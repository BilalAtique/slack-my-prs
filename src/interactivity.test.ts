import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { POST } from '../api/interactivity.js';

const SECRET = 'test-signing-secret';
const RESPONSE_URL = 'https://hooks.slack.com/app/test';
const realFetch = globalThis.fetch;

process.env.SLACK_SIGNING_SECRET = SECRET;
process.env.GITHUB_TOKEN = 'test-token';
process.env.SLACK_USER_TOKEN = 'test-user-token';

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SLACK_USER_IDS;
  process.env.SLACK_USER_TOKEN = 'test-user-token';
});

function shortcutRequest(payload: Record<string, unknown>, secret = SECRET): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return new Request('https://example.test/api/interactivity', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
    },
    body,
  });
}

function approveShortcut(userId: string): Record<string, unknown> {
  return {
    type: 'message_action',
    callback_id: 'approve_prs',
    response_url: RESPONSE_URL,
    user: { id: userId },
    channel: { id: 'C_SOURCE' },
    message: {
      ts: '1789000000.000002',
      thread_ts: '1789000000.000001',
      text: 'Need approval: <https://github.com/acme/repo/pull/1|github.com/acme/repo/pull/1>',
    },
  };
}

// Records the GitHub calls, answers them with one open pull request, and resolves
// with the message the handler delivers to response_url.
function stubFetch(options: {
  failApprovalFor?: number;
  review?: string;
  state?: string;
  states?: Record<number, 'OPEN' | 'MERGED' | 'CLOSED'>;
  author?: string;
  reactionError?: string;
  reactionHttpStatus?: number;
  reactionReject?: boolean;
} = {}) {
  const githubCalls: string[] = [];
  const reactions: Array<{ body: unknown; authorization: string | null }> = [];
  const events: string[] = [];
  let deliver: (message: { text: string }) => void = () => {};
  const delivered = new Promise<{ text: string }>((resolve) => {
    deliver = resolve;
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === RESPONSE_URL) {
      events.push('report');
      deliver(JSON.parse(String(init?.body)) as { text: string });
      return new Response('ok');
    }
    if (url === 'https://slack.com/api/reactions.add') {
      events.push('reaction');
      reactions.push({
        body: JSON.parse(String(init?.body)) as unknown,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      if (options.reactionReject) throw new Error('Slack is unavailable');
      return Response.json(
        options.reactionError ? { ok: false, error: options.reactionError } : { ok: true },
        { status: options.reactionHttpStatus ?? 200 },
      );
    }
    assert.equal(url, 'https://api.github.com/graphql');
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { number?: number; id?: string };
    };
    githubCalls.push(query.includes('ApprovePullRequest') ? 'approve' : 'read');
    events.push(query.includes('ApprovePullRequest') ? 'approve' : 'read');
    if (query.includes('ApprovePullRequest')) {
      if (variables.id === `PR_${options.failApprovalFor}`) {
        return Response.json({ errors: [{ message: 'Approval refused' }] });
      }
      return Response.json({ data: { addPullRequestReview: { pullRequestReview: { state: 'APPROVED' } } } });
    }
    return Response.json({
      data: {
        viewer: { login: 'me' },
        repository: {
          pullRequest: {
            id: `PR_${variables.number}`,
            title: 'a change',
            state: options.states?.[Number(variables.number)] ?? options.state ?? 'OPEN',
            headRefOid: 'sha1',
            author: { login: options.author ?? 'someone' },
            latestOpinionatedReviews: {
              nodes: options.review ? [{ state: options.review, author: { login: 'me' } }] : [],
            },
          },
        },
      },
    });
  }) as typeof fetch;
  return { githubCalls, delivered, reactions, events };
}

test('adds done to the source reply after all linked pull requests are approved', async () => {
  process.env.SLACK_USER_IDS = 'U_ME';
  const { githubCalls, delivered, reactions, events } = stubFetch();
  const payload = approveShortcut('U_ME');
  const message = payload.message as Record<string, unknown>;
  message.text = `${String(message.text)} https://github.com/acme/repo/pull/2`;
  const response = await POST(shortcutRequest(payload));
  assert.equal(response.status, 200);
  assert.equal((await delivered).text, 'Approved 2 of 2 pull requests.');
  assert.deepEqual(githubCalls, ['read', 'read', 'approve', 'approve']);
  assert.deepEqual(reactions, [{
    body: { channel: 'C_SOURCE', timestamp: '1789000000.000002', name: 'white_check_mark' },
    authorization: 'Bearer test-user-token',
  }]);
  assert.deepEqual(events, ['read', 'read', 'approve', 'approve', 'reaction', 'report']);
});

test('approves nothing when the allowlist is empty', async () => {
  const { githubCalls, delivered, reactions } = stubFetch();
  const response = await POST(shortcutRequest(approveShortcut('U_ANYONE')));
  assert.equal(response.status, 200);
  assert.match((await delivered).text, /not enabled for your account/);
  assert.deepEqual(githubCalls, []);
  assert.deepEqual(reactions, []);
});

test('approves nothing for a user outside the allowlist', async () => {
  process.env.SLACK_USER_IDS = 'U_ME';
  const { githubCalls, delivered, reactions } = stubFetch();
  await POST(shortcutRequest(approveShortcut('U_SOMEONE_ELSE')));
  assert.match((await delivered).text, /not enabled for your account/);
  assert.deepEqual(githubCalls, []);
  assert.deepEqual(reactions, []);
});

test('rejects a payload signed with another secret', async () => {
  process.env.SLACK_USER_IDS = 'U_ME';
  const { githubCalls, reactions } = stubFetch();
  const response = await POST(shortcutRequest(approveShortcut('U_ME'), 'wrong-secret'));
  assert.equal(response.status, 401);
  assert.deepEqual(githubCalls, []);
  assert.deepEqual(reactions, []);
});

test('refuses an interaction it does not declare', async () => {
  const response = await POST(shortcutRequest({ ...approveShortcut('U_ME'), callback_id: 'something_else' }));
  assert.equal(response.status, 400);
});

test('does not mark done when any linked approval fails', async () => {
  process.env.SLACK_USER_IDS = 'U_ME';
  const { delivered, reactions } = stubFetch({ failApprovalFor: 2 });
  const payload = approveShortcut('U_ME');
  const message = payload.message as Record<string, unknown>;
  message.text = `${String(message.text)} https://github.com/acme/repo/pull/2`;
  await POST(shortcutRequest(payload));
  assert.equal((await delivered).text, 'Approved 1 of 2 pull requests · 1 failed.');
  assert.deepEqual(reactions, []);
});

test('does not mark done for a message without pull request links', async () => {
  process.env.SLACK_USER_IDS = 'U_ME';
  const { delivered, reactions, githubCalls } = stubFetch();
  const payload = approveShortcut('U_ME');
  const message = payload.message as Record<string, unknown>;
  message.text = 'Nothing to approve here';
  await POST(shortcutRequest(payload));
  assert.equal((await delivered).text, 'No pull request links in this message.');
  assert.deepEqual(reactions, []);
  assert.deepEqual(githubCalls, []);
});

test('marks already approved pull requests done without another GitHub write', async () => {
  process.env.SLACK_USER_IDS = 'U_ME';
  const { delivered, reactions, githubCalls } = stubFetch({ review: 'APPROVED' });
  await POST(shortcutRequest(approveShortcut('U_ME')));
  assert.equal((await delivered).text, 'Approved 0 of 1 pull request · 1 skipped.');
  assert.equal(reactions.length, 1);
  assert.deepEqual(githubCalls, ['read']);
});

test('marks merged pull requests done without another GitHub write', async () => {
  process.env.SLACK_USER_IDS = 'U_ME';
  const { delivered, reactions, githubCalls } = stubFetch({ state: 'MERGED' });
  await POST(shortcutRequest(approveShortcut('U_ME')));
  assert.equal((await delivered).text, 'Approved 0 of 1 pull request · 1 skipped.');
  assert.equal(reactions.length, 1);
  assert.deepEqual(githubCalls, ['read']);
});

test('marks a message done when it mixes a merged PR and a successful approval', async () => {
  process.env.SLACK_USER_IDS = 'U_ME';
  const { delivered, reactions, githubCalls } = stubFetch({ states: { 1: 'MERGED' } });
  const payload = approveShortcut('U_ME');
  const message = payload.message as Record<string, unknown>;
  message.text = `${String(message.text)} https://github.com/acme/repo/pull/2`;
  await POST(shortcutRequest(payload));
  assert.equal((await delivered).text, 'Approved 1 of 2 pull requests · 1 skipped.');
  assert.equal(reactions.length, 1);
  assert.deepEqual(githubCalls, ['read', 'read', 'approve']);
});

for (const options of [{ state: 'CLOSED' }, { author: 'me' }]) {
  test(`does not mark an unapproved skipped pull request done: ${JSON.stringify(options)}`, async () => {
    process.env.SLACK_USER_IDS = 'U_ME';
    const { delivered, reactions, githubCalls } = stubFetch(options);
    await POST(shortcutRequest(approveShortcut('U_ME')));
    assert.equal((await delivered).text, 'Approved 0 of 1 pull request · 1 skipped.');
    assert.deepEqual(reactions, []);
    assert.deepEqual(githubCalls, ['read']);
  });
}

test('accepts an existing done reaction without reporting an error', async () => {
  process.env.SLACK_USER_IDS = 'U_ME';
  const { delivered, reactions } = stubFetch({ reactionError: 'already_reacted' });
  await POST(shortcutRequest(approveShortcut('U_ME')));
  assert.equal((await delivered).text, 'Approved 1 of 1 pull request.');
  assert.equal(reactions.length, 1);
});

for (const options of [
  { reactionError: 'missing_scope' },
  { reactionError: 'not_in_channel' },
  { reactionHttpStatus: 503 },
  { reactionReject: true },
]) {
  test(`keeps approval results when the reaction fails: ${JSON.stringify(options)}`, async () => {
    process.env.SLACK_USER_IDS = 'U_ME';
    const { delivered, githubCalls } = stubFetch(options);
    await POST(shortcutRequest(approveShortcut('U_ME')));
    assert.equal(
      (await delivered).text,
      'Approved 1 of 1 pull request. Could not add the done reaction. Your PR approvals are complete.',
    );
    assert.deepEqual(githubCalls, ['read', 'approve']);
  });
}

test('reports a missing Slack token without interrupting approvals', async () => {
  delete process.env.SLACK_USER_TOKEN;
  process.env.SLACK_USER_IDS = 'U_ME';
  const { delivered, reactions, githubCalls } = stubFetch();
  await POST(shortcutRequest(approveShortcut('U_ME')));
  assert.match((await delivered).text, /Your PR approvals are complete/);
  assert.deepEqual(reactions, []);
  assert.deepEqual(githubCalls, ['read', 'approve']);
});

test('refuses a shortcut without the source channel or message timestamp', async () => {
  process.env.SLACK_USER_IDS = 'U_ME';
  const { githubCalls, reactions } = stubFetch();
  for (const field of ['channel', 'message']) {
    const payload = approveShortcut('U_ME');
    payload[field] = {};
    assert.equal((await POST(shortcutRequest(payload))).status, 400);
  }
  assert.deepEqual(githubCalls, []);
  assert.deepEqual(reactions, []);
});
