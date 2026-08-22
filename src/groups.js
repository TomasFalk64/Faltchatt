import { requireSupabase } from './supabase.js';
import { appState, setActiveGroupId } from './state.js';
import { el, friendlyError, icon, renderIcons, showToast, symbolNode } from './ui.js';

let groupChannel = null;
let groupRefreshTimer = null;

export function isApprovedMember() {
  return appState.memberships.some((member) => member.group_id === appState.activeGroupId && member.status === 'approved');
}

export function currentRole() {
  return appState.memberships.find((member) => member.group_id === appState.activeGroupId)?.role || null;
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
  appState.memberships = memberships || [];

  if (appState.activeGroupId) {
    const membership = appState.memberships.find((item) => item.group_id === appState.activeGroupId);
    if (membership) {
      appState.activeGroup = membership.groups || null;
      await loadMembers();
    } else {
      setActiveGroupId(null);
      appState.activeGroup = null;
      appState.members = [];
    }
  } else {
    appState.activeGroup = null;
    appState.members = [];
  }
}

export async function loadMembers() {
  if (!appState.activeGroupId) return;
  const { data, error } = await requireSupabase()
    .from('group_members')
    .select('*, profiles(id, alias, symbol, symbol_color, show_alias, show_phone, email, phone)')
    .eq('group_id', appState.activeGroupId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  appState.members = data || [];
}

export function subscribeGroups(onChanged) {
  unsubscribeGroups();
  if (!appState.user) return;
  groupChannel = requireSupabase()
    .channel('group-memberships')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'group_members' }, onChanged)
    .subscribe();
  groupRefreshTimer = window.setInterval(onChanged, 3000);
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

  const groupSelect = el(
    'select',
    {
      onChange: async (event) => {
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

  view.append(
    el('div', { className: 'page sidebar-page' }, [
      el('section', { className: 'panel stack' }, [
        el('label', { className: 'group-section-label' }, ['Aktuell grupp', groupSelect]),
        memberList(onChanged),
        activeGroupSummary(),
        createGroupForm(onChanged),
        joinGroupForm(onChanged),
      ]),
      isGroupOwner()
        ? el('section', { className: 'panel stack' }, [
            el('h2', { text: 'Administration' }),
            clearLocationPinsControl(onChanged),
            clearChatControl(onChanged),
            deleteGroupControl(onChanged),
          ])
        : null,
    ]),
  );
  renderIcons();
}

function activeGroupSummary() {
  if (!appState.activeGroup) return el('p', { className: 'muted', text: 'Skapa eller gå med i en grupp för att använda karta och chatt.' });
  const membership = appState.memberships.find((item) => item.group_id === appState.activeGroupId);
  return el('div', { className: 'group-summary' }, [
    el('div', { className: 'group-code-line' }, [
      el('span', { text: 'Gruppkod:' }),
      el('code', {
        text: appState.activeGroup.join_code,
        title: 'Ge gruppkoden till personer som ska begära medlemskap i gruppen.',
      }),
    ]),
    membership?.status !== 'approved' ? el('p', { className: 'warning-text', text: 'Du väntar på godkännande innan karta och chatt öppnas.' }) : null,
  ]);
}

function groupOptionText(membership) {
  const name = membership.groups?.name || `Grupp ${membership.group_id.slice(0, 8)}`;
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
      window.alert(
        joinCode
          ? `Gruppen "${groupName}" är skapad och går att ansluta till med gruppkod:\n\n${joinCode}`
          : `Gruppen "${groupName}" är skapad och går att ansluta till.`,
      );
      showToast('Gruppen skapades.', 'success');
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte skapa grupp.'), 'error');
    }
  };
  return el('form', { className: 'stack subsection', onSubmit: submit }, [
    el('h3', { text: 'Skapa grupp' }),
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
    const label = profile.alias || profile.email || profile.phone || `Användare ${member.user_id.slice(0, 8)}`;
    const isSelf = member.user_id === appState.user.id;
    const canRemove = isSelf || (owner && member.role !== 'owner');
    const removeLabel = isSelf ? 'Gå ur gruppen' : 'Ta bort medlem';
    const activeText = memberHasLocation(member.user_id) ? 'inloggad' : '';
    const phonePanel = memberPhonePanel(profile);
    list.append(
      el('div', { className: `member-row status-${member.status}` }, [
        Object.assign(symbolNode(profile.symbol || 'hat', 'member-symbol'), { style: `color: ${profile.symbol_color || '#17324d'}` }),
        el('div', { className: 'member-main' }, [
          el('strong', { text: label }),
          el('small', { text: memberRowMeta(member, activeText) }),
          el('button', {
            type: 'button',
            className: 'member-phone-link',
            onClick: () => phonePanel.hidden = !phonePanel.hidden,
          }, ['mobil']),
        ]),
        phonePanel,
        admin && member.status === 'pending'
          ? el('div', { className: 'row-actions' }, [
              actionButton('check', 'Godkänn', () => updateMember(member.id, { status: 'approved', approved_at: new Date().toISOString() }, onChanged)),
              actionButton('x', 'Avvisa', () => updateMember(member.id, { status: 'rejected' }, onChanged)),
            ])
          : null,
        member.status !== 'pending'
          ? actionButton('x', canRemove ? removeLabel : 'Bara owner kan ta bort andra medlemmar', () => removeMember(member, label, onChanged), {
              className: 'danger-icon-button member-remove-button',
              disabled: !canRemove,
            })
          : null,
      ]),
    );
  });
  return list;
}

function memberPhonePanel(profile) {
  const canShowPhone = profile.show_phone !== false && Boolean(profile.phone);
  const value = canShowPhone ? profile.phone : 'ej angivet';
  return el('div', { className: 'member-phone-popover', hidden: true }, [
    canShowPhone
      ? el('button', {
          type: 'button',
          className: 'member-phone-number',
          title: 'Kopiera mobilnummer',
          onClick: () => copyPhoneNumber(profile.phone),
        }, [value])
      : el('span', { text: value }),
  ]);
}

async function copyPhoneNumber(phone) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(phone);
    } else {
      const input = el('input', { value: phone });
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.append(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    showToast('Mobilnumret kopierades.', 'success');
  } catch (error) {
    console.error(error);
    showToast('Kunde inte kopiera mobilnumret.', 'error');
  }
}

function compareMembers(a, b) {
  const roleRank = { owner: 0, admin: 1, member: 2 };
  const statusRank = { approved: 0, pending: 1, rejected: 2 };
  const roleDiff = (roleRank[a.role] ?? 3) - (roleRank[b.role] ?? 3);
  if (roleDiff) return roleDiff;
  const activeDiff = Number(memberHasLocation(b.user_id)) - Number(memberHasLocation(a.user_id));
  if (activeDiff) return activeDiff;
  const statusDiff = (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3);
  if (statusDiff) return statusDiff;
  const nameA = a.profiles?.alias || a.profiles?.email || '';
  const nameB = b.profiles?.alias || b.profiles?.email || '';
  return nameA.localeCompare(nameB, 'sv');
}

function memberHasLocation(userId) {
  return appState.locations.some((location) => location.user_id === userId);
}

function memberRowMeta(member, activeText) {
  const role = member.role === 'owner' ? 'owner' : 'member';
  const status = member.status === 'approved' ? activeText : member.status;
  return [role, status].filter(Boolean).join(' · ');
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
