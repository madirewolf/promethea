import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/Button";
import { Field, Input, Textarea } from "../components/ui/Form";
import { Modal } from "../components/ui/Modal";
import type { DialogProps } from "./DialogHost";

export interface PromptSpec {
  type: "prompt";
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  label?: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  confirmLabel?: string;
  hint?: ReactNode;
  /** An error message blocks submitting. */
  validate?: (value: string) => string | null;
  /** May return a promise: the dialog shows a spinner, and stays open with the error if it rejects. */
  onSubmit: (value: string) => void | Promise<unknown>;
  /** Pre-select only the part before the extension (renaming files). */
  selectBase?: boolean;
  size?: "sm" | "md" | "lg";
}

export function PromptDialog({ spec, close }: DialogProps<PromptSpec>) {
  const [value, setValue] = useState(spec.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState(false);
  const invalid = spec.validate?.(value) ?? null;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Runs after the modal focused (and selected) the field.
    const el = inputRef.current;
    if (!spec.selectBase || !el) return;
    const dot = el.value.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setTouched(true);
    if (invalid || busy) return;
    setBusy(true);
    setError("");
    try {
      await spec.onSubmit(value);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const shownError = (touched && invalid) || error || undefined;
  return (
    <Modal
      title={spec.title}
      subtitle={spec.subtitle}
      icon={spec.icon}
      size={spec.size ?? (spec.multiline ? "md" : "sm")}
      onClose={close}
      onSubmit={() => void submit()}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={touched && !!invalid}>
            {spec.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      <Field label={spec.label} hint={spec.hint} error={shownError}>
        {spec.multiline ? (
          <Textarea
            mono={spec.mono}
            value={value}
            placeholder={spec.placeholder}
            rows={6}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        ) : (
          <Input
            ref={inputRef}
            value={value}
            placeholder={spec.placeholder}
            invalid={touched && !!invalid}
            className={spec.mono ? "mono" : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
    </Modal>
  );
}
