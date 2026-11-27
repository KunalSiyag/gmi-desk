import { describe, expect, it } from 'vitest';
import { defaultCodeThreadSettings } from '@shared/contracts/code';
import { describeLoosening, isLoosening, looseningMessage } from '@main/services/code/loosening';

const base = defaultCodeThreadSettings({ model: 'm' });

describe('describeLoosening', () => {
  it('reports mode, window, network, web, computer and budget widenings', () => {
    expect(describeLoosening(base, { mode: 'full-access' })).toEqual(['approval mode auto-accept-edits → full-access']);
    expect(describeLoosening(base, { maxContextTokens: null })).toEqual(['context window 160,000 tokens → the full model window']);
    expect(describeLoosening(base, { network: 'ask' })).toEqual(['shell network off → ask']);
    expect(describeLoosening(base, { webFetch: 'allowlist' })).toEqual(['web access off → allowlist']);
    expect(describeLoosening(base, { computerId: 'cr_1' })).toEqual(['attach a computer to this thread']);
    expect(describeLoosening(base, { budget: { perTurnUsd: 2 } })).toEqual(['per-turn budget $1.00 → $2.00']);
    expect(describeLoosening(base, { budget: { perThreadUsd: null } })).toEqual(['per-thread budget $5.00 → unlimited']);
    expect(describeLoosening(base, { budget: { maxStepsPerTurn: 80 } })).toEqual(['step cap per turn 50 → 80']);
    expect(describeLoosening(base, { budget: { maxTurnMinutes: 60 } })).toEqual(['minutes per turn 30 → 60']);
  });

  it('is silent for tightening and for values that do not widen anything', () => {
    expect(describeLoosening(base, { mode: 'approval-required' })).toEqual([]);
    expect(describeLoosening(base, { maxContextTokens: 100_000 })).toEqual([]);
    expect(describeLoosening(base, { webFetch: 'off', network: 'off' })).toEqual([]);
    expect(describeLoosening(base, { computerId: null })).toEqual([]);
    expect(describeLoosening(base, { budget: { perTurnUsd: 0.5, maxStepsPerTurn: 10, maxTurnMinutes: 5 } })).toEqual([]);
    expect(isLoosening(base, { model: 'other' })).toBe(false);
  });

  it('detaches a computer as a change too', () => {
    const attached = defaultCodeThreadSettings({ model: 'm', computerId: 'cr_1' });
    expect(describeLoosening(attached, { computerId: null })).toEqual(['detach the computer']);
  });

  it('writes the native dialog body', () => {
    const message = looseningMessage('Fix the parser', ['approval mode auto-accept-edits → auto']);
    expect(message).toContain('This widens what Fix the parser may do:');
    expect(message).toContain('• approval mode auto-accept-edits → auto');
    expect(message).toContain('Only this thread changes. Continue?');
  });
});
