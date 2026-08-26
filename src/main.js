import './styles.css';
import { isSupabaseConfigured } from './supabase.js';
import { initAuth, renderAuth, renderProfile, setAuthChangeHandler, signOutUser } from './auth.js';
import { applyPresencePayload, loadGroups, loadPresence, refreshMemberList, renderAdmin, renderGroups, subscribeGroups, unsubscribeGroups } from './groups.js';
import { applyMessagePayload, loadChatData, refreshChatMessages, renderChat, subscribeChat, unsubscribeChat } from './chat.js';
import { applyLocationPayload, loadLocations, refreshMapLayers, renderMapControls, renderMapView, startPresenceHeartbeat, startSharing, stopPresenceHeartbeat, stopSharing, subscribeLocations, unsubscribeLocations } from './map.js';
import { appState, setActiveGroupId, setLocationSharingEnabled } from './state.js';
import { el, renderAppShell, renderIcons, setSessionPill, setTopbarGroupChangeHandler, setTopbarUserActionHandler, setView, showToast, updateNavBadges } from './ui.js';

let currentUserId = null;
let locationPromptShownForUserId = null;
let locationSharingModalOpen = false;

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
  window.addEventListener('faltchatt:enable-location-sharing', () => showLocationSharingModal());
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
      currentUserId = null;
      locationPromptShownForUserId = null;
      appState.activeGroup = null;
      appState.memberships = [];
      appState.members = [];
      appState.presence = [];
      appState.messages = [];
      appState.locations = [];
      stopSharing();
      stopPresenceHeartbeat();
      renderAll();
      return;
    }
    const isNewLogin = currentUserId !== appState.user.id;
    if (isNewLogin) {
      currentUserId = appState.user.id;
      appState.selectedView = 'group';
    }
    await loadGroups();
    if (appState.activeGroupId && !appState.memberships.some((item) => item.group_id === appState.activeGroupId)) {
      setActiveGroupId(null);
      await loadGroups();
    }
    await Promise.all([loadChatData(), loadLocations()]);
    subscribeChat(handleMessagePayload, refreshChatFallback);
    subscribeLocations(async (payload) => {
      if (!applyLocationPayload(payload)) return;
      await refreshMapLayers();
    }, async () => {
      await Promise.all([loadLocations(), loadPresence()]);
      await refreshMapLayers();
      refreshMemberList(handleUserChange);
      updateNavBadges();
    });
    subscribeGroups(refreshGroupsIfChanged, async (payload) => {
      if (!applyPresencePayload(payload)) return;
      await refreshMapLayers();
      refreshMemberList(handleUserChange);
      updateNavBadges();
      renderIcons();
    });
    renderAll();
    syncPresenceAndSharing();
    if (isNewLogin) maybeShowLocationSharingModal();
  } catch (error) {
    console.error(error);
    showToast('Något gick fel vid laddning. Kontrollera nätverk och Supabase-inställningar.', 'error');
    renderAll();
  }
}

async function handleMessagePayload(payload) {
  const changedLocationMessages = applyMessagePayload(payload);
  if (changedLocationMessages === null) {
    await refreshChatFallback();
    return;
  }
  if (changedLocationMessages) await refreshMapLayers();
}

async function refreshChatFallback() {
  const beforeLocations = locationMessageSignature();
  await refreshChatMessages();
  if (locationMessageSignature() !== beforeLocations) await refreshMapLayers();
}

async function refreshGroupsIfChanged() {
  const before = groupStateSignature();
  const beforeActiveGroupId = appState.activeGroupId;
  const beforeMemberships = new Map(appState.memberships.map((member) => [member.group_id, member.status]));
  const beforeApprovedCount = appState.memberships.filter((member) => member.status === 'approved').length;
  await loadGroups();
  const newlyApproved = appState.memberships.find(
    (member) => member.status === 'approved' && beforeMemberships.get(member.group_id) && beforeMemberships.get(member.group_id) !== 'approved',
  );
  if (newlyApproved) {
    appState.groupNotice = {
      type: 'accepted',
      groupId: newlyApproved.group_id,
      groupName: newlyApproved.groups?.name || `Grupp ${newlyApproved.group_id.slice(0, 8)}`,
    };
    appState.unreadGroup = appState.selectedView !== 'group';
    if (!beforeActiveGroupId && beforeApprovedCount === 0) {
      setActiveGroupId(newlyApproved.group_id);
      await loadGroups();
    }
  }
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
  renderGroups(handleUserChange);
  setSessionPill();
  updateNavBadges();
  renderIcons();
}

function groupStateSignature() {
  return [
    appState.activeGroupId || '',
    appState.activeGroup?.name || '',
    appState.memberships.map((member) => `${member.id}:${member.group_id}:${member.groups?.name || ''}:${member.role}:${member.status}`).join('|'),
    appState.members.map((member) => `${member.id}:${member.user_id}:${member.role}:${member.status}:${member.profiles?.alias || ''}`).join('|'),
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

function maybeShowLocationSharingModal() {
  if (!appState.user || appState.locationSharingEnabled) return;
  if (locationPromptShownForUserId === appState.user.id) return;
  locationPromptShownForUserId = appState.user.id;
  showLocationSharingModal();
}

function showLocationSharingModal() {
  if (!appState.user || appState.locationSharingEnabled || locationSharingModalOpen) return;
  locationSharingModalOpen = true;
  const close = () => {
    locationSharingModalOpen = false;
    overlay.remove();
  };
  const allow = async () => {
    setLocationSharingEnabled(true);
    startSharing();
    close();
    await reloadAll();
  };
  const overlay = el('div', { className: 'app-modal-backdrop', role: 'presentation' }, [
    el('section', { className: 'app-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'location-sharing-title' }, [
      el('h2', { id: 'location-sharing-title', text: 'Tillåt position?' }),
      el('p', { text: 'Appen behöver visa och dela din position för att andra i gruppen ska kunna se var du är.' }),
      el('div', { className: 'app-modal-actions' }, [
        el('button', { type: 'button', className: 'ghost', onClick: close }, ['Inte nu']),
        el('button', { type: 'button', className: 'primary', onClick: allow }, ['Tillåt']),
      ]),
    ]),
  ]);
  document.body.append(overlay);
  overlay.querySelector('.primary')?.focus();
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

