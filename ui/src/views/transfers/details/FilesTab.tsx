import { api } from "../../../api/client";
import type { FilesResponse } from "../../../api/types";
import { FileTree } from "../../../components/FileTree";
import type { FileColumn } from "../../../components/FileTree";
import { parentPath } from "../../../components/treeModel";
import type { TreeFile, TreeNode } from "../../../components/treeModel";
import { Empty, Spinner } from "../../../components/ui/Misc";
import { attempt } from "../../../lib/actions";
import { useEvent } from "../../../lib/hooks";
import { toastError, useStore } from "../../../store/store";
import { TabError, TabLoading, useRefreshMs, useSoon, useTorrentPoll } from "./shared";

const FILE_COLUMNS: readonly FileColumn[] = ["progress", "remaining", "availability"];

export function FilesTab({ id, nonce, filter }: { id: string; nonce: number; filter: string }) {
  const numFiles = useStore((s) => s.torrents[id]?.numFiles ?? 0);
  const desktop = useStore((s) => !!s.app?.desktop);
  const base = useRefreshMs();
  // Huge torrents cost the backend real work per poll; refresh them less often.
  const ms = numFiles > 3000 ? Math.max(5000, base) : Math.max(1500, base);
  const { data, error, refresh, mutate } = useTorrentPoll<FilesResponse>(id, api.files, ms, nonce);
  const soon = useSoon(refresh);

  useEvent("torrent.files", (d) => d?.id === id && soon());
  useEvent("torrent.metadata", (d) => d?.id === id && soon());

  if (!data) return error ? <TabError message={error} /> : <TabLoading />;
  if (!data.hasMetadata) {
    return (
      <Empty icon={<Spinner size={20} />} title="Waiting for metadata…">
        The file list appears as soon as a peer sends it.
      </Empty>
    );
  }

  const onPriority = (files: TreeFile[], priority: number) => {
    const indices = files.map((f) => f.index);
    const set = new Set(indices);
    mutate((d) => ({ ...d, files: d.files.map((f) => (set.has(f.index) ? { ...f, priority } : f)) }));
    api.setFilePriority(id, indices, priority).catch((e: unknown) => {
      toastError(e, "Couldn't change the priority");
      refresh();
    });
  };

  const onRename = (node: TreeNode, name: string) => {
    const old = node.path;
    const parent = parentPath(node);
    const next = parent ? `${parent}/${name}` : name;
    if (next === old) return;
    const moves = (p: string) => (node.folder ? p.startsWith(`${old}/`) : p === old);
    // libtorrent renames on its disk thread and the backend announces it with an event,
    // so keep the new names on screen until then.
    mutate((d) => ({ ...d, files: d.files.map((f) => (moves(f.path) ? { ...f, path: next + f.path.slice(old.length) } : f)) }), 10000);
    api.renamePath(id, old, next).catch((e: unknown) => {
      toastError(e, "Couldn't rename");
      refresh();
    });
  };

  return (
    <FileTree
      files={data.files}
      columns={FILE_COLUMNS}
      stateKey={id}
      filter={filter}
      onPriority={onPriority}
      onRename={onRename}
      onOpen={desktop ? (n) => void attempt(() => api.openContent(id, n.path), "Couldn't open it") : undefined}
      onReveal={desktop ? (n) => void attempt(() => api.revealContent(id, n.path), "Couldn't show it") : undefined}
    />
  );
}
