import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { dismissToast, useStore } from "../../store/store";
import { Button, IconButton } from "./Button";

const ICONS = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
};

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon />
            <div className="toast-body">
              {t.title && <div className="toast-title">{t.title}</div>}
              <div className={t.title ? "toast-msg" : undefined}>{t.message}</div>
              {t.action && (
                <div className="toast-action">
                  <Button
                    size="sm"
                    onClick={() => {
                      dismissToast(t.id);
                      t.action!.run();
                    }}
                  >
                    {t.action.label}
                  </Button>
                </div>
              )}
            </div>
            <IconButton label="Dismiss" tip={null} size="xs" onClick={() => dismissToast(t.id)}>
              <X />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
