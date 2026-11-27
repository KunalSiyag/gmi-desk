/**
 * One-shot options of an approval that the tool itself must honour (§8.2.6, §9.4): "Allow once" with
 * "allow writes to sensitive files" lifts the read-only mounts of execution-sensitive files for that one command.
 * The loop notes the decision for the internal tool-call id; the shell tool takes it (once) when it runs.
 */
import type { ApprovalDecision } from '@shared/contracts/code';

export interface CallGrant {
  sensitiveWrites: boolean;
}

export interface CallGrants {
  note(toolCallId: string, decision: ApprovalDecision): void;
  /** Returns and forgets the grant of this call (default: nothing extra). */
  take(toolCallId: string): CallGrant;
  clear(): void;
}

export function createCallGrants(limit = 1_024): CallGrants {
  const grants = new Map<string, CallGrant>();
  return {
    note(toolCallId, decision) {
      if (decision.kind !== 'allow_once' || !decision.sensitiveWrites) return;
      grants.set(toolCallId, { sensitiveWrites: true });
      while (grants.size > limit) grants.delete(grants.keys().next().value as string);
    },
    take(toolCallId) {
      const g = grants.get(toolCallId) ?? { sensitiveWrites: false };
      grants.delete(toolCallId);
      return g;
    },
    clear: () => grants.clear(),
  };
}
