import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approvePullRequests, extractPullRequestLinks, type PullRequestRef } from './approve.js';
import { buildApprovalMessage } from './blocks.js';

type FakePr = {
  title?: string;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  author?: string;
  reviews?: Array<{ author: string; state: string }>;
};

// Answers the two GraphQL documents the approver sends, and records each approval.
function fakeGitHub(prs: Record<number, FakePr | null>, options: { approveError?: string } = {}) {
  const approved: Array<{ id: string; commit: string }> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, string | number>;
    };
    if (query.includes('ApprovePullRequest')) {
      if (options.approveError) return Response.json({ errors: [{ message: options.approveError }] });
      approved.push({ id: String(variables.id), commit: String(variables.commit) });
      return Response.json({ data: { addPullRequestReview: { pullRequestReview: { state: 'APPROVED' } } } });
    }
    const number = Number(variables.number);
    const pr = prs[number];
    return Response.json({
      data: {
        viewer: { login: 'BilalAtique' },
        repository: {
          pullRequest:
            pr === null || pr === undefined
              ? null
              : {
                  id: `PR_${number}`,
                  title: pr.title ?? `change ${number}`,
                  state: pr.state ?? 'OPEN',
                  headRefOid: `sha${number}`,
                  author: { login: pr.author ?? 'Mahmoud-Qassem' },
                  latestOpinionatedReviews: {
                    nodes: (pr.reviews ?? []).map((review) => ({ state: review.state, author: { login: review.author } })),
                  },
                },
        },
      },
    });
  }) as typeof fetch;
  return { fetchImpl, approved };
}

function ref(number: number): PullRequestRef {
  return { owner: 'acme', repo: 'repo', number, url: `https://github.com/acme/repo/pull/${number}` };
}

test('reads each pull request once from a Slack-formatted message', () => {
  const text = [
    'Need approvals:',
    '• <https://github.com/EntendreFinance/MONOREPO/pull/3726|github.com/EntendreFinance/MONOREPO/pull/3726>',
    '• <https://github.com/EntendreFinance/MONOREPO/pull/3680/files|the second one>',
    'and again https://github.com/entendrefinance/monorepo/pull/3726',
    'plus <https://github.com/acme/other.repo/pull/7>',
  ].join('\n');
  assert.deepEqual(
    extractPullRequestLinks(text).map((entry) => `${entry.owner}/${entry.repo}#${entry.number}`),
    ['EntendreFinance/MONOREPO#3726', 'EntendreFinance/MONOREPO#3680', 'acme/other.repo#7'],
  );
});

test('ignores issue links and plain PR numbers', () => {
  assert.deepEqual(extractPullRequestLinks('see #3726 and https://github.com/acme/repo/issues/12'), []);
});

test('ignores PR-shaped URLs on other hosts', () => {
  for (const url of [
    'https://notgithub.com/acme/repo/pull/1',
    'https://github.com@evil.example/acme/repo/pull/1',
    'https://evil.example/https://github.com/acme/repo/pull/1',
    'https://evil.example/?next=https://github.com/acme/repo/pull/1',
  ]) {
    assert.deepEqual(extractPullRequestLinks(url), [], url);
  }
});

test('approves an open pull request at the head it read', async () => {
  const github = fakeGitHub({ 1: {} });
  const [outcome] = await approvePullRequests({ token: 't', refs: [ref(1)], fetchImpl: github.fetchImpl });
  assert.equal(outcome?.status, 'approved');
  assert.deepEqual(github.approved, [{ id: 'PR_1', commit: 'sha1' }]);
});

test('skips merged, closed, own and already approved pull requests without writing', async () => {
  const github = fakeGitHub({
    1: { state: 'MERGED' },
    2: { state: 'CLOSED' },
    3: { author: 'bilalatique' },
    4: { reviews: [{ author: 'BilalAtique', state: 'APPROVED' }] },
  });
  const outcomes = await approvePullRequests({
    token: 't',
    refs: [ref(1), ref(2), ref(3), ref(4)],
    fetchImpl: github.fetchImpl,
  });
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.status, outcome.detail]),
    [
      ['skipped', 'Already merged'],
      ['skipped', 'Closed'],
      ['skipped', 'Your own pull request'],
      ['skipped', 'Already approved'],
    ],
  );
  assert.deepEqual(github.approved, []);
});

test('approves again when the earlier approval was dismissed or someone else approved', async () => {
  const github = fakeGitHub({
    1: { reviews: [{ author: 'BilalAtique', state: 'DISMISSED' }] },
    2: { reviews: [{ author: 'amrharb', state: 'APPROVED' }] },
  });
  const outcomes = await approvePullRequests({ token: 't', refs: [ref(1), ref(2)], fetchImpl: github.fetchImpl });
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['approved', 'approved'],
  );
});

test('reports a GitHub refusal per pull request and keeps going', async () => {
  const refused = fakeGitHub({ 1: {} }, { approveError: 'Resource not accessible by personal access token' });
  const [outcome] = await approvePullRequests({ token: 't', refs: [ref(1)], fetchImpl: refused.fetchImpl });
  assert.equal(outcome?.status, 'failed');
  assert.equal(outcome?.title, 'change 1');
  assert.equal(outcome?.detail, 'Resource not accessible by personal access token');

  const missing = fakeGitHub({ 2: null, 3: {} });
  const outcomes = await approvePullRequests({ token: 't', refs: [ref(2), ref(3)], fetchImpl: missing.fetchImpl });
  assert.deepEqual(
    outcomes.map((entry) => entry.status),
    ['failed', 'approved'],
  );
});

test('the reply leads with the count and escapes titles', () => {
  const message = buildApprovalMessage([
    { ref: ref(1), title: 'fix <b> & c', status: 'approved', detail: 'Approved' },
    { ref: ref(2), title: 'two', status: 'skipped', detail: 'Already approved' },
    { ref: ref(3), title: null, status: 'failed', detail: 'Pull request not found' },
  ]);
  assert.equal(message.response_type, 'ephemeral');
  assert.equal(message.text, 'Approved 1 of 3 pull requests · 1 skipped · 1 failed.');
  const rendered = JSON.stringify(message.blocks);
  assert.match(rendered, /fix &lt;b&gt; &amp; c/);
  assert.match(rendered, /acme\/repo#3/);
});

test('says so when the message links no pull request', () => {
  assert.match(buildApprovalMessage([]).text, /No pull request links/);
});
