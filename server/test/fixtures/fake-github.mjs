#!/usr/bin/env node
// Stand-in for the GitHub REST API, for UI demos without a real repository:
//   node server/test/fixtures/fake-github.mjs 4999 &
//   ORCH_GITHUB_API_URL=http://127.0.0.1:4999 ORCH_CLAUDE_BIN=$PWD/server/test/fixtures/fake-claude.mjs npm start
// Any token is accepted. Issues and pull requests live in memory and share one number sequence.
// Demo controls:  POST /_demo/merge/<pr>   POST /_demo/label/<pr>/<label>   POST /_demo/checks/<success|failure|pending>
import http from 'node:http';

const port = Number(process.argv[2] || 4999);
const items = [
  { number: 1, title: 'Show order totals on the cart page', body: '## Why\nCustomers cannot see what they pay.\n\n## What\nAdd totals to `src/cart.js`.\n\n## Acceptance\n- [ ] Totals are shown\n\n**Size:** S', state: 'open', labels: [{ name: 'enhancement' }] },
  { number: 2, title: 'Store orders in the database', body: '## What\nAdd an orders table (migration).\n\nDepends on #1\n\n**Size:** M', state: 'open', labels: [{ name: 'backend' }] },
];
for (const i of items) i.html_url = `https://github.com/acme/shop/issues/${i.number}`;
let checks = [{ status: 'completed', conclusion: 'success' }];
const labels = (names = []) => names.map((name) => ({ name }));

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = req.url;
      const send = (status, data) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
      };
      const item = (n) => items.find((i) => i.number === Number(n));
      let m;
      if (url === '/user') return send(200, { login: 'you' });
      if ((m = url.match(/^\/_demo\/merge\/(\d+)$/))) {
        const pr = item(m[1]);
        Object.assign(pr, { state: 'closed', merged: true });
        for (const n of pr.body.matchAll(/closes #(\d+)/gi)) item(n[1]).state = 'closed';
        return send(200, pr);
      }
      if ((m = url.match(/^\/_demo\/label\/(\d+)\/(.+)$/))) {
        item(m[1]).labels.push({ name: decodeURIComponent(m[2]) });
        return send(200, item(m[1]));
      }
      if ((m = url.match(/^\/_demo\/checks\/(\w+)$/))) {
        checks = m[1] === 'pending' ? [{ status: 'in_progress', conclusion: null }] : [{ status: 'completed', conclusion: m[1] }];
        return send(200, checks);
      }
      if (req.method === 'GET' && /\/issues\?/.test(url)) return send(200, items.filter((i) => i.state === 'open'));
      if (req.method === 'POST' && /\/issues$/.test(url)) {
        const n = items.length + 1;
        const it = { number: n, title: body.title, body: body.body, state: 'open', labels: labels(body.labels), html_url: `https://github.com/acme/shop/issues/${n}` };
        items.push(it);
        return send(201, it);
      }
      if ((m = url.match(/\/issues\/(\d+)$/))) {
        const it = item(m[1]);
        if (!it) return send(404, { message: 'Not Found' });
        if (req.method === 'PATCH') Object.assign(it, { ...body, ...(body.labels ? { labels: labels(body.labels) } : {}) });
        return send(200, it);
      }
      if (req.method === 'POST' && /\/issues\/\d+\/(comments|assignees)$/.test(url)) return send(201, { id: 1 });
      if (req.method === 'POST' && /\/requested_reviewers$/.test(url)) return send(422, { message: 'Review cannot be requested from pull request author.' });
      if (req.method === 'GET' && /\/pulls\?/.test(url)) {
        const head = decodeURIComponent((url.match(/head=([^&]+)/) ?? [])[1] ?? '').split(':')[1];
        return send(200, items.filter((i) => i.pull_request && i.state === 'open' && i.head.ref === head));
      }
      if (req.method === 'POST' && /\/pulls$/.test(url)) {
        const n = items.length + 1;
        const pr = { number: n, title: body.title, body: body.body, state: 'open', labels: [], html_url: `https://github.com/acme/shop/pull/${n}`, pull_request: {}, head: { ref: body.head, sha: 'abc123' }, draft: body.draft, merged: false };
        items.push(pr);
        return send(201, pr);
      }
      if ((m = url.match(/\/pulls\/(\d+)$/))) {
        const pr = item(m[1]);
        if (!pr) return send(404, { message: 'Not Found' });
        if (req.method === 'PATCH') Object.assign(pr, body);
        return send(200, pr);
      }
      if (/\/check-runs/.test(url)) return send(200, { check_runs: checks });
      return send(404, { message: 'Not Found' });
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`[fake-github] http://127.0.0.1:${port}`));
