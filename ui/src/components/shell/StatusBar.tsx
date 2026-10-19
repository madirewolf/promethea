import { ArrowDown, ArrowUp, HardDrive, Network, Turtle } from "lucide-react";
import { api } from "../../api/client";
import type { ServerState } from "../../api/types";
import { attempt } from "../../lib/actions";
import { formatBytes, formatDuration, formatSpeed } from "../../lib/format";
import { openDialog, useStore } from "../../store/store";

const CONNECTION = {
  connected: { label: "Connected", tip: "Incoming connections are reaching Promethea" },
  firewalled: {
    label: "Firewalled",
    tip: "No incoming connections yet. Downloads still work, but forwarding the listening port helps speed.",
  },
  disconnected: { label: "Not listening", tip: "Promethea could not open its listening port" },
} as const;

function limitText(limit: number): string {
  return limit > 0 ? `[${formatSpeed(limit)}]` : "";
}

function Connection({ server }: { server: ServerState }) {
  const c = CONNECTION[server.connection] ?? CONNECTION.disconnected;
  const details = [
    c.tip,
    `Listening port: ${server.listenPort}`,
    server.externalIp && `External IP: ${server.externalIp}`,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className="sb-item" data-tip={details}>
      <span className={`conn-dot ${server.connection}`} />
      {c.label}
    </span>
  );
}

export function StatusBar() {
  const connected = useStore((s) => s.connected);
  const server = useStore((s) => s.server);

  if (!server) {
    return (
      <footer className="statusbar">
        <span className="sb-item">
          <span className="conn-dot" />
          Connecting…
        </span>
      </footer>
    );
  }

  const dlTip = [
    `Session: ${formatBytes(server.dlSession)} downloaded`,
    `All time: ${formatBytes(server.dlAllTime)}`,
    server.wasted > 0 && `Wasted: ${formatBytes(server.wasted)}`,
    "Click to change the speed limits",
  ]
    .filter(Boolean)
    .join("\n");
  const ulTip = [
    `Session: ${formatBytes(server.upSession)} uploaded`,
    `All time: ${formatBytes(server.upAllTime)}`,
    "Click to change the speed limits",
  ].join("\n");

  return (
    <footer className="statusbar">
      {connected ? (
        <Connection server={server} />
      ) : (
        <span className="sb-item" data-tip="Lost the connection to Promethea; retrying">
          <span className="conn-dot disconnected" />
          Reconnecting…
        </span>
      )}
      <span className="sb-item" data-tip={`DHT nodes · ${server.peers.toLocaleString()} peers connected`}>
        <Network />
        DHT {server.dhtNodes.toLocaleString()}
      </span>
      <span className="sb-item" data-tip="Free space in the default save folder">
        <HardDrive />
        {server.freeSpace >= 0 ? `${formatBytes(server.freeSpace)} free` : "–"}
      </span>
      {server.uptime > 0 && (
        <span className="sb-item sb-hide-narrow" data-tip="Uptime">
          {formatDuration(server.uptime)}
        </span>
      )}

      <span className="spacer" />

      <button
        type="button"
        className={`sb-item${server.altSpeed ? " on" : ""}`}
        aria-pressed={server.altSpeed}
        data-tip={server.altSpeed ? "Alternative speed limits are on" : "Use alternative speed limits"}
        onClick={() => void attempt(() => api.setAltSpeed(!server.altSpeed))}
      >
        <Turtle />
      </button>
      <span className="sb-sep" />
      <button
        type="button"
        className="sb-item sb-speed sb-dl"
        data-tip={dlTip}
        onClick={() => openDialog({ type: "globalLimits" })}
      >
        <ArrowDown />
        {formatSpeed(server.dlSpeed, "0 B/s")}
        {server.dlLimit > 0 && <span className="sb-limit">{limitText(server.dlLimit)}</span>}
      </button>
      <button
        type="button"
        className="sb-item sb-speed sb-ul"
        data-tip={ulTip}
        onClick={() => openDialog({ type: "globalLimits" })}
      >
        <ArrowUp />
        {formatSpeed(server.upSpeed, "0 B/s")}
        {server.upLimit > 0 && <span className="sb-limit">{limitText(server.upLimit)}</span>}
      </button>
    </footer>
  );
}
