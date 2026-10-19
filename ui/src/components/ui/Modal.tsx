import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "./Button";

interface ModalProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  tone?: "accent" | "danger";
  size?: "sm" | "md" | "lg" | "xl";
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  /** When given, the body is a form and Enter submits it. */
  onSubmit?: () => void;
  /** Close when the backdrop is clicked (default true). */
  dismissable?: boolean;
  className?: string;
  bodyClassName?: string;
}

/** Stack of open modals: only the top one reacts to Escape/Tab. */
const stack: number[] = [];
let seq = 0;

export function Modal({
  title,
  subtitle,
  icon,
  tone = "accent",
  size,
  onClose,
  children,
  footer,
  onSubmit,
  dismissable = true,
  className,
  bodyClassName,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const downOnScrim = useRef(false);

  useEffect(() => {
    const id = ++seq;
    idRef.current = id;
    stack.push(id);
    const prevFocus = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Focus the first field, else the primary button, else the dialog itself.
    const first =
      el?.querySelector<HTMLElement>("[data-autofocus]") ??
      el?.querySelector<HTMLElement>(".modal-body input:not([type=checkbox]):not([type=radio]):not(:disabled), .modal-body textarea, .modal-body select") ??
      el?.querySelector<HTMLElement>(".modal-footer .btn-primary, .modal-footer .btn-danger") ??
      el;
    first?.focus({ preventScroll: true });
    if (first instanceof HTMLInputElement && first.type === "text") first.select();

    // Bubble phase, so a field or menu inside the dialog can claim Escape first
    // (clearing a search box, cancelling an inline rename, closing a dropdown).
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && el && !e.defaultPrevented) {
        const focusables = [...el.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1']), a[href]",
        )].filter((f) => f.offsetParent !== null);
        if (!focusables.length) return;
        const firstF = focusables[0];
        const lastF = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === firstF) {
          e.preventDefault();
          lastF.focus();
        } else if (!e.shiftKey && document.activeElement === lastF) {
          e.preventDefault();
          firstF.focus();
        } else if (!el.contains(document.activeElement)) {
          e.preventDefault();
          firstF.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    };
  }, []);

  const body = (
    <>
      <div className="modal-header">
        {icon && <div className={`modal-icon ${tone === "danger" ? "danger" : ""}`}>{icon}</div>}
        <div className="grow">
          <h2 className="modal-title">{title}</h2>
          {subtitle && <div className="modal-subtitle">{subtitle}</div>}
        </div>
        <IconButton label="Close" tip={null} size="sm" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {children != null && <div className={["modal-body", bodyClassName].filter(Boolean).join(" ")}>{children}</div>}
      {footer && <div className="modal-footer">{footer}</div>}
    </>
  );

  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        downOnScrim.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (dismissable && downOnScrim.current && e.target === e.currentTarget) onClose();
        downOnScrim.current = false;
      }}
    >
      <div
        ref={ref}
        className={["modal", size, className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onContextMenu={(e) => {
          const t = e.target as HTMLElement;
          if (!t.closest("input, textarea")) e.preventDefault();
        }}
      >
        {onSubmit ? (
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </div>,
    document.body,
  );
}
