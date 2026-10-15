// Explicit opt-in. Uses four real anonymous Firebase clients and only its own room.
// Scenario decisions inspect fixture roles; this is an integration test, not AI play.
const { chromium, expect: baseExpect } = require('@playwright/test');
const expect = baseExpect.configure({ timeout: 30000 });
const fs = require('node:fs/promises');
const path = require('node:path');
if (process.env.CWW_LIVE_TEST !== '1') throw new Error('Set CWW_LIVE_TEST=1 for the isolated live Firebase release test.');
const baseURL = process.env.CWW_TEST_URL || 'http://127.0.0.1:4173/';
const output = process.env.CWW_CAPTURE_DIR || 'test-results/live-release';

(async () => {
  const browser = await chromium.launch();
  const pages = [];
  const byId = new Map();
  const errors = [];
  let host, code;
  const prefix = page => page === host ? 'host' : 'player';
  const state = () => host.evaluate(code => window.CWWRoom.getRoom(code), code);
  const dismiss = async page => {
    if (await page.locator('#rules-dialog').isVisible()) await page.locator('#close-rules').click();
    if (await page.locator('#presentation-event').isVisible()) await page.locator('#skip-effect').click();
  };
  async function start(seer) {
    await host.locator('#host-topic-mode').selectOption('local');
    await host.locator('#host-topic-auto').fill('動物');
    await host.locator('#host-use-seer').setChecked(seer);
    await host.locator('#host-input-seconds').fill('180');
    await host.locator('#host-discussion-seconds').selectOption('0');
    await host.locator('#host-start').click();
    for (const page of pages) {
      await expect(page.locator('#rules-dialog')).toBeVisible();
      await dismiss(page);
      await page.locator(`#${prefix(page)}-confirm-role`).click();
    }
    await host.locator('#begin-input').click();
    await expect.poll(async () => (await state()).phase).toBe('think');
    const started = await state();
    if (seer && !started.seerId) throw new Error('Seer missing');
    if (!started.settings.constraint || !started.settings.topic) throw new Error('Local topic generation failed');
    console.log(`PASS: local auto topic and role confirmation (seer=${seer})`);
  }
  async function playWords(words) {
    const snapshot = await state();
    const living = Object.values(snapshot.players).filter(p => p.active !== false && !p.suspect);
    for (const player of Object.values(snapshot.players)) {
      const page = byId.get(player.id);
      await dismiss(page);
      if (player.suspect) await expect(page.locator(`#${prefix(page)}-complete-thinking`)).toHaveCount(0);
    }
    await expect(host.locator('#screen-host [data-countdown]:visible')).toHaveCount(1);
    for (let i = 0; i < living.length; i++) {
      const page = byId.get(living[i].id);
      await page.locator(`#${prefix(page)}-complete-thinking`).click();
      if (i < living.length - 1) {
        await expect(page.locator(`#${prefix(page)}-complete-thinking`)).toBeDisabled();
        if ((await state()).phase !== 'think') throw new Error('Skipped before everyone completed');
      }
    }
    await expect.poll(async () => (await state()).phase).toBe('input');
    if ((await state()).thinkEndsAt - Date.now() < 90000) throw new Error('Did not skip thinking early');
    for (const [i, player] of living.entries()) {
      const page = byId.get(player.id);
      await page.locator(`#${prefix(page)}-hidden-word`).fill(words[i]);
      await page.locator(`#${prefix(page)}-submit-word`).click();
    }
    await expect.poll(async () => (await state()).phase).toBe('reveal');
    for (const id of (await state()).revealOrder) {
      const page = byId.get(id);
      await dismiss(page);
      await page.locator(`#${prefix(page)}-reveal-word`).click();
    }
    await expect.poll(async () => (await state()).phase).toMatch(/discussion|suspectTalk/);
    if ((await state()).phase === 'suspectTalk') {
      await dismiss(host);
      await host.locator('#start-discussion').click();
    }
    await expect(host.locator('#start-vote')).toBeVisible();
    console.log(`PASS: week ${snapshot.week} all-player thinking skip, submissions and reveals (${living.length} eligible)`);
  }
  async function voteFor(target, final = false) {
    if (!final) {
      await dismiss(host);
      await host.locator('#start-vote').click();
      await expect.poll(async () => (await state()).phase).toBe('vote');
    }
    const voting = await state();
    const voters = Object.values(voting.players).filter(p => p.active !== false && (final ? p.suspect : !p.suspect));
    for (const voter of voters) {
      const page = byId.get(voter.id);
      await dismiss(page);
      const selected = target === '__skip__' || voter.id !== target || final ? target : Object.values(voting.players).find(p => p.id !== target && !p.suspect && p.active !== false).id;
      await page.locator(`#${page === host ? 'host-participant' : 'player-phase'}-panel [data-target="${selected}"]`).click();
    }
  }
  try {
    await fs.mkdir(output, { recursive: true });
    for (let i = 0; i < 4; i++) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      page.on('pageerror', error => errors.push(error.message));
      pages.push(page);
    }
    host = pages[0];
    await host.goto(baseURL);
    await host.locator('#create-room-button').click();
    await expect(host.locator('#host-room-code')).not.toHaveText('----');
    code = await host.locator('#host-room-code').innerText();
    const url = await host.locator('#room-invite-url').inputValue();
    for (const [i, page] of pages.slice(1).entries()) {
      await page.goto(url);
      await page.locator('#join-name').fill(`公開前確認${i + 1}`);
      await page.locator('#join-room-button').click();
      await expect(page.locator('#player-title')).toHaveText(`公開前確認${i + 1} さん`);
    }
    for (const page of pages) byId.set(await page.evaluate(() => window.CWWRoom.userId), page);
    await start(false);
    await host.screenshot({ path: path.join(output, 'thinking-master.png'), fullPage: true });
    await pages[1].screenshot({ path: path.join(output, 'thinking-player.png'), fullPage: true });
    await playWords(['ライオン', 'キリン', 'ゾウ', 'ウサギ']);
    await expect(host.locator('#start-final')).toBeDisabled();
    let snapshot = await state();
    await voteFor(Object.values(snapshot.players).find(p => p.role === '人狼').id);
    await expect.poll(async () => (await state()).winner).toBe('villager');
    await host.screenshot({ path: path.join(output, 'no-seer-result.png'), fullPage: true });
    console.log('PASS: no-seer game completed with synchronized victory');
    await dismiss(host);
    await host.locator('#back-lobby').click();
    await start(true);
    await playWords(['ライオン', 'キリン', 'ゾウ', 'ウサギ']);
    await voteFor('__skip__');
    await expect.poll(async () => (await state()).week).toBe(2);
    snapshot = await state();
    const seerPage = byId.get(snapshot.seerId);
    await expect(seerPage.locator('#rules-title')).toHaveClass(/seer-awakening-title/);
    await expect(seerPage.locator(`#${prefix(seerPage)}-card`)).toContainText(snapshot.settings.hint);
    for (const page of pages.filter(p => p !== seerPage)) await expect(page.locator('#rules-dialog')).not.toBeVisible();
    await seerPage.screenshot({ path: path.join(output, 'seer-awakening.png'), fullPage: true });
    console.log('PASS: seer awakens privately at week 2');
    await playWords(['ネコ', 'イヌ', 'パンダ', 'コアラ']);
    const innocents = Object.values(snapshot.players).filter(p => p.role !== '人狼');
    await voteFor(innocents[0].id);
    await expect.poll(async () => (await state()).week).toBe(3);
    await playWords(['カバ', 'サイ', 'シマウマ']);
    await voteFor(innocents[1].id);
    await expect.poll(async () => (await state()).phase).toBe('finalVote');
    for (const suspect of Object.values((await state()).players).filter(p => p.suspect)) {
      const page = byId.get(suspect.id); await dismiss(page);
      await expect(page.locator('body')).toHaveClass(/accusation-scene/);
    }
    await voteFor(Object.values((await state()).players).find(p => p.role === '人狼').id, true);
    await expect.poll(async () => (await state()).winner).toBe('villager');
    await host.screenshot({ path: path.join(output, 'seer-final-result.png'), fullPage: true });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('PASS: 3 weeks, suspect exclusion, final accusation and replay; no browser errors');
  } catch (error) {
    if (host) await host.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    try {
      if (host && !code) {
        const created = await host.locator('#host-room-code').innerText().catch(() => '');
        if (/^[A-Z0-9]{4}$/.test(created)) code = created;
      }
      if (host && code) {
        await host.evaluate(async code => {
          const { getApp } = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js');
          const { getFirestore, doc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js');
          await deleteDoc(doc(getFirestore(getApp()), 'artifacts', window.CWW_APP_ID, 'public', 'data', 'rooms', code));
        }, code);
        console.log('CLEANUP: deleted only the new release-test room');
      }
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
