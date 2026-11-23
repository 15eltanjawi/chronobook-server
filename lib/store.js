'use strict';
// Task storage, backed by Upstash Redis's REST API (plain HTTPS, works from any
// host). This replaced an earlier local-JSON-file version: Render's free tier (and
// most serverless/free hosts) gives the app no persistent disk - every redeploy or
// restart wipes local files, which silently deleted every pending liveness task each
// time this server's code was updated. Upstash's free tier is a real external
// service, so it survives restarts/redeploys here same as everywhere else.
//
// Needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN - see README.md for how
// to get them (free, a couple of minutes, no credit card).

const BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PREFIX = 'chronobook:task:';

function configured() {
  return Boolean(BASE && TOKEN);
}

async function redis(command) {
  if (!configured()) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set - see README.md');
  }
  const res = await fetch(BASE.replace(/\/+$/, ''), {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `Upstash error (HTTP ${res.status})`);
  return body.result;
}

async function get(id) {
  const raw = await redis(['GET', PREFIX + id]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function put(task) {
  // The key expires itself a day after the task's own expiresAt, so finished or
  // abandoned tasks clean themselves up - no separate sweep process needed.
  const ttlSeconds = Math.max(60, Math.ceil(((task.expiresAt || Date.now()) + 24 * 60 * 60 * 1000 - Date.now()) / 1000));
  await redis(['SET', PREFIX + task.id, JSON.stringify(task), 'EX', String(ttlSeconds)]);
  return task;
}

async function remove(id) {
  await redis(['DEL', PREFIX + id]);
}

// Kept so server.js's existing periodic call stays harmless: Redis's own EX (set in
// put(), above) already expires old tasks on its own.
async function sweepExpired() {}

module.exports = { get, put, remove, sweepExpired, configured };
