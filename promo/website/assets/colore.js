/* =========================================================================
   MultiZone — Movement D.

   The effect gallery. Eight of the app's thirteen animated backgrounds,
   running for real on a stage canvas, driven by the app's own four controls.
   ========================================================================= */

(function () {
  "use strict";

  var stage = document.getElementById("fxCanvas");
  if (!stage || !window.MZFX) return;

  var pick = document.getElementById("fxPick");
  var nameEl = document.getElementById("fxName");
  var noteEl = document.getElementById("fxNote");
  var applyBtn = document.getElementById("fxApply");

  function accent() {
    return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4f9cf9";
  }

  var state = { effect: "particles", speed: 0.8, density: 1, opacity: 0.8, hue: 0.4, accent: accent() };
  var fx = window.MZFX.mount(stage, state);

  /* ---------- the effect buttons ---------- */

  var buttons = {};
  window.MZFX.list.forEach(function (e) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = e.name;
    b.setAttribute("aria-pressed", e.id === state.effect ? "true" : "false");
    b.addEventListener("click", function () { select(e.id); });
    pick.appendChild(b);
    buttons[e.id] = b;
  });

  function select(id) {
    var e = window.MZFX.list.find(function (x) { return x.id === id; });
    if (!e) return;
    state.effect = id;
    Object.keys(buttons).forEach(function (k) {
      buttons[k].setAttribute("aria-pressed", k === id ? "true" : "false");
    });
    nameEl.textContent = e.name;
    noteEl.textContent = e.note;
    fx.set({ effect: id });
  }

  /* ---------- the four sliders ---------- */

  [
    ["fxSpeed", "speed"],
    ["fxDensity", "density"],
    ["fxOpacity", "opacity"],
    ["fxHue", "hue"]
  ].forEach(function (pair) {
    var input = document.getElementById(pair[0]);
    var out = document.getElementById(pair[0] + "Out");
    if (!input) return;
    input.addEventListener("input", function () {
      var v = parseFloat(input.value);
      state[pair[1]] = v;
      out.textContent = v.toFixed(2);
      var patch = {};
      patch[pair[1]] = v;
      fx.set(patch);
    });
  });

  /* ---------- put the chosen effect behind the whole page ---------- */

  if (applyBtn) {
    applyBtn.addEventListener("click", function () {
      var host = document.getElementById("bgfx");
      if (!host) return;
      host.setAttribute("data-effect", state.effect);
      /* remount so the page field picks up the whole configuration, kept
         quieter than the stage because there is text over it */
      if (window.__mzPageFx) window.__mzPageFx.destroy();
      window.__mzPageFx = window.MZFX.mount(host, {
        effect: state.effect,
        speed: state.speed,
        density: Math.min(state.density, 1),
        opacity: Math.min(state.opacity * 0.34, 0.34),
        hue: state.hue,
        accent: accent()
      });
      host.classList.add("on");
      applyBtn.textContent = "Applied — it is behind this page now";
      setTimeout(function () {
        applyBtn.textContent = "Apply this effect to the whole page →";
      }, 3200);
    });
  }

  /* the stage follows the house lights, like the app follows its theme */
  window.addEventListener("mz:lights", function () {
    fx.set({ accent: accent() });
  });

  select("particles");
})();
