import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_VERSION = 'v0';

// Slack's own replay window. A request older than this is refused even when the
// signature is valid, so a captured request cannot be replayed later.
const MAX_SKEW_SECONDS = 300;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifySlackSignature(args: {
  signingSecret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  now?: number;
}): VerifyResult {
  const { signingSecret, signature, timestamp, rawBody } = args;

  if (!signature || !timestamp) return { ok: false, reason: 'missing_signature_headers' };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'bad_timestamp' };

  const now = args.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - sentAt) > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  const digest = createHmac('sha256', signingSecret)
    .update(`${SIGNATURE_VERSION}:${timestamp}:${rawBody}`)
    .digest('hex');
  const expected = Buffer.from(`${SIGNATURE_VERSION}=${digest}`, 'utf8');
  const received = Buffer.from(signature, 'utf8');

  // timingSafeEqual throws on a length mismatch, so the lengths are compared first.
  if (expected.length !== received.length) return { ok: false, reason: 'bad_signature' };

  return timingSafeEqual(expected, received) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
