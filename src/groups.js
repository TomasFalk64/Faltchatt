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
        el('label', {}, ['Aktuell grupp', groupSelect]),
        activeGroupSummary(),
        createGroupForm(onChanged),
        joinGroupForm(onChanged),
      ]),
      el('section', { className: 'panel stack' }, [el('h2', { text: 'Medlemmar' }), memberList(onChanged)]),
    ]),
  );
  renderIcons();
}

function activeGroupSummary() {
  if (!appState.activeGroup) return el('p', { className: 'muted', text: 'Skapa eller gå med i en grupp för att använda karta och chatt.' });
  const membership = appState.memberships.find((item) => item.group_id === appState.activeGroupId);
  return el('div', { className: 'group-summary' }, [
    el('strong', { text: appState.activeGroup.name }),
    el('span', { text: membership?.status === 'approved' ? `Roll: ${membership?.role || '-'}` : `Roll: ${membership?.role || '-'} · ${membership?.status || '-'}` }),
    el('div', { className: 'group-code-block' }, [
      el('span', { text: 'Gruppkod' }),
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
    input,
    el('button', { className: 'primary', type: 'submit' }, [icon('plus', 'Skapa'), 'Skapa grupp']),
  ]);
}

function joinGroupForm(onChanged) {
  const input = el('input', { placeholder: 'Gruppkod', autocapitalize: 'characters' });
  const submit = async (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    try {
      const { error } = await requireSupabase().rpc('request_group_membership', { requested_join_code: input.value.trim().toUpperCase() });
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
    input,
    el('button', { className: 'secondary', type: 'submit' }, [icon('user-plus', 'Gå med'), 'Begär medlemskap']),
  ]);
}

function memberList(onChanged) {
  if (!appState.activeGroup) return el('p', { className: 'muted', text: 'Ingen grupp vald.' });
  if (!isApprovedMember()) return el('p', { className: 'muted', text: 'Medlemslistan visas efter godkännande.' });
  const admin = canAdminGroup();
  const list = el('div', { className: 'member-list' });
  appState.members.forEach((member) => {
    const profile = member.profiles || {};
    const label = profile.alias || profile.email || profile.phone || `Användare ${member.user_id.slice(0, 8)}`;
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
      ]),
    );
  });
  return list;
}

function actionButton(iconName, label, handler) {
  return el('button', { className: 'icon-button', title: label, onClick: handler }, [icon(iconName, label)]);
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
