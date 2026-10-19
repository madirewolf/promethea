import { useId, useState } from "react";
import { FolderInput, Info } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api/client";
import type { Torrent } from "../api/types";
import { Button } from "../components/ui/Button";
import { Field } from "../components/ui/Form";
import { Modal } from "../components/ui/Modal";
import { PathInput } from "../components/ui/Misc";
import { plural } from "../lib/format";
import { useStore } from "../store/store";
import type { DialogProps } from "./DialogHost";
import { useSubmit } from "./useSubmit";

export interface LocationSpec {
  type: "location";
  ids: string[];
}

export function LocationDialog({ spec, close }: DialogProps<LocationSpec>) {
  const ts = useStore(useShallow((s) => spec.ids.map((id) => s.torrents[id]).filter(Boolean) as Torrent[]));
  // Start from the folder they share, else the first one's.
  const [initial] = useState(() => ts[0]?.savePath ?? "");
  const [path, setPath] = useState(initial);
  const [touched, setTouched] = useState(false);
  const pathId = useId();
  const target = path.trim();
  const auto = ts.filter((t) => t.autoTMM).length;
  const unchanged = ts.length > 0 && ts.every((t) => t.savePath === target);

  const { busy, error, submit } = useSubmit(async () => {
    setTouched(true);
    if (!target) throw new Error("Enter a folder");
    if (unchanged) return;
    await api.setLocation(
      ts.map((t) => t.id),
      target,
    );
  }, close);

  const one = ts.length === 1 ? ts[0] : null;
  return (
    <Modal
      title="Set location"
      subtitle={one ? <span className="dlg-name">{one.name}</span> : plural(ts.length, "torrent")}
      icon={<FolderInput />}
      size="md"
      onClose={close}
      onSubmit={submit}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!ts.length}>
            Move
          </Button>
        </>
      }
    >
      <Field
        label="Download to"
        htmlFor={pathId}
        error={(touched && !target && "Enter a folder") || error || undefined}
        hint="Files already downloaded are moved there."
      >
        <PathInput id={pathId} value={path} onChange={setPath} showFreeSpace autoFocus invalid={touched && !target} dialogTitle="Move to" />
      </Field>
      {auto > 0 && (
        <div className="callout info">
          <Info />
          <span>
            Automatic management will be turned off for{" "}
            {one ? "this torrent, so it stays" : auto === ts.length ? "these torrents, so they stay" : `${auto} of them, so they stay`}{" "}
            where you put {one ? "it" : "them"} instead of following the category's folder.
          </span>
        </div>
      )}
    </Modal>
  );
}
