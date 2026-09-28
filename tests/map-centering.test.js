import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createTimedCache } from '../src/timed-cache.js';

const source = (await readFile('src/map.js', 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export /gm, '');

function fixture() {
  let watches = 0;
  const cleared = [];
  const views = [];
  const appState = { user: { id: 'guest', is_anonymous: true }, locationSharingEnabled: true };
  const api = vm.runInNewContext(`${source}
    ownPositionIcon = () => ({});
    bindMemberPopup = () => {};
    ({ startSharing, stopSharing, handlePosition,
      mount() {
        map = { setView: (center, zoom) => recordView(center, zoom) };
        ownMarker = { setLatLng() {}, setIcon() {}, remove() {} };
        userAdjustedMapView = true;
      },
      position: () => lastOwnPosition,
      pan() { userAdjustedMapView = true; }
    });`, {
    appState, console, createTimedCache,
    window: { addEventListener() {}, setTimeout() {} },
    navigator: { geolocation: {
      watchPosition() { watches++; return 0; },
      clearWatch(id) { cleared.push(id); },
    } },
    recordView: (center, zoom) => views.push({ center: [...center], zoom }),
    logEvent() {}, showToast() {},
  });
  return { api, views, cleared, appState, watches: () => watches };
}

const position = { coords: { latitude: 57.7, longitude: 11.9, accuracy: 5 } };

test('guest GPS start centers once even if the previous session panned the map', async () => {
  const f = fixture();
  f.api.mount();
  f.api.startSharing();
  await f.api.handlePosition(position);
  assert.deepEqual(f.views, [{ center: [57.7, 11.9], zoom: 15 }]);
  f.api.pan();
  await f.api.handlePosition(position);
  assert.equal(f.views.length, 1, 'later GPS updates must not undo a manual pan');
});

test('watch ID zero is retained and cleared correctly', () => {
  const f = fixture();
  f.api.startSharing();
  f.api.startSharing();
  assert.equal(f.watches(), 1);
  f.api.stopSharing();
  assert.deepEqual(f.cleared, [0]);
});

test('GPS before map initialization is retained without touching a missing map', async () => {
  const f = fixture();
  f.api.startSharing();
  await f.api.handlePosition(position);
  assert.equal(f.api.position().latitude, 57.7);
  assert.equal(f.views.length, 0);
  f.api.mount();
  await f.api.handlePosition(position);
  assert.equal(f.views.length, 1);
});

test('disabled location sharing ignores GPS callbacks', async () => {
  const f = fixture();
  f.api.mount();
  f.appState.locationSharingEnabled = false;
  await f.api.handlePosition(position);
  assert.equal(f.views.length, 0);
  assert.equal(f.api.position(), null);
});
