import type { ReactNode } from "react";
import { CircleAlert, CircleHelp } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { openDialog } from "../store/store";
import type { DialogProps } from "./DialogHost";

export interface ConfirmSpec {
  type: "confirm";
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  /** Closed without confirming. */
  onCancel?: () => void;
}

/** Ask a yes/no question; resolves true when it's confirmed. */
export function confirm(spec: Omit<ConfirmSpec, "type" | "onConfirm" | "onCancel">): Promise<boolean> {
  return new Promise((resolve) =>
    openDialog({ type: "confirm", ...spec, onConfirm: () => resolve(true), onCancel: () => resolve(false) }),
  );
}

export function ConfirmDialog({ spec, close }: DialogProps<ConfirmSpec>) {
  const cancel = () => {
    close();
    spec.onCancel?.();
  };
  return (
    <Modal
      title={spec.title}
      icon={spec.danger ? <CircleAlert /> : <CircleHelp />}
      tone={spec.danger ? "danger" : "accent"}
      size="sm"
      onClose={cancel}
      onSubmit={() => {
        close();
        spec.onConfirm();
      }}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={cancel}>Cancel</Button>
          <Button type="submit" variant={spec.danger ? "danger" : "primary"}>
            {spec.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      {spec.message && <p className="muted">{spec.message}</p>}
    </Modal>
  );
}
