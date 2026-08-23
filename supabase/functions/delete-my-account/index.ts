import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type DeleteAccountPayload = {
  confirmEmail?: string;
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
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return json({ error: 'invalid user' }, 401);

    const payload = await req.json() as DeleteAccountPayload;
    const accountEmail = (userData.user.email || '').trim().toLowerCase();
    const confirmEmail = (payload.confirmEmail || '').trim().toLowerCase();
    if (!accountEmail || confirmEmail !== accountEmail) {
      return json({ error: 'email confirmation does not match account email' }, 400);
    }

    const { data: cleanup, error: cleanupError } = await supabase.rpc('prepare_delete_user_account', {
      target_user_id: userData.user.id,
    });
    if (cleanupError) throw cleanupError;

    const { error: deleteError } = await supabase.auth.admin.deleteUser(userData.user.id);
    if (deleteError) throw deleteError;

    return json({ deleted: true, cleanup });
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
