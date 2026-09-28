const sitekey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
let scriptPromise;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      const timeout = window.setTimeout(() => fail(), 15000);
      const fail = () => {
        window.clearTimeout(timeout);
        script.remove();
        scriptPromise = null;
        reject(new Error('Robotkontrollen kunde inte laddas. Försök igen.'));
      };
      script.onload = () => {
        window.clearTimeout(timeout);
        if (window.turnstile) resolve(window.turnstile);
        else fail();
      };
      script.onerror = fail;
      document.head.append(script);
    });
  }
  return scriptPromise;
}

// Execute only when submitting. Tokens are single-use and also accompany the
// ordinary auth flows, since Supabase's CAPTCHA setting applies project-wide.
export function createCaptcha(container) {
  let widget;
  let pending;
  let disposed = false;
  const rejectPending = () => {
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pending.reject(new Error('Robotkontrollen misslyckades eller tog för lång tid. Försök igen.'));
    pending = null;
  };
  return {
    async token(required = false) {
      if (!sitekey) {
        if (required) throw new Error('Gästläget är inte tillgängligt ännu. Logga in med ett konto.');
        return undefined;
      }
      const turnstile = await loadTurnstile();
      if (disposed) throw new Error('Inloggningssidan har stängts.');
      if (widget === undefined) {
        widget = turnstile.render(container, {
          sitekey,
          execution: 'execute',
          appearance: 'interaction-only',
          language: 'sv',
          callback: (token) => {
            if (!pending) return;
            window.clearTimeout(pending.timeout);
            pending.resolve(token);
            pending = null;
          },
          'error-callback': rejectPending,
          'expired-callback': rejectPending,
          'timeout-callback': rejectPending,
        });
      } else {
        turnstile.reset(widget);
      }
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timeout: window.setTimeout(rejectPending, 120000) };
        try {
          turnstile.execute(widget);
        } catch {
          rejectPending();
        }
      });
    },
    dispose() {
      disposed = true;
      rejectPending();
      if (widget !== undefined) window.turnstile?.remove(widget);
    },
  };
}
