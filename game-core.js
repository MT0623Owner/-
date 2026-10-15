(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CWWCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  const ROLES = {
    WOLF: "人狼",
    VILLAGER: "村人",
    SEER: "占い師"
  };

  const PHASES = {
    LOBBY: "lobby",
    ROLE_CHECK: "roleCheck",
    PRESENTATION: "presentation",
    THINK: "think",
    INPUT: "input",
    REVEAL: "reveal",
    SUSPECT_TALK: "suspectTalk",
    DISCUSSION: "discussion",
    VOTE: "vote",
    FINAL_VOTE: "finalVote",
    RESULT: "result"
  };

  const SKIP_VOTE = "__skip__";
  const DEFAULT_AI_MODEL = "gemini-2.5-flash";

  const TEMPLATES = [
    { topic: "動物", constraint: "サバンナにいる", hint: "生息地" },
    { topic: "食べ物", constraint: "朝ごはんで出やすい", hint: "時間" },
    { topic: "乗り物", constraint: "空を移動できる", hint: "場所" },
    { topic: "スポーツ", constraint: "ボールを使う", hint: "道具" },
    { topic: "家電", constraint: "キッチンで使う", hint: "場所" },
    { topic: "職業", constraint: "夜に働くことがある", hint: "時間" },
    { topic: "場所", constraint: "入場料がかかることが多い", hint: "料金" },
    { topic: "飲み物", constraint: "温かくして飲める", hint: "温度" }
  ];

  const TOPIC_BANK = [
    {
      topic: "動物",
      constraints: [
        { constraint: "人間が手で抱えられる大きさのもの", hint: "大きさ" },
        { constraint: "野生のサバンナに生息しているもの", hint: "生息地" },
        { constraint: "水辺や水中で暮らすことが多いもの", hint: "場所" },
        { constraint: "空を飛ぶことができるもの", hint: "移動" },
        { constraint: "日本の家庭でペットとして飼われることがあるもの", hint: "飼育" }
      ]
    },
    {
      topic: "食べ物",
      constraints: [
        { constraint: "コンビニや一般的なスーパーに売っていないもの", hint: "入手難度" },
        { constraint: "手で持って食べやすいもの", hint: "食べ方" },
        { constraint: "冷たい状態で食べることが多いもの", hint: "温度" },
        { constraint: "赤い色の印象が強いもの", hint: "色" },
        { constraint: "祝い事や特別な日に食べることが多いもの", hint: "場面" }
      ]
    },
    {
      topic: "キャラクター",
      constraints: [
        { constraint: "人間ではないキャラクター", hint: "種族" },
        { constraint: "赤い要素が印象に残るキャラクター", hint: "色" },
        { constraint: "空を飛ぶ、または浮くイメージがあるキャラクター", hint: "移動" },
        { constraint: "道具や武器を持っている印象が強いキャラクター", hint: "持物" },
        { constraint: "子ども向け作品で広く知られているキャラクター", hint: "対象" }
      ]
    },
    {
      topic: "場所",
      constraints: [
        { constraint: "入場料や利用料がかかることが多い場所", hint: "料金" },
        { constraint: "屋外にあることが多い場所", hint: "屋外" },
        { constraint: "静かにすることが求められやすい場所", hint: "雰囲気" },
        { constraint: "旅行先として選ばれやすい場所", hint: "目的" },
        { constraint: "水に関係する場所", hint: "水" }
      ]
    },
    {
      topic: "乗り物",
      constraints: [
        { constraint: "空を移動できるもの", hint: "場所" },
        { constraint: "一人で乗ることが多いもの", hint: "人数" },
        { constraint: "免許が必要になることが多いもの", hint: "資格" },
        { constraint: "観光地で見かけやすいもの", hint: "用途" },
        { constraint: "電気で動くイメージが強いもの", hint: "動力" }
      ]
    },
    {
      topic: "スマホアプリ",
      constraints: [
        { constraint: "写真や動画を扱うことが中心のもの", hint: "機能" },
        { constraint: "位置情報を使うことが多いもの", hint: "位置" },
        { constraint: "毎日開く人が多いもの", hint: "頻度" },
        { constraint: "課金要素が目立つもの", hint: "料金" },
        { constraint: "誰かと連絡を取るために使うもの", hint: "交流" }
      ]
    },
    {
      topic: "道具",
      constraints: [
        { constraint: "切るために使うもの", hint: "用途" },
        { constraint: "学校や職場で使われやすいもの", hint: "場所" },
        { constraint: "金属でできている印象が強いもの", hint: "素材" },
        { constraint: "片手で持てるもの", hint: "大きさ" },
        { constraint: "掃除に関係するもの", hint: "用途" }
      ]
    },
    {
      topic: "偉人",
      constraints: [
        { constraint: "政治や国の運営に関わった人物", hint: "分野" },
        { constraint: "科学や発明で知られている人物", hint: "分野" },
        { constraint: "日本で広く知られている人物", hint: "地域" },
        { constraint: "紙幣や硬貨に関係する人物", hint: "お金" },
        { constraint: "戦いや争いの時代と結びつきが強い人物", hint: "時代" }
      ]
    },
    {
      level: 2,
      topic: "偉人",
      constraints: [
        { constraint: "ノーベル賞を受賞している人物", hint: "受賞" },
        { constraint: "本名より通称や芸名で知られている人物", hint: "名前" },
        { constraint: "20世紀以降に活躍した人物", hint: "時代" },
        { constraint: "発明や発見に関係する人物", hint: "分野" },
        { constraint: "複数の国や地域に影響を与えた人物", hint: "影響" }
      ]
    },
    {
      level: 2,
      topic: "国",
      constraints: [
        { constraint: "島国である", hint: "地形" },
        { constraint: "公用語が英語ではない", hint: "言語" },
        { constraint: "国旗に赤色が入っている", hint: "国旗" },
        { constraint: "サッカーが強い印象のある国", hint: "スポーツ" },
        { constraint: "日本から直行便で行きやすい国", hint: "距離" }
      ]
    },
    {
      level: 2,
      topic: "世界遺産",
      constraints: [
        { constraint: "自然遺産として知られているもの", hint: "分類" },
        { constraint: "ヨーロッパにあるもの", hint: "地域" },
        { constraint: "水に関係するもの", hint: "水" },
        { constraint: "宗教施設や信仰に関係するもの", hint: "信仰" },
        { constraint: "日本にあるもの", hint: "地域" }
      ]
    },
    {
      level: 2,
      topic: "映画",
      constraints: [
        { constraint: "実写ではなくアニメ作品である", hint: "表現" },
        { constraint: "宇宙や未来が重要な要素である", hint: "舞台" },
        { constraint: "シリーズ作品として続編がある", hint: "続編" },
        { constraint: "日本でも広く知られている洋画", hint: "地域" },
        { constraint: "家族や子どもも見やすい作品", hint: "対象" }
      ]
    },
    {
      level: 2,
      topic: "ゲーム",
      constraints: [
        { constraint: "任天堂のハードで遊べる印象が強いもの", hint: "機種" },
        { constraint: "対戦要素があるもの", hint: "遊び方" },
        { constraint: "冒険や探索が中心のもの", hint: "目的" },
        { constraint: "スマホでも遊べるもの", hint: "機種" },
        { constraint: "キャラクター育成が重要なもの", hint: "育成" }
      ]
    },
    {
      level: 3,
      topic: "ワンピースのキャラ",
      constraints: [
        { constraint: "海賊ではないキャラクター", hint: "所属" },
        { constraint: "悪魔の実の能力者である", hint: "能力" },
        { constraint: "麦わらの一味ではない", hint: "所属" },
        { constraint: "海軍や世界政府に関係する", hint: "所属" },
        { constraint: "初登場が新世界編より前のキャラクター", hint: "時期" }
      ]
    },
    {
      level: 3,
      topic: "ポケモン",
      constraints: [
        { constraint: "初代に登場するポケモン", hint: "世代" },
        { constraint: "進化するポケモン", hint: "進化" },
        { constraint: "伝説・幻ではないポケモン", hint: "分類" },
        { constraint: "水タイプを持つポケモン", hint: "タイプ" },
        { constraint: "人型ではない印象が強いポケモン", hint: "形" }
      ]
    },
    {
      level: 3,
      topic: "ジョジョのスタンド",
      constraints: [
        { constraint: "近距離パワー型の印象が強いスタンド", hint: "型" },
        { constraint: "時間や空間に関係する能力を持つスタンド", hint: "能力" },
        { constraint: "名前が音楽由来のスタンド", hint: "由来" },
        { constraint: "主人公側が使うスタンド", hint: "陣営" },
        { constraint: "人型のビジュアルが印象的なスタンド", hint: "形" }
      ]
    },
    {
      level: 3,
      topic: "ガンダムの機体",
      constraints: [
        { constraint: "主人公が搭乗する機体", hint: "搭乗者" },
        { constraint: "量産機として知られている機体", hint: "分類" },
        { constraint: "赤い印象が強い機体", hint: "色" },
        { constraint: "宇宙世紀作品に登場する機体", hint: "作品群" },
        { constraint: "変形や合体の印象がある機体", hint: "機構" }
      ]
    },
    {
      level: 3,
      topic: "日本の戦国武将",
      constraints: [
        { constraint: "天下統一に強く関係する人物", hint: "目的" },
        { constraint: "関ヶ原の戦いに関係する人物", hint: "戦い" },
        { constraint: "東北地方に関係が深い人物", hint: "地域" },
        { constraint: "女性ではない人物", hint: "性別" },
        { constraint: "城と結びつきが強い人物", hint: "拠点" }
      ]
    }
  ];

  const GENERIC_CONSTRAINTS = {
    1: [
      { constraint: "赤い要素があるもの", hint: "色" },
      { constraint: "手で持てるもの", hint: "大きさ" },
      { constraint: "家の中で見かけやすいもの", hint: "場所" },
      { constraint: "子どもにも知られているもの", hint: "認知度" },
      { constraint: "値段が高すぎないもの", hint: "価格" }
    ],
    2: [
      { constraint: "20世紀以降と関係が深いもの", hint: "時代" },
      { constraint: "日本国外との関係が強いもの", hint: "地域" },
      { constraint: "賞やランキングに関係しやすいもの", hint: "評価" },
      { constraint: "専門用語で語られやすいもの", hint: "知識" },
      { constraint: "学校で習う可能性があるもの", hint: "学習" }
    ],
    3: [
      { constraint: "主人公側ではないもの", hint: "立場" },
      { constraint: "初期から登場しているもの", hint: "時期" },
      { constraint: "特定の組織や勢力に属するもの", hint: "所属" },
      { constraint: "能力や特殊設定が重要なもの", hint: "能力" },
      { constraint: "名前や由来に元ネタがあるもの", hint: "由来" }
    ]
  };

  function defaultSettings() {
    return {
      wolfCount: 1,
      useSeer: false,
      inputSeconds: 30,
      discussionSeconds: 0,
      maxWeeks: 3,
      topicLevel: 1,
      hostParticipates: true,
      hostName: "マスター",
      topicMode: "manual",
      autoTopic: false,
      aiModel: DEFAULT_AI_MODEL,
      topic: "動物",
      constraint: "サバンナにいる",
      hint: "生息地"
    };
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function normalizeSettings(input) {
    const settings = { ...defaultSettings(), ...(input || {}) };
    settings.wolfCount = Math.floor(clamp(Number(settings.wolfCount) || 1, 1, 6));
    settings.useSeer = Boolean(settings.useSeer);
    settings.inputSeconds = clamp(Number(settings.inputSeconds) || 30, 10, 180);
    settings.discussionSeconds = clamp(Number(settings.discussionSeconds) || 0, 0, 600);
    settings.maxWeeks = Math.floor(clamp(Number(settings.maxWeeks) || 3, 1, 10));
    settings.topicLevel = Math.floor(clamp(Number(settings.topicLevel) || 1, 1, 3));
    settings.hostParticipates = input?.hostParticipates !== false;
    settings.hostName = String(settings.hostName || "マスター").trim() || "マスター";
    settings.topicMode = ["manual", "local", "external"].includes(input?.topicMode)
      ? input.topicMode
      : Boolean(input?.autoTopic) ? "local" : settings.topicMode;
    settings.autoTopic = settings.topicMode !== "manual";
    settings.aiModel = normalizeAiModel(settings.aiModel);
    settings.topic = String(settings.topic || "").trim();
    settings.constraint = String(settings.constraint || "").trim();
    settings.hint = String(settings.hint || "").trim();
    return settings;
  }

  function normalizeAiModel(model) {
    const value = String(model || DEFAULT_AI_MODEL).trim().replace(/^models\//, "");
    if (!value || value === "gemini-2.5-flash-preview-09-2025") return DEFAULT_AI_MODEL;
    return value;
  }

  function validateStart(settingsInput, playersInput) {
    const settings = normalizeSettings(settingsInput);
    const players = activeRoster(playersInput);
    const errors = [];
    const names = players.map(player => normalizeText(player.name));

    if (players.length < 3) errors.push("3人以上の参加者が必要です。");
    if (new Set(names).size !== names.length) errors.push("同じ名前の参加者がいます。");
    if (settings.wolfCount >= players.length) errors.push("人狼人数は参加者数未満にしてください。");
    const seerEligible = settings.useSeer && players.length >= 4;
    if (seerEligible && players.length - settings.wolfCount < 2) errors.push("占い師を入れるには村人陣営の枠が足りません。");
    if (settings.topicMode !== "local") {
      if (!settings.topic) errors.push("お題を入力してください。");
      if (!settings.constraint) errors.push("人狼の制約を入力してください。");
      if (seerEligible && !settings.hint) errors.push("占い師ヒントを入力してください。");
    }

    return { ok: errors.length === 0, errors, settings, players };
  }

  function createRoom(roomCode, hostId) {
    return {
      version: 7,
      roomCode,
      hostId,
      phase: PHASES.LOBBY,
      settings: defaultSettings(),
      players: {},
      week: 0,
      thinkEndsAt: null,
      inputEndsAt: null,
      discussionEndsAt: null,
      roleReady: {},
      thinkReady: {},
      seerId: "",
      seerRevealed: false,
      submissions: {},
      revealOrder: [],
      revealIndex: 0,
      logs: [],
      votes: {},
      voteHistory: [],
      presentation: null,
      presentationSequence: 0,
      winner: "",
      reason: "",
      updatedAt: Date.now()
    };
  }

  function addOrUpdatePlayer(state, playerId, name) {
    state.players[playerId] = {
      id: playerId,
      name: String(name || "").trim(),
      role: state.players[playerId]?.role || "",
      suspect: Boolean(state.players[playerId]?.suspect),
      joinedAt: state.players[playerId]?.joinedAt || Date.now(),
      active: true
    };
    state.updatedAt = Date.now();
    return state;
  }

  function activeRoster(playersMap) {
    return Object.values(playersMap || {}).filter(player => player && player.active !== false)
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || a.id.localeCompare(b.id));
  }

  function livingPlayers(state) {
    return activeRoster(state.players).filter(player => !player.suspect);
  }

  function suspectPlayers(state) {
    return activeRoster(state.players).filter(player => player.suspect);
  }

  function usedWordsBeforeWeek(state, week = state.week) {
    return new Set((state.logs || []).filter(log => log.week < week).map(log => log.normalized));
  }

  function assignRoles(state, random = Math.random) {
    requirePresentationComplete(state);
    if (state.settings?.topicMode === "local" || (state.settings?.autoTopic && !state.settings?.topicMode)) {
      state.settings = normalizeSettings({ ...state.settings, ...generateTopicSet(random, state.settings.topicLevel, state.settings.topic) });
    }
    const validation = validateStart(state.settings, state.players);
    if (!validation.ok) throw new Error(validation.errors.join("\n"));

    const roles = [];
    for (let index = 0; index < validation.settings.wolfCount; index++) roles.push(ROLES.WOLF);
    while (roles.length < validation.players.length) roles.push(ROLES.VILLAGER);

    shuffle(roles, random).forEach((role, index) => {
      state.players[validation.players[index].id].role = role;
      state.players[validation.players[index].id].suspect = false;
    });
    state.seerId = "";
    state.seerRevealed = false;
    if (validation.settings.useSeer && validation.players.length >= 4) {
      const candidates = validation.players.filter(player => state.players[player.id].role === ROLES.VILLAGER);
      if (candidates.length) {
        state.seerId = candidates[Math.floor(random() * candidates.length)].id;
      }
    }
    state.settings = validation.settings;
    state.week = 0;
    state.roleReady = {};
    state.logs = [];
    state.voteHistory = [];
    state.winner = "";
    state.reason = "";
    return state;
  }

  function startRoleCheck(state, now = Date.now()) {
    requirePresentationComplete(state);
    state.phase = PHASES.ROLE_CHECK;
    state.roleReady = {};
    state.thinkReady = {};
    state.submissions = {};
    state.revealOrder = [];
    state.revealIndex = 0;
    state.votes = {};
    state.thinkEndsAt = null;
    state.inputEndsAt = null;
    state.discussionEndsAt = null;
    state.updatedAt = now;
    return state;
  }

  function confirmRole(state, playerId, now = Date.now()) {
    if (state.phase !== PHASES.ROLE_CHECK) throw new Error("役職確認の時間ではありません。");
    if (!activeRoster(state.players).some(player => player.id === playerId)) throw new Error("参加者だけが確認できます。");
    state.roleReady[playerId] = true;
    state.updatedAt = now;
    return state;
  }

  function allRolesConfirmed(state) {
    const players = activeRoster(state.players);
    return players.length > 0 && players.every(player => state.roleReady?.[player.id]);
  }

  function startWeek(state, now = Date.now()) {
    requirePresentationComplete(state);
    if (state.phase === PHASES.ROLE_CHECK && !allRolesConfirmed(state)) throw new Error("全員の役職確認が終わっていません。");
    state.week += 1;
    revealSeerIfNeeded(state);
    state.phase = PHASES.THINK;
    state.thinkEndsAt = now + state.settings.inputSeconds * 1000;
    state.thinkReady = {};
    state.inputEndsAt = null;
    state.discussionEndsAt = null;
    state.submissions = {};
    state.revealOrder = livingPlayers(state).map(player => player.id);
    state.revealIndex = 0;
    state.votes = {};
    state.updatedAt = now;
    return state;
  }

  function startInput(state, now = Date.now()) {
    if (state.phase !== PHASES.THINK) throw new Error("思考時間の後だけ伏せ入力へ進めます。");
    state.phase = PHASES.INPUT;
    state.inputEndsAt = null;
    state.updatedAt = now;
    return state;
  }

  function allThinkingComplete(state) {
    const players = livingPlayers(state);
    return players.length > 0 && players.every(player => state.thinkReady?.[player.id]);
  }

  function completeThinking(state, playerId, week, deadline, now = Date.now()) {
    // A delayed tap from an earlier round must not complete a later round.
    if (state.phase !== PHASES.THINK || state.week !== week || state.thinkEndsAt !== deadline) return state;
    if (!livingPlayers(state).some(player => player.id === playerId)) throw new Error("今回ワードを入力する参加者だけが思考完了できます。");
    state.thinkReady ||= {};
    if (state.thinkReady[playerId]) return state;
    state.thinkReady[playerId] = true;
    state.updatedAt = now;
    if (allThinkingComplete(state)) return startInput(state, now);
    return state;
  }

  function automaticAction(state, now = Date.now(), host = false) {
    if (state.presentation) return "";
    if (state.phase === PHASES.THINK && (allThinkingComplete(state) || (state.thinkEndsAt && now >= state.thinkEndsAt))) return "input";
    if (state.phase === PHASES.INPUT && allLivingSubmitted(state)) return "reveal";
    if (!host) return "";
    if ([PHASES.VOTE, PHASES.FINAL_VOTE].includes(state.phase) && allVotesSubmitted(state)) return "resolve";
    if (state.phase === PHASES.DISCUSSION && state.discussionEndsAt && now >= state.discussionEndsAt) return "vote";
    return "";
  }

  function advanceAutomatically(state, expectedPhase, expectedWeek, now = Date.now(), host = false) {
    if (state.phase !== expectedPhase || state.week !== expectedWeek) return state;
    // Recheck the live transaction snapshot, including deadlines and completeness.
    const action = automaticAction(state, now, host);
    if (action === "input") return startInput(state, now);
    if (action === "reveal") return startReveal(state, now);
    if (action === "resolve") return resolveVotes(state, now);
    if (action === "vote") return startVote(state, false, now);
    return state;
  }

  function startFinalAccusation(state, now = Date.now()) {
    if (state.phase !== PHASES.DISCUSSION) throw new Error("話し合いの後に最終告発へ進めます。");
    if (!suspectPlayers(state).length) throw new Error("容疑者がいません。通常投票へ進んでください。");
    return startVote(state, true, now);
  }

  function resetGame(state, now = Date.now()) {
    requirePresentationComplete(state);
    const empty = createRoom(state.roomCode, state.hostId);
    const settings = normalizeSettings(state.settings);
    if (settings.autoTopic) { settings.topic = ""; settings.constraint = ""; settings.hint = ""; }
    Object.assign(state, empty, { settings, players: state.players, presentationSequence: state.presentationSequence || 0, updatedAt: now });
    Object.values(state.players).forEach(player => { player.role = ""; player.suspect = false; });
    return state;
  }

  function revealSeerIfNeeded(state) {
    if (!state.settings?.useSeer || !state.seerId || state.seerRevealed || state.week < 2) return state;
    const player = state.players[state.seerId];
    if (player && player.active !== false && player.role !== ROLES.WOLF) {
      player.role = ROLES.SEER;
      state.seerRevealed = true;
    }
    return state;
  }

  function submitHiddenWord(state, playerId, word, now = Date.now()) {
    if (state.phase !== PHASES.INPUT) throw new Error("伏せ入力の時間ではありません。");
    const player = state.players[playerId];
    if (!player || player.suspect) throw new Error("容疑者は伏せ入力できません。");
    if (!livingPlayers(state).some(item => item.id === playerId)) throw new Error("生存者だけが伏せ入力できます。");
    const normalized = normalizeText(word);
    if (!normalized) throw new Error("ワードを入力してください。");
    if (normalized === normalizeText(state.settings.topic)) throw new Error("お題そのものは入力できません。");
    if (normalized === normalizeText(state.settings.constraint)) throw new Error("制約そのものは入力できません。");
    if (usedWordsBeforeWeek(state).has(normalized)) throw new Error("過去週で公開済みのワードは使えません。");

    state.submissions[playerId] = {
      playerId,
      word: String(word).trim(),
      normalized,
      submittedAt: now,
      revealed: false
    };
    state.updatedAt = now;
    return state;
  }

  function allLivingSubmitted(state) {
    return livingPlayers(state).every(player => state.submissions[player.id]);
  }

  function startReveal(state, now = Date.now()) {
    if (state.phase !== PHASES.INPUT) throw new Error("伏せ入力後だけ開示できます。");
    const missing = livingPlayers(state).filter(player => !state.submissions[player.id]);
    if (missing.length) throw new Error(`未送信: ${missing.map(player => player.name).join(", ")}`);
    state.phase = PHASES.REVEAL;
    state.revealOrder = livingPlayers(state).map(player => player.id);
    state.revealIndex = 0;
    state.updatedAt = now;
    return state;
  }

  function currentRevealPlayer(state) {
    if (state.phase !== PHASES.REVEAL) return null;
    const id = state.revealOrder[state.revealIndex];
    return state.players[id] || null;
  }

  function revealCurrentWord(state, playerId, now = Date.now()) {
    const current = currentRevealPlayer(state);
    if (!current || current.id !== playerId) throw new Error("今はあなたの開示順ではありません。");
    const submission = state.submissions[playerId];
    if (!submission) throw new Error("伏せ入力が見つかりません。");

    submission.revealed = true;
    state.logs.push({
      id: `w${state.week}-${state.logs.length + 1}`,
      week: state.week,
      playerId,
      playerName: current.name,
      word: submission.word,
      normalized: submission.normalized,
      revealedAt: now
    });
    state.revealIndex += 1;

    const next = state.revealIndex < state.revealOrder.length ? "reveal"
      : suspectPlayers(state).length ? "suspectTalk" : "discussion";
    return beginPresentation(state, "word", { type: next }, now, { logId: state.logs.at(-1).id });
  }

  function startDiscussion(state, now = Date.now()) {
    requirePresentationComplete(state);
    state.phase = PHASES.DISCUSSION;
    state.discussionEndsAt = state.settings.discussionSeconds
      ? now + state.settings.discussionSeconds * 1000
      : null;
    state.votes = {};
    state.updatedAt = now;
    return state;
  }

  function startVote(state, final = false, now = Date.now()) {
    requirePresentationComplete(state);
    if (final) {
      const suspects = suspectPlayers(state);
      if (!suspects.length) return finishGame(state, "wolf", "解答権を持つ容疑者がいないため、人狼陣営の勝ちです。", now);
      state.phase = PHASES.FINAL_VOTE;
    } else {
      state.phase = PHASES.VOTE;
    }
    state.votes = {};
    state.updatedAt = now;
    return state;
  }

  function voteVoters(state) {
    if (state.phase === PHASES.FINAL_VOTE) return suspectPlayers(state);
    if (state.phase === PHASES.VOTE) return livingPlayers(state);
    return [];
  }

  function voteCandidates(state) {
    if (state.phase === PHASES.FINAL_VOTE || state.phase === PHASES.VOTE) return livingPlayers(state);
    return [];
  }

  function canSkipVote(state) {
    return state.phase === PHASES.VOTE && state.week === 1;
  }

  function castVote(state, voterId, targetId, now = Date.now()) {
    const voters = voteVoters(state);
    const candidates = voteCandidates(state);
    const skip = targetId === SKIP_VOTE;
    if (!voters.some(player => player.id === voterId)) throw new Error("投票権がありません。");
    if (skip && !canSkipVote(state)) throw new Error("スキップは1週目の通常投票でだけ選べます。");
    if (!skip && !candidates.some(player => player.id === targetId)) throw new Error("投票先が不正です。");
    if (!skip && state.phase === PHASES.VOTE && voterId === targetId && candidates.length > 1) throw new Error("通常投票では自分に投票できません。");
    state.votes[voterId] = targetId;
    state.updatedAt = now;
    return state;
  }

  function allVotesSubmitted(state) {
    const voters = voteVoters(state);
    return voters.length > 0 && voters.every(player => state.votes[player.id]);
  }

  function resolveVotes(state, now = Date.now()) {
    if (![PHASES.VOTE, PHASES.FINAL_VOTE].includes(state.phase)) throw new Error("投票中ではありません。");
    if (!allVotesSubmitted(state)) throw new Error("未投票の参加者がいます。");

    const final = state.phase === PHASES.FINAL_VOTE;
    const counts = {};
    Object.values(state.votes).forEach(targetId => {
      counts[targetId] = (counts[targetId] || 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const topCount = sorted[0][1];
    const top = sorted.filter(([, count]) => count === topCount).map(([id]) => id);
    const tied = top.length !== 1;
    const targetId = tied ? "" : top[0];
    const skipped = targetId === SKIP_VOTE;
    const target = state.players[targetId];

    state.voteHistory.push({
      week: state.week,
      final,
      result: tied ? "同数" : skipped ? "スキップ" : target.name,
      votes: Object.entries(state.votes).map(([voterId, votedId]) => ({
        voterId,
        voterName: state.players[voterId]?.name || "不明",
        targetId: votedId,
        targetName: votedId === SKIP_VOTE ? "スキップ" : state.players[votedId]?.name || "不明"
      }))
    });

    let next;
    if (final) {
      next = !tied && target.role === ROLES.WOLF
        ? { type: "result", winner: "villager", reason: "最終告発で人狼を告発できました。" }
        : { type: "result", winner: "wolf", reason: tied ? "最終告発で意見が割れました。" : "最終告発で人狼以外を告発しました。" };
    } else if (!tied && !skipped && target.role === ROLES.WOLF) {
      next = { type: "result", winner: "villager", reason: `${target.name}さんが人狼でした。` };
    } else {
      if (!tied && !skipped) target.suspect = true;
      next = { type: shouldForceFinal(state) ? "finalVote" : "nextWeek" };
    }
    return beginPresentation(state, "vote", next, now, { voteIndex: state.voteHistory.length - 1 });
  }

  function requirePresentationComplete(state) {
    if (state.presentation) throw new Error("全員の演出確認を待ってください。");
  }

  function beginPresentation(state, kind, next, now, detail) {
    state.presentationSequence = (state.presentationSequence || 0) + 1;
    state.presentation = {
      id: `${state.roomCode}-${state.presentationSequence}`,
      kind, next, ...detail,
      required: [...new Set([state.hostId, ...activeRoster(state.players).map(player => player.id)])],
      ready: {}
    };
    state.phase = PHASES.PRESENTATION;
    state.thinkEndsAt = null;
    state.inputEndsAt = null;
    state.discussionEndsAt = null;
    state.updatedAt = now;
    return state;
  }

  function confirmPresentation(state, playerId, eventId, now = Date.now()) {
    const event = state.presentation;
    if (!event || state.phase !== PHASES.PRESENTATION || event.id !== eventId) return state;
    if (!event.required.includes(playerId)) throw new Error("この演出の参加者だけが確認できます。");
    if (event.ready[playerId]) return state;
    event.ready[playerId] = true;
    state.updatedAt = now;
    if (event.required.every(id => event.ready[id])) return resumePresentation(state, now);
    return state;
  }

  function forcePresentation(state, actorId, eventId, now = Date.now()) {
    if (actorId !== state.hostId) throw new Error("マスターだけが確認待ちを解除できます。");
    if (!state.presentation || state.presentation.id !== eventId) return state;
    return resumePresentation(state, now);
  }

  function resumePresentation(state, now) {
    const next = state.presentation.next;
    state.presentation = null;
    if (next.type === "nextWeek") return startWeek(state, now);
    if (next.type === "discussion") return startDiscussion(state, now);
    if (next.type === "finalVote") return startVote(state, true, now);
    if (next.type === "result") return finishGame(state, next.winner, next.reason, now);
    state.phase = next.type === "suspectTalk" ? PHASES.SUSPECT_TALK : PHASES.REVEAL;
    state.updatedAt = now;
    return state;
  }

  function shouldForceFinal(state) {
    const living = livingPlayers(state);
    const livingWolves = living.filter(player => player.role === ROLES.WOLF).length;
    return state.week >= state.settings.maxWeeks || living.length <= livingWolves + 1;
  }

  function finishGame(state, winner, reason, now = Date.now()) {
    state.phase = PHASES.RESULT;
    state.winner = winner;
    state.reason = reason;
    state.updatedAt = now;
    return state;
  }

  function privateCard(state, playerId) {
    const player = state.players[playerId];
    if (!player) return null;
    const card = { topic: state.settings.topic, role: player.role, label: "制約", value: "なし" };
    if (player.role === ROLES.WOLF) {
      card.label = "あなたの制約";
      card.value = state.settings.constraint;
    }
    if (player.role === ROLES.SEER) {
      card.label = "占い師ヒント";
      card.value = state.settings.hint;
    }
    return card;
  }

  function generateTopicSet(random = Math.random, level = 1, preferredTopic = "") {
    const targetLevel = clamp(Number(level) || 1, 1, 3);
    const preferred = String(preferredTopic || "").trim();
    const preferredKey = normalizeText(preferred);
    let bank = TOPIC_BANK.filter(item => (item.level || 1) === targetLevel);

    if (preferredKey) {
      const exact = TOPIC_BANK.filter(item => normalizeText(item.topic) === preferredKey && (item.level || 1) === targetLevel);
      const fallbackExact = TOPIC_BANK.filter(item => normalizeText(item.topic) === preferredKey);
      if (exact.length) {
        bank = exact;
      } else if (fallbackExact.length) {
        bank = fallbackExact;
      } else {
        const generic = GENERIC_CONSTRAINTS[targetLevel] || GENERIC_CONSTRAINTS[1];
        const rule = generic[Math.floor(random() * generic.length)];
        return sanitizeTopicSet({ topic: preferred, constraint: rule.constraint, hint: rule.hint });
      }
    }

    if (!bank.length) bank = TOPIC_BANK;
    const topicItem = bank[Math.floor(random() * bank.length)];
    const rule = topicItem.constraints[Math.floor(random() * topicItem.constraints.length)];
    return sanitizeTopicSet({
      topic: topicItem.topic,
      constraint: rule.constraint,
      hint: rule.hint
    });
  }

  function sanitizeTopicSet(set) {
    const topic = stripPrefix(set.topic);
    const constraint = stripPrefix(set.constraint);
    const hint = stripPrefix(set.hint);
    if (!topic || !constraint || !hint) {
      throw new Error("お題セットの生成に失敗しました。");
    }
    return { topic, constraint, hint };
  }

  function stripPrefix(value) {
    return String(value || "")
      .replace(/^(お題|おだい|テーマ|topic|カテゴリ|category|制約|せいやく|条件|制限|constraint|ヒント|ひんと|hint)[:：\s]+/i, "")
      .trim();
  }

  function clone(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function shuffle(values, random) {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  }

  return {
    ROLES,
    PHASES,
    SKIP_VOTE,
    TEMPLATES,
    TOPIC_BANK,
    defaultSettings,
    normalizeText,
    normalizeSettings,
    normalizeAiModel,
    validateStart,
    createRoom,
    addOrUpdatePlayer,
    activeRoster,
    livingPlayers,
    suspectPlayers,
    usedWordsBeforeWeek,
    assignRoles,
    startRoleCheck,
    confirmRole,
    allRolesConfirmed,
    startWeek,
    startInput,
    allThinkingComplete,
    completeThinking,
    automaticAction,
    advanceAutomatically,
    startFinalAccusation,
    resetGame,
    submitHiddenWord,
    allLivingSubmitted,
    startReveal,
    currentRevealPlayer,
    revealCurrentWord,
    startDiscussion,
    startVote,
    voteVoters,
    voteCandidates,
    canSkipVote,
    castVote,
    allVotesSubmitted,
    resolveVotes,
    confirmPresentation,
    forcePresentation,
    shouldForceFinal,
    privateCard,
    generateTopicSet,
    sanitizeTopicSet,
    clone
  };
});
