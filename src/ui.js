import { createIcons, icons } from 'lucide';
import { appState, getSymbol } from './state.js';

const toastTimers = new Set();

export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(options).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
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

export function renderIcons() {
  createIcons({ icons });
}

export function showToast(message, type = 'info') {
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
  const member = appState.members.find((item) => item.user_id === userId);
  return getSymbol(member?.profiles?.symbol || member?.profile?.symbol || 'circle').glyph;
}

export function setView(view) {
  appState.selectedView = view;
  document.querySelectorAll('.view').forEach((node) => {
    node.hidden = node.dataset.view !== view;
  });
  document.querySelectorAll('.nav-button').forEach((node) => {
    node.classList.toggle('active', node.dataset.view === view);
  });
  if (view === 'map') window.dispatchEvent(new CustomEvent('faltchatt:map-visible'));
}

export function renderAppShell() {
  const app = document.querySelector('#app');
  app.innerHTML = '';
  app.append(
    el('div', { className: 'app-shell' }, [
      el('header', { className: 'topbar' }, [
        el('div', { className: 'brand' }, [el('span', { className: 'brand-mark', text: 'F' }), el('span', { text: 'Fältchatt' })]),
        el('div', { id: 'session-pill', className: 'session-pill' }),
      ]),
      el('main', { className: 'views' }, [
        el('section', { id: 'auth-view', className: 'auth-view' }),
        el('section', { id: 'profile-view', className: 'view', 'data-view': 'profile' }),
        el('section', { id: 'group-view', className: 'view', 'data-view': 'group', hidden: true }),
        el('section', { id: 'map-view', className: 'view map-view', 'data-view': 'map', hidden: true }),
        el('section', { id: 'chat-view', className: 'view', 'data-view': 'chat', hidden: true }),
      ]),
      el('nav', { className: 'bottom-nav' }, [
        navButton('user', 'Profil', 'profile'),
        navButton('users', 'Grupp', 'group'),
        navButton('map', 'Karta', 'map'),
        navButton('message-square', 'Chatt', 'chat'),
      ]),
      el('div', { id: 'toast-region', className: 'toast-region', 'aria-live': 'polite' }),
    ]),
  );
  renderIcons();
}

function navButton(iconName, text, view) {
  return el('button', { className: 'nav-button', 'data-view': view, onClick: () => setView(view) }, [icon(iconName, text), el('span', { text })]);
}

export function setSessionPill() {
  const pill = document.querySelector('#session-pill');
  if (!pill) return;
  pill.textContent = appState.user ? appState.profile?.alias || appState.user.email : 'Inte inloggad';
}
