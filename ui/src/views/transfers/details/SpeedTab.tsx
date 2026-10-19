// Speed tab: the overall download and upload rate over time, drawn from the history the
// server pushes with every update (at most one point per second).

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { HistoryPoint } from "../../../api/types";
import { Segmented } from "../../../components/ui/Form";
import { formatSpeed, formatTime } from "../../../lib/format";
import { useSize } from "../../../lib/hooks";
import { useStore } from "../../../store/store";
import { cssColor, useLookTick, useRefreshMs } from "./shared";

type Range = "60" | "300" | "900" | "all";

const RANGES: { value: Range; label: string; tip: string }[] = [
  { value: "60", label: "1m", tip: "Last minute" },
  { value: "300", label: "5m", tip: "Last 5 minutes" },
  { value: "900", label: "15m", tip: "Last 15 minutes" },
  { value: "all", label: "All", tip: "All the history Promethea keeps (Settings › Advanced)" },
];

// Kept for the session, so switching tabs or torrents doesn't reset it.
let lastRange: Range = "300";

/** Space under the plot for the time labels, and above it for breathing room. */
const GUTTER = 20;
const PAD_TOP = 4;
/** The y axis never goes below this, so an idle client doesn't magnify noise. */
const MIN_TOP = 8 * 1024;

// ------------------------------------------------------------------ scales
/** 1-2-5 steps within each binary unit: 1 KiB, 2 KiB, 5 KiB, 10 KiB … 500 KiB, 1 MiB … */
const Y_STEPS = (() => {
  const out: number[] = [];
  for (let unit = 1024; unit <= 1024 ** 4; unit *= 1024) {
    for (const dec of [1, 10, 100]) for (const m of [1, 2, 5]) out.push(m * dec * unit);
  }
  return out;
})();

function yScale(peak: number): { top: number; step: number } {
  const v = Math.max(MIN_TOP, peak * 1.08);
  const step = Y_STEPS.find((s) => Math.ceil(v / s) <= 4) ?? Y_STEPS[Y_STEPS.length - 1];
  return { top: Math.ceil(v / step) * step, step };
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** Every label in the step's unit, so the axis reads 500, 1000, 1500 KiB/s rather than mixing units. */
function yLabel(v: number, step: number): string {
  let u = 0;
  while (u < UNITS.length - 1 && step >= 1024 ** (u + 1)) u++;
  const n = v / 1024 ** u;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ${UNITS[u]}/s`;
}

const X_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200];

function ago(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`;
  const m = Math.round((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)}h ${m}m` : `${s / 3600}h`;
}

// ------------------------------------------------------------------ data
interface View {
  /** Start of the window and its length, in seconds. */
  t0: number;
  span: number;
  /** Raw points in the window, plus the one just before it so the line enters from the edge. */
  pts: HistoryPoint[];
  /** What gets drawn: `pts`, or one max-per-pixel point when there are more points than pixels. */
  line: HistoryPoint[];
  /** Points further apart than this (seconds) are a gap in the data, not a slope. */
  gap: number;
  top: number;
  step: number;
  peakDl: number;
  peakUl: number;
}

/** Index of the first point at or after time t. */
function lowerBound(h: readonly HistoryPoint[], t: number): number {
  let lo = 0;
  let hi = h.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (h[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildView(history: readonly HistoryPoint[], range: Range, cols: number, sampleSec: number): View | null {
  if (!history.length || cols <= 0) return null;
  const end = history[history.length - 1][0];
  const span = range === "all" ? Math.max(60, end - history[0][0]) : Number(range);
  const t0 = end - span;
  const first = lowerBound(history, t0);
  const pts = history.slice(Math.max(0, first - 1));

  let peakDl = 0;
  let peakUl = 0;
  for (let i = first; i < history.length; i++) {
    if (history[i][1] > peakDl) peakDl = history[i][1];
    if (history[i][2] > peakUl) peakUl = history[i][2];
  }

  let line = pts;
  let gap = Math.max(5, sampleSec * 3);
  if (pts.length > cols * 1.5) {
    // Keep the highest value per pixel column, so the chart never understates a burst.
    line = [];
    let col = Number.NaN;
    for (const p of pts) {
      const c = Math.floor(((p[0] - t0) / span) * cols);
      const last = line[line.length - 1];
      if (c === col && last) {
        last[1] = Math.max(last[1], p[1]);
        last[2] = Math.max(last[2], p[2]);
      } else {
        line.push([p[0], p[1], p[2]]);
        col = c;
      }
    }
    gap = Math.max(gap, (span / cols) * 3);
  }

  const { top, step } = yScale(Math.max(peakDl, peakUl));
  return { t0, span, pts, line, gap, top, step, peakDl, peakUl };
}

/** The raw point nearest to x, unless the pointer is over a gap in the data. */
function pick(v: View, x: number, width: number): HistoryPoint | null {
  const t = v.t0 + (x / width) * v.span;
  const i = lowerBound(v.pts, t);
  let best: HistoryPoint | null = null;
  for (const j of [i - 1, i]) {
    const p = v.pts[j];
    if (p && p[0] >= v.t0 && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p;
  }
  return best && Math.abs(best[0] - t) <= v.gap ? best : null;
}

function segments(line: readonly HistoryPoint[], gap: number): HistoryPoint[][] {
  const out: HistoryPoint[][] = [];
  let cur: HistoryPoint[] = [];
  for (const p of line) {
    if (cur.length && p[0] - cur[cur.length - 1][0] > gap) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

// ------------------------------------------------------------------ drawing
interface Colors {
  dl: string;
  ul: string;
  grid: string;
  text: string;
  bg: string;
  font: string;
}

function readColors(el: Element): Colors {
  return {
    dl: cssColor(el, "--accent", "#8b5cf6"),
    ul: cssColor(el, "--green", "#34d399"),
    grid: cssColor(el, "--line", "rgba(127,127,127,0.18)"),
    text: cssColor(el, "--text-3", "#888"),
    bg: cssColor(el, "--bg-1", "#111"),
    font: `11px ${getComputedStyle(el).fontFamily || "system-ui"}`,
  };
}

/** Any CSS color with a different alpha (gradients need explicit stops). */
const rgbCache = new Map<string, string>();
function withAlpha(color: string, alpha: number): string {
  let rgb = rgbCache.get(color);
  if (!rgb) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return color;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    rgb = `${r}, ${g}, ${b}`;
    rgbCache.set(color, rgb);
  }
  return `rgba(${rgb}, ${alpha})`;
}

interface Limits {
  dl: number;
  ul: number;
}

function paint(canvas: HTMLCanvasElement, w: number, h: number, v: View | null, c: Colors, hover: HistoryPoint | null, limits: Limits) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const plotTop = PAD_TOP;
  const plotBottom = h - GUTTER;
  const plotH = Math.max(1, plotBottom - plotTop);
  const { top, step } = v ?? yScale(0);
  const y = (val: number) => plotBottom - (Math.min(val, top) / top) * plotH;
  /** Snap a horizontal line to whole device pixels. */
  const crisp = (yy: number) => Math.round(yy * dpr) / dpr;

  // Grid: a baseline plus one line per step.
  ctx.fillStyle = c.grid;
  for (let k = 0; k * step <= top + 0.5; k++) ctx.fillRect(0, crisp(y(k * step)), w, 1 / dpr);

  if (v) {
    const x = (t: number) => ((t - v.t0) / v.span) * w;
    const segs = segments(v.line, v.gap);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, plotBottom);
    ctx.clip();

    const series: [number, string, number][] = [
      [1, c.dl, 0.26],
      [2, c.ul, 0.14],
    ];
    for (const [i, color, alpha] of series) {
      const grad = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
      grad.addColorStop(0, withAlpha(color, alpha));
      grad.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = grad;
      for (const seg of segs) {
        if (seg.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(x(seg[0][0]), plotBottom);
        for (const p of seg) ctx.lineTo(x(p[0]), y(p[i]));
        ctx.lineTo(x(seg[seg.length - 1][0]), plotBottom);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const [i, color] of [...series].reverse()) {
      ctx.strokeStyle = color;
      for (const seg of segs) {
        ctx.beginPath();
        seg.forEach((p, j) => (j ? ctx.lineTo(x(p[0]), y(p[i])) : ctx.moveTo(x(p[0]), y(p[i]))));
        if (seg.length === 1) ctx.lineTo(x(seg[0][0]) + 0.01, y(seg[0][i]));
        ctx.stroke();
      }
    }

    // Speed limits, when they're within view.
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    for (const [limit, color] of [
      [limits.dl, c.dl],
      [limits.ul, c.ul],
    ] as const) {
      if (limit > 0 && limit <= top) {
        ctx.strokeStyle = withAlpha(color, 0.7);
        ctx.beginPath();
        const ly = crisp(y(limit)) + 0.5 / dpr;
        ctx.moveTo(0, ly);
        ctx.lineTo(w, ly);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();

    if (hover) {
      const hx = Math.round(x(hover[0]) * dpr) / dpr;
      ctx.fillStyle = withAlpha(c.text, 0.6);
      ctx.fillRect(hx, plotTop, 1 / dpr, plotH);
      for (const [i, color] of series) {
        ctx.beginPath();
        ctx.arc(hx, y(hover[i]), 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.strokeStyle = c.bg;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fill();
      }
    }

    // Time labels under the plot: "now" on the right, then round steps back in time.
    ctx.font = c.font;
    ctx.fillStyle = c.text;
    ctx.textBaseline = "alphabetic";
    const ly = h - 6;
    ctx.textAlign = "right";
    ctx.fillText("now", w - 2, ly);
    const fit = Math.max(2, Math.floor(w / 72));
    const xs = X_STEPS.find((s) => v.span / s <= Math.min(6, fit)) ?? X_STEPS[X_STEPS.length - 1];
    ctx.textAlign = "center";
    for (let s = xs; s < v.span + 0.5; s += xs) {
      const tx = w - (s / v.span) * w;
      if (tx < 18) break;
      ctx.fillText(ago(s), tx, ly);
    }
  }

  // Speed labels just under each grid line, on top of the data with a halo for contrast.
  ctx.font = c.font;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = c.bg;
  ctx.fillStyle = c.text;
  for (let k = 1; k * step <= top + 0.5; k++) {
    const label = yLabel(k * step, step);
    const ly = y(k * step) + 3;
    ctx.strokeText(label, 6, ly);
    ctx.fillText(label, 6, ly);
  }
}

// ------------------------------------------------------------------ tab
export function SpeedTab() {
  const history = useStore((s) => s.history);
  const dlLimit = useStore((s) => s.server?.dlLimit ?? 0);
  const upLimit = useStore((s) => s.server?.upLimit ?? 0);
  const sampleMs = useRefreshMs();
  const [range, setRangeState] = useState<Range>(lastRange);
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const look = useLookTick();

  const width = Math.round(size.width);
  const height = Math.round(size.height);
  const view = useMemo(
    () => buildView(history, range, width, Math.max(1, sampleMs / 1000)),
    [history, range, width, sampleMs],
  );
  const hover = view && hoverX != null ? pick(view, hoverX, width) : null;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    paint(canvas, width, height, view, readColors(canvas), hover, { dl: dlLimit, ul: upLimit });
  }, [view, width, height, look, hover, dlLimit, upLimit]);

  const setRange = (r: Range) => {
    lastRange = r;
    setRangeState(r);
  };

  const last = history[history.length - 1];
  const end = last?.[0] ?? 0;
  const enough = (view?.pts.length ?? 0) >= 2;
  const rangeName = RANGES.find((r) => r.value === range)?.tip.toLowerCase() ?? "";

  let tip: CSSProperties | undefined;
  if (hover && view && width > 0) {
    const hx = ((hover[0] - view.t0) / view.span) * width;
    tip = hx > width - 190 ? { left: hx - 12, transform: "translateX(-100%)" } : { left: hx + 12 };
  }

  return (
    <div className="speed-tab">
      <div className="speed-head">
        <div className="speed-legend">
          <LegendItem kind="dl" label="Download" now={last?.[1] ?? 0} peak={view?.peakDl ?? 0} limit={dlLimit} />
          <LegendItem kind="ul" label="Upload" now={last?.[2] ?? 0} peak={view?.peakUl ?? 0} limit={upLimit} />
        </div>
        <Segmented value={range} onChange={setRange} options={RANGES} className="segmented-sm" />
      </div>
      <div
        ref={wrapRef}
        className="speed-chart"
        onMouseMove={(e) => setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left)}
        onMouseLeave={() => setHoverX(null)}
      >
        <canvas ref={canvasRef} role="img" aria-label={`Download and upload speed, ${rangeName}`} />
        {!enough && <div className="speed-empty">Collecting data…</div>}
        {hover && tip && (
          <div className="speed-tip" style={tip}>
            <div className="st-time">
              {formatTime(hover[0])}
              <span className="faint">{end - hover[0] > 0 ? ` · ${ago(end - hover[0])} ago` : " · now"}</span>
            </div>
            <div className="st-row dl">
              <i />
              Download <b className="num">{formatSpeed(hover[1], "0 B/s")}</b>
            </div>
            <div className="st-row ul">
              <i />
              Upload <b className="num">{formatSpeed(hover[2], "0 B/s")}</b>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LegendItem({ kind, label, now, peak, limit }: { kind: "dl" | "ul"; label: string; now: number; peak: number; limit: number }) {
  return (
    <span className={`sl-item ${kind}`}>
      <i />
      {label}
      <b className="num">{formatSpeed(now, "0 B/s")}</b>
      <span className="faint num">
        peak {formatSpeed(peak, "0 B/s")}
        {limit > 0 && ` · limit ${formatSpeed(limit)}`}
      </span>
    </span>
  );
}
