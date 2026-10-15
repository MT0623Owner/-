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

test('an old minimum-player warning clears when the roster becomes sufficient', async ({ page }) => {
  await openRoom(page, { host: true });
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    delete state.players.p2;
    window.pushRoom(state);
  });
  await page.locator('#host-topic').fill('動物');
  await page.locator('#host-constraint').fill('赤い');
  await page.locator('#host-start').click();
  await expect(page.locator('#toast')).toContainText('3人以上');
  await expect(page.locator('#toast')).toHaveClass(/show/);
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    window.CWWCore.addOrUpdatePlayer(state, 'p2', '追加の人');
    window.pushRoom(state);
  });
  await expect(page.locator('#toast')).not.toHaveClass(/show/);
  await expect(page.locator('#host-topic')).toHaveValue('動物');
});

test('room QR decodes to the invitation URL and opens with the code filled in', async ({ page, context }) => {
  await openRoom(page, { host: true });
  await page.locator('[data-action=invite]').click();
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

test('stalled recovery can retry and its late response cannot replace fresh participants', async ({ page }) => {
  await openRoom(page, { host: true });
  await page.clock.install();
  await page.evaluate(() => {
    window.recoveryReads = 0;
    window.CWWRoom.getRoom = () => {
      window.recoveryReads++;
      if (window.recoveryReads === 1) return new Promise(resolve => { window.finishStalledRecovery = resolve; });
      const state = structuredClone(window.testRoom);
      state.players.p3 = { id: 'p3', name: '追加の人', active: true };
      window.testRoom = state;
      return Promise.resolve(state);
    };
  });
  const sync = page.locator('#screen-host [data-action="sync"]');
  await sync.click();
  await page.clock.runFor(16000);
  await sync.click();
  expect(await page.evaluate(() => window.recoveryReads)).toBe(2);
  await expect(page.locator('#host-player-list')).toContainText('追加の人');
  await page.evaluate(() => {
    const stale = structuredClone(window.testRoom);
    delete stale.players.p3;
    window.finishStalledRecovery(stale);
  });
  await expect(page.locator('#host-player-list')).toContainText('追加の人');
});

test('new phase actions stay disabled until the previous write finishes', async ({ page }) => {
  await openRoom(page, { input: true });
  await page.clock.install();
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
  await page.clock.runFor(16000);
  await expect(page.locator('#connection-notice')).toBeVisible();
  await expect(page.locator('#connection-notice')).toContainText('送信が完了している場合もあります');
  await expect(page.locator('#connection-notice [data-action="reload"]')).toBeEnabled();
  await expect(page.locator('#player-reveal-word')).toBeDisabled();
  await page.evaluate(() => window.finishWrite());
  await expect(page.locator('#player-reveal-word')).toBeEnabled();
  await expect(page.locator('#connection-notice')).not.toBeVisible();
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
  await expect(dialog.locator('.rule-ban > strong')).toBeInViewport();
  await expect(dialog.locator('.rule-ban > strong')).toHaveText('名乗り・カード提示・ヒントの公開は禁止');
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
  await expect(dialog.locator('.rule-do > strong').last()).toHaveText('公開ワードを比べ、話し合いと最終告発で人狼を探す');
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
  await expect(dialog.locator('.rule-do > strong')).toBeInViewport();
  await expect(dialog.locator('.rule-ban > strong')).toBeInViewport();
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

for (const host of [false, true]) {
  test(`${host ? 'host' : 'player'} thinking readiness waits for eligible players and skips on last tap`, async ({ page }) => {
    await openRoom(page, { host });
    const prefix = host ? 'host' : 'player';
    await page.evaluate(() => {
      const state = structuredClone(window.testRoom);
      state.settings.inputSeconds = 180;
      state.players.p2.suspect = true;
      window.CWWCore.startWeek(state);
      window.pushRoom(state);
    });
    const button = page.locator(`#${prefix}-complete-thinking`);
    await button.evaluate(el => { window.thinkingButton = el; });
    await page.evaluate(() => window.pushRoom(structuredClone(window.testRoom)));
    expect(await button.evaluate(el => el === window.thinkingButton)).toBe(true);
    await expect(page.locator('.screen.is-active [data-countdown]:visible')).toHaveCount(1);
    await expect(page.locator(`#${host ? 'host-participant' : 'player-phase'}-panel`)).toContainText('0 / 2人');
    await button.click();
    await expect(button).toHaveText('思考完了済み');
    await expect(button).toBeDisabled();
    expect(await page.evaluate(() => window.testRoom.phase)).toBe('think');
    await page.evaluate(() => {
      const state = structuredClone(window.testRoom);
      const other = window.CWWRoom.userId === 'host' ? 'p1' : 'host';
      window.CWWCore.completeThinking(state, other, state.week, state.thinkEndsAt);
      window.pushRoom(state);
    });
    await expect(page.locator(`#${prefix}-hidden-word`)).toBeVisible();
    expect(await page.evaluate(() => window.testRoom.thinkEndsAt - Date.now())).toBeGreaterThan(150000);
  });
}

test('spectator master and suspects are not offered thinking completion, timers are singular', async ({ page }) => {
  await openRoom(page, { host: true });
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    delete state.players.host;
    window.CWWCore.startWeek(state);
    window.pushRoom(state);
  });
  await expect(page.locator('#host-complete-thinking')).toHaveCount(0);
  await expect(page.locator('.screen.is-active [data-countdown]:visible')).toHaveCount(1);
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.players.host = { id: 'host', name: 'host', active: true, suspect: true };
    window.pushRoom(state);
  });
  await expect(page.locator('#host-complete-thinking')).toHaveCount(0);
  await expect(page.locator('#host-participant-panel')).toContainText('思考完了の対象外');
  await expect(page.locator('.screen.is-active [data-countdown]:visible')).toHaveCount(1);
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.settings.discussionSeconds = 60;
    window.CWWCore.startDiscussion(state);
    window.pushRoom(state);
  });
  await expect(page.locator('.screen.is-active [data-countdown]:visible')).toHaveCount(1);
});

test('final accusation is disabled without suspects and explains outcomes before voting', async ({ page }) => {
  await openRoom(page, { host: true });
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    window.CWWCore.startDiscussion(state);
    window.pushRoom(state);
  });
  await expect(page.locator('#start-final')).toBeDisabled();
  await expect(page.locator('#start-final')).toHaveText('容疑者による最終告発へ');
  await expect(page.locator('#start-vote')).toBeEnabled();
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.players.host.suspect = true;
    window.pushRoom(state);
  });
  if (await page.locator('#rules-dialog').isVisible()) await page.locator('#close-rules').click();
  await expect(page.locator('#host-phase-panel')).toContainText('同票は人狼勝利');
  await page.locator('#start-final').click();
  await expect(page.locator('#host-participant-panel')).toContainText('それ以外・同票は人狼勝利');
  await expect(page.locator('#host-participant-panel .vote-option')).toHaveCount(2);
});

test('mobile text controls avoid small focus text and phase changes release focus without disabling zoom', async ({ page }) => {
  await openRoom(page, { host: true });
  for (const field of await page.locator('.screen.is-active input:visible, .screen.is-active select:visible').all()) {
    expect(await field.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  }
  await page.locator('#host-topic').focus();
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    window.CWWCore.startWeek(state);
    window.pushRoom(state);
  });
  expect(await page.evaluate(() => document.activeElement.matches('input,select,textarea'))).toBe(false);
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).not.toMatch(/user-scalable=no|maximum-scale=1/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('local automatic topics start with seer and expose only the participants own card', async ({ page }) => {
  await openRoom(page, { host: true });
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.players.p3 = { id: 'p3', name: 'p3', active: true };
    window.pushRoom(state);
  });
  await page.locator('#host-topic-mode').selectOption('local');
  await page.locator('#host-topic-auto').fill('動物');
  await page.locator('#host-use-seer').check();
  await page.locator('#host-start').click();
  await expect(page.locator('#rules-dialog')).toBeVisible();
  const state = await page.evaluate(() => window.testRoom);
  expect(state.settings.topic).toBe('動物');
  expect(state.settings.constraint.length).toBeGreaterThan(0);
  expect(state.settings.hint.length).toBeGreaterThan(0);
  expect(state.seerId).not.toBe('');
  expect(state.players[state.seerId].role).toBe('村人');
  if (state.players.host.role !== '人狼') await expect(page.locator('#host-player-card')).not.toContainText(state.settings.constraint);
});

for (const host of [false, true]) test(`shared effect waits for acknowledgement, host=${host}`, async ({ page }) => {
  await openRoom(page, { host, input: true });
  await page.evaluate(() => {
    const C = window.CWWCore, s = structuredClone(window.testRoom);
    C.startVote(s);
    for (const id of ['host', 'p1', 'p2']) C.castVote(s, id, C.SKIP_VOTE);
    C.resolveVotes(s);
    window.pushRoom(s);
  });
  await expect(page.locator('#presentation-event')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.CWWPresentation.complete());
  await page.waitForTimeout(5500);
  expect(await page.evaluate(() => window.testRoom.phase)).toBe('presentation');
  await page.locator('#skip-effect').click();
  await expect(page.locator('#skip-effect')).toBeDisabled();
  await expect(page.locator('#presentation-event')).toBeVisible();
  expect(await page.evaluate(() => window.testRoom.phase)).toBe('presentation');
  await page.evaluate(() => { window.CWWPresentation.reset(); window.pushRoom(structuredClone(window.testRoom)); });
  await expect(page.locator('#presentation-event')).toBeVisible();
  await expect(page.locator('#skip-effect')).toBeDisabled();
  if (host) await page.locator('#force-effect').click();
  else await page.evaluate(() => {
    const s = structuredClone(window.testRoom), gate = s.presentation;
    for (const id of gate.required) window.CWWCore.confirmPresentation(s, id, gate.id);
    window.pushRoom(s);
  });
  await expect(page.locator('#presentation-event')).not.toBeVisible();
  expect(await page.evaluate(() => window.testRoom.phase)).toBe('think');
});

async function pendingVote(page) {
  await openRoom(page, { input: true });
  await page.evaluate(() => {
    const C = window.CWWCore, s = structuredClone(window.testRoom);
    C.startVote(s);
    for (const id of ['host', 'p1', 'p2']) C.castVote(s, id, C.SKIP_VOTE);
    C.resolveVotes(s);
    window.pushRoom(s);
  });
  await expect(page.locator('#presentation-event')).toBeVisible();
}

test('stale confirmation consumes the returned current state without another snapshot', async ({ page }) => {
  await pendingVote(page);
  await page.evaluate(() => {
    const s = structuredClone(window.testRoom);
    window.CWWCore.forcePresentation(s, 'host', s.presentation.id);
    window.testRoom = s; // server advanced; subscriber notification is delayed
    window.CWWRoom.mutateRoom = async (_code, mutate) => mutate(structuredClone(window.testRoom));
  });
  await page.locator('#skip-effect').click();
  await expect(page.locator('#presentation-event')).not.toBeVisible();
  await expect(page.locator('#player-complete-thinking')).toBeVisible();
});

test('presentation recovery and local close stay accessible during a stalled write', async ({ page }) => {
  await pendingVote(page);
  await page.evaluate(() => { window.CWWRoom.mutateRoom = () => new Promise(() => {}); });
  await page.locator('#skip-effect').click();
  await expect(page.locator('#effect-sync')).toBeEnabled();
  await page.locator('#effect-close').click();
  await expect(page.locator('#presentation-event')).not.toBeVisible();
  expect(await page.evaluate(() => window.testRoom.presentation.ready.p1)).toBeUndefined();
  await page.evaluate(() => window.pushRoom(structuredClone(window.testRoom)));
  await expect(page.locator('#presentation-event')).not.toBeVisible();
  await page.locator('[data-action="show-effect"]').click();
  await expect(page.locator('#presentation-event')).toBeVisible();
  await page.evaluate(() => {
    const s = structuredClone(window.testRoom);
    window.CWWCore.forcePresentation(s, 'host', s.presentation.id);
    window.testRoom = s;
  });
  await page.locator('#effect-sync').click();
  await expect(page.locator('#presentation-event')).not.toBeVisible();
});

test('a late transaction result cannot restore a presentation after a newer snapshot', async ({ page }) => {
  await pendingVote(page);
  await page.evaluate(() => {
    window.CWWRoom.mutateRoom = async (_code, mutate) => {
      const stale = mutate(structuredClone(window.testRoom));
      await new Promise(resolve => { window.finishOldConfirmation = resolve; });
      return stale;
    };
  });
  await page.locator('#skip-effect').click();
  await page.evaluate(() => {
    const fresh = structuredClone(window.testRoom);
    window.CWWCore.forcePresentation(fresh, 'host', fresh.presentation.id);
    window.pushRoom(fresh);
    window.finishOldConfirmation();
  });
  await expect(page.locator('#presentation-event')).not.toBeVisible();
  await expect(page.locator('#player-complete-thinking')).toBeEnabled();
});

test('word reveals require no confirmation and do not make the game screen inert', async ({ page }) => {
  await openRoom(page, { input: true });
  await page.evaluate(() => {
    const C = window.CWWCore, s = structuredClone(window.testRoom);
    for (const id of ['host', 'p1', 'p2']) C.submitHiddenWord(s, id, id);
    C.startReveal(s);
    C.revealCurrentWord(s, 'host');
    window.pushRoom(s);
  });
  await expect(page.locator('#presentation-event')).toBeVisible();
  expect(await page.locator('#presentation-event').evaluate(el => el.matches(':modal'))).toBe(false);
  expect(await page.evaluate(() => window.testRoom.presentation)).toBeNull();
  await expect(page.locator('#player-reveal-word')).toBeEnabled();
  await expect(page.locator('#skip-effect')).toHaveText('閉じる');
  await expect(page.locator('#presentation-event')).not.toBeVisible({ timeout: 3500 });
});

for (const host of [false, true]) test(`thinking panel survives a delayed vote snapshot and restoration, host=${host}`, async ({ page }) => {
  await openRoom(page, { host, input: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    const C = window.CWWCore, vote = structuredClone(window.testRoom);
    C.startVote(vote);
    for (const id of ['host', 'p1', 'p2']) C.castVote(vote, id, C.SKIP_VOTE);
    C.resolveVotes(vote);
    const thinking = structuredClone(vote);
    C.forcePresentation(thinking, 'host', thinking.presentation.id);
    window.pushRoom(thinking);
    window.pushRoom(vote); // delayed notification replaces the thinking DOM
    window.pushRoom(thinking); // resync returns the very same round/deadline
  });
  const prefix = host ? 'host' : 'player';
  await expect(page.locator('#presentation-event')).not.toBeVisible();
  await expect(page.locator(`#${prefix}-complete-thinking`)).toBeEnabled();
  await expect(page.locator(host ? '#host-participant-panel .thinking-progress' : '#player-phase-panel .thinking-progress')).toHaveText('思考完了 0 / 3人');
  await page.locator(`#${prefix}-complete-thinking`).click();
  await expect(page.locator(`#${prefix}-complete-thinking`)).toBeDisabled();
  expect(errors).toEqual([]);
});

const generatedTopic = { topic: '動物', constraint: '水辺や水中で暮らすことが多いもの', hint: '生息地', matchingExamples: ['ペンギン','ビーバー','カワウソ','イルカ','アザラシ','タコ'], otherExamples: ['キリン','ライオン','ラクダ','リス','シマウマ','ウマ'] };
async function selectAI(page) {
  await openRoom(page, { host: true });
  await page.locator('#host-topic-mode').selectOption('external');
  await page.locator('#host-gemini-api-key').fill('fixture-ai-key');
}

test('AI starts with validated topics, stores no key or examples and sends the key only in a header', async ({page}) => {
  const requests = [];
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    requests.push({url:route.request().url(),headers:route.request().headers()});
    await route.fulfill({json:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(generatedTopic)}]}}]}});
  });
  await selectAI(page);
  await page.locator('#host-start').click();
  await expect(page.locator('#host-phase-panel')).toContainText('役職確認');
  const state = await page.evaluate(() => window.testRoom);
  expect(state.settings.topicMode).toBe('external');
  expect(state.settings.constraint).toBe(generatedTopic.constraint);
  expect(JSON.stringify(state)).not.toContain('fixture-ai-key');
  expect(JSON.stringify(state)).not.toContain('matchingExamples');
  expect(requests).toHaveLength(1);
  expect(requests[0].url).not.toContain('fixture-ai-key');
  expect(requests[0].headers['x-goog-api-key']).toBe('fixture-ai-key');
});

test('AI failure stays in the lobby, offers explicit local fallback and can forget the key', async ({page}) => {
  await page.route('https://generativelanguage.googleapis.com/**', route => route.fulfill({status:429,json:{error:{message:'fixture-ai-key'}}}));
  await selectAI(page);
  await page.locator('#host-start').click();
  await expect(page.locator('#ai-generation-status')).toContainText('利用上限');
  expect(await page.evaluate(() => window.testRoom.phase)).toBe('lobby');
  await expect(page.locator('#toast')).not.toContainText('fixture-ai-key');
  await page.locator('#forget-ai-key').click();
  await expect(page.locator('#host-gemini-api-key')).toHaveValue('');
  expect(await page.evaluate(()=>sessionStorage.getItem('cww.geminiApiKey.session'))).toBeNull();
  await page.locator('#ai-fallback').click();
  await expect(page.locator('#host-topic-mode')).toHaveValue('local');
  expect(await page.evaluate(() => window.testRoom.phase)).toBe('lobby');
  await page.locator('#host-start').click();
  await expect(page.locator('#host-phase-panel')).toContainText('役職確認');
});

test('AI retries invalid content once and does not call API when the roster is insufficient', async ({page}) => {
  let calls=0;
  await page.route('https://generativelanguage.googleapis.com/**', route => {
    calls++;
    return route.fulfill({json:{candidates:[{content:{parts:[{text:JSON.stringify(calls===1?{...generatedTopic,matchingExamples:[]}:generatedTopic)}]}}]}});
  });
  await selectAI(page);
  await page.evaluate(()=>{const s=structuredClone(window.testRoom); delete s.players.p2; window.pushRoom(s);});
  await page.locator('#host-start').click();
  await expect(page.locator('#toast')).toContainText('3人以上');
  expect(calls).toBe(0);
  await page.evaluate(()=>{const s=structuredClone(window.testRoom);window.CWWCore.addOrUpdatePlayer(s,'p2','p2');window.pushRoom(s);});
  await page.locator('#host-start').click();
  await expect(page.locator('#host-phase-panel')).toContainText('役職確認');
  expect(calls).toBe(2);
});
