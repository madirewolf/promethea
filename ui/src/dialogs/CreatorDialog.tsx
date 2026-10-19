import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { CircleAlert, CircleCheck, File, Folder, FolderOpen, Wand } from "lucide-react";
import { ApiError, api } from "../api/client";
import type { CreatorJob, CreatorOptions, CreatorSource, TorrentFormat } from "../api/types";
import { Button } from "../components/ui/Button";
import { Checkbox, Field, Input, Segmented, Select, Textarea } from "../components/ui/Form";
import { Modal } from "../components/ui/Modal";
import { PathInput, Progress, Spinner } from "../components/ui/Misc";
import { formatBytes, formatPercent, plural } from "../lib/format";
import { useDebounced, useEvent } from "../lib/hooks";
import { baseName, joinPath, parentPath } from "../lib/paths";
import { toastError, useStore } from "../store/store";
import { confirm } from "./ConfirmDialog";
import type { DialogProps } from "./DialogHost";

export interface CreatorSpec {
  type: "creator";
  /** A file or folder to start with, instead of the last one shared. */
  source?: string;
}

/** Auto, then 16 KiB to 128 MiB: the sizes libtorrent will load. */
const PIECE_SIZES = [0, ...Array.from({ length: 14 }, (_, i) => 16384 * 2 ** i)];

const FORMATS: { value: TorrentFormat; label: string; hint: string }[] = [
  { value: "hybrid", label: "Hybrid", hint: "Works in every client, and v2 clients also get its per-file hashes." },
  { value: "v1", label: "v1", hint: "The original format, which every client reads. The smallest .torrent file." },
  { value: "v2", label: "v2", hint: "Only clients with BitTorrent v2 support can open it, like qBittorrent 4.4 and later." },
];

// ------------------------------------------------------------------ remembered settings
const STORE_KEY = "promethea.creator.v1";

const DEFAULTS: CreatorOptions = {
  format: "hybrid",
  pieceSize: 0,
  private: false,
  startSeeding: true,
  ignoreShareLimits: false,
  trackers: "",
  urlSeeds: "",
  comment: "",
  source: "",
};

interface Saved {
  options: CreatorOptions;
  /** The last file or folder shared, and the folder its .torrent file went to. */
  source: string;
  outputDir: string;
}

function loadSaved(): Saved {
  let raw: any = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
  } catch {
    /* unreadable or blocked: the defaults */
  }
  const o = raw && typeof raw.options === "object" && raw.options ? raw.options : {};
  const picked = Object.fromEntries(
    (Object.keys(DEFAULTS) as (keyof CreatorOptions)[]).filter((k) => typeof o[k] === typeof DEFAULTS[k]).map((k) => [k, o[k]]),
  );
  const options: CreatorOptions = { ...DEFAULTS, ...picked };
  if (!FORMATS.some((f) => f.value === options.format)) options.format = DEFAULTS.format;
  if (!PIECE_SIZES.includes(options.pieceSize)) options.pieceSize = 0;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return { options, source: str(raw?.source), outputDir: str(raw?.outputDir) };
}

function store(saved: Saved): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
  } catch {
    /* storage blocked: nothing to remember */
  }
}

// ------------------------------------------------------------------ helpers
/** The server's messages start in lower case. */
function errorText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The first line (1-based) that isn't a web address, or 0. */
function badLine(text: string): number {
  return text.split("\n").findIndex((l) => l.trim() && !/^[a-z][a-z0-9+.-]*:\/\/\S/i.test(l.trim())) + 1;
}

function describe(s: CreatorSource): string {
  if (s.partial) return `More than ${plural(s.files, "file")} and ${formatBytes(s.size)}`;
  return [s.isDir && plural(s.files, "file"), formatBytes(s.size), `${plural(s.numPieces, "piece")} of ${formatBytes(s.pieceSize, 0)}`]
    .filter(Boolean)
    .join(" · ");
}

// ------------------------------------------------------------------ dialog
export function CreatorDialog({ spec, close }: DialogProps<CreatorSpec>) {
  const saved = useMemo(loadSaved, []);
  const desktop = useStore((s) => !!s.app?.desktop);
  const ids = {
    source: useId(),
    output: useId(),
    piece: useId(),
    trackers: useId(),
    seeds: useId(),
    comment: useId(),
    infoSource: useId(),
  };

  const [source, setSource] = useState(spec.source ?? saved.source);
  const [output, setOutput] = useState("");
  const [opts, setOpts] = useState(saved.options);
  const set = <K extends keyof CreatorOptions>(key: K, value: CreatorOptions[K]) => setOpts((o) => ({ ...o, [key]: value }));
  // The .torrent goes next to what's shared, or where the last one went, until it's edited.
  const outputEdited = useRef(false);
  const outputDir = useRef(saved.outputDir);

  const [job, setJob] = useState<CreatorJob | null>(null);
  const jobRef = useRef(job);
  jobRef.current = job;
  // Every job's latest state, in case an update beats the answer that started it.
  const latest = useRef(new Map<string, CreatorJob>());
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [touched, setTouched] = useState(false);
  const [requestError, setRequestError] = useState("");

  const src = source.trim();
  const out = output.trim();

  // ---- the preview: files, size and pieces of what's picked
  const query = useDebounced(src, 350);
  const [preview, setPreview] = useState<{ path: string; info: CreatorSource | null; error: string }>({
    path: "",
    info: null,
    error: "",
  });
  const [reading, setReading] = useState(false);
  // Look again when the window gets focus back: files may have been added or moved meanwhile.
  const [recheck, setRecheck] = useState(0);
  useEffect(() => {
    const onFocus = () => setRecheck((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    if (!query) {
      setPreview({ path: "", info: null, error: "" });
      setReading(false);
      return;
    }
    let alive = true;
    setReading(true);
    api
      .inspectSource(query, { format: opts.format, pieceSize: opts.pieceSize })
      .then((info) => alive && setPreview({ path: query, info, error: "" }))
      .catch((e) => alive && setPreview({ path: query, info: null, error: errorText(e) }))
      .finally(() => alive && setReading(false));
    return () => {
      alive = false;
    };
  }, [query, opts.format, opts.pieceSize, recheck]);
  const shown = preview.path === src ? preview : null;

  useEffect(() => {
    if (outputEdited.current) return;
    const name = baseName(src);
    const dir = outputDir.current || parentPath(src);
    setOutput(!name ? "" : dir ? joinPath(dir, `${name}.torrent`) : `${name}.torrent`);
  }, [src]);

  // ---- a job started before the dialog was (re)opened
  useEffect(() => {
    let alive = true;
    api
      .creatorJobs()
      .then((jobs) => {
        const running = jobs.filter((j) => j.status === "running").sort((a, b) => b.started - a.started)[0];
        if (!alive || !running || jobRef.current) return;
        outputEdited.current = true;
        setSource(running.source);
        setOutput(running.output);
        setJob(running);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEvent("creator", (j: CreatorJob) => {
    latest.current.set(j.id, j);
    setJob((cur) => (cur?.id === j.id ? j : cur));
  });

  const active = job?.status === "running" ? job : null;
  const done = job?.status === "done" ? job : null;
  const failed = job?.status === "error" ? errorText(job.error) : "";
  useEffect(() => {
    if (!active) setStopping(false);
  }, [active]);

  // ---- checks
  const trackerLine = badLine(opts.trackers);
  const seedLine = badLine(opts.urlSeeds);
  const invalid = !src || !out || !!shown?.error || !!trackerLine || !!seedLine;

  const submit = async () => {
    setTouched(true);
    if (active || done || submitting || invalid) return;
    setSubmitting(true);
    setRequestError("");
    try {
      let started: CreatorJob;
      try {
        started = await api.createTorrent(src, out, opts);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409 && (e.data as { exists?: boolean } | null)?.exists)) throw e;
        const file = /\.torrent$/i.test(out) ? out : `${out}.torrent`;
        const replace = await confirm({
          title: `Replace ${baseName(file)}?`,
          message: `There's a file with that name in ${parentPath(file) || "that folder"} already.`,
          confirmLabel: "Replace",
          danger: true,
        });
        if (!replace) return;
        started = await api.createTorrent(src, out, opts, true);
      }
      outputDir.current = parentPath(started.output);
      store({ options: opts, source: src, outputDir: outputDir.current });
      setOutput(started.output);
      setJob(latest.current.get(started.id) ?? started);
    } catch (e) {
      setRequestError(errorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  const finish = () => {
    store({ options: opts, source: src, outputDir: outputDir.current });
    close();
  };

  const stop = () => {
    if (!active) return;
    setStopping(true);
    api.cancelCreator(active.id).catch((e) => {
      setStopping(false);
      toastError(e);
    });
  };

  const again = () => {
    setJob(null);
    setTouched(false);
    window.setTimeout(() => document.getElementById(ids.source)?.focus(), 0);
  };

  /** The desktop app's file and folder pickers, opened where the current path points. */
  const pick = async (kind: "open" | "folder") => {
    const isDir = shown?.info?.isDir;
    const start = !src ? "" : kind === "folder" ? (isDir === false ? parentPath(src) : src) : isDir ? src : parentPath(src);
    try {
      const paths = await api.dialog({
        kind,
        title: kind === "folder" ? "Choose a folder to share" : "Choose a file to share",
        directory: start || undefined,
      });
      if (paths[0]) setSource(paths[0]);
    } catch {
      /* dialog closed */
    }
  };

  const submitOnCtrlEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  // ---- what the fields say
  let sourceHint: ReactNode = "A file, or a folder with everything in it. Hidden files in a folder are left out.";
  if (shown?.info) sourceHint = describe(shown.info);
  else if (src && (reading || src !== query))
    sourceHint = (
      <span className="row creator-reading">
        <Spinner size={12} /> Counting files…
      </span>
    );
  const sourceError = (touched && !src && "Choose a file or folder to share") || shown?.error || undefined;
  const auto = shown?.info && !shown.info.partial && opts.pieceSize === 0 ? shown.info.pieceSize : 0;
  const pieceOptions = PIECE_SIZES.map((v) => ({
    value: v,
    label: v ? formatBytes(v, 0) : auto ? `Auto (${formatBytes(auto, 0)})` : "Auto",
  }));

  const footer = active ? (
    <>
      <div className="creator-progress grow">
        <Progress value={active.progress} size="lg" className={active.numPieces ? "accent" : "accent indeterminate"} />
        <span className="faint">{active.numPieces ? `Hashing… ${formatPercent(active.progress, 0)}` : "Reading files…"}</span>
      </div>
      <Button onClick={stop} loading={stopping}>
        Stop
      </Button>
      <Button onClick={finish} tip="It keeps going, and you'll get a notice when it's done">
        Close
      </Button>
    </>
  ) : done ? (
    <>
      {desktop && (
        <Button icon={<FolderOpen />} onClick={() => api.revealCreated(done.id).catch((e) => toastError(e))}>
          Show in folder
        </Button>
      )}
      <span className="spacer" />
      <Button onClick={again}>Create another</Button>
      <Button variant="primary" onClick={finish}>
        Done
      </Button>
    </>
  ) : (
    <>
      {job?.status === "cancelled" && <span className="faint dlg-foot-note">Stopped. Nothing was saved.</span>}
      <span className="spacer" />
      <Button onClick={finish}>Cancel</Button>
      <Button type="submit" variant="primary" icon={<Wand />} loading={submitting} disabled={touched && invalid}>
        Create torrent
      </Button>
    </>
  );

  return (
    <Modal title="Create a torrent" icon={<Wand />} size="lg" className="creator-dialog" onClose={finish} onSubmit={() => void submit()} footer={footer}>
      {done && (
        <div className="callout success" role="status">
          <CircleCheck />
          <div className="grow">
            <div>
              <b>{baseName(done.output)}</b> is ready{done.seed ? ", and seeding" : ""}.
            </div>
            <div className="faint mono-ish creator-done-path">{parentPath(done.output)}</div>
          </div>
        </div>
      )}
      {(failed || requestError) && (
        <div className="callout error" role="alert">
          <CircleAlert />
          <div>{failed || requestError}</div>
        </div>
      )}
      <fieldset className="creator-form" disabled={!!active || !!done || submitting}>
        <Field label="File or folder to share" htmlFor={ids.source} error={sourceError} hint={sourceHint}>
          <div className="creator-source">
            <PathInput id={ids.source} value={source} onChange={setSource} browse={false} invalid={!!sourceError} />
            {desktop && (
              <>
                <Button icon={<File />} onClick={() => void pick("open")}>
                  File…
                </Button>
                <Button icon={<Folder />} onClick={() => void pick("folder")}>
                  Folder…
                </Button>
              </>
            )}
          </div>
        </Field>
        <Field
          label="Save the .torrent file as"
          htmlFor={ids.output}
          error={touched && !out ? "Choose where to save the .torrent file" : undefined}
        >
          <PathInput
            id={ids.output}
            kind="save"
            value={output}
            onChange={(v) => {
              outputEdited.current = true;
              setOutput(v);
            }}
            dialogTitle="Save the torrent file as"
            fileTypes={["Torrent files (*.torrent)"]}
            saveName={`${baseName(src) || "New torrent"}.torrent`}
            invalid={touched && !out}
          />
        </Field>

        <div className="creator-cols">
          <section>
            <div className="section-title">Settings</div>
            <Field label="Format" hint={FORMATS.find((f) => f.value === opts.format)?.hint}>
              <Segmented value={opts.format} onChange={(v) => set("format", v)} options={FORMATS.map(({ value, label }) => ({ value, label }))} />
            </Field>
            <Field label="Piece size" htmlFor={ids.piece}>
              <Select id={ids.piece} value={opts.pieceSize} options={pieceOptions} onChange={(v) => set("pieceSize", v)} />
            </Field>
            <div className="dlg-checks">
              <Checkbox
                checked={opts.private}
                onChange={(v) => set("private", v)}
                label="Private torrent"
                hint="Peers only come from its trackers: no DHT, peer exchange or local discovery."
              />
              <Checkbox
                checked={opts.startSeeding}
                onChange={(v) => set("startSeeding", v)}
                label="Start seeding it"
                hint="Adds it to your transfers, seeding from where the files are."
              />
              <Checkbox
                className="creator-sub"
                checked={opts.ignoreShareLimits}
                disabled={!opts.startSeeding}
                onChange={(v) => set("ignoreShareLimits", v)}
                label="Ignore share limits"
                hint="Keep seeding past the ratio and seeding time limits."
              />
            </div>
          </section>

          <section>
            <div className="section-title">Trackers and details</div>
            <Field
              label="Trackers"
              htmlFor={ids.trackers}
              error={touched && trackerLine ? `Line ${trackerLine} isn't a web address` : undefined}
              hint="One per line. A blank line starts a new tier."
            >
              <Textarea
                id={ids.trackers}
                className={touched && trackerLine ? "invalid" : undefined}
                mono
                rows={4}
                value={opts.trackers}
                placeholder="udp://tracker.example.org:6969/announce"
                onChange={(e) => set("trackers", e.target.value)}
                onKeyDown={submitOnCtrlEnter}
              />
            </Field>
            <Field
              label="Web seeds"
              htmlFor={ids.seeds}
              error={touched && seedLine ? `Line ${seedLine} isn't a web address` : undefined}
              hint="Web addresses that serve the same files, one per line."
            >
              <Textarea
                id={ids.seeds}
                className={touched && seedLine ? "invalid" : undefined}
                mono
                rows={2}
                value={opts.urlSeeds}
                placeholder="https://example.org/files/"
                onChange={(e) => set("urlSeeds", e.target.value)}
                onKeyDown={submitOnCtrlEnter}
              />
            </Field>
            <Field label="Comment" htmlFor={ids.comment}>
              <Input id={ids.comment} value={opts.comment} onChange={(e) => set("comment", e.target.value)} />
            </Field>
            <Field label="Source" htmlFor={ids.infoSource} hint="Some private trackers ask for this. It changes the info hash.">
              <Input id={ids.infoSource} value={opts.source} onChange={(e) => set("source", e.target.value)} />
            </Field>
          </section>
        </div>
      </fieldset>
    </Modal>
  );
}
