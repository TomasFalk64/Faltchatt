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
    .select('*, profiles(id, alias, symbol, symbol_color, show_alias, email, phone)')
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
        el('h2', { text: 'Grupp' }),
        el('label', { className: 'group-section-label' }, ['Aktuell grupp', groupSelect]),
        memberList(onChanged),
        activeGroupSummary(),
        createGroupForm(onChanged),
        joinGroupForm(onChanged),
      ]),
      el('section', { className: 'panel stack' }, [el('h2', { text: 'Administration' }), clearChatControl(onChanged)]),
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
    if (!input.value.trim()) return;
    try {
      const { error } = await requireSupabase().rpc('create_group_with_owner', { group_name: input.value.trim() });
      if (error) throw error;
      input.value = '';
      showToast('Gruppen skapades.', 'success');
      await onChanged();
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
  const input = el('input', { placeholder: 'gul-prickig-kantarell', autocapitalize: 'none' });
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
    el('h3', { text: 'Gå med' }),
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
    const canRemove = owner && member.role !== 'owner';
    list.append(
      el('div', { className: `member-row status-${member.status}` }, [
        Object.assign(symbolNode(profile.symbol || 'hat', 'member-symbol'), { style: `color: ${profile.symbol_color || '#17324d'}` }),
        el('div', { className: 'member-main' }, [
          el('strong', { text: label }),
          el('small', { text: member.status === 'approved' ? member.role : `${member.role} · ${member.status}` }),
        ]),
        admin && member.status === 'pending'
          ? el('div', { className: 'row-actions' }, [
              actionButton('check', 'Godkänn', () => updateMember(member.id, { status: 'approved', approved_at: new Date().toISOString() }, onChanged)),
              actionButton('x', 'Avvisa', () => updateMember(member.id, { status: 'rejected' }, onChanged)),
            ])
          : null,
        member.status !== 'pending'
          ? actionButton('x', canRemove ? 'Ta bort medlem' : 'Bara owner kan ta bort medlemmar', () => removeMember(member, label, onChanged), {
              className: 'danger-icon-button member-remove-button',
              disabled: !canRemove,
            })
          : null,
      ]),
    );
  });
  return list;
}

function compareMembers(a, b) {
  const roleRank = { owner: 0, admin: 1, member: 2 };
  const statusRank = { approved: 0, pending: 1, rejected: 2 };
  const roleDiff = (roleRank[a.role] ?? 3) - (roleRank[b.role] ?? 3);
  if (roleDiff) return roleDiff;
  const statusDiff = (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3);
  if (statusDiff) return statusDiff;
  const nameA = a.profiles?.alias || a.profiles?.email || '';
  const nameB = b.profiles?.alias || b.profiles?.email || '';
  return nameA.localeCompare(nameB, 'sv');
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

function actionButton(iconName, label, handler, options = {}) {
  return el('button', {
    className: options.className || 'icon-button',
    title: label,
    disabled: options.disabled,
    onClick: handler,
  }, [icon(iconName, label)]);
}

async function removeMember(member, label, onChanged) {
  if (!isGroupOwner() || member.role === 'owner') return;
  const confirmed = window.confirm(`Ta bort ${label} från gruppen?`);
  if (!confirmed) return;
  try {
    const { error } = await requireSupabase().from('group_members').delete().eq('id', member.id);
    if (error) throw error;
    showToast('Medlemmen togs bort.', 'success');
    await onChanged();
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte ta bort medlem.'), 'error');
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
