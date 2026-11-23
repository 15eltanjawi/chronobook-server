'use strict';

// Tiny .env loader (no dependency needed) — only for local runs; a real host sets
// real environment variables instead, and this never overrides those.
(function loadDotEnv() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const express = require('express');
const store = require('./lib/store');
const customerRoutes = require('./routes/customer');
const operatorRoutes = require('./routes/operator');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// The cosmetic landing page for the "https://.../liveness-customer#..." link. The app
// never fetches this — it only reads the link's text, locally, after it's pasted or
// shared into the app — but a human tapping the link on their phone should land
// somewhere sensible, not a 404.
app.get('/liveness-customer', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Liveness Customer task</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
code{background:#f0f0f0;padding:.15em .4em;border-radius:.3em}</style></head>
<body>
<h1>Open this in the Liveness Customer app</h1>
<p>This link only works inside the <strong>Liveness Customer</strong> app. If you have it installed,
tap the link again or paste the whole thing (including the part after <code>#</code>) into the app's
"Private task link" box.</p>
<p>If you don't have the app yet, ask whoever sent you this link for it.</p>
</body></html>`);
});

app.use('/api/v1/liveness-tasks/customer', customerRoutes);
app.use('/api/v1/liveness-tasks/operator', operatorRoutes);

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  // This "error" string reaches the phone app directly (it shows it to the person
  // as-is when a response isn't a success), so it's written for them, not as a log code.
  res.status(500).json({ error: 'The task server had a problem. Try again in a moment.' });
});

setInterval(() => store.sweepExpired(), 60 * 60 * 1000);

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => {
  console.log(`chronobook-server listening on :${port}`);
  if (!process.env.OPERATOR_API_KEY) {
    console.warn('WARNING: OPERATOR_API_KEY is not set — the operator API has no real secret to check against.');
  }
  if (!process.env.PUBLIC_BASE_URL) {
    console.warn('WARNING: PUBLIC_BASE_URL is not set — links will use the request host, which is wrong behind some proxies.');
  }
  if (!store.configured()) {
    console.warn('WARNING: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set — every task will fail to save.');
  }
});
