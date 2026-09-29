import parseGeoraster from 'georaster';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import proj4FullyLoaded from 'proj4-fully-loaded';
import { requireSupabase } from './supabase.js';
import { appState } from './state.js';
import { logEvent, showToast } from './ui.js';
import { prepareMapTiles } from './map-import.js';
import { isTileMap, listStorageFiles, readTileManifest, uploadTileMap, deleteTileMap, removeStorageFiles } from './map-storage.js';
import { createMapTileLayer } from './map-tile-layer.js';

const rasterLayers = new Map();
const failedPaths = new Set();
const pendingLayers = new Map();
let requestedMap = null;
let requestedPaths = new Set();
let layerGeneration = 0;
let requestedOpacity = 1;

export async function uploadGroupGeoTiff(file, onProgress = () => {}) {
  const groupId = appState.activeGroupId;
  const userId = appState.user?.id;
  if (!groupId || !userId) throw new Error('Välj en grupp innan du laddar upp en karta.');
  const assertContext = () => {
    if (appState.activeGroupId !== groupId || appState.user?.id !== userId) throw new Error('Gruppen eller inloggningen ändrades. Ladda upp kartan igen i rätt grupp.');
  };
  const safeName = file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'karta';
  const path = `${groupId}/${Date.now()}-${crypto.randomUUID()}-${safeName}.tiles.json`;
  const client = requireSupabase();
  const bucket = client.storage.from('group-maps');
  const prepared = await prepareMapTiles(file, onProgress);
  assertContext();
  prepared.manifest.name = file.name;
  const uploaded = await uploadTileMap(bucket, path, prepared, onProgress, assertContext);
  const { error: updateError } = await client.from('groups').update({ map_file_path: path }).eq('id', groupId);
  if (updateError) {
    try { await removeStorageFiles(bucket, uploaded); } catch (error) { console.error('Kunde inte städa kartuppladdning.', error); }
    throw updateError;
  }
  if (appState.activeGroupId === groupId && appState.user?.id === userId && appState.activeGroup) appState.activeGroup.map_file_path = path;
  failedPaths.delete(path);
  onProgress({ value: 100, text: 'Kartan är uppladdad.' });
  return path;
}

export async function listGroupGeoTiffs(groupId = appState.activeGroupId) {
  if (!groupId) return [];
  const data = await listStorageFiles(requireSupabase().storage.from('group-maps'), groupId);
  return (data || [])
    .filter((item) => /\.(tif|tiff)$/i.test(item.name) || isTileMap(item.name))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .map((item) => ({
      name: isTileMap(item.name) ? item.name.replace(/^(\d+-)[0-9a-f-]{36}-/i, '$1').replace(/\.tiles\.json$/, '') : item.name,
      path: `${groupId}/${item.name}`,
      size: item.metadata?.size || 0,
      createdAt: item.created_at,
    }));
}

export async function deleteGroupGeoTiff(path) {
  const bucket = requireSupabase().storage.from('group-maps');
  if (isTileMap(path)) await deleteTileMap(bucket, path);
  else await removeStorageFiles(bucket, [path]);
  requestedPaths.delete(path);
  failedPaths.delete(path);
  removeGeoTiffPath(path);
  if (appState.activeGroup?.map_file_path === path) {
    const { error: updateError } = await requireSupabase().from('groups').update({ map_file_path: null }).eq('id', appState.activeGroupId);
    if (updateError) throw updateError;
    appState.activeGroup.map_file_path = null;
  }
}

export async function loadGeoTiffLayers(map, paths = [], opacity = 1, options = {}) {
  if (requestedMap && requestedMap !== map) removeGeoTiffLayers(requestedMap);
  requestedMap = map;
  requestedPaths = new Set(paths);
  requestedOpacity = opacity;
  const wantedPaths = new Set(paths);
  [...rasterLayers.keys()].forEach((path) => {
    if (!wantedPaths.has(path)) removeGeoTiffPath(path, map);
  });
  if (!paths.length) return [];

  const loaded = [];
  for (const path of paths) {
    const layer = await loadGeoTiffPath(map, path, opacity, options);
    if (layer) loaded.push(layer);
  }
  return loaded;
}

async function loadGeoTiffPath(map, path, opacity = 1, options = {}) {
  if (!requestedPaths.has(path) || requestedMap !== map) return null;
  if (rasterLayers.has(path)) {
    const layer = rasterLayers.get(path);
    layer.setOpacity(opacity);
    if (!map.hasLayer(layer)) layer.addTo(map);
    return layer;
  }
  if (failedPaths.has(path)) return null;
  if (pendingLayers.has(path)) return pendingLayers.get(path);
  const generation = layerGeneration;
  const request = createGeoTiffLayer(map, path, opacity, options, generation);
  pendingLayers.set(path, request);
  try { return await request; }
  finally { if (pendingLayers.get(path) === request) pendingLayers.delete(path); }
}

async function createGeoTiffLayer(map, path, opacity, options, generation) {
  try {
    const client = requireSupabase();
    let rasterLayer;
    if (isTileMap(path)) {
      const bucket = client.storage.from('group-maps');
      const manifest = await readTileManifest(bucket, path);
      rasterLayer = createMapTileLayer(bucket, path, manifest, opacity);
    } else {
      const { data, error } = await client.storage.from('group-maps').download(path);
      if (error) throw error;
      const arrayBuffer = await data.arrayBuffer();
      const georaster = await parseGeoraster(arrayBuffer);
      logEvent(`GeoTIFF laddad. Projektion/EPSG: ${georaster.projection || 'okänd'}.`, 'info');
      rasterLayer = new GeoRasterLayer({ georaster, opacity, proj4: proj4FullyLoaded, resolution: 128 });
    }
    if (generation !== layerGeneration || requestedMap !== map || !requestedPaths.has(path)) return null;
    rasterLayer.setOpacity(requestedOpacity);
    rasterLayers.set(path, rasterLayer);
    rasterLayer.addTo(map);
    if (options.fitBounds) map.fitBounds(rasterLayer.getBounds());
    return rasterLayer;
  } catch (error) {
    if (generation !== layerGeneration || requestedMap !== map || !requestedPaths.has(path)) return null;
    console.error(error);
    failedPaths.add(path);
    showToast(`GeoTIFF-kartan kunde inte läsas: ${error?.message || 'projektion eller georeferering stöds inte.'}`, 'error');
    return null;
  }
}

export function setGeoTiffOpacity(value) {
  requestedOpacity = value;
  rasterLayers.forEach((layer) => layer.setOpacity(value));
}

export function removeGeoTiffLayers(map) {
  layerGeneration++;
  requestedPaths.clear();
  requestedMap = null;
  pendingLayers.clear();
  failedPaths.clear();
  rasterLayers.forEach((layer) => {
    layer.remove();
  });
  rasterLayers.clear();
}

function removeGeoTiffPath(path, map) {
  const layer = rasterLayers.get(path);
  if (layer) layer.remove();
  rasterLayers.delete(path);
}
