'use strict';
// Crypto helpers that match the Liveness Customer Android app exactly (verified by
// disassembling its classes.dex — there is no source for that app, so this must stay
// byte-for-byte compatible with what it decodes).
//
// - ids are UUID v4, matching the app's regex:
//     ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
// - "key" and "access" in the task link are 32 random bytes, base64url, no padding.
// - the encrypted "session" the app decrypts is AES-256-GCM with:
//     key   = the task's 32-byte "key"
//     nonce = 12 random bytes ("iv")
//     AAD   = utf8("chronobook-liveness-v1|<task id>|<attemptId>")
//   Java's Cipher.doFinal appends the 16-byte GCM tag to the ciphertext, so "data"
//   below is ciphertext||tag, exactly like the app expects when it calls doFinal() on it.

const crypto = require('crypto');

function randomId() {
  return crypto.randomUUID(); // Node's randomUUID() is a v4 UUID in the exact format the app requires.
}

function randomSecret32() {
  return b64urlEncode(crypto.randomBytes(32));
}

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function aad(id, attemptId) {
  return Buffer.from(`chronobook-liveness-v1|${id}|${attemptId}`, 'utf8');
}

// Encrypts `payload` (any JSON-serializable value) so the app's AES/GCM/NoPadding
// Cipher.doFinal(...) call can decrypt it. keyB64url must be the task's 32-byte "key".
function encryptSession(keyB64url, id, attemptId, payload) {
  const key = b64urlDecode(keyB64url);
  if (key.length !== 32) throw new Error('session key must decode to 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(id, attemptId));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: b64urlEncode(iv),
    data: b64urlEncode(Buffer.concat([ciphertext, tag])),
  };
}

// Inverse of encryptSession, used by our own tests / the operator API to sanity-check
// a session before storing it. The app never calls this; it decrypts on-device.
function decryptSession(keyB64url, id, attemptId, session) {
  const key = b64urlDecode(keyB64url);
  const iv = b64urlDecode(session.iv);
  const all = b64urlDecode(session.data);
  const tag = all.subarray(all.length - 16);
  const ciphertext = all.subarray(0, all.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(aad(id, attemptId));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

// Constant-time string compare for secrets (access tokens, API keys).
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so timing doesn't leak length
    // cheaply; this isn't perfect, but it's not the primary defense here (access
    // tokens are also unguessable 32-byte secrets, and are additionally bound to a
    // specific unguessable task id).
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { randomId, randomSecret32, b64urlEncode, b64urlDecode, encryptSession, decryptSession, safeEqual };
