import { useState } from "react";
import { Gauge } from "lucide-react";
import { api } from "../api/client";
import type { SetProps } from "../api/client";
import type { Prefs, Torrent } from "../api/types";
import { Button } from "../components/ui/Button";
import { Checkbox, Field, NumberInput, RadioGroup, SpeedInput } from "../components/ui/Form";
import { Modal } from "../components/ui/Modal";
import { formatDuration, formatLimit, plural } from "../lib/format";
import { useStore } from "../store/store";
import type { DialogProps } from "./DialogHost";
import { useSubmit } from "./useSubmit";

export interface OptionsSpec {
  type: "options";
  ids: string[];
}

type ShareMode = "global" | "none" | "custom";

/** The value every torrent shares, or undefined when they differ. */
function shared<T>(ts: readonly Torrent[], f: (t: Torrent) => T): T | undefined {
  if (!ts.length) return undefined;
  const v = f(ts[0]);
  return ts.every((t) => f(t) === v) ? v : undefined;
}

function modeOf(t: Torrent): ShareMode {
  const all = [t.ratioLimit, t.seedingTimeLimit, t.inactiveSeedingTimeLimit];
  if (all.every((v) => v === -2)) return "global";
  if (all.every((v) => v === -1)) return "none";
  return "custom";
}

const ACTIONS: Record<string, string> = {
  stop: "the torrent is stopped",
  remove: "the torrent is removed",
  removeWithFiles: "the torrent and its files are removed",
  superSeeding: "the torrent switches to super seeding",
};

function describeGlobal(b: Record<string, any>): string {
  const parts: string[] = [];
  if (b.ratioLimitEnabled) parts.push(`ratio ${Number(b.ratioLimit).toFixed(2)}`);
  if (b.seedingTimeLimitEnabled) parts.push(`${formatDuration(b.seedingTimeLimit * 60)} of seeding`);
  if (b.inactiveSeedingTimeLimitEnabled) parts.push(`${formatDuration(b.inactiveSeedingTimeLimit * 60)} inactive`);
  return parts.length ? `Currently ${parts.join(", or ")}.` : "No global limits are set.";
}

interface Limit {
  on: boolean;
  value: number;
}

/** A custom limit's starting point: the torrent's own value, else the global one. */
function initialLimit(own: number | undefined, globalValue: number): Limit {
  return own != null && own >= 0 ? { on: true, value: own } : { on: false, value: globalValue };
}

export function OptionsDialog({ spec, close }: DialogProps<OptionsSpec>) {
  // A snapshot: the live values keep changing (and would fight the inputs) while the dialog is open.
  const [ts] = useState(() => {
    const all = useStore.getState().torrents;
    return spec.ids.map((id) => all[id]).filter(Boolean) as Torrent[];
  });
  const prefs = useStore((s) => s.prefs) ?? ({} as Prefs);
  const b = prefs.bittorrent ?? {};
  const globalDl = useStore((s) => s.server?.dlLimit ?? 0);
  const globalUl = useStore((s) => s.server?.upLimit ?? 0);

  const dl0 = shared(ts, (t) => t.dlLimit);
  const ul0 = shared(ts, (t) => t.upLimit);
  const [dl, setDl] = useState(dl0 ?? 0);
  const [ul, setUl] = useState(ul0 ?? 0);
  const [dlTouched, setDlTouched] = useState(false);
  const [ulTouched, setUlTouched] = useState(false);

  const custom = ts.find((t) => modeOf(t) === "custom");
  const [mode, setMode] = useState<ShareMode | null>(() => shared(ts, modeOf) ?? null);
  const [ratio, setRatio] = useState(() => initialLimit(custom?.ratioLimit, b.ratioLimit ?? 1));
  const [seeding, setSeeding] = useState(() => initialLimit(custom?.seedingTimeLimit, b.seedingTimeLimit ?? 1440));
  const [inactive, setInactive] = useState(() => initialLimit(custom?.inactiveSeedingTimeLimit, b.inactiveSeedingTimeLimit ?? 1440));
  const [shareTouched, setShareTouched] = useState(false);
  const touchShare = () => setShareTouched(true);

  const { busy, error, submit } = useSubmit(async () => {
    const props: SetProps = {};
    if (dlTouched) props.dlLimit = dl;
    if (ulTouched) props.upLimit = ul;
    if (shareTouched && mode) {
      props.shareLimits =
        mode === "global"
          ? { ratio: -2, seedingTime: -2, inactiveSeedingTime: -2 }
          : mode === "none"
            ? { ratio: -1, seedingTime: -1, inactiveSeedingTime: -1 }
            : {
                ratio: ratio.on ? ratio.value : -1,
                seedingTime: seeding.on ? seeding.value : -1,
                inactiveSeedingTime: inactive.on ? inactive.value : -1,
              };
    }
    if (Object.keys(props).length) {
      await api.set(
        ts.map((t) => t.id),
        props,
      );
    }
  }, close);

  const one = ts.length === 1 ? ts[0] : null;
  const mixed = "Different for each";
  const action = ACTIONS[b.seedingLimitAction] ?? ACTIONS.stop;
  return (
    <Modal
      title="Limits & sharing"
      subtitle={one ? <span className="dlg-name">{one.name}</span> : plural(ts.length, "torrent")}
      icon={<Gauge />}
      size="md"
      onClose={close}
      onSubmit={submit}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <section className="dlg-section">
        <h3 className="section-title">Speed limits</h3>
        <div className="field-row">
          <Field label="Download" hint={`Global: ${formatLimit(globalDl)}`}>
            <SpeedInput
              value={dl}
              placeholder={dl0 === undefined && !dlTouched ? mixed : "Unlimited"}
              onChange={(v) => {
                setDl(v);
                setDlTouched(true);
              }}
            />
          </Field>
          <Field label="Upload" hint={`Global: ${formatLimit(globalUl)}`}>
            <SpeedInput
              value={ul}
              placeholder={ul0 === undefined && !ulTouched ? mixed : "Unlimited"}
              onChange={(v) => {
                setUl(v);
                setUlTouched(true);
              }}
            />
          </Field>
        </div>
      </section>

      <section className="dlg-section">
        <h3 className="section-title">Seeding limits</h3>
        {mode === null && !shareTouched && <p className="faint dlg-note">These torrents use different seeding limits.</p>}
        <RadioGroup<ShareMode>
          value={mode ?? ("" as ShareMode)}
          onChange={(m) => {
            setMode(m);
            touchShare();
          }}
          options={[
            { value: "global", label: "Use the global limits", hint: describeGlobal(b) },
            { value: "none", label: "No limits", hint: "Seed until you stop it." },
            { value: "custom", label: "Custom limits" },
          ]}
        />
        {mode === "custom" && (
          <div className="share-limits">
            <LimitRow
              label="Ratio reaches"
              limit={ratio}
              float
              step={0.1}
              suffix=""
              onChange={(l) => {
                setRatio(l);
                touchShare();
              }}
            />
            <LimitRow
              label="Seeding time reaches"
              limit={seeding}
              suffix="min"
              onChange={(l) => {
                setSeeding(l);
                touchShare();
              }}
            />
            <LimitRow
              label="Inactive for"
              limit={inactive}
              suffix="min"
              onChange={(l) => {
                setInactive(l);
                touchShare();
              }}
            />
            <p className="faint dlg-note">When a limit is reached, {action}. Change that in Settings › BitTorrent.</p>
          </div>
        )}
      </section>
      {error && <div className="callout error">{error}</div>}
    </Modal>
  );
}

function LimitRow({
  label,
  limit,
  onChange,
  suffix,
  float,
  step,
}: {
  label: string;
  limit: Limit;
  onChange: (l: Limit) => void;
  suffix: string;
  float?: boolean;
  step?: number;
}) {
  return (
    <div className="limit-row">
      <Checkbox checked={limit.on} onChange={(on) => onChange({ ...limit, on })} label={label} />
      <NumberInput
        sm
        value={limit.value}
        min={0}
        float={float}
        step={step}
        suffix={suffix || undefined}
        disabled={!limit.on}
        onChange={(value) => onChange({ ...limit, value })}
        aria-label={label}
      />
    </div>
  );
}
