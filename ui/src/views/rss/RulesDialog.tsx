// Download rules, like qBittorrent's RSS downloader: new articles whose titles match a rule
// are downloaded on their own (while automatic downloading is on in Settings). Edits stay
// drafts until they're saved, because saving makes the backend check every unread article
// against the rule again, and a half-typed rule matches far too much.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { Check, Copy, Eraser, Info, ListFilter, Plus, Power, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { api } from "../../api/client";
import type { ContentLayout, RssFeed, RssMatch, RssRule } from "../../api/types";
import { Button, IconButton } from "../../components/ui/Button";
import { Checkbox, Field, Input, NumberInput, Select, TagsInput } from "../../components/ui/Form";
import type { Option } from "../../components/ui/Form";
import { openContextMenu, openMenu } from "../../components/ui/Menu";
import type { MenuEntry } from "../../components/ui/Menu";
import { Empty, PathInput, Spinner } from "../../components/ui/Misc";
import { Modal } from "../../components/ui/Modal";
import { confirm } from "../../dialogs/ConfirmDialog";
import type { DialogProps } from "../../dialogs/DialogHost";
import { formatAgo, formatDate, plural } from "../../lib/format";
import { useLatest, useNow } from "../../lib/hooks";
import { toastError, useStore } from "../../store/store";
import { clearEpisodes, deleteRules, loadRules, previewRule, renameRule, saveRule, scopeFeeds, useRss } from "./rssStore";

export interface RulesSpec {
  type: "rssRules";
  /** The rule to show first. */
  name?: string;
}

const SAVED = "r:";
const NEW = "n:";
/** Saving a rule that downloads this many torrents at once asks first. */
const MANY = 10;
/** Matching articles listed at most. */
const MAX_SHOWN = 300;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** A rule in the list: a saved one (perhaps with unsaved changes) or a new one. */
interface Entry {
  key: string;
  saved: RssRule | null;
  /** What the editor shows: the draft, else the saved rule. */
  rule: RssRule;
  dirty: boolean;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Compares what the editor changes; when it last matched and the episodes it got are the backend's. */
function sameRule(a: RssRule, b: RssRule): boolean {
  return (
    a.name === b.name &&
    a.enabled === b.enabled &&
    a.mustContain === b.mustContain &&
    a.mustNotContain === b.mustNotContain &&
    a.useRegex === b.useRegex &&
    a.episodeFilter === b.episodeFilter &&
    a.smartFilter === b.smartFilter &&
    sameList([...a.affectedFeeds].sort(), [...b.affectedFeeds].sort()) &&
    a.ignoreDays === b.ignoreDays &&
    a.addPaused === b.addPaused &&
    a.category === b.category &&
    sameList(a.tags, b.tags) &&
    a.savePath === b.savePath &&
    a.contentLayout === b.contentLayout &&
    a.priority === b.priority
  );
}

/** What gets saved (and previewed): the draft with the stored history, so an old copy can't bring back forgotten episodes. */
function toSave(e: Entry): RssRule {
  return {
    ...e.rule,
    name: e.rule.name.trim(),
    lastMatch: e.saved?.lastMatch ?? 0,
    previouslyMatchedEpisodes: e.saved?.previouslyMatchedEpisodes ?? [],
  };
}

function blankRule(name: string, feeds: string[], priority: number): RssRule {
  return {
    name,
    enabled: true,
    mustContain: "",
    mustNotContain: "",
    useRegex: false,
    episodeFilter: "",
    smartFilter: false,
    affectedFeeds: feeds,
    ignoreDays: 0,
    lastMatch: 0,
    previouslyMatchedEpisodes: [],
    addPaused: null,
    category: "",
    tags: [],
    savePath: "",
    contentLayout: null,
    priority,
  };
}

function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Saving replaces the rule with the same name, so names have to be unique. */
function nameError(name: string, own: string | null, rules: readonly RssRule[]): string | null {
  const n = name.trim();
  if (!n) return "Give it a name";
  if (n !== own && rules.some((r) => r.name === n)) return `There's already a rule called “${n}”`;
  return null;
}

// The backend's reading of "1x2;8-15;30-;" (promethea/rss.py _parse_episode_filter).
const EPISODES_RE = /^\s*(\d{1,4})\s*x(.*;)\s*$/is;
const DIGITS_RE = /^\d+$/;

/** An error when the filter can't match anything, a warning for the parts the backend skips. */
function checkEpisodes(text: string): { error?: string; warning?: string } {
  let expr = text.trim();
  if (!expr) return {};
  if (!expr.endsWith(";")) expr += ";";
  const m = EPISODES_RE.exec(expr);
  if (!m) return { error: "Write it like 1x2;8-15;30-; with the season, an x, then the episodes" };
  let good = 0;
  const bad: string[] = [];
  for (const raw of m[2].split(";")) {
    const tok = raw.trim();
    if (!tok) continue;
    const dash = tok.indexOf("-");
    const lo = dash < 0 ? tok : tok.slice(0, dash).trim();
    const hi = dash < 0 ? tok : tok.slice(dash + 1).trim();
    if (DIGITS_RE.test(lo) && (hi === "" || (DIGITS_RE.test(hi) && +lo <= +hi))) good++;
    else bad.push(tok);
  }
  if (!good) return { error: `Add the episodes after the x, like ${m[1]}x1-; for all of them` };
  if (bad.length) {
    const list = bad.map((t) => `“${t}”`).join(", ");
    return { warning: `${list} ${bad.length === 1 ? "isn't" : "aren't"} understood and ${bad.length === 1 ? "is" : "are"} skipped. Ranges go from low to high, like 8-15.` };
  }
  return {};
}

/** The backend uses Python's regular expressions; JavaScript's agree on nearly everything. */
function regexProblem(pattern: string): string | null {
  if (!pattern) return null;
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (e) {
    return `This doesn't look like a valid regular expression (${message(e).replace(/^.*: /, "")}). One that isn't matches nothing.`;
  }
}

function summary(rule: RssRule): string {
  if (!rule.affectedFeeds.length) return "No feeds picked";
  return rule.mustContain.trim() || "Every title";
}

// ------------------------------------------------------------------ the dialog
export function RulesDialog({ spec, close }: DialogProps<RulesSpec>) {
  const rules = useRss((s) => s.rules);
  const rulesError = useRss((s) => s.rulesError);
  const prefsLoaded = useStore((s) => !!s.prefs);
  const auto = useStore((s) => !!s.prefs?.rss?.autoDownload);
  const [drafts, setDrafts] = useState<Record<string, RssRule>>({});
  /** New rules, in the order they were made. */
  const [fresh, setFresh] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(spec.name != null ? SAVED + spec.name : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef(0);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadRules();
    return () => window.clearTimeout(flashTimer.current);
  }, []);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const r of rules ?? []) {
      const key = SAVED + r.name;
      const d = drafts[key];
      out.push({ key, saved: r, rule: d ?? r, dirty: !!d && !sameRule(d, r) });
    }
    for (const key of fresh) if (drafts[key]) out.push({ key, saved: null, rule: drafts[key], dirty: true });
    return out;
  }, [rules, drafts, fresh]);

  // A rule that's gone (deleted or renamed elsewhere) hands over to the first one.
  const current = entries.find((e) => e.key === sel) ?? entries[0] ?? null;
  const latest = useLatest({ entries, current, rules });

  useEffect(() => {
    if (!current) return;
    listRef.current?.querySelector(`[data-key="${CSS.escape(current.key)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current?.key]);

  const edit = (patch: Partial<RssRule>) => {
    if (!current) return;
    const { key, rule } = current;
    setDrafts((d) => ({ ...d, [key]: { ...(d[key] ?? rule), ...patch } }));
    setError("");
  };

  const drop = (key: string) => {
    setDrafts((d) => {
      if (!(key in d)) return d;
      const next = { ...d };
      delete next[key];
      return next;
    });
    setFresh((f) => (f.includes(key) ? f.filter((k) => k !== key) : f));
  };

  const select = (key: string) => {
    setSel(key);
    setError("");
  };

  const create = (from?: RssRule) => {
    const { entries } = latest.current;
    const taken = new Set(entries.map((e) => e.rule.name.trim()));
    const priority = Math.max(0, ...entries.map((e) => e.rule.priority)) + 1;
    let rule: RssRule;
    if (from) {
      rule = { ...from, name: freeName(`${from.name.trim()} copy`, taken), priority, lastMatch: 0, previouslyMatchedEpisodes: [] };
    } else {
      // It watches the feeds the RSS view shows.
      const s = useRss.getState();
      rule = blankRule(freeName("New rule", taken), scopeFeeds(s, s.scope).map((f) => f.url), priority);
    }
    const key = NEW + ++seq.current;
    setDrafts((d) => ({ ...d, [key]: rule }));
    setFresh((f) => [...f, key]);
    select(key);
    // Naming it comes first.
    requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
  };

  /** Saving a rule downloads the unread articles it matches straight away: ask first when that's a lot. */
  const okToDownload = async (rule: RssRule): Promise<boolean> => {
    if (!auto || !rule.enabled) return true;
    let n: number;
    try {
      n = (await previewRule(rule)).filter((m) => !m.read && m.hasTorrent).length;
    } catch {
      return true; // saving will say what's wrong
    }
    if (rule.ignoreDays > 0) n = Math.min(n, 1); // the first one starts the pause
    if (n < MANY) return true;
    return confirm({
      title: `Download ${n} torrents now?`,
      message: `“${rule.name}” matches ${plural(n, "unread article")} in its feeds, and they're all downloaded as soon as it's saved.`,
      confirmLabel: "Download them",
    });
  };

  const showSaved = () => {
    setFlash(true);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(false), 2500);
  };

  const save = async () => {
    const { current: entry, rules: saved } = latest.current;
    if (!entry || busy) return;
    if (nameError(entry.rule.name, entry.saved?.name ?? null, saved ?? []) || checkEpisodes(entry.rule.episodeFilter).error) return;
    const rule = toSave(entry);
    setBusy(true);
    setError("");
    try {
      if (entry.dirty && !(await okToDownload(rule))) return;
      let key = entry.key;
      const old = entry.saved?.name;
      if (old !== undefined && old !== rule.name) {
        await renameRule(old, rule.name);
        // It has the new name now, whatever happens next.
        const to = SAVED + rule.name;
        setDrafts((d) => {
          const next = { ...d, [to]: d[key] };
          delete next[key];
          return next;
        });
        setSel(to);
        key = to;
      }
      const done = SAVED + (await saveRule(rule)).name;
      setDrafts((d) => {
        const next = { ...d };
        const mine = next[key];
        delete next[key];
        // Changed again while it saved: those changes stay a draft.
        if (mine && !sameRule(mine, entry.rule)) next[done] = mine;
        else delete next[done];
        return next;
      });
      setFresh((f) => f.filter((k) => k !== entry.key));
      setSel(done);
      showSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (entry: Entry, on: boolean) => {
    if (entry.saved) {
      // Saved rules turn on and off at once; changes being made to them stay a draft.
      const rule = { ...entry.saved, enabled: on };
      if (on && !(await okToDownload(rule))) return;
      try {
        await saveRule(rule);
      } catch (e) {
        toastError(e, `Couldn't turn “${rule.name}” ${on ? "on" : "off"}`);
        return;
      }
    }
    setDrafts((d) => (d[entry.key] ? { ...d, [entry.key]: { ...d[entry.key], enabled: on } } : d));
  };

  const remove = async (entry: Entry) => {
    const { entries } = latest.current;
    const i = entries.findIndex((e) => e.key === entry.key);
    const next = entries[i + 1] ?? entries[i - 1] ?? null;
    if (entry.saved) {
      const name = entry.saved.name;
      const ok = await confirm({
        title: `Delete “${name}”?`,
        message: "The torrents it downloaded stay in the transfer list.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteRules([name]);
      } catch (e) {
        toastError(e, "Couldn't delete the rule");
        return;
      }
    }
    drop(entry.key);
    setSel((s) => (s === entry.key || s === null ? next?.key ?? null : s));
  };

  const requestClose = async () => {
    const unsaved = latest.current.entries.filter((e) => e.dirty);
    if (unsaved.length) {
      const one = unsaved.length === 1 ? unsaved[0] : null;
      const ok = await confirm({
        title: one
          ? one.saved
            ? `Discard the changes to “${one.saved.name}”?`
            : `Discard the new rule “${one.rule.name.trim() || "Unnamed"}”?`
          : `Discard the changes to ${unsaved.length} rules?`,
        message: one && !one.saved ? "It hasn't been saved." : "They haven't been saved.",
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    close();
  };

  const menuFor = (entry: Entry): MenuEntry[] => [
    {
      label: entry.rule.enabled ? "Turn off" : "Turn on",
      icon: <Power />,
      onSelect: () => void setEnabled(entry, !entry.rule.enabled),
    },
    { label: "Duplicate", icon: <Copy />, onSelect: () => create(entry.rule) },
    { type: "separator" },
    {
      label: entry.saved ? "Delete…" : "Discard",
      icon: <Trash2 />,
      hint: "Del",
      danger: true,
      onSelect: () => void remove(entry),
    },
  ];

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!current || e.target !== e.currentTarget) return;
    const i = entries.indexOf(current);
    let j: number;
    switch (e.key) {
      case "ArrowDown":
        j = Math.min(entries.length - 1, i + 1);
        break;
      case "ArrowUp":
        j = Math.max(0, i - 1);
        break;
      case "Home":
        j = 0;
        break;
      case "End":
        j = entries.length - 1;
        break;
      case " ":
        e.preventDefault();
        void setEnabled(current, !current.rule.enabled);
        return;
      case "Delete":
        e.preventDefault();
        void remove(current);
        return;
      default:
        return;
    }
    e.preventDefault();
    select(entries[j].key);
  };

  const onListMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    const row = (e.target as Element).closest<HTMLElement>("[data-key]");
    const entry = row ? entries.find((x) => x.key === row.dataset.key) : current;
    if (!entry) return;
    e.preventDefault();
    if (row) {
      select(entry.key);
      openContextMenu(e, menuFor(entry));
      return;
    }
    // From the keyboard: under the selected rule.
    const r = listRef.current?.querySelector(`[data-key="${CSS.escape(entry.key)}"]`)?.getBoundingClientRect();
    if (r) openMenu({ items: menuFor(entry), x: r.left + 28, y: r.bottom });
  };

  const blocked =
    !!current && (!!nameError(current.rule.name, current.saved?.name ?? null, rules ?? []) || !!checkEpisodes(current.rule.episodeFilter).error);

  let body: ReactNode;
  if (rules === null) {
    body = rulesError ? (
      <Empty
        icon={<TriangleAlert />}
        title="Couldn't load the rules"
        actions={
          <Button icon={<RefreshCw />} onClick={() => void loadRules()}>
            Try again
          </Button>
        }
      >
        {rulesError}
      </Empty>
    ) : (
      <div className="rr-wait">
        <Spinner size={18} />
      </div>
    );
  } else if (!current) {
    body = (
      <Empty
        icon={<ListFilter />}
        title="No download rules yet"
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => create()}>
            New rule
          </Button>
        }
      >
        A rule downloads new articles whose titles match it, like every new episode of a show.
      </Empty>
    );
  } else {
    body = (
      <div className="rr-layout">
        <aside className="rr-list">
          <div className="rr-list-head">
            <span className="rr-list-title">Rules</span>
            <IconButton label="New rule" size="sm" onClick={() => create()}>
              <Plus />
            </IconButton>
          </div>
          <RuleList
            entries={entries}
            current={current}
            listRef={listRef}
            onSelect={select}
            onToggle={(entry, on) => void setEnabled(entry, on)}
            onKeyDown={onListKey}
            onContextMenu={onListMenu}
          />
        </aside>
        <div className="rr-editor">
          <RuleEditor entry={current} rules={rules} edit={edit} error={error} nameRef={nameRef} />
          <Matches entry={current} auto={auto} />
        </div>
      </div>
    );
  }

  return (
    <Modal
      title="Download rules"
      subtitle="New articles that match a rule are downloaded on their own."
      icon={<ListFilter />}
      size="xl"
      className="rr-dialog"
      bodyClassName="rr-body"
      onClose={() => void requestClose()}
      onSubmit={() => void save()}
      footer={
        <>
          {current && (
            <Button variant="ghost" className="rr-delete" icon={<Trash2 />} disabled={busy} onClick={() => void remove(current)}>
              {current.saved ? "Delete" : "Discard"}
            </Button>
          )}
          {current?.saved && current.dirty && (
            <Button variant="ghost" disabled={busy} onClick={() => drop(current.key)}>
              Undo changes
            </Button>
          )}
          <div className="spacer" />
          {flash && (
            <span className="rr-saved" role="status">
              <Check />
              Saved
            </span>
          )}
          <Button onClick={() => void requestClose()}>Close</Button>
          {current && (
            <Button type="submit" variant="primary" loading={busy} disabled={!current.dirty || blocked}>
              Save
            </Button>
          )}
        </>
      }
    >
      {prefsLoaded && !auto && <AutoOff />}
      {body}
    </Modal>
  );
}

/** Rules only download while automatic downloading is on. */
function AutoOff() {
  const [busy, setBusy] = useState(false);
  const turnOn = async () => {
    setBusy(true);
    try {
      const prefs = await api.setPrefs({ rss: { autoDownload: true } });
      useStore.setState({ prefs });
    } catch (e) {
      toastError(e, "Couldn't turn it on");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="callout info rr-auto">
      <Info />
      <span className="grow">
        Automatic downloading is off in Settings, so rules don't download anything. Turning it on downloads the unread articles they match.
      </span>
      <Button size="sm" loading={busy} onClick={() => void turnOn()}>
        Turn it on
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ the list
function RuleList({
  entries,
  current,
  listRef,
  onSelect,
  onToggle,
  onKeyDown,
  onContextMenu,
}: {
  entries: Entry[];
  current: Entry;
  listRef: RefObject<HTMLDivElement | null>;
  onSelect: (key: string) => void;
  onToggle: (entry: Entry, on: boolean) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onContextMenu: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const id = useId();
  const index = entries.indexOf(current);
  return (
    <div
      ref={listRef}
      className="rr-items"
      role="listbox"
      aria-label="Rules"
      tabIndex={0}
      data-autofocus
      aria-activedescendant={index >= 0 ? `${id}-${index}` : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
    >
      {entries.map((e, i) => {
        const name = e.rule.name.trim() || "Unnamed";
        return (
          <div
            key={e.key}
            id={`${id}-${i}`}
            data-key={e.key}
            role="option"
            aria-selected={e === current}
            className={["rr-item", e === current && "sel", !e.rule.enabled && "off"].filter(Boolean).join(" ")}
            onClick={() => onSelect(e.key)}
          >
            {/* Space toggles the selected rule; the switch itself stays out of the tab order. */}
            <input
              type="checkbox"
              role="switch"
              className="sw"
              tabIndex={-1}
              checked={e.rule.enabled}
              aria-label={`Use “${name}”`}
              data-tip={e.rule.enabled ? "On" : "Off"}
              onClick={(ev) => ev.stopPropagation()}
              onChange={(ev) => onToggle(e, ev.target.checked)}
            />
            <span className="rr-item-main">
              <span className="rr-item-name">
                <span className="ellipsis">{name}</span>
                {e.dirty && <span className="rr-unsaved" title={e.saved ? "Changes not saved" : "Not saved yet"} />}
              </span>
              <span className="rr-item-sub ellipsis">{summary(e.rule)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ the editor
const STARTS: Option<"" | "start" | "stop">[] = [
  { value: "", label: "As in Settings" },
  { value: "start", label: "Start right away" },
  { value: "stop", label: "Keep it stopped" },
];

const LAYOUTS: Option<"" | ContentLayout>[] = [
  { value: "", label: "As in Settings" },
  { value: "original", label: "Original" },
  { value: "subfolder", label: "Create a subfolder" },
  { value: "noSubfolder", label: "Don't create a subfolder" },
];

function Warn({ children }: { children: ReactNode }) {
  return <span className="rr-warn">{children}</span>;
}

function RuleEditor({
  entry,
  rules,
  edit,
  error,
  nameRef,
}: {
  entry: Entry;
  rules: readonly RssRule[];
  edit: (patch: Partial<RssRule>) => void;
  error: string;
  nameRef: RefObject<HTMLInputElement | null>;
}) {
  const categories = useStore((s) => s.categories);
  const allTags = useStore((s) => s.tags);
  const ids = {
    name: useId(),
    must: useId(),
    not: useId(),
    eps: useId(),
    days: useId(),
    cat: useId(),
    tags: useId(),
    save: useId(),
    start: useId(),
    layout: useId(),
  };
  const r = entry.rule;
  const nameErr = nameError(r.name, entry.saved?.name ?? null, rules);
  const eps = checkEpisodes(r.episodeFilter);
  const mustWarn = r.useRegex ? regexProblem(r.mustContain) : null;
  const notWarn = r.useRegex ? regexProblem(r.mustNotContain) : null;

  const catOptions = useMemo(() => {
    const names = Object.keys(categories).sort(collator.compare);
    const opts: Option[] = [{ value: "", label: "None" }, ...names.map((n) => ({ value: n, label: n }))];
    // Adding a torrent makes the category when there isn't one.
    if (r.category && !(r.category in categories)) opts.push({ value: r.category, label: `${r.category} (new)` });
    return opts;
  }, [categories, r.category]);

  let mustHint: ReactNode;
  if (mustWarn) mustHint = <Warn>{mustWarn}</Warn>;
  else if (!r.mustContain.trim()) mustHint = <Warn>Empty, so every title matches.</Warn>;
  else if (r.useRegex) mustHint = "A regular expression; capitals don't matter.";
  else mustHint = "Every word has to be in the title, in any order. * matches anything, ? one character, and | separates alternatives.";

  return (
    <div className="rr-fields">
      {error && (
        <div className="callout error" role="alert">
          <TriangleAlert />
          <span>{error}</span>
        </div>
      )}
      <section className="rr-section">
        <Field label="Name" htmlFor={ids.name} error={nameErr}>
          <Input ref={nameRef} id={ids.name} value={r.name} invalid={!!nameErr} onChange={(e) => edit({ name: e.target.value })} />
        </Field>
        <Field label="Must contain" htmlFor={ids.must} hint={mustHint}>
          <Input
            id={ids.must}
            className={r.useRegex ? "mono" : undefined}
            value={r.mustContain}
            placeholder={r.useRegex ? "^Show Name.*1080p" : "Show Name 1080p"}
            onChange={(e) => edit({ mustContain: e.target.value })}
          />
        </Field>
        <Field label="Must not contain" htmlFor={ids.not} hint={notWarn ? <Warn>{notWarn}</Warn> : "Titles that match this are left out."}>
          <Input
            id={ids.not}
            className={r.useRegex ? "mono" : undefined}
            value={r.mustNotContain}
            placeholder={r.useRegex ? "" : "720p | x265"}
            onChange={(e) => edit({ mustNotContain: e.target.value })}
          />
        </Field>
        <Checkbox checked={r.useRegex} label="Regular expressions" onChange={(v) => edit({ useRegex: v })} />
        <Field
          label="Episodes"
          htmlFor={ids.eps}
          error={eps.error}
          hint={eps.warning ? <Warn>{eps.warning}</Warn> : "1x2;8-15;30-; is season 1’s episodes 2, 8 to 15, and 30 on (later seasons too). Empty takes every episode."}
        >
          <Input
            id={ids.eps}
            className="mono"
            value={r.episodeFilter}
            invalid={!!eps.error}
            placeholder="1x2;8-15;30-;"
            onChange={(e) => edit({ episodeFilter: e.target.value })}
          />
        </Field>
        <Checkbox
          checked={r.smartFilter}
          label="Smart episode filter"
          hint="Downloads each episode once, whatever the quality."
          onChange={(v) => edit({ smartFilter: v })}
        />
        <Field label="After a match, skip the next ones for" htmlFor={ids.days} hint="0 never skips." className="rr-days">
          <NumberInput id={ids.days} value={r.ignoreDays} min={0} max={36500} suffix="days" onChange={(v) => edit({ ignoreDays: v })} />
        </Field>
      </section>

      <section className="rr-section">
        <h3 className="rr-section-title">Feeds</h3>
        <FeedPicker value={r.affectedFeeds} onChange={(urls) => edit({ affectedFeeds: urls })} />
      </section>

      <section className="rr-section">
        <h3 className="rr-section-title">Adding the torrents</h3>
        <div className="field-row">
          <Field label="Category" htmlFor={ids.cat}>
            <Select id={ids.cat} value={r.category} options={catOptions} onChange={(v) => edit({ category: v })} />
          </Field>
          <Field label="Tags" htmlFor={ids.tags}>
            <TagsInput id={ids.tags} value={r.tags} suggestions={allTags} placeholder="None" onChange={(tags) => edit({ tags })} />
          </Field>
        </div>
        <Field label="Save to" htmlFor={ids.save}>
          <PathInput id={ids.save} value={r.savePath} placeholder="Where torrents usually go" onChange={(v) => edit({ savePath: v })} />
        </Field>
        <div className="field-row">
          <Field label="When added" htmlFor={ids.start}>
            <Select
              id={ids.start}
              value={r.addPaused === null ? "" : r.addPaused ? "stop" : "start"}
              options={STARTS}
              onChange={(v) => edit({ addPaused: v === "" ? null : v === "stop" })}
            />
          </Field>
          <Field label="Content layout" htmlFor={ids.layout}>
            <Select id={ids.layout} value={r.contentLayout ?? ""} options={LAYOUTS} onChange={(v) => edit({ contentLayout: v || null })} />
          </Field>
        </div>
      </section>

      {entry.saved && <History rule={entry.saved} ignoreDays={r.ignoreDays} />}
    </div>
  );
}

function FeedPicker({ value, onChange }: { value: readonly string[]; onChange: (urls: string[]) => void }) {
  const feeds = useRss((s) => s.feeds);
  const sorted = useMemo(
    () => [...feeds].sort((a, b) => collator.compare(a.folder, b.folder) || collator.compare(a.name, b.name)),
    [feeds],
  );
  if (!feeds.length && !value.length) return <p className="rr-note">Add a feed first: rules only look at the feeds they're given.</p>;
  const chosen = new Set(value);
  const known = new Set(feeds.map((f) => f.url));
  // Feeds it watched that were removed since.
  const gone = value.filter((u) => !known.has(u));
  const count = feeds.filter((f) => chosen.has(f.url)).length;
  const toggle = (url: string, on: boolean) => onChange(on ? [...value, url] : value.filter((u) => u !== url));
  return (
    <div className="rr-feeds">
      {feeds.length > 1 && (
        <Checkbox
          className="rr-feeds-all"
          checked={count === feeds.length}
          indeterminate={count > 0 && count < feeds.length}
          label="All feeds"
          onChange={(on) => onChange(on ? [...gone, ...sorted.map((f) => f.url)] : gone)}
        />
      )}
      {sorted.map((f) => (
        <Checkbox
          key={f.id}
          checked={chosen.has(f.url)}
          label={f.name}
          hint={f.folder ? f.folder.split("/").join(" › ") : undefined}
          onChange={(on) => toggle(f.url, on)}
        />
      ))}
      {gone.map((u) => (
        <Checkbox key={u} checked label={u} hint="Not one of your feeds anymore" onChange={() => toggle(u, false)} />
      ))}
    </div>
  );
}

function History({ rule, ignoreDays }: { rule: RssRule; ignoreDays: number }) {
  const now = useNow(30_000);
  const until = rule.lastMatch > 0 && ignoreDays > 0 ? rule.lastMatch + ignoreDays * 86400 : 0;
  const eps = rule.previouslyMatchedEpisodes;
  const forget = async () => {
    const ok = await confirm({
      title: "Forget the episodes it downloaded?",
      message: "The smart filter then downloads them again when they turn up, unread articles already in its feeds included.",
      confirmLabel: "Forget them",
    });
    if (ok) clearEpisodes(rule.name).catch((e) => toastError(e, "Couldn't forget them"));
  };
  return (
    <section className="rr-section">
      <h3 className="rr-section-title">History</h3>
      <div className="rr-history">
        <span className="muted">Last match</span>
        <span title={rule.lastMatch > 0 ? formatDate(rule.lastMatch) : undefined}>{formatAgo(rule.lastMatch, now)}</span>
      </div>
      {until > now && <p className="rr-note">It skips matches until {formatDate(until)}.</p>}
      {eps.length > 0 && (
        <>
          <div className="rr-history">
            <span className="muted">Episodes downloaded</span>
            <span>{eps.length.toLocaleString()}</span>
          </div>
          <div className="rr-episodes">
            {eps.slice(0, 60).map((ep) => (
              <span key={ep} className="chip mono">
                {ep}
              </span>
            ))}
            {eps.length > 60 && <span className="faint">and {(eps.length - 60).toLocaleString()} more</span>}
          </div>
          <div>
            <Button size="sm" icon={<Eraser />} onClick={() => void forget()}>
              Forget these episodes
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ matching articles
interface Preview {
  key: string;
  probe: string;
  matches: RssMatch[] | null;
  error: string;
}

function groupMatches(matches: readonly RssMatch[], feeds: readonly RssFeed[]) {
  const byFeed = new Map<string, RssMatch[]>();
  for (const m of matches.slice(0, MAX_SHOWN)) {
    let list = byFeed.get(m.feedId);
    if (!list) byFeed.set(m.feedId, (list = []));
    list.push(m);
  }
  const names = new Map(feeds.map((f) => [f.id, f.name]));
  return [...byFeed]
    .map(([feedId, items]) => ({ feedId, name: names.get(feedId) ?? "Feed", items }))
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** What the rule matches in its feeds now, checked by the backend as it's edited. */
function Matches({ entry, auto }: { entry: Entry; auto: boolean }) {
  const feeds = useRss((s) => s.feeds);
  const rule = toSave(entry);
  const probe = JSON.stringify(rule);
  const [preview, setPreview] = useState<Preview | null>(null);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const key = entry.key;
    // Right away for another rule; a moment after typing stops for this one.
    const delay = lastKey.current === key ? 300 : 0;
    lastKey.current = key;
    let alive = true;
    const t = window.setTimeout(() => {
      previewRule(rule).then(
        (matches) => alive && setPreview({ key, probe, matches, error: "" }),
        (e: unknown) => alive && setPreview({ key, probe, matches: null, error: message(e) }),
      );
    }, delay);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // The rule is in `probe`; new articles come with a new feed list.
  }, [probe, entry.key, feeds]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = preview?.key === entry.key ? preview : null;
  const loading = !shown || shown.probe !== probe;
  const groups = useMemo(() => groupMatches(shown?.matches ?? [], feeds), [shown, feeds]);
  const total = shown?.matches?.length ?? 0;
  const unread = shown?.matches?.filter((m) => !m.read && m.hasTorrent).length ?? 0;

  let note: string | null = null;
  if (auto && entry.rule.enabled && entry.dirty && unread > 0 && !loading) {
    if (unread === 1) note = "Saving it downloads the unread one.";
    else if (entry.rule.ignoreDays > 0) note = `Saving it downloads one of the ${unread} unread ones, then skips matches for ${plural(entry.rule.ignoreDays, "day")}.`;
    else note = `Saving it downloads the ${unread} unread ones.`;
  }

  let content: ReactNode = null;
  if (!entry.rule.affectedFeeds.length) content = <p className="rr-matches-note">Pick the feeds it watches.</p>;
  else if (shown?.error) content = <p className="rr-matches-note text-err">{shown.error}</p>;
  else if (shown && !total) content = <p className="rr-matches-note">Nothing in its feeds matches right now.</p>;
  else if (shown)
    content = (
      <>
        {groups.map((g) => (
          <div key={g.feedId} className="rr-match-group">
            <div className="rr-match-feed ellipsis">{g.name}</div>
            <ul>
              {g.items.map((m) => (
                <li key={m.articleId} className={`rr-match${m.read ? " read" : ""}`} title={m.read ? m.title : `${m.title} (unread)`}>
                  <span className="rr-match-dot" aria-hidden />
                  <span className="rr-match-title">{m.title || "Untitled"}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {total > MAX_SHOWN && <p className="rr-matches-note">And {(total - MAX_SHOWN).toLocaleString()} more.</p>}
      </>
    );

  return (
    <section className="rr-matches" aria-label="Matching articles">
      <div className="rr-matches-head">
        <span className="grow">Matching articles</span>
        {loading && !!entry.rule.affectedFeeds.length ? <Spinner size={14} /> : total > 0 && <span className="badge">{total.toLocaleString()}</span>}
      </div>
      {note && <p className="rr-matches-note rr-get">{note}</p>}
      {content}
    </section>
  );
}
