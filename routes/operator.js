'use strict';
// Routes the Sweven BLS extension calls. This half of the API is this server's own
// design (the phone app never calls these) — there was nothing to reverse-engineer
// here, so these shapes can be changed freely to suit the extension.

const express = require('express');
const store = require('../lib/store');
const { randomId, randomSecret32, encryptSession, safeEqual } = require('../lib/crypto');
const { buildLink } = require('../lib/link');

const router = express.Router();

// Express 4 does not catch a rejected promise from an async handler on its own -
// without this, a storage error would hang the request instead of answering it.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireOperator(req, res, next) {
  const key = req.header('x-operator-key');
  if (!safeEqual(key, process.env.OPERATOR_API_KEY || '')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
router.use(requireOperator);

function publicBase(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Create a new liveness task and get back the link to send to the customer's phone.
router.post('/tasks', ah(async (req, res) => {
  const { appointmentId, note, ttlMinutes } = req.body || {};
  const base = publicBase(req);
  const id = randomId();
  const task = {
    id,
    server: base,
    key: randomSecret32(),
    access: randomSecret32(),
    appointmentId: appointmentId || null,
    note: note || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + (Number(ttlMinutes) > 0 ? Number(ttlMinutes) : 30) * 60 * 1000,
    status: 'pending',
    message: 'Waiting for the customer to open the link.',
    attemptId: null,
    previousAttemptId: null,
    reportId: null,
    result: null,
    pendingSession: null,
    sessions: {},
    decision: null,
  };
  await store.put(task);
  res.json({ id: task.id, link: buildLink(base, task), expiresAt: task.expiresAt });
}));

// Hand off the live Oz Forensics transaction the phone should complete: the exact
// sessionToken/transactionId/webAdapterUrl BLS's own page just got for this
// appointment (captured by main.js — see bls-autofill-extension/main.js — from BLS's
// own call to POST /api/v1/oz-forensics/session-token). The app decrypts this,
// requires all three fields to be present, and uses them to open the same Oz Forensics
// plugin BLS's own page would have, for the same transaction — so whichever device
// finishes it, BLS resolves the same transactionId. Call this right after creating
// the task, or again if the token needs refreshing (Oz tokens are short-lived).
router.post('/tasks/:id/session', ah(async (req, res) => {
  const task = await store.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const { sessionToken, transactionId, webAdapterUrl } = req.body || {};
  if (!sessionToken || !transactionId || !webAdapterUrl) {
    return res.status(400).json({ error: 'sessionToken, transactionId and webAdapterUrl are all required' });
  }
  task.pendingSession = { sessionToken, transactionId, webAdapterUrl };
  if (task.attemptId) {
    // An attempt is already underway without a session yet (the phone opened the
    // task before we had cookies ready) — seal it now so the next poll picks it up.
    task.sessions = task.sessions || {};
    task.sessions[task.attemptId] = encryptSession(task.key, task.id, task.attemptId, task.pendingSession);
    if (task.status === 'pending') {
      task.status = 'preparing';
      task.message = 'Preparing the camera on the BLS page…';
    }
  }
  await store.put(task);
  res.json({ ok: true });
}));

// Poll this for the extension's own UI and for the "auto-confirm, then show payment" step.
router.get('/tasks/:id', ah(async (req, res) => {
  const task = await store.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  res.json({
    id: task.id,
    status: task.status,
    message: task.message,
    appointmentId: task.appointmentId,
    attemptId: task.attemptId,
    reportId: task.reportId,
    result: task.result,
    decision: task.decision,
    expiresAt: task.expiresAt,
    link: buildLink(publicBase(req), task),
  });
}));

router.get('/tasks', (req, res) => {
  res.json({ tasks: [] }); // kept minimal on purpose; extend if a dashboard needs a list.
});

// The extension (or whoever actually checked the result against BLS) records the
// final call here. The customer app's next poll reflects this.
router.post('/tasks/:id/decision', ah(async (req, res) => {
  const task = await store.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const { decision, message } = req.body || {};
  if (!['accepted', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "accepted" or "rejected"' });
  }
  task.decision = decision;
  task.status = decision;
  task.message = message || (decision === 'accepted'
    ? 'BLS accepted your selfie. Your operator saved the result.'
    : 'BLS did not accept the result. Tap Try selfie again to repeat it while the link is valid.');
  await store.put(task);
  res.json({ ok: true });
}));

router.post('/tasks/:id/cancel', ah(async (req, res) => {
  const task = await store.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  task.status = 'expired';
  task.message = 'This task was cancelled by the operator.';
  task.expiresAt = Date.now();
  await store.put(task);
  res.json({ ok: true });
}));

module.exports = router;
