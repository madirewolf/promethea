// Theme, accent and density on <html>. Cached per browser so the first paint already matches.

export interface Look {
  theme: "dark" | "light";
  accent: string;
  density: string;
}

const KEY = "promethea.look.v1";

export function applyLook(look: Look): void {
  const root = document.documentElement;
  root.dataset.theme = look.theme;
  root.dataset.accent = look.accent;
  root.dataset.density = look.density;
  try {
    localStorage.setItem(KEY, JSON.stringify(look));
  } catch {
    /* storage unavailable */
  }
}

/** Apply the last used look before React renders anything. */
export function applyCachedLook(): void {
  let look: Partial<Look> = {};
  try {
    look = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Look>;
  } catch {
    /* ignore */
  }
  const system = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  const root = document.documentElement;
  root.dataset.theme = look.theme ?? system;
  root.dataset.accent = look.accent ?? "violet";
  root.dataset.density = look.density ?? "comfortable";
}

export const ACCENTS = [
  { value: "violet", label: "Violet", color: "#8b5cf6" },
  { value: "blue", label: "Blue", color: "#3b82f6" },
  { value: "sky", label: "Sky", color: "#0ea5e9" },
  { value: "teal", label: "Teal", color: "#14b8a6" },
  { value: "green", label: "Green", color: "#22c55e" },
  { value: "amber", label: "Amber", color: "#f59e0b" },
  { value: "orange", label: "Orange", color: "#f97316" },
  { value: "rose", label: "Rose", color: "#f43f5e" },
  { value: "pink", label: "Pink", color: "#ec4899" },
  { value: "graphite", label: "Graphite", color: "#8b8f99" },
] as const;
