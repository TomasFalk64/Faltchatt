import L from 'leaflet';
import { tileKeys } from './map-tiles.js';
import { tilePath } from './map-storage.js';

export function createMapTileLayer(bucket, path, manifest, opacity) {
  const keys = tileKeys(manifest);
  const available = new Set(keys);
  const paths = keys.map((key) => tilePath(path, key));
  let urls, validUntil = 0, signing;
  async function signedUrls() {
    if (urls && Date.now() < validUntil) return urls;
    if (!signing) {
      signing = (async () => {
        const { data, error } = await bucket.createSignedUrls(paths, 3600);
        if (error) throw error;
        if (data?.length !== paths.length || data.some((item) => item.error || !item.signedUrl)) throw new Error('Kunde inte hämta kartans bildrutor.');
        urls = new Map(data.map((item) => [item.path, item.signedUrl]));
        validUntil = Date.now() + 50 * 60 * 1000;
        return urls;
      })().finally(() => { signing = null; });
    }
    return signing;
  }
  const TileMap = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('img');
      tile.alt = '';
      tile.setAttribute('role', 'presentation');
      const key = `${coords.z}/${coords.x}/${coords.y}`;
      if (!available.has(key)) {
        // Rounded geographic bounds can touch an adjacent tile at an edge.
        queueMicrotask(() => done(null, tile));
        return tile;
      }
      tile.onload = () => done(null, tile);
      tile.onerror = () => done(new Error('En kartruta kunde inte hämtas.'), tile);
      signedUrls().then((signed) => {
        if (!tile.cancelled) tile.src = signed.get(tilePath(path, key));
      }).catch((error) => { if (!tile.cancelled) done(error, tile); });
      return tile;
    },
    getBounds() { return L.latLngBounds(manifest.bounds); },
  });
  const layer = new TileMap({ tileSize: 256, bounds: manifest.bounds, noWrap: true,
    minNativeZoom: manifest.minZoom, maxNativeZoom: manifest.maxZoom,
    minZoom: 0, maxZoom: Math.max(19, manifest.maxZoom), opacity,
    updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 2 });
  layer.on('tileunload', ({ tile }) => { tile.cancelled = true; tile.onload = null; tile.onerror = null; tile.removeAttribute('src'); });
  return layer;
}
