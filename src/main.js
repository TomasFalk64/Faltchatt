import './styles.css';
import { isSupabaseConfigured } from './supabase.js';
import { initAuth, renderAuth, renderProfile, setAuthChangeHandler, signOutUser } from './auth.js';
import { loadGroups, loadPresence, refreshGroupDynamics, refreshMemberList, renderAdmin, renderGroups, subscribeGroups, unsubscribeGroups } from './groups.js';
import { loadChatData, refreshChatMessages, renderChat, subscribeChat, unsubscribeChat } from './chat.js';
import { loadLocations, refreshMapLayers, renderMapControls, renderMapView, startPresenceHeartbeat, startSharing, stopPresenceHeartbeat, stopSharing, subscribeLocations, unsubscribeLocations } from './map.js';
import { appState, setActiveGroupId } from './state.js';
import { renderAppShell, renderIcons, setSessionPill, setTopbarGroupChangeHandler, setTopbarUserActionHandler, setView, showToast, updateNavBadges } from './ui.js';

async function bootstrap() {
  renderAppShell();
  if (!isSupabaseConfigured) {
    document.querySelector('#auth-view').hidden = false;
    document.querySelector('#auth-view').innerHTML = '<div class="auth-panel"><h1>Fältchatt</h1><p>Supabase saknar konfiguration. Skapa <code>.env.local</code> från <code>.env.example</code>.</p></div>';
    document.querySelector('.app-frame').hidden = true;
    return;
  }
  setTopbarGroupChangeHandler(async (groupId) => {
    setActiveGroupId(groupId);
    await handleUserChange();
  });
  setTopbarUserActionHandler(async (action) => {
    if (action === 'profile') {
      setView('profile');
      return;
    }
    if (action === 'signout') await signOutUser();
  });
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
      appState.invites = [];
      appState.presence = [];
      appState.messages = [];
      appState.locations = [];
      stopSharing();
      stopPresenceHeartbeat();
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
      await Promise.all([loadLocations(), loadPresence()]);
      await refreshMapLayers();
      refreshMemberList(handleUserChange);
      updateNavBadges();
    });
    subscribeGroups(refreshGroupsIfChanged);
    renderAll();
    syncPresenceAndSharing();
  } catch (error) {
    console.error(error);
    showToast('Något gick fel vid laddning. Kontrollera nätverk och Supabase-inställningar.', 'error');
    renderAll();
  }
}

async function refreshGroupsIfChanged() {
  const before = groupStateSignature();
  await loadGroups();
  if (groupStateSignature() === before) {
    await Promise.all([loadLocations(), loadPresence()]);
    await refreshMapLayers();
    refreshMemberList(handleUserChange);
    updateNavBadges();
    renderIcons();
    return;
  }
  await Promise.all([refreshChatMessages(), loadLocations(), loadPresence()]);
  await refreshMapLayers();
  syncPresenceAndSharing();
  refreshGroupDynamics(handleUserChange);
  setSessionPill();
  updateNavBadges();
  renderIcons();
}

function groupStateSignature() {
  return [
    appState.activeGroupId || '',
    appState.activeGroup?.name || '',
    appState.memberships.map((member) => `${member.id}:${member.group_id}:${member.groups?.name || ''}:${member.role}:${member.status}`).join('|'),
    appState.members.map((member) => `${member.id}:${member.user_id}:${member.role}:${member.status}:${member.profiles?.alias || ''}:${member.profiles?.email || ''}:${member.profiles?.phone || ''}:${member.profiles?.show_phone}`).join('|'),
    appState.invites.map((invite) => `${invite.id}:${invite.email}:${invite.phone || ''}:${invite.alias || ''}:${invite.status}`).join('|'),
    appState.presence.map((presence) => `${presence.group_id}:${presence.user_id}:${presence.is_sharing_location}`).join('|'),
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
  renderGroups(handleUserChange);
  renderAdmin(handleUserChange);
  renderMapView(reloadAll);
  renderMapControls(reloadAll);
  renderChat();
  setView(appState.user ? appState.selectedView : 'profile');
  updateNavBadges();
  renderIcons();
}

async function handleUserChange() {
  await reloadAll();
}

function syncPresenceAndSharing() {
  if (appState.activeGroup && appState.memberships.some((member) => member.group_id === appState.activeGroupId && member.status === 'approved')) startPresenceHeartbeat();
  else stopPresenceHeartbeat();
  if (appState.locationSharingEnabled) startSharing();
}

bootstrap();
