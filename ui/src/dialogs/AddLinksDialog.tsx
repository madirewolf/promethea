import { useMemo, useState } from "react";
import { Link } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Field, Textarea } from "../components/ui/Form";
import { Modal } from "../components/ui/Modal";
import { addSources, extractSources } from "../lib/add";
import { plural } from "../lib/format";
import type { DialogProps } from "./DialogHost";

export interface AddLinksSpec {
  type: "addLinks";
  /** Text to start with (e.g. links dropped on the dialog's button). */
  text?: string;
}

export function AddLinksDialog({ spec, close }: DialogProps<AddLinksSpec>) {
  const [text, setText] = useState(spec.text ?? "");
  const [touched, setTouched] = useState(false);
  const sources = useMemo(() => extractSources(text), [text]);

  const submit = () => {
    setTouched(true);
    if (!sources.length) return;
    close();
    // Each link opens in the add dialog (or is added right away), with errors as toasts.
    void addSources(sources);
  };

  const error = touched && !sources.length ? (text.trim() ? "No magnet links, hashes or URLs found" : "Paste at least one link") : undefined;
  return (
    <Modal
      title="Add magnet links or URLs"
      icon={<Link />}
      size="md"
      onClose={close}
      onSubmit={submit}
      footer={
        <>
          <span className="faint dlg-foot-note">Ctrl+Enter to add</span>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={touched && !sources.length}>
            {sources.length > 1 ? `Add ${sources.length}` : "Add"}
          </Button>
        </>
      }
    >
      <Field
        label="Links"
        error={error}
        hint={
          sources.length
            ? `${plural(sources.length, "link")} found`
            : "One per line: magnet links, info hashes, or web addresses of .torrent files."
        }
      >
        <Textarea
          mono
          rows={8}
          value={text}
          placeholder={"magnet:?xt=urn:btih:…\nhttps://example.org/file.torrent"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </Field>
    </Modal>
  );
}
