/* =========================================================================
   MultiZone — the full-bleed perspective band.

   Six zones answer one message at once and their replies are rendered the way
   the app renders them: incremental markdown over the prefix received so far,
   headings with their rule, real tables, inline-code chips. The app's
   StreamingMarkdown does the same thing — parse what has arrived, not what
   will arrive.

   Every transcript here is synthetic, written for this page. The formatting
   differences between columns are the point: six models given one message
   answer in six shapes.
   ========================================================================= */

(function () {
  "use strict";

  /* ---------- a small markdown renderer, prefix-safe ---------- */

  function esc(s) {
    return s.replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  }

  function render(src) {
    var lines = src.split("\n");
    var out = [], i = 0;

    function flushTable() {
      var rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i]); i++;
      }
      if (!rows.length) return;
      var cells = rows.map(function (r) {
        return r.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); });
      });
      var hasSep = cells.length > 1 && cells[1].every(function (c) { return /^:?-{2,}:?$/.test(c); });
      var head = hasSep ? cells[0] : null;
      var body = hasSep ? cells.slice(2) : cells;
      var html = '<div class="tw"><table>';
      if (head) {
        html += "<thead><tr>" + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr></thead>";
      }
      html += "<tbody>" + body.map(function (r) {
        return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";
      out.push(html);
    }

    while (i < lines.length) {
      var line = lines[i];

      if (/^\s*$/.test(line)) { i++; continue; }

      if (/^```/.test(line)) {
        i++;
        var code = [];
        while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.push("<pre>" + esc(code.join("\n")) + "</pre>");
        continue;
      }

      if (/^\s*\|/.test(line)) { flushTable(); continue; }

      var h = /^(#{2,4})\s+(.*)$/.exec(line);
      if (h) {
        var lvl = Math.min(3, h[1].length);
        out.push("<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">");
        i++; continue;
      }

      if (/^>\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, "")); i++; }
        out.push("<blockquote>" + inline(q.join(" ")) + "</blockquote>");
        continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        var ul = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          ul.push("<li>" + inline(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>");
          i++;
        }
        out.push("<ul>" + ul.join("") + "</ul>");
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        var ol = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          ol.push("<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>");
          i++;
        }
        out.push("<ol>" + ol.join("") + "</ol>");
        continue;
      }

      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^(#{2,4}\s|>\s?|\s*[-*]\s|\s*\d+\.\s|\s*\||```)/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (para.length) out.push("<p>" + inline(para.join(" ")) + "</p>");
      else i++;
    }
    return out.join("");
  }

  /* the renderer is the page's, not this section's — the tutti uses it too */
  window.MZMD = render;

  var band = document.getElementById("band");
  if (!band) return;

  /* ---------- the panel ---------- */

  var QUESTION ="Postgres or SQLite for a desktop app that has to sync between machines?";

  var ZONES = [
    {
      key: "claude", name: "Claude", model: "anthropic/claude", think: 480, speed: 5.5,
      act: "Weighing the sync requirement",
      text:
"**SQLite, and treat sync as a separate problem.**\n\n" +
"The instinct to reach for Postgres here is really an instinct about sync, not about storage — and swapping the engine does not solve it. A desktop app with Postgres still needs a server, an account, a migration story and a network path before it can open a window, and you have now made the offline case the hard case.\n\n" +
"What actually decides it:\n\n" +
"- The database has to open with **no network and no daemon**. That is SQLite's whole design and Postgres's opposite.\n" +
"- Sync is a *merge* problem. Whether the local store is SQLite or Postgres, you still have to decide what happens when the same row changed in two places.\n" +
"- Users expect their data to survive uninstalling your app. One file they can copy is a feature.\n\n" +
"So: SQLite locally, and pick your conflict model deliberately — last-write-wins with a vector clock if the data is mostly personal, CRDTs if two machines genuinely edit at once."
    },
    {
      key: "gpt", name: "GPT", model: "openai/gpt", think: 700, speed: 4.6,
      act: "Comparing along five axes",
      text:
"Short answer: **SQLite for the local store, something else for the sync layer.** The two are not competing for the same job.\n\n" +
"## Side by side\n\n" +
"| | SQLite | Postgres |\n|---|---|---|\n| Runs with no server | Yes | No |\n| Works offline | Always | Only via a local instance |\n| Install footprint | One file | A daemon per machine |\n| Concurrent writers | One at a time | Many |\n| Ships inside your binary | Yes | No |\n| Sync built in | No | No |\n\n" +
"Note the last row. Neither gives you sync — so it cannot be the tiebreaker, and once you remove it Postgres is paying a daemon for concurrency a single-user desktop app does not have.\n\n" +
"### When Postgres does win\n\n" +
"If several people hit the same data at once, or you need real server-side constraints and roles, you are not building a desktop app with sync — you are building a client for a service. Decide which one you are building first."
    },
    {
      key: "gemini", name: "Gemini", model: "google/gemini", think: 900, speed: 5,
      act: "Reading the question as an architecture choice",
      text:
"## The question underneath\n\n" +
"“Postgres or SQLite” is a storage question. “Has to sync between machines” is a distributed-systems question. They are being asked together, and the second one is much larger.\n\n" +
"## Local store\n\n" +
"SQLite. It is embedded, transactional, and the file is portable. Enable `WAL` mode and it handles a reader during a write, which covers a desktop app's real concurrency.\n\n" +
"## Sync\n\n" +
"Pick one of three shapes, in increasing order of difficulty:\n\n" +
"1. **File-level sync** — hand the whole database to a file-sync service. Simple, and it corrupts the moment two machines are open at once. Do not.\n" +
"2. **Operation log** — append every change as a row, ship the log, replay it. This is what most apps end up building.\n" +
"3. **CRDTs** — merge without coordination, at the cost of a data model designed around it.\n\n" +
"Most teams want 2 and discover they needed 3 for exactly one table."
    },
    {
      key: "deepseek", name: "DeepSeek", model: "deepseek/deepseek-chat", think: 1150, speed: 4.2,
      act: "Checking the failure mode first",
      text:
"Everyone will say SQLite, and they are right, so let me argue the part that actually bites.\n\n" +
"**The dangerous option is neither.** It is putting SQLite on a synced folder:\n\n" +
"```\n~/Dropbox/App/app.db\n~/Dropbox/App/app.db-wal   <- here\n```\n\n" +
"SQLite's locking is `fs`-based and a sync client does not honour it. You will get a database that opens fine and is silently wrong.\n\n" +
"If you take one thing:\n\n" +
"- Keep the `.db` somewhere the user cannot sync it.\n" +
"- Sync **changes**, never the file.\n" +
"- Give every row an `updated_at` and an origin id before you need them, not after."
    },
    {
      key: "kimi", name: "Kimi", model: "moonshot/kimi", think: 640, speed: 5.2,
      act: "Framing the decision",
      text:
"> Choose the database for the offline case, because the offline case is the one that has no workaround.\n\n" +
"That is the whole decision, and it points at **SQLite**.\n\n" +
"A useful test before you commit: write down what your app does when the network has been gone for three days.\n\n" +
"1. If the answer is “everything, and it reconciles later” — SQLite, plus an operation log.\n" +
"2. If the answer is “shows a spinner” — you do not need sync, you need a server, and Postgres behind an API is fine.\n" +
"3. If the answer is “it depends which feature” — split the data now. Some of it is local truth, some of it is server truth, and pretending otherwise is where sync projects die.\n\n" +
"Most desktop apps are 1 and get built as 2."
    },
    {
      key: "glm", name: "GLM", model: "zhipu/glm", think: 380, speed: 6,
      act: "Answering directly",
      text:
"SQLite.\n\n" +
"- Zero setup, zero daemon, opens offline.\n" +
"- One file — backup, copy and “where is my data” all become trivial.\n" +
"- Fast enough that you will not think about it again.\n\n" +
"Set these on first open and move on:\n\n" +
"```sql\nPRAGMA journal_mode = WAL;\nPRAGMA synchronous  = NORMAL;\nPRAGMA foreign_keys = ON;\n```\n\n" +
"Sync is a separate build. Do not let it choose your storage engine."
    }
  ];

  var strip = document.getElementById("strip");
  var chips = document.getElementById("winChips");
  var runBtn = document.getElementById("bandRun");
  var runLabel = document.getElementById("bandRunLabel");

  var ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h10M8 3v10"/></svg>';
  var SPARK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 8h2.6l1.7-4 2.4 8 1.7-4H14"/></svg>';

  var cols = [];

  ZONES.forEach(function (z) {
    var col = document.createElement("article");
    col.className = "col voice";
    col.setAttribute("data-v", z.key);
    col.innerHTML =
      '<div class="col__head">' +
        '<span class="zicon">' + ICON + "</span>" +
        '<span class="col__name">' + z.name + "</span>" +
        '<span class="col__model">' + z.model + "</span>" +
      "</div>" +
      '<div class="col__act" data-done="false">' + SPARK + "<span>" + z.act + "</span></div>" +
      '<div class="mdx"></div>';
    strip.appendChild(col);
    cols.push({ z: z, el: col, body: col.querySelector(".mdx"), act: col.querySelector(".col__act") });

    var chip = document.createElement("span");
    chip.className = "win__chip voice";
    chip.setAttribute("data-v", z.key);
    chip.innerHTML = '<span class="zicon">' + ICON + "</span>" + z.name;
    chips.appendChild(chip);
  });

  var timers = [], running = false, done = false;

  function clearAll() { timers.forEach(clearTimeout); timers = []; }

  function settle() {
    clearAll();
    cols.forEach(function (c) {
      c.body.innerHTML = render(c.z.text);
      c.body.classList.remove("streaming");
      c.act.setAttribute("data-done", "true");
      c.act.querySelector("span").textContent = "Answered";
    });
    running = false; done = true;
    runBtn.disabled = false;
    runLabel.textContent = "Play again";
  }

  function play() {
    clearAll();
    running = true; done = false;
    runBtn.disabled = true;
    var finished = 0;

    cols.forEach(function (c) {
      c.body.innerHTML = "";
      c.body.classList.remove("streaming");
      c.act.setAttribute("data-done", "false");
      c.act.querySelector("span").textContent = c.z.act;
    });

    if (window.MZ.reduced()) { settle(); return; }

    cols.forEach(function (c) {
      timers.push(setTimeout(function () {
        c.body.classList.add("streaming");
        var i = 0, last = 0;
        (function step() {
          if (!running) return;
          /* models do not emit one character at a time; they emit bursts */
          i = Math.min(c.z.text.length, i + 2 + Math.floor(Math.random() * 5));
          if (i - last > 2) { c.body.innerHTML = render(c.z.text.slice(0, i)); last = i; }
          if (i < c.z.text.length) {
            timers.push(setTimeout(step, c.z.speed + Math.random() * c.z.speed * 2.2));
          } else {
            c.body.innerHTML = render(c.z.text);
            c.body.classList.remove("streaming");
            c.act.setAttribute("data-done", "true");
            c.act.querySelector("span").textContent = "Answered";
            finished += 1;
            if (finished === cols.length) {
              running = false; done = true;
              runBtn.disabled = false;
              runLabel.textContent = "Play again";
            }
          }
        })();
      }, c.z.think));
    });
  }

  runBtn.addEventListener("click", function () { if (!running) play(); });

  window.MZ.whenSeen(band, function () {
    if (!done && !running) setTimeout(play, 200);
  }, { threshold: 0.14 });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden && running) settle();
  });

  /* the question is authored in one place */
  var q = document.getElementById("bandQuestion");
  if (q) q.textContent = QUESTION;
})();
