'use strict';
// Builds the "https://<host>/liveness-customer#<token>" link the Liveness Customer app
// accepts. The token is the only part the app actually reads — it never fetches the
// URL itself, it just needs the whole string to match the app's regex:
//   https?://[^\s#<>"'()]+/liveness-customer#[A-Za-z0-9_-]+
// The decoded token must be a JSON object: { v:1, id, server, key, access } — see
// lib/crypto.js for how id/key/access are generated, and README.md for how this was
// confirmed against the app's own bytecode.

const { b64urlEncode } = require('./crypto');

function buildLink(publicBaseUrl, task) {
  const token = { v: 1, id: task.id, server: task.server, key: task.key, access: task.access };
  const encoded = b64urlEncode(Buffer.from(JSON.stringify(token), 'utf8'));
  return `${publicBaseUrl.replace(/\/+$/, '')}/liveness-customer#${encoded}`;
}

module.exports = { buildLink };
