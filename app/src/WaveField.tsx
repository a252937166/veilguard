import { useEffect, useRef } from 'react';

/**
 * Animated flowing "silk ribbon" background for the hero — layered sine waves that
 * undulate naturally, purple on the left fading to blue on the right, plus a drift
 * of fine particles for texture. Pure canvas, no libraries. Honors reduced-motion.
 */
export function WaveField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0, t = 0, W = 0, H = 0, dpr = 1, last = performance.now();
    const FPS = 30, minDelta = 1000 / FPS;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // Ribbon gradient reused every frame — vivid purple→blue silk.
    const ribbonGrad = () => {
      const g = ctx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0.00, 'rgba(147, 51, 234, 0)');
      g.addColorStop(0.12, 'rgba(180, 90, 255, 0.85)'); // purple
      g.addColorStop(0.34, 'rgba(150, 95, 250, 0.7)');
      g.addColorStop(0.5, 'rgba(120, 110, 255, 0.62)');
      g.addColorStop(0.66, 'rgba(90, 130, 255, 0.7)');
      g.addColorStop(0.88, 'rgba(70, 150, 255, 0.85)'); // blue
      g.addColorStop(1.00, 'rgba(37, 99, 235, 0)');
      return g;
    };

    // Drifting particles seeded once (deterministic-ish, no reliance on rng cadence).
    const P = 90;
    const parts = Array.from({ length: P }, (_, i) => ({
      x: ((i * 97.13) % 100) / 100,
      y: ((i * 53.71) % 100) / 100,
      r: 0.6 + ((i * 31.7) % 10) / 8,
      sp: 0.2 + ((i * 17.3) % 10) / 22,
      ph: (i * 0.7) % (Math.PI * 2),
    }));

    const LINES = 66;

    const frame = () => {
      ctx.clearRect(0, 0, W, H);
      const cy = H * 0.5;

      // --- flowing silk ribbon (additive glow, two passes: bloom + crisp) ---
      ctx.globalCompositeOperation = 'lighter';
      const grad = ribbonGrad();
      const step = Math.max(3, W / 320);
      const yAt = (nx: number, i: number, spread: number, edge: number) => {
        const amp = H * (0.06 + edge * 0.27);
        return (
          cy +
          Math.sin(nx * 5.2 + t * 0.5 + i * 0.13) * amp +
          Math.sin(nx * 2.4 - t * 0.33 + i * 0.19) * amp * 0.5 +
          Math.sin(nx * 8.3 + t * 0.7 + i * 0.07) * amp * 0.16 +
          spread * H * 0.13 * (0.3 + edge)
        );
      };
      for (let i = 0; i < LINES; i++) {
        const spread = i / (LINES - 1) - 0.5; // -0.5..0.5 across ribbon thickness
        ctx.beginPath();
        for (let x = 0; x <= W; x += step) {
          const nx = x / W;
          const edge = Math.pow(Math.abs(nx - 0.5) * 2, 1.7); // valley: rises toward edges
          const y = yAt(nx, i, spread, edge);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = grad;
        const core = 1 - Math.abs(spread) * 2;
        // bloom pass
        ctx.globalAlpha = (0.05 + 0.06 * core);
        ctx.lineWidth = 3.2;
        ctx.stroke();
        // crisp pass
        ctx.globalAlpha = (0.12 + 0.16 * core);
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }

      // --- drifting particles ---
      for (const p of parts) {
        const nx = (p.x + t * 0.006 * p.sp) % 1;
        const wobble = Math.sin(t * 0.4 * p.sp + p.ph) * 0.03;
        const py = (p.y + wobble + 1) % 1;
        const x = nx * W;
        const y = py * H;
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 1.3 * p.sp + p.ph));
        ctx.beginPath();
        ctx.arc(x, y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = nx < 0.5
          ? `rgba(200, 160, 255, ${0.38 * tw})`
          : `rgba(140, 185, 255, ${0.38 * tw})`;
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    // 30fps cap + time-based advance so the sway speed is frame-rate independent;
    // pauses when the tab is hidden.
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) { last = now; return; }
      const dt = now - last;
      if (dt < minDelta) return;
      last = now - (dt % minDelta);
      t += dt * 0.0006;
      frame();
    };
    frame();
    if (!reduce) raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} className="wavefield" aria-hidden="true" />;
}
