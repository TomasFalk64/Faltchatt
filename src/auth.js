import { requireSupabase, supabase } from './supabase.js';
import { appState, isGuest, setActiveGroupId, setLocationSharingEnabled, SYMBOLS, SYMBOL_COLORS } from './state.js';
import { centerOnNextOwnGpsPosition, clearOwnLocation, clearOwnPresence, refreshMapLayers, startSharing, stopSharing, stopPresenceHeartbeat, touchPresence } from './map.js';
import { el, friendlyError, icon, renderIcons, setSessionPill, showToast, symbolNode } from './ui.js';
import { createCaptcha } from './captcha.js';

let onAuthChanged = async () => {};
let accountHeartbeat;
let disposeAuthForm;
let signingOut = false;

export function setAuthChangeHandler(handler) {
  onAuthChanged = handler;
}

export async function signOutUser() {
  if (signingOut) return;
  signingOut = true;
  appState.signingOut = true;
  try {
    setLocationSharingEnabled(false);
    stopPresenceHeartbeat();
    stopSharing();
    await clearOwnLocation();
    await clearOwnPresence();
    // Clear every group, including those no longer selected in the UI.
    const { error: cleanupError } = await requireSupabase().rpc('clear_own_live_data');
    if (cleanupError) throw cleanupError;
    const { error } = await requireSupabase().auth.signOut();
    if (error) throw error;
    setActiveGroupId(null);
  } catch (error) {
    showToast(friendlyError(error, 'Kunde inte logga ut. Försök igen.'), 'error');
  } finally {
    signingOut = false;
    appState.signingOut = false;
  }
}

export async function initAuth() {
  if (!supabase) return;
  if (isRecoveryUrl()) appState.passwordRecovery = true;
  const { data, error } = await supabase.auth.getSession();
  if (error) console.error(error);
  let session = data?.session || null;
  if (session) {
    const verified = await supabase.auth.getUser();
    if (verified.error && [401, 403, 404].includes(verified.error.status)) {
      // An expired guest may still have a saved access token in this browser.
      await supabase.auth.signOut({ scope: 'local' });
      session = null;
      setActiveGroupId(null);
      setLocationSharingEnabled(false);
    }
  }
  await applySession(session);
  supabase.auth.onAuthStateChange((event, session) => {
    // Leave the Auth callback before making further Supabase requests.
    window.setTimeout(async () => {
      try {
        if (event === 'PASSWORD_RECOVERY' || isRecoveryUrl()) appState.passwordRecovery = true;
        await applySession(session);
        await onAuthChanged();
      } catch (error) {
        console.error(error);
        showToast('Kunde inte läsa din session. Ladda om sidan.', 'error');
      }
    }, 0);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && appState.user && !signingOut) void touchAccountActivity();
  });
}

function isRecoveryUrl() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return query.get('type') === 'recovery' || hash.get('type') === 'recovery';
}

function authRedirectUrl() {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

async function applySession(session) {
  const previousUserId = appState.user?.id || null;
  appState.session = session;
  appState.user = session?.user || null;
  window.clearInterval(accountHeartbeat);
  if (appState.user) {
    await ensureProfile();
    await touchAccountActivity();
    accountHeartbeat = window.setInterval(() => {
      if (!document.hidden && !signingOut) void touchAccountActivity();
    }, 60000);
    if (appState.locationSharingEnabled && previousUserId !== appState.user.id) centerOnNextOwnGpsPosition();
  } else {
    appState.profile = null;
    appState.passwordRecovery = false;
  }
  setSessionPill();
}

async function touchAccountActivity() {
  const userId = appState.user?.id;
  if (!userId) return;
  try {
    const { error } = await requireSupabase().rpc('touch_account_activity');
    if (error) throw error;
  } catch (error) {
    console.warn('Kunde inte uppdatera kontoaktivitet.', error);
    if (isGuest() && appState.user?.id === userId && ['23503', 'PGRST301', 'PGRST303'].includes(error.code)) {
      const verified = await requireSupabase().auth.getUser();
      if (verified.error && [401, 403, 404].includes(verified.error.status) && appState.user?.id === userId) {
        setLocationSharingEnabled(false);
        setActiveGroupId(null);
        await requireSupabase().auth.signOut({ scope: 'local' });
      }
    }
  }
}

export async function ensureProfile() {
  const client = requireSupabase();
  const user = appState.user;
  if (!user) return null;
  const { data, error } = await client
    .from('profiles')
    .select('id, alias, symbol, symbol_color, updated_at')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (data) {
    appState.profile = data;
    return data;
  }

  const alias = 'Fältanvändare';
  const initialSymbol = randomItem(SYMBOLS).id;
  const initialColor = randomItem(SYMBOL_COLORS);
  const { data: created, error: createError } = await client
    .from('profiles')
    .insert({ id: user.id, alias, symbol: initialSymbol, symbol_color: initialColor })
    .select('id, alias, symbol, symbol_color, updated_at')
    .single();
  if (createError) throw createError;
  appState.profile = created;
  return created;
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function renderAuth() {
  const authView = document.querySelector('#auth-view');
  const loggedIn = Boolean(appState.user);
  authView.hidden = loggedIn;
  // Preserve tab choice and an in-progress CAPTCHA on routine redraws.
  if (!loggedIn && authView.querySelector('.auth-form')) return;
  disposeAuthForm?.();
  disposeAuthForm = null;
  if (loggedIn) {
    authView.innerHTML = '';
    return;
  }

  authView.innerHTML = '';
  authView.append(
    el('div', { className: 'auth-panel' }, [
      el('h1', { text: 'Fältchatt' }),
      el('p', { text: 'Logga in, skapa konto eller fortsätt som gäst för att dela position, karta och chatt med din grupp.' }),
      authForm(),
    ]),
  );
  renderIcons();
}

function authForm() {
  const email = el('input', { type: 'email', placeholder: 'E-post', autocomplete: 'email', required: true });
  const password = el('input', { type: 'password', placeholder: 'Lösenord', autocomplete: 'current-password', required: true, minlength: '6' });
  let currentMode = 'signin';
  const submitButton = el('button', { className: 'primary', type: 'submit' }, [icon('log-in', 'Logga in'), 'Fortsätt']);
  const resetButton = el('button', { type: 'button', className: 'ghost auth-reset-button', onClick: resetPassword }, [icon('key-round', 'Återställ'), 'Återställ lösenord']);
  const signInTab = el('button', { type: 'button', className: 'auth-mode-button active', onClick: () => setMode('signin') }, ['Logga in']);
  const signUpTab = el('button', { type: 'button', className: 'auth-mode-button', onClick: () => setMode('signup') }, ['Skapa konto']);
  const guestTab = el('button', { type: 'button', className: 'auth-mode-button', onClick: () => setMode('guest') }, ['Gäst']);
  const modeHint = el('p', { className: 'auth-mode-hint', text: 'Logga in med ditt befintliga konto.' });
  const captchaContainer = el('div', { className: 'auth-captcha' });
  const captcha = createCaptcha(captchaContainer);
  disposeAuthForm = () => captcha.dispose();
  let busy = false;
  const fullMessage = 'Just nu är gästplatserna fulla. Försök igen senare eller logga in med ett konto.';

  function setBusy(value) {
    busy = value;
    [submitButton, signInTab, signUpTab, guestTab].forEach((button) => button.disabled = value);
    resetButton.disabled = value || currentMode !== 'signin';
  }

  function setMode(nextMode) {
    if (busy) return;
    currentMode = nextMode;
    const isSignup = currentMode === 'signup';
    const guest = currentMode === 'guest';
    email.hidden = password.hidden = guest;
    email.disabled = password.disabled = guest;
    modeHint.hidden = guest;
    resetButton.hidden = guest;
    guestTab.classList.toggle('active', guest);
    guestTab.setAttribute('aria-pressed', String(guest));
    signInTab.classList.toggle('active', currentMode === 'signin');
    signUpTab.classList.toggle('active', isSignup);
    signInTab.setAttribute('aria-pressed', String(currentMode === 'signin'));
    signUpTab.setAttribute('aria-pressed', String(isSignup));
    password.setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');
    submitButton.replaceChildren(icon(isSignup ? 'user-plus' : 'log-in', isSignup ? 'Skapa konto' : 'Logga in'), isSignup ? 'Skapa konto' : 'Logga in');
    if (guest) submitButton.replaceChildren('Gå till Fältchatt');
    resetButton.classList.toggle('is-placeholder', isSignup);
    resetButton.disabled = isSignup;
    resetButton.setAttribute('aria-hidden', String(isSignup));
    modeHint.textContent = isSignup
      ? 'Skapa konto med e-post och lösenord. Du behöver bekräfta e-postmeddelandet innan du kan logga in.'
      : 'Logga in med ditt befintliga konto.';
    renderIcons();
  }

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const client = requireSupabase();
      if (currentMode === 'guest') {
        const { data: available, error } = await client.rpc('guest_capacity_available');
        if (error) throw new Error('Gästläget är inte tillgängligt just nu. Försök igen senare.');
        if (!available) throw new Error(fullMessage);
        const captchaToken = await captcha.token(true);
        const result = await client.auth.signInAnonymously({ options: { captchaToken } });
        if (result.error) {
          const capacity = await client.rpc('guest_capacity_available');
          if (capacity.data === false) throw new Error(fullMessage);
          throw result.error;
        }
        showToast('Du använder Fältchatt som gäst.', 'success');
        return;
      }
      const captchaToken = await captcha.token();
      const credentials = { email: email.value.trim(), password: password.value };
      const result =
        currentMode === 'signup'
          ? await client.auth.signUp({ ...credentials, options: { emailRedirectTo: authRedirectUrl(), captchaToken } })
          : await client.auth.signInWithPassword({ ...credentials, options: { captchaToken } });
      if (result.error) throw result.error;
      if (currentMode === 'signup' && result.data?.user && Array.isArray(result.data.user.identities) && result.data.user.identities.length === 0) {
        showToast('Det finns redan ett konto med den e-postadressen. Logga in eller återställ lösenordet.', 'warning');
        return;
      }
      showToast(currentMode === 'signup' ? 'Det har skickats mail till e-postadressen du angav. Bekräfta i mailet för att kunna logga in.' : 'Du är inloggad.', 'success');
    } catch (error) {
      console.error(error);
      showToast(currentMode === 'guest' ? friendlyError(error, 'Kunde inte fortsätta som gäst.') : currentMode === 'signup' ? 'Kunde inte skapa konto. Kontrollera e-postadressen och robotkontrollen.' : 'Inloggningen misslyckades. Kontrollera uppgifterna och robotkontrollen.', 'error');
    } finally {
      setBusy(false);
    }
  };
  async function resetPassword() {
    if (busy) return;
    if (!email.value.trim()) {
      showToast('Ange e-post först.', 'warning');
      return;
    }
    setBusy(true);
    try {
      const captchaToken = await captcha.token();
      const { error } = await requireSupabase().auth.resetPasswordForEmail(email.value.trim(), {
        redirectTo: authRedirectUrl(),
        captchaToken,
      });
      if (error) throw error;
      showToast('Länk för lösenordsåterställning skickad.', 'success');
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte skicka återställningslänk.'), 'error');
    } finally {
      setBusy(false);
    }
  }
  setMode(currentMode);
  return el('form', { className: 'auth-form', onSubmit: submit }, [
    el('div', { className: 'auth-mode-tabs', role: 'group', 'aria-label': 'Välj inloggningsläge' }, [signInTab, signUpTab, guestTab]),
    el('div', { className: 'auth-form-body stack' }, [
      modeHint,
      email,
      password,
      captchaContainer,
      submitButton,
      resetButton,
    ]),
  ]);
}

export function renderProfile() {
  const view = document.querySelector('#profile-view');
  view.innerHTML = '';
  if (!appState.user) return;

  const alias = el('input', { value: appState.profile?.alias || '', placeholder: 'Välj alias' });
  let selectedSymbol = SYMBOLS.some((item) => item.id === appState.profile?.symbol) ? appState.profile.symbol : SYMBOLS[0].id;
  let selectedColor = appState.profile?.symbol_color || SYMBOL_COLORS[0];
  const shareToggle = el('input', { type: 'checkbox', id: 'profile-share-location' });
  shareToggle.checked = appState.locationSharingEnabled;
  shareToggle.addEventListener('change', () => {
    setLocationSharingEnabled(shareToggle.checked);
    if (shareToggle.checked) startSharing();
    else stopSharing();
    void touchPresence();
  });

  const save = async (event) => {
    event.preventDefault();
    try {
      const { data, error } = await requireSupabase()
        .from('profiles')
        .upsert({
          id: appState.user.id,
          alias: alias.value.trim() || 'Fältanvändare',
          symbol: selectedSymbol,
          symbol_color: selectedColor,
          updated_at: new Date().toISOString(),
        })
        .select('id, alias, symbol, symbol_color, updated_at')
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

  let deletingGuest = false;
  const deleteGuestProfile = async () => {
    if (!isGuest() || deletingGuest) return;
    if (!window.confirm('Radera din gästprofil permanent?\n\nDu lämnar alla grupper. Din profil, aktuella position och närvaro tas bort direkt. Meddelanden, polls och platsnålar finns kvar tills gruppen rensas. Det går inte att ångra.')) return;
    deletingGuest = true;
    try {
      const { error } = await requireSupabase().functions.invoke('delete-my-account', {
        body: { confirmGuest: true },
      });
      if (error) throw error;
      appState.signingOut = true;
      setLocationSharingEnabled(false);
      stopPresenceHeartbeat();
      stopSharing();
      setActiveGroupId(null);
      await requireSupabase().auth.signOut({ scope: 'local' });
      await applySession(null);
      await onAuthChanged();
      showToast('Gästprofilen har raderats. Gruppens meddelanden och platsnålar finns kvar.', 'success');
    } catch (error) {
      console.error(error);
      showToast(accountDeleteError(error), 'error');
    } finally {
      deletingGuest = false;
      appState.signingOut = false;
    }
  };

  const deleteAccount = async () => {
    if (isGuest()) return deleteGuestProfile();
    const email = appState.user.email || '';
    const confirmed = window.confirm(
      'Ta bort ditt konto permanent?\n\nDet går inte att ångra. Du lämnar alla grupper. Om du är owner flyttas ägarskap till annan medlem när det finns någon, annars tas tomma grupper bort.',
    );
    if (!confirmed) return;
    const typedEmail = window.prompt(`Skriv din e-postadress för att bekräfta:\n${email}`);
    if (typedEmail === null) return;
    if (typedEmail.trim().toLowerCase() !== email.trim().toLowerCase()) {
      showToast('E-postadressen matchar inte kontot.', 'warning');
      return;
    }
    try {
      await clearOwnLocation();
      await clearOwnPresence();
      const { error } = await requireSupabase().functions.invoke('delete-my-account', {
        body: { confirmEmail: typedEmail.trim() },
      });
      if (error) throw error;
      await requireSupabase().auth.signOut().catch(() => {});
      showToast('Kontot togs bort.', 'success');
    } catch (error) {
      console.error(error);
      showToast(accountDeleteError(error), 'error');
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
    el('div', { className: 'page narrow profile-page' }, [
      el('div', { className: 'tab-kicker', text: 'PROFIL' }),
      isGuest() ? el('p', { className: 'muted', text: 'Du använder Fältchatt som gäst. Profilen tas bort efter 24 timmars inaktivitet. Efter utloggning kan du inte återvända som samma gäst. Profilen förs inte över till ett konto.' }) : null,
      appState.passwordRecovery && !isGuest() ? passwordRecoveryForm() : null,
      el('form', { className: 'stack profile-form', onSubmit: save }, [
        el('label', { className: 'inline-field' }, [el('span', { text: 'Alias:' }), alias]),
        el('fieldset', { className: 'symbol-picker' }, [el('legend', { text: 'Symbol' }), ...symbolButtons]),
        el('fieldset', { className: 'color-picker' }, [el('legend', { text: 'Symbolfärg' }), ...colorButtons]),
        el('div', { className: 'symbol-preview' }, [previewGlyph, 'Visas på kartan']),
        el('label', { className: 'toggle-row' }, [shareToggle, el('span', { text: 'Visa och dela min position' })]),
        el('button', { className: 'primary', type: 'submit' }, [icon('save', 'Spara'), 'Spara profil']),
        el('button', { className: 'danger-button signout-button', type: 'button', onClick: signOutUser }, [icon('log-out', 'Logga ut'), 'Logga ut']),
        el('button', { className: 'danger-button', type: 'button', onClick: deleteAccount }, [icon('user-x', 'Ta bort konto'), isGuest() ? 'Radera min gästprofil' : 'Ta bort mitt konto']),
      ]),
    ]),
  );
  renderIcons();
}

function accountDeleteError(error) {
  const message = error?.message || '';
  const name = error?.name || '';
  if (name === 'FunctionsFetchError' || message.includes('Failed to send a request to the Edge Function')) {
    return 'Kunde inte nå kontoraderingsfunktionen. Kontrollera att Supabase Edge Function "delete-my-account" är deployad.';
  }
  if (name === 'FunctionsHttpError') {
    return 'Kontoraderingsfunktionen svarade med fel. Kontrollera Edge Function-loggen i Supabase.';
  }
  return friendlyError(error, 'Kunde inte ta bort kontot.');
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

