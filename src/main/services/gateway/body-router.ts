/**
 * GMI Router body (harness.md §4.2, §4.7): `{messages, mode, stream}` only — the router ignores tools,
 * temperature and max_tokens [V: D6]. Requests with tools are refused (invalid_input) before this is built.
 */
import type { RouterMode } from '@shared/contracts/app';
import type { GatewayRequest } from '@shared/contracts/gateway';
import { GMI_URLS } from '@shared/app';
import { toRouterMessages } from './messages';

export const ROUTER_URL = `${GMI_URLS.router}/autoroute`;

export function buildRouterBody(req: Pick<GatewayRequest, 'messages'>, mode: RouterMode): Record<string, unknown> {
  return { messages: toRouterMessages(req.messages), mode, stream: true };
}
