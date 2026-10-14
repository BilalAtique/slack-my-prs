import { githubGraphQl } from './github.js';

export type PullRequestRef = { owner: string; repo: string; number: number; url: string };

export type ApprovalOutcome = {
  ref: PullRequestRef;
  title: string | null;
  status: 'approved' | 'skipped' | 'failed';
  detail: string;
};

const LINKS = /https?:\/\/[^\s<>|]+/gi;
const PULL_REQUEST_PATH = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/|$)/;

export function extractPullRequestLinks(text: string): PullRequestRef[] {
  const refs = new Map<string, PullRequestRef>();
  for (const [link] of text.matchAll(LINKS)) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (url.hostname !== 'github.com') continue;
    const match = url.pathname.match(PULL_REQUEST_PATH);
    if (!match) continue;
    const [, owner = '', repo = '', number = ''] = match;
    const key = `${owner}/${repo}#${number}`.toLowerCase();
    if (refs.has(key)) continue;
    refs.set(key, {
      owner,
      repo,
      number: Number(number),
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    });
  }
  return [...refs.values()];
}

const READ = `
query PullRequestForApproval($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      title
      state
      headRefOid
      author { login }
      latestOpinionatedReviews(first: 100) {
        nodes { state author { login } }
      }
    }
  }
}`;

const APPROVE = `
mutation ApprovePullRequest($id: ID!, $commit: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $id, event: APPROVE, commitOID: $commit }) {
    pullRequestReview { state }
  }
}`;

type ReadResult = {
  viewer: { login: string };
  repository: {
    pullRequest: {
      id: string;
      title: string;
      state: 'OPEN' | 'CLOSED' | 'MERGED';
      headRefOid: string;
      author: { login: string } | null;
      latestOpinionatedReviews: { nodes: Array<{ state: string; author: { login: string } | null } | null> };
    } | null;
  } | null;
};

export async function approvePullRequests(args: {
  token: string;
  refs: readonly PullRequestRef[];
  fetchImpl?: typeof fetch;
}): Promise<ApprovalOutcome[]> {
  return Promise.all(args.refs.map((ref) => approveOne(args.token, ref, args.fetchImpl)));
}

async function approveOne(token: string, ref: PullRequestRef, fetchImpl?: typeof fetch): Promise<ApprovalOutcome> {
  let title: string | null = null;
  try {
    const data = await githubGraphQl<ReadResult>({
      token,
      query: READ,
      variables: { owner: ref.owner, repo: ref.repo, number: ref.number },
      fetchImpl,
    });
    const pr = data.repository?.pullRequest;
    if (!pr) return { ref, title, status: 'failed', detail: 'Pull request not found' };
    title = pr.title;

    const me = data.viewer.login.toLowerCase();
    if (pr.state === 'MERGED') return { ref, title, status: 'skipped', detail: 'Already merged' };
    if (pr.state === 'CLOSED') return { ref, title, status: 'skipped', detail: 'Closed' };
    if (pr.author?.login.toLowerCase() === me) return { ref, title, status: 'skipped', detail: 'Your own pull request' };

    // The latest opinionated review is the one that counts. An approval that a new
    // push dismissed reads DISMISSED here, so it is approved again.
    const mine = pr.latestOpinionatedReviews.nodes.find((review) => review?.author?.login.toLowerCase() === me);
    if (mine?.state === 'APPROVED') return { ref, title, status: 'skipped', detail: 'Already approved' };

    // Pinned to the head that was just read, so a commit pushed in between does not
    // receive the approval.
    await githubGraphQl({ token, query: APPROVE, variables: { id: pr.id, commit: pr.headRefOid }, fetchImpl });
    return { ref, title, status: 'approved', detail: 'Approved' };
  } catch (error) {
    return { ref, title, status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}
