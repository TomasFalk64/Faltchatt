import parseGeoraster from 'georaster';
import GeoRasterLayer from 'georaster-layer-for-leaflet';
import { requireSupabase } from './supabase.js';
import { appState } from './state.js';
import { showToast } from './ui.js';

let rasterLayer = null;
let loadedPath = null;
const failedPaths = new Set();

export async function uploadGroupGeoTiff(file) {
  const extension = file.name.toLowerCase().endsWith('.tiff') ? 'tiff' : 'tif';
  const path = `${appState.activeGroupId}/${crypto.randomUUID()}.${extension}`;
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

export async function loadGeoTiffLayer(map, opacity = 0.8) {
  const path = appState.activeGroup?.map_file_path;
  if (!path) {
    removeGeoTiffLayer(map);
    return null;
  }
  if (rasterLayer && loadedPath === path) {
    rasterLayer.setOpacity(opacity);
    if (!map.hasLayer(rasterLayer)) rasterLayer.addTo(map);
    return rasterLayer;
  }
  if (failedPaths.has(path)) return null;

  try {
    const client = requireSupabase();
    const { data, error } = await client.storage.from('group-maps').download(path);
    if (error) throw error;
    const arrayBuffer = await data.arrayBuffer();
    const georaster = await parseGeoraster(arrayBuffer);
    removeGeoTiffLayer(map);
    rasterLayer = new GeoRasterLayer({
      georaster,
      opacity,
      resolution: 128,
    });
    loadedPath = path;
    rasterLayer.addTo(map);
    map.fitBounds(rasterLayer.getBounds());
    return rasterLayer;
  } catch (error) {
    console.error(error);
    failedPaths.add(path);
    showToast(`GeoTIFF-kartan kunde inte läsas: ${error?.message || 'projektion eller georeferering stöds inte.'}`, 'error');
    return null;
  }
}

export function setGeoTiffOpacity(value) {
  if (rasterLayer) rasterLayer.setOpacity(value);
}

export function removeGeoTiffLayer(map) {
  if (rasterLayer && map?.hasLayer(rasterLayer)) map.removeLayer(rasterLayer);
  rasterLayer = null;
  loadedPath = null;
}
