// Building blocks for the settings page: sections, grouped cards, rows, and controls
// bound to one preference each. Rows hide while the search box holds words they don't contain.

import { isValidElement, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Checkbox, Input, NumberInput, Select, SpeedInput, Switch, Textarea } from "../../components/ui/Form";
import type { Option } from "../../components/ui/Form";
import { PathInput } from "../../components/ui/Misc";
import { useDraft, usePref } from "./draft";
import type { SectionId } from "./draft";

/** [section, key] of a preference. */
export type PrefKey = readonly [string, string];

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ------------------------------------------------------------------ search
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** Whether a row with this text matches every word in the search box. */
export function useShown(...text: (ReactNode | undefined)[]): boolean {
  const query = useDraft((s) => s.query.trim().toLowerCase());
  if (!query) return true;
  const hay = text.map(textOf).join(" ").toLowerCase();
  return query.split(/\s+/).every((w) => hay.includes(w));
}

// ------------------------------------------------------------------ layout
interface SectionProps {
  id: SectionId;
  title: string;
  icon: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}

export function Section({ id, title, icon, description, children }: SectionProps) {
  return (
    <section className="set-section" id={`settings-${id}`} data-section={id} aria-labelledby={`settings-${id}-title`}>
      <header className="set-section-head">
        <span className="set-section-icon">{icon}</span>
        <div>
          <h2 id={`settings-${id}-title`}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

export function Group({ title, note, children }: { title?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-group">
      {title && <h3 className="set-group-title">{title}</h3>}
      <div className="set-card">{children}</div>
      {note && <div className="set-note">{note}</div>}
    </div>
  );
}

interface RowProps {
  label: ReactNode;
  hint?: ReactNode;
  /** More words the search box finds this row by. */
  keywords?: string;
  children?: ReactNode;
  /** The control goes under the text at full width (folders, lists). */
  stacked?: boolean;
  /** Changed but not saved yet. */
  dirty?: boolean;
  disabled?: boolean;
  /** Depends on the setting above it. */
  sub?: boolean;
  className?: string;
}

function RowText({ label, hint, dirty }: Pick<RowProps, "label" | "hint" | "dirty">) {
  return (
    <div className="set-text">
      <div className="set-label">
        {dirty && <span className="set-dirty" aria-label="Not saved yet" title="Not saved yet" />}
        {label}
      </div>
      {hint && <div className="set-hint">{hint}</div>}
    </div>
  );
}

export function Row({ label, hint, keywords, children, stacked, dirty, disabled, sub, className }: RowProps) {
  if (!useShown(label, hint, keywords)) return null;
  return (
    <div className={cx("set-row", stacked && "stacked", sub && "sub", disabled && "disabled", className)}>
      <RowText label={label} hint={hint} dirty={dirty} />
      {children != null && <div className="set-ctl">{children}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ bound controls
interface PrefRowProps {
  k: PrefKey;
  label: ReactNode;
  hint?: ReactNode;
  keywords?: string;
  disabled?: boolean;
  sub?: boolean;
}

interface ToggleRowProps {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  keywords?: string;
  dirty?: boolean;
  disabled?: boolean;
  sub?: boolean;
}

/** A switch row: clicking anywhere on it toggles. */
export function SwitchRow({ checked, onChange, label, hint, keywords, dirty, disabled, sub }: ToggleRowProps) {
  if (!useShown(label, hint, keywords)) return null;
  return (
    <label className={cx("set-row", "set-toggle", sub && "sub", disabled && "disabled")}>
      <RowText label={label} hint={hint} dirty={dirty} />
      <div className="set-ctl">
        <Switch checked={checked} disabled={disabled} onChange={onChange} title={typeof label === "string" ? label : undefined} />
      </div>
    </label>
  );
}

/** On/off setting. `invert` shows "on" when the preference is false. */
export function SwitchPref({ k, invert, ...row }: PrefRowProps & { invert?: boolean }) {
  const [value, set, dirty] = usePref<boolean>(k[0], k[1]);
  const on = invert ? !value : !!value;
  return <SwitchRow {...row} checked={on} dirty={dirty} onChange={(c) => set(invert ? !c : c)} />;
}

interface NumberPrefProps extends PrefRowProps {
  min?: number;
  max?: number;
  step?: number;
  suffix?: ReactNode;
  float?: boolean;
  /** Stored value = shown value × scale (seconds shown as minutes: 60). */
  scale?: number;
}

export function NumberPref({ k, min, max, step, suffix, float, scale = 1, ...row }: NumberPrefProps) {
  const [value, set, dirty] = usePref<number>(k[0], k[1]);
  return (
    <Row {...row} dirty={dirty}>
      <NumberInput
        className="set-num"
        value={Math.round(((value ?? 0) / scale) * 100) / 100}
        onChange={(v) => set(float ? v * scale : Math.round(v * scale))}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        float={float}
        disabled={row.disabled}
        aria-label={typeof row.label === "string" ? row.label : undefined}
      />
    </Row>
  );
}

/** A count where an empty box means "no limit"; stored as `none` (0 or -1, as the engine expects). */
export function LimitPref({ k, none = -1, suffix, max, ...row }: PrefRowProps & { none?: number; suffix?: ReactNode; max?: number }) {
  const [value, set, dirty] = usePref<number>(k[0], k[1]);
  return (
    <Row {...row} dirty={dirty}>
      <LimitInput
        value={value > 0 ? value : null}
        onChange={(v) => set(v ?? none)}
        suffix={suffix}
        max={max}
        disabled={row.disabled}
        label={typeof row.label === "string" ? row.label : undefined}
      />
    </Row>
  );
}

function LimitInput({
  value,
  onChange,
  suffix,
  max,
  disabled,
  label,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  suffix?: ReactNode;
  max?: number;
  disabled?: boolean;
  label?: string;
}) {
  const show = (v: number | null) => (v == null ? "" : String(v));
  const [text, setText] = useState(show(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(show(value));
  }, [value]);
  const commit = () => {
    const n = parseInt(text, 10);
    const next = Number.isFinite(n) && n > 0 ? Math.min(n, max ?? n) : null;
    setText(show(next));
    if (next !== value) onChange(next);
  };
  return (
    <div className="input-wrap number-input set-num" aria-disabled={disabled}>
      <input
        inputMode="numeric"
        value={text}
        placeholder="No limit"
        disabled={disabled}
        aria-label={label}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      {suffix != null && <span className="suffix">{suffix}</span>}
    </div>
  );
}

/** A limit that can be switched off: checkbox + number (seeding limits). */
export function CheckNumberPref({
  on: onKey,
  k,
  label,
  hint,
  keywords,
  min,
  max,
  step,
  suffix,
  float,
  disabled,
}: Omit<NumberPrefProps, "sub" | "scale"> & { on: PrefKey }) {
  const [enabled, setEnabled, dirtyOn] = usePref<boolean>(onKey[0], onKey[1]);
  const [value, set, dirtyValue] = usePref<number>(k[0], k[1]);
  if (!useShown(label, hint, keywords)) return null;
  return (
    <div className={cx("set-row", "set-check", disabled && "disabled")}>
      <div className="set-text">
        <div className="set-label">
          {(dirtyOn || dirtyValue) && <span className="set-dirty" title="Not saved yet" />}
          <Checkbox checked={!!enabled} onChange={setEnabled} label={label} disabled={disabled} />
        </div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-ctl">
        <NumberInput
          className="set-num"
          value={value}
          onChange={set}
          min={min}
          max={max}
          step={step}
          suffix={suffix}
          float={float}
          disabled={disabled || !enabled}
          aria-label={typeof label === "string" ? label : undefined}
        />
      </div>
    </div>
  );
}

export function SelectPref<T extends string>({ k, options, ...row }: PrefRowProps & { options: readonly Option<T>[] }) {
  const [value, set, dirty] = usePref<T>(k[0], k[1]);
  return (
    <Row {...row} dirty={dirty}>
      <Select<T>
        className="set-select"
        value={value}
        options={options}
        onChange={set}
        disabled={row.disabled}
        aria-label={typeof row.label === "string" ? row.label : undefined}
      />
    </Row>
  );
}

interface TextPrefProps extends PrefRowProps {
  placeholder?: string;
  mono?: boolean;
  stacked?: boolean;
  type?: "text" | "password";
  /** A wider box beside the text (addresses, commands). */
  wide?: boolean;
}

export function TextPref({ k, placeholder, mono, type = "text", wide, ...row }: TextPrefProps) {
  const [value, set, dirty] = usePref<string>(k[0], k[1]);
  return (
    <Row {...row} dirty={dirty}>
      <Input
        className={cx(mono && "mono", !row.stacked && (wide ? "set-in-wide" : "set-in"))}
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={row.disabled}
        onChange={(e) => set(e.target.value)}
        aria-label={typeof row.label === "string" ? row.label : undefined}
      />
    </Row>
  );
}

interface PathPrefProps extends PrefRowProps {
  placeholder?: string;
  /** Show the free space on that drive. */
  free?: boolean;
  /** Pick a file instead of a folder. */
  file?: { title: string; types: string[] };
}

export function PathPref({ k, placeholder, free, file, ...row }: PathPrefProps) {
  const [value, set, dirty] = usePref<string>(k[0], k[1]);
  return (
    <Row {...row} dirty={dirty} stacked>
      <PathInput
        value={value ?? ""}
        onChange={set}
        placeholder={placeholder}
        disabled={row.disabled}
        showFreeSpace={free}
        kind={file ? "open" : "folder"}
        dialogTitle={file?.title}
        fileTypes={file?.types}
        aria-label={typeof row.label === "string" ? row.label : undefined}
      />
    </Row>
  );
}

/** A folder that is optional: off = empty path. */
export function OptionalPathPref({ k, label, hint, keywords, disabled, placeholder }: PrefRowProps & { placeholder?: string }) {
  const [value, set, dirty] = usePref<string>(k[0], k[1]);
  const [open, setOpen] = useState(!!value);
  useEffect(() => {
    if (value) setOpen(true);
  }, [value]);
  if (!useShown(label, hint, keywords)) return null;
  return (
    <>
      <SwitchRow
        label={label}
        hint={hint}
        dirty={dirty}
        disabled={disabled}
        checked={open}
        onChange={(on) => {
          setOpen(on);
          if (!on) set("");
        }}
      />
      {open && (
        <div className="set-row sub stacked">
          <div className="set-ctl">
            <PathInput
              value={value ?? ""}
              onChange={set}
              placeholder={placeholder}
              disabled={disabled}
              aria-label={typeof label === "string" ? label : undefined}
            />
          </div>
        </div>
      )}
    </>
  );
}

export function SpeedPref({ k, ...row }: PrefRowProps) {
  const [value, set, dirty] = usePref<number>(k[0], k[1]);
  return (
    <Row {...row} dirty={dirty}>
      <div className="set-speed">
        <SpeedInput value={value ?? 0} onChange={set} disabled={row.disabled} />
      </div>
    </Row>
  );
}

/** Free text over several lines, stored as one string. */
export function TextareaPref({ k, placeholder, rows = 4, ...row }: PrefRowProps & { placeholder?: string; rows?: number }) {
  const [value, set, dirty] = usePref<string>(k[0], k[1]);
  return (
    <Row {...row} dirty={dirty} stacked>
      <Textarea
        mono
        rows={rows}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={row.disabled}
        onChange={(e) => set(e.target.value)}
        aria-label={typeof row.label === "string" ? row.label : undefined}
      />
    </Row>
  );
}

/** One item per line, stored as a list. The text is kept as typed while the box has focus. */
export function LinesPref({ k, placeholder, rows = 4, ...row }: PrefRowProps & { placeholder?: string; rows?: number }) {
  const [value, set, dirty] = usePref<string[]>(k[0], k[1]);
  const joined = (value ?? []).join("\n");
  const [text, setText] = useState(joined);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(joined);
  }, [joined]);
  return (
    <Row {...row} dirty={dirty} stacked>
      <Textarea
        mono
        rows={rows}
        value={text}
        placeholder={placeholder}
        disabled={row.disabled}
        aria-label={typeof row.label === "string" ? row.label : undefined}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          setText(joined);
        }}
        onChange={(e) => {
          setText(e.target.value);
          set(
            e.target.value
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean),
          );
        }}
      />
    </Row>
  );
}
