/**
 * Per-request trace (harness.md §4.3, §21): a memory ring of the last 1,000 settled requests and one
 * `gateway.request` info line each. Never bodies, prompts, outputs or keys: the record type has no field for them.
 *
 * The log line uses short key names (`prompt`, `cached`, …) because the logger redacts every key that contains
 * "token" (SECRET_KEY_PATTERN), which would hide the counts.
 */
import type { Logger } from '../../core/logger';
import { GATEWAY_LIMITS, type GatewayTrace, type GatewayTraceRecord } from './types';

export interface GatewayTraceDeps {
  log?: Logger;
  /** Ring size (GATEWAY_LIMITS.traceRing). */
  size?: number;
}

/** The `gateway.request` log fields for one record. */
export function traceLogLine(r: GatewayTraceRecord): Record<string, unknown> {
  return {
    reqId: r.requestId,
    purpose: r.purpose,
    priority: r.priority,
    threadId: r.threadId,
    runId: r.runId,
    step: r.step,
    model: r.model,
    api: r.api,
    attempts: r.attempts,
    queueMs: r.queueMs,
    ttfbMs: r.ttfbMs,
    totalMs: r.totalMs,
    prompt: r.promptTokens,
    cached: r.cachedTokens,
    cacheWrite: r.cacheWriteTokens,
    completion: r.completionTokens,
    reasoning: r.reasoningTokens,
    costUsd: r.costUsd,
    estimated: r.estimated,
    maybeBilled: r.maybeBilled,
    status: r.status,
    code: r.code,
    prefix8: r.prefixHash8,
  };
}

export function createGatewayTrace(deps: GatewayTraceDeps = {}): GatewayTrace {
  const size = Math.max(1, Math.floor(deps.size ?? GATEWAY_LIMITS.traceRing));
  const ring: Array<GatewayTraceRecord | undefined> = new Array(size);
  let next = 0;
  let count = 0;

  return {
    record(record) {
      const copy: GatewayTraceRecord = { ...record, prefixHash8: record.prefixHash8 ? record.prefixHash8.slice(0, 8) : null };
      ring[next] = copy;
      next = (next + 1) % size;
      count = Math.min(size, count + 1);
      deps.log?.info('gateway.request', traceLogLine(copy));
    },
    recent(limit = count) {
      const n = Math.max(0, Math.min(count, Math.floor(limit)));
      const out: GatewayTraceRecord[] = [];
      for (let i = 1; i <= n; i++) out.push({ ...ring[(next - i + size) % size]! });
      return out;
    },
  };
}
