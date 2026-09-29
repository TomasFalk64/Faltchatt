import { validateTileManifest } from './map-tiles.js';

export const isTileMap = (path) => path.endsWith('.tiles.json');
export const tileFolder = (path) => path.slice(0, -'.tiles.json'.length);
export const tilePath = (path, key) => `${tileFolder(path)}/${key.replaceAll('/', '-')}.png`;

export async function listStorageFiles(bucket, folder) {
  const files = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await bucket.list(folder, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    files.push(...(data || []));
    if (!data || data.length < 1000) return files;
  }
}

export async function removeStorageFiles(bucket, paths) {
  for (let offset = 0; offset < paths.length; offset += 100) {
    const { error } = await bucket.remove(paths.slice(offset, offset + 100));
    if (error) throw error;
  }
}

export async function readTileManifest(bucket, path) {
  const { data, error } = await bucket.download(path);
  if (error) throw error;
  return validateTileManifest(JSON.parse(await data.text()));
}

// Publish the manifest last. Wait for every in-flight upload before rolling back.
export async function uploadTileMap(bucket, path, prepared, onProgress, assertContext = () => {}) {
  const attempted = [];
  let next = 0, completed = 0, failure;
  const workers = Array.from({ length: Math.min(4, prepared.tiles.length) }, async () => {
    while (!failure && next < prepared.tiles.length) {
      const tile = prepared.tiles[next++];
      try {
        assertContext();
        const target = tilePath(path, tile.key);
        attempted.push(target);
        const { error } = await bucket.upload(target, tile.blob, { contentType: 'image/png', cacheControl: '3600', upsert: false });
        if (error) throw error;
        completed++;
        onProgress({ value: 65 + Math.round(30 * completed / prepared.tiles.length), text: `Laddar upp kartan: ${completed} av ${prepared.tiles.length}…` });
      } catch (error) { failure ||= error; }
    }
  });
  try {
    await Promise.all(workers);
    if (failure) throw failure;
    assertContext();
    attempted.push(path);
    const { error } = await bucket.upload(path, new Blob([JSON.stringify(prepared.manifest)], { type: 'application/json' }),
      { contentType: 'application/json', cacheControl: '3600', upsert: false });
    if (error) throw error;
    return attempted;
  } catch (error) {
    try { await removeStorageFiles(bucket, attempted); }
    catch (cleanupError) { console.error('Kunde inte städa avbruten kartuppladdning.', cleanupError); }
    throw error;
  }
}

export async function deleteTileMap(bucket, path) {
  // Enumerate the dedicated folder, never accept deletion paths from a manifest.
  const folder = tileFolder(path);
  const files = await listStorageFiles(bucket, folder);
  await removeStorageFiles(bucket, files.filter((file) => file.id).map((file) => `${folder}/${file.name}`));
  await removeStorageFiles(bucket, [path]);
}
