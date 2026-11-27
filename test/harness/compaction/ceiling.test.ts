// H2-C: the §7.4 ceiling (window, reserve, economy) and the token / message-count / cost triggers.
import { describe, expect, it } from 'vitest';
import { CODE_DEFAULTS } from '@shared/contracts/code';
import type { CeilingInput, TriggerInput } from '@harness/types';
import { compactionTrigger, computeCeiling, overflowTargets, shouldPrecompute } from '@harness/loop/compaction';
import { fakeCompactor } from '../fakes';

const base: CeilingInput = {
  modelContextTokens: 1_000_000,
  maxContextTokens: CODE_DEFAULTS.maxContextTokens,
  maxOutputTokens: CODE_DEFAULTS.maxOutputTokens,
  economy: false,
  tierBoundaryTokens: null,
  prefixTokens: 6_000,
};

describe('ceiling (§7.4)', () => {
  it('at the defaults C = 160,000 − (24,000 + 16,384) = 119,616 and keep = 20k', () => {
    const c = computeCeiling(base);
    expect(c).toEqual({ windowTokens: 160_000, reserveTokens: 40_384, ceilingTokens: 119_616, keepTokens: 20_000, economy: 'off', tierBoundaryTokens: null });
    // The H2-0 fake uses the same formula, so the loop's tests and the real compactor agree.
    expect(fakeCompactor().ceiling(base)).toMatchObject({ windowTokens: 160_000, reserveTokens: 40_384, ceilingTokens: 119_616, keepTokens: 20_000 });
  });

  it('W = min(model window, maxContextTokens); null maxContextTokens = the full window; unknown window = 128k', () => {
    expect(computeCeiling({ ...base, maxContextTokens: null }).windowTokens).toBe(1_000_000);
    expect(computeCeiling({ ...base, modelContextTokens: 64_000 }).windowTokens).toBe(64_000);
    expect(computeCeiling({ ...base, modelContextTokens: null, maxContextTokens: null }).windowTokens).toBe(128_000);
    expect(computeCeiling({ ...base, modelContextTokens: null }).windowTokens).toBe(128_000);
    // The reserve floor of 16,384 applies to small windows: 64k − (16,384 + 16,384) = 31,232.
    expect(computeCeiling({ ...base, modelContextTokens: 64_000 }).ceilingTokens).toBe(31_232);
  });

  it('keep = min(20k, 0.25·C)', () => {
    expect(computeCeiling({ ...base, modelContextTokens: 64_000 }).keepTokens).toBe(7_808);
    expect(computeCeiling({ ...base, maxContextTokens: null }).keepTokens).toBe(20_000);
  });

  it('a window smaller than the reserve gives C = 0, never negative', () => {
    expect(computeCeiling({ ...base, modelContextTokens: 16_000 })).toMatchObject({ ceilingTokens: 0, keepTokens: 0 });
  });

  describe('economy: C = min(W − R, floor(0.95 × tier)), only when C ≥ prefix + keep + 8k', () => {
    it('Qwen3-Coder, 32k tier: C = 30,400 (the old formula gave −385)', () => {
      const c = computeCeiling({ ...base, modelContextTokens: 262_144, economy: true, tierBoundaryTokens: 32_000 });
      expect(c).toMatchObject({ ceilingTokens: 30_400, keepTokens: 7_600, economy: 'on', tierBoundaryTokens: 32_000 });
    });

    it('Qwen3-Coder, 128k tier: at the 160k default W − R binds; with the full window the tier does', () => {
      expect(computeCeiling({ ...base, modelContextTokens: 262_144, economy: true, tierBoundaryTokens: 128_000 })).toMatchObject({ ceilingTokens: 119_616, economy: 'on' });
      const full = computeCeiling({ ...base, modelContextTokens: 262_144, maxContextTokens: null, economy: true, tierBoundaryTokens: 128_000 });
      expect(full).toMatchObject({ windowTokens: 262_144, ceilingTokens: 121_600, keepTokens: 20_000, economy: 'on' });
    });

    it('MiniMax-M3 at 512k: full 1M window → C = 486,400; the 160k default is below the tier anyway', () => {
      expect(computeCeiling({ ...base, maxContextTokens: null, economy: true, tierBoundaryTokens: 512_000 })).toMatchObject({ ceilingTokens: 486_400, economy: 'on' });
      expect(computeCeiling({ ...base, economy: true, tierBoundaryTokens: 512_000 })).toMatchObject({ ceilingTokens: 119_616, economy: 'on' });
    });

    it('disabled where the cheap tier is too small for agent work (notice economy_disabled)', () => {
      // 16k tier: 15,200 < 6,000 + 3,800 + 8,192.
      expect(computeCeiling({ ...base, economy: true, tierBoundaryTokens: 16_000 })).toMatchObject({ ceilingTokens: 119_616, economy: 'disabled' });
      // 32k tier with a 15k prefix: 30,400 < 15,000 + 7,600 + 8,192.
      expect(computeCeiling({ ...base, prefixTokens: 15_000, economy: true, tierBoundaryTokens: 32_000 })).toMatchObject({ ceilingTokens: 119_616, economy: 'disabled' });
      // Exactly at the edge it is enabled: 30,400 = 14,608 + 7,600 + 8,192.
      expect(computeCeiling({ ...base, prefixTokens: 14_608, economy: true, tierBoundaryTokens: 32_000 }).economy).toBe('on');
    });

    it('economy without a known tier, or switched off, changes nothing', () => {
      expect(computeCeiling({ ...base, economy: true, tierBoundaryTokens: null })).toMatchObject({ ceilingTokens: 119_616, economy: 'off' });
      expect(computeCeiling({ ...base, economy: false, tierBoundaryTokens: 32_000 })).toMatchObject({ ceilingTokens: 119_616, economy: 'off' });
    });
  });
});

describe('triggers (§7.4)', () => {
  const ceiling = computeCeiling(base);
  const t = (over: Partial<TriggerInput>): TriggerInput => ({ ceiling, sizeTokens: 10_000, messageCount: 10, nextStepCachedUsd: 0.001, perTurnUsd: 1, ...over });

  it('tokens: S ≥ C', () => {
    expect(compactionTrigger(t({ sizeTokens: 119_615 }))).toBeNull();
    expect(compactionTrigger(t({ sizeTokens: 119_616 }))).toBe('tokens');
  });

  it('message count: more than 1,500 messages in context', () => {
    expect(compactionTrigger(t({ messageCount: 1_500 }))).toBeNull();
    expect(compactionTrigger(t({ messageCount: 1_501 }))).toBe('messages');
  });

  it('cost: the projected cached step cost above perTurnUsd / 20 (expensive models compact earlier)', () => {
    expect(compactionTrigger(t({ nextStepCachedUsd: 0.05 }))).toBeNull();
    expect(compactionTrigger(t({ nextStepCachedUsd: 0.0501 }))).toBe('cost');
    expect(compactionTrigger(t({ nextStepCachedUsd: 0.03, perTurnUsd: 0.5 }))).toBe('cost');
    // Unknown price or no per-turn cap: no cost trigger.
    expect(compactionTrigger(t({ nextStepCachedUsd: null }))).toBeNull();
    expect(compactionTrigger(t({ nextStepCachedUsd: 5, perTurnUsd: null }))).toBeNull();
  });

  it('tokens take precedence when several fire', () => {
    expect(compactionTrigger(t({ sizeTokens: 200_000, messageCount: 2_000, nextStepCachedUsd: 1 }))).toBe('tokens');
  });

  it('precompute at 85 % of a trigger; for tokens only from S ≥ 32k', () => {
    expect(shouldPrecompute(t({ sizeTokens: 101_674 }))).toBe(true); // ≥ 0.85 · 119,616 = 101,673.6
    expect(shouldPrecompute(t({ sizeTokens: 101_000 }))).toBe(false);
    expect(shouldPrecompute(t({ messageCount: 1_276 }))).toBe(true);
    expect(shouldPrecompute(t({ messageCount: 1_275 }))).toBe(false);
    expect(shouldPrecompute(t({ nextStepCachedUsd: 0.043 }))).toBe(true);
    expect(shouldPrecompute(t({ nextStepCachedUsd: 0.042 }))).toBe(false);
    // Economy ceiling of 30,400: 85 % is 25,840 but the 32k floor wins.
    const small = computeCeiling({ ...base, modelContextTokens: 262_144, economy: true, tierBoundaryTokens: 32_000 });
    expect(shouldPrecompute({ ceiling: small, sizeTokens: 30_000, messageCount: 10, nextStepCachedUsd: null, perTurnUsd: 1 })).toBe(false);
  });
});

describe('layer-2 shrink levels (§7.5)', () => {
  it('85 %, 70 %, 50 % and 35 % of the rejected size', () => {
    expect(overflowTargets(200_000)).toEqual([170_000, 140_000, 100_000, 70_000]);
    expect(overflowTargets(-5)).toEqual([0, 0, 0, 0]);
  });
});
