import { useId, useState } from "react";
import { Folder } from "lucide-react";
import { api } from "../api/client";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Form";
import { Modal } from "../components/ui/Modal";
import { PathInput } from "../components/ui/Misc";
import { plural } from "../lib/format";
import { categoryFolder, categoryNameError } from "../lib/paths";
import { useStore } from "../store/store";
import type { DialogProps } from "./DialogHost";
import { FieldError, useSubmit } from "./useSubmit";

export interface CategorySpec {
  type: "category";
  /** The category being edited; absent for a new one. */
  name?: string;
  savePath?: string;
  /** Torrents to put in the new category once it exists. */
  assignTo?: string[];
}

export function CategoryDialog({ spec, close }: DialogProps<CategorySpec>) {
  const categories = useStore((s) => s.categories);
  const base = useStore((s) => s.prefs?.downloads?.savePath ?? "");
  const editing = spec.name != null;
  const [name, setName] = useState(spec.name ?? "");
  const [path, setPath] = useState(spec.savePath ?? "");
  const [touched, setTouched] = useState(false);
  const ids = { name: useId(), path: useId() };
  const invalid = categoryNameError(name, spec.name, categories);

  const { busy, error, submit } = useSubmit(async () => {
    setTouched(true);
    if (invalid) throw new FieldError(invalid);
    const n = name.trim();
    await api.setCategory(n, path.trim(), editing && spec.name !== n ? spec.name : undefined);
    if (spec.assignTo?.length) await api.set(spec.assignTo, { category: n });
  }, close);

  const assign = spec.assignTo?.length ?? 0;
  return (
    <Modal
      title={editing ? "Edit category" : "New category"}
      subtitle={assign ? `For ${assign === 1 ? "the selected torrent" : plural(assign, "selected torrent")}` : undefined}
      icon={<Folder />}
      size="md"
      onClose={close}
      onSubmit={submit}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={touched && !!invalid}>
            {editing ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor={ids.name} error={(touched && invalid) || undefined} hint="Use “/” for subcategories, like Movies/HD.">
        <Input id={ids.name} value={name} invalid={touched && !!invalid} placeholder="Movies" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label="Download folder"
        htmlFor={ids.path}
        hint={
          path.trim()
            ? "Torrents in this category with automatic management download here."
            : `Leave empty to use ${categoryFolder(base, name || "Category")}.`
        }
      >
        <PathInput id={ids.path} value={path} onChange={setPath} placeholder={categoryFolder(base, name || "Category")} showFreeSpace />
      </Field>
      {editing && spec.name !== name.trim() && !invalid && (
        <p className="faint dlg-note">Torrents in “{spec.name}” move to the renamed category.</p>
      )}
      {error && <div className="callout error">{error}</div>}
    </Modal>
  );
}
