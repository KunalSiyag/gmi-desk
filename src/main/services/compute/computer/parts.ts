// The computer's parts (compute.md §8.3–8.5, §14): C2-B's files, transfers, ports and services and C2-C's previews,
// exposed as `ComputerApi` methods over C2-A's sessions. Written by the C2 integrator.
//
// Every method turns a `sessionId` into a `ComputerTarget` through `sessions.handle(sid, {requireReady: true})` (a
// paused or closed session refuses with conflict / not_found) and passes the session's abort signal where a module
// takes one, so work for a closed session is cancelled. A closing session cancels its transfers, forgets its port
// cache and closes its previews. A renderer that reloaded or crashed loses its preview ids: every preview closes.
import type { ComputerApi } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { PreviewHost } from '../../../core/preview-host';
import { createExecRunner, type ComputerTarget } from './exec';
import { createFileService } from './files';
import type { ComputerPart, ComputerPartContext, ComputerPartFactory } from './index';
import { createPortScanner } from './ports';
import { createPlaceholderPreviewHost, createPreviewManager, previewApi, type PreviewAccess, type PreviewManager } from './preview';
import { createServiceManager } from './services';
import type { ComputerSessionHandle } from './session';
import { createTransferManager } from './transfers';

export interface ComputerPartsOptions {
  /** True while the main window is minimised or hidden: the Ports tab's poll then runs no exec. */
  windowHidden?: () => boolean;
  /** Tests: a preview host other than the context's (mock mode uses the placeholder host by default). */
  previewHost?: PreviewHost;
  /** Tests: preview manager overrides (timers). */
  preview?: { tokenSyncMs?: number };
}

/** What the computer service learns about the parts after building them (tests, Diagnostics). */
export interface ComputerPartsHandle {
  previews: PreviewManager;
}

const isPreviewHost = (v: unknown): v is PreviewHost =>
  typeof v === 'object' && v !== null && typeof (v as PreviewHost).create === 'function' && typeof (v as PreviewHost).onEvent === 'function';

/** One part with every non-session `ComputerApi` method. */
export function computerParts(opts: ComputerPartsOptions = {}, out?: (handle: ComputerPartsHandle) => void): ComputerPartFactory {
  return (c: ComputerPartContext): ComputerPart => {
    const { ctx, sessions, dataPlane, internals } = c;
    const log = c.log;
    const activity = internals.guard.activity;
    const runner = createExecRunner({ dataPlane, execPort: c.execPort, activity, log });
    const files = createFileService({ runner, dataPlane, log });
    const ports = createPortScanner({ runner, log, windowHidden: opts.windowHidden });
    const services = createServiceManager({ runner, ports, registry: internals.registry, secrets: internals.secrets, log, now: () => ctx.now() });
    const transfers = createTransferManager({
      runner,
      files,
      dataPlane,
      platform: ctx.platform,
      emit: (info) => ctx.events.emit('computer:transfer', info),
      log,
    });

    // Mock mode draws no native view and touches no network (§16, T17).
    const host = opts.previewHost ?? (ctx.mock || !isPreviewHost(c.previewHost) ? createPlaceholderPreviewHost() : c.previewHost);
    const handleOrNull = (sid: string): ComputerSessionHandle | null => {
      try {
        return sessions.handle(sid);
      } catch {
        return null;
      }
    };
    const toAccess = (a: { sandboxKey: string; domain: string; trafficToken: string }): PreviewAccess => ({ sandboxKey: a.sandboxKey, domain: a.domain, trafficToken: a.trafficToken });
    const previews = createPreviewManager({
      host,
      session(sid) {
        const h = handleOrNull(sid);
        if (!h) return null;
        return { sessionId: h.sessionId, resourceId: h.resourceId, kind: 'sandbox', secure: internals.registry.get(h.resourceId)?.secure ?? null };
      },
      async access(sid) {
        const h = sessions.handle(sid, { requireReady: true });
        return toAccess(await c.tokens.get(h.sandboxId));
      },
      peekAccess(sid) {
        const h = handleOrNull(sid);
        const a = h ? c.tokens.peek(h.sandboxId) : null;
        return a ? toAccess(a) : null;
      },
      activity,
      platform: ctx.platform,
      emit: (info) => ctx.events.emit('computer:preview', info),
      log: log.child('computer.preview'),
      tokenSyncMs: opts.preview?.tokenSyncMs,
    });
    out?.({ previews });

    const offClose = sessions.onClose((sid) => {
      transfers.closeSession(sid);
      ports.forget(sid);
      previews.closeSession(sid);
    });

    /** A ready (or reconnecting) session as a target, with its abort signal and home. */
    const target = (sid: string): { t: ComputerTarget; h: ComputerSessionHandle } => {
      const h = sessions.handle(sid, { requireReady: true });
      return { t: { sessionId: h.sessionId, resourceId: h.resourceId, sandboxId: h.sandboxId }, h };
    };

    const api: Partial<ComputerApi> = {
      async listDir(sid, path) {
        const { t, h } = target(sid);
        return files.listDir(t, path, { signal: h.signal });
      },
      async readFile(sid, path, o) {
        const { t, h } = target(sid);
        return files.readFile(t, path, { maxBytes: o?.maxBytes, signal: h.signal });
      },
      async writeFile(sid, path, text) {
        return files.writeFile(target(sid).t, path, text);
      },
      async makeDir(sid, path) {
        return files.makeDir(target(sid).t, path);
      },
      async movePath(sid, from, to) {
        return files.movePath(target(sid).t, from, to);
      },
      async removePath(sid, path) {
        const { t, h } = target(sid);
        return files.removePath(t, path, { home: h.home });
      },
      async upload(sid, remoteDir) {
        return transfers.upload(target(sid).t, remoteDir);
      },
      async download(sid, remotePath) {
        return transfers.download(target(sid).t, remotePath);
      },
      async cancelTransfer(transferId) {
        if (typeof transferId !== 'string' || !transferId) throw new GmiError('invalid_input', 'Not a valid transfer id.');
        return transfers.cancel(transferId);
      },
      async listPorts(sid) {
        return ports.listPorts(target(sid).t);
      },
      async startService(sid, svc) {
        const r = await services.start(target(sid).t, svc);
        if (svc.port && !r.portReady) log.info('service port not listening yet', { sid, port: svc.port });
        return sessions.info(sid);
      },
      async restartServices(sid) {
        await services.restart(target(sid).t);
        return sessions.info(sid);
      },
      async getResourceUsage(sid) {
        return services.usage(target(sid).t);
      },
      ...previewApi(previews),
    };

    return {
      api,
      sessionReady(sid) {
        // A connect or refresh may have brought new tokens: open previews pick them up (cached, no extra call).
        void previews.accessChanged(sid).catch(() => undefined);
      },
      viewsGone() {
        previews.closeAll();
      },
      async dispose() {
        offClose();
        previews.dispose();
        if (!opts.previewHost && host !== c.previewHost) host.dispose();
        await transfers.dispose();
      },
    };
  };
}
