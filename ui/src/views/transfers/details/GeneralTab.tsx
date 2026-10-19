import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { CircleAlert, Copy, FolderSearch, LoaderCircle } from "lucide-react";
import { api } from "../../../api/client";
import type { PiecesResponse, Properties } from "../../../api/types";
import { IconButton } from "../../../components/ui/Button";
import * as A from "../../../lib/actions";
import {
  formatBytes,
  formatDate,
  formatDuration,
  formatEta,
  formatLimit,
  formatPercent,
  formatRatio,
  formatSpeed,
} from "../../../lib/format";
import { useDebounced, useSize } from "../../../lib/hooks";
import { isStopped } from "../../../lib/states";
import { useStore } from "../../../store/store";
import { TabError, TabLoading, count, cssColor, useLookTick, useRefreshMs, useTorrentPoll } from "./shared";

// ------------------------------------------------------------------ piece bars
interface Layer {
  values: readonly number[];
  color: string;
  /** Values are divided by this before being used as opacity. */
  scale?: number;
  /** Opacity at value 1. */
  alpha?: number;
}

/** Draw bucket layers across the canvas, on whole device pixels, merging runs of equal values. */
function drawBar(canvas: HTMLCanvasElement, width: number, height: number, layers: Layer[]): void {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(width * dpr));
  const H = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  for (const layer of layers) {
    const n = layer.values.length;
    if (!n) continue;
    const scale = layer.scale && layer.scale > 0 ? layer.scale : 1;
    const peak = layer.alpha ?? 1;
    ctx.fillStyle = layer.color;
    let runStart = 0;
    let runValue = layer.values[0];
    const flush = (end: number) => {
      const a = Math.max(0, Math.min(1, runValue / scale)) * peak;
      if (a > 0.004) {
        const x0 = Math.round((runStart * W) / n);
        const x1 = Math.round((end * W) / n);
        if (x1 > x0) {
          ctx.globalAlpha = a;
          ctx.fillRect(x0, 0, x1 - x0, H);
        }
      }
    };
    for (let i = 1; i <= n; i++) {
      if (i === n || layer.values[i] !== runValue) {
        flush(i);
        runStart = i;
        runValue = layer.values[i];
      }
    }
  }
  ctx.globalAlpha = 1;
}

function PieceBars({ id, numPiecesHint }: { id: string; numPiecesHint: number }) {
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const progressRef = useRef<HTMLCanvasElement>(null);
  const availRef = useRef<HTMLCanvasElement>(null);
  const look = useLookTick();
  const base = useRefreshMs();
  // One bucket per CSS pixel; wait for the width to settle before asking.
  const width = useDebounced(Math.round(size.width), 200);
  const buckets = Math.max(16, Math.min(4096, width));
  const { data } = useTorrentPoll<PiecesResponse>(
    id,
    (tid) => api.pieces(tid, buckets),
    Math.max(2000, base * 2),
    buckets,
    width > 0,
  );
  useLayoutEffect(() => {
    const width = size.width;
    if (!data || !width) return;
    const pc = progressRef.current;
    const ac = availRef.current;
    if (pc) {
      drawBar(pc, width, 12, [
        { values: data.have, color: cssColor(pc, "--accent", "#8b5cf6") },
        { values: data.downloading, color: cssColor(pc, "--green", "#34d399"), alpha: 0.95 },
      ]);
    }
    if (ac) {
      const max = data.availability.reduce((m, v) => Math.max(m, v), 0);
      drawBar(ac, width, 6, [{ values: data.availability, color: cssColor(ac, "--cyan", "#22d3ee"), scale: max }]);
    }
  }, [data, size.width, look]);

  const waiting = data ? data.numPieces === 0 : numPiecesHint === 0;
  return (
    <div className="piece-bars" ref={wrapRef}>
      {waiting ? (
        <div className="piece-bar empty">
          <LoaderCircle className="spinner" />
          Waiting for metadata…
        </div>
      ) : (
        <>
          <div className="piece-bar" data-tip="Pieces: downloaded, and being downloaded right now (green)">
            <canvas ref={progressRef} />
          </div>
          <div className="piece-bar avail" data-tip="How many peers have each part of the torrent">
            <canvas ref={availRef} />
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ helpers
/** `more`: only with "Every detail in General" on (the Detailed layout). */
function Item({ label, children, hide, more }: { label: string; children: ReactNode; hide?: boolean; more?: boolean }) {
  const everyDetail = useStore((s) => s.layout.everyDetail);
  if (hide || (more && !everyDetail)) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Faint({ children }: { children: ReactNode }) {
  return <span className="faint">{children}</span>;
}

/** Comments often carry links; make http(s) ones clickable and leave the rest as text. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  return (
    <span className="selectable pre-wrap">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </span>
  );
}

function Hash({ value, what }: { value: string; what: string }) {
  if (!value) return <Faint>–</Faint>;
  return (
    <span className="hash">
      <span className="mono selectable">{value}</span>
      <IconButton label={`Copy ${what.toLowerCase()}`} size="xs" onClick={() => void A.copyText(value, what)}>
        <Copy />
      </IconButton>
    </span>
  );
}

// ------------------------------------------------------------------ tab
export function GeneralTab({ id, nonce }: { id: string; nonce: number }) {
  const t = useStore((s) => s.torrents[id]);
  const desktop = useStore((s) => !!s.app?.desktop);
  const everyDetail = useStore((s) => s.layout.everyDetail);
  const ms = useRefreshMs();
  const { data: p, error } = useTorrentPoll<Properties>(id, api.properties, ms, nonce);

  if (!p) return error ? <TabError message={error} /> : <TabLoading />;
  const stopped = t ? isStopped(t) : false;
  const progress = t?.progress ?? (p.totalSize ? p.piecesHave / Math.max(1, p.numPieces) : 0);

  return (
    <div className="general-tab">
      {p.error && (
        <div className="callout error">
          <CircleAlert />
          <div>
            <b>This torrent has an error.</b> {p.error}
          </div>
        </div>
      )}
      <div className="general-progress">
        <div className="gp-row">
          <span className="gp-label">Progress</span>
          <PieceBars id={id} numPiecesHint={p.hasMetadata ? p.numPieces : 0} />
          <span className="gp-value num">{formatPercent(progress)}</span>
        </div>
        {everyDetail && (
          <div className="gp-row sub">
            <span className="gp-label">Availability</span>
            <span className="gp-fill" />
            <span className="gp-value num">{p.availability < 0 ? "–" : p.availability.toFixed(2)}</span>
          </div>
        )}
      </div>

      <div className="general-grid">
        <section>
          <div className="section-title">Transfer</div>
          <dl className="kv">
            <Item label="Time active">
              {formatDuration(p.timeActive)}
              {p.seedingTime > 0 && <Faint>(seeding {formatDuration(p.seedingTime)})</Faint>}
            </Item>
            <Item label="ETA">{t && !stopped && t.progress < 1 ? formatEta(t.eta) : "–"}</Item>
            <Item label="Downloaded">
              {formatBytes(p.downloaded)}
              <Faint>({formatBytes(p.dlSession)} this session)</Faint>
            </Item>
            <Item label="Uploaded">
              {formatBytes(p.uploaded)}
              <Faint>({formatBytes(p.upSession)} this session)</Faint>
            </Item>
            <Item label="Share ratio">{formatRatio(p.ratio)}</Item>
            <Item more label="Wasted">{formatBytes(p.wasted)}</Item>
            <Item more label="Reannounce in">{stopped || p.reannounceIn <= 0 ? "–" : formatDuration(p.reannounceIn)}</Item>
            <Item more label="Last seen complete">{p.lastSeenComplete > 0 ? formatDate(p.lastSeenComplete) : "Never"}</Item>
          </dl>
        </section>

        <section>
          <div className="section-title">Connections</div>
          <dl className="kv">
            <Item more label="Connections">
              {count(p.connections)}
              {p.connectionsLimit > 0 && <Faint>({p.connectionsLimit.toLocaleString()} max)</Faint>}
            </Item>
            <Item label="Seeds">
              {count(p.seeds)}
              {p.seedsTotal >= 0 && <Faint>({p.seedsTotal.toLocaleString()} in swarm)</Faint>}
            </Item>
            <Item label="Peers">
              {count(p.peers)}
              {p.peersTotal >= 0 && <Faint>({p.peersTotal.toLocaleString()} in swarm)</Faint>}
            </Item>
            <Item label="Download speed">
              {formatSpeed(p.dlSpeed, "0 B/s")}
              <Faint>({formatSpeed(p.dlSpeedAvg, "0 B/s")} average)</Faint>
            </Item>
            <Item label="Upload speed">
              {formatSpeed(p.upSpeed, "0 B/s")}
              <Faint>({formatSpeed(p.upSpeedAvg, "0 B/s")} average)</Faint>
            </Item>
            <Item more label="Download limit">{formatLimit(p.dlLimit)}</Item>
            <Item more label="Upload limit">{formatLimit(p.upLimit)}</Item>
          </dl>
        </section>

        <section>
          <div className="section-title">Information</div>
          <dl className="kv">
            <Item label="Total size">
              {p.hasMetadata ? formatBytes(p.totalSize) : "–"}
              {p.hasMetadata && p.size < p.totalSize && <Faint>({formatBytes(p.size)} selected)</Faint>}
            </Item>
            <Item more label="Pieces">
              {p.hasMetadata ? (
                <>
                  {p.numPieces.toLocaleString()} × {formatBytes(p.pieceSize)}
                  <Faint>(have {p.piecesHave.toLocaleString()})</Faint>
                </>
              ) : (
                "–"
              )}
            </Item>
            <Item more label="Created by" hide={!p.createdBy}>
              <span className="selectable">{p.createdBy}</span>
            </Item>
            <Item more label="Created on" hide={!p.creationDate}>
              {formatDate(p.creationDate)}
            </Item>
            <Item label="Added on">{formatDate(p.addedOn)}</Item>
            <Item label="Completed on">{p.completedOn > 0 ? formatDate(p.completedOn) : "–"}</Item>
            <Item more label="Private">{p.hasMetadata ? (p.private ? "Yes" : "No") : "–"}</Item>
            <Item more label="Info hash v1" hide={!p.infohashV1 && !!p.infohashV2}>
              <Hash value={p.infohashV1} what="Info hash" />
            </Item>
            <Item more label="Info hash v2" hide={!p.infohashV2}>
              <Hash value={p.infohashV2} what="Info hash v2" />
            </Item>
            <Item label="Save path">
              <span className="hash">
                <span className="selectable">{p.savePath}</span>
                {desktop && (
                  <IconButton label="Open folder" size="xs" onClick={() => A.revealContent(id)}>
                    <FolderSearch />
                  </IconButton>
                )}
              </span>
            </Item>
            <Item label="Downloading to" hide={!p.currentPath || p.currentPath === p.savePath}>
              <span className="selectable">{p.currentPath}</span>
            </Item>
            <Item label="Comment" hide={!p.comment}>
              <Linkified text={p.comment} />
            </Item>
          </dl>
        </section>
      </div>
    </div>
  );
}
