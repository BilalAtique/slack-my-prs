import { waitUntil } from '@vercel/functions';

import { buildErrorMessage, buildNoticeMessage, buildPullRequestMessage, type SlackMessage } from '../src/blocks.ts';
import { fetchOpenPullRequests } from '../src/github.ts';
import { verifySlackSignature } from '../src/verify.ts';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const githubToken = process.env.GITHUB_TOKEN;
  const githubLogin = process.env.GITHUB_LOGIN;

  if (!signingSecret || !githubToken || !githubLogin) {
    console.error('missing env: SLACK_SIGNING_SECRET, GITHUB_TOKEN and GITHUB_LOGIN are all required');
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
    console.warn(`rejected slash command: ${verdict.reason}`);
    return new Response(verdict.reason, { status: 401 });
  }

  const form = new URLSearchParams(rawBody);
  const responseUrl = form.get('response_url');
  const callerId = form.get('user_id') ?? '';

  const allowlist = (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (allowlist.length > 0 && !allowlist.includes(callerId)) {
    return json(buildNoticeMessage('This command is not enabled for your account.'));
  }

  // Slack gives a slash command three seconds. GitHub usually answers in under
  // one, but a slow call must not surface as "operation timeout", so the ack is
  // empty and the real message is delivered to response_url afterwards.
  if (!responseUrl) {
    return json(await buildReport(githubToken, githubLogin, process.env.GITHUB_SEARCH_SCOPE));
  }

  waitUntil(deliver(responseUrl, githubToken, githubLogin, process.env.GITHUB_SEARCH_SCOPE));
  return new Response(null, { status: 200 });
}

async function buildReport(token: string, login: string, scope: string | undefined): Promise<SlackMessage> {
  try {
    return buildPullRequestMessage(await fetchOpenPullRequests({ token, login, scope }), login);
  } catch (error) {
    console.error('failed to read pull requests', error);
    return buildErrorMessage(error);
  }
}

async function deliver(
  responseUrl: string,
  token: string,
  login: string,
  scope: string | undefined,
): Promise<void> {
  const message = await buildReport(token, login, scope);
  const response = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    console.error(`response_url delivery failed: ${response.status} ${await response.text()}`);
  }
}

function json(message: SlackMessage): Response {
  return new Response(JSON.stringify(message), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
