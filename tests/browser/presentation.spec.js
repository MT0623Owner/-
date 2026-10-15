const { test, expect } = require('@playwright/test');
const Core = require('../../game-core');
const fs = require('node:fs/promises');
const path = require('node:path');

async function openGame(page, host = false) {
  const state = Core.createRoom('FXTS', 'host');
  for (const id of ['host', 'p1', 'p2', 'p3']) {
    Core.addOrUpdatePlayer(state, id, id);
    state.players[id].role = id === 'p3' ? Core.ROLES.WOLF : Core.ROLES.VILLAGER;
  }
  state.settings = Core.normalizeSettings({ topic: '動物', constraint: '秘密の制約', hint: '秘密のヒント', useSeer: true });
  Core.startWeek(state);
  Core.startInput(state);
  state.submissions.p3 = { word: '未公開ワード', revealed: false };
  await page.route('**/room-sync.js*', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.addInitScript(({ state, userId }) => {
    let callback;
    window.writeCount = 0;
    window.vibrations = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: pattern => { window.vibrations.push(pattern); return true; } });
    window.testRoom = state;
    window.pushRoom = next => { window.testRoom = next; callback?.(structuredClone(next)); };
    window.CWWRoom = {
      configured: true, userId, ready: async () => {}, getRoom: async () => structuredClone(window.testRoom),
      subscribe: (_code, cb) => { callback = cb; queueMicrotask(() => cb(structuredClone(window.testRoom))); return () => { callback = null; }; },
      mutateRoom: async (_code, mutate) => { window.writeCount++; window.pushRoom(await mutate(structuredClone(window.testRoom))); }
    };
  }, { state, userId: host ? 'host' : 'p1' });
  await page.goto('/?room=FXTS');
  await page.locator('#join-room-button').click();
  await page.locator('#close-rules').click();
  await page.evaluate(() => {
    const update = window.CWWPresentation.update;
    window.CWWPresentation.update = view => { window.effectView = structuredClone(view); update(view); };
    window.CWWPresentation.complete();
  });
}

async function publishWord(page, count = 1) {
  await page.evaluate(count => {
    const state = structuredClone(window.testRoom);
    for (let i = 0; i < count; i++) state.logs.push({ id: `word${state.logs.length}`, week: state.week, playerId: 'p2', playerName: 'p2', word: 'ライオン', normalized: 'ライオン' });
    window.pushRoom(state);
  }, count);
}

async function screenshot(page, name) {
  if (!process.env.CWW_CAPTURE_DIR) return;
  const directory = path.join(process.env.CWW_CAPTURE_DIR, test.info().project.name);
  await fs.mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: !name.startsWith('comparison-'), scale: 'css' });
}

for (const layout of [
  { name: 'mobile-player', width: 390, height: 844, host: false },
  { name: 'mobile-master', width: 390, height: 844, host: true },
  { name: 'desktop-player', width: 1280, height: 900, host: false },
  { name: 'desktop-master', width: 1280, height: 900, host: true }
]) {
  test.describe(layout.name, () => {
  test.use({ isMobile: layout.name.startsWith('mobile'), hasTouch: layout.name.startsWith('mobile'), deviceScaleFactor: 1 });
  test(`${layout.name}: reveal is skippable, stable during sync and never receives hidden data`, async ({ page }) => {
    await page.setViewportSize(layout);
    await openGame(page, layout.host);
    const prefix = layout.host ? 'host' : 'player';
    await page.locator(`#${prefix}-hidden-word`).fill('キリン');
    await publishWord(page);
    await expect(page.locator('#presentation-event')).toBeVisible();
    await expect(page.locator('#effect-body')).toContainText('ライオン');
    await page.locator(`#${prefix}-log [data-log-id]`).evaluate(el => { window.originalLog = el; });
    await page.evaluate(() => window.pushRoom(structuredClone(window.testRoom)));
    expect(await page.locator(`#${prefix}-log [data-log-id]`).evaluate(el => el === window.originalLog)).toBe(true);
    const projected = JSON.stringify(await page.evaluate(() => window.effectView));
    for (const secret of ['秘密の制約', '秘密のヒント', '未公開ワード', '人狼']) expect(projected).not.toContain(secret);
    expect(await page.evaluate(() => window.writeCount)).toBe(0);
    expect(await page.evaluate(() => window.vibrations)).toEqual([]);
    await screenshot(page, `${layout.name}-reveal`);
    await page.locator('#skip-effect').click();
    await expect(page.locator('#presentation-event')).not.toBeVisible();
    await expect(page.locator(`#${prefix}-hidden-word`)).toHaveValue('キリン');
    await expect(page.locator(`#${prefix}-submit-word`)).toBeEnabled();
    await publishWord(page);
    await expect(page.locator('#presentation-event')).not.toBeVisible({ timeout: 7000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`${layout.name}: vote count, suspect scene and result timeline remain usable`, async ({ page }) => {
    await page.setViewportSize(layout);
    await openGame(page, layout.host);
    const prefix = layout.host ? 'host' : 'player';
    await publishWord(page);
    await page.locator('#skip-effect').click();
    await page.evaluate(() => {
      const state = structuredClone(window.testRoom);
      state.players.p2.suspect = true;
      state.voteHistory.push({ week: 1, final: false, result: 'p2', votes: ['p2', 'p2', 'p3', 'p2'].map(targetId => ({ targetId, targetName: targetId })) });
      window.pushRoom(state);
    });
    await expect(page.locator('#effect-title')).toHaveText('開票中');
    await expect(page.locator('[data-effect-count="0"]')).toHaveText('3票');
    await expect(page.locator('#effect-title')).toContainText('p2さんが容疑者');
    await expect(page.locator(`#${prefix}-vote-summary`)).toContainText('3票');
    await screenshot(page, `${layout.name}-vote`);
    await page.locator('#skip-effect').click();
    await page.evaluate(() => {
      const state = structuredClone(window.testRoom);
      state.players[window.CWWRoom.userId].suspect = true;
      state.phase = 'finalVote';
      state.votes = {};
      window.pushRoom(state);
    });
    await page.locator('#close-rules').click();
    await expect(page.locator('body')).toHaveClass(/accusation-scene/);
    const panel = page.locator(layout.host ? '#host-participant-panel' : '#player-phase-panel');
    await expect(panel).toHaveClass(/accusation-panel/);
    await expect(panel.locator('.vote-option').first()).toBeEnabled();
    await screenshot(page, `${layout.name}-accusation`);
    await page.evaluate(() => {
      const state = structuredClone(window.testRoom);
      state.phase = 'result'; state.winner = 'villager'; state.reason = 'p3さんが人狼でした。';
      window.pushRoom(state);
    });
    const resultRoot = page.locator(layout.host ? '#host-phase-panel' : '#player-phase-panel');
    await expect(resultRoot.locator('.result-reveal-card')).toHaveCount(4);
    await expect(resultRoot.locator('.result-reveal-card').last()).toContainText('秘密の制約');
    await resultRoot.locator('[data-action="finish-effects"]').click();
    const word = resultRoot.locator('[data-review-word]').first();
    const before = await page.evaluate(() => JSON.stringify(window.testRoom));
    await word.click();
    await expect(word).toHaveAttribute('data-assessment', '1');
    await expect(page.locator(`#${prefix}-log [data-log-id]`).first()).toHaveAttribute('data-assessment', '1');
    await page.evaluate(() => window.pushRoom(structuredClone(window.testRoom)));
    await expect(resultRoot.locator('[data-review-word]').first()).toHaveAttribute('data-assessment', '1');
    expect(await page.evaluate(() => JSON.stringify(window.testRoom))).toBe(before);
    expect(await page.evaluate(() => window.writeCount)).toBe(0);
    await screenshot(page, `${layout.name}-result`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  });
}

test('tie and skip show no suspect, reduced motion and rejoin do not replay effects', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openGame(page);
  for (const targets of [['p2', 'p3'], ['__skip__', '__skip__']]) {
    await page.evaluate(targets => {
      const state = structuredClone(window.testRoom);
      state.voteHistory.push({ week: 1, final: false, result: targets[0] === '__skip__' ? 'スキップ' : '同数', votes: targets.map(targetId => ({ targetId, targetName: targetId === '__skip__' ? 'スキップ' : targetId })) });
      window.pushRoom(state);
    }, targets);
    await expect(page.locator('#player-vote-summary')).toContainText('該当者なし');
    await expect(page.locator('#presentation-event')).not.toBeVisible();
  }
  await publishWord(page);
  await expect(page.locator('#presentation-event')).not.toBeVisible();
  await expect(page.locator('#player-log .fx-word')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#screen-player [data-action="sync"]').click();
  await expect(page.locator('#presentation-event')).not.toBeVisible();
  await page.locator('#screen-player [data-action="leave"]').click();
  await expect(page.locator('#suspect-indicator')).not.toBeVisible();
});

test('only own seer awakening is animated, audio defaults off and vibration is opt in', async ({ page }) => {
  await openGame(page);
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.players.p2.role = '占い師'; state.seerId = 'p2';
    window.pushRoom(state);
  });
  await expect(page.locator('#rules-dialog')).not.toBeVisible();
  await expect(page.locator('#player-card')).not.toHaveClass(/fx-awaken/);
  await expect(page.locator('#effect-sound')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#effect-vibration').click();
  await publishWord(page);
  expect(await page.evaluate(() => window.vibrations)).toContain(35);
  await page.locator('#skip-effect').click();
  await page.locator('#effect-vibration').click();
  await page.evaluate(() => { window.vibrations = []; });
  await publishWord(page);
  expect(await page.evaluate(() => window.vibrations)).toEqual([]);
  await page.locator('#skip-effect').click();
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.week = 2; state.players.p1.role = '占い師';
    window.pushRoom(state);
  });
  await expect(page.locator('#rules-dialog')).toBeVisible();
  await expect(page.locator('#rules-title')).toHaveClass(/seer-awakening-title/);
  expect(await page.evaluate(() => window.vibrations)).toEqual([]);
  await screenshot(page, 'mobile-seer-awakening');
  await page.locator('#close-rules').click();
  await expect(page.locator('#player-submit-word')).toBeEnabled();
  await page.locator('#screen-player [data-action="leave"]').click();
  await page.locator('#screen-home [data-action="help"]').click();
  await expect(page.locator('#rules-title')).not.toHaveClass(/seer-awakening-title/);
});

test('sound unlocks on a gesture and can be turned off; unsupported feedback does not block play', async ({ page }) => {
  await page.addInitScript(() => {
    window.tones = 0;
    window.audioResumes = 0;
    window.AudioContext = class {
      constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
      resume() { window.audioResumes++; this.state = 'running'; return Promise.resolve(); }
      createOscillator() { return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(node) { return node; }, start() { window.tones++; }, stop() {}, disconnect() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    };
  });
  await openGame(page);
  await publishWord(page);
  expect(await page.evaluate(() => window.tones)).toBe(0);
  await page.locator('#skip-effect').click();
  await page.locator('#effect-sound').click();
  expect(await page.evaluate(() => window.audioResumes)).toBeGreaterThan(0);
  const before = await page.evaluate(() => window.tones);
  await publishWord(page);
  expect(await page.evaluate(() => window.tones)).toBeGreaterThan(before);
  await page.locator('#skip-effect').click();
  await page.locator('#effect-sound').click();
  const off = await page.evaluate(() => window.tones);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: () => { throw new Error('unsupported'); } });
  });
  await page.locator('#effect-vibration').click();
  await publishWord(page);
  await page.locator('#skip-effect').click();
  expect(await page.evaluate(() => window.tones)).toBe(off);
  await page.locator('#effect-vibration').click();
  await expect(page.locator('#effect-vibration')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#player-submit-word')).toBeEnabled();
});

test('ten-second urgency, stable vote targets and new game cleanup', async ({ page }) => {
  await openGame(page);
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.phase = 'think'; state.week = 3; state.thinkEndsAt = Date.now() + 9000;
    window.pushRoom(state);
  });
  await expect(page.locator('#player-phase-panel .countdown')).toHaveClass(/urgent/);
  await expect(page.locator('body')).toHaveAttribute('data-week-mood', 'final');
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom); state.phase = 'vote'; state.votes = {};
    window.pushRoom(state);
  });
  const button = page.locator('#player-phase-panel [data-target="p3"]');
  await button.evaluate(el => { window.originalVote = el; });
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.players = Object.fromEntries(Object.entries(state.players).reverse());
    window.pushRoom(state);
  });
  expect(await button.evaluate(el => el === window.originalVote)).toBe(true);
  await button.click();
  expect(await page.evaluate(() => window.testRoom.votes.p1)).toBe('p3');
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.phase = 'lobby'; state.week = 0; state.logs = []; state.voteHistory = [];
    window.pushRoom(state);
  });
  await expect(page.locator('body')).toHaveAttribute('data-week-mood', '');
  await expect(page.locator('#player-vote-summary')).not.toBeVisible();
  await expect(page.locator('#presentation-event')).not.toBeVisible();
});

test('reveals leave reading time, queue later words and skip clears the queue', async ({ page }) => {
  await openGame(page);
  await page.clock.install();
  await publishWord(page);
  await page.clock.runFor(3000);
  await expect(page.locator('#presentation-event')).toBeVisible();
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.logs.push({ id: 'next-word', week: 1, playerId: 'p3', playerName: 'p3', word: 'キリン' });
    window.pushRoom(state);
  });
  await expect(page.locator('#effect-body')).toHaveText('ライオン');
  await page.clock.runFor(2200);
  await expect(page.locator('#effect-body')).toHaveText('キリン');
  await publishWord(page);
  await page.locator('#skip-effect').click();
  await page.clock.runFor(10000);
  await expect(page.locator('#presentation-event')).not.toBeVisible();
  await publishWord(page, 2);
  await page.evaluate(() => {
    const state = structuredClone(window.testRoom);
    state.phase = 'vote'; state.votes = {};
    window.pushRoom(state);
  });
  await page.clock.runFor(10000);
  await expect(page.locator('#presentation-event')).not.toBeVisible();
  expect(await page.evaluate(() => window.writeCount)).toBe(0);
});

for (const host of [false, true]) {
  test(`${host ? 'master' : 'player'} compares four people in one viewport and keeps many rounds scrollable`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openGame(page, host);
    const prefix = host ? 'host' : 'player';
    await page.evaluate(() => {
      const state = structuredClone(window.testRoom);
      const names = ['マスター', 'Codex', 'Android', 'iPad'];
      const words = [['学校', '会社'], ['公園', '海岸', '山頂'], ['家', '野球場', 'トイレ'], ['公園', 'ディズニーランド', 'スタジアム']];
      state.logs = Object.values(state.players).flatMap((player, i) => {
        player.name = names[i];
        return words[i].map((word, week) => ({ id: `${player.id}-${week}`, week: week + 1, playerId: player.id, playerName: player.name, word }));
      });
      state.phase = 'vote'; state.week = 3; state.votes = {};
      window.pushRoom(state);
      window.CWWPresentation.complete();
    });
    const log = page.locator(`#${prefix}-log`);
    await expect(log.locator('.log-row')).toHaveCount(4);
    await expect(log).not.toContainText('週目');
    const bounds = await log.boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThan(844);
    expect(await log.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await log.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const line = log.locator('[data-log-player="p1"] [data-log-id]');
    const ys = await line.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(20);
    await expect(log.locator('[data-log-player="host"] .missing-word')).toHaveCount(1);
    const card = page.locator(host ? '#host-player-card' : '#player-card');
    await card.locator('.card-toggle').click();
    await expect(card.locator('.card-info')).toBeVisible();
    await page.evaluate(() => window.pushRoom(structuredClone(window.testRoom)));
    await expect(card.locator('.card-info')).toBeVisible();
    await card.locator('.card-toggle').click();
    await expect(card.locator('.card-info')).not.toBeVisible();
    await screenshot(page, `comparison-${prefix}`);
    await page.evaluate(() => {
      const state = structuredClone(window.testRoom);
      for (let i = 4; i < 8; i++) {
        window.CWWCore.addOrUpdatePlayer(state, `extra${i}`, `長い参加者名${i}`);
        for (let week = 1; week <= 6; week++) state.logs.push({ id: `extra${i}-${week}`, week, playerId: `extra${i}`, playerName: `長い参加者名${i}`, word: '長いワードも省略せずに比較' });
      }
      state.week = 6;
      window.pushRoom(state);
      window.CWWPresentation.complete();
    });
    await expect(log.locator('.log-row')).toHaveCount(8);
    expect(await log.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await log.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await log.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    expect(await log.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await screenshot(page, `comparison-eight-${prefix}`);
  });
}
