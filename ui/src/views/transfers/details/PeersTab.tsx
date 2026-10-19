import { useMemo, useState } from "react";
import { Ban, Copy, UserPlus, Users } from "lucide-react";
import { api } from "../../../api/client";
import type { Peer } from "../../../api/types";
import type { MenuEntry } from "../../../components/ui/Menu";
import { Empty, Progress } from "../../../components/ui/Misc";
import * as A from "../../../lib/actions";
import { formatBytes, formatPercent, formatSpeed, plural } from "../../../lib/format";
import { openDialog, toast } from "../../../store/store";
import { DetailTable, nextSort } from "./DetailTable";
import type { DtColumn, DtSort } from "./DetailTable";
import { TabError, TabLoading, useRefreshMs, useTorrentPoll } from "./shared";

// ------------------------------------------------------------------ flags
const FLAG_INFO: [string, string][] = [
  ["D", "Downloading from the peer"],
  ["d", "We want to download, but the peer is choking us"],
  ["U", "Uploading to the peer"],
  ["u", "The peer wants data, but we're choking it"],
  ["K", "The peer is unchoking us, but we're not interested"],
  ["?", "We unchoked the peer, but it isn't interested"],
  ["O", "Optimistic unchoke"],
  ["S", "The peer snubbed us"],
  ["I", "Incoming connection"],
  ["E", "Encrypted traffic (RC4)"],
  ["e", "Encrypted handshake"],
  ["P", "µTP connection"],
  ["X", "Found through peer exchange (PeX)"],
  ["H", "Found through DHT"],
  ["L", "Found through local peer discovery"],
  ["h", "Hole-punched connection"],
];
const FLAG_TEXT = new Map(FLAG_INFO);
const LEGEND = FLAG_INFO.map(([f, t]) => `${f}  ${t}`).join("\n");

function flagTip(flags: string): string | undefined {
  const parts = flags.split(" ").filter(Boolean);
  if (!parts.length) return undefined;
  return parts.map((f) => `${f}  ${FLAG_TEXT.get(f) ?? f}`).join("\n");
}

// ------------------------------------------------------------------ add peers
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/;
const IPV6 = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i;

function peerError(s: string): string | null {
  const v4 = IPV4.exec(s);
  const v6 = v4 ? null : IPV6.exec(s);
  const m = v4 ?? v6;
  const port = m ? Number(m[m.length - 1]) : NaN;
  const okAddress = v4 ? v4.slice(1, 5).every((o) => Number(o) <= 255) : !!v6 && v6[1].includes(":");
  if (!okAddress || !(port >= 1 && port <= 65535)) return `Not an address and port: ${s}`;
  return null;
}

/** Ask for peers ("1.2.3.4:6881", "[2001:db8::1]:6881") and connect the torrents to them. */
export function promptAddPeers(ids: string[], done?: () => void): void {
  const parse = (v: string) => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  openDialog({
    type: "prompt",
    title: ids.length > 1 ? `Add peers to ${ids.length} torrents` : "Add peers",
    label: "Peers",
    multiline: true,
    mono: true,
    placeholder: "192.0.2.10:6881\n[2001:db8::1]:51413",
    hint: "One IP:port per line. IPv6 addresses go in brackets.",
    confirmLabel: "Add peers",
    validate: (v: string) => {
      const peers = parse(v);
      if (!peers.length) return "Enter at least one peer";
      for (const p of peers) {
        const err = peerError(p);
        if (err) return err;
      }
      return null;
    },
    onSubmit: async (v: string) => {
      const peers = parse(v);
      let added = 0;
      for (const id of ids) added += (await api.addPeers(id, peers)).added;
      if (added) toast("success", `Connecting to ${plural(added, "peer")}`);
      else toast("warning", "None of those peers could be added");
      done?.();
    },
  });
}

function confirmBan(peers: Peer[], done: () => void): void {
  const ips = [...new Set(peers.map((p) => p.ip))];
  openDialog({
    type: "confirm",
    title: ips.length > 1 ? `Ban ${ips.length} peers?` : "Ban this peer?",
    message: (
      <>
        Promethea will disconnect {ips.length > 1 ? "these addresses" : <b className="mono">{ips[0]}</b>} and refuse
        connections from {ips.length > 1 ? "them" : "it"} in every torrent. You can lift the ban in Settings ›
        Connection.
      </>
    ),
    confirmLabel: "Ban",
    danger: true,
    onConfirm: () =>
      void A.attempt(() => api.banPeers(ips), "Couldn't ban").then((r) => {
        if (r) toast("success", ips.length > 1 ? `Banned ${ips.length} peers` : `Banned ${ips[0]}`);
        done();
      }),
  });
}

// ------------------------------------------------------------------ table
const COLUMNS: DtColumn<Peer>[] = [
  {
    key: "ip",
    label: "Peer",
    sortable: true,
    cell: (p) => (
      <span className="cell-flex">
        <span className="cell-text mono-num">{p.id}</span>
        <span className="peer-conn">{p.connection}</span>
      </span>
    ),
  },
  { key: "client", label: "Client", width: 180, sortable: true, cell: (p) => p.client || "–", cellTip: (p) => p.client || undefined },
  { key: "flags", label: "Flags", width: 96, sortable: true, tip: LEGEND, cell: (p) => <span className="mono">{p.flags}</span>, cellTip: (p) => flagTip(p.flags) },
  {
    key: "progress",
    label: "Progress",
    width: 140,
    sortable: true,
    cell: (p) => (
      <div className="progress-cell">
        <Progress value={p.progress} />
        <span>{formatPercent(p.progress)}</span>
      </div>
    ),
  },
  { key: "dlSpeed", label: "Down", width: 96, right: true, sortable: true, cell: (p) => formatSpeed(p.dlSpeed) },
  { key: "upSpeed", label: "Up", width: 96, right: true, sortable: true, cell: (p) => formatSpeed(p.upSpeed) },
  { key: "downloaded", label: "Downloaded", width: 100, right: true, sortable: true, cell: (p) => formatBytes(p.downloaded) },
  { key: "uploaded", label: "Uploaded", width: 100, right: true, sortable: true, cell: (p) => formatBytes(p.uploaded) },
];

const TEXT_KEYS = ["ip", "client", "flags"] as const;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compare(a: Peer, b: Peer, key: string): number {
  switch (key) {
    case "ip":
      return collator.compare(a.ip, b.ip) || a.port - b.port;
    case "client":
      return collator.compare(a.client, b.client);
    case "flags":
      return collator.compare(a.flags, b.flags);
    default:
      return ((a as unknown as Record<string, number>)[key] ?? 0) - ((b as unknown as Record<string, number>)[key] ?? 0);
  }
}

export function PeersTab({ id, nonce }: { id: string; nonce: number }) {
  const ms = useRefreshMs();
  const { data, error, refresh } = useTorrentPoll<Peer[]>(id, api.peers, ms, nonce);
  const [sort, setSort] = useState<DtSort>({ key: "dlSpeed", dir: -1 });

  const rows = useMemo(() => {
    if (!data) return [];
    // Ties fall back to the address so rows don't shuffle between refreshes.
    return [...data].sort((a, b) => sort.dir * compare(a, b, sort.key) || compare(a, b, "ip"));
  }, [data, sort]);

  if (!data) return error ? <TabError message={error} /> : <TabLoading />;

  const copy = (ps: Peer[]) => void A.copyText(ps.map((p) => p.id).join("\n"), ps.length > 1 ? "Peer addresses" : "Peer address");
  const menu = (sel: Peer[]): MenuEntry[] => [
    { label: "Add peers…", icon: <UserPlus />, onSelect: () => promptAddPeers([id], refresh) },
    { type: "separator" },
    sel.length > 0 && { label: sel.length > 1 ? "Copy addresses" : "Copy IP:port", icon: <Copy />, hint: "Ctrl+C", onSelect: () => copy(sel) },
    sel.length > 0 && {
      label: sel.length > 1 ? `Ban ${sel.length} peers…` : "Ban peer…",
      icon: <Ban />,
      danger: true,
      onSelect: () => confirmBan(sel, refresh),
    },
  ];

  return (
    <DetailTable
      label="Peers"
      rows={rows}
      rowKey={(p) => p.id}
      columns={COLUMNS}
      sort={sort}
      onSort={(key) => setSort((s) => nextSort(s, key, TEXT_KEYS))}
      menu={menu}
      onKey={(e, sel) => {
        if ((e.key === "c" || e.key === "C") && (e.ctrlKey || e.metaKey) && sel.length) {
          copy(sel);
          return true;
        }
        return false;
      }}
      empty={
        <Empty icon={<Users />} title="No peers connected">
          Peers show up here once Promethea connects to the swarm.
        </Empty>
      }
      minWidth={900}
    />
  );
}
