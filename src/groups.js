import { requireSupabase } from './supabase.js';
import { appState, presenceForUser, setActiveGroupId } from './state.js';
import { el, formatRelative, friendlyError, icon, renderIcons, showToast, symbolNode } from './ui.js';

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
      await loadInvites();
      await loadPresence();
    } else {
      setActiveGroupId(null);
      appState.activeGroup = null;
      appState.members = [];
      appState.invites = [];
      appState.presence = [];
    }
  } else {
    appState.activeGroup = null;
    appState.members = [];
    appState.invites = [];
    appState.presence = [];
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

export async function loadInvites() {
  appState.invites = [];
  if (!appState.activeGroupId || !canAdminGroup()) return;
  const { data, error } = await requireSupabase()
    .from('group_invites')
    .select('*')
    .eq('group_id', appState.activeGroupId)
    .eq('status', 'invited')
    .order('created_at', { ascending: true });
  if (error) throw error;
  appState.invites = data || [];
}

export async function loadPresence() {
  appState.presence = [];
  if (!appState.activeGroupId || !isApprovedMember()) return;
  const { data, error } = await requireSupabase()
    .from('group_presence')
    .select('*')
    .eq('group_id', appState.activeGroupId);
  if (error) throw error;
  appState.presence = data || [];
}

export function subscribeGroups(onChanged) {
  unsubscribeGroups();
  if (!appState.user) return;
  groupChannel = requireSupabase()
    .channel('group-memberships')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'group_members' }, onChanged)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'group_invites' }, onChanged)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'group_presence' }, onChanged)
    .subscribe();
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
      isGroupOwner() ? adminRoleControl(onChanged) : null,
      importMembersControl(onChanged),
      emailGroupControl(),
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
  if (admin) {
    [...appState.invites].sort(compareInvites).forEach((invite) => {
      const label = invite.alias || invite.email;
      list.append(
        el('div', { className: 'member-row status-invited' }, [
          el('span', { className: 'member-symbol invite-symbol' }, [icon('mail', 'Inbjuden')]),
          el('div', { className: 'member-main' }, [
            el('strong', { text: label }),
            el('small', { text: 'invited · har ännu inget konto' }),
            el('small', { text: invite.email }),
          ]),
          actionButton('x', 'Återkalla inbjudan', () => revokeInvite(invite, onChanged), {
            className: 'danger-icon-button member-remove-button',
          }),
        ]),
      );
    });
  }
  return list;
}

function compareInvites(a, b) {
  const nameA = a.alias || a.email || '';
  const nameB = b.alias || b.email || '';
  return nameA.localeCompare(nameB, 'sv');
}

async function revokeInvite(invite, onChanged) {
  const confirmed = window.confirm(`Återkalla inbjudan till ${invite.email}?`);
  if (!confirmed) return;
  try {
    const { error } = await requireSupabase().rpc('revoke_group_invite', { target_invite_id: invite.id });
    if (error) throw error;
    showToast('Inbjudan återkallades.', 'success');
    await onChanged();
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte återkalla inbjudan.'), 'error');
  }
}

function memberInfoPanel(member) {
  const profile = member.profiles || {};
  const presence = memberPresence(member.user_id);
  const phone = profile.show_phone !== false && profile.phone ? profile.phone : 'ej angivet';
  return el('div', { className: 'member-info-popover', hidden: true, onClick: (event) => event.stopPropagation() }, [
    el('div', {}, [el('span', { text: 'E-post: ' }), el('span', { text: profile.email || 'ej angivet' })]),
    el('div', {}, [el('span', { text: 'Mobil: ' }), el('span', { text: phone })]),
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
  const nameA = a.profiles?.alias || a.profiles?.email || '';
  const nameB = b.profiles?.alias || b.profiles?.email || '';
  return nameA.localeCompare(nameB, 'sv');
}

function memberPresence(userId) {
  return presenceForUser(userId);
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
  const name = profile.alias || profile.email || profile.phone || `Användare ${member.user_id.slice(0, 8)}`;
  return `${name} (${member.role === 'admin' ? 'admin' : 'member'})`;
}

function emailGroupControl() {
  const panel = el('div', { className: 'group-email-panel', hidden: true });
  const openButton = el('button', {
    type: 'button',
    className: 'secondary',
    onClick: () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && !panel.childNodes.length) {
        renderGroupEmailPanel(panel);
        renderIcons();
      }
    },
  }, [icon('mail', 'Skicka e-post'), 'Skicka e-post till gruppen']);

  return el('div', { className: 'admin-cleanup group-email-control' }, [
    openButton,
    panel,
  ]);
}

function renderGroupEmailPanel(panel) {
  const mode = el('select', {}, [
    el('option', { value: 'all', text: 'Alla' }),
    el('option', { value: 'approved', text: 'approved' }),
    el('option', { value: 'pending', text: 'pending' }),
    el('option', { value: 'invited', text: 'invited' }),
    el('option', { value: 'selected', text: 'Valda personer' }),
  ]);
  const subject = el('input', { placeholder: 'Ämne' });
  const body = el('textarea', { rows: '5', placeholder: 'Gemensam huvudtext' });
  const approvedText = el('textarea', { rows: '3' });
  const pendingText = el('textarea', { rows: '3' });
  const invitedText = el('textarea', { rows: '3' });
  approvedText.value = 'Du är redan medlem i gruppen. Logga in i Fältchatt via länken nedan.';
  pendingText.value = 'Du har ansökt om medlemskap i gruppen och väntar på godkännande.';
  invitedText.value = 'Du är inbjuden men saknar konto. Skapa konto med den här e-postadressen och bekräfta e-postmeddelandet för att gå med i gruppen.';

  const selectedBox = el('div', { className: 'email-selected-list', hidden: true });
  const preview = el('div', { className: 'email-preview' });
  const sendButton = el('button', { type: 'button', className: 'primary', hidden: true }, [icon('send', 'Skicka'), 'Skicka e-post']);
  let lastPreview = null;

  function resetPreview() {
    lastPreview = null;
    sendButton.hidden = true;
    preview.replaceChildren();
  }

  function renderSelectedList() {
    selectedBox.hidden = mode.value !== 'selected';
    if (selectedBox.hidden) return;
    selectedBox.replaceChildren(...groupEmailRecipients().map((recipient) => {
      const checkbox = el('input', { type: 'checkbox', value: recipient.key });
      checkbox.addEventListener('change', resetPreview);
      return el('label', { className: 'email-recipient-choice' }, [
        checkbox,
        el('span', { text: `${recipient.name} · ${recipient.status}` }),
        el('small', { text: recipient.email }),
      ]);
    }));
  }

  function collectPayload() {
    const selectedRecipients = [...selectedBox.querySelectorAll('input:checked')].map((input) => input.value);
    return {
      groupId: appState.activeGroupId,
      recipientMode: mode.value,
      selectedRecipients,
      subject: subject.value.trim(),
      body: body.value.trim(),
      statusTexts: {
        approved: approvedText.value.trim(),
        pending: pendingText.value.trim(),
        invited: invitedText.value.trim(),
      },
    };
  }

  function showPreview() {
    const payload = collectPayload();
    const recipients = filterGroupEmailRecipients(payload.recipientMode, payload.selectedRecipients);
    if (!payload.subject || !payload.body) {
      showToast('Ange ämne och huvudtext först.', 'warning');
      return;
    }
    if (!recipients.length) {
      showToast('Välj minst en mottagare.', 'warning');
      return;
    }
    lastPreview = payload;
    sendButton.hidden = false;
    preview.replaceChildren(
      el('div', { className: 'email-preview-box' }, [
        el('strong', { text: `Förhandsgranskning (${recipients.length} mottagare)` }),
        el('div', { className: 'email-preview-recipients' }, recipients.slice(0, 8).map((recipient) => el('span', { text: `${recipient.email} · ${recipient.status}` }))),
        recipients.length > 8 ? el('p', { className: 'muted', text: `Visar 8 av ${recipients.length} mottagare.` }) : null,
        el('p', { className: 'email-preview-subject', text: payload.subject }),
        el('pre', { text: buildEmailPreviewText(payload, recipients[0]) }),
      ]),
    );
  }

  async function sendEmail() {
    if (!lastPreview) return;
    try {
      const { data, error } = await requireSupabase().functions.invoke('send-group-email', { body: lastPreview });
      if (error) throw error;
      showToast(`E-post skickades till ${data?.sent ?? 0} mottagare.`, 'success');
      resetPreview();
    } catch (error) {
      console.error(error);
      showToast(groupEmailError(error), 'error');
    }
  }

  mode.addEventListener('change', () => {
    renderSelectedList();
    resetPreview();
  });
  [subject, body, approvedText, pendingText, invitedText].forEach((input) => input.addEventListener('input', resetPreview));
  sendButton.addEventListener('click', sendEmail);

  panel.replaceChildren(
    el('div', { className: 'stack' }, [
      el('label', {}, ['Mottagare', mode]),
      selectedBox,
      el('label', {}, ['Ämne', subject]),
      el('label', {}, ['Huvudtext', body]),
      el('details', { className: 'email-status-texts' }, [
        el('summary', { text: 'Standardtexter per status' }),
        el('label', {}, ['approved', approvedText]),
        el('label', {}, ['pending', pendingText]),
        el('label', {}, ['invited', invitedText]),
      ]),
      el('div', { className: 'button-row' }, [
        el('button', { type: 'button', className: 'ghost', onClick: () => { panel.hidden = true; } }, [icon('x', 'Stäng'), 'Stäng']),
        el('button', { type: 'button', className: 'secondary', onClick: showPreview }, [icon('eye', 'Förhandsgranska'), 'Förhandsgranska']),
        sendButton,
      ]),
      preview,
    ]),
  );
  renderSelectedList();
}

function groupEmailRecipients() {
  const members = appState.members
    .filter((member) => ['approved', 'pending'].includes(member.status) && member.profiles?.email)
    .map((member) => ({
      key: `member:${member.id}`,
      id: member.id,
      email: member.profiles.email,
      name: member.profiles.alias || member.profiles.email,
      status: member.status,
    }));
  const invites = appState.invites.map((invite) => ({
    key: `invite:${invite.id}`,
    id: invite.id,
    email: invite.email,
    name: invite.alias || invite.email,
    status: 'invited',
  }));
  return [...members, ...invites].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
}

function filterGroupEmailRecipients(mode, selectedRecipients = []) {
  const recipients = groupEmailRecipients();
  if (mode === 'all') return recipients;
  if (mode === 'selected') return recipients.filter((recipient) => selectedRecipients.includes(recipient.key));
  return recipients.filter((recipient) => recipient.status === mode);
}

function buildEmailPreviewText(payload, recipient) {
  const statusText = payload.statusTexts?.[recipient?.status] || '';
  return [payload.body, statusText, appUrlForEmail()].filter(Boolean).join('\n\n');
}

function appUrlForEmail() {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

function groupEmailError(error) {
  const message = error?.message || '';
  const name = error?.name || '';
  if (name === 'FunctionsFetchError' || message.includes('Failed to send a request to the Edge Function')) {
    return 'Kunde inte nå e-postfunktionen. Kontrollera att Supabase Edge Function "send-group-email" är deployad och att den har rätt secrets.';
  }
  if (name === 'FunctionsHttpError') {
    return 'E-postfunktionen svarade med fel. Kontrollera Edge Function-loggen i Supabase.';
  }
  return friendlyError(error, 'Kunde inte skicka e-post.');
}

function importMembersControl(onChanged) {
  const fileInput = el('input', { type: 'file', accept: '.csv,text/csv', className: 'visually-hidden-file' });
  const preview = el('div', { className: 'import-preview' });
  let importRows = [];

  async function readFile() {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = previewCsvImport(text);
      importRows = result.importRows;
      renderImportPreview(preview, result, () => importCsvRows(importRows, onChanged));
      renderIcons();
    } catch (error) {
      console.error(error);
      showToast('Kunde inte läsa CSV-filen.', 'error');
    }
  }

  fileInput.addEventListener('change', readFile);

  return el('div', { className: 'admin-cleanup import-members-control' }, [
    el('p', { className: 'muted', text: 'Importera medlemmar till aktuell grupp från CSV med kolumnerna email, phone och alias.' }),
    fileInput,
    el('button', {
      type: 'button',
      className: 'secondary',
      onClick: () => fileInput.click(),
    }, [icon('file-up', 'Välj CSV'), 'Välj CSV']),
    preview,
  ]);
}

function renderImportPreview(container, result, onImport) {
  const canImport = result.importRows.length > 0;
  container.replaceChildren(
    el('div', { className: 'import-preview-box' }, [
      el('strong', { text: `${result.total} personer hittades` }),
      el('div', { className: 'import-stats' }, [
        el('span', { text: `${result.importRows.length} giltiga för import` }),
        el('span', { text: `${result.alreadyMember} finns redan i gruppen` }),
        el('span', { text: `${result.duplicates} dubbletter i filen` }),
        el('span', { text: `${result.invalid} saknar giltig e-post` }),
        result.alreadyInvited ? el('span', { text: `${result.alreadyInvited} redan inbjudna` }) : null,
        result.pendingToApprove ? el('span', { text: `${result.pendingToApprove} pending blir approved` }) : null,
      ]),
      result.rows.length
        ? el('div', { className: 'import-table' }, result.rows.slice(0, 40).map(importPreviewRow))
        : null,
      result.rows.length > 40 ? el('p', { className: 'muted', text: `Visar 40 av ${result.rows.length} rader.` }) : null,
      el('div', { className: 'button-row' }, [
        el('button', { type: 'button', className: 'ghost', onClick: () => container.replaceChildren() }, [icon('x', 'Avbryt'), 'Avbryt']),
        el('button', { type: 'button', className: 'primary', disabled: !canImport, onClick: onImport }, [icon('user-plus', 'Importera'), `Importera ${result.importRows.length} personer`]),
      ]),
    ]),
  );
}

function importPreviewRow(row) {
  return el('div', { className: `import-row import-${row.status}` }, [
    el('span', { text: row.email || row.rawEmail || '-' }),
    el('span', { text: row.alias || '' }),
    el('span', { text: importStatusText(row.status) }),
  ]);
}

function importStatusText(status) {
  const labels = {
    ready: 'importeras',
    pending: 'pending → approved',
    duplicate: 'dubblett',
    invalid: 'ogiltig e-post',
    existing: 'finns redan',
    invited: 'redan inbjuden',
  };
  return labels[status] || status;
}

async function importCsvRows(rows, onChanged) {
  if (!rows.length || !appState.activeGroupId) return;
  try {
    const { data, error } = await requireSupabase().rpc('import_group_invites', {
      target_group_id: appState.activeGroupId,
      import_rows: rows,
    });
    if (error) throw error;
    showToast(`Import klar. ${data?.approved ?? 0} godkända och ${data?.invited ?? 0} inbjudna.`, 'success');
    await onChanged();
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte importera medlemslistan.'), 'error');
  }
}

function previewCsvImport(text) {
  const records = parseCsv(text);
  const existingMembers = new Map(appState.members.map((member) => [member.profiles?.email?.toLowerCase(), member]).filter(([email]) => email));
  const existingInvites = new Set(appState.invites.map((invite) => invite.email));
  const seen = new Set();
  const result = {
    total: records.length,
    importRows: [],
    rows: [],
    alreadyMember: 0,
    alreadyInvited: 0,
    duplicates: 0,
    invalid: 0,
    pendingToApprove: 0,
  };

  records.forEach((record) => {
    const rawEmail = record.email || '';
    const email = normalizeEmail(rawEmail);
    const row = {
      email,
      rawEmail,
      phone: (record.phone || '').trim(),
      alias: (record.alias || '').trim(),
      status: 'ready',
    };

    if (!isValidEmail(email)) {
      row.status = 'invalid';
      result.invalid += 1;
    } else if (seen.has(email)) {
      row.status = 'duplicate';
      result.duplicates += 1;
    } else if (existingMembers.get(email)?.status === 'approved') {
      row.status = 'existing';
      result.alreadyMember += 1;
    } else if (existingInvites.has(email)) {
      row.status = 'invited';
      result.alreadyInvited += 1;
    } else {
      const existingMember = existingMembers.get(email);
      if (existingMember?.status === 'pending') {
        row.status = 'pending';
        result.pendingToApprove += 1;
      }
      result.importRows.push({ email, phone: row.phone || null, alias: row.alias || null });
    }

    if (email) seen.add(email);
    result.rows.push(row);
  });

  return result;
}

function parseCsv(text) {
  const rows = parseCsvRows(text).filter((row) => row.some((cell) => cell.trim()));
  if (!rows.length) return [];
  const headers = rows[0].map((cell) => cell.trim().toLowerCase());
  const emailIndex = headers.indexOf('email');
  if (emailIndex === -1) throw new Error('CSV-filen måste ha kolumnen email.');
  const phoneIndex = headers.indexOf('phone');
  const aliasIndex = headers.indexOf('alias');
  return rows.slice(1).map((row) => ({
    email: row[emailIndex] || '',
    phone: phoneIndex >= 0 ? row[phoneIndex] || '' : '',
    alias: aliasIndex >= 0 ? row[aliasIndex] || '' : '',
  }));
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const delimiter = detectCsvDelimiter(text);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function detectCsvDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  return firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
}

function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
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
