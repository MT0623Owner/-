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
  const $ = selector => document.querySelector(selector);

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    Room = await waitForRoomApi();
    bindStaticEvents();
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
    document.body.addEventListener("click", event => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "leave") leaveRoom();
      if (action === "sync") recoverRoomConnection();
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
    try {
      await Room.ready();
      const latest = await Room.getRoom(code);
      if (generation !== subscriptionGeneration || code !== roomCode || !mode) return;
      if (!latest) {
        showToast("部屋が見つからなくなりました。");
        clearSavedSession();
        leaveRoom(false);
        return;
      }
      room = latest;
      renderRoom();
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      subscribe(roomCode);
      updateWakeLock();
    } catch (error) {
      if (generation === subscriptionGeneration) showToast(`接続の復帰に失敗しました。通信状態を確認してください。${error.message ? ` (${error.message})` : ""}`);
    } finally {
      syncingRoom = false;
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
    if (mode === "host") renderHost();
    if (mode === "player") renderPlayer();
    renderBusyState();
    updateWakeLock();
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
    const living = Core.livingPlayers(room);
    const suspects = Core.suspectPlayers(room);
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
        <div class="countdown" data-countdown="${room.thinkEndsAt}"></div>
        <p class="muted">この時間はお題と役職を見ながら、伏せるワードを考える時間です。終了後に入力画面へ進みます。</p>
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
        ${room.discussionEndsAt ? `<div class="countdown" data-countdown="${room.discussionEndsAt}"></div>` : `<p class="muted">制限時間なし</p>`}
        <div class="button-row">
          <button id="start-vote" class="button warn">通常投票へ</button>
          <button id="start-final" class="button secondary">最終解決へ</button>
        </div>
      `;
      $("#start-vote").addEventListener("click", () => mutate(state => Core.startVote(state, false)));
      $("#start-final").addEventListener("click", () => mutate(state => Core.startVote(state, true)));
      return;
    }
    if (room.phase === Core.PHASES.VOTE || room.phase === Core.PHASES.FINAL_VOTE) {
      const voters = Core.voteVoters(room);
      panel.innerHTML = `
        <h2>${room.phase === Core.PHASES.FINAL_VOTE ? "最終解決" : "通常投票"}</h2>
        <p class="muted">投票済み ${Object.keys(room.votes || {}).length} / ${voters.length}</p>
      `;
      return;
    }
    if (room.phase === Core.PHASES.RESULT) {
      panel.innerHTML = `
        <h2>結果</h2>
        <p class="${room.winner === "villager" ? "role-villager" : "role-wolf"}">${room.winner === "villager" ? "村人陣営の勝ち" : "人狼陣営の勝ち"}</p>
        <p>${escapeHtml(room.reason)}</p>
        <div class="answer-list compact-list">
          <div><dt>お題</dt><dd>${escapeHtml(room.settings.topic)}</dd></div>
          <div><dt>制約</dt><dd>${escapeHtml(room.settings.constraint)}</dd></div>
          ${room.settings.useSeer ? `<div><dt>ヒント</dt><dd>${escapeHtml(room.settings.hint)}</dd></div>` : ""}
        </div>
        <button id="back-lobby" class="button primary full">同じ部屋で新規ゲーム</button>
      `;
      $("#back-lobby").addEventListener("click", () => {
        hostDraftSettings = null;
        mutate(state => {
          state.phase = Core.PHASES.LOBBY;
          state.week = 0;
          state.roleReady = {};
          state.seerId = "";
          state.seerRevealed = false;
          state.thinkEndsAt = null;
          state.inputEndsAt = null;
          state.discussionEndsAt = null;
          state.submissions = {};
          state.revealOrder = [];
          state.revealIndex = 0;
          state.logs = [];
          state.votes = {};
          state.voteHistory = [];
          state.winner = "";
          state.reason = "";
          if (state.settings?.autoTopic) {
            state.settings.topic = "";
            state.settings.constraint = "";
            state.settings.hint = "";
          }
          Object.values(state.players).forEach(player => {
            player.role = "";
            player.suspect = false;
          });
          return state;
        });
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
    card.innerHTML = `
      <p class="card-label">お題</p>
      <strong class="card-topic">${escapeHtml(privateCard.topic)}</strong>
      <div class="card-divider"></div>
      <p class="card-label">役職</p>
      <strong class="card-role ${roleClass(privateCard.role)}">${escapeHtml(privateCard.role)}</strong>
      <div class="card-info"><strong>${escapeHtml(privateCard.label)}</strong><br>${escapeHtml(privateCard.value)}</div>
      ${room.settings.useSeer ? `<p class="card-note">全員共通：ゲーム終了まで、占い師の名乗り・偽名乗りは禁止です。占い師はヒントを言い換えて教えることもできませんが、自分の気づきとして推理を話せます。</p>` : ""}
      ${privateCard.role === Core.ROLES.SEER ? `<p class="card-note">この役職とヒントは自分だけの秘密です。ヒントをワード選びや投票に使い、話し合いでは公開ワードを根拠に推理を伝えてください。容疑者になっても、このルールは同じです。</p>` : ""}
    `;
  }

  function renderPlayerPhase(me) {
    renderParticipantPhase($("#player-phase-panel"), me, "player");
  }

  function renderParticipantPhase(panel, me, prefix) {
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
      panel.innerHTML = confirmed ? `
        <h2>確認済み</h2>
        <p class="muted">全員の確認完了と、マスターのゲーム開始を待っています。</p>
      ` : `
        <h2>役職確認</h2>
        <p>あなたは「${escapeHtml(card.topic)} / ${escapeHtml(card.role)}」です。</p>
        <p class="muted">上のお題・役職カードを確認してください。</p>
        <button id="${buttonId}" class="button primary full">確認</button>
      `;
      if (!confirmed) panel.querySelector(`#${buttonId}`).addEventListener("click", () => mutate(state => Core.confirmRole(state, me.id)));
      return;
    }
    if (room.phase === Core.PHASES.THINK) {
      panel.innerHTML = `
        <h2>${room.week}週目: 思考時間</h2>
        <div class="countdown" data-countdown="${room.thinkEndsAt}"></div>
        <p class="muted">お題と役職を見ながら、入力するワードを考えてください。タイマー終了後に入力できます。</p>
      `;
      return;
    }
    if (room.phase === Core.PHASES.INPUT) {
      if (me.suspect) {
        panel.innerHTML = `<h2>${room.week}週目: 伏せ入力</h2><p class="muted">あなたは容疑者です。伏せ入力はできません。</p>`;
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
        panel.innerHTML = `
          <h2>あなたの開示順です</h2>
          <p class="muted">ボタンを押したら、公開されたワードを声に出して読んでください。</p>
          <button id="${buttonId}" class="button primary full">「${escapeHtml(word)}」を明らかにする</button>
        `;
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
      panel.innerHTML = renderResult();
    }
  }

  function renderPlayerVote(panel, me) {
    const voters = Core.voteVoters(room);
    const voted = room.votes?.[me.id];
    if (!voters.some(player => player.id === me.id)) {
      panel.innerHTML = `<h2>${room.phase === Core.PHASES.FINAL_VOTE ? "最終解決" : "通常投票"}</h2><p class="muted">あなたにはこの投票の投票権がありません。</p>`;
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
    panel.innerHTML = `
      <h2>${room.phase === Core.PHASES.FINAL_VOTE ? "最終解決" : "通常投票"}</h2>
      <div class="vote-options">
        ${candidates.map(player => `<button class="vote-option" data-target="${player.id}">${escapeHtml(player.name)} に投票</button>`).join("")}
        ${skipButton}
      </div>
    `;
    panel.querySelectorAll("[data-target]").forEach(button => {
      button.addEventListener("click", () => mutate(state => Core.castVote(state, me.id, button.dataset.target)));
    });
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
    if (room.phase === Core.PHASES.THINK && Date.now() >= room.thinkEndsAt) {
      await mutate(state => state.phase === Core.PHASES.THINK ? Core.startInput(state) : state);
      return;
    }
    if (room.phase === Core.PHASES.INPUT && Core.allLivingSubmitted(room)) {
      await advanceToReveal();
      return;
    }
    if (mode !== "host") return;
    if ((room.phase === Core.PHASES.VOTE || room.phase === Core.PHASES.FINAL_VOTE) && Core.allVotesSubmitted(room)) {
      await mutate(state => Core.resolveVotes(state));
    }
    if (room.phase === Core.PHASES.DISCUSSION && room.discussionEndsAt && Date.now() >= room.discussionEndsAt) {
      await mutate(state => Core.startVote(state, false));
    }
  }

  function renderCountdowns() {
    document.querySelectorAll("[data-countdown]").forEach(el => {
      const end = Number(el.dataset.countdown);
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      el.textContent = `${left}秒`;
      el.classList.toggle("danger", left <= 5);
      const panel = el.closest(".panel");
      panel?.querySelectorAll("[data-warning-message]").forEach(message => {
        message.classList.toggle("hidden", left > 0);
      });
    });
  }

  async function mutate(mutator) {
    await run(async () => {
      await Room.mutateRoom(roomCode, mutator);
    });
  }

  async function run(task) {
    if (busy) return;
    busy = true;
    renderBusyState();
    try {
      await task();
    } catch (error) {
      showToast(error.message || String(error));
    } finally {
      busy = false;
      renderBusyState();
    }
  }

  function renderBusyState() {
    document.querySelector(".app-shell").setAttribute("aria-busy", String(busy));
    document.querySelectorAll("button").forEach(button => {
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
    $(selector).innerHTML = Core.activeRoster(room.players).map(player => {
      const role = (revealRoles && result) ? ` / ${player.role}` : "";
      const suspect = player.suspect ? " / 容疑者" : "";
      return `<span class="chip ${player.suspect ? "suspect" : ""}">${escapeHtml(player.name)}${escapeHtml(role)}${suspect}</span>`;
    }).join("") || `<span class="muted">まだ参加者がいません。</span>`;
  }

  function renderLogs(selector) {
    const logs = room.logs || [];
    if (!logs.length) {
      $(selector).innerHTML = `<div class="result-item">公開ログはまだありません。</div>`;
      return;
    }
    const grouped = new Map();
    logs.forEach(log => {
      const key = log.playerId || log.playerName;
      if (!grouped.has(key)) grouped.set(key, { name: log.playerName || "不明", words: [] });
      grouped.get(key).words.push(log.word);
    });
    const ordered = [
      ...Core.activeRoster(room.players)
        .filter(player => grouped.has(player.id))
        .map(player => grouped.get(player.id)),
      ...[...grouped.entries()]
        .filter(([playerId]) => !room.players?.[playerId])
        .map(([, row]) => row)
    ];
    $(selector).innerHTML = ordered.map(row => `
      <div class="log-item log-row">
        <strong>${escapeHtml(row.name)}</strong>
        <span>${row.words.map(word => escapeHtml(word)).join("／")}</span>
      </div>
    `).join("");
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
      <div class="result-list">
        ${Core.activeRoster(room.players).map(player => `<div class="result-item two-col"><strong>${escapeHtml(player.name)}</strong><span class="${roleClass(player.role)}">${player.role}${player.suspect ? " / 容疑者" : ""}</span></div>`).join("")}
      </div>
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
