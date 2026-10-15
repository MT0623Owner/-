// Opt-in: creates one real Firebase room with three anonymous browser sessions.
// Deletes only that room in finally. Never runs in CI or the default test suite.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
if (process.env.CWW_LIVE_TEST !== '1') {
  console.error('Set CWW_LIVE_TEST=1 to allow creating a temporary room in the configured Firebase project.');
  process.exit(1);
}
const baseURL = process.env.CWW_TEST_URL || 'http://127.0.0.1:4173/';
(async () => {
  const browser = await chromium.launch();
  let host, code;
  const pages = [];
  const errors = [];
  try {
    await fs.mkdir('test-results', { recursive: true });
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.on('pageerror', e => errors.push(e.message));
      pages.push(page);
    }
    host = pages[0];
    await host.goto(baseURL);
    await host.locator('#create-room-button').click();
    await host.locator('#screen-host.is-active').waitFor();
    code = await host.locator('#host-room-code').textContent();
    const invitation = await host.locator('#room-invite-url').inputValue();
    console.log('PASS: real anonymous auth and room creation');
    for (const [i, page] of pages.slice(1).entries()) {
      await page.goto(invitation);
      await page.locator('#join-name').fill(`動作確認${i + 1}`);
      await page.locator('#join-room-button').click();
      await page.locator('#screen-player.is-active').waitFor();
    }
    console.log('PASS: invitation URL joins with two separate browser identities');
    await host.locator('#host-topic-mode').selectOption('local');
    await host.locator('#host-topic-auto').fill('動物');
    await host.locator('#host-input-seconds').fill('10');
    await host.locator('#host-discussion-seconds').selectOption('60');
    await host.screenshot({ path: 'test-results/live-host.png', fullPage: true });
    await host.locator('#host-start').click();
    for (const page of pages) {
      await expect(page.locator('#rules-dialog')).toBeVisible();
      await page.locator('#close-rules').click();
    }
    await host.locator('#host-confirm-role').click();
    for (const page of pages.slice(1)) await page.locator('#player-confirm-role').click();
    await host.locator('#begin-input').click();
    await host.locator('#host-hidden-word').waitFor();
    for (const [i, page] of pages.entries()) {
      const prefix = i ? 'player' : 'host';
      await page.locator(`#${prefix}-hidden-word`).fill(['ライオン', 'キリン', 'ゾウ'][i]);
      await page.locator(`#${prefix}-submit-word`).click();
    }
    console.log('PASS: confirmation, thinking and hidden submissions');
    const state = () => host.evaluate(code => window.CWWRoom.getRoom(code), code);
    const byId = new Map();
    for (const page of pages) byId.set(await page.evaluate(() => window.CWWRoom.userId), page);
    await expect(host.locator('#host-phase-panel')).toContainText('順番開示');
    for (const id of (await state()).revealOrder) {
      const page = byId.get(id);
      await page.locator(page === host ? '#host-reveal-word' : '#player-reveal-word').click();
    }
    await host.locator('#start-vote').waitFor();
    if (!((await state()).discussionEndsAt > Date.now())) throw new Error('Discussion timer not running');
    console.log('PASS: sequential reveal and configured discussion timer');
    await host.locator('#start-vote').click();
    const voting = await state();
    const wolf = Object.values(voting.players).find(p => p.role === '人狼');
    for (const [id, page] of byId) {
      const target = id === wolf.id ? Object.keys(voting.players).find(x => x !== id) : wolf.id;
      await page.locator(`[data-target="${target}"]`).click();
    }
    await host.locator('#back-lobby').waitFor();
    if ((await state()).winner !== 'villager') throw new Error('Wrong result');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('PASS: synchronized voting and villager victory; no browser errors');
  } catch (error) {
    if (host && code) {
      console.error('Failure phase:', await host.evaluate(code => window.CWWRoom.getRoom(code).then(s => s?.phase), code).catch(() => 'unavailable'));
      await host.screenshot({ path: 'test-results/live-failure.png', fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    try {
      if (host && code) {
        await host.evaluate(async code => {
          const { getApp } = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js');
          const { getFirestore, doc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js');
          await deleteDoc(doc(getFirestore(getApp()), 'artifacts', window.CWW_APP_ID, 'public', 'data', 'rooms', code));
        }, code);
        console.log('CLEANUP: deleted only the new test room');
      }
    } finally {
      await browser.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
