import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPullRequestMessage, classify, sortPullRequests, tally } from './blocks.ts';
import type { PullRequest } from './github.ts';

const NOW = Date.parse('2026-09-10T12:00:00Z');

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'a change',
    url: 'https://github.com/acme/repo/pull/1',
    repository: 'acme/repo',
    isDraft: false,
    createdAt: '2026-09-08T12:00:00Z',
    updatedAt: '2026-09-10T11:00:00Z',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: 'SUCCESS',
    ...overrides,
  };
}

test('a draft outranks nothing, even with failing checks', () => {
  assert.equal(classify(pr({ isDraft: true, checks: 'FAILURE' })).rank, 5);
});

test('conflicts and failing checks are the top of the list', () => {
  assert.equal(classify(pr({ mergeable: 'CONFLICTING' })).rank, 0);
  assert.equal(classify(pr({ checks: 'FAILURE' })).rank, 0);
  assert.equal(classify(pr({ checks: 'ERROR' })).rank, 0);
});

test('an approved, green PR is labelled ready to merge', () => {
  const { rank, label } = classify(pr({ reviewDecision: 'APPROVED' }));
  assert.equal(rank, 4);
  assert.match(label, /ready to merge/);
});

test('sorts by urgency, then by most recently updated', () => {
  const order = sortPullRequests([
    pr({ number: 1, reviewDecision: 'APPROVED' }),
    pr({ number: 2, checks: 'FAILURE' }),
    pr({ number: 3, isDraft: true }),
    pr({ number: 4, reviewDecision: 'CHANGES_REQUESTED' }),
    pr({ number: 5, reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-09-10T09:00:00Z' }),
    pr({ number: 6, reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-09-10T11:30:00Z' }),
  ]).map((entry) => entry.number);
  assert.deepEqual(order, [2, 4, 6, 5, 1, 3]);
});

test('tallies each state and omits the empty ones', () => {
  const counts = tally([
    pr({ number: 1, checks: 'FAILURE' }),
    pr({ number: 2, mergeable: 'CONFLICTING' }),
    pr({ number: 3, reviewDecision: 'APPROVED' }),
    pr({ number: 4, isDraft: true }),
  ]);
  assert.deepEqual(
    counts.map((entry) => [entry.name, entry.count]),
    [
      ['blocked', 2],
      ['ready to merge', 1],
      ['draft', 1],
    ],
  );
});

test('the fallback text spells out the tally rather than one fuzzy count', () => {
  const message = buildPullRequestMessage(
    [pr({ number: 1, checks: 'FAILURE' }), pr({ number: 2, reviewDecision: 'APPROVED' }), pr({ number: 3, isDraft: true })],
    'octocat',
    NOW,
  );
  assert.equal(message.text, '3 open pull requests: 1 blocked, 1 ready to merge, 1 draft.');
});

test('escapes mrkdwn control characters in a title', () => {
  const message = buildPullRequestMessage([pr({ title: 'fix <script> & 5 > 4' })], 'octocat', NOW);
  const rendered = JSON.stringify(message.blocks);
  assert.match(rendered, /fix &lt;script&gt; &amp; 5 &gt; 4/);
  assert.doesNotMatch(rendered, /fix <script>/);
});

test('caps the list at twenty and counts the remainder', () => {
  const many = Array.from({ length: 26 }, (_, index) => pr({ number: index + 1 }));
  const message = buildPullRequestMessage(many, 'octocat', NOW);
  assert.equal(message.blocks.length, 3 + 20 * 2 + 1);
  assert.ok(message.blocks.length <= 50);
  assert.match(JSON.stringify(message.blocks), /…and 6 more\./);
});

test('says so plainly when there is nothing open', () => {
  const message = buildPullRequestMessage([], 'octocat', NOW);
  assert.equal(message.blocks.length, 1);
  assert.match(message.text, /No open pull requests/);
});
