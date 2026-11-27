/**
 * Hardening of the bwrap spawn (review H2, sandbox lens):
 *
 * 1. A seccomp filter (`bwrap --seccomp 3`) that fails `add_key`, `keyctl` and `request_key` with EPERM, as Docker's
 *    and Flatpak's default filters do. bwrap's flags do not give the sandbox a new session keyring, so without it a
 *    sandboxed command could read keys of the user's session keyring and plant keys host processes then see.
 *    On x86_64 the x32 ABI (syscall numbers with bit 30 set) is refused entirely, so the same calls cannot be reached
 *    through it. Other architectures: no filter (the self-test reports it).
 *
 * 2. A launcher that closes every inherited descriptor above the ones we pass (0–2 and the seccomp fd 3) before it
 *    `exec`s bwrap. In an Electron utilityProcess some descriptors (an inotify fd, a NETLINK_ROUTE socket in the host's
 *    network namespace, the V8 snapshot) are not close-on-exec; Node keeps them across spawn and bwrap passes them on.
 */

/** classic BPF over `struct seccomp_data { int nr; u32 arch; … }`. */
const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;

interface ArchInfo {
  audit: number;
  /** add_key, request_key, keyctl. */
  syscalls: [number, number, number];
  x32: boolean;
}

const ARCHES: Partial<Record<NodeJS.Architecture, ArchInfo>> = {
  x64: { audit: 0xc000003e, syscalls: [248, 249, 250], x32: true },
  arm64: { audit: 0xc00000b7, syscalls: [217, 218, 219], x32: false },
};

/** The keyctl syscall number on this architecture (the self-test probe), or null. */
export function keyctlSyscall(arch: NodeJS.Architecture = process.arch): number | null {
  return ARCHES[arch]?.syscalls[2] ?? null;
}

function insn(code: number, jt: number, jf: number, k: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(code, 0);
  b.writeUInt8(jt, 2);
  b.writeUInt8(jf, 3);
  b.writeUInt32LE(k >>> 0, 4);
  return b;
}

/** The filter program for `arch` (little-endian sock_filter array), or null when the arch is unknown. */
export function seccompProgram(arch: NodeJS.Architecture = process.arch): Buffer | null {
  const a = ARCHES[arch];
  if (!a) return null;
  const [addKey, requestKey, keyctl] = a.syscalls;
  // Layout (indexes): 0 ld arch · 1 jeq arch (else → allow) · 2 ld nr · [3 jge x32 → deny] · jeq ×3 → deny · allow · deny
  const prog: Buffer[] = [];
  const body = a.x32 ? 4 : 3; // instructions between "ld nr" and "ret allow"
  prog.push(insn(BPF_LD_W_ABS, 0, 0, 4));
  prog.push(insn(BPF_JEQ_K, 0, body + 1, a.audit)); // mismatch → skip ld nr + body → ret allow
  prog.push(insn(BPF_LD_W_ABS, 0, 0, 0));
  let left = body; // instructions after the current one up to and including "ret allow"
  if (a.x32) {
    prog.push(insn(BPF_JGE_K, left, 0, 0x40000000));
    left -= 1;
  }
  for (const nr of [addKey, requestKey, keyctl]) {
    prog.push(insn(BPF_JEQ_K, left, 0, nr));
    left -= 1;
  }
  prog.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
  prog.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM));
  return Buffer.concat(prog);
}

/**
 * `bash -c <this> gmid-sandbox <bwrap> <args…>`: closes every descriptor above `$GMID_KEEP_FD` (inherited from the
 * host), then execs bwrap. The glob's own directory fd is gone by the time the loop closes descriptors.
 */
export const FD_CLOSE_LAUNCHER = 'keep=3; for f in /proc/self/fd/*; do n=${f##*/}; case $n in *[!0-9]*|"") continue;; esac; if [ "$n" -gt "$keep" ]; then eval "exec $n>&-" 2>/dev/null; fi; done; exec "$@"';

export const LAUNCHER_SHELL = '/bin/bash';
