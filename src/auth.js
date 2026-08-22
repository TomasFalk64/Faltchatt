import { requireSupabase, supabase } from './supabase.js';
import { appState, setLocationSharingEnabled, SYMBOLS, SYMBOL_COLORS } from './state.js';
import { refreshMapLayers, startSharing, stopSharing } from './map.js';
import { el, friendlyError, icon, renderIcons, setSessionPill, showToast, symbolNode } from './ui.js';

let onAuthChanged = async () => {};

export function setAuthChangeHandler(handler) {
  onAuthChanged = handler;
}

export async function initAuth() {
  if (!supabase) return;
  if (isRecoveryUrl()) appState.passwordRecovery = true;
  const { data, error } = await supabase.auth.getSession();
  if (error) console.error(error);
  await applySession(data?.session || null);
  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY' || isRecoveryUrl()) appState.passwordRecovery = true;
    await applySession(session);
    await onAuthChanged();
  });
}

function isRecoveryUrl() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return query.get('type') === 'recovery' || hash.get('type') === 'recovery';
}

async function applySession(session) {
  appState.session = session;
  appState.user = session?.user || null;
  if (appState.user) {
    await ensureProfile();
  } else {
    appState.profile = null;
  }
  setSessionPill();
}

export async function ensureProfile() {
  const client = requireSupabase();
  const user = appState.user;
  if (!user) return null;
  const { data, error } = await client.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) throw error;
  if (data) {
    appState.profile = data;
    return data;
  }

  const alias = user.email?.split('@')[0] || 'Faltanvandare';
  const { data: created, error: createError } = await client
    .from('profiles')
    .insert({ id: user.id, alias, symbol: SYMBOLS[0].id, symbol_color: SYMBOL_COLORS[0], show_alias: true, email: user.email })
    .select('*')
    .single();
  if (createError) throw createError;
  appState.profile = created;
  return created;
}

export function renderAuth() {
  const authView = document.querySelector('#auth-view');
  const loggedIn = Boolean(appState.user);
  authView.hidden = loggedIn;
  if (loggedIn) {
    authView.innerHTML = '';
    return;
  }

  authView.innerHTML = '';
  authView.append(
    el('div', { className: 'auth-panel' }, [
      el('h1', { text: 'Fältchatt' }),
      el('p', { text: 'Logga in eller skapa konto för att dela position, karta och chatt med din grupp.' }),
      authForm(),
    ]),
  );
  renderIcons();
}

function authForm() {
  const email = el('input', { type: 'email', placeholder: 'E-post', autocomplete: 'email', required: true });
  const password = el('input', { type: 'password', placeholder: 'Lösenord', autocomplete: 'current-password', required: true, minlength: '6' });
  const mode = el('select', {}, [
    el('option', { value: 'signin', text: 'Logga in' }),
    el('option', { value: 'signup', text: 'Skapa konto' }),
  ]);
  const submit = async (event) => {
    event.preventDefault();
    try {
      const client = requireSupabase();
      const credentials = { email: email.value.trim(), password: password.value };
      const result =
        mode.value === 'signup'
          ? await client.auth.signUp(credentials)
          : await client.auth.signInWithPassword(credentials);
      if (result.error) throw result.error;
      if (mode.value === 'signup' && result.data?.user && Array.isArray(result.data.user.identities) && result.data.user.identities.length === 0) {
        showToast('Det finns redan ett konto med den e-postadressen. Logga in eller återställ lösenordet.', 'warning');
        return;
      }
      showToast(mode.value === 'signup' ? 'Det har skickats mail till e-postadressen du angav. Bekräfta i mailet för att kunna logga in.' : 'Du är inloggad.', 'success');
    } catch (error) {
      console.error(error);
      showToast(mode.value === 'signup' ? 'Kunde inte skapa konto. Kontrollera e-postadressen.' : 'Inloggningen misslyckades. Kontrollera uppgifterna.', 'error');
    }
  };
  const resetPassword = async () => {
    if (!email.value.trim()) {
      showToast('Ange e-post först.', 'warning');
      return;
    }
    try {
      const { error } = await requireSupabase().auth.resetPasswordForEmail(email.value.trim(), {
        redirectTo: window.location.origin,
      });
      if (error) throw error;
      showToast('Länk för lösenordsåterställning skickad.', 'success');
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte skicka återställningslänk.'), 'error');
    }
  };
  return el('form', { className: 'stack', onSubmit: submit }, [
    mode,
    email,
    password,
    el('button', { className: 'primary', type: 'submit' }, [icon('log-in', 'Logga in'), 'Fortsätt']),
    el('button', { type: 'button', className: 'ghost', onClick: resetPassword }, [icon('key-round', 'Återställ'), 'Återställ lösenord']),
  ]);
}

export function renderProfile() {
  const view = document.querySelector('#profile-view');
  view.innerHTML = '';
  if (!appState.user) return;

  const alias = el('input', { value: appState.profile?.alias || '', placeholder: 'Alias' });
  const phone = el('input', { value: appState.profile?.phone || '', placeholder: 'Mobilnummer', type: 'tel' });
  let selectedSymbol = SYMBOLS.some((item) => item.id === appState.profile?.symbol) ? appState.profile.symbol : SYMBOLS[0].id;
  let selectedColor = appState.profile?.symbol_color || SYMBOL_COLORS[0];
  const showAlias = el('input', { type: 'checkbox' });
  const shareToggle = el('input', { type: 'checkbox', id: 'profile-share-location' });
  showAlias.checked = appState.profile?.show_alias !== false;
  shareToggle.checked = appState.locationSharingEnabled;
  shareToggle.addEventListener('change', () => {
    setLocationSharingEnabled(shareToggle.checked);
    if (shareToggle.checked) startSharing();
    else stopSharing();
  });

  const save = async (event) => {
    event.preventDefault();
    try {
      const { data, error } = await requireSupabase()
        .from('profiles')
        .upsert({
          id: appState.user.id,
          alias: alias.value.trim() || 'Faltanvandare',
          phone: phone.value.trim() || null,
          symbol: selectedSymbol,
          symbol_color: selectedColor,
          show_alias: showAlias.checked,
          email: appState.user.email,
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();
      if (error) throw error;
      appState.profile = data;
      setSessionPill();
      await refreshMapLayers();
      showToast('Profilen sparades.', 'success');
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte spara profilen.'), 'error');
    }
  };

  const getSelectedSymbol = () => SYMBOLS.find((item) => item.id === selectedSymbol) || SYMBOLS[0];
  const previewGlyph = symbolNode(getSelectedSymbol().id, 'profile-symbol-preview');
  previewGlyph.style.color = selectedColor;
  const updatePreview = () => {
    previewGlyph.replaceChildren(...symbolNode(getSelectedSymbol().id, 'profile-symbol-preview').childNodes);
    previewGlyph.style.color = selectedColor;
  };
  const symbolButtons = SYMBOLS.map((symbolOption) =>
    el('button', {
      type: 'button',
      className: `symbol-choice ${symbolOption.id === selectedSymbol ? 'active' : ''}`,
      title: symbolOption.label,
      onClick: () => {
        selectedSymbol = symbolOption.id;
        symbolButtons.forEach((button) => button.classList.toggle('active', button.title === symbolOption.label));
        updatePreview();
      },
    }, [symbolNode(symbolOption.id, 'symbol-choice-icon')]),
  );
  const colorButtons = SYMBOL_COLORS.map((color) =>
    el('button', {
      type: 'button',
      className: `color-swatch ${color.toLowerCase() === selectedColor.toLowerCase() ? 'active' : ''}`,
      style: `background: ${color}`,
      title: color,
      onClick: () => {
        selectedColor = color;
        colorButtons.forEach((button) => button.classList.toggle('active', button.title.toLowerCase() === selectedColor.toLowerCase()));
        updatePreview();
      },
    }),
  );

  view.append(
    el('div', { className: 'page narrow' }, [
      el('h2', { text: 'Profil' }),
      appState.passwordRecovery ? passwordRecoveryForm() : null,
      el('form', { className: 'panel stack', onSubmit: save }, [
        el('label', {}, ['Alias', alias]),
        el('fieldset', { className: 'symbol-picker' }, [el('legend', { text: 'Symbol' }), ...symbolButtons]),
        el('fieldset', { className: 'color-picker' }, [el('legend', { text: 'Symbolfärg' }), ...colorButtons]),
        el('div', { className: 'symbol-preview' }, [previewGlyph, 'Visas på kartan']),
        el('label', {}, ['E-post', el('input', { value: appState.user.email || '', disabled: true })]),
        el('label', {}, ['Mobilnummer', phone]),
        el('label', { className: 'toggle-row' }, [showAlias, el('span', { text: 'Visa alias i chatt och kart-popup' })]),
        el('label', { className: 'toggle-row' }, [shareToggle, el('span', { text: 'Visa och dela min position' })]),
        el('button', { className: 'primary', type: 'submit' }, [icon('save', 'Spara'), 'Spara profil']),
        el('button', { className: 'ghost', type: 'button', onClick: () => requireSupabase().auth.signOut() }, [icon('log-out', 'Logga ut'), 'Logga ut']),
      ]),
    ]),
  );
  renderIcons();
}

function passwordRecoveryForm() {
  const password = el('input', { type: 'password', placeholder: 'Nytt lösenord', autocomplete: 'new-password', required: true });
  const repeat = el('input', { type: 'password', placeholder: 'Upprepa nytt lösenord', autocomplete: 'new-password', required: true });
  const submit = async (event) => {
    event.preventDefault();
    if (password.value.length < 6) {
      showToast('Lösenordet måste vara minst 6 tecken.', 'warning');
      return;
    }
    if (password.value !== repeat.value) {
      showToast('Lösenorden är inte lika.', 'warning');
      return;
    }
    try {
      const { error } = await requireSupabase().auth.updateUser({ password: password.value });
      if (error) throw error;
      appState.passwordRecovery = false;
      password.value = '';
      repeat.value = '';
      showToast('Lösenordet har ändrats.', 'success');
      renderProfile();
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte ändra lösenordet.'), 'error');
    }
  };
  return el('form', { className: 'panel stack', onSubmit: submit }, [
    el('h3', { text: 'Välj nytt lösenord' }),
    el('p', { className: 'muted', text: 'Du är inloggad via återställningslänken. Ange ett nytt lösenord för kontot.' }),
    password,
    repeat,
    el('button', { className: 'primary', type: 'submit' }, [icon('key-round', 'Spara'), 'Spara nytt lösenord']),
  ]);
}
