import { useState } from "react";

/** Thrown when a field already shows what's wrong: the dialog stays open without repeating it below. */
export class FieldError extends Error {}

/**
 * Submitting a dialog: a spinner while the request runs, its error shown inline when it
 * fails (the dialog stays open), and the dialog closed once it succeeds.
 */
export function useSubmit(run: () => Promise<unknown> | unknown, close: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run();
      close();
    } catch (e) {
      if (!(e instanceof FieldError)) setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return { busy, error, setError, submit: () => void submit() };
}
