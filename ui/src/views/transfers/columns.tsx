import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  Clock,
  FolderInput,
  Magnet,
  Pause,
  RefreshCw,
} from "lucide-react";
import type { Torrent } from "../../api/types";
import {
  formatAgo,
  formatBytes,
  formatDuration,
  formatEta,
  formatLimit,
  formatPercent,
  formatRatio,
  formatShortDate,
  formatSpeed,
  hostOf,
  INFINITY_ETA,
} from "../../lib/format";
import { isCompleted, isStopped, stateInfo } from "../../lib/states";
import type { StateKind } from "../../lib/states";

export interface ColumnDef {
  key: string;
  label: string;
  /** Header text when the column is narrow (defaults to label). */
  width: number;
  min?: number;
  align?: "right" | "center";
  /** Hidden unless the user turns it on. */
  hidden?: boolean;
  sortValue?: (t: Torrent) => number | string;
  cell: (t: Torrent) => ReactNode;
  /** Tooltip for the cell contents. */
  tip?: (t: Torrent) => string | undefined;
}

const STATE_ICONS: Record<StateKind, typeof ArrowDown> = {
  dl: ArrowDown,
  seed: ArrowUp,
  done: Check,
  stopped: Pause,
  queued: Clock,
  check: RefreshCw,
  error: CircleAlert,
  meta: Magnet,
  moving: FolderInput,
  stalled: ArrowDown,
};

const STATE_RANK: Record<StateKind, number> = {
  dl: 0,
  meta: 1,
  stalled: 2,
  check: 3,
  moving: 4,
  seed: 5,
  queued: 6,
  stopped: 7,
  done: 8,
  error: 9,
};

export function StateIcon({ t }: { t: Torrent }) {
  const kind = stateInfo(t.state).kind;
  const Icon = STATE_ICONS[kind];
  return (
    <span className="state-ic">
      <Icon />
    </span>
  );
}

const num = (n: number) => (n > 0 ? n.toLocaleString() : "");
const bytes = (n: number) => (n > 0 ? formatBytes(n) : "");
const limit = (n: number) => (n > 0 ? formatLimit(n) : "∞");

function peersCell(n: number, total: number): ReactNode {
  if (n <= 0 && total <= 0) return "";
  return (
    <>
      {n}
      <span className="faint"> ({Math.max(total, 0)})</span>
    </>
  );
}

function limitText(v: number, unit: string): string {
  if (v === -2) return "Global";
  if (v < 0) return "None";
  return unit === "ratio" ? v.toFixed(2) : formatDuration(v * 60);
}

export const COLUMNS: ColumnDef[] = [
  {
    key: "queue",
    label: "#",
    width: 48,
    min: 36,
    align: "right",
    hidden: true,
    sortValue: (t) => (t.queue < 0 ? Number.MAX_SAFE_INTEGER : t.queue),
    cell: (t) => (t.queue >= 0 ? t.queue + 1 : <span className="faint">*</span>),
  },
  {
    key: "name",
    label: "Name",
    width: 320,
    min: 140,
    sortValue: (t) => t.name,
    cell: (t) => (
      <div className="name-cell">
        <StateIcon t={t} />
        <span className="name-text">{t.name}</span>
      </div>
    ),
    tip: (t) => t.name,
  },
  {
    key: "size",
    label: "Size",
    width: 84,
    min: 60,
    align: "right",
    cell: (t) => (t.hasMetadata ? formatBytes(t.size) : ""),
  },
  {
    key: "totalSize",
    label: "Total size",
    width: 92,
    min: 60,
    align: "right",
    hidden: true,
    cell: (t) => (t.hasMetadata ? formatBytes(t.totalSize) : ""),
  },
  {
    key: "progress",
    label: "Progress",
    width: 136,
    min: 80,
    cell: (t) => (
      <div className="progress-cell">
        <div className="progress">
          <i style={{ width: `${Math.min(1, Math.max(0, t.progress)) * 100}%` }} />
        </div>
        <span>{formatPercent(t.progress)}</span>
      </div>
    ),
  },
  {
    key: "state",
    label: "Status",
    width: 140,
    min: 80,
    sortValue: (t) => STATE_RANK[stateInfo(t.state).kind] * 100 + (t.dlSpeed > 0 ? 0 : 1),
    cell: (t) => (
      <span className="status-cell">
        <span className="dot" />
        {stateInfo(t.state).label}
      </span>
    ),
    tip: (t) => t.error || undefined,
  },
  {
    key: "seeds",
    label: "Seeds",
    width: 70,
    min: 50,
    align: "right",
    sortValue: (t) => t.seeds * 1e6 + Math.max(0, t.seedsTotal),
    cell: (t) => peersCell(t.seeds, t.seedsTotal),
  },
  {
    key: "peers",
    label: "Peers",
    width: 70,
    min: 50,
    align: "right",
    sortValue: (t) => t.peers * 1e6 + Math.max(0, t.peersTotal),
    cell: (t) => peersCell(t.peers, t.peersTotal),
  },
  {
    key: "dlSpeed",
    label: "Down",
    width: 90,
    min: 60,
    align: "right",
    cell: (t) => <span className="speed-dl">{formatSpeed(t.dlSpeed)}</span>,
  },
  {
    key: "upSpeed",
    label: "Up",
    width: 90,
    min: 60,
    align: "right",
    cell: (t) => <span className="speed-ul">{formatSpeed(t.upSpeed)}</span>,
  },
  {
    key: "eta",
    label: "ETA",
    width: 72,
    min: 50,
    align: "right",
    sortValue: (t) => (isCompleted(t) || isStopped(t) || t.eta < 0 ? INFINITY_ETA + 1 : t.eta),
    cell: (t) => (isCompleted(t) || isStopped(t) || t.eta >= INFINITY_ETA || t.eta < 0 ? "" : formatEta(t.eta)),
  },
  {
    key: "ratio",
    label: "Ratio",
    width: 64,
    min: 48,
    align: "right",
    cell: (t) => formatRatio(t.ratio),
  },
  {
    key: "category",
    label: "Category",
    width: 110,
    min: 60,
    hidden: true,
    cell: (t) => t.category,
  },
  {
    key: "tags",
    label: "Tags",
    width: 120,
    min: 60,
    hidden: true,
    sortValue: (t) => t.tags.join(", "),
    cell: (t) => t.tags.join(", "),
  },
  {
    key: "addedOn",
    label: "Added",
    width: 128,
    min: 70,
    align: "right",
    hidden: true,
    cell: (t) => formatShortDate(t.addedOn),
  },
  {
    key: "completedOn",
    label: "Completed on",
    width: 128,
    min: 70,
    align: "right",
    hidden: true,
    cell: (t) => formatShortDate(t.completedOn),
  },
  {
    key: "tracker",
    label: "Tracker",
    width: 150,
    min: 70,
    hidden: true,
    sortValue: (t) => hostOf(t.tracker),
    cell: (t) => hostOf(t.tracker),
    tip: (t) => t.tracker || undefined,
  },
  {
    key: "dlLimit",
    label: "Down limit",
    width: 92,
    min: 60,
    align: "right",
    hidden: true,
    sortValue: (t) => (t.dlLimit > 0 ? t.dlLimit : Number.MAX_SAFE_INTEGER),
    cell: (t) => limit(t.dlLimit),
  },
  {
    key: "upLimit",
    label: "Up limit",
    width: 92,
    min: 60,
    align: "right",
    hidden: true,
    sortValue: (t) => (t.upLimit > 0 ? t.upLimit : Number.MAX_SAFE_INTEGER),
    cell: (t) => limit(t.upLimit),
  },
  { key: "downloaded", label: "Downloaded", width: 96, min: 60, align: "right", hidden: true, cell: (t) => bytes(t.downloaded) },
  { key: "uploaded", label: "Uploaded", width: 96, min: 60, align: "right", hidden: true, cell: (t) => bytes(t.uploaded) },
  { key: "dlSession", label: "Session down", width: 104, min: 60, align: "right", hidden: true, cell: (t) => bytes(t.dlSession) },
  { key: "upSession", label: "Session up", width: 104, min: 60, align: "right", hidden: true, cell: (t) => bytes(t.upSession) },
  {
    key: "remaining",
    label: "Remaining",
    width: 96,
    min: 60,
    align: "right",
    hidden: true,
    cell: (t) => (t.hasMetadata && t.remaining > 0 ? formatBytes(t.remaining) : ""),
  },
  {
    key: "completed",
    label: "Completed",
    width: 96,
    min: 60,
    align: "right",
    hidden: true,
    cell: (t) => bytes(t.completed),
  },
  {
    key: "timeActive",
    label: "Time active",
    width: 96,
    min: 60,
    align: "right",
    hidden: true,
    cell: (t) => (t.timeActive > 0 ? formatDuration(t.timeActive) : ""),
  },
  {
    key: "seedingTime",
    label: "Seeding time",
    width: 96,
    min: 60,
    align: "right",
    hidden: true,
    cell: (t) => (t.seedingTime > 0 ? formatDuration(t.seedingTime) : ""),
  },
  {
    key: "savePath",
    label: "Save path",
    width: 220,
    min: 80,
    hidden: true,
    cell: (t) => t.savePath,
    tip: (t) => t.savePath,
  },
  {
    key: "effectiveRatioLimit",
    label: "Ratio limit",
    width: 84,
    min: 50,
    align: "right",
    hidden: true,
    sortValue: (t) => (t.effectiveRatioLimit < 0 ? Number.MAX_SAFE_INTEGER : t.effectiveRatioLimit),
    cell: (t) => (t.effectiveRatioLimit < 0 ? "∞" : t.effectiveRatioLimit.toFixed(2)),
    tip: (t) => `Ratio limit: ${limitText(t.ratioLimit, "ratio")}`,
  },
  {
    key: "seenComplete",
    label: "Last seen complete",
    width: 128,
    min: 70,
    align: "right",
    hidden: true,
    cell: (t) => formatShortDate(t.seenComplete),
  },
  {
    key: "lastActivity",
    label: "Last activity",
    width: 104,
    min: 60,
    align: "right",
    hidden: true,
    cell: (t) => (t.lastActivity > 0 ? formatAgo(t.lastActivity) : ""),
  },
  {
    key: "availability",
    label: "Availability",
    width: 88,
    min: 50,
    align: "right",
    hidden: true,
    cell: (t) => (t.availability >= 0 && t.hasMetadata ? t.availability.toFixed(2) : ""),
  },
  {
    key: "connections",
    label: "Connections",
    width: 88,
    min: 50,
    align: "right",
    hidden: true,
    cell: (t) => num(t.connections),
  },
  {
    key: "id",
    label: "Info hash",
    width: 300,
    min: 80,
    hidden: true,
    cell: (t) => <span className="mono">{t.id}</span>,
  },
];

export const COLUMN_MAP: Record<string, ColumnDef> = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));

export const DEFAULT_ORDER = COLUMNS.map((c) => c.key);
export const DEFAULT_HIDDEN = COLUMNS.filter((c) => c.hidden).map((c) => c.key);
