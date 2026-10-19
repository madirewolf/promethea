// Folder paths in the dialogs: joining them the way the server writes them, category
// names and folders, and the recently used download folders.

/** Join path parts using the separator `base` already uses. */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") ? "\\" : "/";
  const rest = parts.flatMap((p) => p.split(/[\\/]+/)).filter(Boolean);
  if (!rest.length) return base;
  return [base.replace(/[\\/]+$/, ""), ...rest].join(sep);
}

/** The last part of a path: a file or folder name. */
export function baseName(path: string): string {
  const p = path.trim().replace(/[\\/]+$/, "");
  return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}

/** The folder a path is in, keeping a root's separator (C:\ and /); "" when it has none. */
export function parentPath(path: string): string {
  const p = path.trim().replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return "";
  const head = p.slice(0, i);
  return !head || /^[a-z]:$/i.test(head) ? p.slice(0, i + 1) : head;
}

/** Where a category without a folder of its own downloads: a folder named after it. */
export function categoryFolder(base: string, name: string): string {
  return joinPath(base, ...name.trim().split("/"));
}

/** Why `name` can't be a category (renaming `original`), or null. */
export function categoryNameError(name: string, original: string | undefined, existing: Record<string, unknown>): string | null {
  const n = name.trim();
  if (!n) return "Enter a name";
  if (n.startsWith("/") || n.endsWith("/") || n.includes("//")) return "Use “/” only between subcategory names, like Movies/HD";
  if (n !== original && n in existing) return "A category with that name already exists";
  return null;
}

const RECENT_KEY = "promethea.recentPaths";
const RECENT_MAX = 8;

/** Windows paths compare case-insensitively; the rest don't. */
function samePath(a: string, b: string): boolean {
  const norm = (s: string) => {
    const t = s.trim().replace(/[\\/]+$/, "");
    return /^[a-z]:/i.test(t) || t.includes("\\") ? t.toLowerCase() : t;
  };
  return norm(a) === norm(b);
}

export function recentPaths(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberPath(path: string): void {
  const p = path.trim();
  if (!p) return;
  const list = [p, ...recentPaths().filter((x) => !samePath(x, p))].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: nothing to remember */
  }
}
