// One active context. Pending reads are shared; even an empty result (or a
// failed request) is retained until expiry so frequent redraws cannot spam API.
export function createTimedCache(ttlMs = 60000, now = Date.now) {
  let entry;
  return {
    invalidate() { entry = undefined; },
    get(key, load, force = false) {
      if (!force && entry?.key === key && (entry.pending || now() < entry.expiresAt)) return entry.promise;
      const next = { key, pending: true, expiresAt: Infinity };
      next.promise = Promise.resolve().then(load).finally(() => {
        next.pending = false;
        next.expiresAt = now() + ttlMs;
      });
      entry = next;
      return next.promise;
    },
  };
}
