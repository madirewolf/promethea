import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CircleHelp, Copy, FilePlus2, Info, ListChecks, ListX, Magnet } from "lucide-react";
import { api } from "../api/client";
import type { AddOptions, ContentLayout, InspectInfo, StopCondition } from "../api/types";
import { FileTree } from "../components/FileTree";
import { parentPath } from "../components/treeModel";
import type { TreeFile, TreeNode } from "../components/treeModel";
import { Button, IconButton } from "../components/ui/Button";
import { Checkbox, Field, Input, SearchInput, Select, TagsInput } from "../components/ui/Form";
import type { Option } from "../components/ui/Form";
import { Modal } from "../components/ui/Modal";
import { Empty, PathInput, Spinner } from "../components/ui/Misc";
import { copyText } from "../lib/actions";
import { reportAdd } from "../lib/add";
import { formatBytes, formatDate, plural } from "../lib/format";
import { categoryFolder, recentPaths, rememberPath } from "../lib/paths";
import { shiftAdd, toast, toastError, useStore } from "../store/store";
import type { PendingAdd } from "../store/store";
import { FieldError, useSubmit } from "./useSubmit";

// ------------------------------------------------------------------ layout
/** The one folder every file sits in, or null. */
function rootOf(paths: readonly string[]): string | null {
  let root: string | null = null;
  for (const p of paths) {
    const i = p.indexOf("/");
    if (i < 0) return null;
    const r = p.slice(0, i);
    if (root == null) root = r;
    else if (r !== root) return null;
  }
  return root;
}

function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** Rewrite the paths for a content layout the way the server would (qBittorrent's rules). */
function applyLayout(files: TreeFile[], layout: ContentLayout, info: InspectInfo): TreeFile[] {
  const cur = rootOf(files.map((f) => f.path));
  const orig = rootOf(info.files.map((f) => f.path));
  let add: string | null = null;
  let strip = false;
  if (layout === "noSubfolder") strip = cur != null;
  else if (layout === "subfolder") {
    if (cur == null) add = orig ?? (info.files.length === 1 ? stripExt(info.name) : info.name);
  } else if (cur == null && orig != null) add = orig;
  else if (cur != null && orig == null) strip = true;
  if (strip && cur != null) return files.map((f) => ({ ...f, path: f.path.slice(cur.length + 1) }));
  if (add) return files.map((f) => ({ ...f, path: `${add}/${f.path}` }));
  return files;
}

// ------------------------------------------------------------------ excluded names
/** fnmatch-style glob (* ? [seq] [!seq]) as a regex, like the server's check. */
function globRegex(glob: string): RegExp | null {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const j = glob.indexOf("]", i + 2);
      if (j < 0) re += "\\[";
      else {
        let body = glob.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        else if (body.startsWith("^")) body = `\\${body}`;
        re += `[${body}]`;
        i = j;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`, "is");
  } catch {
    return null;
  }
}

function excludedMatcher(patterns: string): (path: string) => boolean {
  const res = patterns
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(globRegex)
    .filter((r): r is RegExp => r != null);
  if (!res.length) return () => false;
  return (path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return res.some((r) => r.test(name) || r.test(path));
  };
}

function initialFiles(info: InspectInfo, layout: ContentLayout, excluded: string): TreeFile[] {
  const skip = excludedMatcher(excluded);
  const files = info.files.map((f) => ({ index: f.index, path: f.path, size: f.size, priority: skip(f.path) ? 0 : 4 }));
  return applyLayout(files, layout, info);
}

// ------------------------------------------------------------------ dialog
const LAYOUTS: Option<ContentLayout>[] = [
  { value: "original", label: "Original" },
  { value: "subfolder", label: "Create a subfolder" },
  { value: "noSubfolder", label: "Don't create a subfolder" },
];

/** The add dialog for the first torrent waiting in the queue (dropped files, pasted links, ...). */
export function AddTorrentHost() {
  const first = useStore((s) => s.addQueue[0]);
  const waiting = useStore((s) => s.addQueue.length);
  if (!first) return null;
  if (first.info.alreadyAdded) return <AlreadyAddedDialog key={first.key} pending={first} />;
  return <AddTorrentDialog key={first.key} pending={first} more={waiting - 1} />;
}

function cancelPending(pending: PendingAdd): void {
  api.cancelInspect(pending.info.token).catch(() => undefined);
  shiftAdd(pending.key);
}

/** Adding a torrent that's already in the list can only give it new trackers and web seeds. */
function AlreadyAddedDialog({ pending }: { pending: PendingAdd }) {
  const { info } = pending;
  const name = info.existingName || info.name || "This torrent";
  const source = info.hasMetadata ? "file" : "link";
  const what = [info.trackers.length ? "trackers" : "", info.webSeeds?.length ? "web seeds" : ""].filter(Boolean).join(" and ");
  const canMerge = !info.existingPrivate && !!what;
  const cancel = () => cancelPending(pending);

  const { busy, error, submit } = useSubmit(
    async () => {
      const res = await api.addToken(info.token, {});
      if (res.errors.length) throw new Error(res.errors[0].error);
      const dup = res.duplicates[0];
      // Removed from the list meanwhile: then it was simply added again.
      if (!dup) return reportAdd(res);
      const got = [dup.trackers ? plural(dup.trackers, "tracker") : "", dup.webSeeds ? plural(dup.webSeeds, "web seed") : ""];
      const added = got.filter(Boolean).join(" and ");
      if (added) toast("success", `Added ${added} to “${name}”`, { ms: 3000 });
      else toast("info", `“${name}” already has all of these ${what}`, { ms: 3000 });
    },
    () => shiftAdd(pending.key),
  );

  return (
    <Modal
      title="Already in your list"
      subtitle={<span className="dlg-name">{name}</span>}
      icon={canMerge ? <CircleHelp /> : <Info />}
      size="sm"
      onClose={cancel}
      onSubmit={canMerge ? submit : cancel}
      footer={
        <>
          <span className="spacer" />
          {canMerge && <Button onClick={cancel}>Cancel</Button>}
          <Button type="submit" variant="primary" loading={busy}>
            {canMerge ? `Add ${what}` : "OK"}
          </Button>
        </>
      }
    >
      <p className="muted">
        {info.existingPrivate
          ? "It's a private torrent, so it only uses its own trackers."
          : canMerge
            ? `Add any new ${what} from this ${source} to it?`
            : `This ${source} has no trackers or web seeds to add to it.`}
      </p>
      {error && <div className="callout error">{error}</div>}
    </Modal>
  );
}

function AddTorrentDialog({ pending, more }: { pending: PendingAdd; more: number }) {
  const { info } = pending;
  const categories = useStore((s) => s.categories);
  const allTags = useStore((s) => s.tags);
  const ids = { save: useId(), cat: useId(), tags: useId() };
  // The defaults when the dialog opened; saving settings meanwhile doesn't reset what's typed here.
  const [d] = useState(() => useStore.getState().prefs?.downloads ?? {});
  const [recent] = useState(recentPaths);
  const base: string = d.savePath ?? "";
  const excluded: string = d.excludedFileNames ?? "";

  const [autoTMM, setAutoTMM] = useState<boolean>(!!d.autoTMM);
  const [category, setCategory] = useState("");
  const [savePath, setSavePath] = useState(base);
  const [useTemp, setUseTemp] = useState<boolean>(!!d.useIncompletePath);
  const [tempPath, setTempPath] = useState<string>(d.incompletePath ?? "");
  const [tags, setTags] = useState<string[]>([]);
  const [start, setStart] = useState<boolean>(!d.startPaused);
  const [stopWhen, setStopWhen] = useState<StopCondition>(() => {
    const s = (d.stopCondition as StopCondition) ?? "none";
    return s === "metadata" && info.hasMetadata ? "none" : s;
  });
  const [layout, setLayout] = useState<ContentLayout>((d.contentLayout as ContentLayout) ?? "original");
  const [addToTop, setAddToTop] = useState<boolean>(!!d.addToTop);
  const [sequential, setSequential] = useState(false);
  const [firstLast, setFirstLast] = useState(false);
  const [skipCheck, setSkipCheck] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const [filter, setFilter] = useState("");
  const [files, setFiles] = useState<TreeFile[]>(() => (info.hasMetadata ? initialFiles(info, layout, excluded) : []));

  // A magnet's file list arrives while the dialog is open.
  const hasMeta = info.hasMetadata;
  const seeded = useRef(hasMeta);
  useEffect(() => {
    if (!hasMeta || seeded.current) return;
    seeded.current = true;
    setFiles(initialFiles(info, layout, excluded));
    setStopWhen((s) => (s === "metadata" ? "none" : s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMeta]);

  const cat = category.trim();
  const catError = cat && (cat.startsWith("/") || cat.endsWith("/") || cat.includes("//")) ? "Use “/” only between subcategory names, like Movies/HD" : null;
  const autoPath = cat ? categories[cat]?.resolvedPath || categoryFolder(base, cat) : base;

  const wanted = useMemo(() => {
    let size = 0;
    let count = 0;
    for (const f of files) {
      if (f.priority > 0) {
        size += f.size;
        count++;
      }
    }
    return { size, count };
  }, [files]);

  const changeLayout = (l: ContentLayout) => {
    setLayout(l);
    setFiles((fs) => (fs.length ? applyLayout(fs, l, info) : fs));
  };

  const onPriority = (fs: TreeFile[], priority: number) => {
    const set = new Set(fs.map((f) => f.index));
    setFiles((cur) => cur.map((f) => (set.has(f.index) ? { ...f, priority } : f)));
  };

  const onRename = (node: TreeNode, name: string) => {
    const old = node.path;
    const parent = parentPath(node);
    const next = parent ? `${parent}/${name}` : name;
    if (next === old) return;
    const moves = (f: TreeFile) => (node.folder ? f.path.startsWith(`${old}/`) : f.index === node.file?.index);
    setFiles((cur) => cur.map((f) => (moves(f) ? { ...f, path: next + f.path.slice(old.length) } : f)));
  };

  const setAll = (want: boolean) => setFiles((cur) => cur.map((f) => ({ ...f, priority: want ? f.priority || 4 : 0 })));

  /** Options for this torrent (with the file choices) or another queued one ("Add all"). */
  const optionsFor = (target: InspectInfo, mine: boolean): AddOptions => {
    const o: AddOptions = {
      autoTMM,
      savePath: autoTMM ? null : savePath.trim() || null,
      useDownloadPath: useTemp,
      downloadPath: useTemp ? tempPath.trim() || null : null,
      category: cat || null,
      tags,
      paused: !start,
      stopCondition: !start || (stopWhen === "metadata" && target.hasMetadata) ? "none" : stopWhen,
      addToTop,
      sequential,
      firstLast,
      contentLayout: layout,
    };
    if (mine && target.hasMetadata && files.length) {
      // The tree already shows the layout, renames and skipped files: send exactly that.
      const orig = new Map(target.files.map((f) => [f.index, f.path]));
      const renames: Record<number, string> = {};
      const priorities: Record<number, number> = {};
      for (const f of files) {
        if (orig.get(f.index) !== f.path) renames[f.index] = f.path;
        priorities[f.index] = f.priority;
      }
      o.contentLayout = "original";
      o.renames = renames;
      o.filePriorities = priorities;
      o.skipChecking = skipCheck;
      const root = rootOf(files.map((f) => f.path));
      const origRoot = rootOf(target.files.map((f) => f.path));
      // Renaming the top folder renames the torrent in the list too.
      if (root && origRoot && root !== origRoot) o.name = root;
    }
    return o;
  };

  const allRef = useRef(false);
  const { busy, error, submit } = useSubmit(
    async () => {
      if (catError) throw new FieldError(catError);
      if (hasMeta && !wanted.count) throw new Error("Choose at least one file to download");
      const res = await api.addToken(info.token, optionsFor(info, true));
      if (res.errors.length) throw new Error(res.errors[0].error);
      reportAdd(res, { quiet: true });
      if (!autoTMM) rememberPath(savePath);
      if (dontAsk) {
        api.setPrefs({ downloads: { showAddDialog: false } }).catch((e: unknown) => toastError(e, "Couldn't save that setting"));
      }
      if (allRef.current) await addRest();
    },
    () => shiftAdd(pending.key),
  );

  /** "Add all": the other queued torrents with the same settings and all of their files. */
  const addRest = async () => {
    const rest = useStore.getState().addQueue.filter((p) => p.key !== pending.key);
    const results = await Promise.allSettled(rest.map((p) => api.addToken(p.info.token, optionsFor(p.info, false))));
    let added = 1;
    results.forEach((r, i) => {
      shiftAdd(rest[i].key);
      if (r.status === "fulfilled") {
        added += r.value.added.length;
        reportAdd(r.value, { quiet: true });
      } else toastError(r.reason, `Couldn't add ${rest[i].info.name}`);
    });
    if (added > 1) toast("success", `Added ${plural(added, "torrent")}`, { ms: 2500 });
  };

  const cancel = () => cancelPending(pending);

  const hash = info.infohashV1 || info.infohashV2;
  const target = autoTMM ? autoPath : savePath;

  return (
    <Modal
      title={info.name || "Torrent"}
      subtitle={
        hasMeta ? (
          `${formatBytes(info.totalSize)} · ${plural(info.files.length, "file")}`
        ) : (
          <span className="row add-waiting">
            <Spinner size={12} /> Magnet link · getting the file list from peers
          </span>
        )
      }
      icon={hasMeta ? <FilePlus2 /> : <Magnet />}
      size="xl"
      className="add-dialog"
      dismissable={false}
      onClose={cancel}
      onSubmit={() => {
        allRef.current = false;
        submit();
      }}
      footer={
        <>
          <Checkbox checked={dontAsk} onChange={setDontAsk} label="Don't show this again" />
          <span className="spacer" />
          {more > 0 && <span className="faint add-more">{plural(more, "more torrent")} waiting</span>}
          <Button onClick={cancel}>Cancel</Button>
          {more > 0 && (
            <Button
              loading={busy && allRef.current}
              disabled={busy}
              onClick={() => {
                allRef.current = true;
                submit();
              }}
            >
              Add all {more + 1}
            </Button>
          )}
          <Button type="submit" variant="primary" loading={busy && !allRef.current} disabled={busy} data-autofocus>
            Add
          </Button>
        </>
      }
    >
      <div className="add-form">
        <Field label="Save to" htmlFor={ids.save}>
          <PathInput
            id={ids.save}
            value={target}
            onChange={setSavePath}
            disabled={autoTMM}
            recent={recent}
            showFreeSpace
            needed={hasMeta && !useTemp ? wanted.size : undefined}
          />
        </Field>
        <Checkbox
          checked={autoTMM}
          onChange={setAutoTMM}
          label="Manage the folder automatically"
          hint="Saves into the category's folder, and moves the files when the category changes."
        />
        <Checkbox checked={useTemp} onChange={setUseTemp} label="Keep unfinished downloads in another folder" />
        {useTemp && (
          <PathInput
            value={tempPath}
            onChange={setTempPath}
            placeholder="Folder for unfinished downloads"
            showFreeSpace
            needed={hasMeta ? wanted.size : undefined}
          />
        )}
        <div className="field-row">
          <Field label="Category" htmlFor={ids.cat} error={catError ?? undefined}>
            <Input
              id={ids.cat}
              list="add-categories"
              value={category}
              invalid={!!catError}
              placeholder="None"
              onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id="add-categories">
              {Object.keys(categories)
                .sort((a, b) => a.localeCompare(b))
                .map((c) => (
                  <option key={c} value={c} />
                ))}
            </datalist>
          </Field>
          <Field label="Tags" htmlFor={ids.tags}>
            <TagsInput id={ids.tags} value={tags} onChange={setTags} suggestions={allTags} placeholder="None" />
          </Field>
        </div>

        <h3 className="section-title">Options</h3>
        <div className="add-start">
          <Checkbox checked={start} onChange={setStart} label="Start the download" />
          <Select<StopCondition>
            sm
            value={start ? stopWhen : "none"}
            disabled={!start}
            aria-label="Stop condition"
            onChange={setStopWhen}
            options={[
              { value: "none", label: "Keep going" },
              ...(hasMeta ? [] : [{ value: "metadata" as const, label: "Stop once it has the file list" }]),
              { value: "checked", label: "Stop after checking files" },
            ]}
          />
        </div>
        <Field label="Content layout">
          <Select<ContentLayout> value={layout} options={LAYOUTS} onChange={changeLayout} />
        </Field>
        <div className="dlg-checks">
          <Checkbox checked={addToTop} onChange={setAddToTop} label="Put it at the top of the queue" />
          <Checkbox checked={sequential} onChange={setSequential} label="Download in order" hint="Good for streaming; slower for the swarm." />
          <Checkbox checked={firstLast} onChange={setFirstLast} label="First and last pieces first" hint="Lets most players preview a video sooner." />
          {hasMeta && (
            <Checkbox
              checked={skipCheck}
              onChange={setSkipCheck}
              label="Skip the hash check"
              hint="Only when the files are already complete in the folder above."
            />
          )}
        </div>
      </div>

      <div className="add-files">
        <div className="add-files-head">
          <span className="add-files-title">Files</span>
          {hasMeta && (
            <span className="faint add-files-stat">
              {wanted.count === files.length
                ? formatBytes(wanted.size)
                : `${wanted.count} of ${files.length} · ${formatBytes(wanted.size)} of ${formatBytes(info.totalSize)}`}
            </span>
          )}
          <span className="spacer" />
          {hasMeta && files.length > 1 && (
            <>
              <SearchInput value={filter} onChange={setFilter} placeholder="Filter" className="add-files-filter" />
              <IconButton label="Download all" size="sm" onClick={() => setAll(true)}>
                <ListChecks />
              </IconButton>
              <IconButton label="Skip all" size="sm" onClick={() => setAll(false)}>
                <ListX />
              </IconButton>
            </>
          )}
        </div>
        {hasMeta ? (
          <FileTree
            files={files}
            stateKey={`add:${info.token}`}
            filter={filter}
            onPriority={onPriority}
            onRename={onRename}
            className="add-tree"
          />
        ) : (
          <Empty icon={<Spinner size={20} />} title="Waiting for the file list…">
            Peers send it within a few seconds. You can add the torrent now; it downloads everything unless you
            choose otherwise later.
          </Empty>
        )}
        {hasMeta && (
          <div className="add-meta">
            {info.private && <span className="chip">Private</span>}
            {info.creationDate > 0 && (
              <span>
                Created {formatDate(info.creationDate)}
                {info.createdBy && ` with ${info.createdBy}`}
              </span>
            )}
            {info.numPieces > 0 && (
              <span>
                {plural(info.numPieces, "piece")} of {formatBytes(info.pieceSize)}
              </span>
            )}
            {hash && (
              <button type="button" className="add-hash mono" data-tip="Copy the info hash" onClick={() => void copyText(hash, "Info hash")}>
                {hash.slice(0, 12)}… <Copy />
              </button>
            )}
          </div>
        )}
        {info.comment && (
          <p className="add-comment selectable" title={info.comment}>
            {info.comment}
          </p>
        )}
      </div>
      {error && <div className="callout error add-error">{error}</div>}
    </Modal>
  );
}
