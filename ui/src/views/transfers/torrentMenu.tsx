import {
  ArrowDownToLine,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Copy,
  Download,
  FastForward,
  FolderInput,
  FolderOpen,
  Gauge,
  ListOrdered,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  SquarePen,
  Tag,
  Trash,
  Users,
  X,
  Folder,
  ExternalLink,
} from "lucide-react";
import type { Torrent } from "../../api/types";
import * as A from "../../lib/actions";
import { isSeeding, isStopped } from "../../lib/states";
import { openDialog, useStore } from "../../store/store";
import type { MenuEntry } from "../../components/ui/Menu";
import { promptAddPeers } from "./details/PeersTab";

/** The torrent context menu (also used by the toolbar's "More" button). */
export function torrentMenu(ids: string[]): MenuEntry[] {
  const st = useStore.getState();
  const ts = ids.map((id) => st.torrents[id]).filter(Boolean) as Torrent[];
  if (!ts.length) return [];
  const one = ts.length === 1 ? ts[0] : null;
  const desktop = !!st.app?.desktop;
  const allStopped = ts.every(isStopped);
  const anyStopped = ts.some(isStopped);
  const all = (f: (t: Torrent) => boolean) => ts.every(f);
  const categories = Object.keys(st.categories).sort((a, b) => a.localeCompare(b));
  const tags = [...st.tags].sort((a, b) => a.localeCompare(b));

  return [
    anyStopped && { label: "Start", icon: <Play />, onSelect: () => A.start(ids) },
    !allStopped && { label: "Stop", icon: <Pause />, onSelect: () => A.stop(ids) },
    { label: "Force start", icon: <FastForward />, onSelect: () => A.forceStart(ids) },
    { label: "Remove…", icon: <Trash />, danger: true, hint: "Del", onSelect: () => A.requestDelete(ids) },
    { type: "separator" },
    desktop && one && { label: "Open", icon: <ExternalLink />, onSelect: () => A.openContent(one.id) },
    desktop && one && { label: "Open containing folder", icon: <FolderOpen />, onSelect: () => A.revealContent(one.id) },
    desktop && one && { type: "separator" },
    { label: "Set location…", icon: <FolderInput />, onSelect: () => openDialog({ type: "location", ids }) },
    one && { label: "Rename…", icon: <Pencil />, hint: "F2", onSelect: () => openDialog({ type: "rename", id: one.id }) },
    {
      label: "Category",
      icon: <Folder />,
      items: () => [
        { label: "New category…", icon: <Plus />, onSelect: () => openDialog({ type: "category", assignTo: ids }) },
        { label: "Remove category", icon: <X />, disabled: all((t) => !t.category), onSelect: () => A.setCategory(ids, "") },
        categories.length > 0 && { type: "separator" },
        ...categories.map((c) => ({
          label: c,
          checked: all((t) => t.category === c),
          onSelect: () => A.setCategory(ids, c),
        })),
      ],
    },
    {
      label: "Tags",
      icon: <Tag />,
      items: () => {
        const cur = useStore.getState().torrents;
        const live = ids.map((id) => cur[id]).filter(Boolean) as Torrent[];
        return [
          { label: "New tag…", icon: <Plus />, onSelect: () => openDialog({ type: "newTag", assignTo: ids }) },
          {
            label: "Remove all tags",
            icon: <X />,
            disabled: live.every((t) => !t.tags.length),
            onSelect: () => A.setTags(ids, [], "set"),
          },
          tags.length > 0 && { type: "separator" },
          ...tags.map((tag) => {
            const on = live.every((t) => t.tags.includes(tag));
            return {
              label: tag,
              checked: on,
              keepOpen: false,
              onSelect: () => A.setTags(ids, [tag], on ? "remove" : "add"),
            };
          }),
        ];
      },
    },
    { label: "Limits & sharing…", icon: <Gauge />, onSelect: () => openDialog({ type: "options", ids }) },
    { type: "separator" },
    {
      label: "Queue",
      icon: <ListOrdered />,
      items: [
        { label: "Move to top", icon: <ChevronsUp />, onSelect: () => A.act("queueTop", ids) },
        { label: "Move up", icon: <ChevronUp />, onSelect: () => A.act("queueUp", ids) },
        { label: "Move down", icon: <ChevronDown />, onSelect: () => A.act("queueDown", ids) },
        { label: "Move to bottom", icon: <ChevronsDown />, onSelect: () => A.act("queueBottom", ids) },
      ],
    },
    {
      label: "Download options",
      icon: <Download />,
      items: [
        {
          label: "Sequential download",
          checked: all((t) => t.seqDl),
          onSelect: () => A.setFlag("sequential", ids, !all((t) => t.seqDl)),
        },
        {
          label: "First & last pieces first",
          checked: all((t) => t.firstLast),
          onSelect: () => A.setFlag("firstLast", ids, !all((t) => t.firstLast)),
        },
        {
          label: "Automatic management",
          checked: all((t) => t.autoTMM),
          onSelect: () => A.setFlag("autoTMM", ids, !all((t) => t.autoTMM)),
        },
        ts.some(isSeeding) && {
          label: "Super seeding",
          checked: all((t) => t.superSeeding),
          onSelect: () => A.setFlag("superSeeding", ids, !all((t) => t.superSeeding)),
        },
      ],
    },
    { label: "Force recheck", icon: <RefreshCw />, onSelect: () => A.recheck(ids) },
    { label: "Force reannounce", icon: <Radio />, onSelect: () => A.reannounce(ids) },
    { type: "separator" },
    {
      label: "Copy",
      icon: <Copy />,
      items: [
        { label: "Name", onSelect: () => void A.copyField(ids, "name") },
        { label: "Magnet link", onSelect: () => void A.copyField(ids, "magnet") },
        { label: "Info hash", onSelect: () => void A.copyField(ids, "infohashV1") },
        { label: "Info hash v2", onSelect: () => void A.copyField(ids, "infohashV2") },
        { label: "Torrent ID", onSelect: () => void A.copyField(ids, "id") },
        { label: "Save path", onSelect: () => void A.copyField(ids, "savePath") },
      ],
    },
    {
      label: ids.length > 1 ? "Export .torrent files" : "Export .torrent",
      icon: <ArrowDownToLine />,
      disabled: ts.every((t) => !t.hasMetadata),
      onSelect: () => void A.exportTorrents(ids.filter((id) => st.torrents[id]?.hasMetadata)),
    },
    { type: "separator" },
    one && {
      label: "Edit trackers…",
      icon: <SquarePen />,
      onSelect: () => useStore.setState({ detailsOpen: true, detailsTab: "trackers" }),
    },
    {
      label: "Add peers…",
      icon: <Users />,
      onSelect: () => promptAddPeers(ids),
    },
  ];
}
