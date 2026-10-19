// Torrent search: the search box, the results of the selected search, and past searches
// in the sidebar. Sites are searched by plugins (the same nova3 plugins qBittorrent uses).

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CircleStop,
  CircleX,
  Copy,
  Download,
  ExternalLink,
  Globe,
  HardDrive,
  ListX,
  Menu as MenuIcon,
  Plus,
  Puzzle,
  RotateCw,
  Search,
  SearchX,
  SlidersHorizontal,
  Sprout,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import type { SearchResult } from "../../api/types";
import { registerSidebarSection } from "../../components/shell/Sidebar";
import { Button, IconButton } from "../../components/ui/Button";
import { SearchInput, Select } from "../../components/ui/Form";
import { openContextMenu, openDropdown } from "../../components/ui/Menu";
import type { MenuEntry } from "../../components/ui/Menu";
import { Empty, Spinner } from "../../components/ui/Misc";
import { copyText, openExternal } from "../../lib/actions";
import { emit } from "../../lib/events";
import { formatBytes, parseSize, plural } from "../../lib/format";
import { useEvent } from "../../lib/hooks";
import { openDialog, useStore } from "../../store/store";
import { NO_SELECTION, ResultsTable } from "./ResultsTable";
import type { Selection } from "./ResultsTable";
import {
  NO_FILTER,
  categoryOptions,
  closeSearch,
  closeSearches,
  downloadResults,
  listSearches,
  loadPlugins,
  repeatSearch,
  resultTorrentId,
  selectSearch,
  setResultFilter,
  setResultSort,
  startSearch,
  stopSearch,
  useSearch,
  wantsDialog,
} from "./searchStore";
import type { ResultFilter, ResultSort, SearchTab } from "./searchStore";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const SIZE_PRESETS = [
  { label: "Any size", min: 0, max: 0 },
  { label: "Under 100 MiB", min: 0, max: 100 * MiB },
  { label: "Under 1 GiB", min: 0, max: GiB },
  { label: "1 – 4 GiB", min: GiB, max: 4 * GiB },
  { label: "Over 4 GiB", min: 4 * GiB, max: 0 },
  { label: "Over 20 GiB", min: 20 * GiB, max: 0 },
];

const SEED_STEPS = [0, 1, 5, 10, 50, 100, 500];

function sizeLabel(min: number, max: number): string {
  const preset = SIZE_PRESETS.find((p) => p.min === min && p.max === max);
  if (preset) return preset.label;
  if (min > 0 && max > 0) return `${formatBytes(min)} – ${formatBytes(max)}`;
  if (min > 0) return `Over ${formatBytes(min)}`;
  return `Under ${formatBytes(max)}`;
}

/** "700 MiB - 4 GiB", "2 GiB+", "> 1g", "under 700mb" -> a size range; null when unreadable. */
function parseRange(text: string): { min: number; max: number } | null {
  const t = text.trim().toLowerCase();
  if (!t) return { min: 0, max: 0 };
  const size = (s: string) => (s.trim() ? parseSize(s) : 0);
  let m = /^(?:<=?|under|below|max)\s*(.+)$/.exec(t);
  if (m) {
    const max = size(m[1]);
    return max > 0 ? { min: 0, max } : null;
  }
  m = /^(?:>=?|over|above|min)\s*(.+)$/.exec(t) ?? /^(.+?)\s*\+$/.exec(t);
  if (m) {
    const min = size(m[1]);
    return min > 0 ? { min, max: 0 } : null;
  }
  const parts = t.split(/\s*(?:–|—|\.\.|-|\bto\b)\s*/);
  if (parts.length === 1) {
    const min = size(parts[0]);
    return min > 0 ? { min, max: 0 } : null;
  }
  if (parts.length !== 2) return null;
  const [min, max] = parts.map(size);
  if (Number.isNaN(min) || Number.isNaN(max) || (!min && !max) || (max > 0 && min > max)) return null;
  return { min, max };
}

/** Every word must be in the name; "-word" keeps it out. */
function nameMatcher(text: string): ((name: string) => boolean) | null {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const not = words.filter((w) => w.length > 1 && w.startsWith("-")).map((w) => w.slice(1));
  const want = words.filter((w) => !(w.length > 1 && w.startsWith("-")));
  if (!want.length && !not.length) return null;
  return (name) => {
    const n = name.toLowerCase();
    return want.every((w) => n.includes(w)) && !not.some((w) => n.includes(w));
  };
}

function hasFilters(f: ResultFilter): boolean {
  return !!f.text.trim() || !!f.site || f.minSeeds > 0 || f.minSize > 0 || f.maxSize > 0;
}

function visibleResults(
  results: readonly SearchResult[],
  f: ResultFilter,
  sort: ResultSort | null,
  siteName: (plugin: string) => string,
): SearchResult[] {
  const match = nameMatcher(f.text);
  const out = results.filter(
    (r) =>
      (!match || match(r.name)) &&
      (!f.site || r.plugin === f.site) &&
      (f.minSeeds <= 0 || r.seeds >= f.minSeeds) &&
      (f.minSize <= 0 || r.size >= f.minSize) &&
      (f.maxSize <= 0 || (r.size >= 0 && r.size <= f.maxSize)),
  );
  if (!sort) return out;
  const { key, dir } = sort;
  let cmp: (a: SearchResult, b: SearchResult) => number;
  let unknown: (r: SearchResult) => boolean = () => false;
  if (key === "name") cmp = (a, b) => collator.compare(a.name, b.name);
  else if (key === "site") cmp = (a, b) => collator.compare(siteName(a.plugin), siteName(b.plugin));
  else {
    cmp = (a, b) => a[key] - b[key];
    unknown = key === "pubDate" ? (r) => r.pubDate <= 0 : (r) => r[key] < 0;
  }
  // Unknown values ("–") go last whichever way it's sorted; ties go to the best-seeded.
  return out.sort((a, b) => {
    const ua = unknown(a);
    if (ua !== unknown(b)) return ua ? 1 : -1;
    return cmp(a, b) * dir || b.seeds - a.seeds || collator.compare(a.name, b.name);
  });
}

function siteLabel(plugin: string): string {
  return useSearch.getState().plugins.find((p) => p.name === plugin)?.fullName || plugin;
}

// ------------------------------------------------------------------ result actions
function resultMenu(rows: SearchResult[]): MenuEntry[] {
  const n = rows.length;
  if (!n) return [];
  const dialog = wantsDialog();
  const pages = rows.filter((r) => /^https?:\/\//i.test(r.descLink));
  const copy = (pick: (r: SearchResult) => string, one: string, many: string) => {
    const values = rows.map(pick).filter(Boolean);
    if (values.length) void copyText(values.join("\n"), values.length > 1 ? `${values.length} ${many}` : one);
  };
  const { tabs, active, filter } = useSearch.getState();
  // Pointless when everything shown is from that site already.
  const oneSite = new Set(rows.map((r) => r.plugin)).size === 1;
  const narrowed = filter.site === rows[0].plugin || (active ? tabs[active]?.plugins.length ?? 0 : 0) <= 1;
  return [
    { label: n > 1 ? `Download ${n} torrents` : "Download", icon: <Download />, hint: "Enter", onSelect: () => downloadResults(rows) },
    {
      label: dialog ? "Add without the dialog" : "Download with options…",
      icon: dialog ? <Zap /> : <SlidersHorizontal />,
      onSelect: () => downloadResults(rows, { dialog: !dialog }),
    },
    { type: "separator" },
    {
      label: pages.length > 1 ? `Open ${pages.length} description pages` : "Open description page",
      icon: <ExternalLink />,
      disabled: !pages.length || pages.length > 10,
      onSelect: () => pages.forEach((r) => openExternal(r.descLink)),
    },
    {
      label: "Copy",
      icon: <Copy />,
      items: [
        { label: n > 1 ? "Names" : "Name", onSelect: () => copy((r) => r.name, "Name", "names") },
        { label: n > 1 ? "Download links" : "Download link", onSelect: () => copy((r) => r.link, "Download link", "download links") },
        {
          label: n > 1 ? "Description page links" : "Description page link",
          disabled: !pages.length,
          onSelect: () => copy((r) => r.descLink, "Link", "links"),
        },
      ],
    },
    { type: "separator" },
    {
      label: "Only this site",
      icon: <Globe />,
      disabled: !oneSite || narrowed,
      onSelect: () => setResultFilter({ site: rows[0].plugin }),
    },
  ];
}

function customSizeRange(): void {
  const { minSize, maxSize } = useSearch.getState().filter;
  openDialog({
    type: "prompt",
    title: "Size range",
    icon: <HardDrive />,
    label: "Show results of this size",
    value: minSize || maxSize ? (minSize && maxSize ? `${formatBytes(minSize)} - ${formatBytes(maxSize)}` : minSize ? `${formatBytes(minSize)}+` : `under ${formatBytes(maxSize)}`) : "",
    placeholder: "e.g. 700 MiB - 4 GiB",
    hint: "A range like “700 MiB - 4 GiB”, or “2 GiB+” and “under 1 GiB”. Empty shows any size.",
    confirmLabel: "Apply",
    validate: (v: string) => (parseRange(v) ? null : "Write a size like 700 MiB, 1.5 GiB or 200k"),
    onSubmit: (v: string) => {
      const range = parseRange(v);
      if (range) setResultFilter({ minSize: range.min, maxSize: range.max });
    },
  });
}

function filterMenu(tab: SearchTab): MenuEntry[] {
  const f = useSearch.getState().filter;
  const perSite = new Map<string, number>();
  for (const r of tab.results) perSite.set(r.plugin, (perSite.get(r.plugin) ?? 0) + 1);
  const sites = [...perSite].sort((a, b) => collator.compare(siteLabel(a[0]), siteLabel(b[0])));
  const custom = !SIZE_PRESETS.some((p) => p.min === f.minSize && p.max === f.maxSize);
  return [
    {
      label: "Seeds",
      icon: <Sprout />,
      hint: f.minSeeds > 0 ? `${f.minSeeds}+` : undefined,
      items: () =>
        SEED_STEPS.map((n) => ({
          label: n ? `At least ${n.toLocaleString()}` : "Any number",
          checked: f.minSeeds === n,
          onSelect: () => setResultFilter({ minSeeds: n }),
        })),
    },
    {
      label: "Size",
      icon: <HardDrive />,
      hint: f.minSize || f.maxSize ? "on" : undefined,
      items: () => [
        ...SIZE_PRESETS.map((p) => ({
          label: p.label,
          checked: f.minSize === p.min && f.maxSize === p.max,
          onSelect: () => setResultFilter({ minSize: p.min, maxSize: p.max }),
        })),
        { type: "separator" as const },
        { label: custom ? `Custom: ${sizeLabel(f.minSize, f.maxSize)}…` : "Custom range…", checked: custom, onSelect: customSizeRange },
      ],
    },
    {
      label: "Site",
      icon: <Globe />,
      disabled: sites.length < 2 && !f.site,
      items: () => [
        { label: "Every site", checked: !f.site, onSelect: () => setResultFilter({ site: null }) },
        { type: "separator" as const },
        ...sites.map(([name, n]) => ({
          label: siteLabel(name),
          hint: n.toLocaleString(),
          checked: f.site === name,
          onSelect: () => setResultFilter({ site: name }),
        })),
      ],
    },
    { type: "separator" },
    { label: "Clear filters", icon: <ListX />, disabled: !hasFilters(f), onSelect: () => setResultFilter(NO_FILTER) },
  ];
}

// ------------------------------------------------------------------ search box
function SearchBar() {
  const query = useSearch((s) => s.query);
  const category = useSearch((s) => s.category);
  const source = useSearch((s) => s.source);
  const plugins = useSearch((s) => s.plugins);
  const categories = useSearch((s) => s.categories);
  const starting = useSearch((s) => s.starting);
  const invalid = useSearch((s) => !!s.formError);
  const input = useRef<HTMLInputElement>(null);

  useEvent("ui.focusFilter", () => {
    input.current?.focus();
    input.current?.select();
  });
  useEffect(() => {
    // Straight to typing, except on phones where that pops the keyboard over everything.
    if (!useSearch.getState().active && window.matchMedia("(min-width: 761px)").matches) input.current?.focus();
  }, []);

  const sources = useMemo(() => {
    const usable = plugins.filter((p) => !p.error);
    const on = usable.filter((p) => p.enabled).length;
    return [
      { value: "enabled", label: on ? `Enabled sites (${on})` : "Enabled sites" },
      { value: "all", label: usable.length ? `All sites (${usable.length})` : "All sites" },
      ...[...plugins]
        .sort((a, b) => collator.compare(a.fullName || a.name, b.fullName || b.name))
        .map((p) => ({
          value: p.name,
          label: `${p.fullName || p.name}${p.error ? " (broken)" : p.enabled ? "" : " (off)"}`,
          disabled: !!p.error,
        })),
    ];
  }, [plugins]);
  const cats = useMemo(() => categoryOptions({ categories, plugins, source }), [categories, plugins, source]);

  // The site picked doesn't have this category: back to all of them.
  useEffect(() => {
    if (!cats.some((c) => c.value === category)) useSearch.setState({ category: "all" });
  }, [cats, category]);

  return (
    <header className="toolbar sv-toolbar">
      <IconButton className="nav-toggle" label="Menu" onClick={() => useStore.setState((s) => ({ navOpen: !s.navOpen }))}>
        <MenuIcon />
      </IconButton>
      <form
        className="sv-form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          startSearch();
        }}
      >
        <div className={`input-wrap sv-query${invalid ? " invalid" : ""}`}>
          <Search />
          <input
            ref={input}
            value={query}
            placeholder="Search torrent sites"
            aria-label="Search for"
            enterKeyHint="search"
            spellCheck={false}
            autoComplete="off"
            maxLength={1000}
            onChange={(e) => useSearch.setState({ query: e.target.value, formError: "" })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                useSearch.setState({ query: "", formError: "" });
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="icon-btn icon-btn-xs"
              aria-label="Clear"
              onClick={() => {
                useSearch.setState({ query: "", formError: "" });
                input.current?.focus();
              }}
            >
              <X />
            </button>
          ) : (
            <span className="suffix">
              <kbd>Ctrl+F</kbd>
            </span>
          )}
        </div>
        <Select className="sv-cat" value={category} options={cats} onChange={(v) => useSearch.setState({ category: v })} aria-label="Category" />
        <Select className="sv-src" value={source} options={sources} onChange={(v) => useSearch.setState({ source: v })} aria-label="Sites to search" />
        <Button type="submit" variant="primary" className="sv-go" icon={<Search />} loading={starting} aria-label="Search">
          <span className="sv-go-label">Search</span>
        </Button>
      </form>
      <IconButton label="Search plugins" onClick={() => openDialog({ type: "searchPlugins" })}>
        <Puzzle />
      </IconButton>
    </header>
  );
}

// ------------------------------------------------------------------ results
function Chip({ icon, label, onClear }: { icon: ReactNode; label: string; onClear: () => void }) {
  return (
    <span className="chip">
      {icon}
      <span>{label}</span>
      <button type="button" className="chip-x" aria-label={`Clear the ${label} filter`} onClick={onClear}>
        <X />
      </button>
    </span>
  );
}

function statusText(tab: SearchTab): string {
  const sites = tab.plugins.length;
  const results = plural(tab.total, "result");
  switch (tab.status) {
    case "running":
      return `${sites ? `Searching ${plural(sites, "site")}` : "Searching"} · ${results}`;
    case "stopped":
      return `Stopped · ${results}`;
    case "error":
      return "The search failed";
    default:
      return sites ? `${results} from ${plural(sites, "site")}` : results;
  }
}

function ResultsBar({ tab, shown, selected }: { tab: SearchTab; shown: number; selected: SearchResult[] }) {
  const filter = useSearch((s) => s.filter);
  const failed = new Set(tab.errors.map((e) => e.plugin)).size;
  const filtered = hasFilters(filter);
  return (
    <div className="sv-bar">
      <div className="sv-status" aria-live="polite">
        {tab.status === "running" ? (
          <Spinner size={14} />
        ) : tab.status === "error" ? (
          <CircleX className="text-err" />
        ) : tab.status === "stopped" ? (
          <CircleStop />
        ) : (
          <Search />
        )}
        <span className="sv-status-text">
          {statusText(tab)}
          {filtered && tab.total > 0 && <span className="faint"> · {shown.toLocaleString()} shown</span>}
        </span>
        {tab.status === "running" && (
          <Button size="sm" variant="ghost" onClick={() => void stopSearch(tab.id)}>
            Stop
          </Button>
        )}
        {failed > 0 && (
          <button type="button" className="sv-failed" onClick={() => openDialog({ type: "searchErrors", id: tab.id })}>
            <TriangleAlert />
            {failed >= tab.plugins.length && tab.plugins.length > 1 ? "Every site failed" : `${plural(failed, "site")} failed`}
          </button>
        )}
      </div>
      <div className="spacer" />
      {selected.length > 0 && (
        <Button size="sm" variant="primary" icon={<Download />} onClick={() => downloadResults(selected)}>
          {selected.length > 1 ? `Download ${selected.length.toLocaleString()}` : "Download"}
        </Button>
      )}
      <div className="filter-chips">
        {filter.minSeeds > 0 && (
          <Chip icon={<Sprout />} label={`${filter.minSeeds.toLocaleString()}+ seeds`} onClear={() => setResultFilter({ minSeeds: 0 })} />
        )}
        {(filter.minSize > 0 || filter.maxSize > 0) && (
          <Chip icon={<HardDrive />} label={sizeLabel(filter.minSize, filter.maxSize)} onClear={() => setResultFilter({ minSize: 0, maxSize: 0 })} />
        )}
        {filter.site && <Chip icon={<Globe />} label={siteLabel(filter.site)} onClear={() => setResultFilter({ site: null })} />}
      </div>
      <SearchInput
        className="sv-filter"
        value={filter.text}
        onChange={(v) => setResultFilter({ text: v })}
        placeholder="Filter results"
        aria-label="Filter results"
      />
      <IconButton
        label="Filters"
        active={filter.minSeeds > 0 || filter.minSize > 0 || filter.maxSize > 0 || !!filter.site}
        onClick={(e) => openDropdown(e.currentTarget, filterMenu(tab), { align: "end" })}
      >
        <SlidersHorizontal />
      </IconButton>
    </div>
  );
}

function emptyResults(tab: SearchTab): ReactNode {
  if (tab.results.length > 0) {
    return (
      <Empty
        icon={<SearchX />}
        title="Nothing matches the filters"
        actions={<Button onClick={() => setResultFilter(NO_FILTER)}>Clear filters</Button>}
      />
    );
  }
  if (tab.total > 0) return <Empty icon={<Spinner size={22} />} title="Loading results…" />;
  switch (tab.status) {
    case "running":
      return (
        <Empty icon={<Spinner size={22} />} title="Searching…">
          Results show up here as the sites answer.
        </Empty>
      );
    case "error":
      return (
        <Empty
          icon={<CircleX />}
          title="The search failed"
          actions={
            <>
              <Button onClick={() => openDialog({ type: "searchErrors", id: tab.id })}>What went wrong?</Button>
              <Button icon={<RotateCw />} onClick={() => repeatSearch(tab.id)}>
                Try again
              </Button>
            </>
          }
        />
      );
    case "stopped":
      return (
        <Empty
          icon={<CircleStop />}
          title="Stopped before anything turned up"
          actions={
            <Button icon={<RotateCw />} onClick={() => repeatSearch(tab.id)}>
              Search again
            </Button>
          }
        />
      );
    default:
      return (
        <Empty icon={<SearchX />} title={`Nothing found for “${tab.query}”`}>
          Try other words, another category, or more sites.
        </Empty>
      );
  }
}

function Results({ tab }: { tab: SearchTab }) {
  const filter = useSearch((s) => s.filter);
  const sort = useSearch((s) => s.sort);
  const plugins = useSearch((s) => s.plugins);
  const fetching = useSearch((s) => s.fetching);
  const resolved = useSearch((s) => s.resolved);
  // Only changes when torrents come or go, not with every speed update.
  const idsKey = useStore((s) => Object.keys(s.torrents).join(" "));
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  useEffect(() => setSelection(NO_SELECTION), [tab.id]);

  const byName = useMemo(() => Object.fromEntries(plugins.map((p) => [p.name, p])), [plugins]);
  // Results stream in; keep typing in the filter box smooth while thousands re-sort.
  const results = useDeferredValue(tab.results);
  const deferredFilter = useDeferredValue(filter);
  const rows = useMemo(
    () => visibleResults(results, deferredFilter, sort, (name) => byName[name]?.fullName || name),
    [results, deferredFilter, sort, byName],
  );
  const added = useMemo(() => {
    const out = new Set<string>();
    if (!idsKey) return out;
    const ids = new Set(idsKey.split(" "));
    for (const r of results) {
      const id = resultTorrentId(r, resolved);
      if (id && ids.has(id)) out.add(r.link);
    }
    return out;
  }, [results, resolved, idsKey]);
  const selected = useMemo(() => rows.filter((r) => selection.selected.has(r.link)), [rows, selection]);

  return (
    <>
      <ResultsBar tab={tab} shown={rows.length} selected={selected} />
      <ResultsTable
        rows={rows}
        sort={sort}
        onSort={setResultSort}
        selection={selection}
        onSelection={setSelection}
        plugins={byName}
        added={added}
        fetching={fetching}
        menu={resultMenu}
        onActivate={(rs) => downloadResults(rs)}
        empty={emptyResults(tab)}
      />
    </>
  );
}

function NoPlugins() {
  return (
    <Empty
      icon={<Puzzle />}
      title="Add some sites to search"
      actions={
        <>
          <Button variant="primary" onClick={() => openDialog({ type: "officialPlugins" })}>
            Get the official plugins
          </Button>
          <Button onClick={() => openDialog({ type: "searchPlugins" })}>Install a plugin…</Button>
        </>
      }
    >
      Promethea searches torrent sites through plugins. They're the same ones qBittorrent uses, so any plugin made for it works here
      too.
    </Empty>
  );
}

function Start() {
  const enabled = useSearch((s) => s.plugins.filter((p) => p.enabled && !p.error).map((p) => p.fullName || p.name).join("\n"));
  const names = enabled ? enabled.split("\n") : [];
  if (!names.length) {
    return (
      <Empty
        icon={<Puzzle />}
        title="Every site is turned off"
        actions={<Button onClick={() => openDialog({ type: "searchPlugins" })}>Choose sites</Button>}
      >
        Turn on the plugins you want to search, or pick a single site next to the search box.
      </Empty>
    );
  }
  return (
    <Empty icon={<Search />} title="Search torrent sites">
      Type what you're looking for above. Results from {names.length === 1 ? names[0] : `your ${names.length} enabled sites`} show up
      here as they arrive.
    </Empty>
  );
}

export function SearchView() {
  const pluginsLoaded = useSearch((s) => s.pluginsLoaded);
  const pluginsError = useSearch((s) => s.pluginsError);
  const hasPlugins = useSearch((s) => s.plugins.length > 0);
  const tab = useSearch((s) => (s.active ? s.tabs[s.active] : undefined));

  useEffect(() => {
    if (!useSearch.getState().listed) void listSearches();
    void loadPlugins();
  }, []);

  let body: ReactNode;
  if (tab) body = <Results tab={tab} />;
  else if (!pluginsLoaded) body = <div className="sv-center"><Spinner size={18} /></div>;
  else if (pluginsError)
    body = (
      <Empty icon={<CircleX />} title="Search isn't available" actions={<Button onClick={() => void loadPlugins()}>Try again</Button>}>
        {pluginsError}
      </Empty>
    );
  else if (!hasPlugins) body = <NoPlugins />;
  else body = <Start />;

  return (
    <div className="searchview">
      <SearchBar />
      <div className="sv-body">{body}</div>
    </div>
  );
}

// ------------------------------------------------------------------ sidebar
function newSearch(): void {
  useSearch.setState({ query: "", formError: "" });
  useStore.setState({ navOpen: false });
  emit("ui.focusFilter", null);
}

function historyMenu(tab: SearchTab): MenuEntry[] {
  const { order, tabs } = useSearch.getState();
  const finished = order.filter((id) => tabs[id]?.status !== "running").length;
  return [
    { label: "Search again", icon: <RotateCw />, onSelect: () => repeatSearch(tab.id) },
    tab.status === "running" && { label: "Stop", icon: <CircleStop />, onSelect: () => void stopSearch(tab.id) },
    { label: "Close", icon: <X />, onSelect: () => closeSearch(tab.id) },
    { type: "separator" },
    { label: "Close finished searches", disabled: !finished, onSelect: () => closeSearches("finished") },
    { label: "Close all searches", icon: <ListX />, onSelect: () => closeSearches("all") },
  ];
}

function HistoryItem({ tab, on }: { tab: SearchTab; on: boolean }) {
  const icon =
    tab.status === "running" ? (
      <Spinner size={15} />
    ) : tab.status === "error" ? (
      <CircleX className="ic-error" />
    ) : tab.status === "stopped" ? (
      <CircleStop />
    ) : (
      <Search />
    );
  const category = useSearch((s) => s.categories[tab.category]);
  return (
    <div className="sv-hist">
      <button
        type="button"
        className={`nav-item sm${on ? " on" : ""}`}
        aria-current={on ? "true" : undefined}
        title={tab.category !== "all" && category ? `${tab.query} (${category})` : tab.query}
        onClick={() => {
          selectSearch(tab.id);
          useStore.setState({ navOpen: false });
        }}
        onAuxClick={(e) => {
          if (e.button === 1) closeSearch(tab.id);
        }}
        onContextMenu={(e) => openContextMenu(e, historyMenu(tab))}
      >
        {icon}
        <span className="nav-label">{tab.query}</span>
        <span className="nav-count">{tab.total.toLocaleString()}</span>
      </button>
      <IconButton className="sv-hist-x" size="xs" label="Close search" tip={null} onClick={() => closeSearch(tab.id)}>
        <X />
      </IconButton>
    </div>
  );
}

function SearchNav() {
  const order = useSearch((s) => s.order);
  const tabs = useSearch((s) => s.tabs);
  const active = useSearch((s) => s.active);
  return (
    <div className="side-section">
      <div className="side-head">
        <span className="side-label">Searches</span>
        <IconButton label="New search" size="xs" onClick={newSearch}>
          <Plus />
        </IconButton>
      </div>
      <div className="nav">
        {order.length ? (
          order.map((id) => tabs[id] && <HistoryItem key={id} tab={tabs[id]} on={id === active} />)
        ) : (
          <p className="side-note">Searches you run show up here.</p>
        )}
        <button
          type="button"
          className="side-more"
          onClick={() => {
            useStore.setState({ navOpen: false });
            openDialog({ type: "searchPlugins" });
          }}
        >
          <Puzzle />
          Search plugins
        </button>
      </div>
    </div>
  );
}

registerSidebarSection("search", () => <SearchNav />);
