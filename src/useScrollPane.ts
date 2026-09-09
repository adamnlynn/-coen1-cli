import { useEffect, useRef, useState } from "react";
import { measureElement, type DOMElement } from "ink";

/**
 * A window onto a list of terminal rows. `follow` pins the view to the newest row; scrolling up
 * unpins it, scrolling back to the bottom pins it again. The pane's real height is read after
 * layout, so it takes whatever the rows below it leave. Shared by the chat transcript and Home.
 */
export function useScrollPane(lines: string[], rows: number) {
  const [follow, setFollow] = useState(true);
  const [top, setTop] = useState(0);
  const [paneH, setPaneH] = useState(Math.max(1, rows - 6));
  const paneRef = useRef<DOMElement>(null);
  useEffect(() => {
    if (!paneRef.current) return;
    const h = measureElement(paneRef.current).height;
    if (h > 0 && h !== paneH) setPaneH(h);
  });
  const maxTop = Math.max(0, lines.length - paneH);
  const start = follow ? maxTop : Math.min(top, maxTop);
  function scrollBy(delta: number) {
    const next = Math.max(0, Math.min(maxTop, start + delta));
    setTop(next);
    setFollow(next >= maxTop);
  }
  /** Jump to a row (clamped). `follow` is set when that row is the bottom. */
  function scrollTo(row: number) {
    const next = Math.max(0, Math.min(maxTop, row));
    setTop(next);
    setFollow(next >= maxTop);
  }
  const visible = lines.slice(start, start + paneH);
  const hidden = lines.length - (start + visible.length);
  return { paneRef, paneH, start, visible, hidden, above: start, follow, scrollBy, scrollTo, setFollow };
}
