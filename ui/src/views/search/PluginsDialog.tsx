// Search plugins: the installed ones (on/off, updates, uninstalling), installing more from
// the official repository, a web address or a file. Also the list of sites a search failed on.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Download,
  ExternalLink,
  FileUp,
  Link,
  MoreHorizontal,
  PackageCheck,
  Plus,
  Puzzle,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api } from "../../api/client";
import type { PluginUpdate, PluginUpdateResult, SearchError, SearchPlugin } from "../../api/types";
import { Button, IconButton } from "../../components/ui/Button";
import { Checkbox, Switch } from "../../components/ui/Form";
import { openDropdown } from "../../components/ui/Menu";
import type { MenuEntry } from "../../components/ui/Menu";
import { Empty, Spinner } from "../../components/ui/Misc";
import { Modal } from "../../components/ui/Modal";
import type { DialogProps } from "../../dialogs/DialogHost";
import { useSubmit } from "../../dialogs/useSubmit";
import { attempt, openExternal } from "../../lib/actions";
import { hostOf, plural } from "../../lib/format";
import { useLoad } from "../../lib/hooks";
import { openDialog, toast, toastError } from "../../store/store";
import { loadPlugins, setPluginEnabled, useSearch } from "./searchStore";

const TRUST_NOTE =
  "Plugins are Python programs that run on the computer Promethea is on, so only install ones you trust. Plugins made for qBittorrent work here too.";

function pluginLabel(name: string): string {
  return useSearch.getState().plugins.find((p) => p.name === name)?.fullName || name;
}

/** Toasts for what an install or update did; true when anything worked. */
function report(results: PluginUpdateResult[], verb: "install" | "update"): boolean {
  const done = results.filter((r) => r.ok);
  if (done.length === 1) {
    const r = done[0];
    toast("success", `${pluginLabel(r.name)}${r.version ? ` ${r.version}` : ""}`, {
      title: verb === "install" ? "Plugin installed" : "Plugin updated",
    });
  } else if (done.length > 1) {
    toast("success", done.map((r) => pluginLabel(r.name)).join(", "), {
      title: verb === "install" ? `${done.length} plugins installed` : `${done.length} plugins updated`,
    });
  }
  for (const r of results.filter((x) => !x.ok)) {
    toast("error", r.error || "Unknown error", { title: `Couldn't ${verb} ${pluginLabel(r.name)}` });
  }
  return done.length > 0;
}

function installFromUrl(): void {
  openDialog({
    type: "prompt",
    title: "Install from a web address",
    icon: <Link />,
    label: "Address of the plugin's .py file",
    placeholder: "https://example.com/plugins/site.py",
    mono: true,
    hint: TRUST_NOTE,
    confirmLabel: "Install",
    size: "md",
    validate: (v: string) => (/^https?:\/\/[^\s/]+\S*$/i.test(v.trim()) ? null : "Enter an address starting with http:// or https://"),
    onSubmit: async (v: string) => {
      const p = await api.installPluginUrl(v.trim());
      toast("success", `${p.fullName || p.name}${p.version ? ` ${p.version}` : ""}`, { title: "Plugin installed" });
      void loadPlugins();
    },
  });
}

async function installFiles(files: File[]): Promise<void> {
  for (const file of files) {
    try {
      const p = await api.installPluginFile(file);
      toast("success", `${p.fullName || p.name}${p.version ? ` ${p.version}` : ""}`, { title: "Plugin installed" });
    } catch (e) {
      toastError(e, `Couldn't install ${file.name}`);
    }
  }
  void loadPlugins();
}

function uninstall(plugin: SearchPlugin): void {
  const name = plugin.fullName || plugin.name;
  openDialog({
    type: "confirm",
    title: `Uninstall ${name}?`,
    message: "Its file is deleted, and searches stop using it. You can install it again any time.",
    confirmLabel: "Uninstall",
    danger: true,
    onConfirm: async () => {
      await attempt(() => api.uninstallPlugins([plugin.name]), `Couldn't uninstall ${name}`);
      void loadPlugins();
    },
  });
}

// ------------------------------------------------------------------ installed plugins
function PluginRow({ plugin, update, onUpdate }: { plugin: SearchPlugin; update?: PluginUpdate; onUpdate: (names: string[]) => void }) {
  const categories = useSearch((s) => s.categories);
  const name = plugin.fullName || plugin.name;
  const cats = plugin.categories.filter((c) => c !== "all").map((c) => categories[c] ?? c);
  const site = hostOf(plugin.url);
  const menu = (): MenuEntry[] => [
    {
      label: "Open the website",
      icon: <ExternalLink />,
      disabled: !/^https?:\/\//i.test(plugin.url),
      onSelect: () => openExternal(plugin.url),
    },
    update && { label: `Update to ${update.available}`, icon: <Download />, onSelect: () => onUpdate([plugin.name]) },
    { type: "separator" },
    { label: "Uninstall…", icon: <Trash2 />, danger: true, onSelect: () => uninstall(plugin) },
  ];
  return (
    <li className={`plugin-row${plugin.enabled && !plugin.error ? "" : " off"}`}>
      <span className="plugin-icon" aria-hidden>
        {plugin.icon ? <img src={plugin.icon} alt="" /> : <Puzzle />}
      </span>
      <div className="plugin-main">
        <div className="plugin-name">
          <span className="ellipsis" title={plugin.name !== name ? `${name} (${plugin.name}.py)` : undefined}>
            {name}
          </span>
          {plugin.version && <span className="plugin-ver">{plugin.version}</span>}
          {update && <span className="badge badge-accent">{update.available} available</span>}
        </div>
        {plugin.error ? (
          <div className="plugin-sub text-err" title={plugin.error}>
            {plugin.error}
          </div>
        ) : (
          <div className="plugin-sub ellipsis" title={cats.join(", ")}>
            {[site, cats.length ? cats.join(", ") : "Every category"].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
      <Switch
        checked={plugin.enabled && !plugin.error}
        disabled={!!plugin.error}
        onChange={(v) => void setPluginEnabled(plugin.name, v)}
        title={plugin.error ? `${name} doesn't work` : `Search ${name}`}
      />
      <IconButton label={`More for ${name}`} tip={null} size="sm" onClick={(e) => openDropdown(e.currentTarget, menu(), { align: "end" })}>
        <MoreHorizontal />
      </IconButton>
    </li>
  );
}

export function SearchPluginsDialog({ close }: DialogProps) {
  const plugins = useSearch((s) => s.plugins);
  const loaded = useSearch((s) => s.pluginsLoaded);
  const loadError = useSearch((s) => s.pluginsError);
  const [updates, setUpdates] = useState<PluginUpdate[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadPlugins();
  }, []);

  const byName = useMemo(() => new Map((updates ?? []).map((u) => [u.name, u])), [updates]);
  const enabled = plugins.filter((p) => p.enabled && !p.error).length;

  const check = async () => {
    setChecking(true);
    const found = await attempt(() => api.checkPluginUpdates(), "Couldn't check for updates");
    setChecking(false);
    if (!found) return;
    setUpdates(found);
    if (!found.length) toast("info", plugins.length === 1 ? "The plugin is up to date." : "Every plugin is up to date.", { title: "No updates" });
  };

  const update = async (names: string[]) => {
    setUpdating(true);
    const results = await attempt(() => api.updatePlugins(names), "Couldn't update");
    if (results) await loadPlugins();
    setUpdating(false);
    if (!results) return;
    report(results, "update");
    const fixed = new Set(results.filter((r) => r.ok).map((r) => r.name));
    setUpdates((u) => u && u.filter((x) => !fixed.has(x.name)));
  };

  const installMenu = (): MenuEntry[] => [
    {
      label: "Official plugins…",
      icon: <PackageCheck />,
      onSelect: () => openDialog({ type: "officialPlugins" }),
    },
    { label: "From a web address…", icon: <Link />, onSelect: installFromUrl },
    { label: "From a file…", icon: <FileUp />, onSelect: () => fileInput.current?.click() },
  ];

  let body;
  if (!loaded) body = <div className="plugin-wait"><Spinner size={18} /></div>;
  else if (loadError && !plugins.length)
    body = (
      <Empty icon={<TriangleAlert />} title="Couldn't load the plugins" actions={<Button onClick={() => void loadPlugins()}>Try again</Button>}>
        {loadError}
      </Empty>
    );
  else if (!plugins.length)
    body = (
      <Empty
        icon={<Puzzle />}
        title="No plugins installed"
        actions={
          <Button variant="primary" icon={<PackageCheck />} onClick={() => openDialog({ type: "officialPlugins" })}>
            Get the official plugins
          </Button>
        }
      >
        Each plugin searches one site. Install the official ones, or any plugin made for qBittorrent.
      </Empty>
    );
  else
    body = (
      <ul className="plugin-list">
        {plugins.map((p) => (
          <PluginRow key={p.name} plugin={p} update={byName.get(p.name)} onUpdate={(names) => void update(names)} />
        ))}
      </ul>
    );

  const pending = (updates ?? []).filter((u) => plugins.some((p) => p.name === u.name));
  return (
    <Modal
      title="Search plugins"
      subtitle={plugins.length ? `${plural(plugins.length, "plugin")} installed · ${enabled.toLocaleString()} on` : undefined}
      icon={<Puzzle />}
      size="lg"
      onClose={close}
      bodyClassName="plugin-body"
      footer={
        <>
          <Button
            icon={<Plus />}
            onClick={(e) => openDropdown(e.currentTarget, installMenu(), { matchWidth: false })}
            aria-haspopup="menu"
          >
            Install
            <ChevronDown className="btn-caret" />
          </Button>
          {plugins.length > 0 &&
            (pending.length ? (
              <Button icon={<Download />} loading={updating} onClick={() => void update(pending.map((u) => u.name))}>
                {pending.length === 1 ? "Update 1 plugin" : `Update ${pending.length} plugins`}
              </Button>
            ) : (
              <Button icon={<RefreshCw />} loading={checking} onClick={() => void check()}>
                Check for updates
              </Button>
            ))}
          <div className="spacer" />
          <Button variant="primary" onClick={close}>
            Done
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".py"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length) void installFiles(files);
            }}
          />
        </>
      }
    >
      {body}
      {plugins.length > 0 && <p className="dlg-note faint plugin-note">{TRUST_NOTE}</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ the official repository
export function OfficialPluginsDialog({ close }: DialogProps) {
  const { data, error, loading, reload } = useLoad(() => api.officialPlugins(), []);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  // Everything not installed yet, until something is (un)ticked.
  const chosen = useMemo(() => picked ?? new Set((data ?? []).filter((p) => !p.installed).map((p) => p.name)), [picked, data]);
  const { busy, error: failed, submit } = useSubmit(async () => {
    const names = [...chosen];
    if (!names.length) return;
    const results = await api.updatePlugins(names);
    await loadPlugins(); // first, so the toasts can use the new plugins' names
    if (!report(results, "install")) throw new Error(results.length === 1 ? results[0].error || "It couldn't be installed" : "None of them could be installed");
  }, close);

  const fresh = (data ?? []).filter((p) => !p.installed);
  const toggle = (name: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(name);
    else next.delete(name);
    setPicked(next);
  };

  let body;
  if (loading && !data) body = <div className="plugin-wait"><Spinner size={18} /></div>;
  else if (error)
    body = (
      <Empty icon={<TriangleAlert />} title="Couldn't get the list" actions={<Button icon={<RefreshCw />} onClick={() => void reload()}>Try again</Button>}>
        {error}
      </Empty>
    );
  else if (!data?.length) body = <Empty icon={<Puzzle />} title="The repository lists no plugins" />;
  else
    body = (
      <>
        <ul className="plugin-list official">
          {data.map((p) => (
            <li key={p.name} className={`plugin-row${p.installed ? " off" : ""}`}>
              <Checkbox
                checked={p.installed || chosen.has(p.name)}
                disabled={p.installed || busy}
                onChange={(v) => toggle(p.name, v)}
                label={
                  <span className="plugin-name">
                    <span>{p.name}</span>
                    <span className="plugin-ver">{p.version}</span>
                  </span>
                }
              />
              <div className="spacer" />
              {p.installed && <span className="badge">Installed</span>}
            </li>
          ))}
        </ul>
        {failed && <p className="dlg-note text-err">{failed}</p>}
      </>
    );

  return (
    <Modal
      title="Official plugins"
      subtitle="From qBittorrent's search plugin repository"
      icon={<PackageCheck />}
      size="md"
      onClose={close}
      onSubmit={submit}
      bodyClassName="plugin-body"
      footer={
        <>
          {fresh.length > 1 && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setPicked(chosen.size === fresh.length ? new Set() : new Set(fresh.map((p) => p.name)))}
            >
              {chosen.size === fresh.length ? "Select none" : "Select all"}
            </Button>
          )}
          <div className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!chosen.size}>
            {chosen.size > 1 ? `Install ${chosen.size}` : "Install"}
          </Button>
        </>
      }
    >
      {body}
      {!!data?.length && <p className="dlg-note faint plugin-note">{TRUST_NOTE}</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ a search's failures
const NO_ERRORS: SearchError[] = [];

export function SearchErrorsDialog({ spec, close }: DialogProps<{ type: "searchErrors"; id: string }>) {
  const errors = useSearch((s) => s.tabs[spec.id]?.errors ?? NO_ERRORS);
  const query = useSearch((s) => s.tabs[spec.id]?.query);
  const plugins = useSearch((s) => s.plugins);
  const label = (name: string) => plugins.find((p) => p.name === name)?.fullName || name;
  return (
    <Modal
      title={errors.length === 1 ? `${label(errors[0].plugin)} failed` : "Sites that failed"}
      subtitle={query ? `Searching for “${query}”` : undefined}
      icon={<TriangleAlert />}
      tone="danger"
      size="md"
      onClose={close}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              close();
              openDialog({ type: "searchPlugins" });
            }}
          >
            Search plugins…
          </Button>
          <div className="spacer" />
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        </>
      }
    >
      {errors.length ? (
        <ul className="sv-errors">
          {errors.map((e, i) => (
            <li key={`${e.plugin}-${i}`}>
              {/* With one, the title already names the site. */}
              {errors.length > 1 && <span className="sv-errors-site">{label(e.plugin)}</span>}
              <span className="sv-errors-msg">{e.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dlg-note muted">Every site answered.</p>
      )}
    </Modal>
  );
}
