import { Copy, TriangleAlert, Wrench } from "lucide-react";
import { IconButton } from "../../../components/ui/Button";
import { toast, useStore } from "../../../store/store";
import { Group, NumberPref, Row, Section, SelectPref, SwitchPref, TextPref } from "../controls";

const A = "advanced";

function DataFolderRow() {
  const dir = useStore((s) => s.app?.dataDir);
  if (!dir) return null;
  return (
    <Row label="Data folder" hint="Settings, resume data and logs live here." keywords="profile config location">
      <div className="set-pair set-path">
        <code className="set-path-text" title={dir}>
          {dir}
        </code>
        <IconButton
          label="Copy the path"
          size="sm"
          onClick={() =>
            navigator.clipboard.writeText(dir).then(
              () => toast("success", "Copied", { ms: 1200 }),
              () => toast("error", "Couldn't copy"),
            )
          }
        >
          <Copy />
        </IconButton>
      </div>
    </Row>
  );
}

export function AdvancedSection() {
  return (
    <Section id="advanced" title="Advanced" icon={<Wrench />}>
      <div className="callout warn set-callout">
        <TriangleAlert />
        <span>These tune libtorrent. The defaults are fast on most connections and drives; change them only for a reason.</span>
      </div>

      <Group title="Disk">
        <NumberPref k={[A, "aioThreads"]} label="Disk threads" hint="Reading and writing in parallel." keywords="aio io threads" min={1} max={64} />
        <NumberPref k={[A, "hashingThreads"]} label="Hashing threads" hint="For checking pieces." keywords="hash threads" min={1} max={64} />
        <NumberPref k={[A, "filePoolSize"]} label="Files kept open" keywords="file pool handles" min={10} max={10000} />
        <NumberPref k={[A, "checkingMemory"]} label="Memory for checking" suffix="MiB" keywords="checking memory buffer" min={1} max={4096} />
        <NumberPref k={[A, "diskQueueSize"]} label="Write queue" suffix="MiB" hint="Data waiting for the disk before peers are slowed down." keywords="disk queue buffer" min={1} max={4096} />
        <SelectPref
          k={[A, "diskWriteMode"]}
          label="Write mode"
          keywords="disk mmap pwrite io"
          options={[
            { value: "auto", label: "Automatic" },
            { value: "pwrite", label: "Write calls" },
            { value: "mmap", label: "Memory-mapped" },
          ]}
        />
        <SelectPref
          k={[A, "diskCacheMode"]}
          label="OS disk cache"
          keywords="cache buffer io"
          options={[
            { value: "default", label: "Default" },
            { value: "enableOsCache", label: "Use it" },
            { value: "disableOsCache", label: "Bypass it" },
            { value: "writeThrough", label: "Write through" },
          ]}
        />
        <NumberPref k={[A, "resumeSaveInterval"]} label="Save resume data every" suffix="min" keywords="fastresume interval" min={1} max={1440} />
      </Group>

      <Group title="Connections">
        <NumberPref k={[A, "connectionSpeed"]} label="New connections per second" keywords="connection speed rate" min={1} max={1000} />
        <NumberPref k={[A, "torrentConnectBoost"]} label="Connections a new torrent opens at once" keywords="connect boost" min={0} max={1000} />
        <NumberPref k={[A, "peerConnectTimeout"]} label="Connect timeout" suffix="s" keywords="peer timeout" min={1} max={120} />
        <NumberPref k={[A, "requestTimeout"]} label="Request timeout" suffix="s" keywords="piece timeout" min={1} max={600} />
        <NumberPref k={[A, "requestQueueSize"]} label="Requests queued per peer" keywords="request queue pipeline" min={1} max={10000} />
        <NumberPref k={[A, "socketBacklog"]} label="Socket backlog" keywords="listen queue" min={1} max={10000} />
        <NumberPref k={[A, "maxPeerListSize"]} label="Peers remembered per torrent" keywords="peer list size" min={10} max={100000} />
        <NumberPref k={[A, "sendBufferWatermark"]} label="Send buffer" suffix="KiB" keywords="watermark upload buffer" min={1} max={65536} />
        <NumberPref k={[A, "sendBufferLowWatermark"]} label="Send buffer low mark" suffix="KiB" keywords="watermark upload buffer" min={1} max={65536} />
        <NumberPref k={[A, "sendBufferWatermarkFactor"]} label="Send buffer growth" suffix="%" keywords="watermark factor" min={1} max={1000} />
        <NumberPref
          k={[A, "outgoingPortMin"]}
          label="Outgoing ports from"
          hint="0 lets the system pick."
          keywords="outgoing source port range"
          min={0}
          max={65535}
        />
        <NumberPref k={[A, "outgoingPortMax"]} label="Outgoing ports to" keywords="outgoing source port range" min={0} max={65535} />
        <NumberPref k={[A, "upnpLeaseDuration"]} label="UPnP lease" suffix="s" hint="0 asks for a permanent mapping." keywords="upnp nat-pmp" min={0} max={604800} />
        <NumberPref k={[A, "peerDscp"]} label="DSCP for peer traffic" hint="Type of service, for routers that prioritise." keywords="tos qos dscp" min={0} max={63} />
        <SelectPref
          k={[A, "mixedMode"]}
          label="TCP and µTP together"
          keywords="mixed mode utp tcp"
          options={[
            { value: "preferTcp", label: "Prefer TCP" },
            { value: "peerProportional", label: "Share by peer count" },
          ]}
        />
        <SwitchPref k={[A, "allowMultipleConnectionsPerIp"]} label="Allow several connections from one IP address" keywords="multiple ip" />
        <SwitchPref k={[A, "blockPrivilegedPorts"]} label="Don't connect to peers on ports below 1024" keywords="privileged ports" />
        <SwitchPref
          k={[A, "ssrfMitigation"]}
          label="SSRF mitigation"
          hint="Keeps trackers and web seeds from reaching services on your network."
          keywords="security localhost"
        />
      </Group>

      <Group title="Choking and peers">
        <SelectPref
          k={[A, "chokingAlgorithm"]}
          label="Upload slots"
          keywords="choking algorithm unchoke"
          options={[
            { value: "fixedSlots", label: "Fixed number" },
            { value: "rateBased", label: "By upload rate" },
          ]}
        />
        <SelectPref
          k={[A, "seedChokingAlgorithm"]}
          label="While seeding, upload to"
          keywords="seed choking algorithm"
          options={[
            { value: "fastestUpload", label: "The fastest peers" },
            { value: "roundRobin", label: "Everyone in turn" },
            { value: "antiLeech", label: "New and nearly done peers" },
          ]}
        />
        <NumberPref k={[A, "peerTurnover"]} label="Peer turnover" suffix="%" hint="Share of slow peers dropped to try new ones." keywords="turnover churn" min={0} max={100} />
        <NumberPref k={[A, "peerTurnoverCutoff"]} label="Turnover below" suffix="%" hint="Only while the torrent uses less than this share of its connections." keywords="turnover cutoff" min={0} max={100} />
        <NumberPref k={[A, "peerTurnoverInterval"]} label="Turnover every" suffix="s" keywords="turnover interval" min={1} max={3600} />
        <SwitchPref k={[A, "pieceExtentAffinity"]} label="Download pieces in runs" hint="Fewer, larger disk writes." keywords="piece extent affinity" />
        <SwitchPref k={[A, "suggestMode"]} label="Suggest cached pieces to peers" keywords="suggest read cache" />
      </Group>

      <Group title="Trackers and DHT">
        <SwitchPref k={[A, "announceToAllTrackers"]} label="Announce to every tracker in a tier" keywords="announce trackers" />
        <SwitchPref k={[A, "announceToAllTiers"]} label="Announce to every tier" keywords="announce trackers" />
        <TextPref k={[A, "announceIp"]} label="IP address to announce" hint="Empty: the one trackers see." keywords="announce ip" placeholder="Automatic" mono />
        <NumberPref k={[A, "announcePort"]} label="Port to announce" hint="0: the listening port." keywords="announce port" min={0} max={65535} />
        <NumberPref k={[A, "maxConcurrentHttpAnnounces"]} label="HTTP announces at once" keywords="concurrent tracker" min={1} max={1000} />
        <NumberPref k={[A, "stopTrackerTimeout"]} label="Wait for trackers on quit" suffix="s" keywords="stop timeout shutdown" min={0} max={60} />
        <SwitchPref k={[A, "validateHttpsTrackers"]} label="Check HTTPS trackers' certificates" keywords="tls ssl validate" />
        <TextPref
          k={[A, "dhtBootstrapNodes"]}
          label="DHT bootstrap nodes"
          hint="host:port, separated by commas."
          keywords="dht router bootstrap"
          mono
          stacked
        />
      </Group>

      <Group title="Promethea">
        <NumberPref k={[A, "uiRefreshInterval"]} label="Refresh the transfer list every" suffix="ms" keywords="update interval ui" min={250} max={10000} step={250} />
        <NumberPref k={[A, "speedHistoryMinutes"]} label="Speed graph history" suffix="min" keywords="graph chart history" min={1} max={1440} />
        <DataFolderRow />
      </Group>
    </Section>
  );
}
