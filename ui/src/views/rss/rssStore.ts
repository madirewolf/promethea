// RSS: the feeds, the articles this page has looked at, the reader's selection and the
// download rules. Everything lives in the backend's RssManager; "rss.*" events say what
// changed and this page fetches it again.

import { create } from "zustand";
import { ApiError, api } from "../../api/client";
import type { RssArticle, RssFeed, RssMatch, RssRule, RssSnapshot } from "../../api/types";
import { on } from "../../lib/events";
import { plural } from "../../lib/format";
import { queueAdd, toast, toastError, useStore } from "../../store/store";
import { magnetHash, wantsDialog } from "../search/searchStore";

/** What the article list shows: "unread", "f:<feed id>" or "d:<folder path>". */
export type Scope = string;

export const UNREAD: Scope = "unread";

export interface Selection {
  selected: ReadonlySet<string>;
  anchor: string | null;
  /** The article in the reader. */
  focused: string | null;
}

export const NO_SELECTION: Selection = { selected: new Set(), anchor: null, focused: null };

/** An article and the feed it's from. Article ids are only unique within a feed; keys are unique. */
export interface Item {
  key: string;
  feedId: string;
  a: RssArticle;
}

interface RssState {
  /** The feed list has been fetched. */
  loaded: boolean;
  /** Why it couldn't be. */
  error: string;
  feeds: RssFeed[];
  folders: string[];
  /** Articles of the feeds looked at, by feed id, newest first. */
  articles: Record<string, RssArticle[]>;
  /** Why the last fetch of articles failed. */
  articlesError: string;
  scope: Scope;
  /** The article filter. */
  text: string;
  selection: Selection;
  /** Read while the Unread list is open: they stay in it until it's left. */
  keep: Record<string, true>;
  /** Articles whose torrent is being fetched, by key. */
  fetching: Record<string, true>;
  /** Torrent ids of the articles downloaded from here, by key. */
  resolved: Record<string, string>;
  rules: RssRule[] | null;
  rulesError: string;
  /** How many unread articles there were when the RSS view was last open (for the sidebar badge). */
  seen: number | null;
}

const PREFS_KEY = "promethea.rss.v1";

function loadPrefs(): Pick<RssState, "scope" | "seen"> {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    return {
      scope: typeof saved?.scope === "string" ? saved.scope : UNREAD,
      seen: typeof saved?.seen === "number" ? saved.seen : null,
    };
  } catch {
    return { scope: UNREAD, seen: null };
  }
}

export const useRss = create<RssState>()(() => ({
  loaded: false,
  error: "",
  feeds: [],
  folders: [],
  articles: {},
  articlesError: "",
  text: "",
  selection: NO_SELECTION,
  keep: {},
  fetching: {},
  resolved: {},
  rules: null,
  rulesError: "",
  ...loadPrefs(),
}));

useRss.subscribe((s, prev) => {
  if (s.scope === prev.scope && s.seen === prev.seen) return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: s.scope, seen: s.seen }));
  } catch {
    /* storage unavailable: it's just not remembered */
  }
});

const set = useRss.setState;
const get = useRss.getState;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const gone = (e: unknown) => e instanceof ApiError && e.status === 404;

// Feed ids are hex, so the first space is where the article id starts.
export function itemKey(feedId: string, articleId: string): string {
  return `${feedId} ${articleId}`;
}

export function splitKey(key: string): [string, string] {
  const i = key.indexOf(" ");
  return [key.slice(0, i), key.slice(i + 1)];
}

// ------------------------------------------------------------------ derived
const unreadCounts = new WeakMap<RssArticle[], number>();

function countUnread(list: RssArticle[]): number {
  let n = unreadCounts.get(list);
  if (n === undefined) {
    n = 0;
    for (const a of list) if (!a.read) n++;
    unreadCounts.set(list, n);
  }
  return n;
}

/** A feed's unread articles: counted from the ones this page has (so it matches the list), else the backend's count. */
export function feedUnread(feed: RssFeed, articles: Record<string, RssArticle[]>): number {
  const list = articles[feed.id];
  return list ? countUnread(list) : feed.unread;
}

export function totalUnread(s: Pick<RssState, "feeds" | "articles">): number {
  let n = 0;
  for (const f of s.feeds) n += feedUnread(f, s.articles);
  return n;
}

export function scopeUnread(s: Pick<RssState, "feeds" | "articles">, scope: Scope): number {
  let n = 0;
  for (const f of scopeFeeds(s, scope)) n += feedUnread(f, s.articles);
  return n;
}

export function inFolder(folder: string, path: string): boolean {
  return folder === path || folder.startsWith(`${path}/`);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** The feeds a scope covers (Unread: all of them). */
export function scopeFeeds(s: Pick<RssState, "feeds">, scope: Scope): RssFeed[] {
  if (scope.startsWith("f:")) {
    const id = scope.slice(2);
    return s.feeds.filter((f) => f.id === id);
  }
  if (scope.startsWith("d:")) {
    const path = scope.slice(2);
    return s.feeds.filter((f) => inFolder(f.folder, path));
  }
  return s.feeds;
}

function scopeExists(s: Pick<RssState, "feeds" | "folders">, scope: Scope): boolean {
  if (scope === UNREAD) return true;
  if (scope.startsWith("f:")) return s.feeds.some((f) => f.id === scope.slice(2));
  if (scope.startsWith("d:")) return s.folders.includes(scope.slice(2));
  return false;
}

/** The scope's feeds whose articles the list needs (feeds with nothing to show are skipped). */
export function wantedFeeds(s: Pick<RssState, "feeds" | "articles">, scope: Scope): RssFeed[] {
  return scopeFeeds(s, scope).filter((f) => (scope === UNREAD ? feedUnread(f, s.articles) > 0 : f.total > 0) || !!s.articles[f.id]);
}

const items = new WeakMap<RssArticle, Item>();

function itemOf(feedId: string, a: RssArticle): Item {
  let it = items.get(a);
  if (!it) {
    it = { key: itemKey(feedId, a.id), feedId, a };
    items.set(a, it);
  }
  return it;
}

/** What the list shows for the current scope (before the text filter), newest first. */
export function scopeItems(s: Pick<RssState, "feeds" | "articles" | "scope" | "keep">): Item[] {
  const unread = s.scope === UNREAD;
  const out: Item[] = [];
  for (const f of scopeFeeds(s, s.scope)) {
    const list = s.articles[f.id];
    if (!list) continue;
    for (const a of list) {
      const it = itemOf(f.id, a);
      if (!unread || !a.read || s.keep[it.key]) out.push(it);
    }
  }
  // Stable: undated articles and ties keep the feed's order.
  return out.sort((x, y) => y.a.date - x.a.date);
}

export function findItem(s: Pick<RssState, "articles">, key: string | null): Item | null {
  if (!key) return null;
  const [feedId, id] = splitKey(key);
  const a = s.articles[feedId]?.find((x) => x.id === id);
  return a ? itemOf(feedId, a) : null;
}

export function scopeTitle(s: Pick<RssState, "feeds">, scope: Scope): string {
  if (scope.startsWith("f:")) return s.feeds.find((f) => f.id === scope.slice(2))?.name ?? "Feed";
  if (scope.startsWith("d:")) return baseName(scope.slice(2));
  return "Unread";
}

/** The folder new feeds go in: the selected folder, or the selected feed's. */
export function scopeFolder(s: Pick<RssState, "feeds">, scope: Scope): string {
  if (scope.startsWith("d:")) return scope.slice(2);
  if (scope.startsWith("f:")) return s.feeds.find((f) => f.id === scope.slice(2))?.folder ?? "";
  return "";
}

function isTorrentLike(url: string): boolean {
  const low = url.trim().toLowerCase();
  if (low.startsWith("magnet:") || low.endsWith(".torrent")) return true;
  try {
    return new URL(low).pathname.endsWith(".torrent");
  } catch {
    return false;
  }
}

/** A torrent, or a tracker's download link (tracker feeds often put those in <link>). */
function isDownloadLink(url: string): boolean {
  return (
    isTorrentLike(url) ||
    /\/(download|dl)(\.php)?(\/|\?|$)|[?&](passkey|authkey|torrent_pass)=|[?&]action=download\b/i.test(url)
  );
}

/**
 * The article names a torrent. Feeds without one get their article link as the torrent
 * address (qBittorrent does the same); that's only a guess when it's an ordinary web page.
 */
export function hasTorrent(a: RssArticle): boolean {
  return !!a.torrentUrl && (a.torrentUrl !== a.link || isDownloadLink(a.link));
}

/** The article's web page, when it has one to open. */
export function pageUrl(a: RssArticle): string | null {
  return /^https?:\/\//i.test(a.link) && !isDownloadLink(a.link) ? a.link : null;
}

const hashes = new WeakMap<RssArticle, string | null>();

/** The torrent an article is, when known. */
export function articleTorrentId(it: Item, resolved: Record<string, string>): string | null {
  const known = resolved[it.key];
  if (known) return known;
  let h = hashes.get(it.a);
  if (h === undefined) {
    h = magnetHash(it.a.torrentUrl);
    hashes.set(it.a, h);
  }
  return h;
}

// ------------------------------------------------------------------ the badge
/** Keeps `seen` up to date: it follows the count while the RSS view is open, and whenever it drops. */
function syncSeen(): void {
  const s = get();
  if (!s.loaded) return;
  const total = totalUnread(s);
  if (s.seen === total) return;
  if (s.seen === null || total < s.seen || useStore.getState().view === "rss") set({ seen: total });
}

/** Articles that came in since the RSS view was last open. */
export function useRssBadge(): number {
  return useRss((s) => (s.loaded && s.seen !== null ? Math.max(0, totalUnread(s) - s.seen) : 0));
}

// ------------------------------------------------------------------ loading
let feedsSeq = 0;

/** Fetch the feed list (and their unread counts). */
export async function loadFeeds(): Promise<void> {
  const n = ++feedsSeq;
  let snap: RssSnapshot;
  try {
    snap = await api.rssSnapshot();
  } catch (e) {
    if (n === feedsSeq) set({ error: message(e) });
    return;
  }
  if (n !== feedsSeq) return; // a newer one is on its way
  set((s) => {
    const ids = new Set(snap.feeds.map((f) => f.id));
    let articles = s.articles;
    for (const id of Object.keys(articles)) {
      if (ids.has(id)) continue;
      if (articles === s.articles) articles = { ...articles };
      delete articles[id];
    }
    const next = { loaded: true, error: "", feeds: snap.feeds, folders: snap.folders, articles };
    if (scopeExists(next, s.scope)) return next;
    // What was shown is gone (removed here or in another window).
    return { ...next, scope: UNREAD, selection: NO_SELECTION, keep: {}, text: "" };
  });
  syncSeen();
  ensureArticles();
}

let feedsTimer = 0;

function scheduleFeeds(): void {
  if (feedsTimer) return;
  feedsTimer = window.setTimeout(() => {
    feedsTimer = 0;
    void loadFeeds();
  }, 150);
}

/**
 * Articles marked read from here, by key: the tick their request finished at (Infinity while
 * it runs). Articles fetched before then may not show it yet; they're kept read.
 */
const marked = new Map<string, number>();
let tick = 0;

function withMarks(feedId: string, list: RssArticle[], started: number): RssArticle[] {
  if (!marked.size) return list;
  let out: RssArticle[] | null = null;
  list.forEach((a, i) => {
    const key = itemKey(feedId, a.id);
    const done = marked.get(key);
    if (done === undefined) return;
    if (done < started) {
      marked.delete(key); // the backend had it when this was fetched
      return;
    }
    if (!a.read) {
      out ??= list.slice();
      out[i] = { ...a, read: true };
    }
  });
  return out ?? list;
}

const inflight = new Set<string>();
/** Changed while being fetched: fetched again once that's done. */
const stale = new Set<string>();
let wanted = new Set<string>();
let articlesTimer = 0;

function scheduleArticles(ids: Iterable<string>, delay = 150): void {
  for (const id of ids) wanted.add(id);
  if (articlesTimer) return;
  articlesTimer = window.setTimeout(() => void fetchArticles(), delay);
}

async function fetchArticles(): Promise<void> {
  articlesTimer = 0;
  const ids: string[] = [];
  for (const id of wanted) {
    if (inflight.has(id)) stale.add(id);
    else ids.push(id);
  }
  wanted = new Set();
  if (!ids.length) return;
  for (const id of ids) inflight.add(id);
  const started = ++tick;
  try {
    const byFeed = await api.rss<Record<string, RssArticle[]>>("articles_by_feed", { feed_ids: ids });
    set((s) => {
      const known = new Set(s.feeds.map((f) => f.id));
      const articles = { ...s.articles };
      for (const id of ids) {
        const list = byFeed[id];
        if (list && known.has(id)) articles[id] = withMarks(id, list, started);
        else delete articles[id];
      }
      return { articles, articlesError: "" };
    });
  } catch (e) {
    set({ articlesError: message(e) });
  } finally {
    for (const id of ids) inflight.delete(id);
    const again = ids.filter((id) => stale.delete(id));
    if (again.length) scheduleArticles(again, 0);
    syncSeen();
  }
}

/** Fetch the articles the current scope shows that this page doesn't have yet (while the RSS view is open). */
export function ensureArticles(): void {
  const s = get();
  if (!s.loaded || useStore.getState().view !== "rss") return;
  const missing = wantedFeeds(s, s.scope)
    .filter((f) => !s.articles[f.id] && !inflight.has(f.id))
    .map((f) => f.id);
  if (missing.length) scheduleArticles(missing, 0);
}

/** Try again after a failure. */
export function reloadArticles(): void {
  set({ articlesError: "" });
  const s = get();
  scheduleArticles(wantedFeeds(s, s.scope).map((f) => f.id), 0);
}

/** Some of the scope's feeds are still on their way. */
export function articlesPending(s: Pick<RssState, "feeds" | "articles" | "scope">): boolean {
  return wantedFeeds(s, s.scope).some((f) => !s.articles[f.id]);
}

on("rss.feeds", () => scheduleFeeds());

on("rss.feed", (d: { feedId?: string }) => {
  scheduleFeeds();
  if (d?.feedId && get().articles[d.feedId]) scheduleArticles([d.feedId]);
});

on("rss.rules", () => {
  if (get().rules !== null) void loadRules();
});

// Events were missed while the connection was down; the badge needs the counts from the start.
useStore.subscribe((s, prev) => {
  if (s.connected && !prev.connected) {
    void loadFeeds();
    const cached = Object.keys(get().articles);
    if (cached.length) scheduleArticles(cached, 0);
    if (get().rules !== null) void loadRules();
  }
  if (s.view !== prev.view) {
    syncSeen();
    if (s.view === "rss") ensureArticles();
  }
});

if (useStore.getState().connected) void loadFeeds();

// ------------------------------------------------------------------ the list
export function setScope(scope: Scope): void {
  if (scope === get().scope) {
    ensureArticles();
    return;
  }
  set({ scope, selection: NO_SELECTION, keep: {}, text: "" });
  ensureArticles();
}

export function setText(text: string): void {
  set({ text });
}

/** Select articles; the one that gets the focus goes in the reader and is marked read. */
export function setSelection(selection: Selection): void {
  const prev = get().selection.focused;
  set({ selection });
  if (selection.focused && selection.focused !== prev) markRead([selection.focused]);
}

export function markRead(keys: string[]): void {
  const s = get();
  const byFeed = new Map<string, Set<string>>();
  for (const key of keys) {
    const [feedId, id] = splitKey(key);
    let ids = byFeed.get(feedId);
    if (!ids) byFeed.set(feedId, (ids = new Set()));
    ids.add(id);
  }
  const articles = { ...s.articles };
  const keep = s.scope === UNREAD ? { ...s.keep } : s.keep;
  const calls: [string, string[]][] = [];
  for (const [feedId, ids] of byFeed) {
    const list = articles[feedId];
    if (!list) continue;
    const flipped: string[] = [];
    const next = list.map((a) => {
      if (a.read || !ids.has(a.id)) return a;
      flipped.push(a.id);
      return { ...a, read: true };
    });
    if (!flipped.length) continue;
    articles[feedId] = next;
    calls.push([feedId, flipped]);
    for (const id of flipped) {
      const key = itemKey(feedId, id);
      marked.set(key, Infinity);
      if (keep !== s.keep) keep[key] = true;
    }
  }
  if (!calls.length) return;
  set({ articles, keep });
  syncSeen();
  for (const [feedId, ids] of calls) {
    api
      .rss("mark_read", { feed_id: feedId, article_ids: ids })
      .then(() => {
        const done = ++tick;
        for (const id of ids) marked.set(itemKey(feedId, id), done);
      })
      .catch((e) => {
        for (const id of ids) marked.delete(itemKey(feedId, id));
        if (!gone(e)) toastError(e, "Couldn't mark it read");
        scheduleFeeds();
        scheduleArticles([feedId], 0);
      });
  }
}

/** Mark everything in a scope read (Unread: every feed). */
export async function markAllRead(scope: Scope = get().scope): Promise<void> {
  const s = get();
  const feeds = scopeFeeds(s, scope);
  const ids = new Set(feeds.map((f) => f.id));
  const articles = { ...s.articles };
  for (const id of ids) {
    const list = articles[id];
    if (!list || !countUnread(list)) continue;
    articles[id] = list.map((a) => {
      if (a.read) return a;
      marked.set(itemKey(id, a.id), Infinity);
      return { ...a, read: true };
    });
  }
  set({
    articles,
    feeds: s.feeds.map((f) => (ids.has(f.id) && f.unread ? { ...f, unread: 0 } : f)),
    // In the Unread list that's the point: it empties.
    keep: scope === UNREAD && s.scope === UNREAD ? {} : s.keep,
  });
  syncSeen();
  try {
    await api.rss("mark_all_read", { feed_ids: scope === UNREAD ? null : [...ids] });
  } catch (e) {
    toastError(e, "Couldn't mark them read");
  } finally {
    const done = ++tick;
    for (const [key, t] of marked) if (t === Infinity && ids.has(splitKey(key)[0])) marked.set(key, done);
    scheduleFeeds();
  }
}

// ------------------------------------------------------------------ downloading
function remember(key: string, id: string | undefined): void {
  if (id) set((s) => ({ resolved: { ...s.resolved, [key]: id } }));
}

async function downloadOne(it: Item, dialog: boolean): Promise<void> {
  const { key, a } = it;
  const name = a.title || "the torrent";
  if (!a.torrentUrl) {
    toast("info", a.title || "This article", { title: "There's no torrent to download" });
    return;
  }
  if (get().fetching[key]) return;
  set((s) => ({ fetching: { ...s.fetching, [key]: true } }));
  let ok = false;
  try {
    if (dialog) {
      const info = await api.inspectText(a.torrentUrl);
      remember(key, info.id);
      queueAdd(info);
      ok = true;
    } else {
      const res = await api.addSources([a.torrentUrl]);
      if (res.added.length) {
        remember(key, res.added[0]);
        toast("success", a.title || a.torrentUrl, { title: "Torrent added", ms: 2500 });
        ok = true;
      }
      for (const d of res.duplicates) {
        remember(key, d.id);
        toast("info", d.error, { title: "Already added" });
        ok = true;
      }
      for (const e of res.errors) toast("error", e.error, { title: `Couldn't add “${name}”` });
    }
  } catch (e) {
    toastError(e, `Couldn't get “${name}”`);
  } finally {
    set((s) => {
      const fetching = { ...s.fetching };
      delete fetching[key];
      return { fetching };
    });
  }
  if (ok) markRead([key]);
}

/** Add the articles' torrents to the transfer list (through the add dialog when that's the preference). */
export function downloadArticles(list: Item[], opts: { dialog?: boolean } = {}): void {
  const dialog = opts.dialog ?? wantsDialog();
  for (const it of list) void downloadOne(it, dialog);
}

// ------------------------------------------------------------------ feeds & folders
export async function addFeed(url: string, folder: string): Promise<RssFeed> {
  const feed = await api.rss<RssFeed>("add_feed", { url, folder });
  await loadFeeds();
  setScope(`f:${feed.id}`);
  const title = `Added “${feed.name}”`;
  if (feed.error) toast("warning", feed.error, { title: `${title}, but couldn't read it` });
  else if (useStore.getState().prefs?.rss?.fetchEnabled === false)
    toast("info", "Fetching feeds is turned off in Settings, so it won't update until that's on.", { title });
  else toast("success", feed.total ? plural(feed.total, "article") : "No articles in it yet", { title, ms: 3000 });
  return feed;
}

export async function removeFeeds(ids: string[]): Promise<void> {
  await api.rss("remove_feeds", { feed_ids: ids });
  await loadFeeds();
}

export async function renameFeed(id: string, name: string): Promise<void> {
  await api.rss("update_feed", { feed_id: id, name });
  await loadFeeds();
}

export async function moveFeed(id: string, folder: string): Promise<void> {
  await api.rss("update_feed", { feed_id: id, folder });
  await loadFeeds();
}

export async function setFeedUrl(id: string, url: string): Promise<void> {
  await api.rss("update_feed", { feed_id: id, url });
  await loadFeeds();
}

/** Fetch feeds now (null: all of them). Their spinners show while it runs. */
export function refreshFeeds(ids: string[] | null): void {
  if (ids && !ids.length) return;
  api.rss("refresh", { feed_ids: ids }).catch((e) => toastError(e, "Couldn't update"));
}

export async function addFolder(path: string): Promise<void> {
  await api.rss("add_folder", { path });
  await loadFeeds();
}

export async function renameFolder(path: string, newPath: string): Promise<void> {
  if (path === newPath) return;
  await api.rss("rename_folder", { path, new_path: newPath });
  // Keep showing it, and keep it open or closed as it was.
  const { scope } = get();
  if (scope.startsWith("d:") && inFolder(scope.slice(2), path)) set({ scope: `d:${newPath}${scope.slice(2 + path.length)}` });
  const { collapsed } = useStore.getState();
  const moved: Record<string, boolean> = {};
  let any = false;
  for (const k of Object.keys(collapsed)) {
    if (k.startsWith("rss:") && inFolder(k.slice(4), path)) {
      moved[`rss:${newPath}${k.slice(4 + path.length)}`] = collapsed[k];
      any = true;
    } else moved[k] = collapsed[k];
  }
  if (any) useStore.setState({ collapsed: moved });
  await loadFeeds();
}

export async function removeFolder(path: string): Promise<void> {
  await api.rss("remove_folder", { path });
  await loadFeeds();
}

// ------------------------------------------------------------------ rules
export async function loadRules(): Promise<void> {
  try {
    const rules = await api.rss<RssRule[]>("rules");
    set({ rules, rulesError: "" });
  } catch (e) {
    set({ rulesError: message(e) });
  }
}

function byPriority(a: RssRule, b: RssRule): number {
  // The backend's order: priority, then the name ignoring case.
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return a.priority - b.priority || (x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export async function renameRule(oldName: string, newName: string): Promise<void> {
  await api.rss("rename_rule", { old: oldName, new: newName });
  set((s) => (s.rules ? { rules: s.rules.map((r) => (r.name === oldName ? { ...r, name: newName } : r)).sort(byPriority) } : s));
}

/** Create a rule, or replace the one with its name. */
export async function saveRule(rule: RssRule): Promise<RssRule> {
  const saved = await api.rss<RssRule>("set_rule", { rule });
  set((s) => (s.rules ? { rules: [...s.rules.filter((r) => r.name !== saved.name), saved].sort(byPriority) } : s));
  return saved;
}

export async function deleteRules(names: string[]): Promise<void> {
  await api.rss("delete_rules", { names });
  set((s) => (s.rules ? { rules: s.rules.filter((r) => !names.includes(r.name)) } : s));
}

export function previewRule(rule: RssRule): Promise<RssMatch[]> {
  return api.rss<RssMatch[]>("preview_rule", { rule });
}

export async function clearEpisodes(name: string): Promise<void> {
  await api.rss("clear_episode_history", { name });
  set((s) => (s.rules ? { rules: s.rules.map((r) => (r.name === name ? { ...r, previouslyMatchedEpisodes: [] } : r)) } : s));
}
