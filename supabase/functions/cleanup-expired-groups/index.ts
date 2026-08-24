import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';

type GroupRow = {
  id: string;
  name: string;
  expires_at: string;
};

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    const jobSecret = Deno.env.get('EXPIRED_GROUP_CLEANUP_SECRET');
    if (jobSecret) {
      const provided = req.headers.get('x-cleanup-secret') || '';
      if (provided !== jobSecret) return json({ error: 'unauthorized' }, 401);
    }

    const supabaseUrl = requiredEnv('SUPABASE_URL');
    const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: groups, error: groupError } = await supabase
      .from('groups')
      .select('id, name, expires_at')
      .lte('expires_at', new Date().toISOString());
    if (groupError) throw groupError;

    const result = { groups: 0, storageObjects: 0 };
    for (const group of (groups || []) as GroupRow[]) {
      result.storageObjects += await removeGroupMapFiles(supabase, group.id);
      const { error: deleteError } = await supabase
        .from('groups')
        .delete()
        .eq('id', group.id);
      if (deleteError) throw deleteError;
      result.groups += 1;
    }

    return json(result);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'unknown error' }, 400);
  }
});

async function removeGroupMapFiles(supabase: any, groupId: string) {
  const paths: string[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { data, error } = await supabase.storage
      .from('group-maps')
      .list(groupId, { limit, offset });
    if (error) throw error;
    if (!data?.length) break;
    for (const item of data) {
      if (item.name) paths.push(`${groupId}/${item.name}`);
    }
    if (data.length < limit) break;
    offset += limit;
  }

  if (!paths.length) return 0;
  const { error } = await supabase.storage.from('group-maps').remove(paths);
  if (error) throw error;
  return paths.length;
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
