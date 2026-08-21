import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { appState } from './state.js';
import { canAdminGroup, isApprovedMember } from './groups.js';
import { sendMessage } from './chat.js';
import { loadGeoTiffLayer, removeGeoTiffLayer, setGeoTiffOpacity, uploadGroupGeoTiff } from './geotiff.js';
import { requireSupabase } from './supabase.js';
import { el, formatRelative, friendlyError, icon, logEvent, memberColor, memberName, memberShowsAlias, memberSymbolId, renderIcons, showToast, symbolMarkup } from './ui.js';

let map;
let ownMarker;
let membersLayer;
let sentLocationsLayer;
let locationChannel;
let watchId;
let lastSent = { at: 0, lat: null, lng: null };
let lastPositionLogAt = 0;
let geotiffOpacity = 0.8;

export async function loadLocations() {
  if (!appState.activeGroupId || !isApprovedMember()) {
    appState.locations = [];
    return;
  }
  const { data, error } = await requireSupabase().from('locations').select('*').eq('group_id', appState.activeGroupId);
  if (error) throw error;
  appState.locations = data || [];
}

export function subscribeLocations(onChanged) {
  unsubscribeLocations();
  if (!appState.activeGroupId || !isApprovedMember()) return;
  locationChannel = requireSupabase()
    .channel(`locations:${appState.activeGroupId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'locations', filter: `group_id=eq.${appState.activeGroupId}` }, onChanged)
    .subscribe();
}

export function unsubscribeLocations() {
  if (locationChannel) requireSupabase().removeChannel(locationChannel);
  locationChannel = null;
}

export async function renderMapView(onChanged) {
  const view = document.querySelector('#map-view');
  view.innerHTML = '';
  const mapNode = el('div', { id: 'map' });

  view.append(
    el('div', { className: 'map-layout' }, [
      mapNode,
      el('div', { id: 'map-send-panel', className: 'map-send-panel', hidden: true }),
    ]),
  );
  renderIcons();
  initMap();
  await refreshMapLayers();
}

export function renderMapControls(onChanged) {
  const view = document.querySelector('#map-controls-view');
  if (!view) return;
  view.innerHTML = '';

  const opacity = el('input', { type: 'range', min: '0', max: '100', value: String(Math.round(geotiffOpacity * 100)) });
  const upload = el('input', { type: 'file', accept: '.tif,.tiff,image/tiff' });
  opacity.addEventListener('input', () => {
    geotiffOpacity = Number(opacity.value) / 100;
    setGeoTiffOpacity(geotiffOpacity);
  });
  upload.addEventListener('change', async () => {
    const file = upload.files?.[0];
    if (!file) return;
    try {
      await uploadGroupGeoTiff(file);
      showToast('Gruppkartan laddades upp.', 'success');
      await onChanged();
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte ladda upp GeoTIFF.'), 'error');
    }
  });

  const hasApprovedGroup = Boolean(appState.activeGroup && isApprovedMember());
  view.append(
    el('div', { className: 'page sidebar-page' }, [
      el('section', { className: 'panel stack' }, [
        el('h2', { text: 'Karta' }),
        el('p', { className: 'muted', text: hasApprovedGroup ? 'OpenStreetMap visas alltid. Gruppkartan visas om en GeoTIFF finns.' : 'OpenStreetMap visas även utan grupp. Gruppkarta och platsmeddelanden kräver godkänd grupp.' }),
        el('label', {}, ['GeoTIFF opacitet', opacity]),
        canAdminGroup() ? el('label', {}, ['Ladda upp GeoTIFF', upload]) : null,
      ]),
    ]),
  );
  renderIcons();
}

function initMap() {
  if (map) {
    map.remove();
    map = null;
  }
  map = L.map('map', { zoomControl: true }).setView([59.3293, 18.0686], 12);
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  membersLayer = L.layerGroup().addTo(map);
  sentLocationsLayer = L.layerGroup().addTo(map);
  L.control.layers({ OpenStreetMap: osm }, { Gruppmedlemmar: membersLayer, 'Skickade platser': sentLocationsLayer }, { collapsed: true }).addTo(map);
  map.on('click', (event) => openSendLocationPanel(event.latlng));
}

export async function refreshMapLayers() {
  if (!map) return;
  membersLayer.clearLayers();
  sentLocationsLayer.clearLayers();
  if (!appState.activeGroup || !isApprovedMember()) {
    removeGeoTiffLayer(map);
    focusRequestedLocation();
    setTimeout(() => map.invalidateSize(), 80);
    return;
  }
  appState.locations.forEach((location) => {
    if (location.user_id === appState.user.id) return;
    const marker = L.marker([location.latitude, location.longitude], { icon: memberIcon(location.user_id, location.updated_at) });
    const name = memberShowsAlias(location.user_id) ? `<strong>${escapeHtml(memberName(location.user_id))}</strong><br>` : '';
    marker.bindPopup(`${name}Senast uppdaterad: ${formatRelative(location.updated_at)}<br>Noggrannhet: ±${Math.round(location.accuracy || 0)} m`);
    marker.addTo(membersLayer);
  });
  appState.messages
    .filter((message) => message.type === 'location' && message.latitude && message.longitude)
    .forEach((message) => {
      L.marker([message.latitude, message.longitude]).bindPopup(escapeHtml(message.text || 'Skickad plats')).addTo(sentLocationsLayer);
    });
  await loadGeoTiffLayer(map, geotiffOpacity);
  focusRequestedLocation();
  setTimeout(() => map.invalidateSize(), 80);
}

function memberIcon(userId, updatedAt) {
  const minutes = (Date.now() - new Date(updatedAt).getTime()) / 60000;
  const ageClass = minutes > 10 ? 'old' : minutes > 2 ? 'faded' : 'fresh';
  const symbol = memberSymbolId(userId);
  const color = memberColor(userId);
  return L.divIcon({
    className: `member-map-icon ${ageClass}`,
    html: `<span style="color:${escapeHtml(color)}">${symbolMarkup(symbol)}</span>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

export function startSharing() {
  if (watchId) return;
  if (!navigator.geolocation) {
    showToast('GPS stöds inte av webbläsaren.', 'error');
    return;
  }
  watchId = navigator.geolocation.watchPosition(handlePosition, handlePositionError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 15000,
  });
}

export function stopSharing() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

async function handlePosition(position) {
  const { latitude, longitude, accuracy, heading, speed } = position.coords;
  if (Date.now() - lastPositionLogAt > 30000) {
    lastPositionLogAt = Date.now();
    logEvent(`GPS WGS84: lat ${latitude.toFixed(6)}, lon ${longitude.toFixed(6)}, noggrannhet ±${Math.round(accuracy || 0)} m.`, 'info');
  }
  if (map && !ownMarker) map.setView([latitude, longitude], 15);
  if (ownMarker) ownMarker.setLatLng([latitude, longitude]);
  else ownMarker = L.marker([latitude, longitude], { icon: ownPositionIcon() }).addTo(map);
  ownMarker.setIcon(ownPositionIcon());

  const moved = lastSent.lat === null || distanceMeters(lastSent.lat, lastSent.lng, latitude, longitude) > 15;
  const enoughTime = Date.now() - lastSent.at > 10000;
  if (!moved && !enoughTime) return;
  lastSent = { at: Date.now(), lat: latitude, lng: longitude };
  if (!appState.activeGroupId || !isApprovedMember()) return;
  try {
    const { error } = await requireSupabase().from('locations').upsert(
      {
        group_id: appState.activeGroupId,
        user_id: appState.user.id,
        latitude,
        longitude,
        accuracy,
        heading: Number.isFinite(heading) ? heading : null,
        speed: Number.isFinite(speed) ? speed : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'group_id,user_id' },
    );
    if (error) throw error;
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte dela positionen.'), 'error');
  }
}

function handlePositionError(error) {
  console.error(error);
  showToast(error.code === error.PERMISSION_DENIED ? 'GPS nekades av webbläsaren.' : 'GPS-positionen är otillgänglig.', 'error');
}

function openSendLocationPanel(latlng) {
  if (!appState.activeGroupId || !isApprovedMember()) {
    showToast('Välj en godkänd grupp för att skicka platser i chatten.', 'warning');
    return;
  }
  const panel = document.querySelector('#map-send-panel');
  const text = el('input', { value: 'Ses här om 20 min' });
  panel.innerHTML = '';
  panel.hidden = false;
  panel.append(
    el('form', { className: 'stack', onSubmit: async (event) => {
      event.preventDefault();
      try {
        await sendMessage(text.value.trim(), { type: 'location', latitude: latlng.lat, longitude: latlng.lng });
        panel.hidden = true;
        showToast('Platsen skickades.', 'success');
      } catch (error) {
        console.error(error);
        showToast(friendlyError(error, 'Kunde inte skicka platsen.'), 'error');
      }
    } }, [
      el('strong', { text: 'Skicka denna position till gruppen?' }),
      el('label', {}, ['Text', text]),
      el('div', { className: 'button-row' }, [
        el('button', { type: 'button', className: 'ghost', onClick: () => { panel.hidden = true; } }, [icon('x', 'Avbryt'), 'Avbryt']),
        el('button', { type: 'submit', className: 'primary' }, [icon('send', 'Skicka'), 'Skicka']),
      ]),
    ]),
  );
  renderIcons();
}

export function focusRequestedLocation() {
  if (!map || !appState.mapTarget) return;
  const { latitude, longitude, text } = appState.mapTarget;
  appState.mapTarget = null;
  map.setView([latitude, longitude], 16);
  L.popup().setLatLng([latitude, longitude]).setContent(escapeHtml(text || 'Plats')).openOn(map);
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radius = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function ownPositionIcon() {
  const symbol = appState.profile?.symbol || 'hat';
  const color = appState.profile?.symbol_color || '#17324d';
  return L.divIcon({
    className: 'own-map-icon',
    html: `<span style="color:${escapeHtml(color)}">${symbolMarkup(symbol)}</span>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  });
}

window.addEventListener('faltchatt:map-visible', () => {
  if (map) setTimeout(() => map.invalidateSize(), 80);
});
window.addEventListener('faltchatt:focus-location', focusRequestedLocation);
