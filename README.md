# slack-my-prs

A `/myprs` slash command that answers with your open pull requests, ranked by what
is actually blocking them. The reply is ephemeral, so only you see it.

```
Your open pull requests
`octocat` · 17 open PRs · 🔴 7 blocked · 🟡 8 waiting on review · ⏳ 1 checks running · 📝 1 draft
──────────────────────────────────────────────
🔴 #482 fix(reports): guard the id casts before the query runs
   Checks failing · acme/backend · opened 13m ago · updated 1m ago
🟡 #479 refactor(search): collapse the two ranking passes
   Waiting on review · acme/backend · opened 2d ago · updated 4h ago
```

Ordering, most urgent first: merge conflicts or failing checks → changes
requested → waiting on review → checks running → approved and ready to merge →
draft. Within a rank, most recently updated first.

## How it is wired

One Vercel function. Slack signs the slash command, the function verifies that
signature, asks the GitHub GraphQL API for your open PRs, and posts the result
back to the command's `response_url`.

The reply is asynchronous on purpose. Slack gives a slash command three seconds;
a real query against this account measured **3.7s**, so a synchronous reply would
have shown "operation timeout". The function acks in ~10ms and delivers the
message a moment later.

## Setup

### 1. Deploy

```bash
vercel link          # create the project
vercel deploy --prod
```

Note the production URL.

### 2. Create the Slack app

Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**,
pick your workspace, and paste `slack-app-manifest.json`. Replace the
`REPLACE-WITH-YOUR-DEPLOYMENT` host in the `url` first.

Install it to the workspace, then copy the **Signing Secret** from
**Basic Information**.

Only the `commands` scope is requested. The reply travels back over
`response_url`, so the app never needs a bot token or permission to post.

### 3. Set the environment variables

```bash
vercel env add SLACK_SIGNING_SECRET production   # from Basic Information
vercel env add GITHUB_TOKEN production           # PAT, `repo` scope
vercel env add GITHUB_LOGIN production           # your GitHub handle
vercel env add SLACK_USER_IDS production         # optional, your Slack user ID
vercel env add GITHUB_SEARCH_SCOPE production    # optional, e.g. repo:owner/name
vercel deploy --prod                             # redeploy to pick them up
```

`SLACK_USER_IDS` is a comma-separated allowlist. Leave it unset and anyone in the
workspace can run the command and see the same person's PRs. Set it to your own
ID (**Profile → ⋮ → Copy member ID**) to keep it yours.

`GITHUB_SEARCH_SCOPE` narrows the search — `repo:acme/backend` or `org:acme`.
Unset means every repository the token can see.

### 4. Try it

Type `/myprs` in any Slack channel or DM.

## Local development

```bash
npm install
npm test                                                    # 15 tests, no network
npm run type-check
GITHUB_TOKEN=$(gh auth token) GITHUB_LOGIN=<you> node scripts/smoke.ts
```

`scripts/smoke.ts` signs a slash-command body the way Slack does, stands up a
fake `response_url` sink, and prints the message the handler delivers — the whole
path against real GitHub data, without deploying anything.

To check the layout visually, paste the printed blocks into
<https://app.slack.com/block-kit-builder> as `{ "blocks": [...] }`.
