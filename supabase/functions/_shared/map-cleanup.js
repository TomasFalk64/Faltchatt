// Shared with the cleanup job; the bucket remains private throughout deletion.
export async function removeGroupMapFiles(supabase, groupId) {
  const bucket = supabase.storage.from('group-maps');
  const paths = [];
  async function collect(folder) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await bucket.list(folder, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw error;
      for (const item of data || []) {
        if (!item.name) continue;
        const path = `${folder}/${item.name}`;
        if (item.id) paths.push(path);
        else await collect(path);
      }
      if (!data || data.length < 1000) break;
    }
  }
  await collect(groupId);
  for (let offset = 0; offset < paths.length; offset += 100) {
    const { error } = await bucket.remove(paths.slice(offset, offset + 100));
    if (error) throw error;
  }
  return paths.length;
}
