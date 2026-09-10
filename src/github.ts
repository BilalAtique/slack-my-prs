export type CheckState = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  repository: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  reviewDecision: ReviewDecision;
  mergeable: MergeableState;
  checks: CheckState;
};

const QUERY = `
query OpenPullRequests($search: String!) {
  search(query: $search, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        createdAt
        updatedAt
        reviewDecision
        mergeable
        repository { nameWithOwner }
        commits(last: 1) {
          nodes { commit { statusCheckRollup { state } } }
        }
      }
    }
  }
}`;

type GraphQlNode = {
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  createdAt?: string;
  updatedAt?: string;
  reviewDecision?: ReviewDecision;
  mergeable?: MergeableState;
  repository?: { nameWithOwner?: string };
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: CheckState } | null } }> };
};

type GraphQlResponse = {
  data?: { search?: { nodes?: Array<GraphQlNode | null> } };
  errors?: Array<{ message?: string }>;
};

export function buildSearchQuery(login: string, scope?: string): string {
  const terms = ['is:pr', 'is:open', `author:${login}`, 'archived:false', 'sort:updated-desc'];
  const trimmed = scope?.trim();
  if (trimmed) terms.push(trimmed);
  return terms.join(' ');
}

export async function fetchOpenPullRequests(args: {
  token: string;
  login: string;
  scope?: string;
  fetchImpl?: typeof fetch;
}): Promise<PullRequest[]> {
  const doFetch = args.fetchImpl ?? fetch;
  const response = await doFetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.token}`,
      'content-type': 'application/json',
      'user-agent': 'slack-my-prs',
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { search: buildSearchQuery(args.login, args.scope) },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as GraphQlResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? 'unknown').join('; '));
  }

  // Search over `type: ISSUE` returns issues too. A node that is not a PullRequest
  // matches no fragment field and arrives as `{}`, so `number` is the discriminator.
  const nodes = payload.data?.search?.nodes ?? [];
  return nodes.filter(isPullRequestNode).map(toPullRequest);
}

function isPullRequestNode(node: GraphQlNode | null): node is GraphQlNode {
  return node !== null && typeof node.number === 'number' && typeof node.url === 'string';
}

function toPullRequest(node: GraphQlNode): PullRequest {
  return {
    number: node.number as number,
    title: node.title ?? '(untitled)',
    url: node.url as string,
    repository: node.repository?.nameWithOwner ?? 'unknown/unknown',
    isDraft: node.isDraft ?? false,
    createdAt: node.createdAt ?? new Date(0).toISOString(),
    updatedAt: node.updatedAt ?? node.createdAt ?? new Date(0).toISOString(),
    reviewDecision: node.reviewDecision ?? null,
    mergeable: node.mergeable ?? 'UNKNOWN',
    checks: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
  };
}
