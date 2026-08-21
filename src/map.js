import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { appState } from './state.js';
import { canAdminGroup, isApprovedMember } from './groups.js';
import { refreshChatMessages, sendMessage } from './chat.js';
import { deleteGroupGeoTiff, listGroupGeoTiffs, loadGeoTiffLayers, removeGeoTiffLayers, setGeoTiffOpacity, uploadGroupGeoTiff } from './geotiff.js';
import { requireSupabase } from './supabase.js';
import { el, formatRelative, friendlyError, icon, logEvent, memberColor, memberName, memberShowsAlias, memberSymbolId, renderIcons, setView, showToast, symbolMarkup } from './ui.js';

let map;
let ownMarker;
let membersLayer;
let sentLocationsLayer;
let locationChannel;
let watchId;
let lastSent = { at: 0, lat: null, lng: null };
let lastOwnPosition = null;
let lastPositionLogAt = 0;
let geotiffOpacity = 0.8;
const hiddenSentLocationIds = new Set();
let groupGeoTiffs = [];
let groupGeoTiffsLoadedFor = null;
let hiddenGeoTiffPaths = new Set();

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
      el('div', { id: 'map-coordinate-readout', className: 'map-coordinate-readout', text: '' }),
      el('button', {
        type: 'button',
        className: 'map-position-check-button',
        title: 'kontrollera position nu',
        'aria-label': 'kontrollera position nu',
        onClick: checkPositionNow,
      }, ['↻']),
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
  const upload = el('input', { type: 'file', accept: '.tif,.tiff,image/tiff', className: 'visually-hidden-file' });
  const uploadButton = el('button', {
    type: 'button',
    className: 'secondary',
    onClick: () => upload.click(),
  }, [icon('upload', 'Ladda upp'), 'Ladda upp GeoTIFF']);
  opacity.addEventListener('input', () => {
    geotiffOpacity = Number(opacity.value) / 100;
    setGeoTiffOpacity(geotiffOpacity);
  });
  upload.addEventListener('change', async () => {
    const file = upload.files?.[0];
    if (!file) return;
    try {
      await uploadGroupGeoTiff(file);
      groupGeoTiffsLoadedFor = null;
      showToast('Gruppkartan laddades upp.', 'success');
      await onChanged();
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte ladda upp GeoTIFF.'), 'error');
    }
  });

  const hasApprovedGroup = Boolean(appState.activeGroup && isApprovedMember());
  const mapList = el('div', { id: 'group-map-list', className: 'map-file-list' }, [
    el('p', { className: 'muted', text: hasApprovedGroup ? 'Laddar kartor...' : 'Ingen aktiv godkänd grupp.' }),
  ]);
  view.append(
    el('div', { className: 'page sidebar-page' }, [
      el('section', { className: 'panel stack' }, [
        el('h2', { text: 'Karta' }),
        el('p', { className: 'muted', text: hasApprovedGroup ? 'OpenStreetMap visas alltid. Gruppkartor visas om de laddas upp.' : 'OpenStreetMap visas även utan grupp. Gruppkarta och platsmeddelanden kräver godkänd grupp.' }),
        el('label', {}, ['GeoTIFF opacitet', opacity]),
        canAdminGroup() ? el('div', { className: 'upload-control' }, [upload, uploadButton]) : null,
        mapList,
      ]),
    ]),
  );
  renderIcons();
  if (hasApprovedGroup) renderGroupMapList(onChanged);
}

function initMap() {
  const previousView = map ? { center: map.getCenter(), zoom: map.getZoom() } : null;
  if (map) {
    map.remove();
    map = null;
  }
  ownMarker = null;
  const initialCenter = lastOwnPosition ? [lastOwnPosition.latitude, lastOwnPosition.longitude] : previousView?.center || [59.3293, 18.0686];
  const initialZoom = lastOwnPosition ? Math.max(previousView?.zoom || 0, 15) : previousView?.zoom || 12;
  map = L.map('map', { zoomControl: true }).setView(initialCenter, initialZoom);
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  membersLayer = L.layerGroup().addTo(map);
  sentLocationsLayer = L.layerGroup().addTo(map);
  L.control.layers({ OpenStreetMap: osm }, { Gruppmedlemmar: membersLayer, 'Skickade platser': sentLocationsLayer }, { collapsed: true }).addTo(map);
  map.on('click', (event) => openSendLocationPanel(event.latlng));
  if (lastOwnPosition) {
    ownMarker = L.marker([lastOwnPosition.latitude, lastOwnPosition.longitude], { icon: ownPositionIcon() }).addTo(map);
    bindMemberPopup(ownMarker, appState.user.id, () => lastOwnPosition);
  }
}

export async function refreshMapLayers() {
  if (!map) return;
  membersLayer.clearLayers();
  sentLocationsLayer.clearLayers();
  if (!appState.activeGroup || !isApprovedMember()) {
    removeGeoTiffLayers(map);
    focusRequestedLocation();
    setTimeout(() => map.invalidateSize(), 80);
    return;
  }
  appState.locations.forEach((location) => {
    if (location.user_id === appState.user.id) return;
    const marker = L.marker([location.latitude, location.longitude], { icon: memberIcon(location.user_id, location.updated_at) });
    const name = '';
    marker.bindPopup(`${name}Senast uppdaterad: ${formatRelative(location.updated_at)}<br>Noggrannhet: ±${Math.round(location.accuracy || 0)} m`);
    marker.bindPopup(memberPopup(location.user_id, location));
    bindMemberPopup(marker, location.user_id, () => location);
    marker.addTo(membersLayer);
  });
  renderSentLocationMarkers();
  await refreshGroupGeoTiffList();
  await loadGeoTiffLayers(map, visibleGeoTiffPaths(), geotiffOpacity);
  focusRequestedLocation();
  setTimeout(() => map.invalidateSize(), 80);
}

async function renderGroupMapList(onChanged) {
  const container = document.querySelector('#group-map-list');
  if (!container) return;
  try {
    await refreshGroupGeoTiffList(true);
    container.replaceChildren(
      groupGeoTiffs.length
        ? el('div', { className: 'map-file-items' }, groupGeoTiffs.map((mapFile) => mapFileRow(mapFile, onChanged)))
        : el('p', { className: 'muted', text: 'Inga GeoTIFF-kartor uppladdade ännu.' }),
    );
    renderIcons();
  } catch (error) {
    console.error(error);
    container.replaceChildren(el('p', { className: 'warning-text', text: friendlyError(error, 'Kunde inte läsa kartlistan.') }));
  }
}

function mapFileRow(mapFile, onChanged) {
  const checkbox = el('input', { type: 'checkbox' });
  checkbox.checked = !hiddenGeoTiffPaths.has(mapFile.path);
  checkbox.addEventListener('change', async () => {
    if (checkbox.checked) hiddenGeoTiffPaths.delete(mapFile.path);
    else hiddenGeoTiffPaths.add(mapFile.path);
    saveHiddenGeoTiffs();
    await refreshMapLayers();
  });

  return el('div', { className: 'map-file-row' }, [
    el('label', { className: 'map-file-toggle' }, [
      checkbox,
      el('span', { text: displayMapName(mapFile.name) }),
    ]),
    canAdminGroup()
      ? el('button', {
          type: 'button',
          className: 'danger-icon-button',
          title: 'Ta bort karta',
          onClick: async () => {
            if (!window.confirm(`Ta bort kartan "${displayMapName(mapFile.name)}"?`)) return;
            try {
              await deleteGroupGeoTiff(mapFile.path);
              hiddenGeoTiffPaths.delete(mapFile.path);
              saveHiddenGeoTiffs();
              removeGeoTiffLayers(map);
              await refreshGroupGeoTiffList(true);
              await refreshMapLayers();
              await renderGroupMapList(onChanged);
              showToast('Kartan togs bort.', 'success');
            } catch (error) {
              console.error(error);
              showToast(friendlyError(error, 'Kunde inte ta bort kartan.'), 'error');
            }
          },
        }, [icon('x', 'Ta bort')])
      : null,
  ]);
}

async function refreshGroupGeoTiffList(force = false) {
  if (!appState.activeGroupId || !isApprovedMember()) {
    groupGeoTiffs = [];
    groupGeoTiffsLoadedFor = null;
    hiddenGeoTiffPaths = new Set();
    return;
  }
  if (groupGeoTiffsLoadedFor !== appState.activeGroupId) {
    hiddenGeoTiffPaths = loadHiddenGeoTiffs();
    groupGeoTiffsLoadedFor = appState.activeGroupId;
    force = true;
  }
  if (!force && groupGeoTiffs.length) return;
  groupGeoTiffs = await listGroupGeoTiffs();
}

function visibleGeoTiffPaths() {
  return groupGeoTiffs.filter((item) => !hiddenGeoTiffPaths.has(item.path)).map((item) => item.path);
}

function loadHiddenGeoTiffs() {
  try {
    return new Set(JSON.parse(localStorage.getItem(geoTiffVisibilityKey()) || '[]'));
  } catch {
    return new Set();
  }
}

function saveHiddenGeoTiffs() {
  localStorage.setItem(geoTiffVisibilityKey(), JSON.stringify([...hiddenGeoTiffPaths]));
}

function geoTiffVisibilityKey() {
  return `faltchatt.hiddenGeoTiffs.${appState.activeGroupId || 'none'}`;
}

function displayMapName(name) {
  return name.replace(/^\d+-/, '');
}

function renderSentLocationMarkers() {
  if (!sentLocationsLayer) return;
  sentLocationsLayer.clearLayers();
  if (!appState.activeGroup || !isApprovedMember()) return;
  appState.messages
    .filter((message) => message.type === 'location' && message.latitude && message.longitude && !hiddenSentLocationIds.has(message.id))
    .forEach((message) => {
      const marker = L.marker([message.latitude, message.longitude]);
      marker.bindPopup(sentLocationPopup(message), { autoClose: false, closeOnClick: false });
      marker.on('popupopen', () => bindSentLocationCloseButton(message.id, marker));
      marker.addTo(sentLocationsLayer);
    });
}

function sentLocationPopup(message) {
  return el('div', { className: 'sent-location-popup' }, [
    el('p', { text: message.text || 'Skickad plats' }),
  ]);
}

function memberPopup(userId, location) {
  const profile = profileForUser(userId);
  const updatedAt = location.updated_at || location.updatedAt;
  return el('div', { className: 'member-popup' }, [
    el('strong', { text: profile?.alias || memberName(userId) }),
    profile?.email ? el('div', {}, [el('span', { text: 'E-post: ' }), el('a', { href: `mailto:${profile.email}`, text: profile.email })]) : null,
    profile?.phone ? el('div', {}, [el('span', { text: 'Mobil: ' }), el('a', { href: `tel:${profile.phone}`, text: profile.phone })]) : null,
    el('div', {}, [el('span', { text: 'Senast uppdaterad: ' }), el('span', { text: updatedAt ? formatRelative(updatedAt) : 'okänd tid' })]),
    Number.isFinite(location.accuracy)
      ? el('div', {}, [el('span', { text: 'Noggrannhet: ' }), el('span', { text: `±${Math.round(location.accuracy)} m` })])
      : null,
  ]);
}

function bindMemberPopup(marker, userId, getLocation) {
  marker.bindPopup(memberPopup(userId, getLocation()));
  marker.off('popupopen');
  marker.on('popupopen', () => {
    marker.setPopupContent(memberPopup(userId, getLocation()));
  });
}

function profileForUser(userId) {
  if (userId === appState.user?.id) return appState.profile;
  const member = appState.members.find((item) => item.user_id === userId);
  return member?.profiles || member?.profile || null;
}

function hideSentLocationMarker(messageId, marker) {
  hiddenSentLocationIds.add(messageId);
  marker.remove();
  showToast('Platsnålen doldes från kartan. Visa den igen från chatten.', 'info');
}

function bindSentLocationCloseButton(messageId, marker) {
  const popup = marker.getPopup();
  const closeButton = popup?.getElement()?.querySelector('.leaflet-popup-close-button');
  if (!closeButton) return;
  closeButton.addEventListener('click', () => hideSentLocationMarker(messageId, marker), { once: true });
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

function checkPositionNow() {
  if (!navigator.geolocation) {
    showToast('GPS stöds inte av webbläsaren.', 'error');
    return;
  }
  showToast('Kontrollerar position...', 'info');
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        await handlePosition(position);
        if (appState.activeGroupId && isApprovedMember()) await loadLocations();
        await refreshMapLayers();
        showToast('Positionen kontrollerades.', 'success');
      } catch (error) {
        console.error(error);
        showToast(friendlyError(error, 'Kunde inte kontrollera positionen.'), 'error');
      }
    },
    handlePositionError,
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    },
  );
}

export function stopSharing() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  lastOwnPosition = null;
  lastSent = { at: 0, lat: null, lng: null };
  if (ownMarker) {
    ownMarker.remove();
    ownMarker = null;
  }
}

async function handlePosition(position) {
  const { latitude, longitude, accuracy, heading, speed } = position.coords;
  lastOwnPosition = { latitude, longitude, accuracy, updatedAt: Date.now() };
  if (Date.now() - lastPositionLogAt > 30000) {
    lastPositionLogAt = Date.now();
    logEvent(`GPS WGS84: lat ${latitude.toFixed(6)}, lon ${longitude.toFixed(6)}, noggrannhet ±${Math.round(accuracy || 0)} m.`, 'info');
  }
  if (map && !ownMarker) map.setView([latitude, longitude], 15);
  if (ownMarker) ownMarker.setLatLng([latitude, longitude]);
  else ownMarker = L.marker([latitude, longitude], { icon: ownPositionIcon() }).addTo(map);
  ownMarker.setIcon(ownPositionIcon());
  bindMemberPopup(ownMarker, appState.user.id, () => lastOwnPosition);

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
    updateCoordinateReadout(latlng);
    return;
  }
  updateCoordinateReadout(latlng);
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
        await refreshChatMessages();
        setView('chat');
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

function updateCoordinateReadout(latlng) {
  const readout = document.querySelector('#map-coordinate-readout');
  if (!readout) return;
  readout.textContent = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
}

export function focusRequestedLocation() {
  if (!map || !appState.mapTarget) return;
  const { messageId, latitude, longitude, text } = appState.mapTarget;
  appState.mapTarget = null;
  if (messageId) {
    hiddenSentLocationIds.delete(messageId);
    renderSentLocationMarkers();
  }
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
