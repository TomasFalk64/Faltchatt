export const SYMBOLS = [
  { id: 'hat', label: 'Hatt', glyph: 'hat' },
  { id: 'tree', label: 'Träd', glyph: 'tree' },
  { id: 'leaf', label: 'Löv', glyph: 'leaf' },
  { id: 'mushroom', label: 'Svamp', glyph: 'mushroom' },
  { id: 'star', label: 'Stjärna', glyph: '★' },
  { id: 'spade', label: 'Spader', glyph: '♠' },
  { id: 'heart', label: 'Hjärta', glyph: '♥' },
  { id: 'train', label: 'Tåg', glyph: 'train' },
  { id: 'car', label: 'Bil', glyph: 'car' },
];

export const SYMBOL_COLORS = [
  '#f70404',
  '#ff52a8',
  '#fcf700',
  '#92400e',
  '#03c74b',
  '#00fcde',
  '#044be6',
  '#9063fa',
  '#9ca3af',
  '#111827',
];

export const ACTIVE_LOCATION_MS = 10 * 60 * 1000;
export const ACTIVE_PRESENCE_MS = 45 * 1000;

export const appState = {
  session: null,
  user: null,
  profile: null,
  locationSharingEnabled: localStorage.getItem('faltchatt.locationSharingEnabled') === 'true',
  activeGroupId: localStorage.getItem('faltchatt.activeGroupId') || null,
  activeGroup: null,
  memberships: [],
  members: [],
  presence: [],
  messages: [],
  questions: new Map(),
  answers: [],
  locations: [],
  selectedView: 'profile',
  pendingMapMessage: null,
  mapTarget: null,
  unreadChat: false,
  passwordRecovery: false,
};

export function setLocationSharingEnabled(enabled) {
  appState.locationSharingEnabled = enabled;
  localStorage.setItem('faltchatt.locationSharingEnabled', String(enabled));
}

export function getSymbol(symbolId) {
  return SYMBOLS.find((symbol) => symbol.id === symbolId) || SYMBOLS[0];
}

export function setActiveGroupId(groupId) {
  appState.activeGroupId = groupId;
  if (groupId) {
    localStorage.setItem('faltchatt.activeGroupId', groupId);
  } else {
    localStorage.removeItem('faltchatt.activeGroupId');
  }
}

export function isRecentLocation(location) {
  if (!location?.updated_at) return false;
  return Date.now() - new Date(location.updated_at).getTime() <= ACTIVE_LOCATION_MS;
}

export function isActivePresence(presence) {
  if (!presence?.last_seen) return false;
  return Date.now() - new Date(presence.last_seen).getTime() <= ACTIVE_PRESENCE_MS;
}

export function presenceForUser(userId) {
  return appState.presence.find((presence) => presence.user_id === userId && isActivePresence(presence)) || null;
}

