const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadSync(initial) {
  let saved = initial;
  let writes = 0;
  const snapshot = () => ({ exists: () => saved !== undefined, data: () => structuredClone(saved) });
  const window = { CWW_FIREBASE_CONFIG: { apiKey: 'fixture', projectId: 'fixture' }, dispatchEvent() {} };
  const context = {
    window, CustomEvent: class {},
    initializeApp() {}, getAuth() {}, getFirestore() {}, doc: (...args) => args,
    onAuthStateChanged: (_auth, cb) => cb({ uid: 'host' }), signInAnonymously: async () => {},
    getDoc: async () => snapshot(), onSnapshot() {},
    setDoc: async (_ref, next) => { saved = next; writes++; },
    runTransaction: async (_db, operation) => operation({
      get: async () => snapshot(),
      set: (_ref, next) => { saved = next; writes++; }
    })
  };
  const source = fs.readFileSync(require.resolve('../room-sync.js'), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(source, context);
  return { api: window.CWWRoom, saved: () => saved, writes: () => writes };
}

test('creating an occupied code does not overwrite its players', async () => {
  const sync = loadSync({ roomCode: 'TEST', hostId: 'original', players: { p1: { name: '既存' } } });
  assert.equal(await sync.api.createRoom({ roomCode: 'TEST', hostId: 'new' }), false);
  assert.equal(sync.writes(), 0);
  assert.equal(sync.saved().hostId, 'original');
});

test('creating a free code commits the new room', async () => {
  const sync = loadSync();
  assert.equal(await sync.api.createRoom({ roomCode: 'FREE', hostId: 'host' }), true);
  assert.equal(sync.writes(), 1);
  assert.equal(sync.saved().roomCode, 'FREE');
});

test('a stale phase transition does not write unchanged room data', async () => {
  const sync = loadSync({ roomCode: 'TEST', phase: 'reveal' });
  await sync.api.mutateRoom('TEST', state => state);
  assert.equal(sync.writes(), 0);
  await sync.api.mutateRoom('TEST', state => ({ ...state, phase: 'discussion' }));
  assert.equal(sync.writes(), 1);
});
