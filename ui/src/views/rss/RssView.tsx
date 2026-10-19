// RSS: feeds and folders of them in the sidebar, the articles of the one picked in a list,
// the selected article in the reader. What it all does is in rssStore.ts.

import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import {
  ArrowDownUp,
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  CircleX,
  Copy,
  Download,
  ExternalLink,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Inbox,
  Link2,
  MailCheck,
  Menu as MenuIcon,
  Newspaper,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  SearchX,
  SlidersHorizontal,
  Trash,
  WandSparkles,
  Zap,
} from "lucide-react";
import type { RssArticle, RssFeed } from "../../api/types";
import { registerSidebarSection } from "../../components/shell/Sidebar";
import { Button, IconButton } from "../../components/ui/Button";
import { SearchInput } from "../../components/ui/Form";
import { openContextMenu, openDropdown, openMenu } from "../../components/ui/Menu";
import type { MenuEntry } from "../../components/ui/Menu";
import { Empty, Spinner } from "../../components/ui/Misc";
import { attempt, copyText, openExternal } from "../../lib/actions";
import { addSources } from "../../lib/add";
import { formatAgo, formatDate, plural } from "../../lib/format";
import { onScrollbar, useEvent, useNow } from "../../lib/hooks";
import { openDialog, selectOnly, setView, toggleCollapsed, useStore } from "../../store/store";
import { wantsDialog } from "../search/searchStore";
import {
  UNREAD,
  addFeed,
  addFolder,
  articleTorrentId,
  articlesPending,
  baseName,
  downloadArticles,
  ensureArticles,
  feedUnread,
  findItem,
  hasTorrent,
  inFolder,
  joinPath,
  loadFeeds,
  markAllRead,
  markRead,
  moveFeed,
  pageUrl,
  parentOf,
  refreshFeeds,
  reloadArticles,
  removeFeeds,
  removeFolder,
  renameFeed,
  renameFolder,
  scopeFeeds,
  scopeFolder,
  scopeItems,
  scopeTitle,
  scopeUnread,
  setFeedUrl,
  setScope,
  setSelection,
  setText,
  totalUnread,
  useRss,
} from "./rssStore";
import type { Item, Scope } from "./rssStore";
import { linkTarget, renderDescription } from "./sanitize";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Every word must be in the title; "-word" keeps it out. */
function titleMatcher(text: string): ((title: string) => boolean) | null {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const not = words.filter((w) => w.length > 1 && w.startsWith("-")).map((w) => w.slice(1));
  const want = words.filter((w) => !(w.length > 1 && w.startsWith("-")));
  if (!want.length && !not.length) return null;
  return (title) => {
    const t = title.toLowerCase();
    return want.every((w) => t.includes(w)) && !not.some((w) => t.includes(w));
  };
}

/** "TV/Anime" -> "TV › Anime" */
function folderLabel(path: string): string {
  return path.split("/").join(" › ");
}

/** Show a folder: open it and the folders it's in. */
function reveal(path: string): void {
  const { collapsed } = useStore.getState();
  const next = { ...collapsed };
  let changed = false;
  for (let p = path; p; p = parentOf(p)) {
    if (next[`rss:${p}`]) {
      delete next[`rss:${p}`];
      changed = true;
    }
  }
  if (changed) useStore.setState({ collapsed: next });
}

function go(scope: Scope): void {
  setScope(scope);
  useStore.setState({ navOpen: false });
}

// ------------------------------------------------------------------ prompts
function promptAddFeed(folder?: string): void {
  const s = useRss.getState();
  const into = folder ?? scopeFolder(s, s.scope);
  openDialog({
    type: "prompt",
    title: "Add a feed",
    icon: <Rss />,
    label: "Feed address",
    placeholder: "https://example.com/rss",
    mono: true,
    confirmLabel: "Add",
    hint: into ? `It goes in “${folderLabel(into)}”.` : undefined,
    validate: (v: string) => (v.trim() ? null : "Type the feed's address"),
    onSubmit: async (v: string) => {
      await addFeed(v.trim(), into);
      if (into) reveal(into);
      useStore.setState({ navOpen: false });
    },
  });
}

function cleanPath(v: string): string {
  return v
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/");
}

function promptNewFolder(parent: string, then?: (path: string) => Promise<void>): void {
  openDialog({
    type: "prompt",
    title: "New folder",
    subtitle: parent ? `Inside “${folderLabel(parent)}”` : undefined,
    icon: <FolderPlus />,
    label: "Name",
    placeholder: "TV shows",
    confirmLabel: "Create",
    hint: "A / makes folders inside folders, like “TV/Anime”.",
    validate: (v: string) => (cleanPath(v) ? null : "Give it a name"),
    onSubmit: async (v: string) => {
      const path = joinPath(parent, cleanPath(v));
      await addFolder(path);
      reveal(parentOf(path));
      if (then) await then(path);
      else go(`d:${path}`);
    },
  });
}

function promptRenameFeed(feed: RssFeed): void {
  openDialog({
    type: "prompt",
    title: "Rename feed",
    icon: <Pencil />,
    label: "Name",
    value: feed.name,
    placeholder: feed.title || feed.url,
    confirmLabel: "Rename",
    hint: "Leave it empty to use the feed's own title.",
    onSubmit: (v: string) => renameFeed(feed.id, v.trim()),
  });
}

function promptFeedUrl(feed: RssFeed): void {
  openDialog({
    type: "prompt",
    title: "Feed address",
    subtitle: feed.name,
    icon: <Link2 />,
    label: "Address",
    value: feed.url,
    mono: true,
    confirmLabel: "Save",
    hint: "Its articles are fetched again from the new address.",
    validate: (v: string) => (v.trim() ? null : "Type the feed's address"),
    onSubmit: (v: string) => (v.trim() === feed.url ? Promise.resolve() : setFeedUrl(feed.id, v.trim())),
  });
}

function promptRenameFolder(path: string): void {
  openDialog({
    type: "prompt",
    title: "Rename folder",
    icon: <Pencil />,
    label: "Name",
    value: baseName(path),
    confirmLabel: "Rename",
    validate: (v: string) => (!v.trim() ? "Give it a name" : v.includes("/") ? "Names can't have a “/” in them" : null),
    onSubmit: (v: string) => renameFolder(path, joinPath(parentOf(path), v.trim())),
  });
}

function confirmRemoveFeed(feed: RssFeed): void {
  openDialog({
    type: "confirm",
    title: `Remove “${feed.name}”?`,
    message: "Its articles go too. Torrents already downloaded from it stay in the transfer list.",
    confirmLabel: "Remove",
    danger: true,
    onConfirm: () => void attempt(() => removeFeeds([feed.id]), "Couldn't remove it"),
  });
}

function confirmRemoveFolder(path: string): void {
  const n = useRss.getState().feeds.filter((f) => inFolder(f.folder, path)).length;
  openDialog({
    type: "confirm",
    title: `Remove “${baseName(path)}”?`,
    message: n
      ? `The ${n === 1 ? "feed" : plural(n, "feed")} in it ${n === 1 ? "goes" : "go"} too, with ${n === 1 ? "its" : "their"} articles. Torrents already downloaded stay in the transfer list.`
      : "There's nothing in it.",
    confirmLabel: "Remove",
    danger: true,
    onConfirm: () => void attempt(() => removeFolder(path), "Couldn't remove it"),
  });
}

function openRules(): void {
  useStore.setState({ navOpen: false });
  openDialog({ type: "rssRules" });
}

// ------------------------------------------------------------------ menus
function moveTo(feed: RssFeed, folder: string): void {
  void attempt(async () => {
    await moveFeed(feed.id, folder);
    if (folder) reveal(folder);
  }, "Couldn't move it");
}

function moveMenu(feed: RssFeed): MenuEntry[] {
  const folders = [...useRss.getState().folders].sort(collator.compare);
  return [
    { label: "Top level", checked: feed.folder === "", onSelect: () => moveTo(feed, "") },
    folders.length > 0 && { type: "separator" },
    ...folders.map((path) => ({ label: folderLabel(path), checked: feed.folder === path, onSelect: () => moveTo(feed, path) })),
    { type: "separator" },
    { label: "New folder…", icon: <FolderPlus />, onSelect: () => promptNewFolder("", (path) => moveFeed(feed.id, path)) },
  ];
}

function feedMenu(feed: RssFeed): MenuEntry[] {
  const unread = feedUnread(feed, useRss.getState().articles);
  return [
    { label: "Update", icon: <RefreshCw />, disabled: feed.loading, onSelect: () => refreshFeeds([feed.id]) },
    { label: "Mark all read", icon: <CheckCheck />, disabled: !unread, onSelect: () => void markAllRead(`f:${feed.id}`) },
    { type: "separator" },
    { label: "Rename…", icon: <Pencil />, onSelect: () => promptRenameFeed(feed) },
    { label: "Move to", icon: <FolderInput />, items: () => moveMenu(feed) },
    { label: "Edit address…", icon: <Link2 />, onSelect: () => promptFeedUrl(feed) },
    { label: "Copy address", icon: <Copy />, onSelect: () => void copyText(feed.url, "Feed address") },
    { type: "separator" },
    { label: "Remove…", icon: <Trash />, danger: true, onSelect: () => confirmRemoveFeed(feed) },
  ];
}

function folderMenu(path: string): MenuEntry[] {
  const s = useRss.getState();
  const scope = `d:${path}`;
  const ids = scopeFeeds(s, scope).map((f) => f.id);
  return [
    { label: "Update", icon: <RefreshCw />, disabled: !ids.length, onSelect: () => refreshFeeds(ids) },
    { label: "Mark all read", icon: <CheckCheck />, disabled: !scopeUnread(s, scope), onSelect: () => void markAllRead(scope) },
    { type: "separator" },
    { label: "Add feed here…", icon: <Plus />, onSelect: () => promptAddFeed(path) },
    { label: "New folder inside…", icon: <FolderPlus />, onSelect: () => promptNewFolder(path) },
    { label: "Rename…", icon: <Pencil />, onSelect: () => promptRenameFolder(path) },
    { type: "separator" },
    { label: "Remove…", icon: <Trash />, danger: true, onSelect: () => confirmRemoveFolder(path) },
  ];
}

function unreadMenu(): MenuEntry[] {
  const s = useRss.getState();
  return [
    { label: "Update all feeds", icon: <RefreshCw />, disabled: !s.feeds.length, onSelect: () => refreshFeeds(null) },
    { label: "Mark all read", icon: <CheckCheck />, disabled: !totalUnread(s), onSelect: () => void markAllRead(UNREAD) },
  ];
}

function copyEntries(list: Item[]): MenuEntry[] {
  const n = list.length;
  const copy = (pick: (it: Item) => string, one: string, many: string) => {
    const values = list.map(pick).filter(Boolean);
    if (values.length) void copyText(values.join("\n"), values.length > 1 ? `${values.length} ${many}` : one);
  };
  return [
    { label: n > 1 ? "Titles" : "Title", onSelect: () => copy((it) => it.a.title, "Title", "titles") },
    {
      label: n > 1 ? "Torrent links" : "Torrent link",
      disabled: !list.some((it) => it.a.torrentUrl),
      onSelect: () => copy((it) => it.a.torrentUrl, "Torrent link", "torrent links"),
    },
    {
      label: n > 1 ? "Page links" : "Page link",
      disabled: !list.some((it) => pageUrl(it.a)),
      onSelect: () => copy((it) => pageUrl(it.a) ?? "", "Link", "links"),
    },
  ];
}

function articleMenu(list: Item[]): MenuEntry[] {
  if (!list.length) return [];
  const dialog = wantsDialog();
  const torrents = list.filter((it) => it.a.torrentUrl);
  const pages = list.map((it) => pageUrl(it.a)).filter((u): u is string => !!u);
  const unread = list.filter((it) => !it.a.read);
  return [
    {
      label: torrents.length > 1 ? `Download ${torrents.length} torrents` : "Download",
      icon: <Download />,
      hint: "Enter",
      disabled: !torrents.length,
      onSelect: () => downloadArticles(torrents),
    },
    {
      label: dialog ? "Add without the dialog" : "Download with options…",
      icon: dialog ? <Zap /> : <SlidersHorizontal />,
      disabled: !torrents.length,
      onSelect: () => downloadArticles(torrents, { dialog: !dialog }),
    },
    { type: "separator" },
    {
      label: pages.length > 1 ? `Open ${pages.length} pages` : "Open page",
      icon: <ExternalLink />,
      disabled: !pages.length || pages.length > 10,
      onSelect: () => pages.forEach((u) => openExternal(u)),
    },
    { label: "Mark read", icon: <MailCheck />, disabled: !unread.length, onSelect: () => markRead(unread.map((it) => it.key)) },
    { label: "Copy", icon: <Copy />, items: copyEntries(list) },
  ];
}

// ------------------------------------------------------------------ toolbar
function RssToolbar() {
  const scope = useRss((s) => s.scope);
  const hasFeeds = useRss((s) => s.feeds.length > 0);
  const title = useRss((s) => (s.feeds.length ? scopeTitle(s, s.scope) : "RSS"));
  const unread = useRss((s) => scopeUnread(s, s.scope));
  const loading = useRss((s) => scopeFeeds(s, s.scope).some((f) => f.loading));
  const update = () => refreshFeeds(scope === UNREAD ? null : scopeFeeds(useRss.getState(), scope).map((f) => f.id));
  return (
    <header className="toolbar rss-toolbar">
      <IconButton className="nav-toggle" label="Menu" onClick={() => useStore.setState((s) => ({ navOpen: !s.navOpen }))}>
        <MenuIcon />
      </IconButton>
      <div className="toolbar-title">
        <h1 className="ellipsis">{title}</h1>
        {unread > 0 && <span className="badge">{unread.toLocaleString()} unread</span>}
      </div>
      <div className="spacer" />
      {hasFeeds && (
        <>
          <IconButton label={scope === UNREAD ? "Update all feeds" : "Update"} disabled={loading} onClick={update}>
            {loading ? <Spinner size={16} /> : <RefreshCw />}
          </IconButton>
          <IconButton label="Mark all read" disabled={!unread} onClick={() => void markAllRead(scope)}>
            <CheckCheck />
          </IconButton>
          <IconButton label="Download rules" onClick={openRules}>
            <WandSparkles />
          </IconButton>
        </>
      )}
      <Button variant="primary" className="toolbar-add" icon={<Plus />} onClick={() => promptAddFeed()}>
        <span className="rss-add-label">Add feed</span>
      </Button>
    </header>
  );
}

// ------------------------------------------------------------------ article list
interface RowProps {
  it: Item;
  /** Shown when the list has articles from several feeds. */
  feed: string | null;
  sel: boolean;
  foc: boolean;
  added: boolean;
  busy: boolean;
  now: number;
}

const ArticleRow = memo(function ArticleRow({ it, feed, sel, foc, added, busy, now }: RowProps) {
  const { a } = it;
  return (
    <div
      className={["rss-row", sel && "sel", foc && "foc", !a.read && "unread"].filter(Boolean).join(" ")}
      data-key={it.key}
      role="option"
      aria-selected={sel}
    >
      <span className="rss-dot" aria-hidden />
      <div className="rss-row-main">
        <div className="rss-row-title" title={a.title}>
          {a.title || "Untitled"}
        </div>
        <div className="rss-row-meta">
          {feed && <span className="rss-meta-part ellipsis">{feed}</span>}
          {a.date > 0 && (
            <span className="rss-meta-part" title={formatDate(a.date)}>
              {formatAgo(a.date, now)}
            </span>
          )}
          {added && (
            <span className="sv-added">
              <Check />
              Added
            </span>
          )}
        </div>
      </div>
      {busy ? (
        <span className="rss-row-busy">
          <Spinner size={15} />
        </span>
      ) : (
        hasTorrent(a) &&
        !added && (
          <IconButton
            className="rss-row-dl"
            size="sm"
            label="Download"
            tip={null}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={() => downloadArticles([it])}
          >
            <Download />
          </IconButton>
        )
      )}
    </div>
  );
});

function ListEmpty({ filtered }: { filtered: boolean }) {
  const scope = useRss((s) => s.scope);
  const text = useRss((s) => s.text);
  const error = useRss((s) => s.articlesError);
  const pending = useRss((s) => articlesPending(s));
  const feed = useRss((s) => (s.scope.startsWith("f:") ? s.feeds.find((f) => f.id === s.scope.slice(2)) : undefined));
  const folderEmpty = useRss((s) => s.scope.startsWith("d:") && !scopeFeeds(s, s.scope).length);
  if (filtered) {
    return (
      <Empty icon={<SearchX />} title={`Nothing matches “${text.trim()}”`} actions={<Button onClick={() => setText("")}>Clear the filter</Button>} />
    );
  }
  if (error) {
    return (
      <Empty icon={<CircleX />} title="Couldn't load the articles" actions={<Button icon={<RefreshCw />} onClick={reloadArticles}>Try again</Button>}>
        {error}
      </Empty>
    );
  }
  if (pending) return <Empty icon={<Spinner size={22} />} />;
  if (feed?.loading && !feed.total) return <Empty icon={<Spinner size={22} />} title="Updating…" />;
  if (feed?.error) {
    return (
      <Empty
        icon={<CircleAlert />}
        title="Couldn't read this feed"
        actions={
          <>
            <Button icon={<RefreshCw />} onClick={() => refreshFeeds([feed.id])}>
              Try again
            </Button>
            <Button icon={<Link2 />} onClick={() => promptFeedUrl(feed)}>
              Edit address…
            </Button>
          </>
        }
      >
        {feed.error}
      </Empty>
    );
  }
  if (feed) {
    return (
      <Empty icon={<Newspaper />} title="No articles yet">
        New ones show up here when the feed has them.
      </Empty>
    );
  }
  if (folderEmpty) {
    return (
      <Empty
        icon={<Folder />}
        title="This folder is empty"
        actions={
          <Button icon={<Plus />} onClick={() => promptAddFeed(scope.slice(2))}>
            Add a feed here
          </Button>
        }
      >
        Add feeds to it, or drag them here from the sidebar.
      </Empty>
    );
  }
  if (scope === UNREAD) {
    return (
      <Empty icon={<CheckCheck />} title="You're all caught up">
        New articles show up here as your feeds update.
      </Empty>
    );
  }
  return <Empty icon={<Newspaper />} title="No articles yet" />;
}

function ArticleList({ onOpen }: { onOpen: () => void }) {
  const feeds = useRss((s) => s.feeds);
  const articles = useRss((s) => s.articles);
  const scope = useRss((s) => s.scope);
  const keep = useRss((s) => s.keep);
  const text = useRss((s) => s.text);
  const selection = useRss((s) => s.selection);
  const fetching = useRss((s) => s.fetching);
  const resolved = useRss((s) => s.resolved);
  // Only changes when torrents come or go, not with every speed update.
  const idsKey = useStore((s) => Object.keys(s.torrents).join(" "));
  const density = useStore((s) => s.prefs?.behavior?.density);
  const rowH = density === "compact" ? 46 : 54;
  const now = useNow(30_000);
  const el = useRef<HTMLDivElement | null>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useEvent("ui.focusFilter", () => {
    filterInput.current?.focus();
    filterInput.current?.select();
  });

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const ro = new ResizeObserver(() => setHeight(node.clientHeight));
    ro.observe(node);
    setHeight(node.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Back to the top for another feed.
  useLayoutEffect(() => {
    if (el.current) el.current.scrollTop = 0;
    setScrollTop(0);
  }, [scope]);

  const query = useDeferredValue(text);
  const all = useMemo(() => scopeItems({ feeds, articles, scope, keep }), [feeds, articles, scope, keep]);
  const rows = useMemo(() => {
    const match = titleMatcher(query);
    return match ? all.filter((it) => match(it.a.title)) : all;
  }, [all, query]);
  const keys = useMemo(() => rows.map((it) => it.key), [rows]);
  const index = useMemo(() => new Map(keys.map((k, i) => [k, i])), [keys]);
  const names = useMemo(
    () => (scopeFeeds({ feeds }, scope).length > 1 ? new Map(feeds.map((f) => [f.id, f.name])) : null),
    [feeds, scope],
  );
  const added = useMemo(() => {
    const out = new Set<string>();
    if (!idsKey) return out;
    const ids = new Set(idsKey.split(" "));
    for (const it of all) {
      const id = articleTorrentId(it, resolved);
      if (id && ids.has(id)) out.add(it.key);
    }
    return out;
  }, [all, resolved, idsKey]);

  const { selected, anchor, focused } = selection;
  const selectedItems = () => rows.filter((it) => selected.has(it.key));

  const scrollToIndex = (i: number) => {
    const node = el.current;
    if (!node) return;
    const top = i * rowH;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + rowH > node.scrollTop + node.clientHeight) node.scrollTop = top + rowH - node.clientHeight;
  };

  // Keep the focused article in view when it moves (keyboard), not when articles come in.
  const lastFocused = useRef<string | null>(null);
  useEffect(() => {
    if (focused && focused !== lastFocused.current) {
      const i = index.get(focused);
      if (i !== undefined) scrollToIndex(i);
    }
    lastFocused.current = focused;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  const only = (key: string | null) => setSelection({ selected: new Set(key ? [key] : []), anchor: key, focused: key });
  const range = (key: string, additive: boolean) => {
    const a = anchor ? index.get(anchor) : undefined;
    const b = index.get(key);
    if (a === undefined || b === undefined) {
      only(key);
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const next = new Set(additive ? selected : []);
    for (let i = lo; i <= hi; i++) next.add(keys[i]);
    setSelection({ selected: next, anchor, focused: key });
  };
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelection({ selected: next, anchor: key, focused: key });
  };

  const keyFromEvent = (e: ReactMouseEvent) => (e.target as Element).closest<HTMLElement>("[data-key]")?.dataset.key ?? null;

  const onMouseDown = (e: ReactMouseEvent) => {
    if (onScrollbar(e)) return;
    const key = keyFromEvent(e);
    if (!key) {
      if (e.button === 0 && !e.ctrlKey && !e.shiftKey && !(e.target as Element).closest(".rss-rows-empty")) only(null);
      return;
    }
    if (e.button === 2) {
      if (!selected.has(key)) only(key);
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey) {
      e.preventDefault();
      range(key, e.ctrlKey || e.metaKey);
    } else if (e.ctrlKey || e.metaKey) toggle(key);
    else only(key);
  };

  const onClick = (e: ReactMouseEvent) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (keyFromEvent(e) && !(e.target as Element).closest("button")) onOpen();
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    const key = keyFromEvent(e);
    if (!key) {
      e.preventDefault();
      return;
    }
    // The mousedown already selected the row when it wasn't.
    const list = selected.has(key) ? selectedItems() : rows.filter((it) => it.key === key);
    openContextMenu(e, articleMenu(list));
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    const key = keyFromEvent(e);
    if (!key || e.ctrlKey || e.shiftKey) return;
    const it = rows[index.get(key) ?? -1];
    if (it?.a.torrentUrl) downloadArticles([it]);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = keys.length;
    const idx = focused ? index.get(focused) ?? -1 : -1;
    const page = Math.max(1, Math.floor(height / rowH) - 1);
    const ctrl = e.ctrlKey || e.metaKey;
    let next = -1;
    switch (e.key) {
      case "ArrowDown":
      case "j":
        if (e.key === "j" && (ctrl || e.altKey)) return;
        next = idx < 0 ? 0 : Math.min(n - 1, idx + 1);
        break;
      case "ArrowUp":
      case "k":
        if (e.key === "k" && (ctrl || e.altKey)) return;
        next = idx < 0 ? 0 : Math.max(0, idx - 1);
        break;
      case "PageDown":
        next = Math.min(n - 1, Math.max(0, idx) + page);
        break;
      case "PageUp":
        next = Math.max(0, idx - page);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = n - 1;
        break;
      case "a":
      case "A":
        if (ctrl) {
          e.preventDefault();
          setSelection({ selected: new Set(keys), anchor: anchor ?? keys[0] ?? null, focused: focused ?? keys[0] ?? null });
        }
        return;
      case " ":
        if (ctrl && focused) {
          e.preventDefault();
          toggle(focused);
        }
        return;
      case "Enter": {
        const list = selectedItems().filter((it) => it.a.torrentUrl);
        if (list.length) {
          e.preventDefault();
          downloadArticles(list);
        }
        return;
      }
      case "Escape":
        if (selected.size) {
          e.preventDefault();
          e.stopPropagation();
          only(null);
        }
        return;
      case "ContextMenu":
      case "F10": {
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        const list = selectedItems();
        if (!list.length || !el.current) return;
        const i = index.get(focused ?? list[0].key) ?? 0;
        const r = el.current.getBoundingClientRect();
        const y = Math.min(r.bottom - 8, Math.max(r.top + 8, r.top + i * rowH - el.current.scrollTop + rowH / 2));
        openMenu({ items: articleMenu(list), x: r.left + 40, y });
        return;
      }
      default:
        return;
    }
    if (next < 0 || n === 0) return;
    e.preventDefault();
    const key = keys[next];
    if (e.shiftKey) range(key, ctrl);
    else if (ctrl) setSelection({ ...selection, focused: key });
    else only(key);
    scrollToIndex(next);
  };

  const overscan = 8;
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / rowH) + overscan);
  const visible = rows.slice(start, end);

  return (
    <section className="rss-list" aria-label="Articles">
      <div className="rss-listbar">
        <SearchInput
          ref={filterInput}
          value={text}
          onChange={setText}
          placeholder="Filter articles"
          hint="Ctrl+F"
          aria-label="Filter articles by title"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !text) filterInput.current?.blur();
            if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              el.current?.focus();
            }
          }}
        />
      </div>
      <div
        ref={el}
        className="rss-rows"
        tabIndex={0}
        role="listbox"
        aria-label="Articles"
        aria-multiselectable
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onMouseDown={onMouseDown}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        style={{ ["--rss-row-h" as string]: `${rowH}px` } as CSSProperties}
      >
        <div className="rss-rows-body" style={{ height: rows.length * rowH }}>
          <div style={{ transform: `translateY(${start * rowH}px)` }}>
            {visible.map((it) => (
              <ArticleRow
                key={it.key}
                it={it}
                feed={names?.get(it.feedId) ?? null}
                sel={selected.has(it.key)}
                foc={focused === it.key}
                added={added.has(it.key)}
                busy={!!fetching[it.key]}
                now={now}
              />
            ))}
          </div>
        </div>
        {rows.length === 0 && (
          <div className="rss-rows-empty">
            <ListEmpty filtered={all.length > 0} />
          </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ reader
function Description({ html, base }: { html: string; base: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(renderDescription(html, base));
  }, [html, base]);

  // Links: torrents are added, pages open outside (in the browser, from the desktop app).
  const follow = (e: ReactMouseEvent) => {
    const a = (e.target as Element).closest("a");
    if (!a || !ref.current?.contains(a)) return;
    e.preventDefault();
    const target = linkTarget(a.getAttribute("href") ?? "");
    if (!target) return;
    if (target.kind === "torrent") void addSources([target.url]);
    else openExternal(target.url);
  };

  return (
    <div
      ref={ref}
      className="rss-desc selectable"
      onClick={follow}
      onAuxClick={(e) => {
        if (e.button === 1) follow(e);
      }}
    />
  );
}

function Reader({ onBack }: { onBack: () => void }) {
  const it = useRss((s) => findItem(s, s.selection.focused));
  const feed = useRss((s) => (it ? s.feeds.find((f) => f.id === it.feedId) : undefined));
  const busy = useRss((s) => !!(it && s.fetching[it.key]));
  const resolvedId = useRss((s) => (it ? articleTorrentId(it, s.resolved) : null));
  const inList = useStore((s) => !!(resolvedId && s.torrents[resolvedId]));
  const count = useRss((s) => s.selection.selected.size);

  if (!it) {
    return (
      <section className="rss-reader rss-reader-none" aria-label="Article">
        <Empty icon={<Newspaper />} title="Pick an article to read it" />
      </section>
    );
  }
  const { a } = it;
  const page = pageUrl(a);
  const base = page ?? (feed && /^https?:\/\//i.test(feed.url) ? feed.url : null);
  return (
    <section className="rss-reader" aria-label="Article" key={it.key}>
      <div className="rss-reader-scroll">
        <header className="rss-reader-head">
          <IconButton className="rss-back" label="Back to the articles" onClick={onBack}>
            <ArrowLeft />
          </IconButton>
          <div className="rss-reader-titles">
            <h2 className="selectable">{a.title || "Untitled"}</h2>
            <div className="rss-reader-meta">
              {feed && (
                <button type="button" className="rss-reader-feed" onClick={() => go(`f:${feed.id}`)}>
                  <Rss />
                  {feed.name}
                </button>
              )}
              {a.date > 0 && <span>{formatDate(a.date)}</span>}
              {a.author && <span className="ellipsis">{a.author}</span>}
              {count > 1 && <span className="faint">{count.toLocaleString()} selected</span>}
            </div>
          </div>
        </header>
        <div className="rss-reader-actions">
          {inList && resolvedId ? (
            <Button
              icon={<ArrowDownUp />}
              onClick={() => {
                selectOnly(resolvedId);
                setView("transfers");
              }}
            >
              Show in Transfers
            </Button>
          ) : (
            a.torrentUrl && (
              <Button variant="primary" icon={<Download />} loading={busy} onClick={() => downloadArticles([it])}>
                Download
              </Button>
            )
          )}
          {page && (
            <Button icon={<ExternalLink />} onClick={() => openExternal(page)}>
              Open page
            </Button>
          )}
          <IconButton label="Copy" onClick={(e) => openDropdown(e.currentTarget, copyEntries([it]))}>
            <Copy />
          </IconButton>
        </div>
        {a.description.trim() ? (
          <Description html={a.description} base={base} />
        ) : (
          <p className="rss-desc-none">This article has no description.</p>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the view
function NoFeeds() {
  return (
    <Empty
      icon={<Rss />}
      title="Follow torrent feeds"
      actions={
        <>
          <Button variant="primary" icon={<Plus />} onClick={() => promptAddFeed("")}>
            Add a feed
          </Button>
          <Button icon={<WandSparkles />} onClick={openRules}>
            Download rules
          </Button>
        </>
      }
    >
      Many sites and trackers publish their new torrents as an RSS feed. Add one to see what's new on it, and set up rules to
      download what you want as soon as it shows up.
    </Empty>
  );
}

function Body() {
  const scope = useRss((s) => s.scope);
  const hasFocus = useRss((s) => !!s.selection.focused);
  // Phones show the list or the article, not both.
  const [reading, setReading] = useState(false);
  useEffect(() => setReading(false), [scope]);
  return (
    <div className={`rss-body${reading && hasFocus ? " reading" : ""}`}>
      <ArticleList onOpen={() => setReading(true)} />
      <Reader onBack={() => setReading(false)} />
    </div>
  );
}

export function RssView() {
  const loaded = useRss((s) => s.loaded);
  const error = useRss((s) => s.error);
  const hasFeeds = useRss((s) => s.feeds.length > 0);

  useEffect(() => {
    if (useRss.getState().loaded) ensureArticles();
    else void loadFeeds();
  }, []);

  let body: ReactNode;
  if (!loaded) {
    body = error ? (
      <Empty icon={<CircleX />} title="Couldn't load the feeds" actions={<Button onClick={() => void loadFeeds()}>Try again</Button>}>
        {error}
      </Empty>
    ) : (
      <div className="sv-center">
        <Spinner size={18} />
      </div>
    );
  } else if (!hasFeeds) body = <NoFeeds />;
  else body = <Body />;

  return (
    <div className="rssview">
      <RssToolbar />
      {body}
    </div>
  );
}

// ------------------------------------------------------------------ sidebar
interface FolderNode {
  path: string;
  name: string;
  folders: FolderNode[];
  feeds: RssFeed[];
}

function buildTree(feeds: RssFeed[], folders: string[]): FolderNode {
  const root: FolderNode = { path: "", name: "", folders: [], feeds: [] };
  const byPath = new Map<string, FolderNode>([["", root]]);
  const ensure = (path: string): FolderNode => {
    let node = byPath.get(path);
    if (node) return node;
    const parent = ensure(parentOf(path));
    node = { path, name: baseName(path), folders: [], feeds: [] };
    parent.folders.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const path of folders) ensure(path);
  for (const feed of feeds) ensure(feed.folder).feeds.push(feed);
  const sort = (n: FolderNode) => {
    n.folders.sort((a, b) => collator.compare(a.name, b.name));
    n.feeds.sort((a, b) => collator.compare(a.name, b.name));
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** What's being dragged in the feed tree. */
type Dragged = { kind: "feed"; feed: RssFeed } | { kind: "folder"; path: string };
let dragging: Dragged | null = null;
const DRAG_TYPE = "application/x-promethea-feed";

/** Whether what's being dragged can go in this folder ("" is the top level). */
function canDrop(target: string): boolean {
  if (!dragging) return false;
  if (dragging.kind === "feed") return dragging.feed.folder !== target;
  const { path } = dragging;
  return parentOf(path) !== target && !inFolder(target, path);
}

function drop(target: string): void {
  const d = dragging;
  dragging = null;
  if (!d) return;
  if (d.kind === "feed") moveTo(d.feed, target);
  else {
    void attempt(async () => {
      const path = joinPath(target, baseName(d.path));
      await renameFolder(d.path, path);
      if (target) reveal(target);
    }, "Couldn't move it");
  }
}

interface TreeCtx {
  scope: Scope;
  articles: Record<string, RssArticle[]>;
  collapsed: Record<string, boolean>;
  twisty: boolean;
  dropTarget: string | null;
  setDropTarget: (path: string | null) => void;
}

function dropProps(target: string, ctx: TreeCtx) {
  return {
    onDragOver: (e: ReactDragEvent) => {
      if (!canDrop(target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (ctx.dropTarget !== target) ctx.setDropTarget(target);
    },
    onDragLeave: (e: ReactDragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null) && ctx.dropTarget === target) ctx.setDropTarget(null);
    },
    onDrop: (e: ReactDragEvent) => {
      if (!canDrop(target)) return;
      e.preventDefault();
      ctx.setDropTarget(null);
      drop(target);
    },
  };
}

function dragProps(what: Dragged, ctx: TreeCtx) {
  return {
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      dragging = what;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DRAG_TYPE, what.kind === "feed" ? what.feed.id : what.path);
    },
    onDragEnd: () => {
      dragging = null;
      ctx.setDropTarget(null);
    },
  };
}

function folderUnread(node: FolderNode, articles: TreeCtx["articles"]): number {
  let n = 0;
  for (const f of node.feeds) n += feedUnread(f, articles);
  for (const sub of node.folders) n += folderUnread(sub, articles);
  return n;
}

function FeedItem({ feed, depth, ctx }: { feed: RssFeed; depth: number; ctx: TreeCtx }) {
  const scope = `f:${feed.id}`;
  const on = ctx.scope === scope;
  const unread = feedUnread(feed, ctx.articles);
  const tip = [feed.name, feed.url, feed.error && `Couldn't update it: ${feed.error}`].filter(Boolean).join("\n");
  return (
    <button
      type="button"
      className={`nav-item sm rss-node${on ? " on" : ""}${unread ? " has-unread" : ""}`}
      style={{ ["--depth" as string]: depth } as CSSProperties}
      aria-current={on ? "true" : undefined}
      title={tip}
      onClick={() => go(scope)}
      onContextMenu={(e) => openContextMenu(e, feedMenu(feed))}
      {...dragProps({ kind: "feed", feed }, ctx)}
    >
      {ctx.twisty && <span className="rss-twisty" />}
      {feed.loading ? <Spinner size={15} /> : feed.error ? <CircleAlert className="ic-error" /> : <Rss />}
      <span className="nav-label">{feed.name}</span>
      {unread > 0 && <span className="nav-count">{unread.toLocaleString()}</span>}
    </button>
  );
}

function FolderItem({ node, depth, ctx }: { node: FolderNode; depth: number; ctx: TreeCtx }) {
  const scope = `d:${node.path}`;
  const on = ctx.scope === scope;
  const open = !ctx.collapsed[`rss:${node.path}`];
  const unread = folderUnread(node, ctx.articles);
  const loading = useRss((s) => s.feeds.some((f) => f.loading && inFolder(f.folder, node.path)));
  return (
    <>
      <button
        type="button"
        className={`nav-item sm rss-node${on ? " on" : ""}${unread ? " has-unread" : ""}${ctx.dropTarget === node.path ? " drop-hover" : ""}`}
        style={{ ["--depth" as string]: depth } as CSSProperties}
        aria-current={on ? "true" : undefined}
        aria-expanded={open}
        data-folder={node.path}
        title={node.path.includes("/") ? folderLabel(node.path) : undefined}
        onClick={() => go(scope)}
        onDoubleClick={() => toggleCollapsed(`rss:${node.path}`)}
        onContextMenu={(e) => openContextMenu(e, folderMenu(node.path))}
        {...dragProps({ kind: "folder", path: node.path }, ctx)}
        {...dropProps(node.path, ctx)}
      >
        <span
          className={`rss-twisty${open ? " open" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleCollapsed(`rss:${node.path}`);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ChevronRight />
        </span>
        {loading ? <Spinner size={15} /> : open ? <FolderOpen /> : <Folder />}
        <span className="nav-label">{node.name}</span>
        {unread > 0 && <span className="nav-count">{unread.toLocaleString()}</span>}
      </button>
      {open && <TreeLevel node={node} depth={depth + 1} ctx={ctx} />}
    </>
  );
}

function TreeLevel({ node, depth, ctx }: { node: FolderNode; depth: number; ctx: TreeCtx }) {
  return (
    <>
      {node.folders.map((sub) => (
        <FolderItem key={`d:${sub.path}`} node={sub} depth={depth} ctx={ctx} />
      ))}
      {node.feeds.map((feed) => (
        <FeedItem key={feed.id} feed={feed} depth={depth} ctx={ctx} />
      ))}
    </>
  );
}

function RssNav() {
  const loaded = useRss((s) => s.loaded);
  const feeds = useRss((s) => s.feeds);
  const folders = useRss((s) => s.folders);
  const articles = useRss((s) => s.articles);
  const scope = useRss((s) => s.scope);
  const collapsed = useStore((s) => s.collapsed);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const tree = useMemo(() => buildTree(feeds, folders), [feeds, folders]);
  const total = totalUnread({ feeds, articles });
  const ctx: TreeCtx = { scope, articles, collapsed, twisty: tree.folders.length > 0, dropTarget, setDropTarget };

  // Up and down move between the items; left and right close and open folders.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(".nav-item")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const path = items[i].dataset.folder;
      if (path === undefined) return;
      e.preventDefault();
      const open = !collapsed[`rss:${path}`];
      if (open !== (e.key === "ArrowRight")) toggleCollapsed(`rss:${path}`);
    }
  };

  return (
    <div className="side-section rss-nav">
      <div className={`side-head${dropTarget === "" ? " drop-hover" : ""}`} {...dropProps("", ctx)}>
        <span className="side-label">Feeds</span>
        <IconButton label="New folder" size="xs" onClick={() => promptNewFolder("")}>
          <FolderPlus />
        </IconButton>
        <IconButton label="Add feed" size="xs" onClick={() => promptAddFeed()}>
          <Plus />
        </IconButton>
      </div>
      <div className="nav" onKeyDown={onKeyDown}>
        <button
          type="button"
          className={`nav-item sm rss-node${scope === UNREAD ? " on" : ""}`}
          style={{ ["--depth" as string]: 0 } as CSSProperties}
          aria-current={scope === UNREAD ? "true" : undefined}
          onClick={() => go(UNREAD)}
          onContextMenu={(e) => openContextMenu(e, unreadMenu())}
        >
          {ctx.twisty && <span className="rss-twisty" />}
          <Inbox />
          <span className="nav-label">Unread</span>
          {total > 0 && <span className="nav-count">{total.toLocaleString()}</span>}
        </button>
        <TreeLevel node={tree} depth={0} ctx={ctx} />
        {loaded && !feeds.length && <p className="side-note">Feeds you add show up here.</p>}
        <button type="button" className="side-more" onClick={openRules}>
          <WandSparkles />
          Download rules
        </button>
      </div>
    </div>
  );
}

registerSidebarSection("rss", () => <RssNav />);
