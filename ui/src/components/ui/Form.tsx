import { forwardRef, useEffect, useId, useRef, useState } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { ChevronDown, Search, X } from "lucide-react";

// ------------------------------------------------------------------ text inputs
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  sm?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, sm, className, ...rest },
  ref,
) {
  const cls = ["input", sm && "input-sm", invalid && "invalid", className].filter(Boolean).join(" ");
  return <input ref={ref} className={cls} spellCheck={false} autoComplete="off" {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ mono, className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={["textarea", mono && "mono", className].filter(Boolean).join(" ")}
        spellCheck={false}
        {...rest}
      />
    );
  },
);

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  value: string;
  onChange: (value: string) => void;
  /** Shown at the right while empty, e.g. "Ctrl+F". */
  hint?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, hint, className, onKeyDown, ...rest },
  ref,
) {
  return (
    <div className={["input-wrap", "search-input", className].filter(Boolean).join(" ")}>
      <Search />
      <input
        ref={ref}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
          onKeyDown?.(e);
        }}
        {...rest}
      />
      {value ? (
        <button type="button" className="icon-btn icon-btn-xs" aria-label="Clear" onClick={() => onChange("")}>
          <X />
        </button>
      ) : hint ? (
        <span className="suffix">
          <kbd>{hint}</kbd>
        </span>
      ) : null}
    </div>
  );
});

// ------------------------------------------------------------------ tags
interface TagsInputProps {
  value: readonly string[];
  onChange: (tags: string[]) => void;
  /** Existing tags offered while typing. */
  suggestions?: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  /** Goes on the text box, for a `<label htmlFor>`. */
  id?: string;
}

/** Tags as chips: Enter or a comma adds what was typed, Backspace in the empty box removes the last. */
export function TagsInput({ value, onChange, suggestions = [], placeholder, disabled, id }: TagsInputProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const listId = useId();
  const add = (raw: string) => {
    const parts = raw.split(",").map((t) => t.trim()).filter(Boolean);
    setText("");
    if (parts.length) onChange([...new Set([...value, ...parts])]);
  };
  return (
    <div
      className="input-wrap tags-input"
      aria-disabled={disabled}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          ref.current?.focus();
        }
      }}
    >
      {value.map((t) => (
        <span key={t} className="chip">
          <span>{t}</span>
          {!disabled && (
            <button type="button" className="chip-x" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
              <X />
            </button>
          )}
        </span>
      ))}
      <input
        ref={ref}
        id={id}
        list={suggestions.length ? listId : undefined}
        value={text}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        placeholder={value.length ? undefined : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          // Picking a suggestion from the list adds it straight away.
          const picked = (e.nativeEvent as InputEvent).inputType === "insertReplacementText" || !("inputType" in e.nativeEvent);
          if (v.includes(",") || (picked && suggestions.includes(v))) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => text.trim() && add(text)}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !value.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ select
export interface Option<T extends string | number = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SelectProps<T extends string | number> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  sm?: boolean;
}

export function Select<T extends string | number>({ value, options, onChange, sm, className, ...rest }: SelectProps<T>) {
  return (
    <div className={["select-wrap", className].filter(Boolean).join(" ")}>
      <select
        className={["select", sm && "input-sm"].filter(Boolean).join(" ")}
        value={String(value)}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value);
          if (opt) onChange(opt.value);
        }}
        {...rest}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown />
    </div>
  );
}

// ------------------------------------------------------------------ toggles
interface CheckProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
  className?: string;
  title?: string;
}

export function Checkbox({ checked, onChange, label, hint, disabled, indeterminate, className, title }: CheckProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  const box = (
    <input
      ref={ref}
      type="checkbox"
      className="cb"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={typeof label === "string" ? label : title}
    />
  );
  if (!label) return box;
  return (
    <label className={["check", disabled && "disabled", className].filter(Boolean).join(" ")} title={title}>
      {box}
      <span>
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Switch({ checked, onChange, label, hint, disabled, className, title }: CheckProps) {
  const input = (
    <input
      type="checkbox"
      role="switch"
      className="sw"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={typeof label === "string" ? label : title}
    />
  );
  if (!label) return input;
  return (
    <label className={["check", "switch-row", disabled && "disabled", className].filter(Boolean).join(" ")} title={title}>
      <span className="grow">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
      {input}
    </label>
  );
}

interface RadioGroupProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; hint?: ReactNode; disabled?: boolean }[];
  className?: string;
}

export function RadioGroup<T extends string>({ value, onChange, options, className }: RadioGroupProps<T>) {
  const name = useId();
  return (
    <div className={["col", "radio-group", className].filter(Boolean).join(" ")} role="radiogroup">
      {options.map((o) => (
        <label key={o.value} className={["check", o.disabled && "disabled"].filter(Boolean).join(" ")}>
          <input
            type="radio"
            className="rb"
            name={name}
            checked={value === o.value}
            disabled={o.disabled}
            onChange={() => onChange(o.value)}
          />
          <span>
            {o.label}
            {o.hint && <span className="hint">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode; tip?: string }[];
  className?: string;
}

export function Segmented<T extends string>({ value, onChange, options, className }: SegmentedProps<T>) {
  return (
    <div className={["segmented", className].filter(Boolean).join(" ")} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className={value === o.value ? "on" : undefined}
          onClick={() => onChange(o.value)}
          data-tip={o.tip}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ field
interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}

export function Field({ label, hint, error, children, className, htmlFor }: FieldProps) {
  return (
    <div className={["field", className].filter(Boolean).join(" ")}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <div className="error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ numbers
interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Text after the number, e.g. "min" or "KiB/s". */
  suffix?: ReactNode;
  /** Allow fractions (default: integers only). */
  float?: boolean;
  sm?: boolean;
}

/** A number box that only commits valid values (on blur / Enter). */
export function NumberInput({ value, onChange, min, max, step, suffix, float, sm, className, disabled, ...rest }: NumberInputProps) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  const commit = () => {
    let v = float ? parseFloat(text) : parseInt(text, 10);
    if (!Number.isFinite(v)) {
      setText(String(value));
      return;
    }
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <div
      className={["input-wrap", "number-input", sm && "input-sm", className].filter(Boolean).join(" ")}
      aria-disabled={disabled}
      style={disabled ? { opacity: 0.5 } : undefined}
    >
      <input
        inputMode={float ? "decimal" : "numeric"}
        value={text}
        disabled={disabled}
        step={step}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const cur = float ? parseFloat(text) : parseInt(text, 10);
            let v = (Number.isFinite(cur) ? cur : value) + (e.key === "ArrowUp" ? 1 : -1) * (step ?? 1);
            if (min != null) v = Math.max(min, v);
            if (max != null) v = Math.min(max, v);
            v = float ? Math.round(v * 100) / 100 : v;
            setText(String(v));
            onChange(v);
          }
        }}
        {...rest}
      />
      {suffix != null && <span className="suffix">{suffix}</span>}
    </div>
  );
}

const SPEED_UNITS = [
  { value: 1024, label: "KiB/s" },
  { value: 1024 * 1024, label: "MiB/s" },
] as const;

interface SpeedInputProps {
  /** Bytes per second; 0 = unlimited. */
  value: number;
  onChange: (bytesPerSecond: number) => void;
  disabled?: boolean;
  placeholder?: string;
}

/** Speed limit editor: number + unit, empty or 0 = unlimited. */
export function SpeedInput({ value, onChange, disabled, placeholder = "Unlimited" }: SpeedInputProps) {
  const initialUnit = value > 0 && value % (1024 * 1024) === 0 ? 1024 * 1024 : 1024;
  const [unit, setUnit] = useState<number>(initialUnit);
  const [text, setText] = useState(value > 0 ? fmt(value / initialUnit) : "");
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    setText(value > 0 ? fmt(value / unit) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = (t = text, u = unit) => {
    const v = parseFloat(t);
    const bytes = Number.isFinite(v) && v > 0 ? Math.round(v * u) : 0;
    if (bytes !== value) onChange(bytes);
    setText(bytes > 0 ? fmt(bytes / u) : "");
  };
  return (
    <div className="input-wrap speed-input" style={disabled ? { opacity: 0.5 } : undefined}>
      <input
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ""))}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <select
        className="unit-select"
        value={unit}
        disabled={disabled}
        onChange={(e) => {
          const u = Number(e.target.value);
          setUnit(u);
          commit(text, u);
        }}
      >
        {SPEED_UNITS.map((u) => (
          <option key={u.value} value={u.value}>
            {u.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}
