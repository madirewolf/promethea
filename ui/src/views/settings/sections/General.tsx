import { useState } from "react";
import type { CSSProperties } from "react";
import { Check, Laptop, Moon, SlidersHorizontal, Sun } from "lucide-react";
import { api } from "../../../api/client";
import { Button } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/Form";
import { ACCENTS } from "../../../lib/look";
import { toast, toastError, useStore } from "../../../store/store";
import { Group, Row, Section, SwitchPref, SwitchRow } from "../controls";
import { usePref } from "../draft";

const B = "behavior";

function ThemeRow() {
  const [theme, setTheme, dirty] = usePref<string>(B, "theme");
  return (
    <Row label="Theme" keywords="appearance dark light mode" dirty={dirty}>
      <Segmented
        value={theme}
        onChange={setTheme}
        options={[
          { value: "system", label: "System", icon: <Laptop /> },
          { value: "dark", label: "Dark", icon: <Moon /> },
          { value: "light", label: "Light", icon: <Sun /> },
        ]}
      />
    </Row>
  );
}

function AccentRow() {
  const [accent, setAccent, dirty] = usePref<string>(B, "accent");
  return (
    <Row label="Accent color" keywords="appearance colour" dirty={dirty}>
      <div className="set-swatches" role="radiogroup" aria-label="Accent color">
        {ACCENTS.map((a) => {
          const on = accent === a.value;
          return (
            <button
              key={a.value}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={a.label}
              data-tip={a.label}
              className={`set-swatch${on ? " on" : ""}`}
              style={{ "--swatch": a.color } as CSSProperties}
              onClick={() => setAccent(a.value)}
            >
              {on && <Check />}
            </button>
          );
        })}
      </div>
    </Row>
  );
}

function DensityRow() {
  const [density, setDensity, dirty] = usePref<string>(B, "density");
  return (
    <Row label="Density" hint="Compact fits more torrents on screen." keywords="appearance rows spacing" dirty={dirty}>
      <Segmented
        value={density}
        onChange={setDensity}
        options={[
          { value: "comfortable", label: "Comfortable" },
          { value: "compact", label: "Compact" },
        ]}
      />
    </Row>
  );
}

/** Things that change Windows right away rather than being saved with the rest. */
function SystemIntegration() {
  const app = useStore((s) => s.app);
  const [busy, setBusy] = useState(false);
  if (!app?.desktop || app.platform !== "win32") return null;

  const refresh = () => api.app().then((info) => useStore.setState({ app: info }), () => undefined);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  return (
    <>
      <SwitchRow
        label="Start Promethea when you sign in to Windows"
        hint="It starts minimized. This changes right away."
        keywords="autostart startup boot login"
        checked={!!app.autostart}
        disabled={busy}
        onChange={(on) => void run(() => api.setAutostart(on))}
      />
      <Row
        label="Open torrent files and magnet links with Promethea"
        hint={app.fileAssociation ? "Promethea is the default for .torrent files and magnet links." : "Double-clicking a .torrent file or a magnet link opens it in Promethea."}
        keywords="default association handler"
      >
        {app.fileAssociation ? (
          <span className="set-ok">
            <Check /> Default
          </span>
        ) : (
          <Button
            size="sm"
            loading={busy}
            onClick={() =>
              void run(async () => {
                await api.associate();
                toast("success", "Promethea now opens torrent files and magnet links", { ms: 2500 });
              })
            }
          >
            Make default
          </Button>
        )}
      </Row>
    </>
  );
}

export function GeneralSection() {
  const app = useStore((s) => s.app);
  const desktop = !!app?.desktop;
  const bin = app?.platform === "win32" ? "Recycle Bin" : "Trash";
  return (
    <Section id="general" title="General" icon={<SlidersHorizontal />}>
      <Group title="Appearance">
        <ThemeRow />
        <AccentRow />
        <DensityRow />
      </Group>

      <Group title="Transfer list">
        <SwitchPref k={[B, "confirmDelete"]} label="Ask before removing torrents" keywords="confirm delete" />
        <SwitchPref
          k={[B, "deleteFilesDefault"]}
          label="Also delete the files by default"
          hint="Ticks “Also delete the downloaded files” when you remove a torrent."
          keywords="remove"
        />
        {app?.platform === "win32" && (
          <SwitchPref
            k={[B, "useRecycleBin"]}
            label={`Move deleted files to the ${bin}`}
            hint="So a removal can still be undone."
            keywords="trash recycle"
          />
        )}
        <SwitchPref k={[B, "speedInTitle"]} label="Show speeds in the window title" keywords="taskbar" />
      </Group>

      <Group title="Window" note={desktop ? undefined : "These apply to the desktop app."}>
        <SwitchPref k={[B, "closeToTray"]} label="Closing the window keeps Promethea running in the tray" keywords="system tray close" />
        <SwitchPref k={[B, "minimizeToTray"]} label="Minimize to the tray" keywords="system tray" />
        <SwitchPref k={[B, "startMinimized"]} label="Start minimized" keywords="hidden launch" />
        <SwitchPref
          k={[B, "confirmExitWithActive"]}
          label="Ask before quitting while torrents are active"
          keywords="confirm exit close"
        />
      </Group>

      <Group title="Notifications">
        <SwitchPref k={[B, "notifyOnComplete"]} label="When a download finishes" keywords="notify notification complete done" />
        <SwitchPref k={[B, "notifyOnError"]} label="When a torrent runs into an error" keywords="notify notification" />
      </Group>

      <Group title="System">
        <SwitchPref
          k={[B, "preventSleep"]}
          label="Keep the computer awake while downloading"
          hint="While something is downloading. The screen can still turn off."
          keywords="sleep standby power"
        />
        <SystemIntegration />
      </Group>
    </Section>
  );
}
