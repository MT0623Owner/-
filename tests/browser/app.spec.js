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

test('role help follows the private seer transition once and can be reopened', async ({ page }) => {
  await openRoom(page);
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.settings.useSeer = true;
    state.settings.hint = '秘密の方向';
    state.seerId = 'p1';
    for (const player of Object.values(state.players)) player.role = window.CWWCore.ROLES.VILLAGER;
    window.CWWCore.startRoleCheck(state);
    window.pushRoom(state);
  });
  const dialog = page.locator('#rules-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#rules-title')).toHaveText('あなたの役割：村人');
  await expect(dialog).not.toContainText('秘密の方向');
  await page.locator('#close-rules').click();
  await page.evaluate(() => window.pushRoom(structuredClone(window.testRoom)));
  await expect(dialog).not.toBeVisible();
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    for (const player of Object.values(state.players)) window.CWWCore.confirmRole(state, player.id);
    window.CWWCore.startWeek(state);
    window.pushRoom(state);
  });
  await expect(dialog).not.toBeVisible();
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    window.CWWCore.startWeek(state);
    window.pushRoom(state);
  });
  await expect(page.locator('#rules-title')).toHaveText('あなたの役割：占い師');
  await expect(dialog).toContainText('自分の気づきとして推理を話せます');
  await expect(dialog).not.toContainText('秘密の方向');
  await page.locator('#close-rules').click();
  await page.locator('#screen-player [data-action="help"]').click();
  await expect(dialog).toBeVisible();
  await page.locator('#close-rules').click();
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.players.p1.suspect = true;
    window.pushRoom(state);
  });
  await expect(dialog).toContainText('今は容疑者です');
  await expect(dialog).toContainText('占い師の遊び方');
  await page.locator('#close-rules').click();
  await page.evaluate(() => window.pushRoom(structuredClone(window.testRoom)));
  await expect(dialog).not.toBeVisible();
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.phase = window.CWWCore.PHASES.RESULT;
    window.pushRoom(state);
    state.players.p1.role = window.CWWCore.ROLES.VILLAGER;
    state.players.p1.suspect = false;
    window.CWWCore.startRoleCheck(state);
    window.pushRoom(state);
  });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#rules-title')).toHaveText('あなたの役割：村人');
});

test('participating master receives wolf guidance without another players private hint', async ({ page }) => {
  await openRoom(page, { host: true });
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.players.host.role = window.CWWCore.ROLES.WOLF;
    state.players.p1.role = window.CWWCore.ROLES.SEER;
    state.settings.hint = '他人の秘密';
    window.CWWCore.startRoleCheck(state);
    window.pushRoom(state);
  });
  const dialog = page.locator('#rules-dialog');
  await expect(dialog).toContainText('人狼の遊び方');
  await expect(dialog).toContainText('マスターの進め方');
  await expect(dialog).not.toContainText('他人の秘密');
  await expect(dialog).not.toContainText('占い師の遊び方');
  await expect(page.locator('#rules-title')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.locator('#screen-host [data-action="help"]').click();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('help preserves draft and dialog focus on sync, and remains closable during writes', async ({ page }) => {
  await openRoom(page, { input: true });
  const field = page.locator('#player-hidden-word');
  await field.fill('ライオン');
  const trigger = page.locator('#screen-player [data-action="help"]');
  await trigger.click();
  await page.locator('#close-rules').focus();
  await page.evaluate(() => window.pushRoom(structuredClone(window.testRoom)));
  await expect(page.locator('#close-rules')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(field).toHaveValue('ライオン');
  await page.evaluate(() => {
    window.CWWRoom.mutateRoom = () => new Promise(resolve => { window.finishHelpWrite = resolve; });
  });
  await page.locator('#player-submit-word').click();
  await expect(page.locator('#player-submit-word')).toBeDisabled();
  await trigger.click();
  await expect(page.locator('#rules-dialog')).toBeVisible();
  await page.locator('#close-rules').click();
  await expect(page.locator('#rules-dialog')).not.toBeVisible();
  await page.evaluate(() => window.finishHelpWrite());
});

test('home help is public and leaving a room clears private guidance', async ({ page }) => {
  await openRoom(page);
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.players.p1.role = window.CWWCore.ROLES.SEER;
    window.CWWCore.startRoleCheck(state);
    window.pushRoom(state);
  });
  await page.locator('#close-rules').click();
  await page.locator('#screen-player [data-action="leave"]').click();
  await page.locator('#screen-home [data-action="help"]').click();
  await expect(page.locator('#rules-title')).toHaveText('ルール・遊び方');
  await expect(page.locator('#rules-dialog')).not.toContainText('占い師の遊び方');
  await expect(page.locator('#rules-dialog')).toContainText('ゲームの流れ');
});
