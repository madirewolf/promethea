import type { CSSProperties } from "react";
import { Copy, Pencil, Plus, RefreshCw, Trash } from "lucide-react";
import { api } from "../../../api/client";
import type { TrackerEntry, TrackerStatus } from "../../../api/types";
import type { MenuEntry } from "../../../components/ui/Menu";
import * as A from "../../../lib/actions";
import { formatDuration } from "../../../lib/format";
import { useEvent } from "../../../lib/hooks";
import { openDialog } from "../../../store/store";
import { DetailTable } from "./DetailTable";
import type { DtColumn } from "./DetailTable";
import { TabError, TabLoading, count, useRefreshMs, useSoon, useTorrentPoll } from "./shared";

export const TRACKER_RE = /^(https?|udp|wss?):\/\/\S+$/i;

const STATUS: Record<TrackerStatus, { label: string; color: string }> = {
  working: { label: "Working", color: "var(--green)" },
  updating: { label: "Updating…", color: "var(--amber)" },
  notWorking: { label: "Not working", color: "var(--red)" },
  notContacted: { label: "Not contacted yet", color: "var(--text-3)" },
  disabled: { label: "Disabled", color: "var(--text-3)" },
};

const PSEUDO: Record<string, string> = {
  "** [DHT] **": "DHT",
  "** [PeX] **": "Peer exchange (PeX)",
  "** [LSD] **": "Local peer discovery (LSD)",
};

const lines = (v: string) => v.split(/\r?\n/).map((l) => l.trim());

/** Ask for tracker URLs (blank lines separate tiers) and add them to a torrent. */
export function promptAddTrackers(id: string, done?: () => void): void {
  openDialog({
    type: "prompt",
    title: "Add trackers",
    label: "Tracker URLs",
    multiline: true,
    mono: true,
    placeholder: "udp://tracker.example.org:1337/announce",
    hint: "One per line. A blank line starts a new tier.",
    confirmLabel: "Add trackers",
    validate: (v: string) => {
      const urls = lines(v).filter(Boolean);
      if (!urls.length) return "Enter at least one tracker URL";
      const bad = urls.find((u) => !TRACKER_RE.test(u));
      return bad ? `Not a tracker URL: ${bad}` : null;
    },
    onSubmit: async (v: string) => {
      await api.editTrackers(id, { add: lines(v) });
      done?.();
    },
  });
}

function announceIn(seconds: number): string {
  return seconds > 0 ? formatDuration(seconds) : "–";
}

const COLUMNS: DtColumn<TrackerEntry>[] = [
  {
    key: "url",
    label: "URL",
    cell: (t) => (
      <span className="cell-flex">
        <span className="dot" style={{ "--st": STATUS[t.status]?.color } as CSSProperties} />
        <span className="cell-text">{t.pseudo ? PSEUDO[t.url] ?? t.url : t.url}</span>
      </span>
    ),
    cellTip: (t) => (t.pseudo ? undefined : t.url),
  },
  { key: "tier", label: "Tier", width: 56, right: true, cell: (t) => (t.tier < 0 ? "" : t.tier) },
  { key: "status", label: "Status", width: 132, cell: (t) => STATUS[t.status]?.label ?? t.status },
  { key: "peers", label: "Peers", width: 70, right: true, cell: (t) => count(t.peers) },
  { key: "seeds", label: "Seeds", width: 70, right: true, cell: (t) => count(t.seeds) },
  { key: "leeches", label: "Leeches", width: 78, right: true, cell: (t) => count(t.leeches) },
  {
    key: "downloaded",
    label: "Completed",
    width: 92,
    right: true,
    tip: "How many times the tracker says the torrent was downloaded",
    cell: (t) => count(t.downloaded),
  },
  { key: "message", label: "Message", width: 220, cell: (t) => t.message, cellTip: (t) => t.message || undefined },
  { key: "next", label: "Next announce", width: 118, right: true, cell: (t) => (t.pseudo ? "" : announceIn(t.nextAnnounce)) },
  {
    key: "min",
    label: "Min announce",
    width: 112,
    right: true,
    tip: "The earliest the tracker allows the next announce",
    cell: (t) => (t.pseudo ? "" : announceIn(t.minAnnounce)),
  },
];

export function TrackersTab({ id, nonce }: { id: string; nonce: number }) {
  const base = useRefreshMs();
  const { data, error, refresh } = useTorrentPoll<TrackerEntry[]>(id, api.trackers, Math.max(2000, base), nonce);
  const soon = useSoon(refresh);
  useEvent("torrent.metadata", (d) => d?.id === id && soon());

  if (!data) return error ? <TabError message={error} /> : <TabLoading />;
  const rows = data;

  const change = (c: Parameters<typeof api.editTrackers>[1], what: string) =>
    void A.attempt(() => api.editTrackers(id, c), what).then(refresh);

  const edit = (t: TrackerEntry) =>
    openDialog({
      type: "prompt",
      title: "Edit tracker URL",
      label: "URL",
      value: t.url,
      mono: true,
      size: "md",
      confirmLabel: "Save",
      validate: (v: string) => {
        const url = v.trim();
        if (!TRACKER_RE.test(url)) return "Enter a tracker URL (http, https, udp, ws or wss)";
        return url !== t.url && rows.some((r) => r.url === url) ? "That tracker is already in the list" : null;
      },
      onSubmit: async (v: string) => {
        const url = v.trim();
        if (url === t.url) return;
        await api.editTrackers(id, { edit: { [t.url]: url } });
        refresh();
      },
    });

  const remove = (ts: TrackerEntry[]) => change({ remove: ts.map((t) => t.url) }, "Couldn't remove the tracker");
  const copy = (ts: TrackerEntry[]) =>
    void A.copyText(ts.map((t) => t.url).join("\n"), ts.length > 1 ? "Tracker URLs" : "Tracker URL");

  const menu = (sel: TrackerEntry[]): MenuEntry[] => {
    const real = sel.filter((t) => !t.pseudo);
    return [
      { label: "Add trackers…", icon: <Plus />, onSelect: () => promptAddTrackers(id, refresh) },
      real.length === 1 && { label: "Edit URL…", icon: <Pencil />, hint: "F2", onSelect: () => edit(real[0]) },
      real.length > 0 && {
        label: real.length > 1 ? `Remove ${real.length} trackers` : "Remove tracker",
        icon: <Trash />,
        hint: "Del",
        danger: true,
        onSelect: () => remove(real),
      },
      { type: "separator" },
      real.length > 0 && { label: real.length > 1 ? "Copy URLs" : "Copy URL", icon: <Copy />, hint: "Ctrl+C", onSelect: () => copy(real) },
      { label: "Reannounce now", icon: <RefreshCw />, onSelect: () => A.reannounce([id]) },
    ];
  };

  return (
    <DetailTable
      label="Trackers"
      rows={rows}
      rowKey={(t) => t.url}
      columns={COLUMNS}
      rowClass={(t) => (t.pseudo ? "pseudo" : undefined)}
      menu={menu}
      onActivate={(t) => !t.pseudo && edit(t)}
      onKey={(e, sel) => {
        const real = sel.filter((t) => !t.pseudo);
        if (!real.length) return false;
        if (e.key === "Delete") remove(real);
        else if (e.key === "F2" && real.length === 1) edit(real[0]);
        else if ((e.key === "c" || e.key === "C") && (e.ctrlKey || e.metaKey)) copy(real);
        else return false;
        return true;
      }}
      minWidth={1080}
    />
  );
}
