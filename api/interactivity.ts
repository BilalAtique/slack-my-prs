import { waitUntil } from '@vercel/functions';

import { approvePullRequests, extractPullRequestLinks } from '../src/approve.js';
import { buildApprovalMessage, buildNoticeMessage, type SlackMessage } from '../src/blocks.js';
import { verifySlackSignature } from '../src/verify.js';

const APPROVE_CALLBACK_ID = 'approve_prs';

type MessageShortcut = {
  responseUrl: string;
  userId: string;
  text: string;
  channelId: string;
  messageTs: string;
};

export async function POST(request: Request): Promise<Response> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const githubToken = process.env.GITHUB_TOKEN;

  if (!signingSecret || !githubToken) {
    console.error('missing env: SLACK_SIGNING_SECRET and GITHUB_TOKEN are both required');
    return new Response('not configured', { status: 500 });
  }

  const rawBody = await request.text();
  const verdict = verifySlackSignature({
    signingSecret,
    signature: request.headers.get('x-slack-signature'),
    timestamp: request.headers.get('x-slack-request-timestamp'),
    rawBody,
  });
  if (!verdict.ok) {
    console.warn(`rejected interaction: ${verdict.reason}`);
    return new Response(verdict.reason, { status: 401 });
  }

  const shortcut = parseMessageShortcut(new URLSearchParams(rawBody).get('payload'));
  if (!shortcut) return new Response('unsupported interaction', { status: 400 });

  // The approvals are made as the token owner. So, unlike the read-only /myprs, an
  // empty allowlist lets nobody approve.
  const allowlist = (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (!allowlist.includes(shortcut.userId)) {
    waitUntil(deliver(shortcut.responseUrl, buildNoticeMessage('This shortcut is not enabled for your account.')));
    return new Response(null, { status: 200 });
  }

  // Slack waits three seconds for the ack, and two GitHub calls per pull request
  // can take longer. So the result goes to response_url afterwards.
  waitUntil(approveAndReport(shortcut, githubToken, process.env.SLACK_USER_TOKEN));
  return new Response(null, { status: 200 });
}

function parseMessageShortcut(raw: string | null): MessageShortcut | null {
  if (!raw) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(payload) || payload.type !== 'message_action' || payload.callback_id !== APPROVE_CALLBACK_ID) {
    return null;
  }
  const { response_url: responseUrl, user, message, channel } = payload;
  if (typeof responseUrl !== 'string' || !isRecord(user) || typeof user.id !== 'string') return null;
  if (!isRecord(channel) || typeof channel.id !== 'string' || !channel.id) return null;
  if (!isRecord(message) || typeof message.ts !== 'string' || !message.ts) return null;
  const text = typeof message.text === 'string' ? message.text : '';
  return { responseUrl, userId: user.id, text, channelId: channel.id, messageTs: message.ts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function approveAndReport(shortcut: MessageShortcut, token: string, slackToken: string | undefined): Promise<void> {
  const outcomes = await approvePullRequests({ token, refs: extractPullRequestLinks(shortcut.text) });
  const message = buildApprovalMessage(outcomes);
  const allComplete =
    outcomes.length > 0 &&
    outcomes.every((outcome) =>
      outcome.status === 'approved' ||
      (outcome.status === 'skipped' && ['Already approved', 'Already merged'].includes(outcome.detail)),
    );
  if (allComplete) {
    try {
      await addDoneReaction(shortcut, slackToken);
      console.info('done reaction confirmed', { channel: shortcut.channelId, timestamp: shortcut.messageTs });
    } catch (error) {
      console.error('done reaction failed', error);
      const notice = buildNoticeMessage('Could not add the done reaction. Your PR approvals are complete.');
      message.text += ` ${notice.text}`;
      message.blocks.push(...notice.blocks);
    }
  }
  await deliver(shortcut.responseUrl, message);
}

async function addDoneReaction(shortcut: MessageShortcut, token: string | undefined): Promise<void> {
  if (!token) throw new Error('SLACK_USER_TOKEN is not configured');
  const response = await fetch('https://slack.com/api/reactions.add', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: shortcut.channelId, timestamp: shortcut.messageTs, name: 'white_check_mark' }),
  });
  if (!response.ok) throw new Error(`Slack returned ${response.status}`);
  const result: unknown = await response.json();
  if (isRecord(result) && (result.ok === true || result.error === 'already_reacted')) return;
  throw new Error(`Slack rejected the done reaction: ${isRecord(result) ? String(result.error) : 'invalid response'}`);
}

async function deliver(responseUrl: string, message: SlackMessage): Promise<void> {
  const response = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    console.error(`response_url delivery failed: ${response.status} ${await response.text()}`);
  }
}
