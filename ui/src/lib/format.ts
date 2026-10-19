// Human-friendly formatting of sizes, speeds, durations and dates.

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function formatBytes(n: number | null | undefined, digits?: number): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "–";
  if (n < 1024) return `${Math.round(n)} B`;
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const d = digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2);
  return `${v.toFixed(d)} ${UNITS[i]}`;
}

export function formatSpeed(n: number | null | undefined, zero = ""): string {
  if (!n || n <= 0) return zero;
  return `${formatBytes(n)}/s`;
}

/** Speed limit in bytes/s; 0 means unlimited. */
export function formatLimit(n: number | null | undefined): string {
  if (!n || n <= 0) return "Unlimited";
  return `${formatBytes(n)}/s`;
}

export const INFINITY_ETA = 8640000;

export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0 || seconds >= INFINITY_ETA) return "∞";
  return formatDuration(seconds, 2);
}

/** "2d 4h", "3h 12m", "5m 3s", "42s" (at most `parts` units). */
export function formatDuration(seconds: number | null | undefined, parts = 2): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "–";
  const s = Math.floor(seconds);
  if (s === 0) return "0s";
  const units: [number, string][] = [
    [Math.floor(s / 31536000), "y"],
    [Math.floor((s % 31536000) / 86400), "d"],
    [Math.floor((s % 86400) / 3600), "h"],
    [Math.floor((s % 3600) / 60), "m"],
    [s % 60, "s"],
  ];
  const out: string[] = [];
  for (const [v, u] of units) {
    if (v > 0 || out.length) {
      if (v > 0) out.push(`${v}${u}`);
      else if (out.length) out.push(`0${u}`);
    }
    if (out.length >= parts) break;
  }
  // Drop trailing zero parts ("3h 0m" -> "3h").
  while (out.length > 1 && out[out.length - 1].startsWith("0")) out.pop();
  return out.join(" ");
}

export function formatRatio(r: number | null | undefined): string {
  if (r == null || r < 0) return "–";
  if (r >= 9999) return "∞";
  return r.toFixed(2);
}

export function formatPercent(p: number | null | undefined, digits = 1): string {
  if (p == null || p < 0) return "–";
  if (p >= 1) return "100%";
  const v = Math.floor(p * 100 * 10 ** digits) / 10 ** digits;
  return `${v.toFixed(digits)}%`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function formatDate(ts: number | null | undefined): string {
  if (!ts || ts <= 0) return "–";
  return dateFmt.format(new Date(ts * 1000));
}

export function formatTime(ts: number): string {
  return timeFmt.format(new Date(ts * 1000));
}

const hmFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const mdhmFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ymdFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Compact date for tables: "17:47" today, "Oct 15, 17:47" this year, else "Oct 15, 2025". */
export function formatShortDate(ts: number | null | undefined): string {
  if (!ts || ts <= 0) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hmFmt.format(d);
  if (d.getFullYear() === now.getFullYear()) return mdhmFmt.format(d);
  return ymdFmt.format(d);
}

export function formatAgo(ts: number | null | undefined, now = Date.now() / 1000): string {
  if (!ts || ts <= 0) return "Never";
  const d = Math.max(0, now - ts);
  if (d < 10) return "Just now";
  return `${formatDuration(d, 1)} ago`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || n < 0) return "–";
  return n.toLocaleString();
}

export function plural(n: number, word: string, many?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? word : many ?? `${word}s`}`;
}

/** Parse "1.5 MiB", "200k", "3m" -> bytes. Returns NaN when unparseable. */
export function parseSize(text: string): number {
  const m = /^\s*([\d.]+)\s*([kmgtp]?)(i?b?)?\s*$/i.exec(text);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  const exp = { "": 0, k: 1, m: 2, g: 3, t: 4, p: 5 }[m[2].toLowerCase() as "" | "k" | "m" | "g" | "t" | "p"];
  return Math.round(v * 1024 ** exp);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
