// Loaded before every test file (vitest.config.ts › setupFiles).
// vi.waitFor's default timeout is 1 s, too tight when the full suite (sqlite fsync, bubblewrap, git) loads the machine.
// Waits still return as soon as the condition holds; only a genuinely failing wait takes longer to report.
import { vi } from 'vitest';

const waitFor = vi.waitFor.bind(vi);
vi.waitFor = ((callback: Parameters<typeof vi.waitFor>[0], options?: Parameters<typeof vi.waitFor>[1]) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: 15_000, ...options })) as typeof vi.waitFor;
