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
  '#ef4444',
  '#ec4899',
  '#facc15',
  '#92400e',
  '#22c55e',
  '#14b8a6',
  '#2563eb',
  '#8b5cf6',
  '#9ca3af',
  '#111827',
];

export const appState = {
  session: null,
  user: null,
  profile: null,
  locationSharingEnabled: localStorage.getItem('faltchatt.locationSharingEnabled') === 'true',
  activeGroupId: localStorage.getItem('faltchatt.activeGroupId') || null,
  activeGroup: null,
  memberships: [],
  members: [],
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
