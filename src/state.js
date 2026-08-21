export const SYMBOLS = [
  { id: 'circle', label: 'Cirkel', glyph: '●' },
  { id: 'triangle', label: 'Triangel', glyph: '▲' },
  { id: 'square', label: 'Kvadrat', glyph: '■' },
  { id: 'star', label: 'Stjärna', glyph: '★' },
  { id: 'tree', label: 'Träd', glyph: '♣' },
  { id: 'binoculars', label: 'Kikare', glyph: '◆' },
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
};

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
