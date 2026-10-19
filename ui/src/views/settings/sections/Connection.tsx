import { Network, Shuffle } from "lucide-react";
import { IconButton } from "../../../components/ui/Button";
import { Input, NumberInput } from "../../../components/ui/Form";
import { useStore } from "../../../store/store";
import { Group, LimitPref, LinesPref, PathPref, Row, Section, SelectPref, SwitchPref, TextPref } from "../controls";
import { usePref } from "../draft";

const C = "connection";

function PortRow() {
  const [port, setPort, dirty] = usePref<number>(C, "port");
  const status = useStore((s) => s.server?.connection);
  const hint =
    status === "connected"
      ? "Peers can reach you on it."
      : status === "firewalled"
        ? "Peers can't reach this port yet. Forward it on your router, or turn on UPnP below."
        : "Peers connect to you on this port.";
  return (
    <Row label="Listening port" hint={hint} keywords="incoming forward firewall" dirty={dirty}>
      <div className="set-pair">
        <NumberInput className="set-num" value={port ?? 0} onChange={setPort} min={1} max={65535} aria-label="Listening port" />
        <IconButton label="Pick a random port" onClick={() => setPort(20000 + Math.floor(Math.random() * 40001))}>
          <Shuffle />
        </IconButton>
      </div>
    </Row>
  );
}

function ProxyServerRow() {
  const [host, setHost, hostDirty] = usePref<string>(C, "proxyHost");
  const [port, setPort, portDirty] = usePref<number>(C, "proxyPort");
  return (
    <Row label="Server" keywords="proxy host address port" dirty={hostDirty || portDirty} sub>
      <div className="set-pair">
        <Input
          className="set-in"
          value={host ?? ""}
          placeholder="Host name or IP"
          onChange={(e) => setHost(e.target.value)}
          aria-label="Proxy host"
        />
        <NumberInput className="set-num-sm" value={port ?? 0} onChange={setPort} min={1} max={65535} aria-label="Proxy port" />
      </div>
    </Row>
  );
}

function ProxyGroup() {
  const [type] = usePref<string>(C, "proxyType");
  const [auth] = usePref<boolean>(C, "proxyAuth");
  const on = type !== "none";
  const canAuth = type === "socks5" || type === "http";
  return (
    <Group title="Proxy">
      <SelectPref
        k={[C, "proxyType"]}
        label="Proxy server"
        keywords="socks http vpn"
        options={[
          { value: "none", label: "None" },
          { value: "socks5", label: "SOCKS5" },
          { value: "socks4", label: "SOCKS4" },
          { value: "http", label: "HTTP" },
        ]}
      />
      {on && <ProxyServerRow />}
      {on && canAuth && <SwitchPref k={[C, "proxyAuth"]} label="The proxy needs a username and password" keywords="proxy authentication" sub />}
      {on && canAuth && auth && <TextPref k={[C, "proxyUsername"]} label="Username" keywords="proxy" sub />}
      {on && canAuth && auth && <TextPref k={[C, "proxyPassword"]} label="Password" keywords="proxy" type="password" sub />}
      {on && (
        <SwitchPref
          k={[C, "proxyPeers"]}
          label="Connect to peers through the proxy"
          hint="When off, only trackers use it."
          keywords="proxy"
          sub
        />
      )}
      {on && <SwitchPref k={[C, "proxyHostnames"]} label="Look up host names through the proxy" keywords="proxy dns" sub />}
    </Group>
  );
}

export function ConnectionSection() {
  const [filter] = usePref<boolean>(C, "ipFilterEnabled");
  return (
    <Section id="connection" title="Connection" icon={<Network />}>
      <Group title="Listening">
        <PortRow />
        <SwitchPref
          k={[C, "upnp"]}
          label="Open the port on the router automatically"
          hint="Uses UPnP and NAT-PMP."
          keywords="upnp nat-pmp forward"
        />
        <SelectPref
          k={[C, "protocol"]}
          label="Peer connections"
          keywords="protocol tcp utp"
          options={[
            { value: "both", label: "TCP and µTP" },
            { value: "tcp", label: "TCP only" },
            { value: "utp", label: "µTP only" },
          ]}
        />
        <TextPref
          k={[C, "interface"]}
          label="Network interface"
          hint="An IP address or interface name to bind to, such as a VPN's. Empty means all of them."
          keywords="bind vpn adapter"
          placeholder="All interfaces"
          mono
        />
      </Group>

      <Group title="Connection limits" note="Leave a box empty for no limit.">
        <LimitPref k={[C, "maxConnections"]} label="Connections in total" keywords="maximum peers global" />
        <LimitPref k={[C, "maxConnectionsPerTorrent"]} label="Connections per torrent" keywords="maximum peers" />
        <LimitPref k={[C, "maxUploads"]} label="Upload slots in total" keywords="maximum unchoke global" />
        <LimitPref k={[C, "maxUploadsPerTorrent"]} label="Upload slots per torrent" keywords="maximum unchoke" />
      </Group>

      <ProxyGroup />

      <Group title="Blocking">
        <SwitchPref
          k={[C, "ipFilterEnabled"]}
          label="Block addresses listed in an IP filter file"
          hint="eMule .dat, PeerGuardian .p2p or .p2b files."
          keywords="ip filter blocklist"
        />
        {filter && (
          <PathPref
            k={[C, "ipFilterPath"]}
            label="Filter file"
            keywords="ip filter blocklist"
            file={{ title: "Choose an IP filter file", types: ["IP filter files (*.dat;*.p2p;*.p2b)", "All files (*.*)"] }}
            sub
          />
        )}
        {filter && <SwitchPref k={[C, "ipFilterTrackers"]} label="Apply it to trackers too" keywords="ip filter" sub />}
        <LinesPref
          k={[C, "bannedIPs"]}
          label="Banned peers"
          hint="One IP address per line. Peers you ban from a torrent's peer list are added here."
          keywords="ban block ip address"
          placeholder="203.0.113.7"
          rows={3}
        />
      </Group>
    </Section>
  );
}
