import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifySlackSignature } from './verify.js';

const SECRET = 'test-signing-secret';
const BODY = 'command=%2Fmyprs&user_id=U123&response_url=https%3A%2F%2Fhooks.slack.com%2Fx';

function sign(timestamp: string, body = BODY, secret = SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

test('accepts a correctly signed, fresh request', () => {
  const timestamp = '1700000000';
  const result = verifySlackSignature({
    signingSecret: SECRET,
    signature: sign(timestamp),
    timestamp,
    rawBody: BODY,
    now: 1700000010,
  });
  assert.deepEqual(result, { ok: true });
});

test('rejects a replay outside the five-minute window', () => {
  const timestamp = '1700000000';
  const result = verifySlackSignature({
    signingSecret: SECRET,
    signature: sign(timestamp),
    timestamp,
    rawBody: BODY,
    now: 1700000000 + 301,
  });
  assert.deepEqual(result, { ok: false, reason: 'stale_timestamp' });
});

test('rejects a body tampered with after signing', () => {
  const timestamp = '1700000000';
  const result = verifySlackSignature({
    signingSecret: SECRET,
    signature: sign(timestamp),
    timestamp,
    rawBody: `${BODY}&injected=1`,
    now: 1700000010,
  });
  assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
});

test('rejects a signature made with a different secret', () => {
  const timestamp = '1700000000';
  const result = verifySlackSignature({
    signingSecret: SECRET,
    signature: sign(timestamp, BODY, 'wrong-secret'),
    timestamp,
    rawBody: BODY,
    now: 1700000010,
  });
  assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
});

test('rejects a request with no signature headers', () => {
  const result = verifySlackSignature({
    signingSecret: SECRET,
    signature: null,
    timestamp: null,
    rawBody: BODY,
  });
  assert.deepEqual(result, { ok: false, reason: 'missing_signature_headers' });
});

test('rejects a signature of a different length without throwing', () => {
  const timestamp = '1700000000';
  const result = verifySlackSignature({
    signingSecret: SECRET,
    signature: 'v0=short',
    timestamp,
    rawBody: BODY,
    now: 1700000010,
  });
  assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
});
