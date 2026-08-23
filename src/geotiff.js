import parseGeoraster from 'georaster';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import proj4FullyLoaded from 'proj4-fully-loaded';
import { requireSupabase } from './supabase.js';
import { appState } from './state.js';
import { logEvent, showToast } from './ui.js';

const rasterLayers = new Map();
const failedPaths = new Set();

export async function uploadGroupGeoTiff(file) {
  const extension = file.name.toLowerCase().endsWith('.tiff') ? 'tiff' : 'tif';
  const safeName = file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'karta';
  const path = `${appState.activeGroupId}/${Date.now()}-${safeName}.${extension}`;
  const client = requireSupabase();
  const { error: uploadError } = await client.storage.from('group-maps').upload(path, file, {
    cacheControl: '3600',
    upsert: true,
    contentType: file.type || 'image/tiff',
  });
  if (uploadError) throw uploadError;
  const { error: updateError } = await client.from('groups').update({ map_file_path: path }).eq('id', appState.activeGroupId);
  if (updateError) throw updateError;
  appState.activeGroup.map_file_path = path;
  failedPaths.delete(path);
  return path;
}

export async function listGroupGeoTiffs() {
  if (!appState.activeGroupId) return [];
  const { data, error } = await requireSupabase()
    .storage
    .from('group-maps')
    .list(appState.activeGroupId, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
  if (error) throw error;
  return (data || [])
    .filter((item) => /\.(tif|tiff)$/i.test(item.name))
    .map((item) => ({
      name: item.name,
      path: `${appState.activeGroupId}/${item.name}`,
      size: item.metadata?.size || 0,
      createdAt: item.created_at,
    }));
}

export async function deleteGroupGeoTiff(path) {
  const { error } = await requireSupabase().storage.from('group-maps').remove([path]);
  if (error) throw error;
  failedPaths.delete(path);
  removeGeoTiffPath(path);
  if (appState.activeGroup?.map_file_path === path) {
    const { error: updateError } = await requireSupabase().from('groups').update({ map_file_path: null }).eq('id', appState.activeGroupId);
    if (updateError) throw updateError;
    appState.activeGroup.map_file_path = null;
  }
}

export async function loadGeoTiffLayers(map, paths = [], opacity = 0.8, options = {}) {
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

async function loadGeoTiffPath(map, path, opacity = 0.8, options = {}) {
  if (rasterLayers.has(path)) {
    const layer = rasterLayers.get(path);
    layer.setOpacity(opacity);
    if (!map.hasLayer(layer)) layer.addTo(map);
    return layer;
  }
  if (failedPaths.has(path)) return null;

  try {
    const client = requireSupabase();
    const { data, error } = await client.storage.from('group-maps').download(path);
    if (error) throw error;
    const arrayBuffer = await data.arrayBuffer();
    const georaster = await parseGeoraster(arrayBuffer);
    logEvent(`GeoTIFF laddad. Projektion/EPSG: ${georaster.projection || 'okänd'}.`, 'info');
    const rasterLayer = new GeoRasterLayer({
      georaster,
      opacity,
      proj4: proj4FullyLoaded,
      resolution: 128,
    });
    rasterLayers.set(path, rasterLayer);
    rasterLayer.addTo(map);
    if (options.fitBounds) map.fitBounds(rasterLayer.getBounds());
    return rasterLayer;
  } catch (error) {
    console.error(error);
    failedPaths.add(path);
    showToast(`GeoTIFF-kartan kunde inte läsas: ${error?.message || 'projektion eller georeferering stöds inte.'}`, 'error');
    return null;
  }
}

export function setGeoTiffOpacity(value) {
  rasterLayers.forEach((layer) => layer.setOpacity(value));
}

export function removeGeoTiffLayers(map) {
  rasterLayers.forEach((layer) => {
    if (map?.hasLayer(layer)) map.removeLayer(layer);
  });
  rasterLayers.clear();
}

function removeGeoTiffPath(path, map) {
  const layer = rasterLayers.get(path);
  if (layer && map?.hasLayer(layer)) map.removeLayer(layer);
  rasterLayers.delete(path);
}
