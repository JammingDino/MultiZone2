import { useEffect, useRef, useState } from "react";
import { useApp } from "@/store/app";

function hexToRgb(hex: string): string {
  const clean = (hex.startsWith("#") ? hex.slice(1) : hex).padEnd(6, "0");
  const r = parseInt(clean.slice(0, 2), 16) || 79;
  const g = parseInt(clean.slice(2, 4), 16) || 156;
  const b = parseInt(clean.slice(4, 6), 16) || 249;
  return `${r},${g},${b}`;
}

interface Particle {
  x: number; y: number;
  /** Ambient drift velocity — never decays, so motion is perpetual. */
  bvx: number; bvy: number;
  /** Mouse-induced impulse — decays back to zero each frame. */
  ix: number; iy: number;
  size: number;
}
interface Orb { baseX: number; baseY: number; r: number; phase: number; phaseY: number; speed: number; }
interface Star { x: number; y: number; size: number; phase: number; twinkleSpeed: number; bright: boolean; }
interface Shooter { x: number; y: number; vx: number; vy: number; len: number; life: number; }
interface Wave { yFrac: number; amp: number; len: number; phase: number; speed: number; width: number; alpha: number; }
interface Firefly {
  x: number; y: number; size: number;
  phase: number; phaseY: number; driftSpeed: number;
  pulseSpeed: number; pulsePhase: number;
}
interface Boid { x: number; y: number; vx: number; vy: number; size: number; }
interface CanvasData {
  t: number;
  particles?: Particle[];
  orbs?: Orb[];
  stars?: Star[];
  shooters?: Shooter[];
  waves?: Wave[];
  fireflies?: Firefly[];
  boids?: Boid[];
  nextShoot?: number;
}

const CANVAS_EFFECTS = ["particles", "orbs", "stars", "shooting", "waves", "fireflies", "boids"];

export function BackgroundEffect() {
  const theme = useApp((s) => s.theme);
  const effect = theme.backgroundEffect ?? "none";
  const speed = theme.effectSpeed ?? 1.0;
  const density = theme.effectDensity ?? 60;
  const opacity = theme.effectOpacity ?? 0.5;
  const colorHex = !theme.effectColor || theme.effectColor === "accent" ? theme.accent : theme.effectColor;

  const mouseRef = useRef({ x: 0.5, y: 0.5 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const dataRef = useRef<CanvasData>({ t: 0 });

  // Smoothed CSS state for aurora + grid
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
    if (effect !== "aurora" && effect !== "grid") return;
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
        const count = Math.max(3, Math.min(8, Math.round(density / 12)));
        dataRef.current.orbs = Array.from({ length: count }, (_, i) => ({
          baseX: ((i + 0.5) / count) * w + (Math.random() - 0.5) * (w / count),
          baseY: Math.random() * h,
          r: w * (0.14 + Math.random() * 0.24),
          phase: Math.random() * Math.PI * 2,
          phaseY: Math.random() * Math.PI * 2,
          speed: speed * (0.2 + Math.random() * 0.5),
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
            ctx!.strokeStyle = `rgba(${rgb},${(1 - Math.sqrt(d2) / thresh) * 0.4})`;
            ctx!.lineWidth = 0.8;
            ctx!.beginPath();
            ctx!.moveTo(particles[i].x, particles[i].y);
            ctx!.lineTo(particles[j].x, particles[j].y);
            ctx!.stroke();
          }
        }
      }
      for (const p of particles) {
        const glow = p.size * 4;
        const grad = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, glow);
        grad.addColorStop(0, `rgba(${rgb},0.5)`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, glow, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = `rgba(${rgb},0.95)`;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalCompositeOperation = "source-over";
      dataRef.current.t = (t ?? 0) + 1;
    }

    function drawOrbs() {
      const { orbs, t } = dataRef.current;
      if (!orbs) return;
      const w = canvas!.width, h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);

      const mx = mouseRef.current.x * w;
      const my = mouseRef.current.y * h;
      const tt = (t ?? 0) + 1;

      // Additive blending makes overlapping clouds bloom into brighter cores.
      ctx!.globalCompositeOperation = "lighter";
      for (const orb of orbs) {
        orb.baseX += (mx - orb.baseX) * 0.0004 * orb.speed;
        orb.baseY += (my - orb.baseY) * 0.0004 * orb.speed;
        const x = orb.baseX + Math.sin(tt * 0.001 * orb.speed + orb.phase) * w * 0.12;
        const y = orb.baseY + Math.cos(tt * 0.0015 * orb.speed + orb.phaseY) * h * 0.14;
        const pulse = 1 + Math.sin(tt * 0.0012 * orb.speed + orb.phaseY) * 0.12;
        const r = orb.r * pulse;
        const grad = ctx!.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(${rgb},0.3)`);
        grad.addColorStop(0.5, `rgba(${rgb},0.08)`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(x, y, r, 0, Math.PI * 2);
        ctx!.fill();
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

      for (const star of stars) {
        const depth = star.size / 2.2;
        const a = (Math.sin(tt * star.twinkleSpeed + star.phase) + 1) * 0.35 + 0.1;
        const x = star.x + pxBase * depth;
        const y = star.y + pyBase * depth;
        if (star.bright) {
          ctx!.globalCompositeOperation = "lighter";
          const glow = star.size * 5;
          const grad = ctx!.createRadialGradient(x, y, 0, x, y, glow);
          grad.addColorStop(0, `rgba(${rgb},${a * 0.8})`);
          grad.addColorStop(1, `rgba(${rgb},0)`);
          ctx!.fillStyle = grad;
          ctx!.beginPath();
          ctx!.arc(x, y, glow, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.globalCompositeOperation = "source-over";
        }
        ctx!.fillStyle = `rgba(${rgb},${a})`;
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

      for (const star of stars) {
        const depth = star.size / 2.2;
        const a = (Math.sin(tt * star.twinkleSpeed + star.phase) + 1) * 0.28 + 0.07;
        ctx!.fillStyle = `rgba(${rgb},${a})`;
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
        const hyp = Math.hypot(s.vx, s.vy);
        const tailX = s.x - (s.vx / hyp) * s.len * s.life;
        const tailY = s.y - (s.vy / hyp) * s.len * s.life;
        const grad = ctx!.createLinearGradient(s.x, s.y, tailX, tailY);
        grad.addColorStop(0, `rgba(${rgb},${s.life * 0.95})`);
        grad.addColorStop(0.4, `rgba(${rgb},${s.life * 0.35})`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
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
        hg.addColorStop(0, `rgba(${rgb},${s.life})`);
        hg.addColorStop(1, `rgba(${rgb},0)`);
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
      for (const wv of waves) {
        const baseY = wv.yFrac * h + mShift * (wv.yFrac - 0.5) * 2;
        ctx!.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const y = baseY
            + Math.sin(x / wv.len + tt * 0.01 * wv.speed * speed + wv.phase) * wv.amp
            + Math.sin(x / (wv.len * 0.5) + tt * 0.013 * wv.speed * speed) * wv.amp * 0.3;
          if (x === 0) ctx!.moveTo(x, y);
          else ctx!.lineTo(x, y);
        }
        ctx!.strokeStyle = `rgba(${rgb},${wv.alpha})`;
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
      for (const f of fireflies) {
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
        grad.addColorStop(0, `rgba(${rgb},${a})`);
        grad.addColorStop(0.4, `rgba(${rgb},${a * 0.3})`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(f.x, f.y, glow, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = `rgba(${rgb},${0.5 + pulse * 0.5})`;
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
      ctx!.fillStyle = `rgba(${rgb},0.85)`;
      for (const b of boids) {
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

    function frame() {
      switch (effect) {
        case "particles": drawParticles(); break;
        case "orbs":      drawOrbs();      break;
        case "stars":     drawStars();     break;
        case "shooting":  drawShooting();  break;
        case "waves":     drawWaves();     break;
        case "fireflies": drawFireflies(); break;
        case "boids":     drawBoids();     break;
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
  }, [effect, speed, density, colorHex]);

  if (effect === "none") return null;

  const rgb = hexToRgb(colorHex);

  if (effect === "aurora") {
    return <AuroraEffect rgb={rgb} opacity={opacity} speed={speed} mx={cssAnim.mx} my={cssAnim.my} />;
  }
  if (effect === "grid") {
    return <GridEffect rgb={rgb} opacity={opacity} speed={speed} cellSize={density} mx={cssAnim.mx} my={cssAnim.my} />;
  }

  return (
    <canvas ref={canvasRef} className="pointer-events-none fixed inset-0 z-0" style={{ opacity }} />
  );
}

// ─── Aurora ───────────────────────────────────────────────────────────────────

function AuroraEffect({ rgb, opacity, speed, mx, my }: {
  rgb: string; opacity: number; speed: number; mx: number; my: number;
}) {
  const d1 = (8 / speed).toFixed(2);
  const d2 = (10.5 / speed).toFixed(2);
  const d3 = (6.5 / speed).toFixed(2);
  const d4 = (13 / speed).toFixed(2);

  return (
    <div className="pointer-events-none fixed inset-0 z-0" style={{ opacity }}>
      <style>{`
        @keyframes mz-a1{0%,100%{translate:0% 0%;scale:1;}50%{translate:6% 4%;scale:1.08;}}
        @keyframes mz-a2{0%,100%{translate:0% 0%;scale:1;}50%{translate:-7% -5%;scale:1.12;}}
        @keyframes mz-a3{0%,100%{translate:0% 0%;scale:1;}50%{translate:4% -6%;scale:1.06;}}
        @keyframes mz-a4{0%,100%{translate:0% 0%;scale:1.05;opacity:0.6;}50%{translate:-5% 7%;scale:1.15;opacity:1;}}
      `}</style>
      <div style={{ position: "absolute", inset: 0, transform: `translate(${mx * 0.4}px,${my * 0.4}px)`, transition: "transform 0.1s linear", mixBlendMode: "screen" }}>
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 90% 65% at 22% 44%, rgba(${rgb},0.30) 0%, transparent 70%)`, animation: `mz-a1 ${d1}s ease-in-out infinite` }} />
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 75% 55% at 78% 58%, rgba(${rgb},0.22) 0%, transparent 70%)`, animation: `mz-a2 ${d2}s ease-in-out infinite`, transform: `translate(${mx * 0.15}px,${my * 0.15}px)` }} />
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 65% 75% at 55% 20%, rgba(${rgb},0.18) 0%, transparent 65%)`, animation: `mz-a3 ${d3}s ease-in-out infinite`, transform: `translate(${-mx * 0.1}px,${-my * 0.1}px)` }} />
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 80% 50% at 35% 80%, rgba(${rgb},0.16) 0%, transparent 68%)`, animation: `mz-a4 ${d4}s ease-in-out infinite`, transform: `translate(${mx * 0.2}px,${-my * 0.18}px)` }} />
      </div>
    </div>
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
