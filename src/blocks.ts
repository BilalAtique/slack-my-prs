import type { PullRequest } from './github.js';

export type SlackMessage = {
  response_type: 'ephemeral' | 'in_channel';
  text: string;
  blocks: unknown[];
};

// A message surface accepts 50 blocks. Each pull request costs two, and the
// header costs three, so the list is capped and the remainder is counted.
const MAX_LISTED = 20;

export type Group = 'blocked' | 'changes_requested' | 'waiting' | 'running' | 'ready' | 'draft';
export type Classification = { rank: number; group: Group; emoji: string; label: string };

export function classify(pr: PullRequest): Classification {
  if (pr.isDraft) return { rank: 5, group: 'draft', emoji: '📝', label: 'Draft' };
  if (pr.mergeable === 'CONFLICTING')
    return { rank: 0, group: 'blocked', emoji: '🔴', label: 'Merge conflicts' };
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR')
    return { rank: 0, group: 'blocked', emoji: '🔴', label: 'Checks failing' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED')
    return { rank: 1, group: 'changes_requested', emoji: '🟠', label: 'Changes requested' };
  if (pr.checks === 'PENDING' || pr.checks === 'EXPECTED')
    return { rank: 3, group: 'running', emoji: '⏳', label: 'Checks running' };
  if (pr.reviewDecision === 'APPROVED')
    return { rank: 4, group: 'ready', emoji: '🟢', label: 'Approved — ready to merge' };
  return { rank: 2, group: 'waiting', emoji: '🟡', label: 'Waiting on review' };
}

// An earlier draft printed one "needs attention" count. Against a real inbox it
// read 15 of 17, because it swept up every PR merely waiting on a reviewer. The
// tally replaces the judgement call with the counts themselves.
const GROUP_NAMES: ReadonlyArray<readonly [Group, string, string]> = [
  ['blocked', '🔴', 'blocked'],
  ['changes_requested', '🟠', 'changes requested'],
  ['waiting', '🟡', 'waiting on review'],
  ['running', '⏳', 'checks running'],
  ['ready', '🟢', 'ready to merge'],
  ['draft', '📝', 'draft'],
];

export function tally(prs: readonly PullRequest[]): Array<{ emoji: string; name: string; count: number }> {
  return GROUP_NAMES.map(([group, emoji, name]) => ({
    emoji,
    name,
    count: prs.filter((pr) => classify(pr).group === group).length,
  })).filter((entry) => entry.count > 0);
}

export function sortPullRequests(prs: readonly PullRequest[]): PullRequest[] {
  return [...prs].sort((a, b) => {
    const byRank = classify(a).rank - classify(b).rank;
    if (byRank !== 0) return byRank;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function buildPullRequestMessage(
  prs: readonly PullRequest[],
  login: string,
  now: number = Date.now(),
): SlackMessage {
  if (prs.length === 0) {
    return {
      response_type: 'ephemeral',
      text: `No open pull requests for ${login}.`,
      blocks: [section(`🎉 *No open pull requests* for \`${escapeMrkdwn(login)}\`.`)],
    };
  }

  const sorted = sortPullRequests(prs);
  const counts = tally(sorted);
  const listed = sorted.slice(0, MAX_LISTED);

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Your open pull requests', emoji: true } },
    context(
      [`\`${escapeMrkdwn(login)}\` · ${plural(prs.length, 'open PR', 'open PRs')}`]
        .concat(counts.map((entry) => `${entry.emoji} ${entry.count} ${entry.name}`))
        .join('  ·  '),
    ),
    { type: 'divider' },
  ];

  for (const pr of listed) {
    const { emoji, label } = classify(pr);
    blocks.push(
      section(`${emoji} *<${pr.url}|#${pr.number} ${escapeMrkdwn(truncate(pr.title, 110))}>*`),
      context(
        `${label} · \`${escapeMrkdwn(pr.repository)}\` · opened ${age(pr.createdAt, now)} ago · updated ${age(pr.updatedAt, now)} ago`,
      ),
    );
  }

  if (sorted.length > listed.length) {
    blocks.push(context(`_…and ${sorted.length - listed.length} more._`));
  }

  return {
    response_type: 'ephemeral',
    text: `${plural(prs.length, 'open pull request', 'open pull requests')}: ${counts
      .map((entry) => `${entry.count} ${entry.name}`)
      .join(', ')}.`,
    blocks,
  };
}

export function buildErrorMessage(error: unknown): SlackMessage {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    response_type: 'ephemeral',
    text: 'Could not read your pull requests.',
    blocks: [section(`⚠️ *Could not read your pull requests.*\n\`${escapeMrkdwn(truncate(detail, 300))}\``)],
  };
}

export function buildNoticeMessage(text: string): SlackMessage {
  return { response_type: 'ephemeral', text, blocks: [section(escapeMrkdwn(text))] };
}

function section(text: string): unknown {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text: string): unknown {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

// Slack reserves these three characters in mrkdwn. A PR title carrying a raw `<`
// swallows the rest of the line into a broken link.
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function age(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
