// Chat slice: threads (one JSON file each + an index) and streaming replies, which go through the GMI gateway
// (harness.md §4.8): GMI's chat completions / Responses APIs and GMI Router "Auto" mode. See service.ts.
import type { ChatApi } from '@shared/contracts/chat';
import { GATEWAY_TPM_TIERS } from '@shared/contracts/gateway';
import type { AppContext } from '../../core/context';
import type { GmiGateway } from '../../core/services';
import { createGatewayRuntime } from '../gateway';
import { systemClock, type GatewayRuntime } from '../gateway/types';
import { redactingKeys } from '../../slices/gateway';
import { createChatService, type ChatDeps, type ChatOptions } from './service';

export type { ChatOptions } from './service';

/**
 * The app passes the gateway slice's gateway (src/main/index.ts). Without one (tests, older callers) chat composes
 * a private gateway from `keys`, `catalog` and `budget`, and disposes it with the slice.
 */
export type ChatSliceDeps = Omit<ChatDeps, 'gateway'> & { gateway?: GmiGateway };
/** @deprecated Use ChatSliceDeps. */
export type { ChatSliceDeps as ChatDeps };

export interface ChatSlice {
  api: ChatApi;
  dispose(): void | Promise<void>;
}

export async function createChatSlice(ctx: AppContext, deps: ChatSliceDeps, opts: ChatOptions = {}): Promise<ChatSlice> {
  let own: GatewayRuntime | null = null;
  let gateway = deps.gateway;
  if (!gateway) {
    if (!deps.keys) throw new Error('The chat slice needs a gateway, or keys to compose one.');
    own = await createGatewayRuntime(
      {
        ctx,
        keys: redactingKeys(deps.keys),
        catalog: deps.catalog,
        budget: deps.budget,
        signals: { isOnline: () => true, onResume: () => () => undefined },
        tpmLimit: () => GATEWAY_TPM_TIERS.t1,
        clock: systemClock,
      },
      { mockSpeed: opts.mockSpeed },
    );
    gateway = own.gateway;
  }
  const service = await createChatService(ctx, { ...deps, gateway }, opts);
  return {
    api: service.api,
    async dispose() {
      await service.dispose();
      await own?.dispose();
    },
  };
}
