import { createIcons, icons } from 'lucide';
import { appState, getSymbol } from './state.js';

const toastTimers = new Set();
const logEntries = [];
let topbarGroupChangeHandler = async () => {};
let topbarUserActionHandler = async () => {};

export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(options).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (typeof value === 'boolean') {
      if (value) node.setAttribute(key, '');
    }
    else node.setAttribute(key, value);
  });
  children.forEach((child) => {
    if (child === undefined || child === null) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

export function icon(name, label) {
  const node = el('i', { 'data-lucide': name, 'aria-label': label, title: label });
  return node;
}

export function symbolNode(symbolId, className = 'symbol-svg') {
  const symbol = getSymbol(symbolId);
  const svgMarkup = symbolSvg(symbol.id);
  if (!svgMarkup) return el('span', { className, text: symbol.glyph, title: symbol.label });
  const wrapper = el('span', { className, title: symbol.label, html: svgMarkup });
  wrapper.setAttribute('aria-label', symbol.label);
  return wrapper;
}

export function symbolMarkup(symbolId) {
  const symbol = getSymbol(symbolId);
  return symbolSvg(symbol.id) || `<span>${escapeHtml(symbol.glyph)}</span>`;
}

function symbolSvg(id) {
  const common = 'viewBox="0 0 32 32" aria-hidden="true" focusable="false"';
  const svgs = {
    hat: `<svg ${common}><path fill="currentColor" d="M9.2 7.2C9.4 5.8 12.2 5 16 5s6.6.8 6.8 2.2l-.7 11.1c2.8.5 5.3 1.4 6.8 2.5.8.6.8 1.5 0 2.1-2.2 1.8-7.3 3.1-12.9 3.1S5.3 24.7 3.1 22.9c-.8-.6-.8-1.5 0-2.1 1.5-1.1 4-2 6.8-2.5L9.2 7.2Zm2.2 10.7h9.2l.1-2.1h-9.4l.1 2.1Zm-5.6 3.8c2.4 1.2 6.2 1.9 10.2 1.9s7.8-.7 10.2-1.9c-1.3-.5-2.7-.9-4.3-1.2-.5 1.1-2.8 1.8-5.9 1.8s-5.4-.7-5.9-1.8c-1.6.3-3 .7-4.3 1.2Z"/></svg>`,
    tree: `<svg ${common}><path fill="currentColor" d="M16 3 7 15h5l-6 8h8v6h4v-6h8l-6-8h5L16 3Z"/></svg>`,
    leaf: `<svg ${common}><path fill="currentColor" d="M27 5C15.5 4.7 7.4 10 6.4 18.7c-.4 3.6 1.6 6.3 4.8 7.1 4.7 1.1 10.5-2.9 12.7-9.2C25.1 13 26 8.8 27 5Zm-4.7 4.1C18 16.9 14.3 21 9 24.4l-1.2-2c5-3.1 8.5-7 12.5-14l2 1.1Z"/></svg>`,
    mushroom: `<svg ${common}><path fill="currentColor" d="M4.7 15.9C5.6 9.1 10 5.8 16 5.8s10.4 3.3 11.3 10.1c.1.9-.6 1.7-1.5 1.7H6.2c-.9 0-1.6-.8-1.5-1.7Zm9 3.3h4.6l1 8c.2 1.4-.9 2.7-2.3 2.7h-2c-1.4 0-2.5-1.3-2.3-2.7l1-8Z"/></svg>`,
    train: `<svg ${common} viewBox="0 0 32 32"><path fill="currentColor" d="M5.5 20.5v-6.2h3.2v-3.1h2V8.6h1.8v2.6h2.2v2.1h5.2V8.5h7v8.7h1.8v3.3h-1.4a3.7 3.7 0 0 1-7.2 0h-2.1a3.7 3.7 0 0 1-7.2 0H9.6a3.7 3.7 0 0 1-4.1 2.8v-2.8Zm16.1-10.3v5.2h3.6v-5.2h-3.6ZM9.2 13.1h9.8v5.4H9.2v-5.4Z"/><path fill="currentColor" d="M7.7 18.1a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm0 1.7a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Zm7.5-1.7a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm0 1.7a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Zm8.5-1.7a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm0 1.7a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z"/><path fill="currentColor" d="M10.3 7.1h2.7v2.1h-2.7V7.1ZM9.5 6h4.3v1.4H9.5V6Z"/></svg>`,
    car: `<svg ${common}><path fill="currentColor" d="M9.2 9h13.6l3 6.1c1.3.5 2.2 1.7 2.2 3.2v4.2h-3V25h-4v-2.5H11V25H7v-2.5H4v-4.2c0-1.5.9-2.8 2.2-3.2L9.2 9Zm2 2.8-1.7 3.5h13l-1.7-3.5h-9.6ZM9 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm14 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/></svg>`,
  };
  return svgs[id] || null;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

export function renderIcons() {
  createIcons({ icons });
}

export function showToast(message, type = 'info') {
  logEvent(message, type);
  const region = document.querySelector('#toast-region');
  if (!region) return;
  const item = el('div', { className: `toast toast-${type}`, text: message });
  region.append(item);
  const timer = setTimeout(() => {
    item.remove();
    toastTimers.delete(timer);
  }, 5200);
  toastTimers.add(timer);
}

export function friendlyError(error, fallback = 'Något gick fel.') {
  const detail = error?.message || error?.details || error?.hint;
  return detail ? `${fallback} ${detail}` : fallback;
}

export function logEvent(message, type = 'info') {
  const stamp = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
  logEntries.unshift(`[${stamp}] ${type.toUpperCase()}: ${message}`);
  logEntries.splice(80);
  renderLog();
}

export function renderLog() {
  const output = document.querySelector('#app-log-output');
  if (!output) return;
  output.value = logEntries.join('\n');
}

export function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function formatRelative(value) {
  if (!value) return 'okänd tid';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} sek sedan`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min sedan`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} tim sedan`;
  const days = Math.round(hours / 24);
  return `${days} dagar sedan`;
}

export function memberName(userId) {
  const member = appState.members.find((item) => item.user_id === userId);
  return member?.profiles?.alias || member?.profile?.alias || 'Okänd';
}

export function memberSymbol(userId) {
  return getSymbol(memberSymbolId(userId)).glyph;
}

export function memberSymbolId(userId) {
  const member = appState.members.find((item) => item.user_id === userId);
  if (userId === appState.user?.id) return appState.profile?.symbol || 'hat';
  return member?.profiles?.symbol || member?.profile?.symbol || 'hat';
}

export function memberColor(userId) {
  const member = appState.members.find((item) => item.user_id === userId);
  if (userId === appState.user?.id) return appState.profile?.symbol_color || '#17324d';
  return member?.profiles?.symbol_color || member?.profile?.symbol_color || '#17324d';
}

export function memberShowsAlias(userId) {
  if (userId === appState.user?.id) return appState.profile?.show_alias !== false;
  const member = appState.members.find((item) => item.user_id === userId);
  return member?.profiles?.show_alias !== false;
}

export function setView(view) {
  appState.selectedView = view;
  document.querySelectorAll('.side-view').forEach((node) => {
    node.hidden = node.dataset.view !== view;
  });
  document.querySelectorAll('.nav-button').forEach((node) => {
    node.classList.toggle('active', node.dataset.view === view);
  });
  if (view === 'chat') appState.unreadChat = false;
  updateNavBadges();
  window.dispatchEvent(new CustomEvent('faltchatt:map-visible'));
}

export function setTopbarGroupChangeHandler(handler) {
  topbarGroupChangeHandler = handler || (async () => {});
}

export function setTopbarUserActionHandler(handler) {
  topbarUserActionHandler = handler || (async () => {});
}

export function updateNavBadges() {
  const hasPendingMembers = appState.members.some((member) => member.status === 'pending');
  const activeMembership = appState.memberships.find((member) => member.group_id === appState.activeGroupId);
  const ownMembershipPending = activeMembership?.status === 'pending';
  setNavBadge('group', hasPendingMembers);
  setNavBadge('map', ownMembershipPending);
  setNavBadge('chat', appState.unreadChat);
}

function setNavBadge(view, visible) {
  const button = document.querySelector(`.nav-button[data-view="${view}"]`);
  button?.classList.toggle('has-badge', Boolean(visible));
}

export function renderAppShell() {
  const app = document.querySelector('#app');
  app.innerHTML = '';
  app.append(
    el('div', { className: 'app-shell' }, [
      el('header', { className: 'topbar' }, [
        el('div', { className: 'brand' }, [el('span', { className: 'brand-mark', text: 'F' }), el('span', { text: 'Fältchatt' })]),
        el('div', { id: 'topbar-map-title', className: 'topbar-map-title' }),
        el('div', { id: 'session-pill', className: 'session-pill' }),
      ]),
      el('main', { className: 'workspace' }, [
        el('section', { id: 'auth-view', className: 'auth-view' }),
        el('div', { className: 'app-frame' }, [
          el('aside', { className: 'sidebar' }, [
            el('nav', { className: 'side-nav' }, [
              navButton('user', 'Profil', 'profile'),
              navButton('users', 'Grupp', 'group'),
              navButton('map', 'Karta', 'map'),
              navButton('message-square', 'Chatt', 'chat'),
              navButton('shield', 'Admin', 'admin'),
            ]),
            el('div', { className: 'sidebar-content' }, [
              el('section', { id: 'profile-view', className: 'side-view', 'data-view': 'profile' }),
              el('section', { id: 'group-view', className: 'side-view', 'data-view': 'group', hidden: true }),
              el('section', { id: 'map-controls-view', className: 'side-view', 'data-view': 'map', hidden: true }),
              el('section', { id: 'chat-view', className: 'side-view', 'data-view': 'chat', hidden: true }),
              el('section', { id: 'admin-view', className: 'side-view', 'data-view': 'admin', hidden: true }),
            ]),
            el('section', { className: 'log-panel' }, [
              el('div', { className: 'log-header' }, [
                el('strong', { text: 'Logg' }),
                el('button', {
                  className: 'small-button',
                  type: 'button',
                  onClick: async () => {
                    const value = document.querySelector('#app-log-output')?.value || '';
                    await navigator.clipboard?.writeText(value);
                  },
                }, [icon('copy', 'Kopiera'), 'Kopiera']),
              ]),
              el('textarea', { id: 'app-log-output', readonly: true, spellcheck: 'false' }),
            ]),
          ]),
          el('section', { id: 'map-view', className: 'map-view', 'data-view': 'map' }),
        ]),
      ]),
      el('div', { id: 'toast-region', className: 'toast-region', 'aria-live': 'polite' }),
    ]),
  );
  renderLog();
  renderIcons();
}

function navButton(iconName, text, view) {
  return el('button', { className: 'nav-button', 'data-view': view, title: text, 'aria-label': text, 'data-tooltip': text, onClick: () => setView(view) }, [icon(iconName, text), el('span', { text }), el('i', { className: 'nav-badge', 'aria-hidden': 'true' })]);
}

export function setSessionPill() {
  const pill = document.querySelector('#session-pill');
  if (!pill) return;
  pill.replaceChildren();
  if (appState.user) {
    pill.append(topbarUserMenu());
  } else {
    pill.textContent = 'Inte inloggad';
  }
  renderTopbarGroupSelector();
}

function topbarUserMenu() {
  const label = topbarUserLabel();
  const details = el('details', { className: 'topbar-user-menu' }, [
    el('summary', { title: label }, [el('span', { text: label })]),
    el('div', { className: 'topbar-user-dropdown' }, [
      el('button', {
        type: 'button',
        onClick: async () => {
          details.open = false;
          await topbarUserActionHandler('profile');
        },
      }, [icon('user', 'Profil'), 'Profil']),
      el('button', {
        type: 'button',
        className: 'topbar-user-signout',
        onClick: async () => {
          details.open = false;
          await topbarUserActionHandler('signout');
        },
      }, [icon('log-out', 'Logga ut'), 'Logga ut']),
    ]),
  ]);
  return details;
}

function topbarUserLabel() {
  const alias = appState.profile?.alias?.trim();
  if (alias) return alias;
  const emailPrefix = appState.user?.email?.split('@')[0]?.trim();
  return emailPrefix || 'Profil';
}

function renderTopbarGroupSelector() {
  const container = document.querySelector('#topbar-map-title');
  if (!container) return;
  container.replaceChildren();
  if (!appState.user) return;
  if (!appState.memberships.length) {
    container.append(el('span', {
      className: 'topbar-group-info',
      text: 'Skapa eller gå med i grupp via grupp-fliken',
      title: 'Skapa eller gå med i grupp via grupp-fliken',
    }));
    return;
  }
  const select = el('select', {
    className: 'topbar-group-select',
    title: 'Välj grupp',
    'aria-label': 'Välj grupp',
    onChange: async (event) => {
      window.dispatchEvent(new CustomEvent('faltchatt:group-changing'));
      await topbarGroupChangeHandler(event.target.value || null);
    },
  }, [
    el('option', { value: '', text: 'Ingen grupp vald' }),
    ...appState.memberships.map((membership) =>
      el('option', { value: membership.group_id, text: topbarGroupOptionText(membership) }),
    ),
  ]);
  select.value = appState.activeGroupId || '';
  container.append(select);
}

function topbarGroupOptionText(membership) {
  const name = membership.groups?.name || `Grupp ${membership.group_id.slice(0, 8)}`;
  return membership.status === 'approved' ? name : `${name} (${membership.status})`;
}
