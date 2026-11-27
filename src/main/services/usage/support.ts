import { GmiError, toGmiError } from '@shared/contracts/errors';
import { SUPPORT_LIMITS, type SupportApi } from '@shared/contracts/usage';
import type { Logger } from '../../core/logger';
import type { McpGateway } from '../../core/services';
import { isRecord, nonEmptyString } from './util';

export const SUPPORT_TIMEOUT_MS = 60_000;
// Filed is all we know: GMI records the request; nobody has necessarily seen it yet.
const DEFAULT_MESSAGE = 'Your request was filed with GMI support.';
const ID_KEYS = ['submission_id', 'submissionId', 'ticket_id', 'ticketId', 'request_id', 'requestId', 'case_id', 'caseId', 'ticket_number', 'reference', 'id'];
const NESTED_KEYS = ['submission', 'ticket', 'request', 'result', 'data'];

/** Subject on one line; description keeps its line breaks. Throws invalid_input with the field's limits. */
export function validateSupportInput(input: unknown): { subject: string; description: string } {
  if (!isRecord(input)) throw new GmiError('invalid_input', 'Add a subject and a description.');
  const subject = typeof input.subject === 'string' ? input.subject.replace(/\s+/g, ' ').trim() : '';
  const description = typeof input.description === 'string' ? input.description.replace(/\r\n?/g, '\n').trim() : '';
  const L = SUPPORT_LIMITS;
  if (subject.length < L.subjectMin) throw new GmiError('invalid_input', `The subject needs at least ${L.subjectMin} characters.`);
  if (subject.length > L.subjectMax) throw new GmiError('invalid_input', `Keep the subject to ${L.subjectMax} characters.`);
  if (description.length < L.descriptionMin) {
    throw new GmiError('invalid_input', `Describe the problem in at least ${L.descriptionMin} characters.`);
  }
  if (description.length > L.descriptionMax) {
    throw new GmiError('invalid_input', `Keep the description to ${L.descriptionMax.toLocaleString('en-US')} characters.`);
  }
  return { subject, description };
}

function findId(raw: Record<string, unknown>, depth = 0): string | null {
  for (const key of ID_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  if (depth > 0) return null;
  for (const key of NESTED_KEYS) {
    const nested = raw[key];
    if (isRecord(nested)) {
      const id = findId(nested, depth + 1);
      if (id) return id;
    }
  }
  return null;
}

/** The tool's result shape is not documented: accept {submission_id|id|…, message} or plain text. */
export function parseSupportResult(raw: unknown): { submissionId: string | null; message: string } {
  if (typeof raw === 'string') {
    const text = raw.trim();
    // "Submission ID: 7f3c2a10", "Ticket #12345" (a separator is required: "Ticket created" has no id).
    const id = /\b(?:submission|ticket|request|case)(?:\s+(?:id|number|no\.?))?\s*[:#]\s*([A-Za-z0-9][\w-]{3,})/i.exec(text)?.[1] ?? null;
    return { submissionId: id, message: text ? text.slice(0, 1000) : DEFAULT_MESSAGE };
  }
  if (isRecord(raw)) {
    const message = nonEmptyString(raw.message) ?? nonEmptyString(raw.detail) ?? nonEmptyString(raw.status_message) ?? DEFAULT_MESSAGE;
    return { submissionId: findId(raw), message: message.slice(0, 1000) };
  }
  return { submissionId: null, message: DEFAULT_MESSAGE };
}

/**
 * Every call files a NEW ticket with GMI support: validate first, call exactly once, never retry,
 * and refuse a second request while one is in flight.
 */
export function createSupportApi(mcp: McpGateway, log: Logger): SupportApi {
  let sending = false;
  return {
    async createRequest(input) {
      const valid = validateSupportInput(input);
      if (sending) throw new GmiError('invalid_input', 'A support request is already being sent.');
      sending = true;
      try {
        const raw = await mcp.callTool('create_support_request', valid, { timeoutMs: SUPPORT_TIMEOUT_MS });
        const result = parseSupportResult(raw);
        log.info('support request filed', { submissionId: result.submissionId });
        return result;
      } catch (error) {
        const err = toGmiError(error);
        if (err.code === 'timeout' || err.code === 'upstream') {
          // GMI may have filed it before failing; a blind resend would open a duplicate ticket.
          throw new GmiError(err.code, `${err.message} The ticket may still have been filed: check your email before sending it again.`, {
            status: err.status,
            detail: err.detail,
            cause: error,
          });
        }
        throw err;
      } finally {
        sending = false;
      }
    },
  };
}
