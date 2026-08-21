export const SYMBOLS = [
  { id: 'circle', label: 'Cirkel', glyph: '●' },
  { id: 'triangle', label: 'Triangel', glyph: '▲' },
  { id: 'square', label: 'Kvadrat', glyph: '■' },
  { id: 'star', label: 'Stjärna', glyph: '★' },
  { id: 'tree', label: 'Träd', glyph: '♣' },
  { id: 'binoculars', label: 'Kikare', glyph: '◆' },
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
