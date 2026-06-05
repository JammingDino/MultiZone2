import { useEffect, useRef, useState } from "react";
import { useApp } from "@/store/app";

function hexToRgb(hex: string): string {
  const clean = (hex.startsWith("#") ? hex.slice(1) : hex).padEnd(6, "0");
  const r = parseInt(clean.slice(0, 2), 16) || 79;
  const g = parseInt(clean.slice(2, 4), 16) || 156;
  const b = parseInt(clean.slice(4, 6), 16) || 249;
  return `${r},${g},${b}`;
}

interface Particle { x: number; y: number; vx: number; vy: number; size: number; }
interface Orb { baseX: number; baseY: number; r: number; phase: number; phaseY: number; speed: number; }
interface Star { x: number; y: number; size: number; phase: number; twinkleSpeed: number; }
interface Shooter { x: number; y: number; vx: number; vy: number; len: number; life: number; }
interface CanvasData {
  t: number;
  particles?: Particle[];
  orbs?: Orb[];
  stars?: Star[];
  shooters?: Shooter[];
  nextShoot?: number;
}

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
    const isCanvas = ["particles", "orbs", "stars", "shooting"].includes(effect);
    if (!isCanvas) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rgb = hexToRgb(colorHex);

    function init() {
      const w = canvas!.width, h = canvas!.height;
      if (effect === "particles") {
        const count = Math.max(20, Math.min(150, Math.round(density * 0.8)));
        dataRef.current.particles = Array.from({ length: count }, () => ({
          x: Math.random() * w, y: Math.random() * h,
          vx: (Math.random() - 0.5) * speed * 0.5,
          vy: (Math.random() - 0.5) * speed * 0.5,
          size: Math.random() * 2.5 + 0.5,
        }));
      } else if (effect === "orbs") {
        const count = Math.max(3, Math.min(8, Math.round(density / 12)));
        dataRef.current.orbs = Array.from({ length: count }, (_, i) => ({
          baseX: ((i + 0.5) / count) * w + (Math.random() - 0.5) * (w / count),
          baseY: Math.random() * h,
          r: w * (0.12 + Math.random() * 0.22),
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
        }));
        if (effect === "shooting") {
          dataRef.current.shooters = [];
          dataRef.current.nextShoot = 60 + Math.random() * 100;
        }
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
      const repulseR = 110;

      for (const p of particles) {
        const dx = p.x - mx, dy = p.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < repulseR && dist > 0) {
          const force = (1 - dist / repulseR) * 0.9;
          p.vx += (dx / dist) * force;
          p.vy += (dy / dist) * force;
        }
        p.vx *= 0.975; p.vy *= 0.975;
        const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        const maxSpd = speed * 1.5;
        if (spd > maxSpd) { p.vx = (p.vx / spd) * maxSpd; p.vy = (p.vy / spd) * maxSpd; }
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) { p.x = 0; p.vx = Math.abs(p.vx); }
        if (p.x > w) { p.x = w; p.vx = -Math.abs(p.vx); }
        if (p.y < 0) { p.y = 0; p.vy = Math.abs(p.vy); }
        if (p.y > h) { p.y = h; p.vy = -Math.abs(p.vy); }
      }

      const thresh = 120, thresh2 = thresh * thresh;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < thresh2) {
            ctx!.strokeStyle = `rgba(${rgb},${(1 - Math.sqrt(d2) / thresh) * 0.5})`;
            ctx!.lineWidth = 0.8;
            ctx!.beginPath();
            ctx!.moveTo(particles[i].x, particles[i].y);
            ctx!.lineTo(particles[j].x, particles[j].y);
            ctx!.stroke();
          }
        }
      }
      for (const p of particles) {
        ctx!.fillStyle = `rgba(${rgb},0.85)`;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx!.fill();
      }
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

      for (const orb of orbs) {
        orb.baseX += (mx - orb.baseX) * 0.0004 * orb.speed;
        orb.baseY += (my - orb.baseY) * 0.0004 * orb.speed;
        const x = orb.baseX + Math.sin(tt * 0.001 * orb.speed + orb.phase) * w * 0.11;
        const y = orb.baseY + Math.cos(tt * 0.0015 * orb.speed + orb.phaseY) * h * 0.13;
        const grad = ctx!.createRadialGradient(x, y, 0, x, y, orb.r);
        grad.addColorStop(0, `rgba(${rgb},0.22)`);
        grad.addColorStop(0.5, `rgba(${rgb},0.06)`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(x, y, orb.r, 0, Math.PI * 2);
        ctx!.fill();
      }
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
        ctx!.fillStyle = `rgba(${rgb},${a})`;
        ctx!.beginPath();
        ctx!.arc(star.x + pxBase * depth, star.y + pyBase * depth, star.size, 0, Math.PI * 2);
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
        const spawnX = mouseRef.current.x * w * 0.7 + Math.random() * w * 0.3;
        const spawnY = mouseRef.current.y * h * 0.4 + Math.random() * h * 0.15;
        dataRef.current.shooters!.push({
          x: spawnX, y: spawnY,
          vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
          len: 60 + Math.random() * 120, life: 1.0,
        });
        dataRef.current.nextShoot = spawnRate;
      }

      for (let i = (shooters ?? []).length - 1; i >= 0; i--) {
        const s = shooters![i];
        const hyp = Math.hypot(s.vx, s.vy);
        const tailX = s.x - (s.vx / hyp) * s.len * s.life;
        const tailY = s.y - (s.vy / hyp) * s.len * s.life;
        const grad = ctx!.createLinearGradient(s.x, s.y, tailX, tailY);
        grad.addColorStop(0, `rgba(${rgb},${s.life * 0.9})`);
        grad.addColorStop(0.4, `rgba(${rgb},${s.life * 0.35})`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = 2 * s.life;
        ctx!.lineCap = "round";
        ctx!.beginPath();
        ctx!.moveTo(s.x, s.y);
        ctx!.lineTo(tailX, tailY);
        ctx!.stroke();
        s.x += s.vx; s.y += s.vy;
        s.life -= 0.016;
        if (s.life <= 0 || s.x > w + 120 || s.y > h + 120) shooters!.splice(i, 1);
      }
      dataRef.current.t = tt;
    }

    function frame() {
      switch (effect) {
        case "particles": drawParticles(); break;
        case "orbs":      drawOrbs();      break;
        case "stars":     drawStars();     break;
        case "shooting":  drawShooting();  break;
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

  return (
    <div className="pointer-events-none fixed inset-0 z-0" style={{ opacity }}>
      <style>{`
        @keyframes mz-a1{0%,100%{translate:0% 0%;scale:1;}50%{translate:6% 4%;scale:1.08;}}
        @keyframes mz-a2{0%,100%{translate:0% 0%;scale:1;}50%{translate:-7% -5%;scale:1.12;}}
        @keyframes mz-a3{0%,100%{translate:0% 0%;scale:1;}50%{translate:4% -6%;scale:1.06;}}
      `}</style>
      <div style={{ position: "absolute", inset: 0, transform: `translate(${mx * 0.4}px,${my * 0.4}px)`, transition: "transform 0.1s linear" }}>
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 90% 65% at 22% 44%, rgba(${rgb},0.28) 0%, transparent 70%)`, animation: `mz-a1 ${d1}s ease-in-out infinite` }} />
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 75% 55% at 78% 58%, rgba(${rgb},0.2) 0%, transparent 70%)`, animation: `mz-a2 ${d2}s ease-in-out infinite`, transform: `translate(${mx * 0.15}px,${my * 0.15}px)` }} />
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 65% 75% at 55% 20%, rgba(${rgb},0.16) 0%, transparent 65%)`, animation: `mz-a3 ${d3}s ease-in-out infinite`, transform: `translate(${-mx * 0.1}px,${-my * 0.1}px)` }} />
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
  const bpX = ((mx * 0.35) % cell).toFixed(1);
  const bpY = ((my * 0.35) % cell).toFixed(1);

  return (
    <div className="pointer-events-none fixed inset-0 z-0" style={{ opacity }}>
      <style>{`@keyframes mz-grid{0%,100%{opacity:0.4;}50%{opacity:1;}}`}</style>
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
    </div>
  );
}
