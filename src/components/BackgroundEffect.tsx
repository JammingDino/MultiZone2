import { useEffect, useRef, useState } from "react";
import { useApp } from "@/store/app";

function hexToRgb(hex: string): string {
  const clean = (hex.startsWith("#") ? hex.slice(1) : hex).padEnd(6, "0");
  const r = parseInt(clean.slice(0, 2), 16) || 79;
  const g = parseInt(clean.slice(2, 4), 16) || 156;
  const b = parseInt(clean.slice(4, 6), 16) || 249;
  return `${r},${g},${b}`;
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex).split(",").map((n) => parseInt(n, 10) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hslToRgbStr(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `${to(ch(hh + 1 / 3))},${to(ch(hh))},${to(ch(hh - 1 / 3))}`;
}

/**
 * Builds a `tint(k)` for one effect run: `k` in [-1,1] fans the element's hue
 * across ±`spread` degrees around the chosen colour, with a matching sliver of
 * lightness so the ends of the range read as distinct even at low spread.
 * Results are cached per quantised k — draw loops call this per element, per
 * frame, and an HSL conversion inside a 500-particle loop is not free.
 */
function makeTint(hex: string, spread: number) {
  const { h, s, l } = hexToHsl(hex);
  const flat = hexToRgb(hex);
  const cache = new Map<number, string>();
  return (k: number): string => {
    if (spread <= 0) return flat;
    const q = Math.round(Math.max(-1, Math.min(1, k)) * 48);
    let v = cache.get(q);
    if (v === undefined) {
      const kk = q / 48;
      v = hslToRgbStr(h + kk * spread, s, Math.max(0.18, Math.min(0.9, l + kk * 0.07)));
      cache.set(q, v);
    }
    return v;
  };
}

/** Deterministic 0..1 hash — stable per (a,b) across frames and resizes. */
function hash2(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

interface Particle {
  x: number; y: number;
  /** Ambient drift velocity — never decays, so motion is perpetual. */
  bvx: number; bvy: number;
  /** Mouse-induced impulse — decays back to zero each frame. */
  ix: number; iy: number;
  size: number;
}
interface Orb {
  baseX: number; baseY: number; r: number;
  phase: number; phaseY: number; speed: number;
  /** Ellipse deformation + spin, so an orb is a drifting cloud, not a disc. */
  squash: number; spin: number; spinPhase: number;
  /** Hue position in [-1,1]. */
  k: number;
  /** Cursor displacement, eased back to zero. */
  ox: number; oy: number;
}
interface Star { x: number; y: number; size: number; phase: number; twinkleSpeed: number; bright: boolean; }
interface Shooter { x: number; y: number; vx: number; vy: number; len: number; life: number; }
interface Wave { yFrac: number; amp: number; len: number; phase: number; speed: number; width: number; alpha: number; }
interface Firefly {
  x: number; y: number; size: number;
  phase: number; phaseY: number; driftSpeed: number;
  pulseSpeed: number; pulsePhase: number;
}
interface Boid { x: number; y: number; vx: number; vy: number; size: number; }
interface Curtain {
  xFrac: number; width: number; amp: number; phase: number;
  speed: number; height: number; k: number; shimmer: number;
}
interface MatrixCol {
  /** Head position in rows (fractional). */
  y: number;
  speed: number;
  len: number;
  glyphs: string[];
  k: number;
}
interface Ridge {
  /** 0 = furthest, 1 = nearest. Drives parallax, height and alpha. */
  depth: number;
  offset: number;
  k: number;
  harmonics: { amp: number; freq: number; phase: number }[];
}
interface Fish {
  x: number; y: number; vx: number; vy: number;
  size: number; k: number;
  phase: number; rate: number;
  joints: { x: number; y: number }[];
}
interface CanvasData {
  t: number;
  particles?: Particle[];
  orbs?: Orb[];
  stars?: Star[];
  shooters?: Shooter[];
  waves?: Wave[];
  fireflies?: Firefly[];
  boids?: Boid[];
  curtains?: Curtain[];
  matrix?: MatrixCol[];
  ridges?: Ridge[];
  fish?: Fish[];
  /** Topography: reusable scalar field, sized to the sample grid. */
  field?: Float32Array;
  fieldW?: number;
  fieldH?: number;
  fieldStep?: number;
  /** Matrix: glyph cell size in px. */
  cell?: number;
  /** Puzzle: piece size and shared edge signs. */
  pieceSize?: number;
  edgeH?: Int8Array;
  edgeV?: Int8Array;
  cols?: number;
  rows?: number;
  nextShoot?: number;
}

const CANVAS_EFFECTS = [
  "particles", "orbs", "stars", "shooting", "waves", "fireflies", "boids",
  "aurora", "matrix", "topography", "puzzle", "mountains", "fish",
];

const MATRIX_GLYPHS = "アカサタナハマヤラワイキシチニヒミリヰウクスツヌフムユルエケセテネヘメレヱオコソトノホモヨロヲ0123456789ABCDEFXYZ<>=*+-/|".split("");

export function BackgroundEffect() {
  const theme = useApp((s) => s.theme);
  const effect = theme.backgroundEffect ?? "none";
  const speed = theme.effectSpeed ?? 1.0;
  const density = theme.effectDensity ?? 60;
  const opacity = theme.effectOpacity ?? 0.5;
  const hueSpread = theme.effectHue ?? 0;
  const colorHex = !theme.effectColor || theme.effectColor === "accent" ? theme.accent : theme.effectColor;

  const mouseRef = useRef({ x: 0.5, y: 0.5 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const dataRef = useRef<CanvasData>({ t: 0 });

  // Smoothed CSS state for the grid
  const [cssAnim, setCssAnim] = useState({ mx: 0, my: 0 });

  // Global mouse tracking
  useEffect(() => {
    function onMove(e: MouseEvent) {
      mouseRef.current = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // Smoothed RAF loop for CSS effects only
  useEffect(() => {
    if (effect !== "grid") return;
    let raf: number;
    const sm = { x: 0.5, y: 0.5 };
    function tick() {
      const m = mouseRef.current;
      sm.x += (m.x - sm.x) * 0.045;
      sm.y += (m.y - sm.y) * 0.045;
      setCssAnim({ mx: (sm.x - 0.5) * 28, my: (sm.y - 0.5) * 16 });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [effect]);

  // Canvas animation loop
  useEffect(() => {
    if (!CANVAS_EFFECTS.includes(effect)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rgb = hexToRgb(colorHex);
    const tint = makeTint(colorHex, hueSpread);

    function init() {
      const w = canvas!.width, h = canvas!.height;
      if (effect === "particles") {
        const count = Math.max(20, Math.min(150, Math.round(density * 0.8)));
        dataRef.current.particles = Array.from({ length: count }, () => {
          // Give every particle a perpetual drift direction so the field stays
          // alive on its own; the mouse only adds a decaying impulse on top.
          const ang = Math.random() * Math.PI * 2;
          const sp = 0.15 + Math.random() * 0.28;
          return {
            x: Math.random() * w, y: Math.random() * h,
            bvx: Math.cos(ang) * sp, bvy: Math.sin(ang) * sp,
            ix: 0, iy: 0,
            size: Math.random() * 2.2 + 0.8,
          };
        });
      } else if (effect === "orbs") {
        const count = Math.max(4, Math.min(11, Math.round(density / 9)));
        dataRef.current.orbs = Array.from({ length: count }, (_, i) => ({
          baseX: ((i + 0.5) / count) * w + (Math.random() - 0.5) * (w / count),
          baseY: Math.random() * h,
          r: w * (0.12 + Math.random() * 0.22),
          phase: Math.random() * Math.PI * 2,
          phaseY: Math.random() * Math.PI * 2,
          speed: 0.35 + Math.random() * 0.75,
          squash: 0.55 + Math.random() * 0.5,
          spin: (Math.random() < 0.5 ? -1 : 1) * (0.15 + Math.random() * 0.35),
          spinPhase: Math.random() * Math.PI * 2,
          k: count > 1 ? (i / (count - 1)) * 2 - 1 : 0,
          ox: 0, oy: 0,
        }));
      } else if (effect === "aurora") {
        const count = Math.max(3, Math.min(9, Math.round(density / 14)));
        dataRef.current.curtains = Array.from({ length: count }, (_, i) => ({
          xFrac: (i + 0.5) / count + (Math.random() - 0.5) * 0.12,
          width: w * (0.05 + Math.random() * 0.09),
          amp: w * (0.05 + Math.random() * 0.09),
          phase: Math.random() * Math.PI * 2,
          speed: 0.5 + Math.random() * 0.9,
          height: 0.55 + Math.random() * 0.4,
          k: count > 1 ? (i / (count - 1)) * 2 - 1 : 0,
          shimmer: 0.02 + Math.random() * 0.03,
        }));
      } else if (effect === "stars" || effect === "shooting") {
        const count = Math.max(40, Math.min(500, Math.round(density * 3)));
        dataRef.current.stars = Array.from({ length: count }, () => ({
          x: Math.random() * w, y: Math.random() * h,
          size: Math.random() * 2 + 0.2,
          phase: Math.random() * Math.PI * 2,
          twinkleSpeed: speed * (0.004 + Math.random() * 0.012),
          bright: Math.random() < 0.08,
        }));
        if (effect === "shooting") {
          dataRef.current.shooters = [];
          dataRef.current.nextShoot = 60 + Math.random() * 100;
        }
      } else if (effect === "waves") {
        const count = Math.max(4, Math.min(16, Math.round(density / 9)));
        dataRef.current.waves = Array.from({ length: count }, (_, i) => {
          const f = (i + 0.5) / count;
          return {
            yFrac: 0.12 + f * 0.76,
            amp: h * (0.02 + Math.random() * 0.05),
            len: w * (0.18 + Math.random() * 0.22),
            phase: Math.random() * Math.PI * 2,
            speed: 0.6 + Math.random() * 0.9,
            width: 1 + Math.random() * 1.6,
            alpha: 0.1 + (1 - Math.abs(f - 0.5) * 1.4) * 0.22,
          };
        });
      } else if (effect === "fireflies") {
        const count = Math.max(12, Math.min(120, Math.round(density * 0.7)));
        dataRef.current.fireflies = Array.from({ length: count }, () => ({
          x: Math.random() * w, y: Math.random() * h,
          size: Math.random() * 1.8 + 1,
          phase: Math.random() * Math.PI * 2,
          phaseY: Math.random() * Math.PI * 2,
          driftSpeed: 0.5 + Math.random() * 1.1,
          pulseSpeed: 0.01 + Math.random() * 0.03,
          pulsePhase: Math.random() * Math.PI * 2,
        }));
      } else if (effect === "boids") {
        const count = Math.max(20, Math.min(90, Math.round(density * 0.5)));
        dataRef.current.boids = Array.from({ length: count }, () => {
          const ang = Math.random() * Math.PI * 2;
          const sp = 1 + Math.random();
          return {
            x: Math.random() * w, y: Math.random() * h,
            vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
            size: 3.5 + Math.random() * 2.5,
          };
        });
      } else if (effect === "matrix") {
        // Higher density means finer glyphs, so more columns fit.
        const cell = Math.max(9, Math.min(26, Math.round(1800 / Math.max(20, density))));
        const cols = Math.ceil(w / cell);
        const rows = Math.ceil(h / cell);
        dataRef.current.cell = cell;
        dataRef.current.matrix = Array.from({ length: cols }, (_, i) => {
          const len = Math.round(rows * (0.25 + Math.random() * 0.55));
          return {
            y: -Math.random() * rows,
            speed: 0.08 + Math.random() * 0.22,
            len,
            glyphs: Array.from({ length: len + 4 }, () => MATRIX_GLYPHS[(Math.random() * MATRIX_GLYPHS.length) | 0]),
            k: (i / Math.max(1, cols - 1)) * 2 - 1,
          };
        });
      } else if (effect === "topography") {
        // Finer grids give rounder contours; coarse ones show visible facets.
        const step = Math.max(9, Math.min(20, Math.round(1500 / Math.max(30, density))));
        const fw = Math.ceil(w / step) + 2;
        const fh = Math.ceil(h / step) + 2;
        dataRef.current.fieldStep = step;
        dataRef.current.fieldW = fw;
        dataRef.current.fieldH = fh;
        dataRef.current.field = new Float32Array(fw * fh);
      } else if (effect === "puzzle") {
        const size = Math.max(70, Math.min(230, Math.round(13000 / Math.max(30, density))));
        const cols = Math.ceil(w / size) + 1;
        const rows = Math.ceil(h / size) + 1;
        // Edge signs are shared by the two pieces that meet on them, so a tab
        // on one side is always a matching blank on the other.
        const edgeV = new Int8Array((cols + 1) * rows);
        const edgeH = new Int8Array(cols * (rows + 1));
        for (let r = 0; r < rows; r++)
          for (let c = 0; c <= cols; c++)
            edgeV[r * (cols + 1) + c] = c === 0 || c === cols ? 0 : (hash2(c, r) > 0.5 ? 1 : -1);
        for (let r = 0; r <= rows; r++)
          for (let c = 0; c < cols; c++)
            edgeH[r * cols + c] = r === 0 || r === rows ? 0 : (hash2(c + 91.7, r + 17.3) > 0.5 ? 1 : -1);
        dataRef.current.pieceSize = size;
        dataRef.current.cols = cols;
        dataRef.current.rows = rows;
        dataRef.current.edgeV = edgeV;
        dataRef.current.edgeH = edgeH;
      } else if (effect === "mountains") {
        const count = Math.max(3, Math.min(8, Math.round(density / 24)));
        dataRef.current.ridges = Array.from({ length: count }, (_, i) => {
          const depth = count > 1 ? i / (count - 1) : 0.5;
          return {
            depth,
            offset: Math.random() * 10000,
            k: depth * 2 - 1,
            harmonics: [
              { amp: 0.16 + Math.random() * 0.1, freq: 0.4 + Math.random() * 0.4, phase: Math.random() * 10 },
              { amp: 0.08 + Math.random() * 0.06, freq: 1.1 + Math.random() * 0.8, phase: Math.random() * 10 },
              { amp: 0.035 + Math.random() * 0.03, freq: 2.7 + Math.random() * 1.6, phase: Math.random() * 10 },
              { amp: 0.014, freq: 6.2 + Math.random() * 3, phase: Math.random() * 10 },
            ],
          };
        });
        const starCount = 90;
        dataRef.current.stars = Array.from({ length: starCount }, () => ({
          x: Math.random() * w, y: Math.random() * h * 0.5,
          size: Math.random() * 1.3 + 0.3,
          phase: Math.random() * Math.PI * 2,
          twinkleSpeed: 0.006 + Math.random() * 0.014,
          bright: Math.random() < 0.12,
        }));
      } else if (effect === "fish") {
        const count = Math.max(6, Math.min(28, Math.round(density * 0.2)));
        const joints = 9;
        dataRef.current.fish = Array.from({ length: count }, (_, i) => {
          const ang = Math.random() * Math.PI * 2;
          const sp = 1 + Math.random();
          const x = Math.random() * w, y = Math.random() * h;
          const size = 8 + Math.random() * 7;
          return {
            x, y,
            vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
            size,
            k: count > 1 ? (i / (count - 1)) * 2 - 1 : 0,
            phase: Math.random() * Math.PI * 2,
            rate: 0.14 + Math.random() * 0.07,
            // Start the spine trailing straight behind the head; the follow
            // constraint bends it into shape within a few frames.
            joints: Array.from({ length: joints }, (_, j) => ({
              x: x - Math.cos(ang) * size * 0.62 * j,
              y: y - Math.sin(ang) * size * 0.62 * j,
            })),
          };
        });
      }
      dataRef.current.t = 0;
    }

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
      init();
    }

    function drawParticles() {
      const { particles, t } = dataRef.current;
      if (!particles) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const mx = mouseRef.current.x * w;
      const my = mouseRef.current.y * h;
      const repulseR = 125;
      const maxImpulse = 6;

      for (const p of particles) {
        const dx = p.x - mx, dy = p.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < repulseR && dist > 0) {
          const force = (1 - dist / repulseR) * 1.1;
          p.ix += (dx / dist) * force;
          p.iy += (dy / dist) * force;
        }
        // Impulse fades so the cursor can't permanently bank a particle.
        p.ix *= 0.92; p.iy *= 0.92;
        const im = Math.hypot(p.ix, p.iy);
        if (im > maxImpulse) { p.ix = (p.ix / im) * maxImpulse; p.iy = (p.iy / im) * maxImpulse; }

        p.x += p.bvx * speed + p.ix;
        p.y += p.bvy * speed + p.iy;

        // Bounce both the perpetual drift and any impulse off the edges so the
        // field can never be pushed off-screen.
        if (p.x < 0) { p.x = 0; p.bvx = Math.abs(p.bvx); p.ix = Math.abs(p.ix); }
        if (p.x > w) { p.x = w; p.bvx = -Math.abs(p.bvx); p.ix = -Math.abs(p.ix); }
        if (p.y < 0) { p.y = 0; p.bvy = Math.abs(p.bvy); p.iy = Math.abs(p.iy); }
        if (p.y > h) { p.y = h; p.bvy = -Math.abs(p.bvy); p.iy = -Math.abs(p.iy); }
      }

      ctx!.globalCompositeOperation = "lighter";
      const thresh = 130, thresh2 = thresh * thresh;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < thresh2) {
            ctx!.strokeStyle = `rgba(${tint((i / particles.length) * 2 - 1)},${(1 - Math.sqrt(d2) / thresh) * 0.4})`;
            ctx!.lineWidth = 0.8;
            ctx!.beginPath();
            ctx!.moveTo(particles[i].x, particles[i].y);
            ctx!.lineTo(particles[j].x, particles[j].y);
            ctx!.stroke();
          }
        }
      }
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const c = tint((i / particles.length) * 2 - 1);
        const glow = p.size * 4;
        const grad = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, glow);
        grad.addColorStop(0, `rgba(${c},0.5)`);
        grad.addColorStop(1, `rgba(${c},0)`);
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, glow, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = `rgba(${c},0.95)`;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalCompositeOperation = "source-over";
      dataRef.current.t = (t ?? 0) + 1;
    }

    // ─── Orbs ─────────────────────────────────────────────────────────────────
    // Lava-lamp clouds: each orb wanders on its own layered sines, breathes,
    // slowly rotates its deformation, and is *pushed aside* by the cursor —
    // the old version crept toward the pointer and read as a static gradient.

    function drawOrbs() {
      const { orbs, t } = dataRef.current;
      if (!orbs) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const mx = mouseRef.current.x * w;
      const my = mouseRef.current.y * h;
      const tt = (t ?? 0) + 1;
      const st = tt * speed;

      ctx!.globalCompositeOperation = "lighter";
      for (const orb of orbs) {
        // Wander on two incommensurate periods so the path never repeats
        // visibly, and let each orb slowly migrate across the screen.
        orb.baseX += Math.cos(st * 0.0007 * orb.speed + orb.phase) * 0.35 * orb.speed;
        orb.baseY += Math.sin(st * 0.0009 * orb.speed + orb.phaseY) * 0.28 * orb.speed;
        if (orb.baseX < -orb.r * 0.5) orb.baseX = w + orb.r * 0.5;
        else if (orb.baseX > w + orb.r * 0.5) orb.baseX = -orb.r * 0.5;
        if (orb.baseY < -orb.r * 0.5) orb.baseY = h + orb.r * 0.5;
        else if (orb.baseY > h + orb.r * 0.5) orb.baseY = -orb.r * 0.5;

        const wx = orb.baseX + Math.sin(st * 0.0016 * orb.speed + orb.phase) * w * 0.09
          + Math.sin(st * 0.0041 * orb.speed + orb.phaseY) * w * 0.025;
        const wy = orb.baseY + Math.cos(st * 0.0021 * orb.speed + orb.phaseY) * h * 0.11
          + Math.cos(st * 0.0053 * orb.speed + orb.phase) * h * 0.03;

        // Cursor parts the clouds: a decaying displacement away from the mouse.
        const dx = wx + orb.ox - mx, dy = wy + orb.oy - my;
        const dist = Math.hypot(dx, dy) || 1;
        const pushR = orb.r * 0.9;
        if (dist < pushR) {
          const f = (1 - dist / pushR) * 3.2;
          orb.ox += (dx / dist) * f;
          orb.oy += (dy / dist) * f;
        }
        orb.ox *= 0.97; orb.oy *= 0.97;

        const x = wx + orb.ox, y = wy + orb.oy;
        const pulse = 1
          + Math.sin(st * 0.0018 * orb.speed + orb.phaseY) * 0.16
          + Math.sin(st * 0.0037 + orb.phase) * 0.06;
        const r = orb.r * pulse;
        const sq = orb.squash + Math.sin(st * 0.0013 + orb.spinPhase) * 0.18;
        const rot = orb.spinPhase + st * 0.0004 * orb.spin;
        const c = tint(orb.k + Math.sin(st * 0.0009 + orb.phase) * 0.25);

        ctx!.save();
        ctx!.translate(x, y);
        ctx!.rotate(rot);
        ctx!.scale(1, sq);
        const grad = ctx!.createRadialGradient(0, 0, 0, 0, 0, r);
        grad.addColorStop(0, `rgba(${c},0.34)`);
        grad.addColorStop(0.35, `rgba(${c},0.16)`);
        grad.addColorStop(0.62, `rgba(${c},0.05)`);
        grad.addColorStop(1, `rgba(${c},0)`);
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(0, 0, r, 0, Math.PI * 2);
        ctx!.fill();
        // A tighter, offset core keeps the cloud from looking like a plain
        // radial gradient once two of them overlap.
        const coreR = r * 0.3;
        const cx = Math.cos(st * 0.0025 + orb.phase) * r * 0.16;
        const cy = Math.sin(st * 0.0031 + orb.phaseY) * r * 0.16;
        const core = ctx!.createRadialGradient(cx, cy, 0, cx, cy, coreR);
        core.addColorStop(0, `rgba(${c},0.22)`);
        core.addColorStop(1, `rgba(${c},0)`);
        ctx!.fillStyle = core;
        ctx!.beginPath();
        ctx!.arc(cx, cy, coreR, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.restore();
      }
      ctx!.globalCompositeOperation = "source-over";
      dataRef.current.t = tt;
    }

    // ─── Aurora ───────────────────────────────────────────────────────────────
    // Canvas curtains rather than the old animated CSS gradients: each is a
    // rippling vertical ribbon whose brightness shimmers along its length and
    // which bends away from the cursor as it passes through.

    function drawAurora() {
      const { curtains, t } = dataRef.current;
      if (!curtains) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const tt = (t ?? 0) + 1;
      const st = tt * speed;
      const mx = mouseRef.current.x * w;
      const my = mouseRef.current.y * h;
      const step = 10;
      const bendR = 240;

      ctx!.globalCompositeOperation = "lighter";
      for (const cu of curtains) {
        const c = tint(cu.k);
        const baseX = cu.xFrac * w;
        const bottom = h * cu.height;
        // Wander the whole curtain slowly sideways so the set never settles.
        const drift = Math.sin(st * 0.0006 * cu.speed + cu.phase) * w * 0.06;

        // Sample the ribbon's centre line and half-width once, then reuse for
        // both the filled body and the bright filament — stroking a very thick
        // line segment by segment beads at the joins.
        const n = Math.ceil(bottom / step) + 1;
        const cx: number[] = new Array(n);
        const hw: number[] = new Array(n);
        const glowAt: number[] = new Array(n);
        for (let i = 0; i < n; i++) {
          const y = i * step;
          const yn = y / h;
          const off =
            Math.sin(yn * 7.5 + st * 0.011 * cu.speed + cu.phase) * cu.amp +
            Math.sin(yn * 15.3 - st * 0.008 * cu.speed) * cu.amp * 0.35 +
            Math.sin(yn * 3.1 + st * 0.004) * cu.amp * 0.5;
          let x = baseX + drift + off;
          // The cursor shoulders the ribbon aside where it crosses it.
          const dx = x - mx, dy = y - my;
          const d = Math.hypot(dx, dy);
          const near = d < bendR ? 1 - d / bendR : 0;
          // Push along the actual offset direction, not its sign — a sign flip
          // snaps the ribbon sideways where it crosses the cursor's column.
          x += near * (dx / (d || 1)) * 130;
          cx[i] = x;
          hw[i] = cu.width * 0.5 * (1 - (y / bottom) * 0.4) * (1 + near * 0.35);
          glowAt[i] = near;
        }

        // Body: one polygon down the left edge and back up the right.
        ctx!.beginPath();
        for (let i = 0; i < n; i++) ctx!.lineTo(cx[i] - hw[i], i * step);
        for (let i = n - 1; i >= 0; i--) ctx!.lineTo(cx[i] + hw[i], i * step);
        ctx!.closePath();
        const body = ctx!.createLinearGradient(0, 0, 0, bottom);
        body.addColorStop(0, `rgba(${c},0)`);
        body.addColorStop(0.13, `rgba(${c},0.24)`);
        body.addColorStop(0.55, `rgba(${c},0.13)`);
        body.addColorStop(1, `rgba(${c},0)`);
        ctx!.fillStyle = body;
        ctx!.fill();

        // Filament: a thin bright core whose shimmer travels up the curtain.
        ctx!.lineWidth = 1.6;
        for (let i = 0; i < n - 1; i++) {
          const y = i * step;
          const yn = y / h;
          const fade = Math.min(1, y / (h * 0.16)) * (1 - y / bottom) ** 1.2;
          const shimmer = 0.5 + 0.5 * Math.sin(yn * 24 - st * cu.shimmer + cu.phase);
          const a = fade * shimmer * 0.55 * (1 + glowAt[i]);
          if (a <= 0.01) continue;
          ctx!.strokeStyle = `rgba(${c},${Math.min(1, a)})`;
          ctx!.beginPath();
          ctx!.moveTo(cx[i], y);
          ctx!.lineTo(cx[i + 1], y + step);
          ctx!.stroke();
        }
      }
      ctx!.globalCompositeOperation = "source-over";
      dataRef.current.t = tt;
    }

    function drawStars() {
      const { stars, t } = dataRef.current;
      if (!stars) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const tt = (t ?? 0) + 1;
      const pxBase = (mouseRef.current.x - 0.5) * 18;
      const pyBase = (mouseRef.current.y - 0.5) * 10;

      for (let i = 0; i < stars.length; i++) {
        const star = stars[i];
        const c = tint(hash2(i, 3) * 2 - 1);
        const depth = star.size / 2.2;
        const a = (Math.sin(tt * star.twinkleSpeed + star.phase) + 1) * 0.35 + 0.1;
        const x = star.x + pxBase * depth;
        const y = star.y + pyBase * depth;
        if (star.bright) {
          ctx!.globalCompositeOperation = "lighter";
          const glow = star.size * 5;
          const grad = ctx!.createRadialGradient(x, y, 0, x, y, glow);
          grad.addColorStop(0, `rgba(${c},${a * 0.8})`);
          grad.addColorStop(1, `rgba(${c},0)`);
          ctx!.fillStyle = grad;
          ctx!.beginPath();
          ctx!.arc(x, y, glow, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.globalCompositeOperation = "source-over";
        }
        ctx!.fillStyle = `rgba(${c},${a})`;
        ctx!.beginPath();
        ctx!.arc(x, y, star.size, 0, Math.PI * 2);
        ctx!.fill();
      }
      dataRef.current.t = tt;
    }

    function drawShooting() {
      const { stars, shooters, t } = dataRef.current;
      if (!stars) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const tt = (t ?? 0) + 1;
      const pxBase = (mouseRef.current.x - 0.5) * 12;
      const pyBase = (mouseRef.current.y - 0.5) * 7;

      for (let i = 0; i < stars.length; i++) {
        const star = stars[i];
        const depth = star.size / 2.2;
        const a = (Math.sin(tt * star.twinkleSpeed + star.phase) + 1) * 0.28 + 0.07;
        ctx!.fillStyle = `rgba(${tint(hash2(i, 5) * 2 - 1)},${a})`;
        ctx!.beginPath();
        ctx!.arc(star.x + pxBase * depth, star.y + pyBase * depth, star.size, 0, Math.PI * 2);
        ctx!.fill();
      }

      const spawnRate = (55 / speed) + Math.random() * 70;
      dataRef.current.nextShoot = (dataRef.current.nextShoot ?? spawnRate) - 1;
      if (dataRef.current.nextShoot <= 0) {
        const spd = speed * (5 + Math.random() * 7);
        const angle = Math.PI / 6 + Math.random() * (Math.PI / 6);
        // Spawn anywhere across the top so meteors streak the whole sky,
        // independent of where the cursor happens to be.
        const spawnX = Math.random() * w * 0.9;
        const spawnY = Math.random() * h * 0.4;
        dataRef.current.shooters!.push({
          x: spawnX, y: spawnY,
          vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
          len: 60 + Math.random() * 120, life: 1.0,
        });
        dataRef.current.nextShoot = spawnRate;
      }

      ctx!.globalCompositeOperation = "lighter";
      for (let i = (shooters ?? []).length - 1; i >= 0; i--) {
        const s = shooters![i];
        const c = tint(1 - s.life * 2);
        const hyp = Math.hypot(s.vx, s.vy);
        const tailX = s.x - (s.vx / hyp) * s.len * s.life;
        const tailY = s.y - (s.vy / hyp) * s.len * s.life;
        const grad = ctx!.createLinearGradient(s.x, s.y, tailX, tailY);
        grad.addColorStop(0, `rgba(${c},${s.life * 0.95})`);
        grad.addColorStop(0.4, `rgba(${c},${s.life * 0.35})`);
        grad.addColorStop(1, `rgba(${c},0)`);
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = 2 * s.life;
        ctx!.lineCap = "round";
        ctx!.beginPath();
        ctx!.moveTo(s.x, s.y);
        ctx!.lineTo(tailX, tailY);
        ctx!.stroke();
        // Glowing head.
        const headR = 4 * s.life;
        const hg = ctx!.createRadialGradient(s.x, s.y, 0, s.x, s.y, headR);
        hg.addColorStop(0, `rgba(${c},${s.life})`);
        hg.addColorStop(1, `rgba(${c},0)`);
        ctx!.fillStyle = hg;
        ctx!.beginPath();
        ctx!.arc(s.x, s.y, headR, 0, Math.PI * 2);
        ctx!.fill();
        s.x += s.vx; s.y += s.vy;
        s.life -= 0.016;
        if (s.life <= 0 || s.x > w + 120 || s.y > h + 120) shooters!.splice(i, 1);
      }
      ctx!.globalCompositeOperation = "source-over";
      dataRef.current.t = tt;
    }

    function drawWaves() {
      const { waves, t } = dataRef.current;
      if (!waves) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const tt = (t ?? 0) + 1;
      const mShift = (mouseRef.current.y - 0.5) * h * 0.08;

      ctx!.globalCompositeOperation = "lighter";
      for (let i = 0; i < waves.length; i++) {
        const wv = waves[i];
        const baseY = wv.yFrac * h + mShift * (wv.yFrac - 0.5) * 2;
        ctx!.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const y = baseY
            + Math.sin(x / wv.len + tt * 0.01 * wv.speed * speed + wv.phase) * wv.amp
            + Math.sin(x / (wv.len * 0.5) + tt * 0.013 * wv.speed * speed) * wv.amp * 0.3;
          if (x === 0) ctx!.moveTo(x, y);
          else ctx!.lineTo(x, y);
        }
        ctx!.strokeStyle = `rgba(${tint((i / Math.max(1, waves.length - 1)) * 2 - 1)},${wv.alpha})`;
        ctx!.lineWidth = wv.width;
        ctx!.stroke();
      }
      ctx!.globalCompositeOperation = "source-over";
      dataRef.current.t = tt;
    }

    function drawFireflies() {
      const { fireflies, t } = dataRef.current;
      if (!fireflies) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const tt = (t ?? 0) + 1;
      const mx = mouseRef.current.x * w;
      const my = mouseRef.current.y * h;

      ctx!.globalCompositeOperation = "lighter";
      for (let i = 0; i < fireflies.length; i++) {
        const f = fireflies[i];
        const c = tint(hash2(i, 11) * 2 - 1);
        // Organic wander from layered sines.
        f.x += Math.cos(tt * 0.005 * f.driftSpeed + f.phase) * 0.6 * speed;
        f.y += Math.sin(tt * 0.006 * f.driftSpeed + f.phaseY) * 0.6 * speed;
        // Gentle, gravity-like pull toward the cursor — never enough to clear
        // the screen, and they wander away again as the cursor moves on.
        const dx = mx - f.x, dy = my - f.y;
        const dist = Math.hypot(dx, dy) || 1;
        if (dist < 280) {
          const pull = 0.45 * (1 - dist / 280);
          f.x += (dx / dist) * pull;
          f.y += (dy / dist) * pull;
        }
        if (f.x < -20) f.x = w + 20; else if (f.x > w + 20) f.x = -20;
        if (f.y < -20) f.y = h + 20; else if (f.y > h + 20) f.y = -20;

        const pulse = (Math.sin(tt * f.pulseSpeed + f.pulsePhase) + 1) * 0.5;
        const a = 0.12 + pulse * 0.6;
        const glow = f.size * 6;
        const grad = ctx!.createRadialGradient(f.x, f.y, 0, f.x, f.y, glow);
        grad.addColorStop(0, `rgba(${c},${a})`);
        grad.addColorStop(0.4, `rgba(${c},${a * 0.3})`);
        grad.addColorStop(1, `rgba(${c},0)`);
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(f.x, f.y, glow, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = `rgba(${c},${0.5 + pulse * 0.5})`;
        ctx!.beginPath();
        ctx!.arc(f.x, f.y, f.size, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalCompositeOperation = "source-over";
      dataRef.current.t = tt;
    }

    function drawBoids() {
      const { boids, t } = dataRef.current;
      if (!boids) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const mx = mouseRef.current.x * w;
      const my = mouseRef.current.y * h;
      const maxSpeed = 2.4 * speed;
      const minSpeed = maxSpeed * 0.5;
      const maxForce = 0.05 * speed;
      const percep2 = 64 * 64;
      const sep2 = 26 * 26;
      const fleeR = 130;

      for (const b of boids) {
        let alignX = 0, alignY = 0, cohX = 0, cohY = 0, sepX = 0, sepY = 0;
        let n = 0, sn = 0;
        for (const o of boids) {
          if (o === b) continue;
          const dx = b.x - o.x, dy = b.y - o.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < percep2) {
            alignX += o.vx; alignY += o.vy;
            cohX += o.x; cohY += o.y;
            n++;
            if (d2 < sep2 && d2 > 0) { sepX += dx / d2; sepY += dy / d2; sn++; }
          }
        }

        let ax = 0, ay = 0;
        if (n > 0) {
          // Alignment: steer toward the average heading of neighbours.
          let al = Math.hypot(alignX, alignY) || 1;
          ax += ((alignX / al) * maxSpeed - b.vx) * 0.6;
          ay += ((alignY / al) * maxSpeed - b.vy) * 0.6;
          // Cohesion: steer toward the local centre of mass.
          let cx = cohX / n - b.x, cy = cohY / n - b.y;
          const cl = Math.hypot(cx, cy) || 1;
          ax += ((cx / cl) * maxSpeed - b.vx) * 0.5;
          ay += ((cy / cl) * maxSpeed - b.vy) * 0.5;
        }
        if (sn > 0) {
          // Separation: steer away from crowding.
          const sl = Math.hypot(sepX, sepY) || 1;
          ax += ((sepX / sl) * maxSpeed - b.vx) * 1.1;
          ay += ((sepY / sl) * maxSpeed - b.vy) * 1.1;
        }
        const af = Math.hypot(ax, ay);
        if (af > maxForce) { ax = (ax / af) * maxForce; ay = (ay / af) * maxForce; }
        b.vx += ax; b.vy += ay;

        // Flee the cursor like a predator — a stronger, separately-capped force.
        const dmx = b.x - mx, dmy = b.y - my;
        const dm2 = dmx * dmx + dmy * dmy;
        if (dm2 < fleeR * fleeR && dm2 > 0) {
          const dm = Math.sqrt(dm2);
          const f = (1 - dm / fleeR) * maxForce * 6;
          b.vx += (dmx / dm) * f;
          b.vy += (dmy / dm) * f;
        }

        // Clamp speed into a band so the flock keeps cruising without stalling.
        const sp = Math.hypot(b.vx, b.vy) || 1;
        if (sp > maxSpeed) { b.vx = (b.vx / sp) * maxSpeed; b.vy = (b.vy / sp) * maxSpeed; }
        else if (sp < minSpeed) { b.vx = (b.vx / sp) * minSpeed; b.vy = (b.vy / sp) * minSpeed; }

        b.x += b.vx; b.y += b.vy;
        // Wrap around the edges so the flock streams seamlessly.
        if (b.x < 0) b.x += w; else if (b.x > w) b.x -= w;
        if (b.y < 0) b.y += h; else if (b.y > h) b.y -= h;
      }

      ctx!.globalCompositeOperation = "lighter";
      for (let i = 0; i < boids.length; i++) {
        const b = boids[i];
        ctx!.fillStyle = `rgba(${tint((i / Math.max(1, boids.length - 1)) * 2 - 1)},0.85)`;
        const ang = Math.atan2(b.vy, b.vx);
        const s = b.size;
        ctx!.save();
        ctx!.translate(b.x, b.y);
        ctx!.rotate(ang);
        ctx!.beginPath();
        ctx!.moveTo(s * 1.7, 0);
        ctx!.lineTo(-s, s * 0.72);
        ctx!.lineTo(-s * 0.5, 0);
        ctx!.lineTo(-s, -s * 0.72);
        ctx!.closePath();
        ctx!.fill();
        ctx!.restore();
      }
      ctx!.globalCompositeOperation = "source-over";
      dataRef.current.t = (t ?? 0) + 1;
    }

    // ─── Matrix rain ──────────────────────────────────────────────────────────
    // Trails are drawn explicitly (alpha falling off behind the head) rather
    // than by painting a translucent black rect over the canvas each frame —
    // the canvas sits over the app's own background and must stay transparent.

    function drawMatrix() {
      const { matrix, cell, t } = dataRef.current;
      if (!matrix || !cell) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const tt = (t ?? 0) + 1;
      const rows = Math.ceil(h / cell) + 2;
      const mCol = (mouseRef.current.x * w) / cell;
      const mRow = (mouseRef.current.y * h) / cell;

      ctx!.font = `${cell - 1}px "Cascadia Mono", "Consolas", ui-monospace, monospace`;
      ctx!.textBaseline = "top";
      ctx!.globalCompositeOperation = "lighter";

      for (let ci = 0; ci < matrix.length; ci++) {
        const col = matrix[ci];
        // Columns under the cursor run hotter and faster — the pointer leaves a
        // burning wake through the rain.
        const near = Math.max(0, 1 - Math.abs(ci - mCol) / 7);
        col.y += col.speed * speed * (1 + near * 1.4);
        if (col.y - col.len > rows) {
          col.y = -Math.random() * rows * 0.6;
          col.speed = 0.08 + Math.random() * 0.22;
        }
        // Flicker: retype one glyph per column per frame.
        col.glyphs[(Math.random() * col.glyphs.length) | 0] =
          MATRIX_GLYPHS[(Math.random() * MATRIX_GLYPHS.length) | 0];

        const c = tint(col.k);
        const head = Math.floor(col.y);
        const x = ci * cell;
        for (let i = 0; i < col.len; i++) {
          const row = head - i;
          if (row < 0 || row > rows) continue;
          const fall = 1 - i / col.len;
          let a = fall * fall * 0.85 + near * 0.15;
          if (i === 0) a = Math.min(1, a + 0.45);
          if (a < 0.02) continue;
          // A glyph belongs to its cell, not to the head, so the column reads
          // as text scrolling past rather than a moving sprite.
          const g = col.glyphs[((row % col.glyphs.length) + col.glyphs.length) % col.glyphs.length];
          const glow = Math.max(0, 1 - Math.abs(row - mRow) / 8) * near;
          ctx!.fillStyle = i === 0
            ? `rgba(255,255,255,${a * 0.8})`
            : `rgba(${c},${Math.min(1, a + glow * 0.4)})`;
          ctx!.fillText(g, x, row * cell);
        }
      }
      ctx!.globalCompositeOperation = "source-over";
      dataRef.current.t = tt;
    }

    // ─── Topography ───────────────────────────────────────────────────────────
    // A slowly morphing height field rendered as contour lines by marching
    // squares. The field is sampled once per frame into a Float32Array and every
    // contour level then walks that same grid, so the trig cost is paid once.

    function drawTopography() {
      const { field, fieldW, fieldH, fieldStep, t } = dataRef.current;
      if (!field || !fieldW || !fieldH || !fieldStep) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const tt = (t ?? 0) + 1;
      const st = tt * 0.004 * speed;
      const mx = mouseRef.current.x * w;
      const my = mouseRef.current.y * h;
      const bumpR = 130, bumpR2 = bumpR * bumpR;
      const scale = 1 / 135;

      for (let gy = 0; gy < fieldH; gy++) {
        const py = gy * fieldStep;
        const v = py * scale;
        for (let gx = 0; gx < fieldW; gx++) {
          const px = gx * fieldStep;
          const u = px * scale;
          let f =
            Math.sin(u * 0.9 + st * 0.9) * Math.cos(v * 0.8 - st * 0.62) +
            0.62 * Math.sin((u + v) * 0.55 - st * 0.5) +
            0.48 * Math.cos(u * 0.4 - v * 0.62 + st * 0.4);
          f /= 2.1;
          // The cursor pushes a hill up through the terrain, which shows as a
          // tight nest of new contour rings following the pointer.
          const dx = px - mx, dy = py - my;
          const d2 = dx * dx + dy * dy;
          if (d2 < bumpR2 * 6) f += 0.85 * Math.exp(-d2 / bumpR2);
          field[gy * fieldW + gx] = f;
        }
      }

      const levels = 11;
      ctx!.lineJoin = "round";
      for (let li = 0; li < levels; li++) {
        const lev = -1 + ((li + 0.5) / levels) * 2;
        const path = new Path2D();
        for (let gy = 0; gy < fieldH - 1; gy++) {
          const row = gy * fieldW, next = row + fieldW;
          const y0 = gy * fieldStep, y1 = y0 + fieldStep;
          for (let gx = 0; gx < fieldW - 1; gx++) {
            const a = field[row + gx], b = field[row + gx + 1];
            const c = field[next + gx + 1], d = field[next + gx];
            let code = 0;
            if (a > lev) code |= 1;
            if (b > lev) code |= 2;
            if (c > lev) code |= 4;
            if (d > lev) code |= 8;
            if (code === 0 || code === 15) continue;
            const x0 = gx * fieldStep, x1 = x0 + fieldStep;
            // Interpolated crossings on each of the cell's four edges.
            const tx = x0 + (lev - a) / (b - a) * fieldStep;   // top
            const rY = y0 + (lev - b) / (c - b) * fieldStep;   // right
            const bx = x0 + (lev - d) / (c - d) * fieldStep;   // bottom
            const lY = y0 + (lev - a) / (d - a) * fieldStep;   // left
            const seg = (ax: number, ay: number, bx2: number, by2: number) => {
              path.moveTo(ax, ay); path.lineTo(bx2, by2);
            };
            switch (code) {
              case 1: case 14: seg(tx, y0, x0, lY); break;
              case 2: case 13: seg(tx, y0, x1, rY); break;
              case 3: case 12: seg(x0, lY, x1, rY); break;
              case 4: case 11: seg(x1, rY, bx, y1); break;
              case 6: case 9:  seg(tx, y0, bx, y1); break;
              case 7: case 8:  seg(x0, lY, bx, y1); break;
              // Saddles: both crossings, resolved the same way every frame.
              case 5: seg(tx, y0, x0, lY); seg(x1, rY, bx, y1); break;
              case 10: seg(tx, y0, x1, rY); seg(x0, lY, bx, y1); break;
              default: break;
            }
          }
        }
        const index = li % 4 === 0;
        ctx!.strokeStyle = `rgba(${tint((li / (levels - 1)) * 2 - 1)},${index ? 0.5 : 0.26})`;
        ctx!.lineWidth = index ? 1.9 : 1;
        ctx!.stroke(path);
      }
      dataRef.current.t = tt;
    }

    // ─── Puzzle ───────────────────────────────────────────────────────────────

    /**
     * Traces one jigsaw edge from a→b, bulging by `sign` (0 = flat border).
     * The control points reach past the knob so it gets the pinched neck a real
     * puzzle tab has instead of a plain bump.
     */
    function jigsawEdge(ax: number, ay: number, bx: number, by: number, sign: number) {
      if (sign === 0) { ctx!.lineTo(bx, by); return; }
      const dx = bx - ax, dy = by - ay;
      const nx = -dy, ny = dx; // un-normalised normal: offsets scale with length
      const e = sign * 0.34;
      const P = (t: number, o: number): [number, number] => [ax + dx * t + nx * o, ay + dy * t + ny * o];
      ctx!.lineTo(...P(0.4, 0));
      ctx!.bezierCurveTo(...P(0.42, 0.02 * sign), ...P(0.28, e), ...P(0.5, e));
      ctx!.bezierCurveTo(...P(0.72, e), ...P(0.58, 0.02 * sign), ...P(0.6, 0));
      ctx!.lineTo(bx, by);
    }

    function drawPuzzle() {
      const { pieceSize, cols, rows, edgeH, edgeV, t } = dataRef.current;
      if (!pieceSize || !cols || !rows || !edgeH || !edgeV) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const tt = (t ?? 0) + 1;
      const st = tt * 0.01 * speed;
      const mx = mouseRef.current.x * w;
      const my = mouseRef.current.y * h;
      const s = pieceSize;
      const R = s * 2.4;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * s, y = r * s;
          const cxp = x + s / 2, cyp = y + s / 2;
          const dx = cxp - mx, dy = cyp - my;
          const dist = Math.hypot(dx, dy);
          // Pieces near the cursor lift out of the board: they scale up, tilt,
          // slide outward and light up. The falloff is squared so the effect is
          // a tight pool of raised pieces, not a vague brightening.
          const lift = dist < R ? (1 - dist / R) ** 2 : 0;
          // Even at rest a slow diagonal shimmer crosses the board.
          const idle = 0.5 + 0.5 * Math.sin((c + r) * 0.55 - st);

          const k = hash2(c, r) * 2 - 1;
          const col = tint(k * 0.6 + lift * 0.5);
          const nx = dist > 0 ? dx / dist : 0, ny = dist > 0 ? dy / dist : 0;

          ctx!.save();
          ctx!.translate(cxp + nx * lift * s * 0.05, cyp + ny * lift * s * 0.05);
          ctx!.rotate(lift * 0.06 * (hash2(c + 4.2, r + 8.1) > 0.5 ? 1 : -1));
          ctx!.scale(1 + lift * 0.05, 1 + lift * 0.05);
          ctx!.translate(-cxp, -cyp);

          ctx!.beginPath();
          ctx!.moveTo(x, y);
          jigsawEdge(x, y, x + s, y, edgeH[r * cols + c]);
          jigsawEdge(x + s, y, x + s, y + s, edgeV[r * (cols + 1) + c + 1]);
          jigsawEdge(x + s, y + s, x, y + s, -edgeH[(r + 1) * cols + c]);
          jigsawEdge(x, y + s, x, y, -edgeV[r * (cols + 1) + c]);
          ctx!.closePath();

          ctx!.fillStyle = `rgba(${col},${0.03 + idle * 0.025 + lift * 0.16})`;
          ctx!.fill();
          if (lift > 0.01) {
            // A raised piece throws a soft glow onto the ones underneath.
            ctx!.globalCompositeOperation = "lighter";
            ctx!.strokeStyle = `rgba(${col},${lift * 0.5})`;
            ctx!.lineWidth = 5 * lift;
            ctx!.stroke();
            ctx!.globalCompositeOperation = "source-over";
          }
          ctx!.strokeStyle = `rgba(${col},${0.14 + idle * 0.1 + lift * 0.6})`;
          ctx!.lineWidth = 1 + lift * 1.2;
          ctx!.stroke();
          ctx!.restore();
        }
      }
      dataRef.current.t = tt;
    }

    // ─── Mountains ────────────────────────────────────────────────────────────

    function drawMountains() {
      const { ridges, stars, t } = dataRef.current;
      if (!ridges) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const tt = (t ?? 0) + 1;
      const st = tt * speed;
      const mxn = mouseRef.current.x - 0.5;
      const myn = mouseRef.current.y - 0.5;

      // Sky: a slow celestial body tracks across, dipping toward the horizon.
      const dayPhase = st * 0.00012;
      const sunX = w * (0.5 + Math.sin(dayPhase) * 0.42) - mxn * 20;
      const sunY = h * (0.34 - Math.cos(dayPhase) * 0.2) - myn * 12;
      const sunC = tint(Math.sin(dayPhase) * 0.9);
      ctx!.globalCompositeOperation = "lighter";
      const halo = ctx!.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.5);
      halo.addColorStop(0, `rgba(${sunC},0.3)`);
      halo.addColorStop(0.12, `rgba(${sunC},0.12)`);
      halo.addColorStop(1, `rgba(${sunC},0)`);
      ctx!.fillStyle = halo;
      ctx!.fillRect(0, 0, w, h);
      ctx!.fillStyle = `rgba(${sunC},0.55)`;
      ctx!.beginPath();
      ctx!.arc(sunX, sunY, h * 0.045, 0, Math.PI * 2);
      ctx!.fill();

      if (stars) {
        for (let i = 0; i < stars.length; i++) {
          const s = stars[i];
          const a = (Math.sin(tt * s.twinkleSpeed + s.phase) + 1) * 0.2 + 0.06;
          ctx!.fillStyle = `rgba(${tint(hash2(i, 7) * 2 - 1)},${a})`;
          ctx!.beginPath();
          ctx!.arc(s.x - mxn * 10, s.y - myn * 6, s.size, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
      ctx!.globalCompositeOperation = "source-over";

      // Ridges, furthest first. Each layer drifts at its own rate and parallaxes
      // against the cursor, so moving the mouse opens depth between them.
      const step = 6;
      for (const ridge of ridges) {
        const d = ridge.depth;
        const parallax = mxn * (12 + d * 90);
        const drift = st * (0.05 + d * 0.28);
        const horizon = h * (0.34 + d * 0.4) - myn * (10 + d * 40);
        const scaleY = h * (0.5 + d * 0.55);
        const c = tint(ridge.k);

        ctx!.beginPath();
        ctx!.moveTo(-10, h + 10);
        for (let x = -10; x <= w + 10; x += step) {
          const u = (x + parallax + drift + ridge.offset) / w;
          let y = 0;
          for (const hm of ridge.harmonics) y += Math.sin(u * hm.freq * 6.283 + hm.phase) * hm.amp;
          // Breathe the peaks very slightly so a still cursor isn't a still image.
          y *= 1 + Math.sin(st * 0.0009 + ridge.offset) * 0.04;
          ctx!.lineTo(x, horizon - y * scaleY);
        }
        ctx!.lineTo(w + 10, h + 10);
        ctx!.closePath();

        const grad = ctx!.createLinearGradient(0, horizon - scaleY * 0.3, 0, h);
        grad.addColorStop(0, `rgba(${c},${0.1 + d * 0.3})`);
        grad.addColorStop(1, `rgba(${c},${0.02 + d * 0.08})`);
        ctx!.fillStyle = grad;
        ctx!.fill();
        ctx!.strokeStyle = `rgba(${c},${0.22 + d * 0.4})`;
        ctx!.lineWidth = 1 + d;
        ctx!.stroke();

        // Mist collecting in front of each ridge separates the layers. It has
        // to fade in *and* out — a band that starts at full alpha draws a hard
        // horizontal line straight across the screen.
        ctx!.globalCompositeOperation = "lighter";
        const top = horizon - h * 0.04, band = h * 0.16;
        const mist = ctx!.createLinearGradient(0, top, 0, top + band);
        mist.addColorStop(0, `rgba(${c},0)`);
        mist.addColorStop(0.35, `rgba(${c},${0.05 + d * 0.045})`);
        mist.addColorStop(1, `rgba(${c},0)`);
        ctx!.fillStyle = mist;
        ctx!.fillRect(0, top, w, band);
        ctx!.globalCompositeOperation = "source-over";
      }
      dataRef.current.t = tt;
    }

    // ─── Fish ─────────────────────────────────────────────────────────────────
    // Each fish is a chain of joints that follow the head at a fixed spacing
    // (with a turn limit so it can't fold back on itself). The head weaves side
    // to side as it swims and the body inherits that as a travelling wave — no
    // per-joint animation, the motion falls out of the constraint. Fins and tail
    // are hung off the joints, so they bank with the body for free.

    const FISH_PROFILE = [0.34, 0.5, 0.55, 0.52, 0.44, 0.35, 0.26, 0.17, 0.1];

    function drawFish() {
      const { fish, t } = dataRef.current;
      if (!fish) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const tt = (t ?? 0) + 1;
      const mx = mouseRef.current.x * w;
      const my = mouseRef.current.y * h;
      const maxSpeed = 1.9 * speed;
      const minSpeed = maxSpeed * 0.55;
      const maxForce = 0.045 * speed;
      const percep2 = 130 * 130;
      const sep2 = 42 * 42;
      const fleeR = 190;

      for (const f of fish) {
        let alignX = 0, alignY = 0, cohX = 0, cohY = 0, sepX = 0, sepY = 0;
        let n = 0, sn = 0;
        for (const o of fish) {
          if (o === f) continue;
          const dx = f.x - o.x, dy = f.y - o.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < percep2) {
            alignX += o.vx; alignY += o.vy;
            cohX += o.x; cohY += o.y;
            n++;
            if (d2 < sep2 && d2 > 0) { sepX += dx / d2; sepY += dy / d2; sn++; }
          }
        }
        let ax = 0, ay = 0;
        if (n > 0) {
          const al = Math.hypot(alignX, alignY) || 1;
          ax += ((alignX / al) * maxSpeed - f.vx) * 0.5;
          ay += ((alignY / al) * maxSpeed - f.vy) * 0.5;
          const cx = cohX / n - f.x, cy = cohY / n - f.y;
          const cl = Math.hypot(cx, cy) || 1;
          ax += ((cx / cl) * maxSpeed - f.vx) * 0.35;
          ay += ((cy / cl) * maxSpeed - f.vy) * 0.35;
        }
        if (sn > 0) {
          const sl = Math.hypot(sepX, sepY) || 1;
          ax += ((sepX / sl) * maxSpeed - f.vx) * 1.2;
          ay += ((sepY / sl) * maxSpeed - f.vy) * 1.2;
        }
        const af = Math.hypot(ax, ay);
        if (af > maxForce) { ax = (ax / af) * maxForce; ay = (ay / af) * maxForce; }
        f.vx += ax; f.vy += ay;

        // Cursor is a predator: a hard dart away, not a drift.
        const dmx = f.x - mx, dmy = f.y - my;
        const dm2 = dmx * dmx + dmy * dmy;
        let startle = 0;
        if (dm2 < fleeR * fleeR && dm2 > 0) {
          const dm = Math.sqrt(dm2);
          startle = 1 - dm / fleeR;
          const force = startle * maxForce * 9;
          f.vx += (dmx / dm) * force;
          f.vy += (dmy / dm) * force;
        }

        const cap = maxSpeed * (1 + startle * 1.6);
        const sp = Math.hypot(f.vx, f.vy) || 1;
        if (sp > cap) { f.vx = (f.vx / sp) * cap; f.vy = (f.vy / sp) * cap; }
        else if (sp < minSpeed) { f.vx = (f.vx / sp) * minSpeed; f.vy = (f.vy / sp) * minSpeed; }

        // Swim: the head tracks a heading that weaves around the travel
        // direction — faster and wider when startled.
        const cruise = Math.hypot(f.vx, f.vy);
        const beat = f.rate * speed * (0.6 + cruise / maxSpeed) * (1 + startle * 1.5);
        f.phase += beat;
        const heading = Math.atan2(f.vy, f.vx) + Math.sin(f.phase) * 0.28 * (1 + startle);
        f.x += Math.cos(heading) * cruise;
        f.y += Math.sin(heading) * cruise;

        // Wrap, carrying the whole spine so the body never stretches across.
        let wx = 0, wy = 0;
        if (f.x < -40) wx = w + 80; else if (f.x > w + 40) wx = -(w + 80);
        if (f.y < -40) wy = h + 80; else if (f.y > h + 40) wy = -(h + 80);
        if (wx || wy) {
          f.x += wx; f.y += wy;
          for (const j of f.joints) { j.x += wx; j.y += wy; }
        }

        // Follow constraint down the spine.
        const seg = f.size * 0.62;
        f.joints[0].x = f.x; f.joints[0].y = f.y;
        let prevAng = heading;
        for (let i = 1; i < f.joints.length; i++) {
          const a = f.joints[i - 1], b = f.joints[i];
          let ang = Math.atan2(b.y - a.y, b.x - a.x);
          // Limit the bend between consecutive segments, which is what stops a
          // sharp turn from crumpling the body into a knot.
          const back = prevAng + Math.PI;
          let diff = ang - back;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const lim = 0.42;
          if (diff > lim) ang = back + lim;
          else if (diff < -lim) ang = back - lim;
          b.x = a.x + Math.cos(ang) * seg;
          b.y = a.y + Math.sin(ang) * seg;
          prevAng = ang + Math.PI;
        }
      }

      ctx!.globalCompositeOperation = "lighter";
      ctx!.lineJoin = "round";
      for (const f of fish) {
        const c = tint(f.k);
        const js = f.joints;
        const nJ = js.length;

        // Forward direction and side normal at every joint.
        const fx: number[] = [], fy: number[] = [];
        for (let i = 0; i < nJ; i++) {
          const a = i === 0 ? js[0] : js[i - 1];
          const b = i === 0 ? js[1] : js[i];
          const dx = a.x - b.x, dy = a.y - b.y;
          const l = Math.hypot(dx, dy) || 1;
          fx.push(dx / l); fy.push(dy / l);
        }
        const wAt = (i: number) => FISH_PROFILE[Math.min(i, FISH_PROFILE.length - 1)] * f.size;

        // Body outline: down one flank, around the tail, back up the other.
        ctx!.beginPath();
        ctx!.moveTo(js[0].x + fx[0] * f.size * 0.5, js[0].y + fy[0] * f.size * 0.5);
        for (let i = 0; i < nJ; i++) {
          const ww = wAt(i);
          ctx!.lineTo(js[i].x - fy[i] * ww, js[i].y + fx[i] * ww);
        }
        for (let i = nJ - 1; i >= 0; i--) {
          const ww = wAt(i);
          ctx!.lineTo(js[i].x + fy[i] * ww, js[i].y - fx[i] * ww);
        }
        ctx!.closePath();
        ctx!.fillStyle = `rgba(${c},0.4)`;
        ctx!.fill();
        ctx!.strokeStyle = `rgba(${c},0.75)`;
        ctx!.lineWidth = 1.1;
        ctx!.stroke();

        // Caudal fin: two lobes trailing the last joint, swept by the beat.
        const tailI = nJ - 1;
        const sway = Math.sin(f.phase - 1.1) * 0.5;
        const tx = js[tailI].x, ty = js[tailI].y;
        const tdx = fx[tailI], tdy = fy[tailI];
        const sx = Math.cos(sway) * tdx - Math.sin(sway) * tdy;
        const sy = Math.sin(sway) * tdx + Math.cos(sway) * tdy;
        const tl = f.size * 1.15;
        ctx!.beginPath();
        ctx!.moveTo(tx, ty);
        ctx!.quadraticCurveTo(
          tx - sx * tl * 0.5 - sy * f.size * 0.5, ty - sy * tl * 0.5 + sx * f.size * 0.5,
          tx - sx * tl - sy * f.size * 0.75, ty - sy * tl + sx * f.size * 0.75,
        );
        ctx!.lineTo(tx - sx * tl * 0.72, ty - sy * tl * 0.72);
        ctx!.lineTo(tx - sx * tl + sy * f.size * 0.75, ty - sy * tl - sx * f.size * 0.75);
        ctx!.quadraticCurveTo(
          tx - sx * tl * 0.5 + sy * f.size * 0.5, ty - sy * tl * 0.5 - sx * f.size * 0.5,
          tx, ty,
        );
        ctx!.closePath();
        ctx!.fillStyle = `rgba(${c},0.3)`;
        ctx!.fill();
        ctx!.strokeStyle = `rgba(${c},0.5)`;
        ctx!.stroke();

        // Pectoral pair, rowing a half-beat out of phase with the tail.
        const pi = 2;
        const row = Math.sin(f.phase * 1.6) * 0.45;
        for (const side of [1, -1]) {
          const ang = Math.atan2(fy[pi], fx[pi]) + side * (1.15 + row * side * 0.5);
          const bx = js[pi].x + fy[pi] * wAt(pi) * side;
          const by = js[pi].y - fx[pi] * wAt(pi) * side;
          ctx!.save();
          ctx!.translate(bx, by);
          ctx!.rotate(ang);
          ctx!.beginPath();
          ctx!.ellipse(-f.size * 0.42, 0, f.size * 0.5, f.size * 0.17, 0, 0, Math.PI * 2);
          ctx!.fillStyle = `rgba(${c},0.28)`;
          ctx!.fill();
          ctx!.restore();
        }

        // Eye — small, but it's what makes the shape read as a fish.
        const ex = js[0].x + fx[0] * f.size * 0.12;
        const ey = js[0].y + fy[0] * f.size * 0.12;
        ctx!.fillStyle = `rgba(255,255,255,0.55)`;
        for (const side of [1, -1]) {
          ctx!.beginPath();
          ctx!.arc(ex - fy[0] * f.size * 0.24 * side, ey + fx[0] * f.size * 0.24 * side, f.size * 0.08, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
      ctx!.globalCompositeOperation = "source-over";
      dataRef.current.t = tt;
    }

    function frame() {
      switch (effect) {
        case "particles":  drawParticles();  break;
        case "orbs":       drawOrbs();       break;
        case "aurora":     drawAurora();     break;
        case "stars":      drawStars();      break;
        case "shooting":   drawShooting();   break;
        case "waves":      drawWaves();      break;
        case "fireflies":  drawFireflies();  break;
        case "boids":      drawBoids();      break;
        case "matrix":     drawMatrix();     break;
        case "topography": drawTopography(); break;
        case "puzzle":     drawPuzzle();     break;
        case "mountains":  drawMountains();  break;
        case "fish":       drawFish();       break;
      }
      rafRef.current = requestAnimationFrame(frame);
    }

    window.addEventListener("resize", resize);
    resize();
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(rafRef.current);
    };
  }, [effect, speed, density, colorHex, hueSpread]);

  if (effect === "none") return null;

  const rgb = hexToRgb(colorHex);

  if (effect === "grid") {
    return <GridEffect rgb={rgb} opacity={opacity} speed={speed} cellSize={density} mx={cssAnim.mx} my={cssAnim.my} />;
  }

  return (
    <canvas ref={canvasRef} className="pointer-events-none fixed inset-0 z-0" style={{ opacity }} />
  );
}

// ─── Grid ─────────────────────────────────────────────────────────────────────

function GridEffect({ rgb, opacity, speed, cellSize, mx, my }: {
  rgb: string; opacity: number; speed: number; cellSize: number; mx: number; my: number;
}) {
  const cell = Math.max(15, Math.min(150, cellSize));
  const dur = (3 / speed).toFixed(2);
  const sweepDur = (7 / speed).toFixed(2);
  const bpX = ((mx * 0.35) % cell).toFixed(1);
  const bpY = ((my * 0.35) % cell).toFixed(1);

  return (
    <div className="pointer-events-none fixed inset-0 z-0" style={{ opacity }}>
      <style>{`
        @keyframes mz-grid{0%,100%{opacity:0.4;}50%{opacity:1;}}
        @keyframes mz-sweep{0%{transform:translateX(-40%);}100%{transform:translateX(140%);}}
      `}</style>
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: [
          `linear-gradient(rgba(${rgb},0.18) 1px, transparent 1px)`,
          `linear-gradient(90deg, rgba(${rgb},0.18) 1px, transparent 1px)`,
        ].join(", "),
        backgroundSize: `${cell}px ${cell}px`,
        backgroundPosition: `${bpX}px ${bpY}px`,
        animation: `mz-grid ${dur}s ease-in-out infinite`,
      }} />
      {/* A soft highlight band sweeping across, lighting up the lines it crosses. */}
      <div style={{
        position: "absolute", top: 0, bottom: 0, width: "45%",
        background: `linear-gradient(90deg, transparent, rgba(${rgb},0.12) 45%, rgba(${rgb},0.2) 50%, rgba(${rgb},0.12) 55%, transparent)`,
        mixBlendMode: "screen",
        animation: `mz-sweep ${sweepDur}s linear infinite`,
      }} />
    </div>
  );
}
