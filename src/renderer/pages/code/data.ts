import { useQuery } from '@tanstack/react-query';
import type { ApprovalRequest, CodeProject, CodeState, CodeThread, CodeThreadSummary, DiffFile } from '@shared/contracts/code';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';

export function useCodeState() {
  return useQuery({ queryKey: qk.codeState, queryFn: () => gmi.code.getState(), staleTime: 15_000 });
}

export function useCodeProjects() {
  return useQuery({ queryKey: qk.codeProjects, queryFn: () => gmi.code.listProjects(), staleTime: 30_000 });
}

export function useCodeThreads(projectId?: string) {
  return useQuery({
    queryKey: [...qk.codeThreads, projectId ?? 'all'] as const,
    queryFn: () => gmi.code.listThreads(projectId ? { projectId } : undefined),
    staleTime: 15_000,
  });
}

export function useCodeThread(threadId: string | null) {
  return useQuery({
    queryKey: qk.codeThread(threadId ?? 'none'),
    queryFn: () => gmi.code.getThread(threadId!),
    enabled: Boolean(threadId),
    staleTime: 10_000,
  });
}

export function useCodeTimeline(threadId: string | null) {
  return useQuery({
    queryKey: qk.codeTimeline(threadId ?? 'none'),
    queryFn: () => gmi.code.getTimeline(threadId!, { limit: 400 }),
    enabled: Boolean(threadId),
    staleTime: Infinity,
  });
}

export function useCodeApprovals() {
  return useQuery<ApprovalRequest[]>({ queryKey: qk.codeApprovals, queryFn: () => gmi.code.listPendingApprovals(), staleTime: 5_000 });
}

export function useCodeDiff(threadId: string | null) {
  return useQuery<DiffFile[]>({
    queryKey: qk.codeDiff(threadId ?? 'none'),
    queryFn: () => gmi.code.getDiff(threadId!),
    enabled: Boolean(threadId),
    staleTime: 10_000,
  });
}

export type { CodeProject, CodeState, CodeThread, CodeThreadSummary };
