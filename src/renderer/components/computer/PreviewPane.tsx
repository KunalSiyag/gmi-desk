// A port preview (compute.md §8.4): the persistent "untrusted content" frame with Back / Forward / Reload / Open
// externally / Close, and the slot the native WebContentsView is placed over. The renderer only reports where the
// slot is (ResizeObserver, one report per animation frame); main builds the URL, injects the token and locks the host.
// A native view is drawn above the DOM, so while any overlay is open (useUi().overlayCount), the tab is hidden, or the
// narrow-window sheet is moving, the view is hidden and the captured image takes its place.
import { useEffect, useRef, useState } from 'react';
import { AppWindow, ArrowLeft, ArrowRight, ExternalLink, RotateCw, ShieldAlert, X } from 'lucide-react';
import type { PreviewBounds, PreviewInfo } from '@shared/contracts/compute';
import { Plates } from '@renderer/components/brand/Plates';
import { Button } from '@renderer/components/ui/button';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { gmi } from '@renderer/lib/gmi';
import { useUi } from '@renderer/lib/store';
import { toastActionError, useComputeState } from '@renderer/pages/compute/hooks';
import { Placeholder } from './parts';
import { useComputerUi, useStoreNow } from './store';

/** How long the dock waits for a capture before hiding the view anyway. */
export const CAPTURE_TIMEOUT_MS = 250;

/** The host shown in the frame ("8000-abc.sandbox.example"); the raw URL when it does not parse. */
export function previewHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Rounded bounds of a slot rectangle, or null when it has no area. */
export function slotBounds(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): PreviewBounds | null {
  const b = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) return null;
  return b;
}

/** Whether the native view may be on screen now. */
export function viewVisible(opts: { active: boolean; overlayCount: number; sheetMoving: boolean; state: PreviewInfo['state'] }): boolean {
  return opts.active && opts.overlayCount === 0 && !opts.sheetMoving && (opts.state === 'ready' || opts.state === 'loading');
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

const noop = () => undefined;

export function PreviewPane({ preview, active, onClosed }: { preview: PreviewInfo; active: boolean; onClosed: () => void }) {
  const id = preview.previewId;
  const slotRef = useRef<HTMLDivElement>(null);
  const overlayCount = useStoreNow(useUi, (s) => s.overlayCount);
  const sheetMoving = useStoreNow(useComputerUi, (s) => s.sheetMoving);
  const removePreview = useComputerUi((s) => s.removePreview);
  const [shot, setShot] = useState<string | null>(null);
  /** The view is (or was last told to be) on screen. */
  const shown = useRef(false);
  const visible = viewVisible({ active, overlayCount, sheetMoving, state: preview.state });

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return undefined;
    if (!visible) {
      let cancelled = false;
      void (async () => {
        // An overlay opened over a live view: show its last frame instead of a hole (capture first, then hide).
        if (shown.current && active && overlayCount > 0) {
          const image = await withTimeout(gmi.computer.capturePreview(id), CAPTURE_TIMEOUT_MS, null);
          if (!cancelled && image) setShot(image);
        }
        if (cancelled) return;
        shown.current = false;
        gmi.computer.setPreviewBounds(id, null).catch(noop);
      })();
      return () => {
        cancelled = true;
      };
    }
    let frame = 0;
    let last = '';
    const report = () => {
      frame = 0;
      const bounds = slotBounds(slot.getBoundingClientRect());
      const key = JSON.stringify(bounds);
      if (key === last) return;
      last = key;
      shown.current = bounds !== null;
      gmi.computer.setPreviewBounds(id, bounds).catch(noop);
      if (bounds) setShot(null);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(report);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(slot);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [id, visible, active, overlayCount]);

  // Leaving the dock (closed, another resource, unmounted): the view must not stay on screen.
  useEffect(
    () => () => {
      shown.current = false;
      gmi.computer.setPreviewBounds(id, null).catch(noop);
    },
    [id],
  );

  const command = (cmd: 'reload' | 'back' | 'forward') => gmi.computer.previewCommand(id, cmd).catch((error: unknown) => toastActionError('Preview', error));
  const close = async () => {
    try {
      await gmi.computer.closePreview(id);
    } catch (error) {
      toastActionError('Could not close the preview', error);
    }
    removePreview(id);
    onClosed();
  };
  const host = previewHost(preview.url);
  // Mock mode draws no native view (§16): the slot shows what would be there instead of an empty box.
  const demo = useComputeState().data?.mock === true;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PreviewFrame
        preview={preview}
        host={host}
        onBack={() => void command('back')}
        onForward={() => void command('forward')}
        onReload={() => void command('reload')}
        onExternal={() => void gmi.computer.openPreviewExternally(id).catch((error: unknown) => toastActionError('Could not open it', error))}
        onClose={() => void close()}
      />
      <div ref={slotRef} data-preview-slot={id} className="relative min-h-0 flex-1 bg-background">
        {preview.state === 'failed' || preview.state === 'blocked' ? (
          <div className="absolute inset-0 flex">
            <Placeholder
              icon={<ShieldAlert />}
              title={preview.state === 'blocked' ? 'The preview tried to leave its address' : 'The preview did not load'}
              action={
                <Button variant="outline" size="sm" onClick={() => void command('reload')}>
                  <RotateCw /> Reload
                </Button>
              }
            >
              {preview.detail ??
                (preview.state === 'blocked'
                  ? 'Only pages on this port’s own address open here. Use “Open externally” for anything else.'
                  : 'Check that the server is running and listening on 0.0.0.0.')}
            </Placeholder>
          </div>
        ) : demo ? (
          <div className="absolute inset-0 flex">
            <Placeholder icon={<AppWindow />} title={preview.state === 'loading' ? 'Loading the preview…' : 'Demo preview'}>
              In the app, the page served on port {preview.port} appears here, in its own isolated view. Demo data never loads a real page.
            </Placeholder>
          </div>
        ) : !visible && shot ? (
          // The captured frame while an overlay hides the native view.
          <img alt="" src={shot} className="pointer-events-none absolute inset-0 size-full object-cover object-left-top" />
        ) : null}
      </div>
    </div>
  );
}

/** The persistent strip above a preview (§8.4 "Frame"). */
export function PreviewFrame({
  preview,
  host,
  onBack,
  onForward,
  onReload,
  onExternal,
  onClose,
}: {
  preview: PreviewInfo;
  host: string;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onExternal: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-1.5" data-preview-frame="">
      <Tooltip label="Back">
        <Button variant="ghost" size="icon-xs" aria-label="Back" disabled={!preview.canGoBack} onClick={onBack}>
          <ArrowLeft />
        </Button>
      </Tooltip>
      <Tooltip label="Forward">
        <Button variant="ghost" size="icon-xs" aria-label="Forward" disabled={!preview.canGoForward} onClick={onForward}>
          <ArrowRight />
        </Button>
      </Tooltip>
      <Tooltip label="Reload">
        <Button variant="ghost" size="icon-xs" aria-label="Reload" onClick={onReload}>
          <RotateCw />
        </Button>
      </Tooltip>
      <div className="mx-1 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-muted px-2 text-2xs dark:bg-white/[0.04]">
        {preview.state === 'loading' ? <Plates size="sm" /> : <ShieldAlert className="size-3 shrink-0 text-warning" />}
        {/* The host may be long; "untrusted content" never truncates. */}
        <span className="min-w-0 truncate" title={preview.url}>
          <span className="text-muted-foreground">Preview of </span>
          <span className="font-mono text-foreground">{host}</span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-muted-foreground"> · untrusted content</span>
      </div>
      <Tooltip label="Open in your browser (it gets no access token: a secured preview answers 401 there)">
        <Button variant="ghost" size="icon-xs" aria-label="Open externally" onClick={onExternal}>
          <ExternalLink />
        </Button>
      </Tooltip>
      <Tooltip label="Close preview">
        <Button variant="ghost" size="icon-xs" aria-label="Close preview" onClick={onClose}>
          <X />
        </Button>
      </Tooltip>
    </div>
  );
}
