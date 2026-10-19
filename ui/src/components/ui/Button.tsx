import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

type Variant = "default" | "primary" | "danger" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "sm";
  icon?: ReactNode;
  loading?: boolean;
  /** Tooltip text (shown by the global tooltip host). */
  tip?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", icon, loading, tip, className, children, disabled, type = "button", ...rest },
  ref,
) {
  const cls = ["btn", variant !== "default" && `btn-${variant}`, size === "sm" && "btn-sm", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} data-tip={tip} {...rest}>
      {loading ? <LoaderCircle className="spinner" /> : icon}
      {children}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label; also the tooltip unless `tip` is given. */
  label: string;
  tip?: string | null;
  /** Keyboard shortcut shown in the tooltip. */
  shortcut?: string;
  size?: "md" | "sm" | "xs";
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tip, shortcut, size = "md", active, className, children, type = "button", ...rest },
  ref,
) {
  const cls = ["icon-btn", size !== "md" && `icon-btn-${size}`, active && "active", className].filter(Boolean).join(" ");
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      aria-label={label}
      aria-pressed={active}
      data-tip={tip === null ? undefined : tip ?? label}
      data-kbd={shortcut}
      {...rest}
    >
      {children}
    </button>
  );
});
