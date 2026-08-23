import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type RecipientMode = 'all' | 'approved' | 'pending' | 'invited' | 'selected';

type EmailPayload = {
  groupId?: string;
  recipientMode?: RecipientMode;
  selectedRecipients?: string[];
  subject?: string;
  body?: string;
  statusTexts?: Record<string, string>;
};

type Recipient = {
  key: string;
  email: string;
  name: string;
  status: 'approved' | 'pending' | 'invited';
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (req.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405);
    }

    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'missing authorization' }, 401);

    const supabaseUrl = requiredEnv('SUPABASE_URL');
    const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const brevoApiKey = requiredEnv('BREVO_API_KEY');
    const senderEmail = requiredEnv('BREVO_SENDER_EMAIL');
    const senderName = Deno.env.get('BREVO_SENDER_NAME') || 'Fältchatt';
    const appUrl = Deno.env.get('FALTCHATT_APP_URL') || 'https://tomasfalk64.github.io/Faltchatt/';

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return json({ error: 'invalid user' }, 401);

    const payload = await req.json() as EmailPayload;
    validatePayload(payload);

    const { data: isAdmin, error: adminError } = await supabase.rpc('is_group_admin', {
      target_group_id: payload.groupId,
      target_user_id: userData.user.id,
    });
    if (adminError) throw adminError;
    if (!isAdmin) return json({ error: 'only group admins can send group email' }, 403);

    const recipients = await loadRecipients(supabase, payload.groupId!);
    const selected = filterRecipients(recipients, payload.recipientMode!, payload.selectedRecipients || []);
    if (!selected.length) return json({ error: 'no recipients' }, 400);

    const { data: groupData, error: groupError } = await supabase
      .from('groups')
      .select('name')
      .eq('id', payload.groupId)
      .single();
    if (groupError) throw groupError;

    const results = [];
    for (const recipient of selected) {
      const text = buildMessageText(payload, recipient, appUrl, groupData?.name || 'gruppen');
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'api-key': brevoApiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { email: senderEmail, name: senderName },
          to: [{ email: recipient.email, name: recipient.name }],
          subject: payload.subject,
          textContent: text,
        }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Brevo failed for ${recipient.email}: ${response.status} ${detail}`);
      }
      results.push(recipient.email);
    }

    return json({ sent: results.length });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'unknown error' }, 400);
  }
});

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

function validatePayload(payload: EmailPayload) {
  if (!payload.groupId) throw new Error('groupId is required');
  if (!['all', 'approved', 'pending', 'invited', 'selected'].includes(payload.recipientMode || '')) throw new Error('invalid recipientMode');
  if (!payload.subject?.trim()) throw new Error('subject is required');
  if (!payload.body?.trim()) throw new Error('body is required');
  if (payload.subject.length > 180) throw new Error('subject is too long');
  if (payload.body.length > 8000) throw new Error('body is too long');
}

async function loadRecipients(supabase: ReturnType<typeof createClient>, groupId: string): Promise<Recipient[]> {
  const { data: members, error: memberError } = await supabase
    .from('group_members')
    .select('id, status, profiles(alias, email)')
    .eq('group_id', groupId)
    .in('status', ['approved', 'pending']);
  if (memberError) throw memberError;

  const { data: invites, error: inviteError } = await supabase
    .from('group_invites')
    .select('id, email, alias')
    .eq('group_id', groupId)
    .eq('status', 'invited');
  if (inviteError) throw inviteError;

  const memberRecipients = (members || [])
    .filter((member: any) => member.profiles?.email)
    .map((member: any) => ({
      key: `member:${member.id}`,
      email: member.profiles.email,
      name: member.profiles.alias || member.profiles.email,
      status: member.status,
    }));

  const inviteRecipients = (invites || []).map((invite: any) => ({
    key: `invite:${invite.id}`,
    email: invite.email,
    name: invite.alias || invite.email,
    status: 'invited' as const,
  }));

  const unique = new Map<string, Recipient>();
  [...memberRecipients, ...inviteRecipients].forEach((recipient) => {
    unique.set(`${recipient.status}:${recipient.email.toLowerCase()}`, recipient);
  });
  return [...unique.values()];
}

function filterRecipients(recipients: Recipient[], mode: RecipientMode, selectedKeys: string[]) {
  if (mode === 'all') return recipients;
  if (mode === 'selected') return recipients.filter((recipient) => selectedKeys.includes(recipient.key));
  return recipients.filter((recipient) => recipient.status === mode);
}

function buildMessageText(payload: EmailPayload, recipient: Recipient, appUrl: string, groupName: string) {
  const statusTexts = payload.statusTexts || {};
  const fallbackTexts: Record<Recipient['status'], string> = {
    approved: 'Du är redan medlem i gruppen och kan logga in i Fältchatt.',
    pending: 'Du har ansökt om medlemskap men väntar på godkännande.',
    invited: 'Du är inbjuden men saknar konto. Skapa konto med den här e-postadressen och bekräfta e-postmeddelandet.',
  };
  return [
    payload.body?.trim(),
    statusTexts[recipient.status]?.trim() || fallbackTexts[recipient.status],
    `Grupp: ${groupName}`,
    appUrl,
  ].filter(Boolean).join('\n\n');
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
