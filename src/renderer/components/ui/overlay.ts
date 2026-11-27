// The overlay counter (compute.md §8.4): a native preview view (WebContentsView) is always drawn above the page's DOM,
// so while any dialog, popover, menu, select list or the command palette is on screen the computer dock hides the view
// and shows a captured image instead. The kit's overlays count themselves in `useUi().overlayCount`; pages never do.
import { useLayoutEffect, useState } from 'react';
import { useUi } from '@renderer/lib/store';

/** Counts one open overlay while `active` (and the caller is mounted). */
export function useOverlayCount(active = true): void {
  useLayoutEffect(() => {
    if (!active) return undefined;
    return useUi.getState().pushOverlay();
  }, [active]);
}

/**
 * Rendered inside a Base UI Popup (dialog, popover, menu): Base UI mounts the popup only while it is open or
 * animating out, so the overlay counts exactly as long as it is visible.
 */
export function OverlayMark(): null {
  useOverlayCount(true);
  return null;
}

/**
 * For overlays whose popup stays mounted while hidden (Base UI Select keeps its list mounted after the first
 * interaction): counts from "opening" until the close transition has finished.
 */
export function useOverlayOpenState(): {
  onOpen: (open: boolean) => void;
  onOpenComplete: (open: boolean) => void;
} {
  const [visible, setVisible] = useState(false);
  useOverlayCount(visible);
  return {
    onOpen: (open) => {
      if (open) setVisible(true);
    },
    onOpenComplete: (open) => {
      if (!open) setVisible(false);
    },
  };
}
