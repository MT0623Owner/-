// Display-only effects. Receives public events and the current player's visible role,
// never the room document, hidden submissions, or another player's in-game role.
(() => {
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let previous = null;
  let timer = null;
  let finishEffect = null;
  let audio = null;
  let sound = false;
  let vibration = false;
  const reviews = new Map();
  const pendingEvents = [];
  // Leave time to read the revealed word/result and choose the skip button.
  const OPEN_MS = 600;
  const READ_MS = 4500;

  function remember(key, value) {
    try { localStorage.setItem(`cww.effects.${key}`, String(value)); } catch (_) { /* optional storage */ }
  }

  function init() {
    try {
      sound = localStorage.getItem("cww.effects.sound") === "true";
      vibration = localStorage.getItem("cww.effects.vibration") === "true";
    } catch (_) { /* play without storage */ }
    const soundButton = document.querySelector("#effect-sound");
    const vibrationButton = document.querySelector("#effect-vibration");
    const labels = () => {
      soundButton.textContent = `音 ${sound ? "ON" : "OFF"}`;
      soundButton.setAttribute("aria-pressed", String(sound));
      vibrationButton.textContent = `振動 ${vibration ? "ON" : "OFF"}`;
      vibrationButton.setAttribute("aria-pressed", String(vibration));
    };
    soundButton.addEventListener("click", () => { sound = !sound; remember("sound", sound); labels(); unlockAudio(); if (sound) cue(); });
    vibrationButton.addEventListener("click", () => {
      vibration = !vibration;
      remember("vibration", vibration);
      labels();
      if (!vibration) { try { navigator.vibrate?.(0); } catch (_) { /* unsupported */ } }
    });
    document.addEventListener("pointerdown", unlockAudio, { passive: true });
    document.addEventListener("keydown", unlockAudio);
    document.querySelector("#skip-effect").addEventListener("click", complete);
    reduced.addEventListener("change", () => { if (reduced.matches) complete(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) complete(); });
    document.addEventListener("click", event => {
      const button = event.target.closest("[data-review-word]");
      if (!button) return;
      const id = button.dataset.reviewWord;
      const next = ((reviews.get(id) || 0) + 1) % 3;
      reviews.set(id, next);
      document.querySelectorAll("[data-review-word]").forEach(el => {
        if (el.dataset.reviewWord === id) decorateReview(el, next);
      });
      document.querySelectorAll("[data-log-id]").forEach(el => { if (el.dataset.logId === id) el.dataset.assessment = String(next); });
    });
    labels();
  }

  function unlockAudio() {
    if (!sound) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      audio ||= new Audio();
      if (audio.state === "suspended") audio.resume().catch(() => {});
    } catch (_) { /* unsupported audio must never block play */ }
  }

  function cue() {
    if (document.hidden) return;
    if (vibration) { try { navigator.vibrate?.(35); } catch (_) { /* unsupported */ } }
    if (!sound || !audio || audio.state !== "running") return;
    try {
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      tone.frequency.setValueAtTime(440, audio.currentTime);
      tone.frequency.exponentialRampToValueAtTime(660, audio.currentTime + .1);
      volume.gain.setValueAtTime(.045, audio.currentTime);
      volume.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .15);
      tone.connect(volume).connect(audio.destination);
      tone.start();
      tone.stop(audio.currentTime + .16);
      tone.onended = () => { tone.disconnect(); volume.disconnect(); };
    } catch (_) { /* optional feedback */ }
  }

  function finishCurrent() {
    clearTimeout(timer);
    timer = null;
    const finish = finishEffect;
    finishEffect = null;
    if (finish) finish();
    document.querySelector("#presentation-event").classList.add("hidden");
    document.querySelector("#presentation-event").classList.remove("suspect-spotlight");
    document.querySelectorAll(".fx-flip, .fx-awaken, .fx-wolf, .fx-word, .fx-result").forEach(el => {
      el.classList.remove("fx-flip", "fx-awaken", "fx-wolf", "fx-word", "fx-result");
    });
  }

  function complete() {
    pendingEvents.length = 0;
    finishCurrent();
  }

  function event(title, content, type, steps = []) {
    const panel = document.querySelector("#presentation-event");
    if (type === "word" && panel.dataset.effect === "word" && !panel.classList.contains("hidden")) {
      pendingEvents.push({ title, content, type, steps });
      return;
    }
    // A vote result takes precedence over any remaining word reveals.
    complete();
    showEvent({ title, content, type, steps });
  }

  function showEvent({ title, content, type, steps }) {
    const panel = document.querySelector("#presentation-event");
    panel.dataset.effect = type;
    document.querySelector("#effect-title").textContent = title;
    const body = document.querySelector("#effect-body");
    body.innerHTML = content;
    panel.classList.remove("hidden");
    if (reduced.matches || document.hidden) { steps.forEach(step => step()); panel.classList.add("hidden"); return; }
    let index = 0;
    finishEffect = () => { while (index < steps.length) steps[index++](); };
    const advance = () => {
      if (index < steps.length) {
        steps[index++]();
        timer = setTimeout(advance, Math.min(500, 4000 / Math.max(steps.length, 1)));
      } else timer = setTimeout(() => {
        finishCurrent();
        if (pendingEvents.length) showEvent(pendingEvents.shift());
      }, READ_MS);
    };
    timer = setTimeout(advance, OPEN_MS);
    cue();
  }

  function animate(el, name) {
    if (!el || reduced.matches || document.hidden) return;
    el.classList.remove(name);
    void el.offsetWidth;
    el.classList.add(name);
    el.addEventListener("animationend", () => el.classList.remove(name), { once: true });
  }

  function tally(vote, suspects) {
    const counts = new Map();
    for (const item of vote.votes) {
      if (!counts.has(item.targetId)) counts.set(item.targetId, { id: item.targetId, name: item.targetName, count: 0 });
      counts.get(item.targetId).count++;
    }
    const rows = [...counts.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    const top = rows[0];
    const tied = rows.length > 1 && rows[1].count === top.count;
    const suspect = !vote.final && top && !tied && suspects.includes(top.id);
    const title = tied ? "同票・該当者なし" : top?.id === "__skip__" ? "スキップ・該当者なし" : suspect ? `${top.name}さんが容疑者になりました` : `${vote.result}さんへの投票が最多でした`;
    return { rows, title, suspect };
  }

  function update(view) {
    const freshGame = !previous || previous.code !== view.code || (view.phase === "roleCheck" && previous.phase !== "roleCheck" && previous.week > 0);
    if (freshGame || view.phase === "lobby") { complete(); reviews.clear(); previous = null; }
    const prior = previous;
    if (prior?.phase !== view.phase && ["vote", "finalVote", "result"].includes(view.phase)
        && document.querySelector("#presentation-event").dataset.effect === "word") complete();
    const active = !["lobby", "result"].includes(view.phase);
    document.body.dataset.weekMood = active ? (view.week >= view.maxWeeks ? "final" : view.week > 1 ? "middle" : "early") : "";
    const badge = document.querySelector("#suspect-indicator");
    badge.classList.toggle("hidden", !active || !view.suspects.length);
    badge.textContent = `容疑者あり · ${view.suspects.length}人`;
    const phasePanel = document.querySelector(view.host ? "#host-participant-panel" : "#player-phase-panel");
    phasePanel.classList.toggle("accusation-panel", view.phase === "finalVote" && view.me.suspect);
    document.body.classList.toggle("accusation-scene", view.phase === "finalVote" && view.me.suspect);
    document.querySelector("#rules-title").classList.toggle("seer-awakening-title", active && view.me.role === "占い師");
    document.querySelector(view.host ? "#host-log" : "#player-log").classList.toggle("suspect-log", active && view.me.suspect);
    renderVoteSummary(view);
    document.querySelectorAll("[data-log-id]").forEach(el => {
      if (view.phase === "result") el.dataset.assessment = String(reviews.get(el.dataset.logId) || 0);
      else delete el.dataset.assessment;
    });
    if (prior && view.logs.length > prior.logs.length && !["vote", "finalVote", "result"].includes(view.phase)) {
      const added = view.logs.slice(prior.logs.length);
      added.forEach(log => event(`${log.playerName}さんのワード`, `<strong class="reveal-word">${escape(log.word)}</strong>`, "word"));
      added.forEach(log => document.querySelectorAll("[data-log-id]").forEach(el => { if (el.dataset.logId === log.id) animate(el, "fx-word"); }));
    }
    if (prior && view.voteHistory.length > prior.voteHistory.length) {
      const vote = view.voteHistory.at(-1);
      const result = tally(vote, view.suspects);
      const html = result.rows.map((row, i) => `<div class="effect-count-row"><span>${escape(row.name)}</span><strong data-effect-count="${i}">0票</strong></div>`).join("");
      const running = result.rows.map(() => 0);
      const steps = vote.votes.map(item => () => {
        const index = result.rows.findIndex(row => row.id === item.targetId);
        const el = document.querySelector(`[data-effect-count="${index}"]`);
        if (el) el.textContent = `${++running[index]}票`;
      });
      steps.push(() => {
        document.querySelector("#effect-title").textContent = result.title;
        document.querySelector("#presentation-event").classList.toggle("suspect-spotlight", result.suspect);
      });
      event("開票中", html, "vote", steps);
    }
    if (view.phase === "result" && prior?.phase !== "result") {
      // Only end-of-game public data reaches this renderer.
      document.querySelectorAll(".result-reveal-card").forEach((el, i) => { el.style.setProperty("--reveal-delay", `${Math.min(i * 850, 6500)}ms`); animate(el, "fx-result"); });
    }
    if (view.me.role && active && prior?.me.role !== view.me.role) {
      const card = document.querySelector(view.host ? "#host-player-card" : "#player-card");
      animate(card, view.me.role === "占い師" ? "fx-awaken" : view.me.role === "人狼" ? "fx-wolf" : "fx-flip");
      const title = document.querySelector("#rules-title");
      animate(document.querySelector("#rules-dialog"), view.me.role === "占い師" ? "fx-awaken" : "fx-flip");
      if (view.me.role === "占い師") {
        animate(title, "fx-awaken");
      }
      // No role-specific sound/vibration: nearby humans must not hear who awakened.
    }
    previous = view;
  }

  function renderVoteSummary(view) {
    const root = document.querySelector(view.host ? "#host-vote-summary" : "#player-vote-summary");
    const vote = view.voteHistory.at(-1);
    root.classList.toggle("hidden", !vote);
    if (!vote) { root.replaceChildren(); delete root.dataset.content; return; }
    const { rows, title, suspect } = tally(vote, view.suspects);
    const html = `<h2>${vote.week}週目・${vote.final ? "最終告発" : "投票結果"}</h2><p class="${suspect ? "suspect-stamp" : ""}">${escape(title)}</p>${rows.map(row => `<div class="effect-count-row"><span>${escape(row.name)}</span><strong>${row.count}票</strong></div>`).join("")}`;
    if (root.dataset.content !== html) { root.innerHTML = html; root.dataset.content = html; }
  }

  function decorateReview(button, state) {
    const labels = ["未判定", "制約に合う", "制約から外れる"];
    button.dataset.assessment = String(state);
    button.querySelector(".review-label").textContent = labels[state];
    button.setAttribute("aria-label", `${button.dataset.word}：${labels[state]}。押すと変更`);
  }

  function results(view) {
    const cards = view.players.map(player => `<article class="result-reveal-card"><strong>${escape(player.name)}</strong><p class="${player.role === "人狼" ? "role-wolf" : player.role === "占い師" ? "role-seer" : "role-villager"}">${escape(player.role)}</p>${player.role === "人狼" ? `<p>制約：${escape(view.constraint)}</p>` : ""}</article>`).join("");
    const columns = Math.max(1, ...view.logs.map(log => log.week));
    const timeline = view.players.map(player => `<div class="review-row"><strong>${escape(player.name)}</strong><div class="review-words">${Array.from({ length: columns }, (_, i) => {
      const log = view.logs.find(log => log.playerId === player.id && log.week === i + 1);
      if (!log) return `<span class="missing-word" aria-label="${i + 1}週目の公開ワードなし">—</span>`;
      const state = reviews.get(log.id) || 0;
      const label = ["未判定", "制約に合う", "制約から外れる"][state];
      return `<button class="review-word" data-local-control data-review-word="${escape(log.id)}" data-word="${escape(log.word)}" data-assessment="${state}" aria-label="${escape(player.name)}、${log.week}週目、${escape(log.word)}：${label}。押すと変更"><strong>${escape(log.word)}</strong><small class="review-label">${label}</small></button>`;
    }).join("")}</div></div>`).join("");
    return `<section class="result-reveal"><h3>正体を公開</h3><button class="button secondary small" data-action="finish-effects" data-local-control>演出をスキップ</button><div class="result-card-grid">${cards}</div></section><section><h3>ワードを振り返る</h3><p class="muted">左から古い順。ワードを押すと「未判定 → 制約に合う → 外れる」を切り替えます。この端末だけの印で、勝敗は変わりません。</p><div class="review-table" style="--word-columns: ${columns}" tabindex="0" role="region" aria-label="参加者ごとのワードの振り返り">${view.logs.length ? timeline : "<p>公開されたワードはありません。</p>"}</div></section>`;
  }

  function reset() {
    complete();
    previous = null;
    reviews.clear();
    document.body.dataset.weekMood = "";
    document.body.classList.remove("accusation-scene");
    document.querySelector("#rules-title").classList.remove("seer-awakening-title");
    document.querySelector("#suspect-indicator").classList.add("hidden");
  }

  window.CWWPresentation = { init, update, reset, results, complete };
})();
