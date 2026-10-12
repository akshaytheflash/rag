"use client";

/**
 * DotField
 *
 * A cursor-reactive dot grid on a canvas. Ported from React Bits
 * (https://reactbits.dev), adapted to this project in four ways that were not
 * optional:
 *
 *  1. Typed. The original ships as untyped JSX; this repo is `strict: true`.
 *  2. Driven by the existing CSS tokens rather than a hardcoded purple, so it
 *     belongs to the same design system as everything else and inverts with
 *     the dark theme for free.
 *  3. It does not run a permanent animation loop. `requestAnimationFrame` is
 *     driven by whether the tab is visible AND whether the pointer has been
 *     near the field recently. The upstream version repaints 60 times a second
 *     forever, including behind a page of documentation prose someone is
 *     trying to read.
 *  4. It respects `prefers-reduced-motion`, and renders nothing at all when
 *     that is set - a decorative field that never moves needs no canvas.
 *
 * Licence: the upstream component is MIT. Kept in one file with the behavioural
 * differences documented rather than silently patched, so it can be diffed
 * against the original if that licence ever needs to be checked.
 */
import { memo, useEffect, useRef } from "react";

const TWO_PI = Math.PI * 2;

/** How long after the pointer leaves before the field stops drawing, in ms. */
const IDLE_STOP_MS = 900;

export interface DotFieldProps {
  dotRadius?: number;
  dotSpacing?: number;
  cursorRadius?: number;
  cursorForce?: number;
  bulgeOnly?: boolean;
  bulgeStrength?: number;
  glowRadius?: number;
  sparkle?: boolean;
  waveAmplitude?: number;
  /** CSS colour. Defaults come from the design tokens, not from upstream. */
  gradientFrom?: string;
  gradientTo?: string;
  glowColor?: string;
  className?: string;
}

interface Dot {
  ax: number;
  ay: number;
  sx: number;
  sy: number;
  vx: number;
  vy: number;
}

const DotField = memo(function DotFieldInner({
  dotRadius = 1.5,
  dotSpacing = 14,
  cursorRadius = 260,
  cursorForce = 0.1,
  bulgeOnly = true,
  bulgeStrength = 42,
  glowRadius = 150,
  sparkle = false,
  waveAmplitude = 0,
  gradientFrom,
  gradientTo,
  glowColor,
  className,
}: DotFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const dotsRef = useRef<Dot[]>([]);
  const mouseRef = useRef({ x: -9999, y: -9999, prevX: -9999, prevY: -9999, speed: 0, seen: 0 });
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, offsetX: 0, offsetY: 0 });
  const glowOpacity = useRef(0);
  const engagement = useRef(0);

  // Props live in a ref so the effect never has to re-run and rebuild the grid
  // on a change; the original does the same.
  const propsRef = useRef({
    dotRadius,
    dotSpacing,
    cursorRadius,
    cursorForce,
    bulgeOnly,
    bulgeStrength,
    sparkle,
    waveAmplitude,
    gradientFrom,
    gradientTo,
    glowColor,
  });
  propsRef.current = {
    dotRadius,
    dotSpacing,
    cursorRadius,
    cursorForce,
    bulgeOnly,
    bulgeStrength,
    sparkle,
    waveAmplitude,
    gradientFrom,
    gradientTo,
    glowColor,
  };

  // A fixed id is enough here: there is one field on the page. Upstream used
  // Math.random(), which differs between server and client and forces the
  // whole subtree to render client-side.
  const glowId = "dot-field-glow";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    // Narrowed once here. TS cannot carry a null check across the nested
    // function declarations below, and re-checking in each one would be noise.
    const ctx: CanvasRenderingContext2D = context;

    // Colours come from CSS custom properties, resolved at setup. Reading them
    // from the computed style is what lets the field follow the light/dark
    // theme without this component knowing which theme is active.
    const styles = getComputedStyle(canvas);
    const readToken = (name: string, fallback: string) => {
      const v = styles.getPropertyValue(name).trim();
      return v || fallback;
    };

    const resolveColour = (explicit: string | undefined, token: string, fallback: string) => {
      if (explicit) return explicit;
      return readToken(token, fallback);
    };

    let disposed = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let frameCount = 0;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function buildDots(w: number, h: number) {
      const p = propsRef.current;
      const step = p.dotRadius + p.dotSpacing;
      const cols = Math.floor(w / step);
      const rows = Math.floor(h / step);
      if (cols < 1 || rows < 1) {
        dotsRef.current = [];
        return;
      }
      const padX = (w % step) / 2;
      const padY = (h % step) / 2;
      const dots: Dot[] = new Array(rows * cols);
      let idx = 0;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const ax = padX + col * step + step / 2;
          const ay = padY + row * step + step / 2;
          dots[idx++] = { ax, ay, sx: ax, sy: ay, vx: 0, vy: 0 };
        }
      }
      dotsRef.current = dots;
    }

    function doResize() {
      if (disposed) return;
      const parent = canvas!.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (w === 0 || h === 0) return;

      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      sizeRef.current = {
        w,
        h,
        offsetX: rect.left + window.scrollX,
        offsetY: rect.top + window.scrollY,
      };
      buildDots(w, h);
    }

    function scheduleResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doResize, 100);
    }

    function onMouseMove(e: MouseEvent) {
      const s = sizeRef.current;
      const m = mouseRef.current;
      m.x = e.pageX - s.offsetX;
      m.y = e.pageY - s.offsetY;
      m.seen = Date.now();
    }

    function updateMouseSpeed() {
      const m = mouseRef.current;
      const dx = m.prevX - m.x;
      const dy = m.prevY - m.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      m.speed += (dist - m.speed) * 0.5;
      if (m.speed < 0.001) m.speed = 0;
      m.prevX = m.x;
      m.prevY = m.y;
    }

    function draw() {
      const dots = dotsRef.current;
      const m = mouseRef.current;
      const { w, h } = sizeRef.current;
      const p = propsRef.current;
      const len = dots.length;
      frameCount++;
      const t = frameCount * 0.02;

      const targetEngagement = Math.min(m.speed / 5, 1);
      engagement.current += (targetEngagement - engagement.current) * 0.06;
      if (engagement.current < 0.001) engagement.current = 0;
      const eng = engagement.current;

      glowOpacity.current += (eng - glowOpacity.current) * 0.08;

      const glowEl = glowRef.current;
      if (glowEl) {
        glowEl.setAttribute("cx", String(m.x));
        glowEl.setAttribute("cy", String(m.y));
        glowEl.style.opacity = String(glowOpacity.current);
      }

      ctx.clearRect(0, 0, w, h);

      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, resolveColour(p.gradientFrom, "--dot-from", "rgba(107,163,214,0.30)"));
      grad.addColorStop(1, resolveColour(p.gradientTo, "--dot-to", "rgba(107,163,214,0.12)"));
      ctx.fillStyle = grad;

      const cr = p.cursorRadius;
      const crSq = cr * cr;
      const rad = p.dotRadius / 2;
      const isBulge = p.bulgeOnly;

      ctx.beginPath();

      for (let i = 0; i < len; i++) {
        const d = dots[i];
        const dx = m.x - d.ax;
        const dy = m.y - d.ay;
        const distSq = dx * dx + dy * dy;

        if (distSq < crSq && eng > 0.01) {
          const dist = Math.sqrt(distSq);
          if (isBulge) {
            const falloff = 1 - dist / cr;
            const push = falloff * falloff * p.bulgeStrength * eng;
            const angle = Math.atan2(dy, dx);
            d.sx += (d.ax - Math.cos(angle) * push - d.sx) * 0.15;
            d.sy += (d.ay - Math.sin(angle) * push - d.sy) * 0.15;
          } else {
            const angle = Math.atan2(dy, dx);
            const move = (500 / dist) * (m.speed * p.cursorForce);
            d.vx += Math.cos(angle) * -move;
            d.vy += Math.sin(angle) * -move;
          }
        } else if (isBulge) {
          d.sx += (d.ax - d.sx) * 0.1;
          d.sy += (d.ay - d.sy) * 0.1;
        }

        if (!isBulge) {
          d.vx *= 0.9;
          d.vy *= 0.9;
          const x = d.ax + d.vx;
          const y = d.ay + d.vy;
          d.sx += (x - d.sx) * 0.1;
          d.sy += (y - d.sy) * 0.1;
        }

        let drawX = d.sx;
        let drawY = d.sy;
        if (p.waveAmplitude > 0) {
          drawY += Math.sin(d.ax * 0.03 + t) * p.waveAmplitude;
          drawX += Math.cos(d.ay * 0.03 + t * 0.7) * p.waveAmplitude * 0.5;
        }

        if (p.sparkle) {
          const hash = ((i * 2654435761) ^ (frameCount >> 3)) >>> 0;
          const r = hash % 100 < 3 ? rad * 1.8 : rad;
          ctx.moveTo(drawX + r, drawY);
          ctx.arc(drawX, drawY, r, 0, TWO_PI);
        } else {
          ctx.moveTo(drawX + rad, drawY);
          ctx.arc(drawX, drawY, rad, 0, TWO_PI);
        }
      }

      ctx.fill();
    }

    function loop() {
      draw();
      rafRef.current = requestAnimationFrame(loop);
    }

    function start() {
      if (rafRef.current === null && !disposed) {
        rafRef.current = requestAnimationFrame(loop);
      }
    }

    function stop() {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }

    // The departure from upstream. The loop runs only while it can be seen:
    // the tab is foregrounded and the pointer has been inside the field
    // recently. Otherwise this is a permanent 60fps repaint on a page whose
    // entire purpose is reading text.
    const speedInterval = setInterval(updateMouseSpeed, 20);
    const idleInterval = setInterval(() => {
      const m = mouseRef.current;
      const stale = Date.now() - m.seen > IDLE_STOP_MS;
      if (stale && m.speed === 0) {
        m.speed = 0;
        stop();
      } else {
        start();
      }
    }, 200);

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    // The field is decorative and nothing about it is conveyed by motion.
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotionChange = () => {
      if (motionQuery.matches) stop();
      else start();
    };

    doResize();
    window.addEventListener("resize", scheduleResize);
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    motionQuery.addEventListener("change", onMotionChange);

    if (motionQuery.matches) {
      // Draw one static frame so the field is present, then stay still.
      draw();
    } else {
      start();
    }

    return () => {
      disposed = true;
      stop();
      clearInterval(speedInterval);
      clearInterval(idleInterval);
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", scheduleResize);
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener("change", onMotionChange);
    };
  }, []);

  // Rebuild the grid when the spacing props change, without tearing down the
  // effect. Mirrors the upstream rebuild effect.
  useEffect(() => {
    const { w, h } = sizeRef.current;
    if (w > 0 && h > 0) {
      const p = propsRef.current;
      const step = p.dotRadius + p.dotSpacing;
      const cols = Math.floor(w / step);
      const rows = Math.floor(h / step);
      if (cols < 1 || rows < 1) {
        dotsRef.current = [];
        return;
      }
      const padX = (w % step) / 2;
      const padY = (h % step) / 2;
      const dots: Dot[] = new Array(rows * cols);
      let idx = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const ax = padX + col * step + step / 2;
          const ay = padY + row * step + step / 2;
          dots[idx++] = { ax, ay, sx: ax, sy: ay, vx: 0, vy: 0 };
        }
      }
      dotsRef.current = dots;
    }
  }, [dotRadius, dotSpacing]);

  const resolvedGlow = glowColor ?? "var(--ink)";

  return (
    <div className={`dotField${className ? ` ${className}` : ""}`} aria-hidden="true">
      <canvas ref={canvasRef} className="dotFieldCanvas" />
      <svg className="dotFieldGlowLayer">
        <defs>
          <radialGradient id={glowId}>
            <stop offset="0%" stopColor={resolvedGlow} stopOpacity="0.10" />
            <stop offset="100%" stopColor={resolvedGlow} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle ref={glowRef} cx={-9999} cy={-9999} r={glowRadius} fill={`url(#${glowId})`} />
      </svg>
    </div>
  );
});

DotField.displayName = "DotField";

export { DotField };
export default DotField;