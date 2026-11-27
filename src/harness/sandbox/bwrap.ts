/**
 * The bubblewrap argv (harness.md §8.3). This one builder produces the argv of every sandboxed command AND of the
 * self-test (SC-9: an earlier argv used `--disable-userns` without `--unshare-user`, which bwrap 0.11 rejects, while
 * a different self-test argv passed).
 *
 *   bwrap --die-with-parent --new-session --unshare-all --unshare-user --disable-userns [--share-net]
 *         <mounts from profiles.ts> --chdir <cwd> --clearenv --setenv … -- <argv>
 *
 * The network namespace is always new unless the per-command `shared` fallback was approved (`local_network`).
 */
import type { SandboxSpec } from '../types';
import { planMounts, type HostLayout, type Mount, type PlanExtras, type SandboxPlan } from './profiles';

export const BWRAP_BASE_FLAGS = ['--die-with-parent', '--new-session', '--unshare-all', '--unshare-user', '--disable-userns'] as const;

function mountArgs(m: Mount): string[] {
  switch (m.op) {
    case 'ro-bind':
    case 'bind':
    case 'ro-bind-try':
      return [`--${m.op}`, m.src, m.dest];
    case 'tmpfs':
      return ['--tmpfs', m.dest];
    case 'symlink':
      return ['--symlink', m.target, m.dest];
    case 'dev':
      return ['--dev', m.dest];
    case 'proc':
      return ['--proc', m.dest];
    case 'remount-ro':
      return ['--remount-ro', m.dest];
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Argv after the `bwrap` binary for a plan. */
export function bwrapArgsFromPlan(plan: SandboxPlan): string[] {
  const args: string[] = [...BWRAP_BASE_FLAGS];
  if (plan.shareNet) args.push('--share-net');
  for (const m of plan.mounts) args.push(...mountArgs(m));
  args.push('--chdir', plan.cwd, '--clearenv');
  for (const name of Object.keys(plan.env).sort()) {
    const value = plan.env[name];
    if (value === undefined || !ENV_NAME.test(name) || value.includes('\0')) continue;
    args.push('--setenv', name, value);
  }
  args.push('--', ...plan.argv);
  return args;
}

/** The full production argv: `[bwrapPath, ...args]`. */
export function buildBwrapArgv(bwrapPath: string, spec: SandboxSpec, layout: HostLayout, extras: PlanExtras): string[] {
  return [bwrapPath, ...bwrapArgsFromPlan(planMounts(spec, layout, extras))];
}
