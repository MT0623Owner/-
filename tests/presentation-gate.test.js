const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../game-core');

function game() {
  const state = Core.createRoom('TEST', 'host');
  for (const id of ['a', 'b', 'c']) {
    Core.addOrUpdatePlayer(state, id, id);
    state.players[id].role = id === 'c' ? Core.ROLES.WOLF : Core.ROLES.VILLAGER;
  }
  state.settings = Core.normalizeSettings({topic:'動物', constraint:'赤い', discussionSeconds:60, maxWeeks:3});
  Core.startWeek(state, 1000);
  Core.startInput(state, 2000);
  for (const id of ['a', 'b', 'c']) Core.submitHiddenWord(state, id, id, 3000);
  Core.startReveal(state, 4000);
  return state;
}

function acknowledgeAll(state, now) {
  const id = state.presentation.id;
  for (const player of ['host', 'a', 'b', 'c']) Core.confirmPresentation(state, player, id, now);
}

test('word reveals never wait for acknowledgements and the last reveal starts discussion', () => {
  const state = game();
  Core.revealCurrentWord(state, 'a', 5000);
  assert.equal(state.phase, 'reveal');
  assert.equal(state.presentation, null);
  Core.revealCurrentWord(state, 'b', 6000);
  Core.revealCurrentWord(state, 'c', 100000);
  assert.equal(state.phase, 'discussion');
  assert.equal(state.discussionEndsAt, 160000);
  assert.equal(state.logs.length, 3);
});

test('vote acknowledgement is idempotent, rejects outsiders and includes spectator master', () => {
  const state = game();
  Core.startVote(state);
  for (const id of ['a', 'b', 'c']) Core.castVote(state, id, Core.SKIP_VOTE);
  Core.resolveVotes(state);
  const id = state.presentation.id;
  assert.equal(Core.automaticAction(state, 999999, true), '');
  assert.throws(() => Core.startVote(state), /確認/);
  assert.throws(() => Core.startDiscussion(state), /確認/);
  Core.confirmPresentation(state, 'a', id, 6000);
  const once = JSON.stringify(state);
  Core.confirmPresentation(state, 'a', id, 7000);
  assert.equal(JSON.stringify(state), once);
  assert.throws(() => Core.confirmPresentation(state, 'stranger', id), /参加/);
  Core.confirmPresentation(state, 'b', id, 8000);
  Core.confirmPresentation(state, 'c', id, 9000);
  assert.equal(state.phase, 'presentation');
  Core.confirmPresentation(state, 'host', id, 10000);
  assert.equal(state.phase, 'think');
});

test('vote presentation delays the new week, and old confirmations cannot complete a later game', () => {
  const state = game();
  Core.startVote(state);
  for (const id of ['a','b','c']) Core.castVote(state, id, Core.SKIP_VOTE);
  Core.resolveVotes(state, 20000);
  assert.equal(state.phase, 'presentation');
  assert.equal(state.week, 1);
  const oldId = state.presentation.id;
  assert.throws(() => Core.startWeek(state), /確認/);
  acknowledgeAll(state, 100000);
  assert.equal(state.week, 2);
  assert.equal(state.thinkEndsAt, 130000);
  Core.resetGame(state);
  Core.startWeek(state);
  Core.startVote(state);
  for(const id of ['a','b','c']) Core.castVote(state,id,Core.SKIP_VOTE);
  Core.resolveVotes(state);
  assert.notEqual(state.presentation.id,oldId);
  Core.confirmPresentation(state,'host',oldId);
  assert.deepEqual(state.presentation.ready,{});
});

test('suspects must acknowledge; only the master may release a disconnected participant', () => {
  const state = game();
  Core.startVote(state);
  Core.castVote(state,'a','b'); Core.castVote(state,'b','a'); Core.castVote(state,'c','b');
  Core.resolveVotes(state);
  assert.equal(state.phase,'presentation');
  assert.equal(state.players.b.suspect,true);
  const id = state.presentation.id;
  for(const player of ['host','a','c']) Core.confirmPresentation(state,player,id);
  assert.equal(state.phase,'presentation');
  assert.throws(()=>Core.forcePresentation(state,'a',id),/マスター/);
  Core.forcePresentation(state,'host',id,100000);
  assert.equal(state.phase,'finalVote');
  Core.castVote(state,'b','c'); Core.resolveVotes(state);
  assert.equal(state.phase,'presentation');
  assert.equal(state.winner,'');
  acknowledgeAll(state,110000);
  assert.equal(state.phase,'result');
  assert.equal(state.winner,'villager');
});
