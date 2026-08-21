/* =========================================================================
   MultiZone — Movement B.

   Two demonstrations:
     1. the Response Leader's call tree, stepped by hand so the briefing is
        readable rather than a blur;
     2. claim_files, where the interesting frame is the one where a write is
        refused.

   Both transcripts are synthetic, written for this page.
   ========================================================================= */

(function () {
  "use strict";

  /* ═════════════ 1. The call tree ═════════════ */

  var tree = document.getElementById("tree-demo");
  if (tree) (function () {
    var leader = document.getElementById("treeLeader");
    var leaderNote = document.getElementById("treeLeaderNote");
    var brace = tree.querySelector(".tree__brace");
    var you = document.getElementById("treeYou");
    var panel = document.getElementById("treePanel");
    var agents = Array.prototype.slice.call(panel.querySelectorAll(".subagent"));
    var resolveEl = document.getElementById("treeResolve");
    var resolveText = document.getElementById("treeResolveText");

    var nEl = document.getElementById("treeN");
    var titleEl = document.getElementById("treeTitle");
    var bodyEl = document.getElementById("treeBody");
    var callEl = document.getElementById("treeCall");
    var barsEl = document.getElementById("treeBars");

    var stepBtn = document.getElementById("treeStep");
    var stepLabel = document.getElementById("treeStepLabel");
    var backBtn = document.getElementById("treeBack");
    var resetBtn = document.getElementById("treeReset");

    var BRIEFS = [
      "Assume the cause is in the code we shipped on Tuesday. Find it in the diff. Do not consider infrastructure.",
      "Assume the deploy is innocent and something in the environment changed at the same time. Argue that case.",
      "Assume the metric is wrong before assuming the system is. Attack the measurement.",
      "Assume this is a queueing effect that Tuesday merely exposed. Model the capacity."
    ];

    var FINDINGS = [
      "Tuesday's diff added an N+1: <code>getCart()</code> now loads line items per row. <b>340 extra queries</b> at p99 cart size.",
      "The read replica failed over at <b>09:14 Tuesday</b> — twenty minutes <i>before</i> the deploy. The pool has pointed at the primary ever since.",
      "p99 is computed over a 5-minute window that now includes warm-up requests after each pod restart. <b>Deploy frequency changed, not latency.</b>",
      "Pool size is 20 and Tuesday's traffic crossed the knee. The N+1 would have been <b>invisible at 60% utilisation</b>."
    ];

    var RESOLUTION =
"Three of these are the same fault seen from different distances, and the fourth is a separate real problem nobody asked about.\n\n" +
"The N+1 accounts for roughly 270 ms on its own — 340 queries at 0.8 ms — and the failover adds about 40 ms flat. Neither reaches 1.4 s, and I put that to both of them directly rather than averaging their confidence. What closes the gap is the capacity finding: past the pool knee those 340 queries queue instead of running, which is where the remaining second lives.\n\n" +
"The measurement finding is real but independent. Fix the p99 window regardless — otherwise you cannot tell whether the fix worked.\n\n" +
"Start with the N+1 in getCart(). Of the three, it is the only one that removes the load rather than absorbing it.";

    var STEPS = [
      {
        t: "A question you would not want one model to answer alone.",
        b: "The leader is idle. Press <b>Begin</b> and follow the call tree — the same tree the app draws inline in the stack tracer, where every subchat transcript is openable.",
        c: "multizone · idle"
      },
      {
        t: "The leader reads it. It does not answer.",
        b: "This is the part that makes it a leader rather than a model with a longer prompt: a zone flagged <b>Response Leader</b> is instructed not to answer from its own knowledge. Its first move is to decide how to split the question.",
        c: "→ zone \"Response Leader\"\n   responseLeader: true\n   answering: false — planning the panel"
      },
      {
        t: "Four sub-agents, four different starting assumptions.",
        b: "Each brief is written by the leader. None of them is your message. An agent told to assume the deploy is innocent goes looking somewhere the other three never will — which is the entire reason to run a panel instead of one model four times.",
        c: "spawn_subagent  zone=\"Diff Analyst\"      background=true\nspawn_subagent  zone=\"Infra Analyst\"     background=true\nspawn_subagent  zone=\"Metrics Skeptic\"   background=true\nspawn_subagent  zone=\"Capacity Modeller\" background=true\n← t1 t2 t3 t4 (ids returned immediately)"
      },
      {
        t: "All four run at once.",
        b: "<code>background: true</code> returned the subchat ids straight away, so the leader is not blocked on any of them. They read the repo, the metrics and the deploy log in parallel — and their <code>ask_user</code> calls are suppressed while the leader is driving, because a question raised in a chat nobody is watching would wait forever.",
        c: "t1 · reading  src/cart/getCart.ts\nt2 · reading  infra/events.log\nt3 · reading  metrics/p99.sql\nt4 · reading  src/db/pool.ts"
      },
      {
        t: "Four findings come back. Two of them contradict.",
        b: "The diff and the environment cannot both be the whole story, and neither number is big enough on its own. A single model would have picked whichever it found first.",
        c: "collect_subagents\n← t1 t2 t3 t4 — 4 findings"
      },
      {
        t: "So the leader cross-examines them.",
        b: "This is the step that has no equivalent in ordinary chat: the leader sends each sub-agent the part of another's finding that threatens it, and makes them answer for it.",
        c: "send_subchat_message t1\n  \"Would the N+1 alone reach 1.4s at the observed cart size?\"\n← \"No. 340 queries at 0.8ms is ~270ms.\"\n\nsend_subchat_message t2\n  \"Does the failover explain the p99 shape, or only the mean?\"\n← \"Only the mean. It adds ~40ms flat.\""
      },
      {
        t: "Now it writes one answer.",
        b: "Not a summary of four opinions — a resolution that says which findings are the same fault, which is separate, and what to do first. Every claim in it is traceable to a subchat you can open.",
        c: "multizone · synthesising 4 subchats → 1 answer"
      }
    ];

    var i = 0;

    STEPS.forEach(function (_, k) {
      if (k === 0) return;
      var li = document.createElement("li");
      barsEl.appendChild(li);
    });
    var bars = Array.prototype.slice.call(barsEl.children);

    function paint() {
      var s = STEPS[i];
      nEl.textContent = i;
      titleEl.textContent = s.t;
      bodyEl.innerHTML = s.b;
      callEl.textContent = s.c;

      bars.forEach(function (b, k) { b.classList.toggle("on", k < i); });

      you.classList.toggle("on", i >= 1);
      leader.classList.toggle("active", i >= 1 && i < 7);
      brace.classList.toggle("on", i >= 2);

      leaderNote.innerHTML = i === 0
        ? 'Flagged <code>responseLeader</code> in the zone editor, which auto-enables the subchat tools.'
        : i === 1 ? 'Read the message. Deciding how to split it — not answering it.'
        : i === 2 ? 'Writing four briefs. Each one is a different starting assumption.'
        : i === 3 ? 'Not blocked. Four subchats are running in the background.'
        : i === 4 ? 'Four findings in. Two of them cannot both be the whole story.'
        : i === 5 ? 'Putting each finding to the member it threatens.'
        : 'Writing the resolution.';

      var st = leader.querySelector("[data-state]");
      st.setAttribute("data-state", i === 0 ? "" : i === 6 ? "done" : "working");
      st.textContent = i === 0 ? "waiting" : i === 6 ? "answered" : "working";

      agents.forEach(function (a, k) {
        var brief = a.querySelector("[data-brief]");
        var find = a.querySelector("[data-finding]");
        var ast = a.querySelector("[data-state]");

        a.classList.toggle("on", i >= 2);
        a.classList.toggle("busy", i === 3);

        brief.textContent = i >= 2 ? BRIEFS[k] : "";
        find.innerHTML = i >= 4 ? FINDINGS[k] : "";

        if (i < 2) { ast.setAttribute("data-state", ""); ast.textContent = "—"; }
        else if (i === 2) { ast.setAttribute("data-state", "briefed"); ast.textContent = "briefed"; }
        else if (i === 3) { ast.setAttribute("data-state", "working"); ast.textContent = "working"; }
        else if (i === 5) { ast.setAttribute("data-state", "working"); ast.textContent = "questioned"; }
        else { ast.setAttribute("data-state", "done"); ast.textContent = "reported"; }
      });

      if (i >= 6) {
        resolveEl.hidden = false;
        resolveText.textContent = RESOLUTION;
      } else {
        resolveEl.hidden = true;
        resolveText.textContent = "";
      }

      backBtn.disabled = i === 0;
      resetBtn.disabled = i === 0;
      stepBtn.disabled = i === STEPS.length - 1;
      stepLabel.textContent = i === 0 ? "Begin" : i === STEPS.length - 1 ? "Resolved" : "Next";
    }

    stepBtn.addEventListener("click", function () { if (i < STEPS.length - 1) { i++; paint(); } });
    backBtn.addEventListener("click", function () { if (i > 0) { i--; paint(); } });
    resetBtn.addEventListener("click", function () { i = 0; paint(); });

    paint();
  })();

  /* ═════════════ 2. claim_files ═════════════ */

  var claims = document.getElementById("claims");
  if (claims) (function () {
    var filesEl = document.getElementById("claimFiles");
    var logEl = document.getElementById("claimLog");
    var boardEl = document.getElementById("claimBoard");
    var runBtn = document.getElementById("claimRun");
    var runLabel = document.getElementById("claimRunLabel");

    var AGENTS = {
      careful:   { name: "Careful",     v: "var(--v-claude)" },
      inventive: { name: "Inventive",   v: "var(--v-gpt)" },
      tests:     { name: "Test author", v: "var(--v-glm)" }
    };

    var SCRIPT = [
      { at: 0,    who: "careful",   log: 'claim_files ["src/cart/getCart.ts", "src/cart/queries.ts"]\n  intent: "collapse the N+1 into one query"', res: "ok", hold: ["src/cart/getCart.ts", "src/cart/queries.ts"] },
      { at: 700,  who: "tests",     log: 'claim_files ["tests/cart.test.ts"]\n  intent: "assert one query per cart"', res: "ok", hold: ["tests/cart.test.ts"] },
      { at: 1400, who: "inventive", log: 'claim_files ["src/db/pool.ts", "src/metrics/window.ts"]\n  intent: "raise the pool and add a wait metric"', res: "ok", hold: ["src/db/pool.ts", "src/metrics/window.ts"] },
      { at: 2300, who: "inventive", log: 'write_file "src/cart/queries.ts"', res: "refused", refuse: "src/cart/queries.ts",
        note: "REFUSED — held by Careful\n  \"collapse the N+1 into one query\"" },
      { at: 3400, who: "inventive", log: 'post_note\n  "pool raised 20 → 60. the wait metric is db.pool.wait_ms"', res: "ok",
        board: { who: "inventive", text: "pool raised 20 → 60. the wait metric is <code>db.pool.wait_ms</code> — read it before you conclude anything about latency." } },
      { at: 4400, who: "careful",   log: 'write_file "src/cart/queries.ts"', res: "ok" },
      { at: 5100, who: "careful",   log: 'post_note\n  "getCart() returns one row per cart now, not per line item"', res: "ok",
        board: { who: "careful", text: "<code>getCart()</code> returns one row per cart now, not one per line item. If you are editing a caller, it changed shape." } },
      { at: 6100, who: "tests",     log: "team_status", res: "ok",
        board: { who: "tests", text: "3 agents · 5 files claimed · 1 write refused · 2 notes. Reads were never blocked." } }
    ];

    var timers = [], running = false;

    function reset() {
      timers.forEach(clearTimeout); timers = [];
      logEl.innerHTML = "";
      boardEl.innerHTML = '<li class="claims__empty">Nothing posted yet. The board is where decisions travel with the edits that caused them.</li>';
      Array.prototype.forEach.call(filesEl.children, function (li) {
        li.removeAttribute("data-held");
        li.removeAttribute("data-refused");
        li.style.removeProperty("--hv");
        li.querySelector("[data-holder]").textContent = "";
      });
    }

    function run() {
      reset();
      running = true;
      runBtn.disabled = true;

      SCRIPT.forEach(function (ev) {
        timers.push(setTimeout(function () {
          var a = AGENTS[ev.who];

          var li = document.createElement("li");
          li.style.setProperty("--lv", a.v);
          li.innerHTML = "<b>" + a.name + "</b>  " +
            ev.log.replace(/\n/g, "<br>&nbsp;&nbsp;") +
            (ev.res === "refused"
              ? '<br><span class="no">' + ev.note.replace(/\n/g, "<br>&nbsp;&nbsp;") + "</span>"
              : '<br><span class="ok">→ ok</span>');
          logEl.appendChild(li);

          (ev.hold || []).forEach(function (f) {
            var row = filesEl.querySelector('[data-file="' + f + '"]');
            if (!row) return;
            row.setAttribute("data-held", "");
            row.style.setProperty("--hv", a.v);
            row.querySelector("[data-holder]").textContent = a.name;
          });

          if (ev.refuse) {
            var r = filesEl.querySelector('[data-file="' + ev.refuse + '"]');
            if (r) {
              r.setAttribute("data-refused", "");
              timers.push(setTimeout(function () { r.removeAttribute("data-refused"); }, 1100));
            }
          }

          if (ev.board) {
            var empty = boardEl.querySelector(".claims__empty");
            if (empty) empty.remove();
            var b = document.createElement("li");
            b.style.setProperty("--nv", AGENTS[ev.board.who].v);
            b.innerHTML = "<b>" + AGENTS[ev.board.who].name + "</b>" + ev.board.text;
            boardEl.appendChild(b);
          }
        }, window.MZ.reduced() ? 0 : ev.at));
      });

      timers.push(setTimeout(function () {
        running = false;
        runBtn.disabled = false;
        runLabel.textContent = "Run again";
      }, window.MZ.reduced() ? 20 : 6800));
    }

    runBtn.addEventListener("click", function () { if (!running) run(); });

    window.MZ.whenSeen(claims, function () {
      if (!running && !logEl.children.length) setTimeout(run, 300);
    }, { threshold: 0.3 });
  })();
})();
