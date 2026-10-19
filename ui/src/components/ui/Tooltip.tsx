import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface TipState {
  text: string;
  kbd: string | null;
  rect: DOMRect;
}

/**
 * One tooltip for the whole app: any element with `data-tip="..."` (and optionally
 * `data-kbd="Ctrl+F"`) gets a tooltip after a short hover delay.
 */
export function TooltipHost() {
  const [tip, setTip] = useState<TipState | null>(null);
  const visible = useRef(false);
  visible.current = tip !== null;

  useEffect(() => {
    let timer = 0;
    let current: Element | null = null;
    let lastHide = 0;
    const hide = () => {
      window.clearTimeout(timer);
      if (current) lastHide = performance.now();
      current = null;
      setTip(null);
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (el === current) return;
      window.clearTimeout(timer);
      current = el;
      if (!el) {
        if (visible.current) lastHide = performance.now();
        setTip(null);
        return;
      }
      const text = el.getAttribute("data-tip");
      if (!text) {
        setTip(null);
        return;
      }
      // Moving between toolbar buttons keeps tooltips instant, like native apps.
      const warm = visible.current || performance.now() - lastHide < 400;
      timer = window.setTimeout(
        () => {
          if (current !== el || !el.isConnected) return;
          setTip({ text, kbd: el.getAttribute("data-kbd"), rect: el.getBoundingClientRect() });
        },
        warm ? 0 : 500,
      );
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tip) return null;
  return createPortal(<TipBubble tip={tip} />, document.body);
}

function TipBubble({ tip }: { tip: TipState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const r = tip.rect;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 6) top = r.top - h - 6;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    setPos({ left, top });
  }, [tip]);
  return (
    <div
      ref={ref}
      className="tooltip"
      role="tooltip"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      {tip.text}
      {tip.kbd && <kbd>{tip.kbd}</kbd>}
    </div>
  );
}
