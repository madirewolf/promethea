import { FolderDown, FolderPlus, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button, IconButton } from "../../../components/ui/Button";
import { Select } from "../../../components/ui/Form";
import { PathInput } from "../../../components/ui/Misc";
import { useStore } from "../../../store/store";
import { Group, OptionalPathPref, PathPref, Row, Section, SelectPref, SwitchPref, TextareaPref, TextPref } from "../controls";
import { usePref } from "../draft";

const D = "downloads";

interface WatchedFolder {
  path: string;
  /** Empty: the default save folder (or the category's). */
  savePath: string;
  category: string;
  /** null: as set under "Adding torrents". */
  paused: boolean | null;
}

const START_OPTIONS = [
  { value: "default", label: "Start as usual" },
  { value: "start", label: "Start right away" },
  { value: "stopped", label: "Add stopped" },
] as const;

type StartMode = (typeof START_OPTIONS)[number]["value"];

function startMode(paused: boolean | null): StartMode {
  return paused == null ? "default" : paused ? "stopped" : "start";
}

function WatchedFolders() {
  const [folders, set, dirty] = usePref<WatchedFolder[]>(D, "watchedFolders");
  const categories = useStore(useShallow((s) => Object.keys(s.categories).sort((a, b) => a.localeCompare(b))));
  const list = folders ?? [];
  const update = (i: number, patch: Partial<WatchedFolder>) => set(list.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const categoryOptions = [{ value: "", label: "No category" }, ...categories.map((c) => ({ value: c, label: c }))];

  return (
    <Row
      label="Watched folders"
      hint={
        <>
          Promethea adds the <code>.torrent</code> files that appear in these folders, then renames them to <code>.added</code>.
        </>
      }
      keywords="monitor automatic scan"
      dirty={dirty}
      stacked
    >
      <div className="set-watch">
        {list.map((f, i) => (
          <div className="set-watch-item" key={i}>
            <div className="set-watch-path">
              <PathInput value={f.path} onChange={(path) => update(i, { path })} placeholder="Folder to watch" />
              <IconButton label="Stop watching this folder" size="sm" onClick={() => set(list.filter((_, j) => j !== i))}>
                <X />
              </IconButton>
            </div>
            <div className="set-watch-opts">
              <PathInput value={f.savePath} onChange={(savePath) => update(i, { savePath })} placeholder="Default save folder" />
              <Select
                value={f.category ?? ""}
                options={categoryOptions}
                onChange={(category) => update(i, { category })}
                aria-label="Category"
              />
              <Select<StartMode>
                value={startMode(f.paused)}
                options={START_OPTIONS}
                onChange={(m) => update(i, { paused: m === "default" ? null : m === "stopped" })}
                aria-label="Start"
              />
            </div>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            icon={<FolderPlus />}
            onClick={() => set([...list, { path: "", savePath: "", category: "", paused: null }])}
          >
            Watch a folder
          </Button>
        </div>
      </div>
    </Row>
  );
}

const PLACEHOLDERS: [string, string][] = [
  ["%N", "Torrent name"],
  ["%L", "Category"],
  ["%G", "Tags, comma-separated"],
  ["%F", "Content path (the file, or the root folder)"],
  ["%R", "Root folder"],
  ["%D", "Save folder"],
  ["%C", "Number of files"],
  ["%Z", "Size in bytes"],
  ["%T", "Current tracker"],
  ["%I", "Info hash v1"],
  ["%J", "Info hash v2"],
  ["%K", "Torrent ID"],
];

function PlaceholderLegend() {
  return (
    <details className="set-legend">
      <summary>Placeholders you can use</summary>
      <dl>
        {PLACEHOLDERS.map(([code, what]) => (
          <div key={code}>
            <dt>
              <code>{code}</code>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p>Put quotes around placeholders that can contain spaces, like “%N”.</p>
    </details>
  );
}

export function DownloadsSection() {
  const local = useStore((s) => !!s.app?.local);
  const windows = useStore((s) => s.app?.platform === "win32");
  const [useIncomplete] = usePref<boolean>(D, "useIncompletePath");
  const example = windows ? `"C:\\Scripts\\done.cmd" "%N" "%F"` : `/usr/local/bin/done.sh "%N" "%F"`;

  return (
    <Section id="downloads" title="Downloads" icon={<FolderDown />}>
      <Group title="Saving">
        <PathPref k={[D, "savePath"]} label="Save new downloads to" keywords="default folder location directory" free />
        <SwitchPref
          k={[D, "useIncompletePath"]}
          label="Keep unfinished downloads in another folder"
          hint="They move to the save folder once they finish."
          keywords="incomplete temporary"
        />
        {useIncomplete && <PathPref k={[D, "incompletePath"]} label="Unfinished downloads go to" keywords="incomplete temporary" sub />}
        <SwitchPref
          k={[D, "autoTMM"]}
          label="Let categories decide the folder"
          hint="New torrents save into their category's folder, and move when you change the category."
          keywords="automatic torrent management tmm"
        />
        <SelectPref
          k={[D, "contentLayout"]}
          label="Folder for multi-file torrents"
          keywords="content layout subfolder"
          options={[
            { value: "original", label: "As in the torrent" },
            { value: "subfolder", label: "Always create one" },
            { value: "noSubfolder", label: "Never create one" },
          ]}
        />
        <SwitchPref
          k={[D, "appendExtension"]}
          label={
            <>
              Add <code>.!sg</code> to unfinished files
            </>
          }
          keywords="extension incomplete"
        />
        <SwitchPref
          k={[D, "preallocate"]}
          label="Allocate disk space up front"
          hint="Reserves the full size when a download starts, so the drive can't fill up halfway."
          keywords="preallocate sparse"
        />
      </Group>

      <Group title="Adding torrents">
        <SwitchPref
          k={[D, "showAddDialog"]}
          label="Show options before adding"
          hint="Pick the folder and the files for each torrent."
          keywords="dialog"
        />
        <SwitchPref k={[D, "startPaused"]} label="Start downloads right away" keywords="paused stopped" invert />
        <SwitchPref k={[D, "addToTop"]} label="Put new torrents at the top of the queue" keywords="priority" />
        <SelectPref
          k={[D, "stopCondition"]}
          label="Stop new torrents once"
          keywords="stop condition"
          options={[
            { value: "none", label: "Never" },
            { value: "metadata", label: "Metadata is received" },
            { value: "checked", label: "Files are checked" },
          ]}
        />
        <TextareaPref
          k={[D, "excludedFileNames"]}
          label="Skip files named"
          hint="One pattern per line; * and ? work as wildcards. Matching files aren't downloaded."
          keywords="exclude filter ignore"
          placeholder={"*.nfo\nthumbs.db"}
          rows={3}
        />
      </Group>

      <Group title="Torrent files">
        <SwitchPref k={[D, "deleteTorrentFile"]} label="Delete the .torrent file once it's added" keywords="remove" />
        <OptionalPathPref k={[D, "copyTorrentTo"]} label="Keep a copy of every .torrent file" keywords="backup export folder" />
        <OptionalPathPref
          k={[D, "copyFinishedTorrentTo"]}
          label="Keep a copy of the .torrent files of finished downloads"
          keywords="backup export folder complete"
        />
        <WatchedFolders />
      </Group>

      <Group title="Finished downloads">
        <SwitchPref
          k={[D, "recheckOnCompletion"]}
          label="Check the files again"
          hint="Catches data that was damaged on its way to the disk."
          keywords="recheck verify hash complete"
        />
      </Group>

      <Group title="Run a program" note={<PlaceholderLegend />}>
        <TextPref
          k={[D, "runOnAdded"]}
          label="When a torrent is added"
          hint={local ? undefined : "Can only be set on the computer Promethea runs on."}
          keywords="external command script"
          placeholder={example}
          disabled={!local}
          mono
          stacked
        />
        <TextPref
          k={[D, "runOnFinished"]}
          label="When a download finishes"
          hint={local ? undefined : "Can only be set on the computer Promethea runs on."}
          keywords="external command script complete"
          placeholder={example}
          disabled={!local}
          mono
          stacked
        />
      </Group>
    </Section>
  );
}
