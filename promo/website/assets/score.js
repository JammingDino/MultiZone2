/* =========================================================================
   MultiZone — the conductor's score
   Shared behaviour: house lights, reveal, masthead, nav, scroll-spy.
   Every effect degrades to a fully readable page with JS off or motion off.
   ========================================================================= */

(function () {
  "use strict";

  var root = document.documentElement;
  root.classList.add("js");

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  var fine = window.matchMedia("(hover: hover) and (pointer: fine)");

  /* ---------- House lights ------------------------------------------------
     Down by default (the darkened hall). The OS preference raises them on a
     first visit; an explicit choice is remembered and always wins.          */

  function currentLights() {
    var stored = null;
    try { stored = localStorage.getItem("mz.lights"); } catch (e) { /* storage blocked */ }
    if (stored === "up" || stored === "down") return stored;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "up" : "down";
  }

  function applyLights(state) {
    root.setAttribute("data-lights", state);
    document.querySelectorAll("[data-lights-btn]").forEach(function (btn) {
      btn.setAttribute("aria-pressed", state === "up" ? "true" : "false");
      var label = btn.querySelector("[data-lights-label]");
      if (label) label.textContent = state === "up" ? "Lights up" : "Lights down";
    });
    /* screenshots follow the hall */
    document.querySelectorAll("[data-shot-dark]").forEach(function (img) {
      var next = state === "up" ? img.getAttribute("data-shot-light") : img.getAttribute("data-shot-dark");
      if (next && img.getAttribute("src") !== next) img.setAttribute("src", next);
    });
    window.dispatchEvent(new CustomEvent("mz:lights", { detail: { state: state } }));
  }

  applyLights(currentLights());

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-lights-btn]");
    if (!btn) return;
    var next = root.getAttribute("data-lights") === "up" ? "down" : "up";
    try { localStorage.setItem("mz.lights", next); } catch (err) { /* storage blocked */ }
    applyLights(next);
  });

  /* The ambient layer is the app's own background effect, mounted from
     effects.js onto #bgfx — cursor-reactive, and the same thing the app runs
     behind its chat. Nothing else here needs a pointer loop. */
  void fine;

  /* ---------- Reveal ------------------------------------------------------ */

  var revealable = document.querySelectorAll(".rise, .draw");

  /* Reveal is opacity-0-until-seen, so anything that renders the whole document
     without scrolling it — printing, a print-to-PDF, a full-page capture — must
     be given every element up front rather than a page of blank sections. */
  var revealAll = function () {
    revealable.forEach(function (el) { el.classList.add("in"); });
  };
  window.addEventListener("beforeprint", revealAll);
  if (window.matchMedia) {
    var printMq = window.matchMedia("print");
    if (printMq.addEventListener) {
      printMq.addEventListener("change", function (e) { if (e.matches) revealAll(); });
    }
  }
  if (!("IntersectionObserver" in window) || reduced.matches) {
    revealable.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });
    revealable.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Masthead & nav ---------------------------------------------- */

  var masthead = document.querySelector(".masthead");
  if (masthead) {
    var onScroll = function () {
      masthead.classList.toggle("stuck", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  var navToggle = document.querySelector(".nav-toggle");
  var navrail = document.querySelector(".navrail");
  if (navToggle && navrail) {
    navToggle.addEventListener("click", function () {
      var open = navrail.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    navrail.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        navrail.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- Scroll spy over rehearsal marks ------------------------------ */

  var spied = Array.prototype.slice.call(document.querySelectorAll("[data-mark]"));
  if (spied.length && "IntersectionObserver" in window) {
    var marks = {};
    document.querySelectorAll(".navrail a[href^='#']").forEach(function (a) {
      marks[a.getAttribute("href").slice(1)] = a;
    });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var a = marks[entry.target.id];
        if (!a) return;
        if (entry.isIntersecting) {
          Object.keys(marks).forEach(function (k) { marks[k].removeAttribute("aria-current"); });
          a.setAttribute("aria-current", "page");
        }
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    spied.forEach(function (el) { spy.observe(el); });
  }

  /* ---------- Shared helpers for the page demos ---------------------------- */

  window.MZ = {
    reduced: function () { return reduced.matches; },

    /* run fn once the element has been on screen; used by every demo so
       nothing animates in a viewport nobody is looking at */
    whenSeen: function (el, fn, opts) {
      if (!el) return;
      if (!("IntersectionObserver" in window)) { fn(); return; }
      var once = (opts && opts.repeat) !== true;
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            fn(true);
            if (once) obs.disconnect();
          } else if (!once) {
            fn(false);
          }
        });
      }, { threshold: (opts && opts.threshold) || 0.25 });
      obs.observe(el);
    }
  };

  /* ---------- Year & version stamps ---------------------------------------- */

  document.querySelectorAll("[data-year]").forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });
})();
