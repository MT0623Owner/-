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
