const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../game-core');

function revealRoom(suspect = false) {
  const state = Core.createRoom('TEST', 'host');
  for (const id of ['a', 'b', 'c', 'd']) Core.addOrUpdatePlayer(state, id, id);
  state.settings = Core.normalizeSettings({ topic: '動物', constraint: '赤い', discussionSeconds: 60 });
  state.players.d.suspect = suspect;
  Core.startWeek(state, 1000);
  Core.startInput(state, 31000);
  for (const player of Core.livingPlayers(state)) Core.submitHiddenWord(state, player.id, player.id, 32000);
  Core.startReveal(state, 33000);
  return state;
}

test('last reveal starts the configured discussion timer', () => {
  const state = revealRoom();
  for (const id of state.revealOrder) Core.revealCurrentWord(state, id, 40000);
  assert.equal(state.phase, Core.PHASES.DISCUSSION);
  assert.equal(state.discussionEndsAt, 100000);
});

test('suspect speech does not consume discussion time', () => {
  const state = revealRoom(true);
  for (const id of state.revealOrder) Core.revealCurrentWord(state, id, 40000);
  assert.equal(state.phase, Core.PHASES.SUSPECT_TALK);
  assert.equal(state.discussionEndsAt, null);
  Core.startDiscussion(state, 90000);
  assert.equal(state.discussionEndsAt, 150000);
});

test('fractional player counts and rounds normalize to integers', () => {
  const settings = Core.normalizeSettings({ wolfCount: 1.5, maxWeeks: 2.5, topicLevel: 1.5 });
  assert.equal(settings.wolfCount, 1);
  assert.equal(settings.maxWeeks, 2);
  assert.equal(settings.topicLevel, 1);
});

function thinkingRoom() {
  const state = Core.createRoom('TEST', 'host');
  for (const id of ['a', 'b', 'c', 'd']) Core.addOrUpdatePlayer(state, id, id);
  state.players.d.suspect = true;
  Core.startWeek(state, 1000);
  return state;
}

test('thinking completes only for all living players, excludes host spectators and suspects', () => {
  const state = thinkingRoom();
  const deadline = state.thinkEndsAt;
  assert.throws(() => Core.completeThinking(state, 'host', 1, deadline), /参加者だけ/);
  assert.throws(() => Core.completeThinking(state, 'd', 1, deadline), /参加者だけ/);
  Core.completeThinking(state, 'a', 1, deadline, 2000);
  Core.completeThinking(state, 'b', 1, deadline, 2100);
  assert.equal(state.phase, 'think');
  const before = JSON.stringify(state);
  Core.completeThinking(state, 'a', 1, deadline, 2200);
  assert.equal(JSON.stringify(state), before);
  Core.completeThinking(state, 'c', 1, deadline, 2300);
  assert.equal(state.phase, 'input');
});

test('new round resets readiness and stale completion cannot skip it', () => {
  const state = thinkingRoom();
  const deadline = state.thinkEndsAt;
  Core.completeThinking(state, 'a', 1, deadline, 2000);
  Core.startWeek(state, 40000);
  assert.deepEqual(state.thinkReady, {});
  Core.completeThinking(state, 'a', 1, deadline, 41000);
  assert.deepEqual(state.thinkReady, {});
  Core.completeThinking(state, 'a', 2, deadline, 41000);
  assert.deepEqual(state.thinkReady, {});
  Core.advanceAutomatically(state, 'think', 1, 99999, true);
  assert.equal(state.phase, 'think');
  Core.advanceAutomatically(state, 'think', 2, state.thinkEndsAt, false);
  assert.equal(state.phase, 'input');
});

test('legacy rooms without readiness still time out, replay clears readiness and roles', () => {
  const state = thinkingRoom();
  delete state.thinkReady;
  Core.completeThinking(state, 'a', 1, state.thinkEndsAt, 2000);
  assert.equal(state.thinkReady.a, true);
  Core.advanceAutomatically(state, 'think', 1, state.thinkEndsAt, false);
  assert.equal(state.phase, 'input');
  state.players.a.role = '占い師';
  state.settings.autoTopic = true;
  state.settings.topicMode = 'local';
  Core.resetGame(state, 100000);
  assert.equal(state.phase, 'lobby');
  assert.equal(Object.keys(state.players).length, 4);
  assert.deepEqual(state.thinkReady, {});
  assert.equal(state.players.a.role, '');
  assert.equal(state.players.d.suspect, false);
  assert.equal(state.settings.hint, '');
});

test('manual final accusation rejects no suspects without ending the game', () => {
  const state = thinkingRoom();
  state.players.d.suspect = false;
  Core.startDiscussion(state);
  assert.throws(() => Core.startFinalAccusation(state), /通常投票/);
  assert.equal(state.phase, 'discussion');
  state.players.d.suspect = true;
  Core.startFinalAccusation(state);
  assert.equal(state.phase, 'finalVote');
});

test('automatic transitions recheck current deadlines and voting snapshots', () => {
  const state = thinkingRoom();
  Core.advanceAutomatically(state, 'think', 1, 1500, true);
  assert.equal(state.phase, 'think');
  Core.startDiscussion(state, 2000);
  state.discussionEndsAt = 3000;
  Core.advanceAutomatically(state, 'discussion', 1, 4000, false);
  assert.equal(state.phase, 'discussion');
  Core.advanceAutomatically(state, 'discussion', 1, 4000, true);
  assert.equal(state.phase, 'vote');
  Core.advanceAutomatically(state, 'discussion', 1, 4000, true);
  assert.equal(state.phase, 'vote');
  Core.advanceAutomatically(state, 'vote', 1, 4000, true);
  assert.equal(state.phase, 'vote');
  assert.equal(state.voteHistory.length, 0);
});
