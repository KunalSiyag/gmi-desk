// Registration of the Code tab (harness.md §12): the `code` namespace, real service from H3-0.
import { CODE_API_METHODS, type CodeApi } from '@shared/contracts/code';
import type { AppContext } from '../core/context';
import type { GmiGateway, SliceHost } from '../core/services';
import { createNotImplementedApi } from '../ipc/registry';
import { createMockCode } from '../mock/code';
import { createCodeService } from '../services/code';
import type { ComputeSlice } from './compute';
import type { HarnessSlice } from './harness';

export interface CodeSliceDeps {
  gateway: GmiGateway;
  harness: HarnessSlice;
  /** Attaching a computer to a thread (H4-C). */
  compute: ComputeSlice;
}

/** Kept for contract tests: every method rejects with not_implemented. */
export function notImplementedCodeApi(): CodeApi {
  return createNotImplementedApi<CodeApi>('The Code tab', CODE_API_METHODS);
}

export async function setupCodeSlice(ctx: AppContext, deps: CodeSliceDeps, host: SliceHost): Promise<void> {
  const api = ctx.mock ? createMockCode({ gateway: deps.gateway }) : createCodeService(ctx, deps).api;
  host.registerApi('code', api);
}
