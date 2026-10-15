const { test, expect } = require('@playwright/test');
const Core = require('../../game-core');
const jsQR = require('jsqr');

async function openRoom(page, { host = false, input = false } = {}) {
  const state = Core.createRoom('TEST', 'host');
  for (const id of ['host', 'p1', 'p2']) Core.addOrUpdatePlayer(state, id, id);
  if (input) {
    state.settings = Core.normalizeSettings({ topic: '動物', constraint: '赤い' });
    Core.startWeek(state);
    Core.startInput(state);
  }
  await page.route('**/room-sync.js*', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.addInitScript(({ state, userId }) => {
    let callback;
    window.subscriptionCodes = [];
    window.testRoom = state;
    window.pushRoom = next => { window.testRoom = next; callback?.(structuredClone(next)); };
    window.CWWRoom = {
      configured: true, userId, ready: async () => {},
      getRoom: async () => structuredClone(window.testRoom),
      subscribe: (code, cb) => { window.subscriptionCodes.push(code); callback = cb; queueMicrotask(() => cb(structuredClone(window.testRoom))); return () => { callback = null; }; },
      mutateRoom: async (_code, mutator) => { window.pushRoom(await mutator(structuredClone(window.testRoom))); }
    };
  }, { state, userId: host ? 'host' : 'p1' });
  await page.goto('/?room=TEST');
  await page.locator('#join-room-button').click();
  await expect(page.locator(host ? '#screen-host' : '#screen-player')).toHaveClass(/is-active/);
}

test('incoming submission preserves the unsent word, focus and cursor', async ({ page }) => {
  await openRoom(page, { input: true });
  const field = page.locator('#player-hidden-word');
  await field.fill('ライオン');
  await field.evaluate(el => { el.focus(); el.setSelectionRange(2, 2); window.originalField = el; });
  await page.evaluate(() => {
    const next = structuredClone(window.testRoom);
    next.submissions.p2 = { word: 'ゾウ' };
    window.pushRoom(next);
  });
  await expect(field).toHaveValue('ライオン');
  await expect(field).toBeFocused();
  expect(await field.evaluate(el => el === window.originalField && el.selectionStart === 2)).toBe(true);
});

test('joining player preserves the host setup DOM and current text', async ({ page }) => {
  await openRoom(page, { host: true });
  const field = page.locator('#host-topic');
  await field.fill('動物');
  await field.evaluate(el => { el.focus(); window.originalField = el; });
  await page.evaluate(() => {
    const next = structuredClone(window.testRoom);
    next.players.p3 = { id: 'p3', name: '追加の人', active: true };
    window.pushRoom(next);
  });
  await expect(field).toHaveValue('動物');
  expect(await field.evaluate(el => el === window.originalField)).toBe(true);
  await expect(page.locator('#host-player-list')).toContainText('追加の人');
});

test('room QR decodes to the invitation URL and opens with the code filled in', async ({ page, context }) => {
  await openRoom(page, { host: true });
  const url = 'http://127.0.0.1:4173/?room=TEST';
  await expect(page.locator('#room-invite-url')).toHaveValue(url);
  const image = page.locator('#room-qr img');
  await expect(image).toBeVisible();
  const pixels = await image.evaluate(async img => {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { width: canvas.width, height: canvas.height, data: [...ctx.getImageData(0, 0, canvas.width, canvas.height).data] };
  });
  const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
  expect(decoded?.data).toBe(url);
  const guest = await context.newPage();
  await guest.route('**/room-sync.js*', route => route.fulfill({ contentType: 'text/javascript', body: 'window.CWWRoom = { configured: true };' }));
  await guest.goto(decoded.data);
  await expect(guest.locator('#join-code')).toHaveValue('TEST');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('blocked browser storage does not prevent entering a room', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    Storage.prototype.removeItem = () => { throw new DOMException('blocked', 'SecurityError'); };
  });
  await openRoom(page, { host: true });
  await expect(page.locator('#host-topic')).toBeVisible();
});

test('late reconnection result after leaving does not resurrect the room', async ({ page }) => {
  await openRoom(page, { host: true });
  await page.evaluate(() => {
    window.CWWRoom.getRoom = () => new Promise(resolve => { window.finishRecovery = resolve; });
  });
  await page.locator('#screen-host [data-action="sync"]').click();
  await expect.poll(() => page.evaluate(() => typeof window.finishRecovery)).toBe('function');
  await page.locator('#screen-host [data-action="leave"]').click();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => window.finishRecovery(structuredClone(window.testRoom)));
  expect(await page.evaluate(() => window.subscriptionCodes)).toEqual(['TEST']);
  await expect(page.locator('#screen-home')).toHaveClass(/is-active/);
  expect(errors).toEqual([]);
  await page.evaluate(() => { window.pushRoom(null); });
  await expect(page.locator('#toast')).not.toHaveClass(/show/);
});

test('new phase actions stay disabled until the previous write finishes', async ({ page }) => {
  await openRoom(page, { input: true });
  await page.evaluate(() => {
    window.CWWRoom.mutateRoom = async (_code, mutate) => {
      const state = mutate(structuredClone(window.testRoom));
      state.phase = 'reveal';
      state.revealOrder = ['p1', 'p2', 'host'];
      state.revealIndex = 0;
      window.pushRoom(state);
      await new Promise(resolve => { window.finishWrite = resolve; });
    };
  });
  await page.locator('#player-hidden-word').fill('ライオン');
  await page.locator('#player-submit-word').click();
  await expect(page.locator('#player-reveal-word')).toBeDisabled();
  await page.evaluate(() => window.finishWrite());
  await expect(page.locator('#player-reveal-word')).toBeEnabled();
});
