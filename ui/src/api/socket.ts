import { applyMessage, useStore } from "../store/store";
import { api } from "./client";

let ws: WebSocket | null = null;
let retry = 0;
let stopped = true;
let timer = 0;

/** Open the live-sync socket; reconnects with backoff until `disconnect()`. */
export function connect(): void {
  if (!stopped) return;
  stopped = false;
  open();
}

export function disconnect(): void {
  stopped = true;
  window.clearTimeout(timer);
  ws?.close();
  ws = null;
}

/** Ask the backend for a fresh full snapshot. */
export function requestResync(): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send("resync");
}

function open(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${location.host}/api/ws`);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    useStore.setState({ connected: true });
  };
  sock.onmessage = (ev) => {
    try {
      applyMessage(JSON.parse(ev.data));
    } catch (e) {
      console.error("bad sync message", e);
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    useStore.setState({ connected: false });
    if (stopped) return;
    const delay = Math.min(5000, 300 * 2 ** retry++);
    timer = window.setTimeout(async () => {
      if (stopped) return;
      // A refused handshake usually means the session expired: show the login page.
      try {
        const st = await api.authState();
        if (!st.authenticated) {
          stopped = true;
          useStore.setState({ auth: st });
          return;
        }
      } catch {
        /* backend unreachable: keep retrying */
      }
      open();
    }, delay);
  };
}
