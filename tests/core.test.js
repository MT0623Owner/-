const assert = require("node:assert/strict");
const Core = require("../game-core");

function roomWithPlayers(count = 4) {
  const state = Core.createRoom("TEST", "host");
  for (let index = 1; index <= count; index++) {
    Core.addOrUpdatePlayer(state, `p${index}`, `P${index}`);
  }
  state.settings = Core.normalizeSettings({
    wolfCount: 1,
    useSeer: count >= 4,
    inputSeconds: 30,
    discussionSeconds: 0,
    maxWeeks: 3,
    topic: "動物",
    constraint: "サバンナにいる",
    hint: "地"
  });
  return state;
}

function forceRoles(state, roles) {
  Object.values(state.players).forEach((player, index) => {
    player.role = roles[index];
    player.suspect = false;
  });
}

function startInputWeek(state, now = 1000) {
  Core.startWeek(state, now);
  Core.startInput(state, now + state.settings.inputSeconds * 1000);
}

{
  const state = roomWithPlayers(4);
  const validation = Core.validateStart({ ...state.settings, useSeer: true }, state.players);
  assert.equal(validation.ok, true);
}

{
  const state = roomWithPlayers(3);
  const validation = Core.validateStart({ ...state.settings, useSeer: true, hint: "" }, state.players);
  assert.equal(validation.ok, true);
}

{
  const settings = Core.normalizeSettings({});
  assert.equal(settings.hostParticipates, true);
  assert.equal(settings.hostName, "マスター");
  assert.equal(settings.topicMode, "manual");
  const disabled = Core.normalizeSettings({ hostParticipates: false, hostName: "進行役" });
  assert.equal(disabled.hostParticipates, false);
  assert.equal(disabled.hostName, "進行役");
  const external = Core.normalizeSettings({ topicMode: "external", aiModel: "gemini-test" });
  assert.equal(external.autoTopic, true);
  assert.equal(external.aiModel, "gemini-test");
  const retiredPreview = Core.normalizeSettings({ topicMode: "external", aiModel: "gemini-2.5-flash-preview-09-2025" });
  assert.equal(retiredPreview.aiModel, "gemini-3.5-flash-lite");
}

{
  const state = roomWithPlayers(4);
  const missingGenerated = Core.validateStart({ ...state.settings, topicMode: "external", topic: "", constraint: "", hint: "" }, state.players);
  assert.equal(missingGenerated.ok, false);
  const generated = Core.validateStart({ ...state.settings, topicMode: "external", topic: "動物", constraint: "赤い", hint: "色" }, state.players);
  assert.equal(generated.ok, true);
}

{
  const state = roomWithPlayers(3);
  Core.addOrUpdatePlayer(state, "p3", "P1");
  const validation = Core.validateStart(state.settings, state.players);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /同じ名前/);
}

{
  const state = roomWithPlayers(4);
  Core.assignRoles(state, () => 0);
  const roles = Object.values(state.players).map(player => player.role);
  assert.equal(roles.filter(role => role === Core.ROLES.WOLF).length, 1);
  assert.equal(roles.filter(role => role === Core.ROLES.SEER).length, 0);
  assert.ok(state.seerId);
  Core.startWeek(state, 1000);
  assert.equal(state.week, 1);
  assert.equal(Object.values(state.players).filter(player => player.role === Core.ROLES.SEER).length, 0);
  Core.startWeek(state, 2000);
  assert.equal(state.week, 2);
  assert.equal(state.players[state.seerId].role, Core.ROLES.SEER);
  assert.equal(state.seerRevealed, true);
}

{
  const state = roomWithPlayers(4);
  Core.assignRoles(state, () => 0);
  Core.startRoleCheck(state, 1000);
  assert.equal(state.phase, Core.PHASES.ROLE_CHECK);
  assert.throws(() => Core.startWeek(state, 1001), /役職確認/);
  Core.activeRoster(state.players).forEach((player, index) => {
    Core.confirmRole(state, player.id, 1002 + index);
  });
  assert.equal(Core.allRolesConfirmed(state), true);
  Core.startWeek(state, 1010);
  assert.equal(state.phase, Core.PHASES.THINK);
  Core.startInput(state, 1040);
  assert.equal(state.phase, Core.PHASES.INPUT);
}

{
  const state = roomWithPlayers(4);
  state.settings = Core.normalizeSettings({
    wolfCount: 1,
    useSeer: true,
    autoTopic: true,
    topic: "",
    constraint: "",
    hint: ""
  });
  const validation = Core.validateStart(state.settings, state.players);
  assert.equal(validation.ok, true);
  Core.assignRoles(state, () => 0);
  assert.equal(state.settings.topic, "動物");
  assert.equal(state.settings.constraint, "人間が手で抱えられる大きさのもの");
  assert.equal(state.settings.hint, "大きさ");
}

{
  const state = roomWithPlayers(4);
  state.settings = Core.normalizeSettings({
    wolfCount: 1,
    useSeer: true,
    topicMode: "external",
    topic: "植物",
    constraint: "赤い花を咲かせるもの",
    hint: "色"
  });
  Core.assignRoles(state, () => 0);
  assert.equal(state.settings.topic, "植物");
  assert.equal(state.settings.constraint, "赤い花を咲かせるもの");
}

{
  const generated = Core.generateTopicSet(() => 0.99);
  assert.ok(generated.topic);
  assert.ok(generated.constraint);
  assert.ok(generated.hint);
  const levelThree = Core.generateTopicSet(() => 0, 3);
  assert.equal(levelThree.topic, "ワンピースのキャラ");
  const preferred = Core.generateTopicSet(() => 0, 2, "漫画");
  assert.equal(preferred.topic, "漫画");
  assert.ok(preferred.constraint);
  const preferredKnown = Core.generateTopicSet(() => 0, 2, "偉人");
  assert.equal(preferredKnown.constraint, "ノーベル賞を受賞している人物");
  const cleaned = Core.sanitizeTopicSet({
    topic: "お題：動物",
    constraint: "制約: サバンナにいる",
    hint: "ヒント：場所"
  });
  assert.deepEqual(cleaned, {
    topic: "動物",
    constraint: "サバンナにいる",
    hint: "場所"
  });
}

{
  const state = roomWithPlayers(3);
  forceRoles(state, [Core.ROLES.WOLF, Core.ROLES.VILLAGER, Core.ROLES.VILLAGER]);
  startInputWeek(state, 1000);
  Core.submitHiddenWord(state, "p1", "ライオン", 40000);
  assert.equal(state.submissions.p1.word, "ライオン");
}

{
  const state = roomWithPlayers(3);
  forceRoles(state, [Core.ROLES.WOLF, Core.ROLES.VILLAGER, Core.ROLES.VILLAGER]);
  startInputWeek(state, 1000);
  Core.submitHiddenWord(state, "p1", "ライオン", 1001);
  Core.submitHiddenWord(state, "p2", "キリン", 1002);
  Core.submitHiddenWord(state, "p3", "ゾウ", 1003);
  Core.startReveal(state, 1004);
  revealCurrentWordAndConfirm(state, "p1", 1005);
  revealCurrentWordAndConfirm(state, "p2", 1006);
  revealCurrentWordAndConfirm(state, "p3", 1007);
  Core.startDiscussion(state, 1008);
  Core.startVote(state, false, 1009);
  Core.castVote(state, "p1", Core.SKIP_VOTE, 1010);
  Core.castVote(state, "p2", Core.SKIP_VOTE, 1011);
  Core.castVote(state, "p3", Core.SKIP_VOTE, 1012);
  resolveVotesAndConfirm(state, 1013);
  assert.equal(state.voteHistory[0].result, "スキップ");
  assert.equal(Core.activeRoster(state.players).some(player => player.suspect), false);
  assert.equal(state.phase, Core.PHASES.THINK);
  assert.equal(state.week, 2);
}

{
  const state = roomWithPlayers(3);
  forceRoles(state, [Core.ROLES.WOLF, Core.ROLES.VILLAGER, Core.ROLES.VILLAGER]);
  state.week = 2;
  Core.startVote(state, false, 1000);
  assert.throws(() => Core.castVote(state, "p1", Core.SKIP_VOTE, 1001), /スキップ/);
}

{
  const state = roomWithPlayers(3);
  forceRoles(state, [Core.ROLES.WOLF, Core.ROLES.VILLAGER, Core.ROLES.VILLAGER]);
  startInputWeek(state, 1000);
  Core.submitHiddenWord(state, "p1", "ライオン", 1001);
  Core.submitHiddenWord(state, "p2", " ライオン ", 1002);
  Core.submitHiddenWord(state, "p3", "ゾウ", 1003);
  assert.equal(Object.keys(state.submissions).length, 3);
  Core.startReveal(state, 1004);
  revealCurrentWordAndConfirm(state, "p1", 1005);
  revealCurrentWordAndConfirm(state, "p2", 1006);
  revealCurrentWordAndConfirm(state, "p3", 1007);
  Core.startDiscussion(state, 1008);
  Core.startVote(state, false, 1009);
  Core.castVote(state, "p1", "p2", 1010);
  Core.castVote(state, "p2", "p1", 1011);
  Core.castVote(state, "p3", "p1", 1012);
  resolveVotesAndConfirm(state, 1013);
  assert.equal(state.phase, Core.PHASES.RESULT);
  assert.equal(state.winner, "villager");
}

{
  const state = roomWithPlayers(3);
  forceRoles(state, [Core.ROLES.WOLF, Core.ROLES.VILLAGER, Core.ROLES.VILLAGER]);
  startInputWeek(state, 1000);
  Core.submitHiddenWord(state, "p1", "ライオン", 1001);
  Core.submitHiddenWord(state, "p2", "キリン", 1002);
  Core.submitHiddenWord(state, "p3", "ゾウ", 1003);
  Core.startReveal(state, 1004);
  revealCurrentWordAndConfirm(state, "p1", 1005);
  revealCurrentWordAndConfirm(state, "p2", 1006);
  revealCurrentWordAndConfirm(state, "p3", 1007);
  Core.startDiscussion(state, 1008);
  Core.startVote(state, false, 1009);
  Core.castVote(state, "p1", "p2", 1010);
  Core.castVote(state, "p2", "p3", 1011);
  Core.castVote(state, "p3", "p2", 1012);
  resolveVotesAndConfirm(state, 1013);
  assert.equal(state.players.p2.suspect, true);
  assert.equal(state.phase, Core.PHASES.FINAL_VOTE);
  assert.throws(() => Core.submitHiddenWord(state, "p2", "チーター", 1014), /伏せ入力の時間ではありません|容疑者/);
}

{
  const state = roomWithPlayers(4);
  forceRoles(state, [Core.ROLES.WOLF, Core.ROLES.VILLAGER, Core.ROLES.VILLAGER, Core.ROLES.VILLAGER]);
  startInputWeek(state, 1000);
  Core.submitHiddenWord(state, "p1", "ライオン", 1001);
  Core.submitHiddenWord(state, "p2", "キリン", 1002);
  Core.submitHiddenWord(state, "p3", "ゾウ", 1003);
  Core.submitHiddenWord(state, "p4", "カバ", 1004);
  Core.startReveal(state, 1005);
  revealCurrentWordAndConfirm(state, "p1", 1006);
  revealCurrentWordAndConfirm(state, "p2", 1007);
  revealCurrentWordAndConfirm(state, "p3", 1008);
  revealCurrentWordAndConfirm(state, "p4", 1009);
  Core.startDiscussion(state, 1010);
  Core.startVote(state, false, 1011);
  Core.castVote(state, "p1", "p2", 1012);
  Core.castVote(state, "p2", "p3", 1013);
  Core.castVote(state, "p3", "p2", 1014);
  Core.castVote(state, "p4", "p2", 1015);
  resolveVotesAndConfirm(state, 1016);
  assert.equal(state.phase, Core.PHASES.THINK);
  Core.startInput(state, 1017);
  assert.throws(() => Core.submitHiddenWord(state, "p1", "ライオン", 1017), /過去週/);
  Core.submitHiddenWord(state, "p1", "チーター", 1018);
}

{
  const state = roomWithPlayers(3);
  forceRoles(state, [Core.ROLES.WOLF, Core.ROLES.VILLAGER, Core.ROLES.VILLAGER]);
  state.players.p2.suspect = true;
  Core.startVote(state, true, 1000);
  Core.castVote(state, "p2", "p1", 1001);
  resolveVotesAndConfirm(state, 1002);
  assert.equal(state.phase, Core.PHASES.RESULT);
  assert.equal(state.winner, "villager");
}

console.log("core tests ok");

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
