/**
 * Steering (harness.md §6.5): a message sent while a run is active is queued and appended as ONE user message
 * (`steering: true`) after the current step's tool results, never mid-step, so the cached prefix is preserved.
 * Several queued messages are joined.
 */

export const STEER_LIMITS = {
  /** Queued messages per thread; more are refused (the user is typing faster than steps finish). */
  maxQueued: 20,
  /** Characters per message. */
  maxChars: 32_000,
} as const;

export interface SteerEntry {
  text: string;
  at: number;
}

export class SteerQueue {
  private readonly queues = new Map<string, SteerEntry[]>();

  push(threadId: string, text: string, at: number): boolean {
    const t = text.trim();
    if (!t) return false;
    const q = this.queues.get(threadId) ?? [];
    if (q.length >= STEER_LIMITS.maxQueued) return false;
    q.push({ text: t.length > STEER_LIMITS.maxChars ? t.slice(0, STEER_LIMITS.maxChars) : t, at });
    this.queues.set(threadId, q);
    return true;
  }

  pending(threadId: string): number {
    return this.queues.get(threadId)?.length ?? 0;
  }

  /** Takes every queued message; null when none. */
  drain(threadId: string): { text: string; parts: string[] } | null {
    const q = this.queues.get(threadId);
    if (!q || q.length === 0) return null;
    this.queues.delete(threadId);
    const parts = q.map((e) => e.text);
    return { text: joinSteering(parts), parts };
  }

  clear(threadId: string): void {
    this.queues.delete(threadId);
  }
}

/** Joined with a blank line; deterministic (it becomes history). */
export function joinSteering(parts: readonly string[]): string {
  return parts.join('\n\n');
}
