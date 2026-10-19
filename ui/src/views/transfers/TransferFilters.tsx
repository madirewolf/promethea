import { useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock,
  Folder,
  FolderInput,
  FolderX,
  Globe,
  Layers,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Tag,
  Trash,
  Zap,
  CircleSlash,
  Activity,
  ChevronUp,
} from "lucide-react";
import { api } from "../../api/client";
import { IconButton } from "../../components/ui/Button";
import { openContextMenu } from "../../components/ui/Menu";
import type { MenuEntry } from "../../components/ui/Menu";
import { attempt } from "../../lib/actions";
import { STATUS_FILTERS } from "../../lib/states";
import type { StatusFilter } from "../../lib/states";
import { openDialog, setFilter, toggleCollapsed, useStore } from "../../store/store";
import type { Filter } from "../../store/store";
import { useSidebarCounts } from "./filters";

const STATUS_ICONS: Record<StatusFilter, { icon: typeof ArrowDown; cls: string }> = {
  all: { icon: Layers, cls: "" },
  downloading: { icon: ArrowDown, cls: "ic-dl" },
  seeding: { icon: ArrowUp, cls: "ic-seed" },
  completed: { icon: CircleCheck, cls: "ic-done" },
  stopped: { icon: Pause, cls: "ic-stopped" },
  active: { icon: Zap, cls: "ic-active" },
  errored: { icon: CircleAlert, cls: "ic-error" },
  running: { icon: Play, cls: "ic-dl" },
  inactive: { icon: CircleSlash, cls: "ic-stopped" },
  stalled: { icon: Clock, cls: "ic-stopped" },
  checking: { icon: RefreshCw, cls: "ic-check" },
  moving: { icon: FolderInput, cls: "ic-moving" },
};

function ids(match: (t: { category: string; tags: string[]; trackerHosts: string[] }) => boolean): string[] {
  const all = useStore.getState().torrents;
  return Object.values(all)
    .filter(match)
    .map((t) => t.id);
}

function groupActions(match: Parameters<typeof ids>[0]): MenuEntry[] {
  return [
    { label: "Start torrents", icon: <Play />, onSelect: () => void attempt(() => api.action("start", ids(match))) },
    { label: "Stop torrents", icon: <Pause />, onSelect: () => void attempt(() => api.action("stop", ids(match))) },
    {
      label: "Remove torrents…",
      icon: <Trash />,
      danger: true,
      onSelect: () => {
        const list = ids(match);
        if (list.length) openDialog({ type: "delete", ids: list });
      },
    },
  ];
}

interface ItemProps {
  icon: ReactNode;
  label: string;
  count?: number;
  on: boolean;
  onClick: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  title?: string;
}

function Item({ icon, label, count, on, onClick, onContextMenu, title }: ItemProps) {
  return (
    <button
      type="button"
      className={`nav-item sm${on ? " on" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
    >
      {icon}
      <span className="nav-label">{label}</span>
      {count !== undefined && <span className="nav-count">{count.toLocaleString()}</span>}
    </button>
  );
}

function Section({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const collapsed = useStore((s) => !!s.collapsed[id]);
  return (
    <div className={`side-section${collapsed ? " collapsed" : ""}`}>
      <div className="side-head">
        <button type="button" className="side-title" onClick={() => toggleCollapsed(id)} aria-expanded={!collapsed}>
          {title}
          <ChevronDown />
        </button>
        {action}
      </div>
      {!collapsed && <div className="nav">{children}</div>}
    </div>
  );
}

export function TransferFilters() {
  const filter = useStore((s) => s.filter);
  const categories = useStore((s) => s.categories);
  const tags = useStore((s) => s.tags);
  const counts = useSidebarCounts();
  const [moreStatus, setMoreStatus] = useState(false);

  const set = (patch: Partial<Filter>) => setFilter(patch);
  const catNames = Object.keys(categories).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const tagNames = [...tags].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const trackerNames = Object.keys(counts.trackers).sort((a, b) => a.localeCompare(b));
  const secondaryOn = STATUS_FILTERS.some((f) => !f.primary && f.key === filter.status);

  return (
    <>
      <Section id="status" title="Status">
        {STATUS_FILTERS.filter((f) => f.primary || moreStatus || secondaryOn).map((f) => {
          const { icon: Icon, cls } = STATUS_ICONS[f.key];
          return (
            <Item
              key={f.key}
              icon={<Icon className={cls} />}
              label={f.label}
              count={counts.status[f.key]}
              on={filter.status === f.key}
              onClick={() => set({ status: f.key })}
            />
          );
        })}
        {!secondaryOn && (
          <button type="button" className="side-more" onClick={() => setMoreStatus((v) => !v)}>
            {moreStatus ? <ChevronUp /> : <ChevronDown />}
            {moreStatus ? "Fewer" : "More"}
          </button>
        )}
      </Section>

      <Section
        id="categories"
        title="Categories"
        action={
          <IconButton label="New category" size="xs" onClick={() => openDialog({ type: "category" })}>
            <Plus />
          </IconButton>
        }
      >
        <Item
          icon={<Layers />}
          label="All"
          count={Object.values(counts.categories).reduce((a, b) => a + b, counts.uncategorized)}
          on={filter.category === null}
          onClick={() => set({ category: null })}
        />
        <Item
          icon={<FolderX />}
          label="Uncategorized"
          count={counts.uncategorized}
          on={filter.category === ""}
          onClick={() => set({ category: "" })}
          onContextMenu={(e) => openContextMenu(e, groupActions((t) => !t.category))}
        />
        {catNames.map((name) => (
          <Item
            key={name}
            icon={<Folder />}
            label={name}
            count={counts.categories[name] ?? 0}
            on={filter.category === name}
            title={categories[name]?.resolvedPath}
            onClick={() => set({ category: name })}
            onContextMenu={(e) =>
              openContextMenu(e, [
                {
                  label: "Edit category…",
                  icon: <Pencil />,
                  onSelect: () => openDialog({ type: "category", name, savePath: categories[name]?.savePath ?? "" }),
                },
                {
                  label: "Remove category",
                  icon: <Trash />,
                  danger: true,
                  onSelect: () => {
                    void attempt(() => api.deleteCategories([name]));
                    if (useStore.getState().filter.category === name) set({ category: null });
                  },
                },
                { type: "separator" },
                ...groupActions((t) => t.category === name),
              ])
            }
          />
        ))}
      </Section>

      <Section
        id="tags"
        title="Tags"
        action={
          <IconButton label="New tag" size="xs" onClick={() => openDialog({ type: "newTag" })}>
            <Plus />
          </IconButton>
        }
      >
        <Item
          icon={<Layers />}
          label="All"
          on={filter.tag === null}
          onClick={() => set({ tag: null })}
        />
        <Item
          icon={<CircleSlash />}
          label="Untagged"
          count={counts.untagged}
          on={filter.tag === ""}
          onClick={() => set({ tag: "" })}
          onContextMenu={(e) => openContextMenu(e, groupActions((t) => t.tags.length === 0))}
        />
        {tagNames.map((name) => (
          <Item
            key={name}
            icon={<Tag />}
            label={name}
            count={counts.tags[name] ?? 0}
            on={filter.tag === name}
            onClick={() => set({ tag: name })}
            onContextMenu={(e) =>
              openContextMenu(e, [
                {
                  label: "Remove tag",
                  icon: <Trash />,
                  danger: true,
                  onSelect: () => {
                    void attempt(() => api.deleteTags([name]));
                    if (useStore.getState().filter.tag === name) set({ tag: null });
                  },
                },
                { type: "separator" },
                ...groupActions((t) => t.tags.includes(name)),
              ])
            }
          />
        ))}
      </Section>

      <Section id="trackers" title="Trackers">
        <Item icon={<Layers />} label="All" on={filter.tracker === null} onClick={() => set({ tracker: null })} />
        <Item
          icon={<Activity />}
          label="Trackerless"
          count={counts.trackerless}
          on={filter.tracker === ""}
          onClick={() => set({ tracker: "" })}
        />
        {trackerNames.map((host) => (
          <Item
            key={host}
            icon={<Globe />}
            label={host}
            count={counts.trackers[host]}
            on={filter.tracker === host}
            onClick={() => set({ tracker: host })}
            onContextMenu={(e) => openContextMenu(e, groupActions((t) => t.trackerHosts.includes(host)))}
          />
        ))}
      </Section>
    </>
  );
}
