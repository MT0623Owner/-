(() => {
  const Core = window.CWWCore;
  let Room = null;
  let mode = "";
  let roomCode = "";
  let room = null;
  let unsubscribe = null;
  let hostDraftSettings = null;
  let busy = false;
  let syncingRoom = false;
  let wakeLock = null;
  let wakeLockRequesting = false;
  let subscriptionGeneration = 0;
  let roomUpdateCount = 0;
  let lastHelpRole = "";
  let lastHelpSuspect = false;
  let helpContentKey = "";

  const SESSION_KEY = "cww.lastSession.v1";
  const GEMINI_API_KEY = "cww.geminiApiKey.session";
  const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
  const GEMINI_MODEL_FALLBACKS = [
    DEFAULT_GEMINI_MODEL,
    "gemini-3.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-flash-latest"
  ];
  const GEMINI_TIMEOUT_MS = 15000;
  const CONNECTION_WAIT_MS = 15000;
  const $ = selector => document.querySelector(selector);

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    Room = await waitForRoomApi();
    bindStaticEvents();
    window.CWWPresentation.init({ confirm: id => mutate(state => Core.confirmPresentation(state, Room.userId, id)), force: id => mutate(state => Core.forcePresentation(state, Room.userId, id)) });
    bindLifecycleEvents();
    renderConfigState();
    setInterval(tick, 500);
    const query = new URLSearchParams(location.search);
    const code = query.get("room");
    if (code) $("#join-code").value = code.toUpperCase();
    renderSavedSession();
  }

  function waitForRoomApi() {
    if (window.CWWRoom) return Promise.resolve(window.CWWRoom);
    return new Promise(resolve => {
      window.addEventListener("cww-room-ready", () => resolve(window.CWWRoom), { once: true });
    });
  }

  function bindStaticEvents() {
    $("#create-room-button").addEventListener("click", createHostRoom);
    $("#join-room-button").addEventListener("click", joinRoom);
    $("#resume-room-button").addEventListener("click", resumeSavedSession);
    $("#forget-room-button").addEventListener("click", forgetSavedSession);
    $("#copy-room-link").addEventListener("click", copyRoomLink);
    $("#close-rules").addEventListener("click", () => { window.CWWPresentation.complete(); $("#rules-dialog").close(); });
    document.body.addEventListener("click", event => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "invite") $("#invite-dialog").showModal();
      if (action === "close-invite") $("#invite-dialog").close();
      if (action === "leave") leaveRoom();
      if (action === "sync") recoverRoomConnection();
      if (action === "show-effect") window.CWWPresentation.reopen();
      if (action === "reload") location.reload();
      if (action === "help") {
        // Safari does not focus buttons on pointer clicks. Give the dialog a
        // stable return target so closing it never jumps back to a text field.
        event.target.closest("[data-action]").focus({ preventScroll: true });
        openRulesHelp();
      }
      if (action === "finish-effects") window.CWWPresentation.complete();
      if (action === "toggle-card") {
        const card = event.target.closest(".private-card");
        const expanded = card.classList.toggle("card-expanded");
        const button = card.querySelector("[data-action='toggle-card']");
        button.setAttribute("aria-expanded", String(expanded));
        button.textContent = expanded ? "カードを閉じる" : "カードを開く";
      }
    });
  }

  function bindLifecycleEvents() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") recoverRoomConnection();
    });
    window.addEventListener("focus", recoverRoomConnection);
    window.addEventListener("online", recoverRoomConnection);
    window.addEventListener("pageshow", recoverRoomConnection);
  }

  function renderConfigState() {
    const warning = $("#config-warning");
    const disabled = !Room.configured;
    $("#create-room-button").disabled = disabled;
    $("#join-room-button").disabled = disabled;
    warning.classList.toggle("hidden", !disabled);
    if (disabled) {
      warning.innerHTML = `
        <strong>Firebase設定が未投入です。</strong><br>
        GitHub Pagesで部屋コード同期を使うには、<code>firebase-config.js</code> に Firebase Web config を設定してください。
      `;
    }
  }

  function readSavedSession() {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (!session || !/^[A-Z0-9]{4}$/.test(session.roomCode || "")) return null;
      return session;
    } catch (_) {
      return null;
    }
  }

  function storageValue(storage, method, key, value) {
    try {
      return window[storage][method](key, value);
    } catch (_) {
      // Storage can be disabled by the browser; playing must remain possible.
      return null;
    }
  }

  function saveSession(session) {
    storageValue("localStorage", "setItem", SESSION_KEY, JSON.stringify({
      mode: session.mode,
      roomCode: session.roomCode,
      name: session.name || "",
      savedAt: Date.now()
    }));
    renderSavedSession();
  }

  function clearSavedSession() {
    storageValue("localStorage", "removeItem", SESSION_KEY);
    renderSavedSession();
  }

  function forgetSavedSession() {
    clearSavedSession();
    $("#join-code").value = "";
    showToast("保存した部屋情報を削除しました。");
  }

  function renderSavedSession() {
    const panel = $("#resume-panel");
    if (!panel) return;
    const session = readSavedSession();
    panel.classList.toggle("hidden", !session);
    if (!session) return;
    const modeLabel = session.mode === "host" ? "マスター" : "参加者";
    $("#resume-room-summary").textContent = `${session.roomCode} / ${modeLabel}${session.name ? ` / ${session.name}` : ""}`;
    if (!mode && !$("#join-code").value) $("#join-code").value = session.roomCode;
    if (!mode && session.name && !$("#join-name").value) $("#join-name").value = session.name;
  }

  async function resumeSavedSession() {
    const session = readSavedSession();
    if (!session) return showToast("保存された部屋情報がありません。");
    await enterRoomByCode(session.roomCode, session.name || "", true);
  }

  async function createHostRoom() {
    await run(async () => {
      await Room.ready();
      const hostId = Room.userId;
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = generateRoomCode();
        if (!await Room.createRoom(Core.createRoom(code, hostId))) continue;
        saveSession({ mode: "host", roomCode: code, name: "マスター" });
        enterHostScreen(code);
        return;
      }
      throw new Error("部屋コードの作成に失敗しました。もう一度試してください。");
    });
  }

  function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  async function joinRoom() {
    const code = $("#join-code").value.trim().toUpperCase();
    const name = $("#join-name").value.trim();
    if (!/^[A-Z0-9]{4}$/.test(code)) return showToast("4文字の部屋コードを入力してください。");
    await enterRoomByCode(code, name, false);
  }

  async function enterRoomByCode(code, name, fromCache) {
    await run(async () => {
      await Room.ready();
      const exists = await Room.getRoom(code);
      if (!exists) throw new Error("部屋が見つかりません。コードを確認してください。");

      if (exists.hostId === Room.userId) {
        saveSession({ mode: "host", roomCode: code, name: "マスター" });
        enterHostScreen(code);
        return;
      }

      const existingSelf = exists.players?.[Room.userId];
      if (existingSelf && existingSelf.active !== false) {
        saveSession({ mode: "player", roomCode: code, name: existingSelf.name || name });
        enterPlayerScreen(code);
        return;
      }

      if (!name) throw new Error(fromCache ? "保存された名前がありません。名前を入力して参加してください。" : "名前を入力してください。");
      await Room.mutateRoom(code, state => {
        if (state.phase !== Core.PHASES.LOBBY) throw new Error("この部屋はすでに開始しています。");
        const duplicate = Core.activeRoster(state.players).some(player => {
          return player.id !== Room.userId && Core.normalizeText(player.name) === Core.normalizeText(name);
        });
        if (duplicate) throw new Error("同じ名前の参加者がいます。別名にしてください。");
        return Core.addOrUpdatePlayer(state, Room.userId, name);
      });
      saveSession({ mode: "player", roomCode: code, name });
      enterPlayerScreen(code);
    });
  }

  function enterHostScreen(code) {
    mode = "host";
    roomCode = code;
    subscribe(code);
    history.replaceState(null, "", `?room=${code}`);
    renderRoomInvite(code);
    showScreen("screen-host");
    updateWakeLock();
  }

  function enterPlayerScreen(code) {
    mode = "player";
    roomCode = code;
    subscribe(code);
    history.replaceState(null, "", `?room=${code}`);
    showScreen("screen-player");
    updateWakeLock();
  }

  function subscribe(code) {
    if (unsubscribe) unsubscribe();
    const generation = ++subscriptionGeneration;
    unsubscribe = Room.subscribe(code, next => {
      if (generation !== subscriptionGeneration) return;
      if (!next) {
        showToast("部屋が見つからなくなりました。");
        clearSavedSession();
        leaveRoom(false);
        return;
      }
      roomUpdateCount++;
      room = next;
      renderRoom();
      updateWakeLock();
    }, error => {
      if (generation !== subscriptionGeneration) return;
      showToast(error.message);
      unsubscribe = null;
      setTimeout(() => {
        if (generation === subscriptionGeneration) recoverRoomConnection();
      }, 1200);
    });
  }

  function leaveRoom(clearUrl = true) {
    $("#invite-dialog").close();
    window.CWWPresentation.reset();
    $("#rules-dialog").close();
    lastHelpRole = "";
    lastHelpSuspect = false;
    helpContentKey = "";
    subscriptionGeneration++;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    mode = "";
    roomCode = "";
    room = null;
    hostDraftSettings = null;
    releaseWakeLock();
    if (clearUrl) history.replaceState(null, "", location.pathname);
    showScreen("screen-home");
    renderSavedSession();
  }

  async function recoverRoomConnection() {
    if (!Room?.configured || !mode || !roomCode || document.visibilityState === "hidden" || syncingRoom) return;
    syncingRoom = true;
    const code = roomCode;
    const generation = subscriptionGeneration;
    const updateCount = roomUpdateCount;
    $("#effect-network").textContent = "最新の状態を確認中…";
    try {
      const latest = await withReadTimeout(async () => {
        await Room.ready();
        return Room.getRoom(code);
      });
      if (generation !== subscriptionGeneration || code !== roomCode || !mode) return;
      if (updateCount !== roomUpdateCount) { $("#effect-network").textContent = ""; return; }
      if (!latest) {
        showToast("部屋が見つからなくなりました。");
        clearSavedSession();
        leaveRoom(false);
        return;
      }
      roomUpdateCount++;
      room = latest;
      renderRoom();
      $("#effect-network").textContent = "";
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      subscribe(roomCode);
      updateWakeLock();
    } catch (error) {
      if (generation === subscriptionGeneration) {
        const message = `接続の復帰に失敗しました。通信状態を確認してください。${error.message ? ` (${error.message})` : ""}`;
        showToast(message);
        $("#effect-network").textContent = message;
      }
    } finally {
      syncingRoom = false;
    }
  }

  async function withReadTimeout(task) {
    let timeout;
    try {
      return await Promise.race([
        Promise.resolve().then(task),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("再同期が時間切れになりました。もう一度再同期するか、画面を再読み込みしてください。")), CONNECTION_WAIT_MS);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function updateWakeLock() {
    if (!shouldKeepScreenAwake()) {
      releaseWakeLock();
      return;
    }
    if (wakeLock || wakeLockRequesting || !navigator.wakeLock || document.visibilityState !== "visible") return;
    wakeLockRequesting = true;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (!shouldKeepScreenAwake()) {
        await lock.release().catch(() => {});
        return;
      }
      wakeLock = lock;
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch (_) {
      wakeLock = null;
    } finally {
      wakeLockRequesting = false;
    }
  }

  function shouldKeepScreenAwake() {
    return Boolean(mode && roomCode && room && room.phase !== Core.PHASES.RESULT);
  }

  function releaseWakeLock() {
    wakeLockRequesting = false;
    if (!wakeLock) return;
    const lock = wakeLock;
    wakeLock = null;
    lock.release?.().catch(() => {});
  }

  function renderRoom() {
    if (!room) return;
    const count = Core.activeRoster(room.players).filter(p => p.id !== room.hostId).length + Number(hostDraftSettings?.hostParticipates ?? room.settings.hostParticipates);
    if (count >= 3 && $("#toast").textContent.includes("3人以上")) hideToast();
    const shell = $(".app-shell");
    const phaseChanged = shell.dataset.phase !== room.phase;
    if (phaseChanged) {
      const focused = document.activeElement;
      if (focused?.matches("input, textarea, select")) focused.blur();
      shell.dataset.phase = room.phase;
      document.querySelectorAll(".private-card").forEach(card => card.classList.remove("card-expanded"));
    }
    shell.dataset.compare = String([Core.PHASES.SUSPECT_TALK, Core.PHASES.DISCUSSION, Core.PHASES.VOTE, Core.PHASES.FINAL_VOTE].includes(room.phase));
    if (mode === "host") renderHost();
    if (mode === "player") renderPlayer();
    if (!room.presentation) updateRulesHelp();
    window.CWWPresentation.update(presentationView());
    renderBusyState();
    updateWakeLock();
    if (phaseChanged && shell.dataset.compare === "true" && !$("#rules-dialog").open) {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }

  function helpContext() {
    const playing = room && room.phase !== Core.PHASES.LOBBY && room.phase !== Core.PHASES.RESULT;
    const me = playing ? room.players[Room.userId] : null;
    return {
      role: me?.active !== false ? me?.role || "" : "",
      suspect: Boolean(me?.active !== false && me?.suspect),
      master: mode === "host"
    };
  }

  function presentationView() {
    const me = room.players[Room.userId];
    return {
      code: roomCode, host: mode === "host", phase: room.phase, week: room.week,
      presentation: room.presentation ? { id: room.presentation.id, kind: room.presentation.kind, logId: room.presentation.logId, voteIndex: room.presentation.voteIndex, selfReady: Boolean(room.presentation.ready[Room.userId]), eligible: room.presentation.required.includes(Room.userId), total: room.presentation.required.length, waiting: room.presentation.required.filter(id => !room.presentation.ready[id]).map(id => room.players[id]?.name || "マスター") } : null,
      maxWeeks: room.settings.maxWeeks,
      me: { role: me?.role || "", suspect: Boolean(me?.suspect) },
      suspects: Core.suspectPlayers(room).map(player => player.id),
      logs: (room.logs || []).map(({ id, week, playerId, playerName, word }) => ({ id, week, playerId, playerName, word })),
      voteHistory: (room.voteHistory || []).map(({ week, final, result, votes }) => ({ week, final, result, votes: votes.map(({ targetId, targetName }) => ({ targetId, targetName })) }))
    };
  }

  function resultPresentation() {
    if (room.phase !== Core.PHASES.RESULT) return "";
    return window.CWWPresentation.results({
      constraint: room.settings.constraint,
      players: Core.activeRoster(room.players).map(({ id, name, role }) => ({ id, name, role })),
      logs: presentationView().logs
    });
  }

  function openRulesHelp() {
    renderRulesHelp(helpContext());
    const dialog = $("#rules-dialog");
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    $("#rules-title").focus({ preventScroll: true });
  }

  function updateRulesHelp() {
    const context = helpContext();
    const changedRole = context.role && context.role !== lastHelpRole;
    const becameSuspect = context.suspect && !lastHelpSuspect;
    // Track only this participant's visible role, never the hidden seer assignment.
    if (!context.role && lastHelpRole) $("#rules-dialog").close();
    lastHelpRole = context.role;
    lastHelpSuspect = context.suspect;
    if (changedRole || becameSuspect) openRulesHelp();
    else if ($("#rules-dialog").open) renderRulesHelp(context);
  }

  function renderRulesHelp(context) {
    const key = JSON.stringify(context);
    if (key === helpContentKey) return;
    helpContentKey = key;
    $("#rules-title").textContent = context.role
      ? `あなたの役割：${context.role}${context.suspect ? "・容疑者" : ""}`
      : "ルール・遊び方";
    const roles = {
      [Core.ROLES.VILLAGER]: { side: "村人陣営", goal: "ワードを見比べて人狼を探す", action: "お題に沿うワードを自由に選び、共通点を推理します。", forbid: "過去の公開ワードの再使用・占い師の名乗りは禁止", note: "同じ週で偶然かぶるのはOKです。占い師の偽名乗りも、全員禁止です。" },
      [Core.ROLES.WOLF]: { side: "人狼陣営", goal: "お題と制約の両方に合うワードを出す", action: "自分のカードの制約を守り、特定されないように話し合います。", forbid: "制約違反・過去の公開ワードの再使用は禁止", note: "占い師の名乗り・偽名乗りも、ゲーム終了まで全員禁止です。" },
      [Core.ROLES.SEER]: { side: "村人陣営", goal: "ヒントを自分の推理・ワード選び・投票に使う", action: "公開ワードを根拠に、自分の気づきとして推理を話せます。", forbid: "名乗り・カード提示・ヒントの公開は禁止", note: "ヒントを言い換えて秘密の情報として教えることも禁止。ゲーム終了まで守ります。" }
    };
    const role = roles[context.role];
    if (role && context.suspect) {
      role.goal = "公開ワードを比べ、話し合いと最終告発で人狼を探す";
      role.action = context.role === Core.ROLES.SEER
        ? "ヒントは自分の推理に使えます。話すときは公開ワードを根拠にします。"
        : "最後は容疑者だけが投票します。ワード入力と通常投票はできません。";
    }
    $("#rules-content").dataset.role = context.role;
    $("#rules-content").innerHTML = `
      ${context.suspect ? `<section class="rules-quick suspect-guidance"><h3>今は容疑者です</h3><div class="rule-do"><span>すること</span><strong>話し合いに参加し、最後に人狼を告発</strong></div><div class="rule-ban"><span>できないこと</span><strong>ワード入力・通常投票</strong><p>占い師なら、容疑者になっても正体とヒントは秘密です。</p></div></section>` : ""}
      ${role ? `<section class="rules-quick"><div class="rules-role-label">${role.side}</div><h3>${context.role}の遊び方</h3><div class="rule-do"><span>すること</span><strong>${role.goal}</strong><p>${role.action}</p></div><div class="rule-ban"><span>禁止</span><strong>${role.forbid}</strong><p>${role.note}</p></div></section>` : `<section class="rules-quick"><h3>まず覚えること</h3><div class="rule-do"><span>すること</span><strong>お題に沿うワードを出し、人狼を推理する</strong><p>人狼だけは、自分のカードの制約にも従います。</p></div><div class="rule-ban"><span>禁止</span><strong>過去の公開ワードの再使用・占い師の名乗り</strong><p>同じ週で偶然かぶるのはOK。占い師のヒントを直接・言い換えて教えるのは禁止です。</p></div></section>`}
      ${context.role === Core.ROLES.SEER ? `<details class="rules-detail"><summary>占い師の発言例と補足</summary><p>2週目に本人だけが役職とヒントを知ります。人狼が誰かを直接知る能力ではありません。人狼に似たワードで探るかどうかは自由です。</p><p><strong>例のヒントが「飼育」の場合</strong>（実際のヒントとは無関係）：</p><ul><li><strong>OK：</strong>公開された「ハムスター」「カメ」を見て、「どちらも家で飼える動物だよね」と推理する。</li><li><strong>禁止：</strong>「占い師です。ヒントは飼育でした」「もらった情報はペット関係」と話す。</li></ul></details>` : ""}
      ${context.master ? `<details class="rules-detail"><summary>マスターの進め方</summary><p>全員の役職確認後にゲームを開始し、開示・話し合い・投票を進めます。<strong>最後の週も、まず「通常投票へ」。</strong></p><p>「容疑者による最終告発へ」は容疑者だけの投票です。<strong>容疑者0人では選べません。</strong></p></details>` : ""}
      <details class="rules-detail"><summary>ゲームの流れ・共通ルール</summary><p>役職確認 → 思考時間 → 伏せ入力 → 順番に開示 → 話し合い → 通常投票。決着しなければ次の週へ進みます。</p><ul><li><strong>思考完了を入力対象の全員が押すとスキップ。</strong>制限時間でも進みます。</li><li><strong>3人以上</strong>で遊べます。占い師ありは<strong>4人以上</strong>で有効です。</li><li><strong>同じ週のワードかぶりはOK。</strong>前の週までの公開ワードは使えません。</li><li><strong>1週目の通常投票だけ</strong>「投票しない」を選べます。</li><li><strong>人狼が単独最多票なら村人勝利。</strong>村人側が単独最多票なら、その人が容疑者になります。</li><li>通常投票の同票、またはスキップが単独最多票なら、新たな容疑者は出ません。</li></ul></details>
      <details class="rules-detail"><summary>容疑者による最終告発・勝敗</summary><p><strong>投票できるのは容疑者だけ。</strong>投票先は容疑者以外です。<strong>人狼が単独最多票なら村人勝利。同票・誤告発は人狼勝利</strong>です。決着時に容疑者がいない場合も人狼勝利です。</p><p>最終週の通常投票後、または容疑者以外が残り人狼数＋1人以下になると最終告発に進みます。</p></details>
      <details class="rules-detail"><summary>占い師の秘密・会話のルール</summary><p><strong>全員、終了まで占い師の名乗り・偽名乗りは禁止。</strong>占い師は正体やヒントを秘密にし、公開ワードからの自分の気づきとして推理を伝えます。終了後は公開して振り返れます。</p></details>
      <p class="rules-footnote">会話は参加者同士で行います。説明を開いてもゲームとタイマーは進みます。</p>
    `;
  }

  function renderHost() {
    $("#host-room-code").textContent = room.roomCode;
    const resetSetup = !hostDraftSettings;
    if (room.phase === Core.PHASES.LOBBY && !hostDraftSettings) {
      hostDraftSettings = Core.normalizeSettings(room.settings);
    }
    renderHostSetup(resetSetup);
    renderHostPlayers();
    renderHostParticipant();
    renderHostPhase();
    renderLogs("#host-log");
  }

  function renderHostPlayers() {
    const roster = Core.activeRoster(room.players);
    const visibleRoster = room.phase === Core.PHASES.LOBBY
      ? roster.filter(player => player.id !== room.hostId)
      : roster;
    const players = visibleRoster.map(player => ({
      name: player.name,
      role: room.phase === Core.PHASES.RESULT ? player.role : "",
      suspect: player.suspect
    }));
    if (room.phase === Core.PHASES.LOBBY && hostDraftSettings?.hostParticipates) {
      players.unshift({
        name: hostDraftSettings.hostName || "マスター",
        role: "参加予定",
        suspect: false
      });
    }
    $("#host-player-list").innerHTML = players.map(player => {
      const role = player.role ? ` / ${player.role}` : "";
      const suspect = player.suspect ? " / 容疑者" : "";
      return `<span class="chip ${player.suspect ? "suspect" : ""}">${escapeHtml(player.name)}${escapeHtml(role)}${suspect}</span>`;
    }).join("") || `<span class="muted">まだ参加者がいません。</span>`;
  }

  function renderHostSetup(force = false) {
    const panel = $("#host-setup-panel");
    if (room.phase !== Core.PHASES.LOBBY) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    if (!force && panel.querySelector("#host-wolves")) return;
    const settings = hostDraftSettings || Core.normalizeSettings(room.settings);
    panel.innerHTML = `
      <h2>ゲーム設定</h2>
      <div class="form-grid">
        <label class="field-label">人狼人数
          <input id="host-wolves" class="input" type="number" min="1" max="6" value="${settings.wolfCount}">
        </label>
        <label class="field-label">最大週数
          <input id="host-max-weeks" class="input" type="number" min="1" max="10" value="${settings.maxWeeks}">
        </label>
        <label class="field-label">思考秒数
          <input id="host-input-seconds" class="input" type="number" min="10" max="180" value="${settings.inputSeconds}">
        </label>
        <label class="field-label">話し合い秒数
          <select id="host-discussion-seconds" class="input">
            ${[0, 60, 120, 180, 300].map(sec => `<option value="${sec}" ${settings.discussionSeconds === sec ? "selected" : ""}>${sec ? `${sec}秒` : "制限なし"}</option>`).join("")}
          </select>
        </label>
      </div>
      <label class="check-row">
        <span><strong>占い師を入れる</strong><small>4人以上のとき、2週目に村人陣営の1人だけが自分の役職とヒントを知ります。終了まで名乗り・ヒントの公開は禁止。推理への利用は自由です。</small></span>
        <input id="host-use-seer" type="checkbox" ${settings.useSeer ? "checked" : ""}>
      </label>
      <label class="check-row">
        <span><strong>マスターも参加する</strong><small>この端末で伏せ入力・開示・投票を行います。</small></span>
        <input id="host-participates" type="checkbox" ${settings.hostParticipates ? "checked" : ""}>
      </label>
      <div id="host-name-row" class="${settings.hostParticipates ? "" : "hidden"}">
        <label class="field-label">マスターの参加名
          <input id="host-name" class="input" maxlength="16" value="${escapeHtml(settings.hostName)}">
        </label>
      </div>
      <label class="field-label">お題モード
        <select id="host-topic-mode" class="input">
          <option value="manual" ${settings.topicMode === "manual" ? "selected" : ""}>手動入力</option>
          <option value="local" ${settings.topicMode === "local" ? "selected" : ""}>お任せ(ローカル生成)</option>
          <option value="external" ${settings.topicMode === "external" ? "selected" : ""}>お任せ(外部AI / Gemini)</option>
        </select>
      </label>
      <div id="auto-topic-fields" class="${settings.topicMode === "local" ? "" : "hidden"}">
        <label class="field-label">生成レベル
          <select id="host-topic-level" class="input">
            <option value="1" ${settings.topicLevel === 1 ? "selected" : ""}>レベル1: 普通</option>
            <option value="2" ${settings.topicLevel === 2 ? "selected" : ""}>レベル2: ちょい知識</option>
            <option value="3" ${settings.topicLevel === 3 ? "selected" : ""}>レベル3: マニアック</option>
          </select>
        </label>
        <label class="field-label">お題指定（任意）
          <input id="host-topic-auto" class="input" value="${escapeHtml(settings.topic)}" placeholder="空ならお題も生成">
        </label>
      </div>
      <div id="external-topic-fields" class="${settings.topicMode === "external" ? "" : "hidden"}">
        <label class="field-label">Gemini APIキー
          <input id="host-gemini-api-key" class="input" type="password" autocomplete="off" placeholder="AI StudioのAPIキー">
        </label>
        <label class="field-label">Geminiモデル
          <input id="host-gemini-model" class="input" value="${escapeHtml(settings.aiModel)}" placeholder="${DEFAULT_GEMINI_MODEL}">
        </label>
        <label class="field-label">生成レベル
          <select id="host-external-topic-level" class="input">
            <option value="1" ${settings.topicLevel === 1 ? "selected" : ""}>レベル1: 普通</option>
            <option value="2" ${settings.topicLevel === 2 ? "selected" : ""}>レベル2: ちょい知識</option>
            <option value="3" ${settings.topicLevel === 3 ? "selected" : ""}>レベル3: マニアック</option>
          </select>
        </label>
        <label class="field-label">お題指定（任意）
          <input id="host-external-topic" class="input" value="${escapeHtml(settings.topic)}" placeholder="空ならAIがお題も生成">
        </label>
        <div class="notice soft">APIキーはこの端末内だけで使い、部屋データには保存しません。失敗時はローカル生成へフォールバックします。</div>
      </div>
      <div id="manual-topic-fields" class="${settings.topicMode === "manual" ? "" : "hidden"}">
        <label class="field-label">お題
          <input id="host-topic" class="input" value="${escapeHtml(settings.topic)}">
        </label>
        <label class="field-label">人狼の制約
          <input id="host-constraint" class="input" value="${escapeHtml(settings.constraint)}">
        </label>
        <label class="field-label">占い師ヒント
          <input id="host-hint" class="input" maxlength="8" value="${escapeHtml(settings.hint)}">
        </label>
      </div>
      ${settings.topicMode === "local" ? `<div class="notice soft">制約・ヒントはゲーム開始時にローカル生成され、各参加者のカードにだけ表示されます。</div>` : ""}
      <div class="button-row">
        <button id="host-template" class="button secondary" ${settings.topicMode !== "manual" ? "disabled" : ""}>手動候補</button>
        <button id="host-start" class="button primary">役職確認へ</button>
      </div>
    `;
    panel.querySelectorAll("input, select").forEach(input => input.addEventListener("input", collectHostDraft));
    const savedGeminiKey = storageValue("sessionStorage", "getItem", GEMINI_API_KEY) || "";
    if ($("#host-gemini-api-key") && savedGeminiKey) $("#host-gemini-api-key").value = savedGeminiKey;
    $("#host-participates").addEventListener("change", () => {
      collectHostDraft();
      renderHostSetup(true);
      renderHostPlayers();
    });
    $("#host-topic-mode").addEventListener("change", () => {
      const next = collectHostDraft();
      if ($("#host-topic-mode").value !== "manual") {
        next.topic = "";
        hostDraftSettings = next;
      }
      renderHostSetup(true);
    });
    $("#host-gemini-api-key")?.addEventListener("input", () => {
      storageValue("sessionStorage", "setItem", GEMINI_API_KEY, $("#host-gemini-api-key").value.trim());
    });
    $("#host-template").addEventListener("click", () => {
      const item = Core.TEMPLATES[Math.floor(Math.random() * Core.TEMPLATES.length)];
      hostDraftSettings = Core.normalizeSettings({ ...collectHostDraft(false), ...item });
      renderHostSetup(true);
    });
    $("#host-start").addEventListener("click", hostStartGame);
  }

  function collectHostDraft(save = true) {
    const topicMode = $("#host-topic-mode")?.value || "manual";
    const settings = Core.normalizeSettings({
      wolfCount: Number($("#host-wolves")?.value || 1),
      maxWeeks: Number($("#host-max-weeks")?.value || 3),
      inputSeconds: Number($("#host-input-seconds")?.value || 30),
      discussionSeconds: Number($("#host-discussion-seconds")?.value || 0),
      useSeer: Boolean($("#host-use-seer")?.checked),
      hostParticipates: Boolean($("#host-participates")?.checked),
      hostName: $("#host-name")?.value || "マスター",
      topicMode,
      autoTopic: topicMode !== "manual",
      aiModel: $("#host-gemini-model")?.value || DEFAULT_GEMINI_MODEL,
      topicLevel: Number((topicMode === "external" ? $("#host-external-topic-level") : $("#host-topic-level"))?.value || 1),
      topic: topicMode === "external"
        ? ($("#host-external-topic")?.value || "")
        : topicMode === "local"
          ? ($("#host-topic-auto")?.value || "")
          : ($("#host-topic")?.value || ""),
      constraint: $("#host-constraint")?.value || "",
      hint: $("#host-hint")?.value || ""
    });
    if (save) hostDraftSettings = settings;
    return settings;
  }

  async function hostStartGame() {
    await run(async () => {
      const draft = collectHostDraft();
      const topicResult = await resolveTopicSettings(draft);
      await Room.mutateRoom(roomCode, state => {
        state.settings = topicResult.settings;
        if (topicResult.settings.hostParticipates) {
          Core.addOrUpdatePlayer(state, state.hostId, topicResult.settings.hostName);
        } else {
          delete state.players[state.hostId];
        }
        Core.assignRoles(state);
        return Core.startRoleCheck(state);
      });
      if (topicResult.notice) showToast(topicResult.notice);
    });
  }

  async function resolveTopicSettings(settings) {
    if (settings.topicMode !== "external") return { settings, notice: "" };
    const apiKey = ($("#host-gemini-api-key")?.value || storageValue("sessionStorage", "getItem", GEMINI_API_KEY) || "").trim();
    if (!apiKey) throw new Error("外部AI生成にはGemini APIキーを入力してください。");

    try {
      const generated = await generateGeminiTopicSet({
        apiKey,
        model: settings.aiModel,
        level: settings.topicLevel,
        preferredTopic: settings.topic
      });
      const requestedModel = normalizeGeminiModelName(settings.aiModel);
      return {
        settings: Core.normalizeSettings({
          ...settings,
          topicMode: "external",
          autoTopic: true,
          aiModel: generated.modelUsed,
          ...generated.topicSet
        }),
        notice: generated.modelUsed !== requestedModel
          ? `指定モデルが使えなかったため、${generated.modelUsed}で外部AI生成しました。`
          : ""
      };
    } catch (error) {
      const fallback = Core.generateTopicSet(Math.random, settings.topicLevel, settings.topic);
      return {
        settings: Core.normalizeSettings({
          ...settings,
          topicMode: "external",
          autoTopic: true,
          ...fallback
        }),
        notice: `外部AI生成に失敗したため、ローカル生成に切り替えました。${error.message ? ` (${error.message})` : ""}`
      };
    }
  }

  async function generateGeminiTopicSet({ apiKey, model, level, preferredTopic }) {
    const modelErrors = [];
    for (const candidate of geminiModelCandidates(model)) {
      try {
        return {
          topicSet: await requestGeminiTopicSet({ apiKey, model: candidate, level, preferredTopic }),
          modelUsed: candidate
        };
      } catch (error) {
        if (!isGeminiModelUnavailableError(error)) throw error;
        modelErrors.push(`${candidate}: ${error.message}`);
      }
    }
    throw new Error(`利用可能なGeminiモデルが見つかりませんでした。${modelErrors.join(" / ")}`);
  }

  async function requestGeminiTopicSet({ apiKey, model, level, preferredTopic }) {
    const cleanModel = normalizeGeminiModelName(model);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    const levelText = {
      1: "レベル1: 普通。誰でも答えやすい一般カテゴリと、分かりやすい制約。",
      2: "レベル2: ちょい知識必要。偉人、国、映画、ゲームなど、少し知識があると楽しいカテゴリ。",
      3: "レベル3: マニアック。特定作品、シリーズ、専門ジャンルなど、知っている人向けのカテゴリ。"
    }[level] || "レベル1: 普通。";
    const preferred = String(preferredTopic || "").trim();
    const userPrompt = `
生成レベル: ${levelText}
${preferred ? `ユーザー指定のお題候補: ${preferred}\nこのお題候補がゲームに適していれば topic として使い、制約とヒントを作ってください。適さない場合は別のお題を生成してください。` : "topic も含めて生成してください。"}

必ず JSON オブジェクトだけを返してください。
キーは topic, constraint, hint の3つだけです。
`;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: geminiSystemPrompt() }]
          },
          contents: [{
            role: "user",
            parts: [{ text: userPrompt }]
          }],
          generationConfig: {
            temperature: 0.95,
            topP: 0.95,
            candidateCount: 1,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                topic: { type: "string" },
                constraint: { type: "string" },
                hint: { type: "string" }
              },
              required: ["topic", "constraint", "hint"],
              propertyOrdering: ["topic", "constraint", "hint"]
            }
          }
        })
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(data?.error?.message || `Gemini API ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map(part => part.text || "")
        .join("")
        .trim();
      return parseGeneratedTopicSet(text || JSON.stringify(data));
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("Gemini APIがタイムアウトしました。");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function normalizeGeminiModelName(model) {
    if (Core.normalizeAiModel) return Core.normalizeAiModel(model);
    const value = String(model || DEFAULT_GEMINI_MODEL).trim().replace(/^models\//, "");
    if (!value || value === "gemini-2.5-flash-preview-09-2025") return DEFAULT_GEMINI_MODEL;
    return value;
  }

  function geminiModelCandidates(model) {
    return [...new Set([normalizeGeminiModelName(model), ...GEMINI_MODEL_FALLBACKS])];
  }

  function isGeminiModelUnavailableError(error) {
    const message = String(error?.message || "").toLowerCase();
    return error?.status === 404
      || message.includes("not found")
      || message.includes("not supported for generatecontent");
  }

  function geminiSystemPrompt() {
    return [
      "あなたは『制約ワードウルフ』のお題セット生成エンジンです。",
      "出力は必ずJSONオブジェクトのみ。Markdown、説明文、コードブロックは禁止。",
      "topic: プレイヤー全員がワードを考えるベースになる、広い認知度を持つ一般カテゴリ名。単語一語の名詞。余計な接頭辞は禁止。",
      "constraint: 人狼だけに課される条件。広すぎず狭すぎず、複数ログから違和感が見える程度。場所、大きさ、価格帯、色、素材、所属、時代、用途など具体名詞を絞れる切り口にする。",
      "hint: 占い師向け。制約そのものを暴露せず、方向性を示す1〜4文字程度の漢字またはカタカナの単語。",
      "例: {\"topic\":\"動物\",\"constraint\":\"人間が手で抱えられる大きさのもの\",\"hint\":\"大きさ\"}",
      "例: {\"topic\":\"偉人\",\"constraint\":\"ノーベル賞を受賞している人物\",\"hint\":\"受賞\"}",
      "例: {\"topic\":\"ワンピースのキャラ\",\"constraint\":\"海賊ではないキャラクター\",\"hint\":\"所属\"}"
    ].join("\n");
  }

  function parseGeneratedTopicSet(raw) {
    let text = String(raw || "").trim();
    text = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) text = text.slice(first, last + 1);
    const parsed = JSON.parse(text);
    const topic = cleanGeneratedValue(findGeneratedValue(parsed, ["topic", "お題", "おだい", "テーマ", "category"]));
    const constraint = cleanGeneratedValue(findGeneratedValue(parsed, ["constraint", "制約", "せいやく", "条件", "制限", "制約条件"]));
    const hint = cleanGeneratedValue(findGeneratedValue(parsed, ["hint", "ヒント", "ひんと", "占い師ヒント"])).replace(/\s+/g, "").slice(0, 8);
    return Core.sanitizeTopicSet({ topic, constraint, hint });
  }

  function findGeneratedValue(object, keys) {
    if (!object || typeof object !== "object") return "";
    const entries = Object.entries(object);
    for (const key of keys) {
      const found = entries.find(([candidate]) => Core.normalizeText(candidate) === Core.normalizeText(key));
      if (found) return found[1];
    }
    return "";
  }

  function cleanGeneratedValue(value) {
    return String(value || "")
      .replace(/^(お題|おだい|テーマ|topic|カテゴリ|category|制約|せいやく|条件|制限|constraint|ヒント|ひんと|hint)[:：\s]+/i, "")
      .trim();
  }

  function renderHostParticipant() {
    const panel = $("#host-participant-panel");
    const card = $("#host-player-card");
    const me = room.players[Room.userId];
    const playing = Boolean(me && me.active !== false && ![Core.PHASES.LOBBY, Core.PHASES.RESULT].includes(room.phase));
    panel.classList.toggle("hidden", !playing);
    if (!playing) {
      card.classList.add("hidden");
      return;
    }
    renderPrivateCard(me, "#host-player-card");
    renderParticipantPhase(panel, me, "host");
  }

  function renderHostPhase() {
    const panel = $("#host-phase-panel");
    if (room.presentation) { panel.innerHTML = `<h2>演出の確認待ち</h2><p>全員の確認後に進みます。タイマーは停止中です。</p><button class="button secondary" data-action="show-effect" data-local-control>投票結果・確認画面を開く</button>`; return; }
    const living = Core.livingPlayers(room);
    const suspects = Core.suspectPlayers(room);
    const hostPlaying = room.players[Room.userId]?.active !== false && Boolean(room.players[Room.userId]);
    if (room.phase === Core.PHASES.LOBBY) {
      panel.innerHTML = `<h2>待機中</h2><p class="muted">参加者が部屋コードを入力して入室するのを待っています。</p>`;
      return;
    }
    if (room.phase === Core.PHASES.ROLE_CHECK) {
      const players = Core.activeRoster(room.players);
      const confirmed = players.filter(player => room.roleReady?.[player.id]);
      const allConfirmed = Core.allRolesConfirmed(room);
      panel.innerHTML = `
        <h2>役職確認</h2>
        <p class="muted">確認済み ${confirmed.length} / ${players.length}</p>
        ${allConfirmed
          ? `<button id="begin-input" class="button primary full">ゲーム開始</button>`
          : `<p class="muted">全員が自分のお題・役職を確認するまで待っています。</p>`}
      `;
      if (allConfirmed) $("#begin-input").addEventListener("click", () => mutate(state => Core.startWeek(state)));
      return;
    }
    if (room.phase === Core.PHASES.THINK) {
      panel.innerHTML = `
        <h2>${room.week}週目: 思考時間</h2>
        ${hostPlaying ? "" : `<div class="countdown" data-countdown="${room.thinkEndsAt}"></div>`}
        <p class="muted">思考完了 ${living.filter(player => room.thinkReady?.[player.id]).length} / ${living.length}人。全員完了、または制限時間で入力へ進みます。</p>
      `;
      return;
    }
    if (room.phase === Core.PHASES.INPUT) {
      const submitted = Object.keys(room.submissions || {}).length;
      const missing = living.filter(player => !room.submissions?.[player.id]);
      panel.innerHTML = `
        <h2>${room.week}週目: 入力状況</h2>
        <p class="muted">送信済み ${submitted} / ${living.length}</p>
        ${missing.length
          ? `<p class="muted">全員の送信完了で自動的に開示へ進みます。<br>未送信: ${missing.map(player => escapeHtml(player.name)).join(", ")}</p>
            <button id="force-reveal" class="button warn full">強制的に開示フェーズへ</button>`
          : `<p class="success-text">全員送信済み。開示フェーズへ移動します。</p>`}
      `;
      if (missing.length) $("#force-reveal").addEventListener("click", () => advanceToReveal(true));
      return;
    }
    if (room.phase === Core.PHASES.REVEAL) {
      const current = Core.currentRevealPlayer(room);
      panel.innerHTML = `<h2>順番開示</h2><p>現在の開示順: <strong>${escapeHtml(current?.name || "完了")}</strong></p>`;
      return;
    }
    if (room.phase === Core.PHASES.SUSPECT_TALK) {
      panel.innerHTML = `
        <h2>容疑者のログなし発言</h2>
        <p class="muted">容疑者: ${suspects.map(player => escapeHtml(player.name)).join(", ")}</p>
        <button id="start-discussion" class="button primary full">話し合いへ</button>
      `;
      $("#start-discussion").addEventListener("click", () => mutate(state => Core.startDiscussion(state)));
      return;
    }
    if (room.phase === Core.PHASES.DISCUSSION) {
      panel.innerHTML = `
        <h2>話し合い</h2>
        ${room.discussionEndsAt ? (hostPlaying ? "" : `<div class="countdown" data-countdown="${room.discussionEndsAt}"></div>`) : `<p class="muted">制限時間なし</p>`}
        <div class="button-row">
          <button id="start-vote" class="button warn">通常投票へ</button>
          <button id="start-final" class="button secondary" ${suspects.length ? "" : "disabled"}>容疑者による最終告発へ</button>
        </div>
        <p class="muted">${suspects.length ? "最終告発は容疑者だけが投票します。人狼が単独最多票なら村人勝利、それ以外・同票は人狼勝利です。" : "容疑者がいないため最終告発はできません。通常投票へ進んでください。"}</p>
      `;
      $("#start-vote").addEventListener("click", () => mutate(state => Core.startVote(state, false)));
      $("#start-final").addEventListener("click", () => mutate(state => Core.startFinalAccusation(state)));
      return;
    }
    if (room.phase === Core.PHASES.VOTE || room.phase === Core.PHASES.FINAL_VOTE) {
      const voters = Core.voteVoters(room);
      panel.innerHTML = `
        <h2>${room.phase === Core.PHASES.FINAL_VOTE ? "最終告発" : "通常投票"}</h2>
        <p class="muted">投票済み ${Object.keys(room.votes || {}).length} / ${voters.length}</p>
      `;
      return;
    }
    if (room.phase === Core.PHASES.RESULT) {
      const html = `
        <h2>結果</h2>
        <p class="${room.winner === "villager" ? "role-villager" : "role-wolf"}">${room.winner === "villager" ? "村人陣営の勝ち" : "人狼陣営の勝ち"}</p>
        <p>${escapeHtml(room.reason)}</p>
        <div class="answer-list compact-list">
          <div><dt>お題</dt><dd>${escapeHtml(room.settings.topic)}</dd></div>
          <div><dt>制約</dt><dd>${escapeHtml(room.settings.constraint)}</dd></div>
          ${room.settings.useSeer ? `<div><dt>ヒント</dt><dd>${escapeHtml(room.settings.hint)}</dd></div>` : ""}
        </div>
        <button id="back-lobby" class="button primary full">同じ部屋で新規ゲーム</button>
        ${resultPresentation()}
      `;
      if (panel.dataset.resultContent === html && panel.querySelector("#back-lobby")) return;
      panel.innerHTML = html;
      panel.dataset.resultContent = html;
      $("#back-lobby").addEventListener("click", () => {
        hostDraftSettings = null;
        mutate(state => Core.resetGame(state));
      });
    }
  }

  function renderPlayer() {
    const me = room.players[Room.userId];
    $("#player-title").textContent = me ? `${me.name} さん` : "参加者画面";
    renderPrivateCard(me, "#player-card");
    renderPlayerPhase(me);
    renderPlayers("#player-list", false);
    renderLogs("#player-log");
  }

  function renderPrivateCard(me, selector) {
    const card = $(selector);
    if (!me || !me.role || room.phase === Core.PHASES.LOBBY || room.phase === Core.PHASES.RESULT) {
      card.classList.add("hidden");
      return;
    }
    const privateCard = Core.privateCard(room, me.id);
    card.classList.remove("hidden");
    const html = `
      <p class="card-label">お題</p>
      <strong class="card-topic">${escapeHtml(privateCard.topic)}</strong>
      <div class="card-divider"></div>
      <p class="card-label">役職</p>
      <strong class="card-role ${roleClass(privateCard.role)}">${escapeHtml(privateCard.role)}</strong>
      <div class="card-info"><strong>${escapeHtml(privateCard.label)}</strong><br>${escapeHtml(privateCard.value)}</div>
      ${room.settings.useSeer ? `<p class="card-note"><strong>禁止：占い師の名乗り・偽名乗り。</strong>終了まで全員が守ります。</p>` : ""}
      ${privateCard.role === Core.ROLES.SEER ? `<p class="card-note"><strong>役職・ヒントは秘密。</strong>ヒントを直接・言い換えて教えるのは禁止です。<strong>公開ワードから自分の気づきとして推理を話すのはOK。</strong></p>` : ""}
      <button class="card-toggle" data-local-control data-action="toggle-card" aria-expanded="false">カードを開く</button>
    `;
    if (card.dataset.content !== html) { card.innerHTML = html; card.dataset.content = html; }
    card.dataset.role = privateCard.role;
    const toggle = card.querySelector(".card-toggle");
    toggle.setAttribute("aria-expanded", String(card.classList.contains("card-expanded")));
    toggle.textContent = card.classList.contains("card-expanded") ? "カードを閉じる" : "カードを開く";
  }

  function renderPlayerPhase(me) {
    renderParticipantPhase($("#player-phase-panel"), me, "player");
  }

  function renderParticipantPhase(panel, me, prefix) {
    const phaseKey = `${roomCode}:${room.phase}:${room.week}`;
    if (panel.dataset.phaseKey !== phaseKey) {
      delete panel.dataset.markup;
      panel.dataset.phaseKey = phaseKey;
    }
    // Presentation replaces this panel too. Track it before returning so a
    // delayed presentation followed by the same thinking round rebuilds its DOM.
    if (room.presentation) { setPanelMarkup(panel, `<h2>演出の確認待ち</h2><p>全員の確認後に進みます。</p><button class="button secondary" data-action="show-effect" data-local-control>投票結果・確認画面を開く</button>`); return; }
    if (!me) {
      panel.innerHTML = `<h2>入室情報がありません</h2><p class="muted">トップに戻って入り直してください。</p>`;
      return;
    }
    if (room.phase === Core.PHASES.LOBBY) {
      panel.innerHTML = `<h2>待機中</h2><p class="muted">マスターがゲームを開始するまで待ってください。</p>${room.settings.useSeer ? `<p class="muted">占い師あり：4人以上で有効です。2週目に本人だけが役職とヒントを知ります。全員、終了まで占い師の名乗り・偽名乗りは禁止。ヒントの公開や言い換えて教えることも禁止ですが、自分の気づきとして推理を話せます。</p>` : ""}`;
      return;
    }
    if (room.phase === Core.PHASES.ROLE_CHECK) {
      const card = Core.privateCard(room, me.id);
      const confirmed = room.roleReady?.[me.id];
      const buttonId = `${prefix}-confirm-role`;
      const html = confirmed ? `
        <h2>確認済み</h2>
        <p class="muted">全員の確認完了と、マスターのゲーム開始を待っています。</p>
      ` : `
        <h2>役職確認</h2>
        <p>あなたは「${escapeHtml(card.topic)} / ${escapeHtml(card.role)}」です。</p>
        <p class="muted">上のお題・役職カードを確認してください。</p>
        <button id="${buttonId}" class="button primary full">確認</button>
      `;
      if (!setPanelMarkup(panel, html)) return;
      if (!confirmed) panel.querySelector(`#${buttonId}`).addEventListener("click", () => mutate(state => Core.confirmRole(state, me.id)));
      return;
    }
    if (room.phase === Core.PHASES.THINK) {
      const thinkers = Core.livingPlayers(room);
      const ready = Boolean(room.thinkReady?.[me.id]);
      const week = room.week;
      const deadline = room.thinkEndsAt;
      const buttonId = `${prefix}-complete-thinking`;
      const html = `
        <h2>${room.week}週目: 思考時間</h2>
        <div class="countdown" data-countdown="${room.thinkEndsAt}"></div>
        <p class="thinking-progress"></p>
        ${me.suspect ? `<p class="muted">容疑者は思考完了の対象外です。公開ログを見ながら推理を続けてください。</p>` : `<button id="${buttonId}" class="button primary full" ${ready ? "disabled" : ""}>${ready ? "思考完了済み" : "思考完了"}</button>`}
        <p class="muted">今回ワードを入力する全員が完了すると、残り時間をスキップします。制限時間でも自動で入力へ進みます。</p>
      `;
      const changed = setPanelMarkup(panel, html);
      panel.querySelector(".thinking-progress").textContent = `思考完了 ${thinkers.filter(player => room.thinkReady?.[player.id]).length} / ${thinkers.length}人`;
      if (!changed) return;
      if (!me.suspect && !ready) panel.querySelector(`#${buttonId}`).addEventListener("click", () => mutate(state => Core.completeThinking(state, me.id, week, deadline)));
      return;
    }
    if (room.phase === Core.PHASES.INPUT) {
      if (me.suspect) {
        panel.innerHTML = `<h2>${room.week}週目: 推理の時間</h2><p class="muted">あなたは容疑者です。入力はせず、下の公開ワードを見比べて人狼を探してください。開示後の話し合いと最終告発に参加できます。</p>`;
        return;
      }
      const submitted = room.submissions?.[me.id];
      const inputId = `${prefix}-hidden-word`;
      const buttonId = `${prefix}-submit-word`;
      const inputRound = `${roomCode}:${room.week}`;
      if (!submitted && panel.dataset.inputRound === inputRound && panel.querySelector(`#${inputId}`)) return;
      panel.dataset.inputRound = inputRound;
      panel.innerHTML = `
        <h2>${room.week}週目: 伏せ入力</h2>
        ${submitted ? `<p class="success-text">送信済み: ${escapeHtml(submitted.word)}</p><p class="muted">全員の入力完了、またはマスターの進行を待っています。</p>` : `
          <label class="field-label">伏せワード
            <input id="${inputId}" class="input" autocomplete="off" placeholder="お題に沿ったワード">
          </label>
          <button id="${buttonId}" class="button primary full">伏せて送信</button>
        `}
      `;
      if (!submitted) panel.querySelector(`#${buttonId}`).addEventListener("click", () => submitWord(inputId));
      return;
    }
    if (room.phase === Core.PHASES.REVEAL) {
      const current = Core.currentRevealPlayer(room);
      if (current?.id === me.id) {
        const word = room.submissions?.[me.id]?.word || "";
        const buttonId = `${prefix}-reveal-word`;
        const html = `
          <h2>あなたの開示順です</h2>
          <p class="muted">ボタンを押したら、公開されたワードを声に出して読んでください。</p>
          <button id="${buttonId}" class="button primary full">「${escapeHtml(word)}」を明らかにする</button>
        `;
        if (!setPanelMarkup(panel, html)) return;
        panel.querySelector(`#${buttonId}`).addEventListener("click", () => mutate(state => Core.revealCurrentWord(state, me.id)));
      } else {
        panel.innerHTML = `<h2>順番開示</h2><p>現在の開示順: <strong>${escapeHtml(current?.name || "完了")}</strong></p>`;
      }
      return;
    }
    if (room.phase === Core.PHASES.SUSPECT_TALK) {
      panel.innerHTML = me.suspect
        ? `<h2>ログなし発言</h2><p class="muted">声だけで発言できます。人狼を揺さぶるトラップを仕掛けられます。</p>`
        : `<h2>容疑者の発言中</h2><p class="muted">ログには残りません。よく聞いてください。</p>`;
      return;
    }
    if (room.phase === Core.PHASES.DISCUSSION) {
      panel.innerHTML = `<h2>話し合い</h2>${room.discussionEndsAt ? `<div class="countdown" data-countdown="${room.discussionEndsAt}"></div>` : `<p class="muted">制限時間なし。マスターが投票へ進めます。</p>`}`;
      return;
    }
    if (room.phase === Core.PHASES.VOTE || room.phase === Core.PHASES.FINAL_VOTE) {
      renderPlayerVote(panel, me);
      return;
    }
    if (room.phase === Core.PHASES.RESULT) {
      const html = renderResult();
      if (panel.dataset.resultContent !== html || !panel.querySelector(".result-reveal")) {
        panel.innerHTML = html;
        panel.dataset.resultContent = html;
      }
    }
  }

  function renderPlayerVote(panel, me) {
    const voters = Core.voteVoters(room);
    const voted = room.votes?.[me.id];
    if (!voters.some(player => player.id === me.id)) {
      panel.innerHTML = `<h2>${room.phase === Core.PHASES.FINAL_VOTE ? "最終告発" : "通常投票"}</h2><p class="muted">あなたにはこの投票の投票権がありません。</p>`;
      return;
    }
    if (voted) {
      panel.innerHTML = `<h2>投票済み</h2><p class="muted">全員の投票を待っています。</p>`;
      return;
    }
    const candidates = Core.voteCandidates(room).filter(player => room.phase === Core.PHASES.FINAL_VOTE || player.id !== me.id);
    const skipButton = Core.canSkipVote(room)
      ? `<button class="vote-option skip" data-target="${Core.SKIP_VOTE}">投票しない（スキップ）</button>`
      : "";
    const html = `
      <h2>${room.phase === Core.PHASES.FINAL_VOTE ? "最終告発" : "通常投票"}</h2>
      ${room.phase === Core.PHASES.FINAL_VOTE && me.suspect ? `<p class="accusation-heading">あなたの告発が、結末を決める</p>` : ""}
      ${room.phase === Core.PHASES.FINAL_VOTE ? `<p class="muted">容疑者だけが投票します。人狼が単独最多票なら村人勝利。それ以外・同票は人狼勝利です。</p>` : ""}
      <div class="vote-options">
        ${candidates.map(player => `<button class="vote-option" data-target="${player.id}">${escapeHtml(player.name)} に投票</button>`).join("")}
        ${skipButton}
      </div>
    `;
    if (panel.dataset.voteContent === html && panel.querySelector("[data-target]")) return;
    panel.innerHTML = html;
    panel.dataset.voteContent = html;
    panel.querySelectorAll("[data-target]").forEach(button => {
      button.addEventListener("click", () => mutate(state => Core.castVote(state, me.id, button.dataset.target)));
    });
  }

  function setPanelMarkup(panel, html) {
    if (panel.dataset.markup === html) return false;
    panel.innerHTML = html;
    panel.dataset.markup = html;
    return true;
  }

  async function submitWord(inputId) {
    const input = document.getElementById(inputId);
    const word = input.value.trim();
    await run(async () => {
      await Room.mutateRoom(roomCode, state => Core.submitHiddenWord(state, Room.userId, word));
    });
  }

  async function advanceToReveal(fillMissing = false) {
    await mutate(state => {
      if (state.phase !== Core.PHASES.INPUT) return state;
      if (fillMissing) fillMissingWords(state);
      return Core.startReveal(state);
    });
  }

  function fillMissingWords(state) {
    Core.livingPlayers(state).forEach(player => {
      if (!state.submissions[player.id]) {
        state.submissions[player.id] = {
          playerId: player.id,
          word: "（未入力）",
          normalized: `__missing_${state.week}_${player.id}`,
          submittedAt: Date.now(),
          revealed: false
        };
      }
    });
  }

  async function tick() {
    renderCountdowns();
    if (!room || busy) return;
    const host = mode === "host";
    if (!Core.automaticAction(room, Date.now(), host)) return;
    const phase = room.phase;
    const week = room.week;
    await mutate(state => Core.advanceAutomatically(state, phase, week, Date.now(), host && state.hostId === Room.userId));
  }

  function renderCountdowns() {
    document.querySelectorAll("[data-countdown]").forEach(el => {
      const end = Number(el.dataset.countdown);
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      el.textContent = `${left}秒`;
      el.classList.toggle("danger", left <= 5);
      el.classList.toggle("urgent", left > 0 && left <= 10);
      const panel = el.closest(".panel");
      panel?.querySelectorAll("[data-warning-message]").forEach(message => {
        message.classList.toggle("hidden", left > 0);
      });
    });
  }

  async function mutate(mutator) {
    await run(async () => {
      const code = roomCode;
      const generation = subscriptionGeneration;
      const updateCount = roomUpdateCount;
      const latest = await Room.mutateRoom(code, mutator);
      // Even a no-op transaction reads current server state. A delayed listener
      // must not trap this client in a presentation the master already released.
      // Conversely, never overwrite a newer snapshot or a different session.
      if (latest && mode && code === roomCode && generation === subscriptionGeneration && updateCount === roomUpdateCount) {
        roomUpdateCount++;
        room = latest;
        renderRoom();
      }
    });
  }

  async function run(task) {
    if (busy) return;
    hideToast();
    $("#effect-network").textContent = "送信中…";
    busy = true;
    renderBusyState();
    // A delayed write may already be committed: keep duplicate actions blocked
    // and offer a fresh page instead of timing out and resending the mutation.
    const slowOperation = setTimeout(() => {
      $("#connection-notice").classList.remove("hidden");
      $("#effect-network").textContent = "通信の確認に時間がかかっています。再読み込み後、前回の部屋から再入室できます。";
      $("#effect-reload").classList.remove("hidden");
    }, CONNECTION_WAIT_MS);
    try {
      await task();
      $("#effect-network").textContent = "";
    } catch (error) {
      showToast(error.message || String(error));
      $("#effect-network").textContent = error.message || String(error);
    } finally {
      clearTimeout(slowOperation);
      $("#effect-reload").classList.add("hidden");
      $("#connection-notice").classList.add("hidden");
      busy = false;
      renderBusyState();
    }
  }

  function renderBusyState() {
    $("#saving-indicator").classList.toggle("hidden", !busy);
    document.querySelector(".app-shell").setAttribute("aria-busy", String(busy));
    document.querySelectorAll("button:not([data-local-control])").forEach(button => {
      if (busy && !button.disabled) {
        button.dataset.busyDisabled = "true";
        button.disabled = true;
      } else if (!busy && button.dataset.busyDisabled) {
        button.disabled = false;
        delete button.dataset.busyDisabled;
      }
    });
  }

  function renderPlayers(selector, revealRoles) {
    const result = room.phase === Core.PHASES.RESULT;
    const html = Core.activeRoster(room.players).map(player => {
      const role = (revealRoles && result) ? ` / ${player.role}` : "";
      const suspect = player.suspect ? " / 容疑者" : "";
      return `<span class="chip ${player.suspect ? "suspect" : ""}">${escapeHtml(player.name)}${escapeHtml(role)}${suspect}</span>`;
    }).join("") || `<span class="muted">まだ参加者がいません。</span>`;
    if ($(selector).dataset.content !== html) { $(selector).innerHTML = html; $(selector).dataset.content = html; }
  }

  function renderLogs(selector) {
    const logs = room.logs || [];
    const container = $(selector);
    const comparison = document.querySelector(".app-shell").dataset.compare === "true" || room.phase === Core.PHASES.RESULT;
    container.classList.toggle("comparison-log", comparison);
    container.closest(".log-panel").querySelector("h2").textContent = comparison ? "ワードを比較" : "公開ログ";
    if (!logs.length) {
      container.innerHTML = `<div class="result-item">公開ログはまだありません。</div>`;
      return;
    }
    const columns = Math.max(1, ...logs.map(log => log.week));
    container.style.setProperty("--word-columns", columns);
    if (!container.querySelector("[data-log-player]")) container.replaceChildren();
    const grouped = new Map();
    logs.forEach(log => {
      const key = log.playerId || log.playerName;
      if (!grouped.has(key)) grouped.set(key, { name: log.playerName || "不明", words: [] });
      grouped.get(key).words.push(log);
    });
    const ordered = [
      ...Core.activeRoster(room.players)
        .filter(player => grouped.has(player.id))
        .map(player => ({ ...grouped.get(player.id), id: player.id })),
      ...[...grouped.entries()]
        .filter(([playerId]) => !room.players?.[playerId])
        .map(([id, row]) => ({ ...row, id }))
    ];
    const kept = new Set();
    const accents = ["#5eead4", "#a5b4fc", "#fcd34d", "#f9a8d4", "#7dd3fc", "#c4b5fd"];
    ordered.forEach((row, index) => {
      let element = [...container.children].find(el => el.dataset.logPlayer === row.id);
      if (!element) {
        element = document.createElement("div");
        element.className = "log-item log-row";
        element.dataset.logPlayer = row.id;
        element.innerHTML = "<strong></strong><span class='word-history'></span>";
        container.append(element);
      }
      kept.add(element);
      element.style.setProperty("--player-accent", accents[index % accents.length]);
      element.dataset.suspect = String(Boolean(room.players[row.id]?.suspect));
      element.firstElementChild.textContent = row.name;
      if (room.players[row.id]?.suspect) {
        const label = document.createElement("small");
        label.className = "log-suspect";
        label.textContent = "容疑者";
        element.firstElementChild.append(label);
      }
      const words = element.lastElementChild;
      words.querySelectorAll(".missing-word").forEach(el => el.remove());
      row.words.forEach((log, i) => {
        let word = [...words.children].find(el => el.dataset.logId === log.id);
        if (!word) {
          word = document.createElement("span");
          word.dataset.logId = log.id;
          words.append(word);
        }
        word.classList.toggle("latest-word", i === row.words.length - 1);
        word.classList.toggle("previous-word", i !== row.words.length - 1);
        word.style.gridColumn = comparison ? String(log.week) : "";
        word.textContent = comparison ? log.word : `${log.week}週目：${log.word}`;
        word.setAttribute("aria-label", `${row.name}、${log.week}週目、${log.word}`);
      });
      [...words.children].forEach(el => { if (!row.words.some(log => log.id === el.dataset.logId)) el.remove(); });
      if (comparison) {
        for (let week = 1; week <= columns; week++) {
          if (row.words.some(log => log.week === week)) continue;
          const missing = document.createElement("span");
          missing.className = "missing-word";
          missing.style.gridColumn = String(week);
          missing.textContent = "—";
          missing.setAttribute("aria-label", `${week}週目の公開ワードなし`);
          words.append(missing);
        }
      }
    });
    [...container.children].forEach(el => { if (!kept.has(el)) el.remove(); });
  }

  function renderResult() {
    const villagerWin = room.winner === "villager";
    return `
      <h2 class="${villagerWin ? "role-villager" : "role-wolf"}">${villagerWin ? "村人陣営の勝ち" : "人狼陣営の勝ち"}</h2>
      <p>${escapeHtml(room.reason)}</p>
      <div class="answer-list compact-list">
        <div><dt>お題</dt><dd>${escapeHtml(room.settings.topic)}</dd></div>
        <div><dt>制約</dt><dd>${escapeHtml(room.settings.constraint)}</dd></div>
        ${room.settings.useSeer ? `<div><dt>ヒント</dt><dd>${escapeHtml(room.settings.hint)}</dd></div>` : ""}
      </div>
      ${resultPresentation()}
    `;
  }

  function showScreen(id) {
    hideToast();
    document.querySelectorAll(".screen").forEach(screen => screen.classList.toggle("is-active", screen.id === id));
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function renderRoomInvite(code) {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set("room", code);
    $("#room-invite-url").value = url.href;
    const container = $("#room-qr");
    try {
      const qr = window.qrcode(0, "M");
      qr.addData(url.href);
      qr.make();
      container.innerHTML = qr.createImgTag(6, 24, "この部屋に参加するQRコード");
    } catch (_) {
      container.textContent = "QRコードを表示できません。参加URLか部屋コードを共有してください。";
    }
  }

  async function copyRoomLink() {
    const field = $("#room-invite-url");
    try {
      await navigator.clipboard.writeText(field.value);
      showToast("参加URLをコピーしました。");
    } catch (_) {
      field.focus();
      field.select();
      showToast("参加URLを選択しました。長押しまたはコピー操作で共有してください。");
    }
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function hideToast() {
    $("#toast").classList.remove("show");
  }

  function roleClass(role) {
    if (role === Core.ROLES.WOLF) return "role-wolf";
    if (role === Core.ROLES.SEER) return "role-seer";
    return "role-villager";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
