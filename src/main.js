import './styles.css';
import { isSupabaseConfigured } from './supabase.js';
import { initAuth, renderAuth, renderProfile, setAuthChangeHandler } from './auth.js';
import { loadGroups, loadMembers, renderGroups, subscribeGroups, unsubscribeGroups } from './groups.js';
import { loadChatData, refreshChatMessages, renderChat, subscribeChat, unsubscribeChat } from './chat.js';
import { loadLocations, refreshMapLayers, renderMapControls, renderMapView, startSharing, stopSharing, subscribeLocations, unsubscribeLocations } from './map.js';
import { appState, setActiveGroupId } from './state.js';
import { renderAppShell, renderIcons, setSessionPill, setView, showToast, updateNavBadges } from './ui.js';

async function bootstrap() {
  renderAppShell();
  if (!isSupabaseConfigured) {
    document.querySelector('#auth-view').hidden = false;
    document.querySelector('#auth-view').innerHTML = '<div class="auth-panel"><h1>Fältchatt</h1><p>Supabase saknar konfiguration. Skapa <code>.env.local</code> från <code>.env.example</code>.</p></div>';
    document.querySelector('.app-frame').hidden = true;
    return;
  }
  setAuthChangeHandler(reloadAll);
  await initAuth();
  await reloadAll();
}

async function reloadAll() {
  try {
    unsubscribeChat();
    unsubscribeLocations();
    unsubscribeGroups();
    if (!appState.user) {
      appState.activeGroup = null;
      appState.memberships = [];
      appState.members = [];
      appState.messages = [];
      appState.locations = [];
      stopSharing();
      renderAll();
      return;
    }
    await loadGroups();
    if (appState.activeGroupId && !appState.memberships.some((item) => item.group_id === appState.activeGroupId)) {
      setActiveGroupId(null);
      await loadGroups();
    }
    await Promise.all([loadChatData(), loadLocations()]);
    subscribeChat(async () => {
      const beforeLocations = locationMessageSignature();
      await refreshChatMessages();
      if (locationMessageSignature() !== beforeLocations) await refreshMapLayers();
    });
    subscribeLocations(async () => {
      await loadLocations();
      await refreshMapLayers();
    });
    subscribeGroups(refreshGroupsIfChanged);
    renderAll();
    if (appState.locationSharingEnabled) startSharing();
  } catch (error) {
    console.error(error);
    showToast('Något gick fel vid laddning. Kontrollera nätverk och Supabase-inställningar.', 'error');
    renderAll();
  }
}

async function refreshGroupsIfChanged() {
  const before = groupStateSignature();
  await loadGroups();
  if (groupStateSignature() === before) return;
  await Promise.all([loadChatData(), loadLocations()]);
  renderAll();
}

function groupStateSignature() {
  return [
    appState.activeGroupId || '',
    appState.activeGroup?.name || '',
    appState.memberships.map((member) => `${member.id}:${member.group_id}:${member.groups?.name || ''}:${member.role}:${member.status}`).join('|'),
    appState.members.map((member) => `${member.id}:${member.user_id}:${member.role}:${member.status}:${member.profiles?.alias || ''}:${member.profiles?.email || ''}`).join('|'),
  ].join('::');
}

function locationMessageSignature() {
  return appState.messages
    .filter((message) => message.type === 'location' && message.latitude && message.longitude)
    .map((message) => `${message.id}:${message.latitude}:${message.longitude}:${message.text}`)
    .join('|');
}

function renderAll() {
  renderAuth();
  document.querySelector('.app-frame').hidden = !appState.user;
  setSessionPill();
  renderProfile();
  renderGroups(async () => {
    await loadGroups();
    await Promise.all([loadMembers(), loadChatData(), loadLocations()]);
    renderAll();
  });
  renderMapView(reloadAll);
  renderMapControls(reloadAll);
  renderChat();
  setView(appState.user ? appState.selectedView : 'profile');
  updateNavBadges();
  renderIcons();
}

bootstrap();
