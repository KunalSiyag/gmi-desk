import { describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { silentLogger } from '@main/core/logger';
import { createSupportApi, parseSupportResult, SUPPORT_TIMEOUT_MS, validateSupportInput } from '@main/services/usage/support';
import { fakeMcp } from './fakes';

const OK = { subject: 'Video job stuck in processing', description: 'Job 1234 has been processing for 3 hours.\nModel: wan3.0-video' };

describe('validateSupportInput', () => {
  it.each([
    [undefined, /subject and a description/],
    [{ subject: 'ab', description: OK.description }, /at least 3/],
    [{ subject: 'x'.repeat(201), description: OK.description }, /200 characters/],
    [{ subject: OK.subject, description: 'too short' }, /at least 10/],
    [{ subject: OK.subject, description: 'x'.repeat(5001) }, /5,000 characters/],
    [{ subject: 42, description: OK.description }, /at least 3/],
  ])('rejects %j', (input, message) => {
    expect(() => validateSupportInput(input)).toThrowError(message);
    try {
      validateSupportInput(input);
    } catch (e) {
      expect((e as GmiError).code).toBe('invalid_input');
    }
  });

  it('puts the subject on one line and keeps description line breaks (trimmed)', () => {
    expect(validateSupportInput({ subject: '  Billing \n question ', description: '\r\nLine one\r\nLine two  ' })).toEqual({
      subject: 'Billing question',
      description: 'Line one\nLine two',
    });
    expect(validateSupportInput({ subject: 'x'.repeat(200), description: 'y'.repeat(5000) }).subject).toHaveLength(200);
  });
});

describe('parseSupportResult', () => {
  it('reads the id and message from common shapes', () => {
    expect(parseSupportResult({ submission_id: 'SR-1', message: 'Filed.' })).toEqual({ submissionId: 'SR-1', message: 'Filed.' });
    expect(parseSupportResult({ id: 1234, status: 'open' })).toEqual({ submissionId: '1234', message: 'Your request was filed with GMI support.' });
    expect(parseSupportResult({ ticket: { id: 'T-9' }, detail: 'ok' })).toEqual({ submissionId: 'T-9', message: 'ok' });
    expect(parseSupportResult('Submission ID: 7f3c2a10 — we will reply by email.')).toEqual({
      submissionId: '7f3c2a10',
      message: 'Submission ID: 7f3c2a10 — we will reply by email.',
    });
    expect(parseSupportResult(null)).toEqual({ submissionId: null, message: 'Your request was filed with GMI support.' });
  });
});

describe('createRequest', () => {
  it('validates, then calls create_support_request exactly once with the cleaned input', async () => {
    const { mcp, calls } = fakeMcp({ create_support_request: () => ({ submission_id: 'SR-42', message: 'Submitted.' }) });
    const support = createSupportApi(mcp, silentLogger);
    await expect(support.createRequest({ subject: 'x', description: OK.description })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toHaveLength(0);
    await expect(support.createRequest({ subject: ` ${OK.subject} `, description: OK.description })).resolves.toEqual({
      submissionId: 'SR-42',
      message: 'Submitted.',
    });
    expect(calls).toEqual([
      { name: 'create_support_request', args: { subject: OK.subject, description: OK.description }, opts: { timeoutMs: SUPPORT_TIMEOUT_MS } },
    ]);
  });

  it('never retries a failed submission and warns that a timed-out ticket may exist', async () => {
    const { mcp, calls } = fakeMcp({
      create_support_request: () => {
        throw new GmiError('timeout', 'GMI took too long to answer.');
      },
    });
    const support = createSupportApi(mcp, silentLogger);
    const error = await support.createRequest(OK).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'timeout' });
    expect((error as Error).message).toMatch(/may still have been filed/);
    expect(calls).toHaveLength(1);
  });

  it('passes sign-in and scope errors through unchanged', async () => {
    const { mcp } = fakeMcp({
      create_support_request: () => {
        throw new GmiError('insufficient_scope', 'support:write was not granted');
      },
    });
    await expect(createSupportApi(mcp, silentLogger).createRequest(OK)).rejects.toMatchObject({
      code: 'insufficient_scope',
      message: 'support:write was not granted',
    });
  });

  it('refuses a second request while one is in flight (no duplicate tickets)', async () => {
    let release: (value: unknown) => void = () => undefined;
    const { mcp, calls } = fakeMcp({ create_support_request: () => new Promise((resolve) => (release = resolve)) });
    const support = createSupportApi(mcp, silentLogger);
    const first = support.createRequest(OK);
    await expect(support.createRequest(OK)).rejects.toMatchObject({ code: 'invalid_input' });
    release({ submission_id: 'SR-1' });
    await expect(first).resolves.toMatchObject({ submissionId: 'SR-1' });
    expect(calls).toHaveLength(1);
    // Once settled, a deliberate new request is allowed.
    const second = support.createRequest(OK);
    release({ submission_id: 'SR-2' });
    await expect(second).resolves.toMatchObject({ submissionId: 'SR-2' });
  });
});
