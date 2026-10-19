import type { Torrent, TorrentState } from "../api/types";

/** Colour family used for icons, progress bars and badges. */
export type StateKind = "dl" | "seed" | "done" | "stopped" | "queued" | "check" | "error" | "meta" | "moving" | "stalled";

interface StateInfo {
  label: string;
  kind: StateKind;
}

const STATES: Record<TorrentState, StateInfo> = {
  downloading: { label: "Downloading", kind: "dl" },
  forcedDL: { label: "Downloading", kind: "dl" },
  metaDL: { label: "Fetching metadata", kind: "meta" },
  forcedMetaDL: { label: "Fetching metadata", kind: "meta" },
  stalledDL: { label: "Stalled", kind: "stalled" },
  queuedDL: { label: "Queued", kind: "queued" },
  stoppedDL: { label: "Stopped", kind: "stopped" },
  checkingDL: { label: "Checking", kind: "check" },
  uploading: { label: "Seeding", kind: "seed" },
  forcedUP: { label: "Seeding", kind: "seed" },
  stalledUP: { label: "Seeding", kind: "seed" },
  queuedUP: { label: "Queued", kind: "queued" },
  stoppedUP: { label: "Completed", kind: "done" },
  checkingUP: { label: "Checking", kind: "check" },
  checkingResumeData: { label: "Loading", kind: "check" },
  moving: { label: "Moving", kind: "moving" },
  missingFiles: { label: "Missing files", kind: "error" },
  error: { label: "Error", kind: "error" },
  allocating: { label: "Allocating", kind: "check" },
  unknown: { label: "Unknown", kind: "stopped" },
};

export function stateInfo(state: TorrentState): StateInfo {
  return STATES[state] ?? STATES.unknown;
}

export function isForced(t: Torrent): boolean {
  return t.state === "forcedDL" || t.state === "forcedUP" || t.state === "forcedMetaDL";
}

export function isStopped(t: Torrent): boolean {
  return t.state === "stoppedDL" || t.state === "stoppedUP";
}

export function isDownloading(t: Torrent): boolean {
  switch (t.state) {
    case "downloading":
    case "metaDL":
    case "forcedMetaDL":
    case "forcedDL":
    case "stalledDL":
    case "queuedDL":
    case "stoppedDL":
    case "checkingDL":
      return true;
    default:
      return false;
  }
}

export function isSeeding(t: Torrent): boolean {
  switch (t.state) {
    case "uploading":
    case "forcedUP":
    case "stalledUP":
    case "queuedUP":
    case "checkingUP":
      return true;
    default:
      return false;
  }
}

export function isCompleted(t: Torrent): boolean {
  return isSeeding(t) || t.state === "stoppedUP";
}

export function isChecking(t: Torrent): boolean {
  return t.state === "checkingDL" || t.state === "checkingUP" || t.state === "checkingResumeData";
}

export function isErrored(t: Torrent): boolean {
  return t.state === "error" || t.state === "missingFiles";
}

export function isActive(t: Torrent): boolean {
  return t.dlSpeed > 0 || t.upSpeed > 0 || t.state === "moving" || isChecking(t);
}

export type StatusFilter =
  | "all"
  | "downloading"
  | "seeding"
  | "completed"
  | "running"
  | "stopped"
  | "active"
  | "inactive"
  | "stalled"
  | "checking"
  | "moving"
  | "errored";

export const STATUS_FILTERS: { key: StatusFilter; label: string; primary: boolean }[] = [
  { key: "all", label: "All", primary: true },
  { key: "downloading", label: "Downloading", primary: true },
  { key: "seeding", label: "Seeding", primary: true },
  { key: "completed", label: "Completed", primary: true },
  { key: "stopped", label: "Stopped", primary: true },
  { key: "active", label: "Active", primary: true },
  { key: "errored", label: "Errored", primary: true },
  { key: "running", label: "Running", primary: false },
  { key: "inactive", label: "Inactive", primary: false },
  { key: "stalled", label: "Stalled", primary: false },
  { key: "checking", label: "Checking", primary: false },
  { key: "moving", label: "Moving", primary: false },
];

export function matchesStatus(t: Torrent, f: StatusFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "downloading":
      return isDownloading(t);
    case "seeding":
      return isSeeding(t);
    case "completed":
      return isCompleted(t);
    case "running":
      return !isStopped(t);
    case "stopped":
      return isStopped(t);
    case "active":
      return isActive(t);
    case "inactive":
      return !isActive(t);
    case "stalled":
      return t.state === "stalledDL" || t.state === "stalledUP";
    case "checking":
      return isChecking(t);
    case "moving":
      return t.state === "moving";
    case "errored":
      return isErrored(t);
  }
}
