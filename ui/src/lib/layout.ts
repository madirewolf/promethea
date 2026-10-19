// What the sidebar and the details panel show. Simple and Detailed are starting points; hiding or
// showing single items (right-click a sidebar heading or a details tab) makes a layout of your own.

import type { StatusFilter } from "./states";
import { STATUS_FILTERS } from "./states";

export type SideSection = "categories" | "tags" | "trackers";
export type DetailsTab = "general" | "files" | "trackers" | "peers" | "webseeds" | "speed";
export type LayoutName = "simple" | "detailed";

export interface Layout {
  /** Status filters besides All, which always shows. */
  status: StatusFilter[];
  /** Sidebar sections besides Status, which always shows. */
  sections: SideSection[];
  tabs: DetailsTab[];
  /** The General tab lists everything (pieces, hashes, limits...), not just the essentials. */
  everyDetail: boolean;
}

export const SIDE_SECTIONS: { key: SideSection; label: string }[] = [
  { key: "categories", label: "Categories" },
  { key: "tags", label: "Tags" },
  { key: "trackers", label: "Trackers" },
];

export const DETAILS_TABS: { key: DetailsTab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "files", label: "Files" },
  { key: "trackers", label: "Trackers" },
  { key: "peers", label: "Peers" },
  { key: "webseeds", label: "HTTP sources" },
  { key: "speed", label: "Speed" },
];

export const LAYOUTS: Record<LayoutName, Layout> = {
  simple: {
    status: ["running", "stopped"],
    sections: ["categories"],
    tabs: ["general", "files"],
    everyDetail: false,
  },
  detailed: {
    status: ["downloading", "seeding", "completed", "stopped", "active", "errored"],
    sections: ["categories", "tags", "trackers"],
    tabs: ["general", "files", "trackers", "peers", "webseeds", "speed"],
    everyDetail: true,
  },
};

/** Which preset a layout is, or null for one of your own. */
export function layoutName(l: Layout): LayoutName | null {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  for (const name of ["simple", "detailed"] as const) {
    const p = LAYOUTS[name];
    if (same(l.status, p.status) && same(l.sections, p.sections) && same(l.tabs, p.tabs) && l.everyDetail === p.everyDetail)
      return name;
  }
  return null;
}

/** A saved layout, cleaned of anything this version doesn't know. */
export function readLayout(saved: unknown): Layout {
  const s = (saved ?? {}) as Partial<Layout>;
  const keep = <T extends string>(v: unknown, known: readonly T[], fallback: T[]): T[] =>
    Array.isArray(v) ? known.filter((k) => v.includes(k)) : fallback;
  const base = LAYOUTS.simple;
  const tabs = keep(s.tabs, DETAILS_TABS.map((t) => t.key), base.tabs);
  return {
    status: keep(s.status, STATUS_FILTERS.map((f) => f.key).filter((k) => k !== "all"), base.status),
    sections: keep(s.sections, SIDE_SECTIONS.map((x) => x.key), base.sections),
    tabs: tabs.length ? tabs : base.tabs,
    everyDetail: typeof s.everyDetail === "boolean" ? s.everyDetail : base.everyDetail,
  };
}
