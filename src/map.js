import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { appState, presenceForUser } from './state.js';
import { canAdminGroup, isApprovedMember } from './groups.js';
import { refreshChatMessages, sendMessage } from './chat.js';
import { deleteGroupGeoTiff, listGroupGeoTiffs, loadGeoTiffLayers, removeGeoTiffLayers, setGeoTiffOpacity, uploadGroupGeoTiff } from './geotiff.js';
import { requireSupabase } from './supabase.js';
import { el, formatRelative, friendlyError, icon, logEvent, memberColor, memberName, memberSymbolId, renderIcons, setView, showToast, symbolMarkup } from './ui.js';

let map;
let ownMarker;
let membersLayer;
let sentLocationsLayer;
let memberMarkers = new Map();
let memberClusterMarkers = new Map();
let locationChannel;
let locationRefreshTimer;
let presenceHeartbeatTimer;
let watchId;
let lastSent = { at: 0, lat: null, lng: null };
let lastOwnPosition = null;
let lastPositionLogAt = 0;
let geotiffOpacity = 0.8;
const hiddenSentLocationIds = new Set();
let groupGeoTiffs = [];
let groupGeoTiffsLoadedFor = null;
let hiddenGeoTiffPaths = new Set();
let hiddenSentLocationsLoadedFor = null;
let lastAutoFitGroupId = null;
let userAdjustedMapView = false;
let programmaticMapMove = false;
let autoCenteredOwnPosition = false;
const FADED_LOCATION_MS = 10 * 60 * 1000;
const HIDDEN_LOCATION_MS = 60 * 60 * 1000;

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
  locationRefreshTimer = window.setInterval(onChanged, 20000);
}

export function unsubscribeLocations() {
  if (locationChannel) requireSupabase().removeChannel(locationChannel);
  locationChannel = null;
  if (locationRefreshTimer) window.clearInterval(locationRefreshTimer);
  locationRefreshTimer = null;
}

export async function renderMapView(onChanged) {
  const view = document.querySelector('#map-view');
  if (map && view.querySelector('#map')) {
    await refreshMapLayers();
    return;
  }
  view.innerHTML = '';
  const mapNode = el('div', { id: 'map' });

  view.append(
    el('div', { className: 'map-layout' }, [
      mapNode,
      el('button', {
        id: 'map-coordinate-readout',
        className: 'map-coordinate-readout',
        type: 'button',
        title: 'Kopiera koordinater',
        'aria-label': 'Kopiera koordinater',
        onClick: copyCoordinateReadout,
      }),
      el('button', {
        type: 'button',
        className: 'map-position-check-button',
        title: 'synka allt nu',
        'aria-label': 'synka allt nu',
        onClick: () => syncAllNow(onChanged),
      }, ['↻']),
      el('button', {
        type: 'button',
        className: 'map-center-members-button',
        title: 'Visa gruppmedlemmar på kartan',
        'aria-label': 'Visa gruppmedlemmar på kartan',
        onClick: centerVisibleMembers,
      }, [icon('scan', 'Centrera')]),
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
  const opacityControl = el('label', { id: 'geotiff-opacity-control', hidden: true }, ['Visa uppladdad karta', opacity]);
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
        opacityControl,
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
  map = L.map('map', { zoomControl: true });
  setMapView(initialCenter, initialZoom);
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri',
  });
  membersLayer = L.layerGroup().addTo(map);
  sentLocationsLayer = L.layerGroup().addTo(map);
  memberMarkers = new Map();
  memberClusterMarkers = new Map();
  L.control.layers({ OpenStreetMap: osm, Satellit: satellite }, { Gruppmedlemmar: membersLayer, 'Skickade platser': sentLocationsLayer }, { collapsed: true }).addTo(map);
  map.on('click', (event) => updateCoordinateReadout(event.latlng));
  map.on('contextmenu', (event) => openSendLocationPanel(event.latlng));
  map.on('moveend zoomend', () => {
    if (programmaticMapMove) return;
    userAdjustedMapView = true;
  });
  if (lastOwnPosition && !shouldUseGroupOwnMarker()) {
    ownMarker = L.marker([lastOwnPosition.latitude, lastOwnPosition.longitude], { icon: ownPositionIcon() }).addTo(map);
    bindMemberPopup(ownMarker, appState.user.id, () => lastOwnPosition);
  }
}

function setMapView(center, zoom) {
  programmaticMapMove = true;
  map.setView(center, zoom);
  window.setTimeout(() => {
    programmaticMapMove = false;
  }, 250);
}

function shouldFitGroupMap() {
  return Boolean(appState.activeGroupId && appState.activeGroupId !== lastAutoFitGroupId && !userAdjustedMapView);
}

export async function refreshMapLayers() {
  if (!map) return;
  if (ownMarker) {
    ownMarker.setIcon(ownPositionIcon());
    bindMemberPopup(ownMarker, appState.user.id, () => lastOwnPosition);
  }
  loadHiddenSentLocations();
  sentLocationsLayer.clearLayers();
  if (shouldUseGroupOwnMarker() && ownMarker) {
    ownMarker.remove();
    ownMarker = null;
  }
  if (!appState.activeGroup || !isApprovedMember()) {
    clearMemberMarkers();
    removeGeoTiffLayers(map);
    focusRequestedLocation();
    setTimeout(() => map.invalidateSize(), 80);
    return;
  }
  renderMemberLocationMarkers();
  renderSentLocationMarkers();
  await refreshGroupGeoTiffList();
  await loadGeoTiffLayers(map, visibleGeoTiffPaths(), geotiffOpacity, { fitBounds: shouldFitGroupMap() });
  lastAutoFitGroupId = appState.activeGroupId || null;
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
    updateGeoTiffOpacityControl();
    renderIcons();
  } catch (error) {
    console.error(error);
    container.replaceChildren(el('p', { className: 'warning-text', text: friendlyError(error, 'Kunde inte läsa kartlistan.') }));
    updateGeoTiffOpacityControl();
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
    updateGeoTiffOpacityControl();
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
              updateGeoTiffOpacityControl();
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

function updateGeoTiffOpacityControl() {
  const control = document.querySelector('#geotiff-opacity-control');
  if (!control) return;
  control.hidden = visibleGeoTiffPaths().length === 0;
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
      const marker = L.marker([message.latitude, message.longitude], { icon: sentLocationIcon() });
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
    profile?.show_phone !== false && profile?.phone ? el('div', {}, [el('span', { text: 'Mobil: ' }), el('a', { href: `tel:${profile.phone}`, text: profile.phone })]) : null,
    el('div', {}, [el('span', { text: 'Senast uppdaterad: ' }), el('span', { text: updatedAt ? formatRelative(updatedAt) : 'okänd tid' })]),
    Number.isFinite(location.accuracy)
      ? el('div', {}, [el('span', { text: 'Noggrannhet: ' }), el('span', { text: `±${Math.round(location.accuracy)} m` })])
      : null,
  ]);
}

function renderMemberLocationMarkers() {
  const groups = groupNearbyMemberLocations(appState.locations.filter(shouldShowMemberOnMap));
  const visibleIndividualKeys = new Set();
  const visibleClusterKeys = new Set();
  groups.forEach((group) => {
    if (group.length > 5) {
      const key = memberClusterKey(group);
      visibleClusterKeys.add(key);
      updateMemberClusterMarker(key, group);
      return;
    }
    memberOffsets(group.length).forEach((offset, index) => {
      const location = group[index];
      visibleIndividualKeys.add(location.user_id);
      updateMemberMarker(location, offset);
    });
  });
  removeMissingMarkers(memberMarkers, visibleIndividualKeys);
  removeMissingMarkers(memberClusterMarkers, visibleClusterKeys);
}

function groupNearbyMemberLocations(locations) {
  const groups = [];
  const thresholdPx = 18;
  locations.forEach((location) => {
    const point = map.latLngToLayerPoint([location.latitude, location.longitude]);
    const group = groups.find((item) => item.center.distanceTo(point) <= thresholdPx);
    if (group) {
      group.items.push(location);
      group.center = averageLayerPoint(group.items);
    } else {
      groups.push({ center: point, items: [location] });
    }
  });
  return groups.map((group) => group.items);
}

function averageLayerPoint(locations) {
  const total = locations.reduce((sum, location) => {
    const point = map.latLngToLayerPoint([location.latitude, location.longitude]);
    return { x: sum.x + point.x, y: sum.y + point.y };
  }, { x: 0, y: 0 });
  return L.point(total.x / locations.length, total.y / locations.length);
}

function groupCenter(group) {
  return map.layerPointToLatLng(averageLayerPoint(group));
}

function offsetLatLng(location, offset) {
  if (!offset.x && !offset.y) return [location.latitude, location.longitude];
  const point = map.latLngToLayerPoint([location.latitude, location.longitude]);
  return map.layerPointToLatLng([point.x + offset.x, point.y + offset.y]);
}

function memberOffsets(count) {
  if (count <= 1) return [{ x: 0, y: 0 }];
  const radius = count === 2 ? 8 : 10;
  const startAngle = count === 2 ? Math.PI : -Math.PI / 2;
  return Array.from({ length: count }, (_, index) => {
    const angle = startAngle + (index * 2 * Math.PI) / count;
    return { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
  });
}

function memberClusterIcon() {
  return L.divIcon({
    className: 'member-cluster-icon',
    html: '<span>∞</span>',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function memberClusterKey(group) {
  return group.map((location) => location.user_id).sort().join('|');
}

function updateMemberMarker(location, offset) {
  const latLng = offsetLatLng(location, offset);
  const icon = memberIcon(location.user_id, location.updated_at, location.user_id === appState.user?.id);
  let marker = memberMarkers.get(location.user_id);
  if (!marker) {
    marker = L.marker(latLng, { icon }).addTo(membersLayer);
    memberMarkers.set(location.user_id, marker);
  } else {
    marker.setLatLng(latLng);
    marker.setIcon(icon);
  }
  marker.faltchattLocation = location;
  bindMemberPopup(marker, location.user_id, () => marker.faltchattLocation);
}

function updateMemberClusterMarker(key, group) {
  const latLng = groupCenter(group);
  let marker = memberClusterMarkers.get(key);
  if (!marker) {
    marker = L.marker(latLng, { icon: memberClusterIcon() }).addTo(membersLayer);
    memberClusterMarkers.set(key, marker);
  } else {
    marker.setLatLng(latLng);
    marker.setIcon(memberClusterIcon());
  }
  marker.faltchattGroup = group;
  marker.bindPopup(memberClusterPopup(group));
  marker.off('popupopen');
  marker.on('popupopen', () => bindMemberClusterPopup(marker, marker.faltchattGroup));
}

function removeMissingMarkers(markers, visibleKeys) {
  markers.forEach((marker, key) => {
    if (visibleKeys.has(key)) return;
    marker.remove();
    markers.delete(key);
  });
}

function clearMemberMarkers() {
  removeMissingMarkers(memberMarkers, new Set());
  removeMissingMarkers(memberClusterMarkers, new Set());
}

function memberClusterPopup(group) {
  return el('div', { className: 'member-cluster-popup' }, [
    el('div', { className: 'member-cluster-title', text: 'Flera personer här' }),
    el('div', { className: 'member-cluster-symbols' }, group.map((location) => memberClusterButton(location))),
  ]);
}

function memberClusterButton(location) {
  return el('button', {
    type: 'button',
    className: 'member-cluster-symbol',
    title: memberName(location.user_id),
    'data-user-id': location.user_id,
  }, [
    el('span', {
      html: symbolMarkup(memberSymbolId(location.user_id)),
      style: `color:${memberColor(location.user_id)}`,
    }),
  ]);
}

function bindMemberClusterPopup(marker, group) {
  const popupElement = marker.getPopup()?.getElement();
  if (!popupElement) return;
  popupElement.querySelectorAll('.member-cluster-symbol').forEach((button) => {
    button.addEventListener('click', () => {
      const location = group.find((item) => item.user_id === button.dataset.userId);
      if (!location) return;
      marker.setPopupContent(memberPopup(location.user_id, location));
    });
  });
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
  saveHiddenSentLocations();
  marker.remove();
  showToast('Platsnålen doldes från kartan. Visa den igen från chatten.', 'info');
}

function bindSentLocationCloseButton(messageId, marker) {
  const popup = marker.getPopup();
  const closeButton = popup?.getElement()?.querySelector('.leaflet-popup-close-button');
  if (!closeButton) return;
  closeButton.addEventListener('click', () => hideSentLocationMarker(messageId, marker), { once: true });
}

function sentLocationIcon() {
  return L.divIcon({
    className: 'sent-location-icon',
    html: `
      <svg viewBox="0 0 24 32" aria-hidden="true" focusable="false">
        <path d="M12 31C8.4 25.8 4 19.6 4 12a8 8 0 1 1 16 0c0 7.6-4.4 13.8-8 19Z" />
        <circle cx="12" cy="12" r="3.2" />
      </svg>
    `,
    iconSize: [24, 32],
    iconAnchor: [12, 30],
    popupAnchor: [0, -28],
  });
}

function loadHiddenSentLocations() {
  if (hiddenSentLocationsLoadedFor === appState.activeGroupId) return;
  hiddenSentLocationIds.clear();
  hiddenSentLocationsLoadedFor = appState.activeGroupId;
  try {
    JSON.parse(localStorage.getItem(sentLocationVisibilityKey()) || '[]').forEach((id) => hiddenSentLocationIds.add(id));
  } catch {
    hiddenSentLocationIds.clear();
  }
  const visibleIds = new Set(appState.messages.filter((message) => message.type === 'location').map((message) => message.id));
  [...hiddenSentLocationIds].forEach((id) => {
    if (!visibleIds.has(id)) hiddenSentLocationIds.delete(id);
  });
  saveHiddenSentLocations();
}

function saveHiddenSentLocations() {
  localStorage.setItem(sentLocationVisibilityKey(), JSON.stringify([...hiddenSentLocationIds]));
}

function sentLocationVisibilityKey() {
  return `faltchatt.hiddenSentLocations.${appState.activeGroupId || 'none'}`;
}

function memberIcon(userId, updatedAt, own = false) {
  const age = Date.now() - new Date(updatedAt).getTime();
  const ageClass = age > FADED_LOCATION_MS ? 'faded' : 'fresh';
  const activeClass = presenceForUser(userId) ? 'active' : 'inactive';
  const symbol = memberSymbolId(userId);
  const color = memberColor(userId);
  return L.divIcon({
    className: `${own ? 'own-map-icon' : 'member-map-icon'} ${ageClass} ${activeClass}`,
    html: `<span style="color:${escapeHtml(color)}">${symbolMarkup(symbol)}</span>`,
    iconSize: own ? [34, 34] : [30, 30],
    iconAnchor: own ? [17, 17] : [15, 15],
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

async function syncAllNow(onChanged) {
  showToast('Synkar gruppen...', 'info');
  try {
    await touchPresence();
    await checkPositionOnce();
    if (appState.activeGroupId && isApprovedMember()) await loadLocations();
    await onChanged();
    showToast('Gruppen synkades.', 'success');
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte synka gruppen.'), 'error');
  }
}

function centerVisibleMembers() {
  if (!map) return;
  const markers = [...memberMarkers.values(), ...memberClusterMarkers.values()].filter((marker) => map.hasLayer(marker));
  if (!markers.length) {
    showToast('Inga synliga gruppmedlemmar på kartan.', 'info');
    return;
  }
  if (markers.length === 1) {
    const latLng = markers[0].getLatLng();
    setMapView([latLng.lat, latLng.lng], Math.max(map.getZoom(), 15));
    return;
  }
  const bounds = L.latLngBounds(markers.map((marker) => marker.getLatLng()));
  programmaticMapMove = true;
  map.fitBounds(bounds.pad(0.25), {
    maxZoom: 16,
    padding: [28, 28],
  });
  window.setTimeout(() => {
    programmaticMapMove = false;
  }, 250);
}

function checkPositionOnce() {
  if (!navigator.geolocation || !appState.locationSharingEnabled) return Promise.resolve();
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          await handlePosition(position);
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      reject,
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000,
      },
    );
  });
}

export function stopSharing() {
  void clearOwnLocation();
  void touchPresence();
  if (watchId) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  lastOwnPosition = null;
  lastSent = { at: 0, lat: null, lng: null };
  if (ownMarker) {
    ownMarker.remove();
    ownMarker = null;
  }
}

export function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  void touchPresence();
  presenceHeartbeatTimer = window.setInterval(() => {
    void touchPresence();
  }, 10000);
}

export function stopPresenceHeartbeat() {
  if (presenceHeartbeatTimer) window.clearInterval(presenceHeartbeatTimer);
  presenceHeartbeatTimer = null;
}

export async function touchPresence() {
  if (!appState.activeGroupId || !appState.user || !isApprovedMember()) return;
  try {
    const { error } = await requireSupabase().from('group_presence').upsert(
      {
        group_id: appState.activeGroupId,
        user_id: appState.user.id,
        last_seen: new Date().toISOString(),
        is_sharing_location: appState.locationSharingEnabled,
      },
      { onConflict: 'group_id,user_id' },
    );
    if (error) throw error;
  } catch (error) {
    console.warn('Kunde inte uppdatera gruppnärvaro.', error);
  }
}

export async function clearOwnPresence() {
  if (!appState.activeGroupId || !appState.user) return;
  try {
    const { error } = await requireSupabase()
      .from('group_presence')
      .delete()
      .eq('group_id', appState.activeGroupId)
      .eq('user_id', appState.user.id);
    if (error) throw error;
    appState.presence = appState.presence.filter((presence) => presence.user_id !== appState.user.id);
  } catch (error) {
    console.warn('Kunde inte rensa egen gruppnärvaro.', error);
  }
}

export async function clearOwnLocation() {
  if (!appState.activeGroupId || !appState.user) return;
  try {
    const { error } = await requireSupabase()
      .from('locations')
      .delete()
      .eq('group_id', appState.activeGroupId)
      .eq('user_id', appState.user.id);
    if (error) throw error;
    appState.locations = appState.locations.filter((location) => location.user_id !== appState.user.id);
    await refreshMapLayers();
  } catch (error) {
    console.warn('Kunde inte rensa egen position.', error);
  }
}

function shouldShowMemberOnMap(location) {
  if (!location?.updated_at) return false;
  if (Date.now() - new Date(location.updated_at).getTime() > HIDDEN_LOCATION_MS) return false;
  const member = appState.members.find((item) => item.user_id === location.user_id && item.status === 'approved');
  if (!member) return false;
  if (location.user_id === appState.user?.id) return Boolean(appState.locationSharingEnabled);
  return true;
}

function shouldUseGroupOwnMarker() {
  return Boolean(appState.activeGroupId && appState.user && appState.locationSharingEnabled);
}

async function handlePosition(position) {
  const { latitude, longitude, accuracy, heading, speed } = position.coords;
  lastOwnPosition = { latitude, longitude, accuracy, updatedAt: Date.now() };
  if (Date.now() - lastPositionLogAt > 30000) {
    lastPositionLogAt = Date.now();
    logEvent(`GPS WGS84: lat ${latitude.toFixed(6)}, lon ${longitude.toFixed(6)}, noggrannhet ±${Math.round(accuracy || 0)} m.`, 'info');
  }
  if (shouldUseGroupOwnMarker()) {
    if (ownMarker) {
      ownMarker.remove();
      ownMarker = null;
    }
  } else {
    if (map && !ownMarker && !userAdjustedMapView && !autoCenteredOwnPosition) {
      setMapView([latitude, longitude], 15);
      autoCenteredOwnPosition = true;
    }
    if (ownMarker) ownMarker.setLatLng([latitude, longitude]);
    else ownMarker = L.marker([latitude, longitude], { icon: ownPositionIcon() }).addTo(map);
    ownMarker.setIcon(ownPositionIcon());
    bindMemberPopup(ownMarker, appState.user.id, () => lastOwnPosition);
  }

  const moved = lastSent.lat === null || distanceMeters(lastSent.lat, lastSent.lng, latitude, longitude) > 15;
  const enoughTime = Date.now() - lastSent.at > 10000;
  if (!moved && !enoughTime) return;
  lastSent = { at: Date.now(), lat: latitude, lng: longitude };
  if (!appState.activeGroupId || !isApprovedMember()) return;
  try {
    const updatedAt = new Date().toISOString();
    const { error } = await requireSupabase().from('locations').upsert(
      {
        group_id: appState.activeGroupId,
        user_id: appState.user.id,
        latitude,
        longitude,
        accuracy,
        heading: Number.isFinite(heading) ? heading : null,
        speed: Number.isFinite(speed) ? speed : null,
        updated_at: updatedAt,
      },
      { onConflict: 'group_id,user_id' },
    );
    if (error) throw error;
    updateOwnLocationState({ latitude, longitude, accuracy, heading, speed, updatedAt });
    updateOwnPresenceState();
    await refreshMapLayers();
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte dela positionen.'), 'error');
  }
}

function updateOwnPresenceState() {
  if (!appState.activeGroupId || !appState.user) return;
  const row = {
    group_id: appState.activeGroupId,
    user_id: appState.user.id,
    last_seen: new Date().toISOString(),
    is_sharing_location: appState.locationSharingEnabled,
  };
  const index = appState.presence.findIndex((presence) => presence.group_id === row.group_id && presence.user_id === row.user_id);
  if (index >= 0) appState.presence[index] = { ...appState.presence[index], ...row };
  else appState.presence.push(row);
}

function updateOwnLocationState({ latitude, longitude, accuracy, heading, speed, updatedAt }) {
  if (!appState.activeGroupId || !appState.user) return;
  const row = {
    group_id: appState.activeGroupId,
    user_id: appState.user.id,
    latitude,
    longitude,
    accuracy,
    heading: Number.isFinite(heading) ? heading : null,
    speed: Number.isFinite(speed) ? speed : null,
    updated_at: updatedAt,
  };
  const index = appState.locations.findIndex((location) => location.group_id === row.group_id && location.user_id === row.user_id);
  if (index >= 0) appState.locations[index] = { ...appState.locations[index], ...row };
  else appState.locations.push(row);
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
  const text = el('input', { value: 'Ses här om 20 min', 'aria-label': 'Text' });
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
      el('div', { className: 'map-send-header' }, [
        el('strong', { text: 'Skicka position?' }),
        el('div', { className: 'map-send-actions' }, [
          el('button', { type: 'button', className: 'map-send-cancel', title: 'Avbryt', 'aria-label': 'Avbryt', onClick: () => { panel.hidden = true; } }, [icon('x', 'Avbryt')]),
          el('button', { type: 'submit', className: 'map-send-submit', title: 'Skicka', 'aria-label': 'Skicka' }, [icon('send', 'Skicka')]),
        ]),
      ]),
      text,
    ]),
  );
  renderIcons();
}

function updateCoordinateReadout(latlng) {
  const readout = document.querySelector('#map-coordinate-readout');
  if (!readout) return;
  readout.textContent = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
}

async function copyCoordinateReadout() {
  const readout = document.querySelector('#map-coordinate-readout');
  const value = readout?.textContent?.trim();
  if (!value) return;
  try {
    await navigator.clipboard?.writeText(value);
    showToast('Koordinater kopierade.', 'success');
  } catch (error) {
    console.error(error);
    showToast('Kunde inte kopiera koordinater.', 'error');
  }
}

export function focusRequestedLocation() {
  if (!map || !appState.mapTarget) return;
  const { messageId, latitude, longitude, text } = appState.mapTarget;
  appState.mapTarget = null;
  if (messageId) {
    hiddenSentLocationIds.delete(messageId);
    saveHiddenSentLocations();
    renderSentLocationMarkers();
  }
  setMapView([latitude, longitude], 16);
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
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

window.addEventListener('faltchatt:map-visible', () => {
  if (map) setTimeout(() => map.invalidateSize(), 80);
});
window.addEventListener('faltchatt:focus-location', focusRequestedLocation);
window.addEventListener('faltchatt:group-changing', () => {
  userAdjustedMapView = false;
  autoCenteredOwnPosition = false;
  void clearOwnPresence();
});
