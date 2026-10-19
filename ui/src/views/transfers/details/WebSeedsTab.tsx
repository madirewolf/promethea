import { Copy, Globe, Pencil, Plus, Trash } from "lucide-react";
import { api } from "../../../api/client";
import type { MenuEntry } from "../../../components/ui/Menu";
import { Button } from "../../../components/ui/Button";
import { Empty } from "../../../components/ui/Misc";
import * as A from "../../../lib/actions";
import { openDialog } from "../../../store/store";
import { DetailTable } from "./DetailTable";
import type { DtColumn } from "./DetailTable";
import { TabError, TabLoading, useRefreshMs, useTorrentPoll } from "./shared";

const WEB_SEED_RE = /^https?:\/\/\S+$/i;

const lines = (v: string) => v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Ask for web seed URLs (BEP 19) and add them to a torrent. */
export function promptAddWebSeeds(id: string, done?: () => void): void {
  openDialog({
    type: "prompt",
    title: "Add HTTP sources",
    label: "URLs",
    multiline: true,
    mono: true,
    placeholder: "https://mirror.example.org/files/",
    hint: "One per line. Promethea downloads pieces from these web servers alongside peers.",
    confirmLabel: "Add",
    validate: (v: string) => {
      const urls = lines(v);
      if (!urls.length) return "Enter at least one URL";
      const bad = urls.find((u) => !WEB_SEED_RE.test(u));
      return bad ? `Not an http(s) URL: ${bad}` : null;
    },
    onSubmit: async (v: string) => {
      await api.editWebSeeds(id, { add: lines(v) });
      done?.();
    },
  });
}

const COLUMNS: DtColumn<string>[] = [
  {
    key: "url",
    label: "URL",
    cell: (u) => (
      <span className="cell-flex">
        <Globe className="cell-ic" />
        <span className="cell-text">{u}</span>
      </span>
    ),
    cellTip: (u) => u,
  },
];

export function WebSeedsTab({ id, nonce }: { id: string; nonce: number }) {
  const base = useRefreshMs();
  const { data, error, refresh } = useTorrentPoll<string[]>(id, api.webSeeds, Math.max(3000, base), nonce);

  if (!data) return error ? <TabError message={error} /> : <TabLoading />;

  const change = (c: { add?: string[]; remove?: string[] }, what: string) =>
    void A.attempt(() => api.editWebSeeds(id, c), what).then(refresh);
  const remove = (urls: string[]) => change({ remove: urls }, "Couldn't remove");
  const copy = (urls: string[]) => void A.copyText(urls.join("\n"), urls.length > 1 ? "URLs" : "URL");
  const edit = (url: string) =>
    openDialog({
      type: "prompt",
      title: "Edit HTTP source",
      label: "URL",
      value: url,
      mono: true,
      size: "md",
      confirmLabel: "Save",
      validate: (v: string) => {
        const next = v.trim();
        if (!WEB_SEED_RE.test(next)) return "Enter an http or https URL";
        return next !== url && data.includes(next) ? "That URL is already in the list" : null;
      },
      onSubmit: async (v: string) => {
        const next = v.trim();
        if (next === url) return;
        await api.editWebSeeds(id, { remove: [url], add: [next] });
        refresh();
      },
    });

  const menu = (sel: string[]): MenuEntry[] => [
    { label: "Add HTTP sources…", icon: <Plus />, onSelect: () => promptAddWebSeeds(id, refresh) },
    sel.length === 1 && { label: "Edit URL…", icon: <Pencil />, hint: "F2", onSelect: () => edit(sel[0]) },
    sel.length > 0 && { label: sel.length > 1 ? `Remove ${sel.length} sources` : "Remove", icon: <Trash />, hint: "Del", danger: true, onSelect: () => remove(sel) },
    { type: "separator" },
    sel.length > 0 && { label: sel.length > 1 ? "Copy URLs" : "Copy URL", icon: <Copy />, hint: "Ctrl+C", onSelect: () => copy(sel) },
  ];

  return (
    <DetailTable
      label="HTTP sources"
      rows={data}
      rowKey={(u) => u}
      columns={COLUMNS}
      menu={menu}
      onActivate={edit}
      onKey={(e, sel) => {
        if (!sel.length) return false;
        if (e.key === "Delete") remove(sel);
        else if (e.key === "F2" && sel.length === 1) edit(sel[0]);
        else if ((e.key === "c" || e.key === "C") && (e.ctrlKey || e.metaKey)) copy(sel);
        else return false;
        return true;
      }}
      empty={
        <Empty
          icon={<Globe />}
          title="No HTTP sources"
          actions={
            <Button size="sm" icon={<Plus />} onClick={() => promptAddWebSeeds(id, refresh)}>
              Add HTTP source
            </Button>
          }
        >
          If the files are also on a web server, add its URL and Promethea will download from it too.
        </Empty>
      }
      minWidth={400}
    />
  );
}
