// The folder tree behind the Files tab and the add dialog: built from flat "/"-separated
// paths, with sizes, progress and priorities rolled up into every folder.

export interface TreeFile {
  index: number;
  /** "/"-separated, including the torrent's root folder. */
  path: string;
  size: number;
  priority: number;
  /** 0..1 */
  progress?: number;
  /** 0..1, -1 = unknown */
  availability?: number;
}

export interface TreeNode {
  /** "d:<path>" for folders, "f:<index>" for files. */
  key: string;
  name: string;
  path: string;
  depth: number;
  folder: boolean;
  parent: TreeNode | null;
  children: TreeNode[];
  file: TreeFile | null;
  size: number;
  /** Bytes downloaded, all files. */
  done: number;
  /** Size of the files that will be downloaded. */
  wanted: number;
  /** Bytes downloaded among the wanted files. */
  wantedDone: number;
  count: number;
  wantedCount: number;
  /** The priority every file underneath shares, or -1 when they differ. */
  priority: number;
  /** Size-weighted availability, -1 when unknown. */
  availability: number;
  sortTag?: string;
  sorted?: TreeNode[];
}

export interface TreeModel {
  root: TreeNode;
  /** Bumped whenever values change, so sort caches and rows refresh. */
  version: number;
  fileCount: number;
  folderCount: number;
  byIndex: Map<number, TreeNode>;
  folders: Map<string, TreeNode>;
  /** Structure signature: the paths and indices it was built from. */
  paths: string[];
  indices: number[];
}

export type TreeSortKey = "name" | "size" | "progress" | "priority" | "remaining" | "availability";

export interface TreeSort {
  key: TreeSortKey;
  dir: 1 | -1;
}

function makeNode(key: string, name: string, path: string, depth: number, folder: boolean, parent: TreeNode | null): TreeNode {
  return {
    key,
    name,
    path,
    depth,
    folder,
    parent,
    children: [],
    file: null,
    size: 0,
    done: 0,
    wanted: 0,
    wantedDone: 0,
    count: 0,
    wantedCount: 0,
    priority: 4,
    availability: -1,
  };
}

export function buildTree(files: readonly TreeFile[]): TreeModel {
  const root = makeNode("d:", "", "", -1, true, null);
  const folders = new Map<string, TreeNode>();
  const byIndex = new Map<number, TreeNode>();
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let parent = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      let dir = folders.get(prefix);
      if (!dir) {
        dir = makeNode(`d:${prefix}`, parts[i], prefix, i, true, parent);
        folders.set(prefix, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    const name = parts[parts.length - 1] ?? f.path;
    const leaf = makeNode(`f:${f.index}`, name, parts.join("/"), Math.max(0, parts.length - 1), false, parent);
    leaf.file = f;
    parent.children.push(leaf);
    byIndex.set(f.index, leaf);
  }
  aggregate(root);
  return {
    root,
    version: 0,
    fileCount: files.length,
    folderCount: folders.size,
    byIndex,
    folders,
    paths: files.map((f) => f.path),
    indices: files.map((f) => f.index),
  };
}

function aggregate(n: TreeNode): void {
  if (!n.folder) {
    const f = n.file!;
    const want = f.priority > 0;
    n.size = f.size;
    n.done = f.size * Math.max(0, Math.min(1, f.progress ?? 0));
    n.wanted = want ? f.size : 0;
    n.wantedDone = want ? n.done : 0;
    n.count = 1;
    n.wantedCount = want ? 1 : 0;
    n.priority = f.priority;
    n.availability = f.availability ?? -1;
    return;
  }
  let size = 0;
  let done = 0;
  let wanted = 0;
  let wantedDone = 0;
  let count = 0;
  let wantedCount = 0;
  let prio: number | null = null;
  let mixed = false;
  let availWeighted = 0;
  let availSize = 0;
  for (const c of n.children) {
    aggregate(c);
    size += c.size;
    done += c.done;
    wanted += c.wanted;
    wantedDone += c.wantedDone;
    count += c.count;
    wantedCount += c.wantedCount;
    if (c.priority === -1) mixed = true;
    else if (prio === null) prio = c.priority;
    else if (prio !== c.priority) mixed = true;
    if (c.availability >= 0) {
      availWeighted += c.availability * c.size;
      availSize += c.size;
    }
  }
  n.size = size;
  n.done = done;
  n.wanted = wanted;
  n.wantedDone = wantedDone;
  n.count = count;
  n.wantedCount = wantedCount;
  n.priority = mixed ? -1 : prio ?? 4;
  n.availability = availSize > 0 ? availWeighted / availSize : n.children.some((c) => c.availability >= 0) ? 1 : -1;
}

function sameStructure(m: TreeModel, files: readonly TreeFile[]): boolean {
  if (m.fileCount !== files.length) return false;
  for (let i = 0; i < files.length; i++) {
    if (files[i].path !== m.paths[i] || files[i].index !== m.indices[i]) return false;
  }
  return true;
}

/**
 * Bring a tree up to date with fresh file data. When only values changed (the usual poll),
 * the existing nodes are updated in place, which keeps sort caches and expansion keys.
 */
export function syncTree(prev: TreeModel | null, files: readonly TreeFile[]): TreeModel {
  if (!prev || !sameStructure(prev, files)) return buildTree(files);
  for (const f of files) {
    const leaf = prev.byIndex.get(f.index);
    if (leaf) leaf.file = f;
  }
  aggregate(prev.root);
  return { ...prev, version: prev.version + 1 };
}

// ------------------------------------------------------------------ values
export function progressOf(n: TreeNode): number {
  if (!n.folder) return Math.max(0, Math.min(1, n.file?.progress ?? 0));
  if (n.wanted > 0) return n.wantedDone / n.wanted;
  return n.size > 0 ? n.done / n.size : 1;
}

export function remainingOf(n: TreeNode): number {
  return Math.max(0, n.wanted - n.wantedDone);
}

export function filesUnder(n: TreeNode, out: TreeFile[] = []): TreeFile[] {
  if (!n.folder) {
    if (n.file) out.push(n.file);
    return out;
  }
  for (const c of n.children) filesUnder(c, out);
  return out;
}

/** Every file under any of the nodes, each once. */
export function filesOf(nodes: Iterable<TreeNode>): TreeFile[] {
  const seen = new Set<number>();
  const out: TreeFile[] = [];
  for (const n of nodes) {
    for (const f of filesUnder(n)) {
      if (!seen.has(f.index)) {
        seen.add(f.index);
        out.push(f);
      }
    }
  }
  return out;
}

export const PRIORITIES = [
  { value: 0, label: "Do not download" },
  { value: 4, label: "Normal" },
  { value: 6, label: "High" },
  { value: 7, label: "Maximum" },
] as const;

export function priorityLabel(p: number): string {
  if (p < 0) return "Mixed";
  if (p === 0) return "Do not download";
  if (p <= 3) return "Low";
  if (p <= 5) return "Normal";
  if (p === 6) return "High";
  return "Maximum";
}

// ------------------------------------------------------------------ sorting & flattening
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

function sortValue(n: TreeNode, key: TreeSortKey): number {
  switch (key) {
    case "size":
      return n.size;
    case "progress":
      return progressOf(n);
    case "priority":
      return n.priority;
    case "remaining":
      return remainingOf(n);
    case "availability":
      return n.availability;
    default:
      return 0;
  }
}

/** Children in display order: folders first, then by the sort key (names break ties). */
export function sortedChildren(n: TreeNode, sort: TreeSort, version: number): TreeNode[] {
  // Names and sizes don't change between polls, so those orders stay cached.
  const fixed = sort.key === "name" || sort.key === "size";
  const tag = fixed ? `${sort.key}:${sort.dir}` : `${sort.key}:${sort.dir}:${version}`;
  if (n.sortTag === tag && n.sorted) return n.sorted;
  const list = n.children.slice();
  list.sort((a, b) => {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    if (sort.key !== "name") {
      const d = sortValue(a, sort.key) - sortValue(b, sort.key);
      if (d) return d * sort.dir;
    }
    return collator.compare(a.name, b.name) * (sort.key === "name" ? sort.dir : 1);
  });
  n.sortTag = tag;
  n.sorted = list;
  return list;
}

/**
 * The rows to show: a depth-first walk through expanded folders. With a filter, only
 * files whose name contains it (and the folders leading to them) are shown, all expanded;
 * a folder whose own name matches shows everything inside it.
 */
export function flatten(model: TreeModel, expanded: (n: TreeNode) => boolean, sort: TreeSort, filter = ""): TreeNode[] {
  const out: TreeNode[] = [];
  const q = filter.trim().toLowerCase();
  if (!q) {
    const walk = (n: TreeNode) => {
      for (const c of sortedChildren(n, sort, model.version)) {
        out.push(c);
        if (c.folder && expanded(c)) walk(c);
      }
    };
    walk(model.root);
    return out;
  }
  const shown = new Set<TreeNode>();
  const mark = (n: TreeNode, forced: boolean): boolean => {
    const self = forced || n.name.toLowerCase().includes(q);
    if (!n.folder) {
      if (self) shown.add(n);
      return self;
    }
    let any = false;
    for (const c of n.children) if (mark(c, self)) any = true;
    if (any || self) shown.add(n);
    return any || self;
  };
  for (const c of model.root.children) mark(c, false);
  const walk = (n: TreeNode) => {
    for (const c of sortedChildren(n, sort, model.version)) {
      if (!shown.has(c)) continue;
      out.push(c);
      if (c.folder) walk(c);
    }
  };
  walk(model.root);
  return out;
}

// ------------------------------------------------------------------ expansion memory
/** Folders the user opened or closed, per tree (torrent id / add token); the rest use the default. */
const expansions = new Map<string, Map<string, boolean>>();

export function expansionFor(stateKey: string): Map<string, boolean> {
  let m = expansions.get(stateKey);
  if (!m) {
    m = new Map();
    expansions.set(stateKey, m);
    if (expansions.size > 60) expansions.delete(expansions.keys().next().value!);
  }
  return m;
}

/** Small torrents open fully; big ones only show their top level. */
export function defaultExpanded(model: TreeModel, n: TreeNode): boolean {
  return model.fileCount <= 500 || n.depth === 0;
}

/** Keep a renamed folder (and the folders inside it) open or closed as they were. */
export function moveExpansion(stateKey: string, oldPath: string, newPath: string): void {
  const m = expansions.get(stateKey);
  if (!m) return;
  for (const [k, v] of [...m]) {
    const p = k.slice(2);
    if (k.startsWith("d:") && (p === oldPath || p.startsWith(`${oldPath}/`))) {
      m.delete(k);
      m.set(`d:${newPath}${p.slice(oldPath.length)}`, v);
    }
  }
}

// ------------------------------------------------------------------ names
const WINDOWS_BAD = /[<>:"|?*\u0000-\u001f]/;

/** Why a new name for `node` is not acceptable, or null when it is. */
export function nameError(name: string, node: TreeNode, windows: boolean): string | null {
  if (!name.trim()) return "The name can't be empty";
  if (/[\\/]/.test(name)) return "Names can't contain slashes";
  if (name === "." || name === "..") return "That isn't a valid name";
  if (windows && WINDOWS_BAD.test(name)) return 'Names can\'t contain < > : " | ? *';
  if (windows && /[. ]$/.test(name)) return "Names can't end with a dot or a space";
  const lower = name.toLowerCase();
  const siblings = node.parent?.children ?? [];
  if (siblings.some((s) => s !== node && s.name.toLowerCase() === lower)) {
    return "Something with that name already exists here";
  }
  return null;
}

/** The parent folder's path ("" at the top level). */
export function parentPath(n: TreeNode): string {
  return n.parent && n.parent.depth >= 0 ? n.parent.path : "";
}

// ------------------------------------------------------------------ file kinds
const KINDS: [RegExp, FileKind][] = [
  [/\.(mkv|mp4|m4v|avi|mov|wmv|webm|flv|mpe?g|ts|m2ts|vob|ogv|3gp|rmvb|divx)$/i, "video"],
  [/\.(mp3|flac|wav|aac|ogg|oga|opus|m4a|wma|ape|alac|aiff?|dsf|mka)$/i, "audio"],
  [/\.(jpe?g|png|gif|bmp|webp|tiff?|svg|heic|avif|ico|psd)$/i, "image"],
  [/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|lz|cab|r\d\d|z\d\d|\d{3})$/i, "archive"],
  [/\.(iso|img|bin|cue|dmg|vhdx?|mdf|nrg)$/i, "disc"],
  [/\.(srt|sub|ass|ssa|vtt|idx|sup)$/i, "subtitle"],
  [/\.(txt|nfo|md|pdf|docx?|odt|rtf|epub|mobi|azw3|djvu|cbz|cbr|log|sfv|md5|sha\d*)$/i, "text"],
  [/\.(exe|msi|apk|appimage|deb|rpm|pkg|bat|cmd|sh|dll|so)$/i, "program"],
  [/\.(js|ts|py|c|cpp|h|rs|go|java|json|xml|html?|css|ya?ml|toml|ini|cfg)$/i, "code"],
];

export type FileKind = "video" | "audio" | "image" | "archive" | "disc" | "subtitle" | "text" | "program" | "code" | "file";

export function fileKind(name: string): FileKind {
  for (const [re, kind] of KINDS) if (re.test(name)) return kind;
  return "file";
}
