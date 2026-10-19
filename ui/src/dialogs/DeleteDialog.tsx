import { useEffect, useState } from "react";
import { Trash } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api/client";
import type { Torrent } from "../api/types";
import { Button } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Form";
import { Modal } from "../components/ui/Modal";
import { formatBytes, plural } from "../lib/format";
import { useStore } from "../store/store";
import type { DialogProps } from "./DialogHost";
import { useSubmit } from "./useSubmit";

export interface DeleteSpec {
  type: "delete";
  ids: string[];
  /** Pre-ticks "also delete the files" (Shift+Del, or the saved default). */
  deleteFiles?: boolean;
}

const SHOWN = 5;

export function DeleteDialog({ spec, close }: DialogProps<DeleteSpec>) {
  // Torrents removed meanwhile (by a share limit, another client) drop out of the list.
  const ts = useStore(useShallow((s) => spec.ids.map((id) => s.torrents[id]).filter(Boolean) as Torrent[]));
  const recycle = useStore((s) => s.app?.platform === "win32" && s.prefs?.behavior?.useRecycleBin !== false);
  const savedDefault = useStore((s) => !!s.prefs?.behavior?.deleteFilesDefault);
  const [files, setFiles] = useState(!!spec.deleteFiles);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (!ts.length) close();
  }, [ts.length, close]);

  const { busy, error, submit } = useSubmit(async () => {
    if (remember && files !== savedDefault) {
      await api.setPrefs({ behavior: { deleteFilesDefault: files } });
    }
    await api.remove(
      ts.map((t) => t.id),
      files,
    );
  }, close);

  if (!ts.length) return null;
  const one = ts.length === 1 ? ts[0] : null;
  const size = ts.reduce((sum, t) => sum + Math.max(0, t.completed), 0);
  const where = recycle ? "moved to the Recycle Bin" : "deleted permanently";

  return (
    <Modal
      title={one ? "Remove this torrent?" : `Remove ${ts.length} torrents?`}
      subtitle={one ? <span className="dlg-name">{one.name}</span> : undefined}
      icon={<Trash />}
      tone="danger"
      size="sm"
      onClose={close}
      onSubmit={submit}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy}>
            {files ? "Remove and delete files" : "Remove"}
          </Button>
        </>
      }
    >
      {!one && (
        <ul className="dlg-list">
          {ts.slice(0, SHOWN).map((t) => (
            <li key={t.id} className="ellipsis" data-tip={t.name}>
              {t.name}
            </li>
          ))}
          {ts.length > SHOWN && <li className="muted">and {plural(ts.length - SHOWN, "more torrent")}</li>}
        </ul>
      )}
      <div className="col dlg-checks">
        <Checkbox
          checked={files}
          onChange={setFiles}
          label="Also delete the downloaded files"
          hint={
            files
              ? `${size > 0 ? `${formatBytes(size)} of data` : "The data"} will be ${where}.`
              : "The files stay on disk; only the torrent is removed from Promethea."
          }
        />
        <Checkbox
          checked={remember}
          onChange={setRemember}
          label="Remember this choice"
          hint="Used the next time you remove a torrent with Del."
        />
      </div>
      {error && <div className="callout error">{error}</div>}
    </Modal>
  );
}
