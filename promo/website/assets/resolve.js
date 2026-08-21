/* =========================================================================
   MultiZone — the tutti.

   The leader reads the six answers streamed above and writes one. It is
   deliberately specific about which zone said what, because that is the whole
   difference between synthesising a panel and averaging it.

   Synthetic transcript, written for this page.
   ========================================================================= */

(function () {
  "use strict";

  var btn = document.getElementById("resolveRun");
  var body = document.getElementById("resolveBody");
  var label = document.getElementById("resolveLabel");
  if (!btn || !body) return;

  var TEXT =
"All six say SQLite, and a panel that agrees this fast is telling you the question was settled " +
"before you asked it. The useful information is in what they *disagree* about, which here is " +
"the sync layer — and one of them found a way to lose data.\n\n" +
"## What only one of them said\n\n" +
"**DeepSeek** is the only member that named a failure mode: SQLite on a synced folder. " +
"SQLite's locking is filesystem-based and a sync client does not honour it, so the " +
"`-wal` file arrives out of step and you get a database that opens cleanly and is quietly " +
"wrong. Nobody else raised it, and it is the single most expensive thing on this page.\n\n" +
"## Where they agree without noticing\n\n" +
"**GPT**'s table has the row that ends the argument — neither engine ships sync — so storage was " +
"never the tiebreaker. **Gemini** and **Kimi** reach the same three-way split from opposite " +
"directions: Gemini by escalating the sync mechanism (file, operation log, CRDT), Kimi by asking " +
"what the app does after three days offline. Those are the same taxonomy. **GLM** gives you the " +
"pragmas, which is the only concrete thing you can act on today.\n\n" +
"## The decision\n\n" +
"1. SQLite in `WAL` mode, in a location the user cannot drop into a synced folder.\n" +
"2. `updated_at` and an origin id on every row from the **first** migration, not the one where you need them.\n" +
"3. Sync changes, never the file. Start with an operation log and expect Gemini's warning to come true — you will want CRDTs for exactly one table.\n\n" +
"**Claude**'s framing is the one to keep: reach for Postgres here and you have made the offline " +
"case the hard case. That is the trade you would be making, and it is not the one you want.";

  var mdx = window.MZMD || null;
  function render(src) {
    /* appstream.js owns the renderer; fall back to <p> splitting if the band
       is not on this page for some reason */
    if (mdx) return mdx(src);
    return src.split("\n\n").map(function (p) { return "<p>" + p + "</p>"; }).join("");
  }

  var typer = null, played = false;

  function play() {
    btn.disabled = true;
    body.classList.add("streaming");
    var i = 0, last = 0;

    if (window.MZ.reduced()) {
      body.innerHTML = render(TEXT);
      body.classList.remove("streaming");
      finish();
      return;
    }

    (function step() {
      i = Math.min(TEXT.length, i + 2 + Math.floor(Math.random() * 5));
      if (i - last > 2) { body.innerHTML = render(TEXT.slice(0, i)); last = i; }
      if (i < TEXT.length) {
        typer = setTimeout(step, 5 + Math.random() * 11);
      } else {
        body.innerHTML = render(TEXT);
        body.classList.remove("streaming");
        finish();
      }
    })();
  }

  function finish() {
    played = true;
    btn.disabled = false;
    label.textContent = "Play again";
  }

  btn.addEventListener("click", function () {
    clearTimeout(typer);
    play();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden && btn.disabled) {
      clearTimeout(typer);
      body.innerHTML = render(TEXT);
      body.classList.remove("streaming");
      finish();
    }
  });

  void played;
})();
