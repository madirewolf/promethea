import type {
  AddOptions,
  AddResult,
  AppInfo,
  AuthState,
  BlockedPeer,
  CreatorJob,
  CreatorOptions,
  CreatorSource,
  FilesResponse,
  InspectInfo,
  LogEntry,
  Peer,
  PiecesResponse,
  PluginUpdate,
  PluginUpdateResult,
  Prefs,
  Properties,
  RssSnapshot,
  SearchDetails,
  SearchPlugin,
  SearchSummary,
  Torrent,
  TrackerEntry,
} from "./types";

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let unauthorizedHandler: (() => void) | null = null;

/** Called whenever the backend answers 401 (session expired, logged out elsewhere). */
export function onUnauthorized(fn: () => void): void {
  unauthorizedHandler = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Can't reach Promethea. Is it still running?", 0, null);
  }
  const type = res.headers.get("content-type") ?? "";
  const data: any = type.includes("json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/auth/login") unauthorizedHandler?.();
    const msg = (data && typeof data === "object" && data.error) || (typeof data === "string" && data) || res.statusText;
    throw new ApiError(String(msg), res.status, data);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T = { ok: true }>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const q = (params: Record<string, string | number>) => new URLSearchParams(params as Record<string, string>).toString();
const tid = (id: string) => `/api/torrents/${encodeURIComponent(id)}`;

export type TorrentAction =
  | "start"
  | "forceStart"
  | "stop"
  | "recheck"
  | "reannounce"
  | "queueTop"
  | "queueUp"
  | "queueDown"
  | "queueBottom"
  | "sequential"
  | "firstLast"
  | "superSeeding"
  | "autoTMM"
  | "startAll"
  | "stopAll";

export interface SetProps {
  category?: string;
  tags?: { tags: string[]; mode: "add" | "remove" | "set" };
  dlLimit?: number | null;
  upLimit?: number | null;
  shareLimits?: { ratio: number; seedingTime: number; inactiveSeedingTime: number };
}

export interface DialogOptions {
  kind: "open" | "folder" | "save";
  title?: string;
  directory?: string;
  multiple?: boolean;
  /** e.g. ["Torrent files (*.torrent)", "All files (*.*)"] */
  fileTypes?: string[];
  saveName?: string;
}

export const api = {
  // auth & app
  authState: () => get<AuthState>("/api/auth/state"),
  login: (username: string, password: string) => post("/api/auth/login", { username, password }),
  logout: () => post("/api/auth/logout"),
  app: () => get<AppInfo>("/api/app"),
  quit: () => post("/api/app/quit"),
  prefs: () => get<Prefs>("/api/prefs"),
  setPrefs: (patch: Prefs) => post<Prefs>("/api/prefs", patch),
  log: (after = 0) => get<LogEntry[]>(`/api/log?${q({ after })}`),
  blocked: () => get<BlockedPeer[]>("/api/log/blocked"),

  // desktop bridge (desktop window only)
  dialog: (opts: DialogOptions) => post<{ paths: string[] }>("/api/dialog", opts).then((r) => r.paths),
  openContent: (id: string, path?: string) => post("/api/os/open", { id, path }),
  revealContent: (id: string, path?: string) => post("/api/os/open", { id, path, reveal: true }),
  openUrl: (url: string) => post("/api/os/url", { url }),
  associate: () => post<{ fileAssociation: boolean }>("/api/os/associate"),
  setAutostart: (enabled: boolean) => post<{ autostart: boolean }>("/api/os/autostart", { enabled }),

  // filesystem helpers
  freeSpace: (path: string) => get<{ path: string; free: number }>(`/api/fs/freespace?${q({ path })}`),
  completeDirs: (path: string) => get<{ dirs: string[] }>(`/api/fs/complete?${q({ path })}`).then((r) => r.dirs),

  // torrents
  torrents: () => get<Record<string, Torrent>>("/api/torrents"),
  inspectFile: (file: Blob, name = "file.torrent") => {
    const form = new FormData();
    form.append("file", file, name);
    return post<InspectInfo>("/api/torrents/inspect", form);
  },
  inspectText: (text: string) => post<InspectInfo>("/api/torrents/inspect", { text }),
  cancelInspect: (token: string) => post("/api/torrents/inspect/cancel", { token }),
  addToken: (token: string, options: AddOptions) => post<AddResult>("/api/torrents/add", { token, options }),
  addSources: (sources: string[], options: AddOptions = {}) =>
    post<AddResult>("/api/torrents/add", { sources, options }),
  addFiles: (files: File[], options: AddOptions = {}) => {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    form.append("options", JSON.stringify(options));
    return post<AddResult>("/api/torrents/add", form);
  },
  action: (action: TorrentAction, ids: string[] | "all" = [], value?: boolean) =>
    post("/api/torrents/action", { action, ids, value }),
  remove: (ids: string[], deleteFiles: boolean) => post("/api/torrents/delete", { ids, deleteFiles }),
  set: (ids: string[], props: SetProps) => post("/api/torrents/set", { ids, ...props }),
  setLocation: (ids: string[], path: string) => post("/api/torrents/location", { ids, path }),
  rename: (id: string, name: string) => post("/api/torrents/rename", { id, name }),

  properties: (id: string) => get<Properties>(`${tid(id)}/properties`),
  files: (id: string) => get<FilesResponse>(`${tid(id)}/files`),
  peers: (id: string) => get<Peer[]>(`${tid(id)}/peers`),
  trackers: (id: string) => get<TrackerEntry[]>(`${tid(id)}/trackers`),
  webSeeds: (id: string) => get<string[]>(`${tid(id)}/webseeds`),
  pieces: (id: string, buckets = 1024) => get<PiecesResponse>(`${tid(id)}/pieces?${q({ buckets })}`),
  exportUrl: (id: string) => `${tid(id)}/export`,
  /** Desktop only: write .torrent files into a folder. */
  exportTo: (ids: string[], dir: string) => post<{ written: string[] }>("/api/torrents/export", { ids, dir }),
  setFilePriority: (id: string, indices: number[], priority: number) =>
    post(`${tid(id)}/files/priority`, { indices, priority }),
  renamePath: (id: string, oldPath: string, newPath: string) =>
    post(`${tid(id)}/files/rename`, { old: oldPath, new: newPath }),
  addPeers: (id: string, peers: string[]) => post<{ added: number }>(`${tid(id)}/peers/add`, { peers }),
  editTrackers: (id: string, change: { add?: string[]; remove?: string[]; edit?: Record<string, string> }) =>
    post(`${tid(id)}/trackers`, change),
  editWebSeeds: (id: string, change: { add?: string[]; remove?: string[] }) => post(`${tid(id)}/webseeds`, change),
  banPeers: (ips: string[]) => post("/api/peers/ban", { ips }),

  // categories, tags, speed
  setCategory: (name: string, savePath: string, oldName?: string) =>
    post("/api/categories", { name, savePath, oldName }),
  deleteCategories: (names: string[]) => post("/api/categories/delete", { names }),
  createTags: (tags: string[]) => post("/api/tags", { tags }),
  deleteTags: (tags: string[]) => post("/api/tags/delete", { tags }),
  setAltSpeed: (enabled: boolean) => post("/api/transfer/alt", { enabled }),
  setGlobalLimits: (dl: number | null, ul: number | null) => post("/api/transfer/limits", { dl, ul }),

  // torrent creator
  creatorJobs: () => get<CreatorJob[]>("/api/creator"),
  /** Files, size and pieces of a torrent made from `source`, without hashing anything. */
  inspectSource: (source: string, options: Pick<CreatorOptions, "format" | "pieceSize">) =>
    post<CreatorSource>("/api/creator/inspect", { source, options }),
  /** Fails with 409 and `data.exists` when `output` is there already, unless `overwrite`. */
  createTorrent: (source: string, output: string, options: CreatorOptions, overwrite = false) =>
    post<CreatorJob>("/api/creator", { source, output, options, overwrite }),
  cancelCreator: (id: string) => post(`/api/creator/${encodeURIComponent(id)}/cancel`),
  /** Desktop only: show the finished .torrent file in the file manager. */
  revealCreated: (id: string) => post(`/api/creator/${encodeURIComponent(id)}/reveal`),

  // search
  searchPlugins: () => get<{ plugins: SearchPlugin[]; categories: Record<string, string> }>("/api/search/plugins"),
  /** The official plugin repository's list (needs the internet). */
  officialPlugins: () => get<{ name: string; version: string; installed: boolean }[]>("/api/search/plugins/official"),
  installPluginUrl: (url: string) => post<SearchPlugin>("/api/search/plugins/install", { url }),
  installPluginFile: (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return post<SearchPlugin>("/api/search/plugins/install", form);
  },
  uninstallPlugins: (names: string[]) => post("/api/search/plugins/uninstall", { names }),
  enablePlugin: (name: string, enabled: boolean) => post("/api/search/plugins/enable", { name, enabled }),
  checkPluginUpdates: () => get<PluginUpdate[]>("/api/search/plugins/updates"),
  /** Installs from the official repository too (for names that aren't installed yet). */
  updatePlugins: (names: string[]) => post<PluginUpdateResult[]>("/api/search/plugins/update", { names }),
  searches: () => get<SearchSummary[]>("/api/search"),
  startSearch: (query: string, category = "all", plugins: string[] | null = null) =>
    post<{ id: string }>("/api/search", { query, category, plugins }),
  getSearch: (id: string, offset = 0) => get<SearchDetails>(`/api/search/${encodeURIComponent(id)}?${q({ offset })}`),
  stopSearch: (id: string) => post(`/api/search/${encodeURIComponent(id)}/stop`),
  removeSearch: (id: string) => post(`/api/search/${encodeURIComponent(id)}/remove`),
  /** Fetch a result's torrent (through its plugin when needed) for the add dialog. */
  searchInspect: (plugin: string, url: string) =>
    post<{ info: InspectInfo }>("/api/search/download", { plugin, url, dialog: true }).then((r) => r.info),
  /** Fetch a result's torrent and add it. A duplicate fails with status 409. */
  searchAdd: (plugin: string, url: string, options: AddOptions = {}) =>
    post<{ id: string }>("/api/search/download", { plugin, url, options }),

  // rss (methods map onto RssManager)
  rssSnapshot: () => get<RssSnapshot>("/api/rss"),
  rss: <T = any>(method: string, args: Record<string, unknown> = {}) =>
    post<{ result: T }>("/api/rss/call", { method, args }).then((r) => r.result),
};
