// The panel under the torrent list: General, Files, Trackers, Peers, HTTP sources and Speed.

import { useState } from "react";
import type { ReactNode } from "react";
import { Activity, Files, Globe, Info, MousePointerClick, Plus, Radio, RefreshCw, UserPlus, Users, X } from "lucide-react";
import { api } from "../../../api/client";
import { IconButton } from "../../../components/ui/Button";
import { SearchInput } from "../../../components/ui/Form";
import { openContextMenu } from "../../../components/ui/Menu";
import { Empty, Tabs } from "../../../components/ui/Misc";
import type { TabSpec } from "../../../components/ui/Misc";
import * as A from "../../../lib/actions";
import { useStore } from "../../../store/store";
import type { DetailsTab } from "../../../store/store";
import { tabsMenu } from "../layoutMenu";
import { FilesTab } from "./FilesTab";
import { GeneralTab } from "./GeneralTab";
import { PeersTab, promptAddPeers } from "./PeersTab";
import { SpeedTab } from "./SpeedTab";
import { TrackersTab, promptAddTrackers } from "./TrackersTab";
import { WebSeedsTab, promptAddWebSeeds } from "./WebSeedsTab";

/** The torrent the panel shows: the focused row when it's selected, else the first selected one. */
function useShownId(): string | null {
  return useStore((s) => {
    if (s.focused && s.selected.has(s.focused) && s.torrents[s.focused]) return s.focused;
    for (const id of s.selected) if (s.torrents[id]) return id;
    return null;
  });
}

export function DetailsPanel({ height }: { height: number }) {
  const tab = useStore((s) => s.detailsTab);
  const shownTabs = useStore((s) => s.layout.tabs);
  const id = useShownId();
  const name = useStore((s) => (id ? s.torrents[id]?.name ?? "" : ""));
  const connected = useStore((s) => {
    const t = id ? s.torrents[id] : undefined;
    return t ? t.seeds + t.peers : 0;
  });
  // Bumped after an add dialog, so the open tab fetches right away.
  const [nonce, setNonce] = useState(0);
  const bump = () => setNonce((n) => n + 1);

  // The file filter belongs to one torrent; start empty for the next.
  const [filter, setFilter] = useState("");
  const [filterFor, setFilterFor] = useState(id);
  if (filterFor !== id) {
    setFilterFor(id);
    setFilter("");
  }

  const setTab = (t: DetailsTab) => useStore.setState({ detailsTab: t });
  const tabs = ([
    { key: "general", label: "General", icon: <Info /> },
    { key: "files", label: "Files", icon: <Files /> },
    { key: "trackers", label: "Trackers", icon: <Radio /> },
    { key: "peers", label: "Peers", icon: <Users />, badge: connected || undefined },
    { key: "webseeds", label: "HTTP sources", icon: <Globe /> },
    { key: "speed", label: "Speed", icon: <Activity /> },
  ] satisfies TabSpec<DetailsTab>[]).filter((t) => shownTabs.includes(t.key));

  let tools: ReactNode = null;
  if (id) {
    if (tab === "files") {
      tools = (
        <SearchInput
          className="details-filter"
          value={filter}
          onChange={setFilter}
          placeholder="Filter files"
          aria-label="Filter files"
        />
      );
    } else if (tab === "trackers") {
      tools = (
        <>
          <IconButton label="Add trackers" size="sm" onClick={() => promptAddTrackers(id, bump)}>
            <Plus />
          </IconButton>
          <IconButton label="Reannounce now" size="sm" onClick={() => void A.attempt(() => api.action("reannounce", [id]), "Couldn't reannounce").then(bump)}>
            <RefreshCw />
          </IconButton>
        </>
      );
    } else if (tab === "peers") {
      tools = (
        <IconButton label="Add peers" size="sm" onClick={() => promptAddPeers([id], bump)}>
          <UserPlus />
        </IconButton>
      );
    } else if (tab === "webseeds") {
      tools = (
        <IconButton label="Add HTTP sources" size="sm" onClick={() => promptAddWebSeeds(id, bump)}>
          <Plus />
        </IconButton>
      );
    }
  }

  let body: ReactNode;
  if (tab === "speed") body = <SpeedTab />;
  else if (!id) {
    body = (
      <Empty icon={<MousePointerClick />} title="No torrent selected">
        Select a torrent to see its details here.
      </Empty>
    );
  } else if (tab === "general") body = <GeneralTab id={id} nonce={nonce} />;
  else if (tab === "files") body = <FilesTab id={id} nonce={nonce} filter={filter} />;
  else if (tab === "trackers") body = <TrackersTab id={id} nonce={nonce} />;
  else if (tab === "peers") body = <PeersTab id={id} nonce={nonce} />;
  else body = <WebSeedsTab id={id} nonce={nonce} />;

  return (
    <section className="details" style={{ height }} aria-label="Torrent details">
      <Tabs
        tabs={tabs}
        value={tab}
        onChange={setTab}
        className="details-tabs"
        onContextMenu={(e, at) => openContextMenu(e, () => tabsMenu(at))}
      >
        {tools}
        {id && tab !== "speed" && (
          <span className="details-name" data-tip={name}>
            {name}
          </span>
        )}
        <IconButton label="Hide details" size="sm" onClick={() => useStore.setState({ detailsOpen: false })}>
          <X />
        </IconButton>
      </Tabs>
      {/* Keyed so a tab's scroll position, selection and sort start fresh for each torrent. */}
      <div className="details-body" key={tab === "speed" ? tab : `${tab}:${id ?? ""}`}>
        {body}
      </div>
    </section>
  );
}
