/* =========================================================================
   MultiZone — animated background effects.

   A web port of the app's own Settings → Appearance background effects, with
   the same four controls: Speed, Density, Opacity and Hue variation (which
   spreads each element's colour around your accent instead of painting
   everything one flat tone).

   window.MZFX.mount(canvas, opts) -> { set(opts), destroy() }
   ========================================================================= */

(function () {
  "use strict";

  /* ---------- colour helpers ---------- */

  function hexToHsl(hex) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16) / 255,
        g = parseInt(h.slice(2, 4), 16) / 255,
        b = parseInt(h.slice(4, 6), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, s = 0, hue = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
    }
    return [hue, s * 100, l * 100];
  }

  /* ---------- the engine ---------- */

  function mount(canvas, opts) {
    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return { set: function () {}, destroy: function () {} };

    var cfg = Object.assign({
      effect: "particles",
      speed: 1,
      density: 1,
      opacity: 0.6,
      hue: 0.35,
      accent: "#4f9cf9",
      interactive: true
    }, opts || {});

    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    var t = 0, raf = null, alive = true, visible = true;
    var pointer = { x: -9999, y: -9999, has: false };
    var base = hexToHsl(cfg.accent);
    var data = {};

    function tint(k, l, a) {
      var hue = base[0] + k * cfg.hue * 70;
      return "hsla(" + hue + "," + base[1] + "%," + (l == null ? base[2] : l) + "%," + (a == null ? 1 : a) + ")";
    }

    function resize() {
      var r = canvas.getBoundingClientRect();
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    }

    var rand = function (a, b) { return a + Math.random() * (b - a); };

    function build() {
      var area = (W * H) / 1000000;
      base = hexToHsl(cfg.accent);
      data = {};

      if (cfg.effect === "particles") {
        var n = Math.round(Math.min(190, 26 + area * 90 * cfg.density));
        data.p = Array.from({ length: n }, function () {
          return { x: rand(0, W), y: rand(0, H), vx: rand(-0.32, 0.32), vy: rand(-0.32, 0.32), r: rand(1, 2.4) };
        });
      } else if (cfg.effect === "boids") {
        var nb = Math.round(Math.min(150, 24 + area * 62 * cfg.density));
        data.b = Array.from({ length: nb }, function () {
          var a = rand(0, Math.PI * 2);
          return { x: rand(0, W), y: rand(0, H), vx: Math.cos(a) * 1.1, vy: Math.sin(a) * 1.1 };
        });
      } else if (cfg.effect === "fireflies") {
        var nf = Math.round(Math.min(130, 18 + area * 52 * cfg.density));
        data.f = Array.from({ length: nf }, function () {
          return { x: rand(0, W), y: rand(0, H), a: rand(0, Math.PI * 2), ph: rand(0, Math.PI * 2), sp: rand(0.3, 0.9), r: rand(1.4, 3.2) };
        });
      } else if (cfg.effect === "stars") {
        var ns = Math.round(Math.min(340, 60 + area * 190 * cfg.density));
        data.s = Array.from({ length: ns }, function () {
          return { x: rand(0, W), y: rand(0, H), z: rand(0.25, 1), r: rand(0.4, 1.5), ph: rand(0, Math.PI * 2) };
        });
        data.meteors = [];
      } else if (cfg.effect === "matrix") {
        var cols = Math.max(8, Math.round((W / 15) * Math.min(1.5, cfg.density)));
        data.cols = cols;
        data.cw = W / cols;
        data.drop = Array.from({ length: cols }, function () { return rand(-H, 0); });
        data.sp = Array.from({ length: cols }, function () { return rand(1.4, 4.2); });
        data.glyph = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789<>{}[]/\\|=+*";
      } else if (cfg.effect === "waves") {
        data.layers = Math.max(2, Math.round(3 + cfg.density * 3));
      } else if (cfg.effect === "grid") {
        data.cell = Math.max(26, 74 - cfg.density * 30);
      } else if (cfg.effect === "aurora") {
        data.bands = Math.max(2, Math.round(2 + cfg.density * 3));
      }
    }

    /* ------------- draws ------------- */

    function drawParticles() {
      var p = data.p, i, j;
      var thresh = 120 * 120;
      ctx.lineWidth = 1;
      for (i = 0; i < p.length; i++) {
        var a = p[i];
        a.x += a.vx * cfg.speed; a.y += a.vy * cfg.speed;
        if (a.x < -20) a.x = W + 20; if (a.x > W + 20) a.x = -20;
        if (a.y < -20) a.y = H + 20; if (a.y > H + 20) a.y = -20;
        if (pointer.has) {
          var dx = a.x - pointer.x, dy = a.y - pointer.y, d2 = dx * dx + dy * dy;
          if (d2 < 18000 && d2 > 1) {
            var f = (1 - Math.sqrt(d2) / 134) * 1.7;
            a.x += (dx / Math.sqrt(d2)) * f; a.y += (dy / Math.sqrt(d2)) * f;
          }
        }
      }
      for (i = 0; i < p.length; i++) {
        for (j = i + 1; j < p.length; j++) {
          var ddx = p[i].x - p[j].x, ddy = p[i].y - p[j].y, dd = ddx * ddx + ddy * ddy;
          if (dd < thresh) {
            ctx.strokeStyle = tint((i / p.length) * 2 - 1, null, (1 - Math.sqrt(dd) / 120) * 0.34 * cfg.opacity);
            ctx.beginPath(); ctx.moveTo(p[i].x, p[i].y); ctx.lineTo(p[j].x, p[j].y); ctx.stroke();
          }
        }
      }
      for (i = 0; i < p.length; i++) {
        ctx.fillStyle = tint((i / p.length) * 2 - 1, 68, cfg.opacity);
        ctx.beginPath(); ctx.arc(p[i].x, p[i].y, p[i].r, 0, 6.284); ctx.fill();
      }
    }

    function drawBoids() {
      var b = data.b, i, j;
      for (i = 0; i < b.length; i++) {
        var o = b[i], ax = 0, ay = 0, cx = 0, cy = 0, sx = 0, sy = 0, n = 0;
        for (j = 0; j < b.length; j++) {
          if (i === j) continue;
          var q = b[j], dx = q.x - o.x, dy = q.y - o.y, d2 = dx * dx + dy * dy;
          if (d2 < 6400) {
            ax += q.vx; ay += q.vy; cx += q.x; cy += q.y; n++;
            if (d2 < 700 && d2 > 0) { sx -= dx / d2 * 22; sy -= dy / d2 * 22; }
          }
        }
        if (n) {
          o.vx += ((ax / n) - o.vx) * 0.05 + ((cx / n) - o.x) * 0.0012 + sx * 0.06;
          o.vy += ((ay / n) - o.vy) * 0.05 + ((cy / n) - o.y) * 0.0012 + sy * 0.06;
        }
        if (pointer.has) {
          var pdx = o.x - pointer.x, pdy = o.y - pointer.y, pd = Math.hypot(pdx, pdy);
          if (pd < 150 && pd > 0.5) { o.vx += (pdx / pd) * 0.85; o.vy += (pdy / pd) * 0.85; }
        }
        var sp = Math.hypot(o.vx, o.vy) || 1;
        o.vx = (o.vx / sp) * 1.5; o.vy = (o.vy / sp) * 1.5;
        o.x += o.vx * cfg.speed * 1.4; o.y += o.vy * cfg.speed * 1.4;
        if (o.x < -12) o.x = W + 12; if (o.x > W + 12) o.x = -12;
        if (o.y < -12) o.y = H + 12; if (o.y > H + 12) o.y = -12;

        var ang = Math.atan2(o.vy, o.vx);
        ctx.fillStyle = tint((i / b.length) * 2 - 1, 66, cfg.opacity);
        ctx.beginPath();
        ctx.moveTo(o.x + Math.cos(ang) * 7, o.y + Math.sin(ang) * 7);
        ctx.lineTo(o.x + Math.cos(ang + 2.6) * 5, o.y + Math.sin(ang + 2.6) * 5);
        ctx.lineTo(o.x + Math.cos(ang - 2.6) * 5, o.y + Math.sin(ang - 2.6) * 5);
        ctx.closePath(); ctx.fill();
      }
    }

    function drawFireflies() {
      var f = data.f;
      for (var i = 0; i < f.length; i++) {
        var o = f[i];
        o.a += (Math.random() - 0.5) * 0.32;
        o.x += Math.cos(o.a) * o.sp * cfg.speed;
        o.y += Math.sin(o.a) * o.sp * cfg.speed;
        if (pointer.has) {
          var dx = pointer.x - o.x, dy = pointer.y - o.y, d = Math.hypot(dx, dy);
          if (d < 260 && d > 1) { o.x += (dx / d) * 0.5 * cfg.speed; o.y += (dy / d) * 0.5 * cfg.speed; }
        }
        if (o.x < 0) o.x = W; if (o.x > W) o.x = 0;
        if (o.y < 0) o.y = H; if (o.y > H) o.y = 0;
        var pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.05 * cfg.speed + o.ph));
        var g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r * 7);
        g.addColorStop(0, tint((i / f.length) * 2 - 1, 76, pulse * cfg.opacity));
        g.addColorStop(1, tint((i / f.length) * 2 - 1, 60, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 7, 0, 6.284); ctx.fill();
      }
    }

    function drawStars() {
      var s = data.s, i;
      for (i = 0; i < s.length; i++) {
        var o = s[i];
        var px = pointer.has ? (pointer.x - W / 2) * 0.012 * o.z : 0;
        var py = pointer.has ? (pointer.y - H / 2) * 0.012 * o.z : 0;
        var tw = 0.55 + 0.45 * Math.sin(t * 0.03 * cfg.speed + o.ph);
        ctx.fillStyle = tint((i / s.length) * 2 - 1, 82, tw * o.z * cfg.opacity);
        ctx.beginPath(); ctx.arc(o.x + px, o.y + py, o.r * o.z * 1.6, 0, 6.284); ctx.fill();
      }
      if (Math.random() < 0.012 * cfg.speed) {
        data.meteors.push({ x: rand(0, W), y: rand(-40, H * 0.4), l: rand(90, 200), a: rand(0.5, 0.9), life: 1 });
      }
      for (i = data.meteors.length - 1; i >= 0; i--) {
        var m = data.meteors[i];
        m.x += Math.cos(m.a) * 9 * cfg.speed; m.y += Math.sin(m.a) * 9 * cfg.speed; m.life -= 0.012 * cfg.speed;
        if (m.life <= 0 || m.x > W + 200 || m.y > H + 200) { data.meteors.splice(i, 1); continue; }
        var gx = m.x - Math.cos(m.a) * m.l, gy = m.y - Math.sin(m.a) * m.l;
        var mg = ctx.createLinearGradient(m.x, m.y, gx, gy);
        mg.addColorStop(0, tint(0, 88, m.life * cfg.opacity));
        mg.addColorStop(1, tint(0, 70, 0));
        ctx.strokeStyle = mg; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(gx, gy); ctx.stroke();
      }
    }

    function drawMatrix() {
      ctx.font = "13px " + '"JetBrains Mono", monospace';
      for (var c = 0; c < data.cols; c++) {
        data.drop[c] += data.sp[c] * cfg.speed * 1.5;
        if (data.drop[c] > H + 220) data.drop[c] = rand(-260, -20);
        var x = c * data.cw + data.cw / 2;
        var boost = 1;
        if (pointer.has && Math.abs(x - pointer.x) < 90) boost = 1.9;
        for (var k = 0; k < 16; k++) {
          var y = data.drop[c] - k * 15;
          if (y < -14 || y > H + 14) continue;
          var a = (1 - k / 16) * cfg.opacity * boost;
          ctx.fillStyle = tint((c / data.cols) * 2 - 1, k === 0 ? 88 : 62, Math.min(1, a));
          ctx.fillText(data.glyph[(Math.random() * data.glyph.length) | 0], x - 6, y);
        }
      }
    }

    function drawWaves() {
      for (var l = 0; l < data.layers; l++) {
        var amp = 22 + l * 13;
        var yBase = H * (0.42 + l * 0.11);
        var lift = pointer.has ? (1 - pointer.y / H) * 46 : 0;
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (var x = 0; x <= W; x += 8) {
          var y = yBase - lift * (1 - l / data.layers)
            + Math.sin(x * 0.006 + t * 0.012 * cfg.speed + l) * amp
            + Math.sin(x * 0.013 - t * 0.008 * cfg.speed + l * 2) * amp * 0.45;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, H); ctx.closePath();
        ctx.fillStyle = tint((l / data.layers) * 2 - 1, 46, 0.1 * cfg.opacity);
        ctx.fill();
        ctx.strokeStyle = tint((l / data.layers) * 2 - 1, 66, 0.42 * cfg.opacity);
        ctx.lineWidth = 1.2; ctx.stroke();
      }
    }

    function drawGrid() {
      var c = data.cell, x, y;
      ctx.lineWidth = 1;
      var sweep = ((t * 0.9 * cfg.speed) % (W + 500)) - 250;
      for (x = 0; x <= W; x += c) {
        var d = Math.abs(x - sweep);
        var a = (0.1 + Math.max(0, 1 - d / 230) * 0.65) * cfg.opacity;
        ctx.strokeStyle = tint((x / W) * 2 - 1, 60, a);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
      for (y = 0; y <= H; y += c) {
        var pd = pointer.has ? Math.abs(y - pointer.y) : 9999;
        var ay = (0.09 + Math.max(0, 1 - pd / 200) * 0.4) * cfg.opacity;
        ctx.strokeStyle = tint((y / H) * 2 - 1, 60, ay);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    }

    function drawAurora() {
      for (var b = 0; b < data.bands; b++) {
        var bend = pointer.has ? (pointer.x / W - 0.5) * 110 : 0;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        for (var x = 0; x <= W; x += 10) {
          var y = H * (0.1 + b * 0.07)
            + Math.sin(x * 0.0042 + t * 0.009 * cfg.speed + b * 1.4) * (46 + b * 16)
            + bend * Math.sin(x / W * Math.PI);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, 0); ctx.closePath();
        var g = ctx.createLinearGradient(0, 0, 0, H * 0.6);
        g.addColorStop(0, tint((b / data.bands) * 2 - 1, 58, 0.34 * cfg.opacity));
        g.addColorStop(1, tint((b / data.bands) * 2 - 1, 50, 0));
        ctx.fillStyle = g; ctx.fill();
      }
    }

    var DRAW = {
      particles: drawParticles, boids: drawBoids, fireflies: drawFireflies,
      stars: drawStars, matrix: drawMatrix, waves: drawWaves,
      grid: drawGrid, aurora: drawAurora
    };

    function frame() {
      if (!alive) return;
      ctx.clearRect(0, 0, W, H);
      t += 1;
      (DRAW[cfg.effect] || drawParticles)();
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (raf || !alive || !visible) return;
      raf = requestAnimationFrame(frame);
    }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

    /* pointer, in canvas space */
    function onMove(e) {
      if (!cfg.interactive) return;
      var r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      pointer.has = true;
    }
    window.addEventListener("pointermove", onMove, { passive: true });

    var ro = null;
    if ("ResizeObserver" in window) { ro = new ResizeObserver(resize); ro.observe(canvas); }
    else window.addEventListener("resize", resize);

    var vis = function () {
      visible = !document.hidden;
      if (visible) start(); else stop();
    };
    document.addEventListener("visibilitychange", vis);

    /* an effect nobody can see should not burn a core */
    var io = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(function (es) {
        es.forEach(function (en) {
          if (en.isIntersecting) { visible = !document.hidden; start(); }
          else { visible = false; stop(); }
        });
      }, { threshold: 0 });
      io.observe(canvas);
    }

    resize();
    if (reduced) {
      /* one settled frame, no loop */
      ctx.clearRect(0, 0, W, H);
      (DRAW[cfg.effect] || drawParticles)();
    } else {
      start();
    }

    return {
      set: function (next) {
        var rebuild = next.effect !== undefined && next.effect !== cfg.effect;
        var reseed = next.density !== undefined && next.density !== cfg.density;
        Object.assign(cfg, next);
        if (rebuild || reseed || next.accent) build();
        if (reduced) { ctx.clearRect(0, 0, W, H); (DRAW[cfg.effect] || drawParticles)(); }
      },
      destroy: function () {
        alive = false; stop();
        window.removeEventListener("pointermove", onMove);
        document.removeEventListener("visibilitychange", vis);
        if (ro) ro.disconnect(); else window.removeEventListener("resize", resize);
        if (io) io.disconnect();
      }
    };
  }

  window.MZFX = {
    mount: mount,
    /* the effects this port implements, in the app's own order */
    list: [
      { id: "particles", name: "Particles", note: "A drifting field wired together by proximity lines; the cursor pushes them aside." },
      { id: "boids",     name: "Boids",     note: "A flock that aligns, crowds and scatters from the cursor like a predator." },
      { id: "matrix",    name: "Matrix",    note: "Falling glyph rain that fades behind itself; the cursor burns the columns it passes brighter." },
      { id: "fireflies", name: "Fireflies", note: "Wandering lights that pulse and drift gently toward the cursor." },
      { id: "stars",     name: "Stars",     note: "A parallax starfield, optionally streaked by meteors." },
      { id: "waves",     name: "Waves",     note: "Layered sine curves that rise and fall with the pointer." },
      { id: "grid",      name: "Grid",      note: "A pulsing grid with a highlight band sweeping across it." },
      { id: "aurora",    name: "Aurora",    note: "Curtains of light rippling across the top of the screen, bending toward the cursor." }
    ]
  };

  /* ---------- site-wide mount ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    var host = document.getElementById("bgfx");
    if (!host) return;
    var accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4f9cf9";
    var fx = mount(host, {
      effect: host.getAttribute("data-effect") || "particles",
      speed: 0.8,
      density: parseFloat(host.getAttribute("data-density") || "0.7"),
      opacity: parseFloat(host.getAttribute("data-opacity") || "0.3"),
      hue: 0.4,
      accent: accent
    });
    requestAnimationFrame(function () { host.classList.add("on"); });
    window.addEventListener("mz:lights", function () {
      var a = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      var base = parseFloat(host.getAttribute("data-opacity") || "0.3");
      fx.set({ accent: a, opacity: document.documentElement.getAttribute("data-lights") === "up" ? base * 0.7 : base });
    });
  });
})();
