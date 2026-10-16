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
  for (const id of state.revealOrder) revealCurrentWordAndConfirm(state, id, 40000);
  assert.equal(state.phase, Core.PHASES.DISCUSSION);
  assert.equal(state.discussionEndsAt, 100000);
});

test('suspect speech does not consume discussion time', () => {
  const state = revealRoom(true);
  for (const id of state.revealOrder) revealCurrentWordAndConfirm(state, id, 40000);
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

function revealCurrentWordAndConfirm(state, ...args) {
  Core.revealCurrentWord(state, ...args);
  const gate = state.presentation;
  for (const id of gate?.required || []) Core.confirmPresentation(state, id, gate.id, args.at(-1));
}

function resolveVotesAndConfirm(state, ...args) {
  Core.resolveVotes(state, ...args);
  const gate = state.presentation;
  for (const id of gate?.required || []) Core.confirmPresentation(state, id, gate.id, args.at(-1));
}

test('host can add a week once, including a pending final transition, but cannot undo a final vote',()=>{
 const C=require('../game-core'),s=C.createRoom('TEST','host');
 for(const id of ['host','p1','p2','p3']) C.addOrUpdatePlayer(s,id,id);
 s.players.host.role=C.ROLES.WOLF;s.phase=C.PHASES.PRESENTATION;s.week=3;s.settings.maxWeeks=3;
 s.presentation={id:'gate',next:{type:'finalVote'}};
 assert.throws(()=>C.extendWeeks(s,'p1',3),/マスター/);
 C.extendWeeks(s,'host',3);assert.equal(s.settings.maxWeeks,4);assert.equal(s.presentation.next.type,'nextWeek');
 C.extendWeeks(s,'host',3);assert.equal(s.settings.maxWeeks,4);
 s.phase=C.PHASES.FINAL_VOTE;s.presentation=null;assert.throws(()=>C.extendWeeks(s,'host',4),/今は/);
 s.phase=C.PHASES.INPUT;s.settings.maxWeeks=10;assert.throws(()=>C.extendWeeks(s,'host',10),/今は/);
});
test('week extension preserves population end condition and resetting clears private state but retains roster',()=>{
 const C=require('../game-core'),s=C.createRoom('TEST','host');for(const id of ['host','p1'])C.addOrUpdatePlayer(s,id,id);
 s.players.host.role=C.ROLES.WOLF;s.phase=C.PHASES.PRESENTATION;s.week=3;s.presentation={id:'gate',next:{type:'finalVote'}};
 C.extendWeeks(s,'host',3);assert.equal(s.presentation.next.type,'finalVote');
 s.settings.topicMode='local';s.logs=[{word:'秘密'}];assert.throws(()=>C.cancelGame(s,'p1'),/マスター/);
 C.cancelGame(s,'host');assert.equal(s.phase,'lobby');assert.equal(s.settings.topic,'');assert.equal(s.presentation,null);assert.deepEqual(s.logs,[]);assert.equal(Object.keys(s.players).length,2);assert.equal(s.players.host.role,'');assert.equal(s.roomCode,'TEST');
});
test('every local topic supports easy and standard independently of topic level',()=>{
 const C=require('../game-core');for(const item of C.TOPIC_BANK)for(const difficulty of ['easy','standard']){
 const result=C.generateTopicSet(()=>0,item.level||1,item.topic,difficulty);
 assert.ok(item.constraints.some(rule=>rule.constraint===result.constraint&&(rule.difficulty||'standard')===difficulty));
 }assert.equal(C.normalizeSettings({constraintDifficulty:'invalid'}).constraintDifficulty,'mixed');
});

test('narrow-topic toggle excludes only random narrow candidates and persists through reset',()=>{const C=require('../game-core');const narrow=C.TOPIC_BANK.filter(x=>x.narrow);assert.equal(narrow.length,5);assert.ok(narrow.every(x=>x.level===1));const all=new Set(),broad=new Set();for(let i=0;i<1000;i++){all.add(C.generateTopicSet(()=>i/1000,1,'','mixed',true).topic);broad.add(C.generateTopicSet(()=>i/1000,1,'','mixed',false).topic);}for(const x of narrow){assert.ok(all.has(x.topic));assert.ok(!broad.has(x.topic));assert.equal(C.generateTopicSet(()=>0,1,x.topic,'easy',false).topic,x.topic);}assert.equal(C.normalizeSettings({}).includeNarrowTopics,true);const s=C.createRoom('TEST','host');s.settings.includeNarrowTopics=false;C.resetGame(s);assert.equal(s.settings.includeNarrowTopics,false);for(const level of [2,3])assert.deepEqual(C.generateTopicSet(()=>0.5,level,'','mixed',false),C.generateTopicSet(()=>0.5,level,'','mixed',true));});
