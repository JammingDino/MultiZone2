/* =========================================================================
   MultiZone — Movement C.

   Three demonstrations: the seven-engine fan-out and its RRF merge, a terminal
   that stays alive across calls, and a scrubbable replay.

   Every transcript, result and timing here is illustrative, written for this
   page and labelled as such in the markup.
   ========================================================================= */

(function () {
  "use strict";

  /* ═════════════ 1. smart_search — seven engines, one ranking ═════════════ */

  var rrf = document.getElementById("rrf");
  if (rrf) (function () {
    var enginesEl = document.getElementById("rrfEngines");
    var outEl = document.getElementById("rrfOut");
    var runBtn = document.getElementById("rrfRun");
    var runLabel = document.getElementById("rrfRunLabel");

    var ENGINES = [
      { name: "DuckDuckGo", v: "var(--v-claude)",   hits: 8, ms: 412 },
      { name: "Bing",       v: "var(--v-gpt)",      hits: 9, ms: 338 },
      { name: "Brave",      v: "var(--v-deepseek)", hits: 7, ms: 296 },
      { name: "Yandex",     v: "var(--v-kimi)",     hits: 0, ms: 0, fail: "rate-limited" },
      { name: "Ecosia",     v: "var(--v-gemini)",   hits: 6, ms: 501 },
      { name: "Yahoo",      v: "var(--v-glm)",      hits: 7, ms: 447 },
      { name: "Wikipedia",  v: "var(--v-gpt)",      hits: 2, ms: 189 }
    ];

    var RESULTS = [
      { t: "tauri-apps/tauri — Updater: signature & pubkey setup", n: 5 },
      { t: "v2.tauri.app · Distribute → Updater plugin", n: 5 },
      { t: "Issue #7847: “Signature verification failed” on NSIS", n: 4 },
      { t: "tauri signer generate — CLI reference", n: 3 },
      { t: "Stack Overflow: minisign key format for tauri v2", n: 2 },
      { t: "Wikipedia — Ed25519", n: 1 }
    ];

    ENGINES.forEach(function (e) {
      var li = document.createElement("li");
      li.style.setProperty("--ev", e.v);
      li.innerHTML =
        '<span class="rrf__name">' + e.name + "</span>" +
        '<span class="rrf__bars">' + Array.from({ length: 9 }, function (_, k) {
          return '<i style="--bd:' + (k * 34) + 'ms;opacity:' + (k < e.hits ? 1 : 0.14) + '"></i>';
        }).join("") + "</span>" +
        '<span class="rrf__lat">' + (e.fail ? e.fail : e.ms + " ms · " + e.hits) + "</span>";
      enginesEl.appendChild(li);
    });

    RESULTS.forEach(function (r, k) {
      var li = document.createElement("li");
      li.style.setProperty("--rd", (k * 90) + "ms");
      li.innerHTML =
        '<span class="rrf__title">' + r.t + "</span>" +
        '<span class="rrf__agree"><b>' + r.n + "</b>/6 agree</span>";
      outEl.appendChild(li);
    });

    var timers = [], running = false;

    function run() {
      timers.forEach(clearTimeout); timers = [];
      running = true;
      runBtn.disabled = true;
      outEl.classList.remove("on");
      Array.prototype.forEach.call(enginesEl.children, function (li) {
        li.classList.remove("on", "fail");
      });

      var order = ENGINES.map(function (e, k) { return { k: k, at: e.fail ? 1400 : e.ms }; })
                         .sort(function (a, b) { return a.at - b.at; });

      order.forEach(function (o) {
        timers.push(setTimeout(function () {
          var li = enginesEl.children[o.k];
          li.classList.add("on");
          if (ENGINES[o.k].fail) li.classList.add("fail");
        }, window.MZ.reduced() ? 0 : o.at));
      });

      timers.push(setTimeout(function () {
        outEl.classList.add("on");
        running = false;
        runBtn.disabled = false;
        runLabel.textContent = "Run again";
      }, window.MZ.reduced() ? 20 : 1750));
    }

    runBtn.addEventListener("click", function () { if (!running) run(); });
    window.MZ.whenSeen(rrf, function () { if (!running) setTimeout(run, 250); }, { threshold: 0.3 });
  })();

  /* ═════════════ 2. A terminal that stays open ═════════════ */

  var term = document.getElementById("term");
  if (term) (function () {
    var out = document.getElementById("termOut");
    var runBtn = document.getElementById("termRun");
    var runLabel = document.getElementById("termRunLabel");
    var alive = document.getElementById("termAlive");
    var aliveText = document.getElementById("termAliveText");

    var SCRIPT = [
      { call: 'terminal_start  cmd="npm run dev"  label="dev server"', wait: 260,
        body: '<span class="m">← t1 — started, returned immediately</span>' },
      { call: 'terminal_read  id="t1"  wait_for="ready in \\\\d+ms"  timeout_ms=20000', wait: 900,
        body: '<span class="c">> multizone@0.15.7 dev</span>\n<span class="c">> vite</span>\n\n  <span class="g">VITE v6.0.1</span>  <span class="m">ready in 431 ms</span>\n\n  <span class="p">➜</span>  Local:   <span class="c">http://localhost:5173/</span>\n<span class="m">← matched: true</span>' },
      { call: 'terminal_write  id="t1"  text="r"   <span class="m">/* vite: restart */</span>', wait: 620,
        body: '<span class="y">[vite] restarting…</span>\n  <span class="g">VITE v6.0.1</span>  <span class="m">ready in 288 ms</span>' },
      { call: 'terminal_start  cmd="cargo test --lib"  label="rust suite"', wait: 700,
        body: '<span class="m">← t2 — the first one is still running</span>' },
      { call: 'terminal_read  id="t1"  cursor=3312   <span class="m">/* only what is new */</span>', wait: 560,
        body: '<span class="y">14:22:41</span> <span class="m">GET</span> /api/health <span class="g">200</span> <span class="m">1.4ms</span>\n<span class="y">14:22:44</span> <span class="m">GET</span> /src/App.tsx <span class="g">200</span> <span class="m">6.1ms</span>\n<span class="m">← 2 lines printed between calls, not lost</span>' },
      { call: "terminal_list", wait: 420,
        body: '<span class="p">t1</span>  dev server  <span class="g">alive</span>   <span class="m">0 bytes waiting</span>\n<span class="p">t2</span>  rust suite  <span class="g">alive</span>   <span class="m">1,204 bytes waiting</span>' }
    ];

    var timers = [], running = false;

    function run() {
      timers.forEach(clearTimeout); timers = [];
      out.innerHTML = "";
      running = true;
      runBtn.disabled = true;
      alive.setAttribute("data-alive", "true");
      aliveText.textContent = "alive";

      var at = 0;
      SCRIPT.forEach(function (s) {
        at += 300;
        var callAt = at;
        timers.push(setTimeout(function () {
          out.insertAdjacentHTML("beforeend", '<span class="tool">' + s.call + "</span>");
          out.scrollTop = out.scrollHeight;
        }, window.MZ.reduced() ? 0 : callAt));

        at += s.wait;
        var bodyAt = at;
        timers.push(setTimeout(function () {
          out.insertAdjacentHTML("beforeend", s.body + "\n");
          out.scrollTop = out.scrollHeight;
        }, window.MZ.reduced() ? 0 : bodyAt));
      });

      timers.push(setTimeout(function () {
        out.insertAdjacentHTML("beforeend",
          '<span class="m">\nBoth terminals stay up until stopped, the process exits, or the app closes.\nThey are never reaped on idle, and the whole session can see them.</span>\n<span class="term__cursor"></span>');
        out.scrollTop = out.scrollHeight;
        running = false;
        runBtn.disabled = false;
        runLabel.textContent = "Run again";
      }, window.MZ.reduced() ? 30 : at + 700));
    }

    runBtn.addEventListener("click", function () { if (!running) run(); });
    window.MZ.whenSeen(term, function () { if (!running && !out.children.length) setTimeout(run, 250); }, { threshold: 0.25 });
  })();

  /* ═════════════ 3. Replay ═════════════ */

  var replay = document.getElementById("replay");
  if (replay) (function () {
    var listEl = document.getElementById("replayList");
    var rangeEl = document.getElementById("replayRange");
    var clockEl = document.getElementById("replayClock");
    var playBtn = document.getElementById("replayPlay");
    var playLabel = document.getElementById("replayPlayLabel");
    var filtersEl = document.getElementById("replayFilters");

    var KINDS = {
      message:  { label: "Message",  v: "var(--accent)" },
      tool:     { label: "Tool",     v: "var(--v-glm)" },
      approval: { label: "Approval", v: "var(--v-claude)" },
      zone:     { label: "Zone",     v: "var(--v-gemini)" },
      error:    { label: "Error",    v: "var(--v-kimi)" },
      plan:     { label: "Plan",     v: "var(--v-gpt)" }
    };

    var EVENTS = [
      { t: 0,     k: "message",  w: "<b>You</b> — “the updater says signature verification failed on the NSIS build”" },
      { t: 1.2,   k: "zone",     w: "Primary zone <b>Code Team Lead</b> picked up the turn" },
      { t: 2.9,   k: "plan",     w: "Plan drafted — 4 steps. <b>You edited step 2</b> before approving" },
      { t: 6.4,   k: "tool",     w: "<code>smart_search</code> <code>\"tauri v2 updater signature\"</code><span class='dur'>1.75 s</span>" },
      { t: 8.2,   k: "tool",     w: "<code>smart_fetch</code> <code>v2.tauri.app/plugin/updater</code> — 11.4 kB markdown<span class='dur'>820 ms</span>" },
      { t: 9.7,   k: "tool",     w: "<code>read_file</code> <code>src-tauri/tauri.conf.json</code><span class='dur'>4 ms</span>" },
      { t: 11.1,  k: "error",    w: "<code>read_file</code> <code>updater/pubkey.pem</code> — <b>no such file</b><span class='dur'>2 ms</span>" },
      { t: 12.8,  k: "tool",     w: "<code>run_command</code> <code>npm run tauri signer generate</code>" },
      { t: 13.0,  k: "approval", w: "Approval requested — shell. <b>You declined.</b> Reason: “not on this machine”" },
      { t: 18.6,  k: "zone",     w: "Switched to <b>Code Scout</b> mid-turn to read the CI config instead" },
      { t: 21.4,  k: "tool",     w: "<code>read_file</code> <code>.github/workflows/release.yml</code><span class='dur'>3 ms</span>" },
      { t: 24.9,  k: "message",  w: "<b>Code Team Lead</b> — “<code>TAURI_SIGNING_PRIVATE_KEY</code> is set in CI but the public key in <code>tauri.conf.json</code> is from the old pair.”" },
      { t: 26.1,  k: "tool",     w: "<code>claim_files</code> <code>[src-tauri/tauri.conf.json]</code><span class='dur'>1 ms</span>" },
      { t: 27.5,  k: "approval", w: "Approval requested — edit inside <code>{project}</code>. <b>Auto-approved</b> by path policy" },
      { t: 28.3,  k: "tool",     w: "<code>write_file</code> <code>src-tauri/tauri.conf.json</code> — 1 hunk<span class='dur'>7 ms</span>" },
      { t: 31.0,  k: "message",  w: "<b>Code Team Lead</b> — wrote the fix and what to re-run" }
    ].filter(function (e) { return e.k && e.w; });

    var active = {};
    Object.keys(KINDS).forEach(function (k) { active[k] = true; });

    Object.keys(KINDS).forEach(function (k) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = KINDS[k].label;
      b.setAttribute("aria-pressed", "true");
      b.addEventListener("click", function () {
        active[k] = !active[k];
        b.setAttribute("aria-pressed", active[k] ? "true" : "false");
        paint();
      });
      filtersEl.appendChild(b);
    });

    var rows = EVENTS.map(function (e) {
      var li = document.createElement("li");
      li.style.setProperty("--kv", KINDS[e.k].v);
      var mm = String(Math.floor(e.t / 60)).padStart(2, "0");
      var ss = e.t.toFixed(1).padStart(4, "0");
      li.innerHTML =
        '<span class="replay__t">' + mm + ":" + ss + "</span>" +
        '<span class="replay__kind">' + KINDS[e.k].label + "</span>" +
        '<span class="replay__what">' + e.w + "</span>";
      listEl.appendChild(li);
      return li;
    });

    rangeEl.max = String(EVENTS.length - 1);
    var at = EVENTS.length - 1;
    var playing = null;

    function paint() {
      rows.forEach(function (li, k) {
        li.hidden = !active[EVENTS[k].k];
        li.classList.toggle("past", k < at);
        li.classList.toggle("now", k === at);
        li.classList.toggle("future", k > at);
      });
      var e = EVENTS[at];
      var mm = String(Math.floor(e.t / 60)).padStart(2, "0");
      var ss = e.t.toFixed(1).padStart(4, "0");
      var wall = new Date(Date.UTC(2026, 0, 1, 14, 22, 7 + Math.floor(e.t)));
      clockEl.textContent = mm + ":" + ss + " · " +
        String(wall.getUTCHours()).padStart(2, "0") + ":" +
        String(wall.getUTCMinutes()).padStart(2, "0") + ":" +
        String(wall.getUTCSeconds()).padStart(2, "0");
      rangeEl.value = String(at);
    }

    rangeEl.addEventListener("input", function () {
      stop();
      at = Number(rangeEl.value);
      paint();
    });

    function stop() {
      if (playing) { clearInterval(playing); playing = null; playLabel.textContent = "Play"; }
    }

    playBtn.addEventListener("click", function () {
      if (playing) { stop(); return; }
      if (at >= EVENTS.length - 1) at = 0;
      paint();
      playLabel.textContent = "Pause";
      playing = setInterval(function () {
        at += 1;
        if (at >= EVENTS.length - 1) { at = EVENTS.length - 1; paint(); stop(); return; }
        paint();
      }, 620);
    });

    paint();
  })();
})();
