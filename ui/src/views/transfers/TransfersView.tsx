import { useRef } from "react";
import { useDrag, useSize } from "../../lib/hooks";
import { useStore } from "../../store/store";
import { DetailsPanel } from "./details/DetailsPanel";
import { useVisibleTorrents } from "./filters";
import { TorrentTable } from "./TorrentTable";
import { TransfersToolbar } from "./TransfersToolbar";

const DETAILS_MIN = 150;
const DETAILS_DEFAULT = 300;
const LIST_MIN = 110;

export function TransfersView() {
  const rows = useVisibleTorrents();
  const open = useStore((s) => s.detailsOpen);
  const height = useStore((s) => s.detailsHeight);
  const [ref, size] = useSize<HTMLDivElement>();
  const start = useRef(0);

  const max = size.height ? Math.max(DETAILS_MIN, size.height - LIST_MIN) : Number.POSITIVE_INFINITY;
  const h = Math.round(Math.min(max, Math.max(DETAILS_MIN, height)));
  const drag = useDrag(
    (_dx, dy) => {
      useStore.setState({ detailsHeight: Math.round(Math.min(max, Math.max(DETAILS_MIN, start.current - dy))) });
    },
    undefined,
    "row-resize",
  );

  return (
    <>
      <TransfersToolbar count={rows.length} />
      <div className="transfers" ref={ref}>
        <TorrentTable rows={rows} />
        {open && (
          <>
            <div
              className="split-h"
              role="separator"
              aria-orientation="horizontal"
              onPointerDown={(e) => {
                start.current = h;
                drag(e);
              }}
              onDoubleClick={() => useStore.setState({ detailsHeight: DETAILS_DEFAULT })}
            />
            <DetailsPanel height={h} />
          </>
        )}
      </div>
    </>
  );
}
