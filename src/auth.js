import { requireSupabase, supabase } from './supabase.js';
import { appState, SYMBOLS, SYMBOL_COLORS } from './state.js';
import { startSharing, stopSharing } from './map.js';
import { el, friendlyError, icon, renderIcons, setSessionPill, showToast } from './ui.js';

let onAuthChanged = async () => {};

export function setAuthChangeHandler(handler) {
  onAuthChanged = handler;
}

export async function initAuth() {
  if (!supabase) return;
  const { data, error } = await supabase.auth.getSession();
  if (error) console.error(error);
  await applySession(data?.session || null);
  supabase.auth.onAuthStateChange(async (_event, session) => {
    await applySession(session);
    await onAuthChanged();
  });
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
    .insert({ id: user.id, alias, symbol: 'circle', symbol_color: SYMBOL_COLORS[0], show_alias: true, email: user.email })
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
      showToast(mode.value === 'signup' ? 'Kontot är skapat. Kontrollera e-post om bekräftelse krävs.' : 'Du är inloggad.', 'success');
    } catch (error) {
      console.error(error);
      showToast('Inloggningen misslyckades. Kontrollera uppgifterna.', 'error');
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
      showToast('Kunde inte skicka återställningslänk.', 'error');
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
  const symbol = el('select', {}, SYMBOLS.map((item) => el('option', { value: item.id, text: `${item.glyph} ${item.label}` })));
  let selectedColor = appState.profile?.symbol_color || SYMBOL_COLORS[0];
  const showAlias = el('input', { type: 'checkbox' });
  const shareToggle = el('input', { type: 'checkbox', id: 'profile-share-location' });
  symbol.value = appState.profile?.symbol || 'circle';
  showAlias.checked = appState.profile?.show_alias !== false;
  shareToggle.addEventListener('change', () => (shareToggle.checked ? startSharing() : stopSharing()));

  const save = async (event) => {
    event.preventDefault();
    try {
      const { data, error } = await requireSupabase()
        .from('profiles')
        .upsert({
          id: appState.user.id,
          alias: alias.value.trim() || 'Faltanvandare',
          phone: phone.value.trim() || null,
          symbol: symbol.value,
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
      showToast('Profilen sparades.', 'success');
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte spara profilen.'), 'error');
    }
  };

  const previewGlyph = el('span', { text: SYMBOLS.find((item) => item.id === symbol.value)?.glyph || '●', style: `background: ${selectedColor}` });
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
  const updatePreview = () => {
    previewGlyph.textContent = SYMBOLS.find((item) => item.id === symbol.value)?.glyph || '●';
    previewGlyph.style.background = selectedColor;
  };

  view.append(
    el('div', { className: 'page narrow' }, [
      el('h2', { text: 'Profil' }),
      el('form', { className: 'panel stack', onSubmit: save }, [
        el('label', {}, ['Alias', alias]),
        el('label', {}, ['Symbol', symbol]),
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
  symbol.addEventListener('change', updatePreview);
  renderIcons();
}
