// Drives the real handler locally: signs a slash-command body the way Slack does,
// stands up a fake response_url sink, and prints the message that comes back.
//
//   GITHUB_TOKEN=$(gh auth token) GITHUB_LOGIN=<login> node scripts/smoke.ts
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

import handler from '../api/slack.js';

const SIGNING_SECRET = 'smoke-test-secret';
process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;

if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_LOGIN) {
  console.error('set GITHUB_TOKEN and GITHUB_LOGIN, e.g. GITHUB_TOKEN=$(gh auth token) GITHUB_LOGIN=octocat');
  process.exit(1);
}

const received = Promise.withResolvers<string>();
const sink = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    res.writeHead(200).end('ok');
    received.resolve(Buffer.concat(chunks).toString('utf8'));
  });
});
await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
const { port } = sink.address() as { port: number };

const body = new URLSearchParams({
  command: '/myprs',
  user_id: process.env.SMOKE_SLACK_USER_ID ?? 'U_SMOKE',
  response_url: `http://127.0.0.1:${port}/response`,
}).toString();
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;

const started = Date.now();
const response = await handler(
  new Request('https://example.test/api/slack', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
    },
    body,
  }),
);

console.log(`ack: ${response.status} in ${Date.now() - started}ms`);

const timeout = setTimeout(() => {
  console.error('no message delivered to response_url within 20s');
  process.exit(1);
}, 20_000);
const payload = await received.promise;
clearTimeout(timeout);
sink.close();

const message = JSON.parse(payload) as { text: string; blocks: unknown[] };
console.log(`delivered after ${Date.now() - started}ms`);
console.log(`fallback text: ${message.text}`);
console.log(`blocks: ${message.blocks.length}`);
console.log(JSON.stringify(message.blocks, null, 2));
