// MilkDrop-style oscilloscope visualizer (smooth pixels).
//
// The Rust engine taps its output callback and emits `audio:waveform` frames
// (~30 Hz) of the most recent oscilloscope amplitudes. Here we render the look
// from the reference: a starfield, a glowing white waveform line across the
// center, a green bloom around it, and feedback trails that flow outward
// (up/down) from the line and fade — the classic MilkDrop persistence effect.
//
// It mounts into a container (the #now-playing-visualizer layer inside the
// now-playing hero) and fills it, resizing with the pane. The rAF loop is gated
// by start()/stop() so it only burns cycles while the visualizer is the chosen
// hero view and that face is visible (see setupSettings in src/main.ts, driven
// off nowPlayingView + heroVisible).
//
// Rendering model:
//   - A ping-pong pair of offscreen buffers holds the bloom. Each frame the
//     previous buffer is drawn back slightly zoomed-out from center (outward
//     flow) and faded (decay), then the fresh line is added on top. That
//     accumulation IS the glow/trails.
//   - The visible canvas is composited each frame: dark bg → a 3D zooming
//     starfield (stars fly outward from center with warp streaks) → the bloom
//     buffer added on top (`lighter`), so stars stay crisp while the glow
//     blooms over them. The bg and bloom slowly drift through a neon palette.

import { listen } from "@tauri-apps/api/event";

interface WaveformEvent {
  samples: number[];
}

// --- Look / feel knobs -------------------------------------------------------
const DECAY = 0.9; // fraction of the previous frame that survives (trail length)
const ZOOM_Y = 1.04; // >1 pushes trails outward vertically each frame
const ZOOM_X = 1.006; // a touch of horizontal breathing
const AMP = 0.34; // waveform swing as a fraction of half-height
const CORE = "225, 255, 240"; // near-white line core (rgb)

// The bloom (and a faint background tint) slowly drift through a loop of 90s
// neon shades. COLOR_SECS is how long we dwell on each before crossfading to
// the next; the loop wraps back to the start seamlessly.
const PALETTE: [number, number, number][] = [
  [255, 128, 0], // orange
  [255, 240, 30], // yellow
  [255, 60, 200], // pink
  [40, 90, 255], // blue
  [0, 255, 230], // cyan
  [255, 40, 60], // red
  [40, 255, 120], // green
  [170, 50, 255], // purple
];
const COLOR_SECS = 6;

// Pick a palette index different from `cur`, so the drift never crossfades a
// color into itself and the order stays unpredictable.
const pickColor = (cur: number): number => {
  let n = Math.floor(Math.random() * (PALETTE.length - 1));
  if (n >= cur) n++;
  return n;
};

// A star in a classic 3D zooming field. x/y are offsets in a plane; z is depth
// (distance toward the camera). Each frame z shrinks so the star flies outward
// from center, growing and brightening; when it passes the camera it respawns
// far away. The warp streak is drawn from a depth TRAIL_SECS of motion behind
// the current one, so it grows with speed.
interface Star {
  x: number;
  y: number;
  z: number;
  base: number; // per-star brightness/size scale
  speed: number; // per-star depth velocity multiplier (parallax)
  // Energy level (0..1) at which this star fades in. 0 = always visible (the
  // base field); the extra stars have higher thresholds so louder music reveals
  // progressively more of them, up to double density at full energy.
  threshold: number;
}

// How fast the field flies toward the camera, as a fraction of the depth range
// per second.
const STAR_SPEED = 0.28;

// How many seconds of a star's motion the warp streak represents. The streak
// spans velocity × this × energy, so faster stars (louder music) draw longer
// trails and silence draws none at all.
const TRAIL_SECS = 0.035;

export interface Visualizer {
  start(): void;
  stop(): void;
}

// Build a visualizer that fills `container` and can be started/stopped. Async
// only because it subscribes to the waveform event stream once up front.
export async function createVisualizer(container: HTMLElement): Promise<Visualizer> {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, {
    display: "block",
    width: "100%",
    height: "100%",
  } satisfies Partial<CSSStyleDeclaration>);
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  // Device-pixel dimensions; recomputed from the container on every resize.
  let W = 0;
  let H = 0;
  let cx = 0;
  let cy = 0;

  // Ping-pong bloom buffers, rebuilt whenever the size changes.
  const makeBuf = () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    return { c, x: c.getContext("2d")! };
  };
  let read = makeBuf();
  let write = makeBuf();

  // Starfield: position, size, base brightness, twinkle phase/speed. Reseeded on
  // resize so density and placement track the new dimensions.
  let stars: Star[] = [];

  const resize = () => {
    const cssW = Math.max(1, container.clientWidth);
    const cssH = Math.max(1, container.clientHeight);
    const nextW = Math.round(cssW * dpr);
    const nextH = Math.round(cssH * dpr);
    if (nextW === W && nextH === H) return;
    W = nextW;
    H = nextH;
    cx = W / 2;
    cy = H / 2;
    canvas.width = W;
    canvas.height = H;
    read = makeBuf();
    write = makeBuf();
    // Seed double the base density; the first half is always visible, the second
    // half fades in with energy (see `threshold`), so full energy ~doubles it.
    const baseCount = Math.round((W * H) / (2600 * dpr));
    stars = Array.from({ length: baseCount * 2 }, (_, i) => ({
      x: (Math.random() * 2 - 1) * W,
      y: (Math.random() * 2 - 1) * H,
      z: Math.random() * W, // spread through the whole depth range up front
      base: 0.4 + Math.random() * 0.6,
      speed: 0.5 + Math.random() * 0.9,
      threshold: i < baseCount ? 0 : 0.1 + Math.random() * 0.8,
    }));
  };
  resize();
  new ResizeObserver(() => resize()).observe(container);

  // Latest waveform frame; the rAF loop consumes it (newest wins, no backlog).
  let latest: number[] = [];
  await listen<WaveformEvent>("audio:waveform", (e) => {
    latest = e.payload.samples;
  });

  const drawScope = (g: CanvasRenderingContext2D, wave: number[], glow: string) => {
    const n = wave.length;
    if (n < 2) return;

    // Build a smoothed path through the waveform points (quadratic midpoints).
    g.beginPath();
    const px = (i: number) => (i / (n - 1)) * W;
    const py = (i: number) => cy - wave[i] * AMP * H;
    g.moveTo(px(0), py(0));
    for (let i = 1; i < n - 1; i++) {
      const mx = (px(i) + px(i + 1)) / 2;
      const my = (py(i) + py(i + 1)) / 2;
      g.quadraticCurveTo(px(i), py(i), mx, my);
    }
    g.lineCap = "round";
    g.lineJoin = "round";

    // Wide, soft halo in the current neon shade.
    g.strokeStyle = `rgba(${glow}, 0.22)`;
    g.lineWidth = 11 * dpr;
    g.stroke();

    // Bright core with a colored glow via shadow.
    g.shadowColor = `rgba(${glow}, 0.9)`;
    g.shadowBlur = 10 * dpr;
    g.strokeStyle = `rgba(${CORE}, 0.95)`;
    g.lineWidth = 2 * dpr;
    g.stroke();
    g.shadowBlur = 0;
  };

  let running = false;
  let rafId = 0;
  let lastT = 0; // timestamp (s) of the previous frame, for frame-rate-independent motion
  let energy = 0; // smoothed audio loudness (0..1) driving the starfield speed

  // Color drift state: crossfade from one palette index to the next over
  // COLOR_SECS, then randomly pick a fresh target — so transitions vary.
  let colorFrom = Math.floor(Math.random() * PALETTE.length);
  let colorTo = pickColor(colorFrom);
  let colorT = 0; // seconds elapsed into the current crossfade

  const frame = (tMs: number) => {
    if (!running) return;
    // A resize can leave zero-size buffers for a beat (e.g. the pane was hidden
    // when start() ran); skip until the ResizeObserver gives real dimensions.
    if (W === 0 || H === 0) {
      rafId = requestAnimationFrame(frame);
      return;
    }

    const t = tMs / 1000;
    // Clamp dt so a hidden/backgrounded pane (huge gap) doesn't warp the field.
    const dt = lastT ? Math.min(0.05, t - lastT) : 0;
    lastT = t;
    const w = write.x;

    // Advance the color crossfade; on completion, pick a new random target.
    colorT += dt;
    if (colorT >= COLOR_SECS) {
      colorT -= COLOR_SECS;
      colorFrom = colorTo;
      colorTo = pickColor(colorFrom);
    }
    // Current neon shade for the bloom; the background gets a very dark cast of
    // the same hue so the whole scene drifts through the palette together.
    const f = colorT / COLOR_SECS;
    const ca = PALETTE[colorFrom];
    const cb = PALETTE[colorTo];
    const gr = Math.round(ca[0] + (cb[0] - ca[0]) * f);
    const gg = Math.round(ca[1] + (cb[1] - ca[1]) * f);
    const gb = Math.round(ca[2] + (cb[2] - ca[2]) * f);
    const glow = `${gr}, ${gg}, ${gb}`;

    // 1) Feedback: fade + zoom the previous bloom outward from center.
    w.setTransform(1, 0, 0, 1, 0, 0);
    w.globalCompositeOperation = "source-over";
    w.globalAlpha = 1;
    w.clearRect(0, 0, W, H);
    w.globalAlpha = DECAY;
    w.translate(cx, cy);
    w.scale(ZOOM_X, ZOOM_Y);
    w.translate(-cx, -cy);
    w.drawImage(read.c, 0, 0);
    w.setTransform(1, 0, 0, 1, 0, 0);
    w.globalAlpha = 1;

    // 2) Add the fresh waveform line on top (additive so it accumulates glow).
    w.globalCompositeOperation = "lighter";
    drawScope(w, latest, glow);
    w.globalCompositeOperation = "source-over";

    // 3) Composite to screen: bg → stars → bloom buffer (added over the top).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgb(${Math.round(gr * 0.07)}, ${Math.round(gg * 0.07)}, ${Math.round(gb * 0.07)})`;
    ctx.fillRect(0, 0, W, H);

    // Track the music's loudness (RMS of the latest waveform) and let it push
    // the starfield: quiet → gentle drift, loud → warp. Fast attack so beats
    // punch, slow release so it eases back down.
    let sum = 0;
    for (let i = 0; i < latest.length; i++) sum += latest[i] * latest[i];
    const rms = latest.length ? Math.sqrt(sum / latest.length) : 0;
    const target = Math.min(1, rms * 2.4);
    energy += (target - energy) * (target > energy ? 0.4 : 0.08);
    const speedMul = 0.35 + energy * 3.5; // floor keeps it drifting when silent

    ctx.lineCap = "round";
    for (const s of stars) {
      // Depth velocity (units/sec); faster when louder or nearer the camera.
      const vel = s.speed * STAR_SPEED * W * speedMul;

      // Fly toward the camera; respawn far away (invisible) once we pass it.
      s.z -= vel * dt;
      if (s.z <= 1) {
        s.x = (Math.random() * 2 - 1) * W;
        s.y = (Math.random() * 2 - 1) * H;
        s.z = W;
      }

      // Perspective projection: nearer stars (small z) sit further from center.
      const k = W / s.z;
      const sx = cx + s.x * k;
      const sy = cy + s.y * k;

      // Fade the star in as energy rises past its threshold (0.2-wide window).
      // Base stars (threshold 0) stay fully lit; skip ones still fully hidden.
      const vis = s.threshold === 0 ? 1 : Math.max(0, Math.min(1, (energy - s.threshold) / 0.2 + 1));
      if (vis <= 0) continue;

      // Grow and brighten as the star approaches (z: W → 0).
      const depth = 1 - s.z / W;
      const r = (0.5 + depth * 2.4) * dpr;
      const b = Math.min(1, s.base * depth * 1.6) * vis;

      // Warp streak: project from a depth TRAIL_SECS of motion behind us, scaled
      // by energy so louder music → longer streaks and silence → none.
      const trail = vel * TRAIL_SECS * energy;
      if (trail > 0.5) {
        const tk = W / (s.z + trail);
        ctx.strokeStyle = `rgba(255,255,255,${b * 0.7})`;
        ctx.lineWidth = r;
        ctx.beginPath();
        ctx.moveTo(cx + s.x * tk, cy + s.y * tk);
        ctx.lineTo(sx, sy);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${b})`;
      ctx.fill();
    }

    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(write.c, 0, 0);
    ctx.globalCompositeOperation = "source-over";

    // Swap buffers: this frame's bloom becomes next frame's source.
    const tmp = read;
    read = write;
    write = tmp;

    rafId = requestAnimationFrame(frame);
  };

  return {
    start() {
      if (running) return;
      running = true;
      lastT = 0; // first frame after (re)start yields dt=0, no motion jump
      // The pane just became visible; pick up its real size before the first frame.
      resize();
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    },
  };
}
