import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';

type Candidate = {
  user_id: string;
  last_seen: string;
  deletion_warning_sent_at: string | null;
  action: 'warn' | 'delete' | 'none';
};

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    const jobSecret = Deno.env.get('INACTIVE_ACCOUNT_CLEANUP_SECRET');
    if (jobSecret) {
      const provided = req.headers.get('x-cleanup-secret') || '';
      if (provided !== jobSecret) return json({ error: 'unauthorized' }, 401);
    }

    const supabaseUrl = requiredEnv('SUPABASE_URL');
    const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await supabase.rpc('inactive_account_candidates');
    if (error) throw error;

    const result = { warned: 0, deleted: 0, skippedWarnings: 0 };
    for (const candidate of (data || []) as Candidate[]) {
      if (candidate.action === 'warn') {
        const sent = await sendWarningEmail(supabase, candidate);
        if (sent) {
          const { error: markError } = await supabase.rpc('mark_inactive_account_warning_sent', {
            target_user_id: candidate.user_id,
          });
          if (markError) throw markError;
          result.warned += 1;
        } else {
          result.skippedWarnings += 1;
        }
      }

      if (candidate.action === 'delete') {
        const { error: cleanupError } = await supabase.rpc('prepare_delete_user_account', {
          target_user_id: candidate.user_id,
        });
        if (cleanupError) throw cleanupError;

        const { error: deleteError } = await supabase.auth.admin.deleteUser(candidate.user_id);
        if (deleteError) throw deleteError;
        result.deleted += 1;
      }
    }

    return json(result);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'unknown error' }, 400);
  }
});

async function sendWarningEmail(supabase: any, candidate: Candidate) {
  const brevoKey = Deno.env.get('BREVO_API_KEY');
  const senderEmail = Deno.env.get('BREVO_SENDER_EMAIL');
  if (!brevoKey || !senderEmail) return false;

  const { data, error } = await supabase.auth.admin.getUserById(candidate.user_id);
  if (error || !data.user?.email) return false;

  const appUrl = Deno.env.get('FALTCHATT_APP_URL') || '';
  const senderName = Deno.env.get('BREVO_SENDER_NAME') || 'Fältchatt';
  const text = [
    'Ditt Fältchatt-konto har varit inaktivt länge.',
    '',
    'Om du vill behålla kontot behöver du logga in igen inom cirka 30 dagar.',
    appUrl ? `Länk: ${appUrl}` : '',
  ].filter(Boolean).join('\n');

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': brevoKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: data.user.email }],
      subject: 'Fältchatt: logga in för att behålla kontot',
      textContent: text,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Brevo warning email failed: ${response.status} ${detail}`);
  }
  return true;
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
