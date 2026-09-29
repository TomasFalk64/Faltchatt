import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { removeGroupMapFiles } from '../_shared/map-cleanup.js';

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

    // Includes groups removed manually or during account deletion. A failed
    // Storage API call leaves the queue item in place for the next scheduled run.
    while (true) {
      const { data: queued, error: queueError } = await supabase.from('map_storage_cleanup')
        .select('group_id').order('created_at').limit(100);
      if (queueError) throw queueError;
      if (!queued?.length) break;
      for (const item of queued) {
        result.storageObjects += await removeGroupMapFiles(supabase, item.group_id);
        const { error } = await supabase.from('map_storage_cleanup').delete().eq('group_id', item.group_id);
        if (error) throw error;
      }
    }

    return json(result);
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
    headers: { 'content-type': 'application/json' },
  });
}
