import { requireSupabase } from './supabase.js';
import { appState, presenceForUser, setActiveGroupId } from './state.js';
import { el, formatRelative, friendlyError, icon, logEvent, renderIcons, showToast, symbolNode } from './ui.js';

let groupChannel = null;
let groupRefreshTimer = null;
const presenceDebugState = new Map();

export function isApprovedMember() {
  return Boolean(
    appState.activeGroup &&
      !isGroupExpired(appState.activeGroup) &&
      appState.memberships.some((member) => member.group_id === appState.activeGroupId && member.status === 'approved'),
  );
}

export function currentRole() {
  if (!appState.activeGroup || isGroupExpired(appState.activeGroup)) return null;
  return (
    appState.memberships.find((member) => member.group_id === appState.activeGroupId)?.role ||
    appState.members.find((member) => member.group_id === appState.activeGroupId && member.user_id === appState.user?.id)?.role ||
    null
  );
}

export function canAdminGroup() {
  return ['owner', 'admin'].includes(currentRole());
}

export function isGroupOwner() {
  return currentRole() === 'owner';
}

export async function loadGroups() {
  if (!appState.user) return;
  const client = requireSupabase();
  const { data: memberships, error } = await client
    .from('group_members')
    .select('*, groups(*)')
    .eq('user_id', appState.user.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  appState.memberships = (memberships || []).filter((membership) => membership.groups && !isGroupExpired(membership.groups));

  if (appState.activeGroupId) {
    const membership = appState.memberships.find((item) => item.group_id === appState.activeGroupId);
    if (membership?.groups && !isGroupExpired(membership.groups)) {
      appState.activeGroup = membership.groups;
      await loadMembers();
      await loadPresence();
    } else {
      setActiveGroupId(null);
      appState.activeGroup = null;
      appState.members = [];
      appState.presence = [];
    }
  } else {
    appState.activeGroup = null;
    appState.members = [];
    appState.presence = [];
  }
}

export async function loadMembers() {
  if (!appState.activeGroupId) return;
  const { data, error } = await requireSupabase()
    .from('group_members')
    .select('*, profiles(id, alias, symbol, symbol_color)')
    .eq('group_id', appState.activeGroupId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  appState.members = data || [];
}

export async function loadPresence() {
  if (!appState.activeGroupId || !isApprovedMember()) {
    appState.presence = [];
    return;
  }
  const { data, error } = await requireSupabase()
    .from('group_presence')
    .select('*')
    .eq('group_id', appState.activeGroupId);
  if (error) throw error;
  appState.presence = data || [];
  auditPresenceStatuses('fallback');
}

export function applyPresencePayload(payload) {
  const row = payload.new || payload.old;
  if (!row || row.group_id !== appState.activeGroupId) return false;
  if (payload.eventType === 'DELETE') {
    appState.presence = appState.presence.filter((presence) => !(presence.group_id === row.group_id && presence.user_id === row.user_id));
    auditPresenceStatuses('Realtime');
    return true;
  }
  const index = appState.presence.findIndex((presence) => presence.group_id === row.group_id && presence.user_id === row.user_id);
  if (index >= 0) appState.presence[index] = { ...appState.presence[index], ...row };
  else appState.presence.push(row);
  auditPresenceStatuses('Realtime');
  return true;
}

export function subscribeGroups(onChanged, onPresenceChanged) {
  unsubscribeGroups();
  if (!appState.user) return;
  let channel = requireSupabase()
    .channel('group-memberships')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'group_members' }, onChanged);
  if (appState.activeGroupId && isApprovedMember()) {
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'group_presence', filter: `group_id=eq.${appState.activeGroupId}` },
      onPresenceChanged,
    );
  }
  groupChannel = channel.subscribe();
  groupRefreshTimer = window.setInterval(onChanged, 30000);
}

export function unsubscribeGroups() {
  if (groupChannel) requireSupabase().removeChannel(groupChannel);
  groupChannel = null;
  if (groupRefreshTimer) window.clearInterval(groupRefreshTimer);
  groupRefreshTimer = null;
}

export function renderGroups(onChanged = async () => {}) {
  const view = document.querySelector('#group-view');
  view.innerHTML = '';
  if (!appState.user) return;

  view.append(
    el('div', { className: 'page sidebar-page' }, [
      el('section', { className: 'panel stack' }, [
        el('div', { id: 'group-select-region' }, [groupSelectControl(onChanged)]),
        el('div', { id: 'group-member-list-region' }, [memberList(onChanged)]),
        el('div', { id: 'group-summary-region' }, [activeGroupSummary()]),
        createGroupForm(onChanged),
        joinGroupForm(onChanged),
      ]),
    ]),
  );
  renderIcons();
}

export function refreshGroupDynamics(onChanged = async () => {}) {
  const selectRegion = document.querySelector('#group-select-region');
  if (selectRegion) selectRegion.replaceChildren(groupSelectControl(onChanged));
  refreshMemberList(onChanged);
  const summaryRegion = document.querySelector('#group-summary-region');
  if (summaryRegion) summaryRegion.replaceChildren(activeGroupSummary());
  renderIcons();
}

export function refreshMemberList(onChanged = async () => {}) {
  const region = document.querySelector('#group-member-list-region');
  if (!region) return;
  region.replaceChildren(memberList(onChanged));
  renderIcons();
}

function isGroupExpired(group) {
  return Boolean(group?.expires_at && new Date(group.expires_at).getTime() <= Date.now());
}

function formatExpiry(value) {
  return new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function groupSelectControl(onChanged) {
  const groupSelect = el(
    'select',
    {
      onChange: async (event) => {
        window.dispatchEvent(new CustomEvent('faltchatt:group-changing'));
        setActiveGroupId(event.target.value || null);
        await onChanged();
      },
    },
    [
      el('option', { value: '', text: 'Ingen grupp vald' }),
      ...appState.memberships.map((membership) =>
        el('option', { value: membership.group_id, text: groupOptionText(membership) }),
      ),
    ],
  );
  groupSelect.value = appState.activeGroupId || '';
  return el('label', { className: 'group-section-label' }, ['Aktuell grupp', groupSelect]);
}

export function renderAdmin(onChanged = async () => {}) {
  const view = document.querySelector('#admin-view');
  if (!view) return;
  view.innerHTML = '';
  if (!appState.user) return;

  let content;
  if (!appState.activeGroup) {
    content = el('p', { className: 'muted', text: 'Välj en grupp i gruppfliken för att se administration.' });
  } else if (!canAdminGroup()) {
    content = el('p', { className: 'muted', text: 'Administrationsverktyg visas för owner och admin i den valda gruppen.' });
  } else {
    content = [
      invitationControl(),
      isGroupOwner() ? adminRoleControl(onChanged) : null,
      isGroupOwner() ? clearLocationPinsControl(onChanged) : null,
      isGroupOwner() ? clearChatControl(onChanged) : null,
      isGroupOwner() ? deleteGroupControl(onChanged) : null,
    ];
  }

  view.append(
    el('div', { className: 'page sidebar-page' }, [
      el('section', { className: 'panel stack' }, [
        el('h2', { text: 'Administration' }),
        ...(Array.isArray(content) ? content : [content]),
      ]),
    ]),
  );
  renderIcons();
}

function activeGroupSummary() {
  if (!appState.activeGroup) return el('p', { className: 'muted', text: 'Skapa eller gå med i en grupp för att använda karta och chatt.' });
  const membership = appState.memberships.find((item) => item.group_id === appState.activeGroupId);
  const expired = isGroupExpired(appState.activeGroup);
  return el('div', { className: 'group-summary' }, [
    el('div', { className: 'group-code-line' }, [
      el('span', { text: 'Gruppkod:' }),
      el('code', {
        text: appState.activeGroup.join_code,
        title: 'Ge gruppkoden till personer som ska begära medlemskap i gruppen.',
      }),
    ]),
    appState.activeGroup.expires_at ? el('p', { className: 'muted', text: `Raderas automatiskt ${formatExpiry(appState.activeGroup.expires_at)}.` }) : null,
    expired ? el('p', { className: 'warning-text', text: 'Gruppen har gått ut.' }) : null,
    !expired && membership?.status !== 'approved' ? el('p', { className: 'warning-text', text: 'Du väntar på godkännande innan karta och chatt öppnas.' }) : null,
  ]);
}

function groupOptionText(membership) {
  const name = membership.groups?.name || `Grupp ${membership.group_id.slice(0, 8)}`;
  if (membership.groups && isGroupExpired(membership.groups)) return `${name} (utgången)`;
  return membership.status === 'approved' ? name : `${name} (${membership.status})`;
}

function createGroupForm(onChanged) {
  const input = el('input', { placeholder: 'Gruppnamn' });
  const submit = async (event) => {
    event.preventDefault();
    const groupName = input.value.trim();
    if (!groupName) return;
    try {
      const { data: groupId, error } = await requireSupabase().rpc('create_group_with_owner', { group_name: groupName });
      if (error) throw error;
      input.value = '';
      await onChanged();
      const createdMembership = appState.memberships.find((membership) => membership.group_id === groupId);
      const joinCode = createdMembership?.groups?.join_code;
      const expiryText = createdMembership?.groups?.expires_at ? `\n\nGruppen raderas automatiskt ${formatExpiry(createdMembership.groups.expires_at)}.` : '\n\nGruppen raderas automatiskt efter 7 dagar.';
      window.alert(
        joinCode
          ? `Gruppen "${groupName}" är skapad och går att ansluta till med gruppkod:\n\n${joinCode}${expiryText}`
          : `Gruppen "${groupName}" är skapad och går att ansluta till.${expiryText}`,
      );
      showToast('Gruppen skapades.', 'success');
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte skapa grupp.'), 'error');
    }
  };
  return el('form', { className: 'stack subsection create-group-section', onSubmit: submit }, [
    el('h3', { text: 'Skapa grupp' }),
    el('p', { className: 'muted', text: 'Gruppen raderas automatiskt efter 7 dagar. Max 30 personer per grupp och max 30 pågående grupper totalt.' }),
    el('div', { className: 'compact-form-row' }, [
      input,
      el('button', { className: 'primary', type: 'submit' }, [icon('plus', 'Skapa'), 'Skapa']),
    ]),
  ]);
}

function joinGroupForm(onChanged) {
  const input = el('input', { placeholder: 'Ange gruppkod, tex vild-snäll-murkla', autocapitalize: 'none' });
  const submit = async (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    try {
      const { error } = await requireSupabase().rpc('request_group_membership', { requested_join_code: input.value.trim() });
      if (error) throw error;
      showToast('Medlemsförfrågan skickad.', 'success');
      input.value = '';
      await onChanged();
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte gå med.'), 'error');
    }
  };
  return el('form', { className: 'stack subsection', onSubmit: submit }, [
    el('h3', { text: 'Gå med i grupp' }),
    el('div', { className: 'compact-form-row' }, [
      input,
      el('button', { className: 'secondary', type: 'submit' }, [icon('user-plus', 'Gå med'), 'Ansök']),
    ]),
  ]);
}

function memberList(onChanged) {
  if (!appState.activeGroup) return el('p', { className: 'muted', text: 'Ingen grupp vald.' });
  if (!isApprovedMember()) return el('p', { className: 'muted', text: 'Medlemslistan visas efter godkännande.' });
  const admin = canAdminGroup();
  const owner = isGroupOwner();
  const list = el('div', { className: 'member-list' });
  [...appState.members].sort(compareMembers).forEach((member) => {
    const profile = member.profiles || {};
    const label = profile.alias || `Användare ${member.user_id.slice(0, 8)}`;
    const isSelf = member.user_id === appState.user.id;
    const canRemove = isSelf || (owner && member.role !== 'owner');
    const removeLabel = isSelf ? 'Gå ur gruppen' : 'Ta bort medlem';
    const activeText = memberPresence(member.user_id) ? 'aktiv' : '';
    const infoPanel = memberInfoPanel(member);
    list.append(
      el('div', {
        className: `member-row status-${member.status}`,
        title: 'Visa medlemsinfo',
        onClick: () => infoPanel.hidden = !infoPanel.hidden,
      }, [
        Object.assign(symbolNode(profile.symbol || 'hat', 'member-symbol'), { style: `color: ${profile.symbol_color || '#17324d'}` }),
        el('div', { className: 'member-main' }, [
          el('strong', { text: label }),
          el('small', { text: memberRowMeta(member, activeText) }),
        ]),
        infoPanel,
        admin && member.status === 'pending'
          ? el('div', { className: 'row-actions' }, [
              actionButton('check', 'Godkänn', (event) => {
                event.stopPropagation();
                updateMember(member.id, { status: 'approved', approved_at: new Date().toISOString() }, onChanged);
              }),
              actionButton('x', 'Avvisa', (event) => {
                event.stopPropagation();
                updateMember(member.id, { status: 'rejected' }, onChanged);
              }),
            ])
          : null,
        member.status !== 'pending'
          ? actionButton('x', canRemove ? removeLabel : 'Bara owner kan ta bort andra medlemmar', (event) => {
              event.stopPropagation();
              removeMember(member, label, onChanged);
            }, {
              className: 'danger-icon-button member-remove-button',
              disabled: !canRemove,
            })
          : null,
      ]),
    );
  });
  return list;
}

function memberInfoPanel(member) {
  const presence = memberPresence(member.user_id);
  return el('div', { className: 'member-info-popover', hidden: true, onClick: (event) => event.stopPropagation() }, [
    el('div', {}, [el('span', { text: 'Senast aktiv: ' }), el('span', { text: presence ? formatRelative(presence.last_seen) : 'okänd' })]),
  ]);
}

function compareMembers(a, b) {
  const roleRank = { owner: 0, admin: 1, member: 2 };
  const statusRank = { approved: 0, pending: 1, rejected: 2 };
  const roleDiff = (roleRank[a.role] ?? 3) - (roleRank[b.role] ?? 3);
  if (roleDiff) return roleDiff;
  const activeDiff = Number(memberPresence(b.user_id)) - Number(memberPresence(a.user_id));
  if (activeDiff) return activeDiff;
  const statusDiff = (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3);
  if (statusDiff) return statusDiff;
  const nameA = a.profiles?.alias || '';
  const nameB = b.profiles?.alias || '';
  return nameA.localeCompare(nameB, 'sv');
}

function memberPresence(userId) {
  return presenceForUser(userId);
}

function auditPresenceStatuses(source) {
  if (!appState.activeGroupId || !appState.members.length) return;
  appState.members
    .filter((member) => member.status === 'approved')
    .forEach((member) => {
      const row = appState.presence.find((presence) => presence.user_id === member.user_id);
      const active = Boolean(presenceForUser(member.user_id));
      const sharing = Boolean(row?.is_sharing_location);
      const key = `${appState.activeGroupId}:${member.user_id}`;
      const previous = presenceDebugState.get(key);
      const label = member.profiles?.alias || `Användare ${member.user_id.slice(0, 8)}`;
      const reason = presenceStatusReason(row, active);
      if (!previous) {
        logEvent(`Presence ${source}: ${label} är ${active ? 'aktiv' : 'inaktiv'} (${reason}, dela position ${sharing ? 'ja' : 'nej'}).`, 'info');
      } else if (previous.active !== active) {
        logEvent(`Presence ${source}: ${label} ändrades till ${active ? 'aktiv' : 'inaktiv'} (${reason}).`, 'info');
      } else if (previous.sharing !== sharing) {
        logEvent(`Presence ${source}: ${label} ändrade dela position till ${sharing ? 'ja' : 'nej'}.`, 'info');
      }
      presenceDebugState.set(key, { active, sharing });
    });
}

function presenceStatusReason(row, active) {
  if (!row?.last_seen) return 'presence-rad saknas';
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(row.last_seen).getTime()) / 1000));
  return active ? `last_seen ${ageSeconds} s sedan` : `last_seen ${ageSeconds} s sedan, för gammal`;
}

function memberRowMeta(member, activeText) {
  const role = ['owner', 'admin'].includes(member.role) ? member.role : 'member';
  const status = member.status === 'approved' ? activeText : member.status;
  return [role, status].filter(Boolean).join(' · ');
}

function adminRoleControl(onChanged) {
  const members = appState.members.filter((member) => member.status === 'approved' && member.role !== 'owner');
  const memberSelect = el(
    'select',
    {},
    members.length
      ? members.map((member) => el('option', { value: member.id, text: memberLabel(member) }))
      : [el('option', { value: '', text: 'Ingen medlem att välja' })],
  );
  const roleSelect = el('select', {}, [
    el('option', { value: 'admin', text: 'admin' }),
    el('option', { value: 'member', text: 'member' }),
  ]);
  memberSelect.addEventListener('change', () => {
    const member = members.find((item) => item.id === memberSelect.value);
    roleSelect.value = member?.role === 'admin' ? 'admin' : 'member';
  });
  if (members[0]?.role === 'admin') roleSelect.value = 'admin';

  const submit = async (event) => {
    event.preventDefault();
    const member = members.find((item) => item.id === memberSelect.value);
    if (!member) return;
    await updateMember(member.id, { role: roleSelect.value }, onChanged);
  };

  return el('form', { className: 'admin-cleanup admin-role-control', onSubmit: submit }, [
    el('p', { className: 'muted', text: 'Utse eller ta bort admin för godkända medlemmar.' }),
    el('div', { className: 'compact-form-row' }, [
      memberSelect,
      roleSelect,
      el('button', { type: 'submit', className: 'secondary', disabled: !members.length }, [icon('shield-check', 'Spara adminroll'), 'Spara']),
    ]),
  ]);
}

function memberLabel(member) {
  const profile = member.profiles || {};
  const name = profile.alias || `Användare ${member.user_id.slice(0, 8)}`;
  return `${name} (${member.role === 'admin' ? 'admin' : 'member'})`;
}

function invitationControl() {
  const text = el('div', {
    className: 'invitation-text rich-invitation-text',
    contenteditable: 'true',
    role: 'textbox',
    'aria-label': 'Inbjudningstext',
    spellcheck: 'true',
    html: invitationHtml(),
  });
  const copyButton = el('button', {
    type: 'button',
    className: 'primary invitation-copy-button',
    onClick: async () => {
      try {
        await copyInvitation(text);
        showToast('Inbjudan kopierad', 'success');
      } catch (error) {
        console.error(error);
        showToast(friendlyError(error, 'Kunde inte kopiera inbjudan.'), 'error');
      }
    },
  }, [icon('copy', 'Kopiera'), 'Kopiera']);
  const invitationPanel = el('div', { className: 'invitation-panel', hidden: true }, [text, copyButton]);

  return el('div', { className: 'admin-cleanup invitation-control' }, [
    el('button', {
      type: 'button',
      className: 'secondary',
      onClick: () => {
        const willShow = invitationPanel.hidden;
        text.innerHTML = invitationHtml();
        invitationPanel.hidden = !willShow;
        if (willShow) text.focus();
      },
    }, [icon('mail-plus', 'Inbjudan'), 'Inbjudan']),
    invitationPanel,
  ]);
}

async function copyInvitation(node) {
  const html = node.innerHTML;
  const plain = node.innerText.trim();
  if (navigator.clipboard?.write && window.ClipboardItem) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
    return;
  }
  await navigator.clipboard?.writeText(plain);
}

function invitationHtml() {
  const groupName = appState.activeGroup?.name || 'gruppen';
  const groupCode = appState.activeGroup?.join_code || '';
  const url = appUrl();
  return [
    `Du har blivit inbjuden till <strong>${escapeHtml(groupName)}</strong> i Fältchatt.`,
    `Gruppkod: <strong>${escapeHtml(groupCode)}</strong>`,
    'Ange gruppkoden i Fältchatt för att ansluta till grupp.',
    'Om du inte har ett konto behöver du först skapa ett.',
    `Öppna Fältchatt: <a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`,
  ].join('<br>');
}

function appUrl() {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
function clearLocationPinsControl(onChanged) {
  return el('div', { className: 'admin-cleanup map-cleanup' }, [
    el('p', { className: 'muted', text: 'Rensa skickade platsnålar för gruppen. Vanliga chattmeddelanden och polls sparas.' }),
    el('button', {
      type: 'button',
      className: 'danger-button',
      title: 'Rensa skickade platsnålar permanent',
      onClick: () => clearLocationPins(onChanged),
    }, [icon('map-pin-x', 'Rensa'), 'Rensa platsnålar']),
  ]);
}

async function clearLocationPins(onChanged) {
  if (!isGroupOwner() || !appState.activeGroupId) return;
  const confirmed = window.confirm('Rensa alla skickade platsnålar i gruppen?\n\nPlatsmeddelandena tas bort permanent, men övrig chatt sparas.');
  if (!confirmed) return;
  try {
    const { data, error } = await requireSupabase().rpc('clear_group_location_messages', { target_group_id: appState.activeGroupId });
    if (error) throw error;
    showToast(`Platsnålar rensades. ${data ?? 0} platsmeddelanden togs bort.`, 'success');
    await onChanged();
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte rensa platsnålar.'), 'error');
  }
}

function clearChatControl(onChanged) {
  const owner = isGroupOwner();
  const groupName = appState.activeGroup?.name || 'gruppen';
  return el('div', { className: 'admin-cleanup' }, [
    el('p', { className: 'muted', text: 'Rensa hela chatten för gruppen. Textmeddelanden, polls, svar och platsnålar tas bort permanent.' }),
    el('button', {
      type: 'button',
      className: 'danger-button',
      disabled: !owner,
      title: owner ? 'Rensa hela chatten permanent' : 'Bara gruppens owner kan rensa chatten',
      onClick: () => clearGroupChat(groupName, onChanged),
    }, [icon('trash-2', 'Rensa'), 'Rensa chatt']),
  ]);
}

async function clearGroupChat(groupName, onChanged) {
  if (!isGroupOwner() || !appState.activeGroupId) return;
  const confirmed = window.confirm(`Rensa hela chatten i "${groupName}"?\n\nDet tar bort textmeddelanden, polls, svar och platsnålar permanent.`);
  if (!confirmed) return;
  try {
    const { data, error } = await requireSupabase().rpc('clear_group_chat', { target_group_id: appState.activeGroupId });
    if (error) throw error;
    showToast(`Chatten rensades. ${data ?? 0} meddelanden togs bort.`, 'success');
    await onChanged();
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte rensa chatten.'), 'error');
  }
}

function deleteGroupControl(onChanged) {
  const owner = isGroupOwner();
  const groupName = appState.activeGroup?.name || 'gruppen';
  return el('div', { className: 'admin-cleanup delete-group-cleanup' }, [
    el('p', { className: 'muted', text: 'Ta bort hela gruppen permanent. Medlemmar, positioner, chatt och polls tas bort.' }),
    el('button', {
      type: 'button',
      className: 'danger-button',
      disabled: !owner || !appState.activeGroupId,
      title: owner ? 'Ta bort gruppen permanent' : 'Bara gruppens owner kan ta bort gruppen',
      onClick: () => deleteGroup(groupName, onChanged),
    }, [icon('trash-2', 'Ta bort'), 'Ta bort grupp']),
  ]);
}

async function deleteGroup(groupName, onChanged) {
  if (!isGroupOwner() || !appState.activeGroupId) return;
  const confirmed = window.confirm(`Ta bort gruppen "${groupName}" permanent?\n\nDet går inte att ångra. Medlemmar, positioner, chatt och polls tas bort.`);
  if (!confirmed) return;
  try {
    const groupId = appState.activeGroupId;
    const { error } = await requireSupabase().rpc('delete_group', { target_group_id: groupId });
    if (error) throw error;
    setActiveGroupId(null);
    appState.activeGroup = null;
    appState.members = [];
    showToast(`Gruppen "${groupName}" togs bort.`, 'success');
    await onChanged();
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte ta bort gruppen.'), 'error');
  }
}

function actionButton(iconName, label, handler, options = {}) {
  return el('button', {
    type: 'button',
    className: options.className || 'icon-button',
    title: label,
    disabled: options.disabled,
    onClick: handler,
  }, [icon(iconName, label)]);
}

async function removeMember(member, label, onChanged) {
  const isSelf = member.user_id === appState.user.id;
  if (!isSelf && (!isGroupOwner() || member.role === 'owner')) return;
  const confirmed = window.confirm(isSelf ? `Gå ur gruppen "${appState.activeGroup?.name || ''}"?` : `Ta bort ${label} från gruppen?`);
  if (!confirmed) return;
  try {
    const request = isSelf
      ? requireSupabase().rpc('leave_group', { target_group_id: appState.activeGroupId })
      : requireSupabase().from('group_members').delete().eq('id', member.id);
    const { error } = await request;
    if (error) throw error;
    if (isSelf) {
      setActiveGroupId(null);
      appState.activeGroup = null;
      appState.members = [];
    }
    showToast(isSelf ? 'Du gick ur gruppen.' : 'Medlemmen togs bort.', 'success');
    await onChanged();
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, isSelf ? 'Kunde inte gå ur gruppen.' : 'Kunde inte ta bort medlem.'), 'error');
  }
}

async function updateMember(memberId, patch, onChanged) {
  try {
    const { error } = await requireSupabase().from('group_members').update(patch).eq('id', memberId);
    if (error) throw error;
    showToast('Medlemskapet uppdaterades.', 'success');
    await onChanged();
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte uppdatera medlem.'), 'error');
  }
}

