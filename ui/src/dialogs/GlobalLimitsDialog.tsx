import { useState } from "react";
import { Gauge, Turtle } from "lucide-react";
import { api } from "../api/client";
import { Button } from "../components/ui/Button";
import { Field, SpeedInput, Switch } from "../components/ui/Form";
import { Modal } from "../components/ui/Modal";
import { useStore } from "../store/store";
import { openSettings } from "../views/settings/draft";
import type { DialogProps } from "./DialogHost";
import { useSubmit } from "./useSubmit";

export interface GlobalLimitsSpec {
  type: "globalLimits";
}

type Key = "dlLimit" | "upLimit" | "altDlLimit" | "altUpLimit";

/** The status bar's speed limits: normal and alternative, and which set is in use. */
export function GlobalLimitsDialog({ close }: DialogProps<GlobalLimitsSpec>) {
  const [initial] = useState(() => {
    const s = useStore.getState().prefs?.speed ?? {};
    return {
      dlLimit: Number(s.dlLimit ?? 0),
      upLimit: Number(s.upLimit ?? 0),
      altDlLimit: Number(s.altDlLimit ?? 0),
      altUpLimit: Number(s.altUpLimit ?? 0),
      alt: !!useStore.getState().server?.altSpeed,
      schedule: !!s.scheduleEnabled,
    };
  });
  const [v, setV] = useState<Record<Key, number>>(initial);
  const [alt, setAlt] = useState(initial.alt);
  const set = (k: Key) => (bytes: number) => setV((cur) => ({ ...cur, [k]: bytes }));

  const { busy, error, submit } = useSubmit(async () => {
    const patch: Record<string, number> = {};
    for (const k of ["dlLimit", "upLimit", "altDlLimit", "altUpLimit"] as const) {
      if (v[k] !== initial[k]) patch[k] = v[k];
    }
    if (Object.keys(patch).length) await api.setPrefs({ speed: patch });
    if (alt !== initial.alt) await api.setAltSpeed(alt);
  }, close);

  return (
    <Modal
      title="Speed limits"
      subtitle="For all torrents together. Leave a box empty for no limit."
      icon={<Gauge />}
      size="md"
      onClose={close}
      onSubmit={submit}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              close();
              openSettings("speed");
            }}
          >
            Schedule & more
          </Button>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <section className={`dlg-section limit-set${alt ? "" : " active"}`}>
        <h3 className="section-title">Normal</h3>
        <div className="field-row">
          <Field label="Download">
            <SpeedInput value={v.dlLimit} onChange={set("dlLimit")} />
          </Field>
          <Field label="Upload">
            <SpeedInput value={v.upLimit} onChange={set("upLimit")} />
          </Field>
        </div>
      </section>
      <section className={`dlg-section limit-set${alt ? " active" : ""}`}>
        <h3 className="section-title">
          <Turtle /> Alternative
        </h3>
        <div className="field-row">
          <Field label="Download">
            <SpeedInput value={v.altDlLimit} onChange={set("altDlLimit")} />
          </Field>
          <Field label="Upload">
            <SpeedInput value={v.altUpLimit} onChange={set("altUpLimit")} />
          </Field>
        </div>
      </section>
      <Switch
        checked={alt}
        onChange={setAlt}
        label="Use the alternative limits now"
        hint={
          initial.schedule
            ? "A schedule is set, so Promethea also switches them on and off by itself."
            : "Handy when you need the bandwidth for something else for a while."
        }
      />
      {error && <div className="callout error">{error}</div>}
    </Modal>
  );
}
