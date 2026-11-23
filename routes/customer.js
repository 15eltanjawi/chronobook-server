'use strict';
// Routes the Liveness Customer phone app calls. Paths and body field names below are
// taken directly from the app's own code (dexdump of classes.dex — the app ships with
// no source), not guessed. See ../README.md for exactly what was confirmed and what is
// this server's own best-effort design for the parts the disassembly didn't pin down
// (test end-to-end against the real app before relying on this in production).

const express = require('express');
const store = require('../lib/store');
const { randomId, encryptSession, safeEqual } = require('../lib/crypto');

const router = express.Router();

function taskPublic(task, { includePayload = true } = {}) {
  const body = {
    // Confirmed from the app's own bytecode: a 2xx response is only accepted as
    // valid if it has "ok": true at the top level - anything else (even a
    // perfectly reasonable-looking JSON object) is rejected client-side as
    // "Invalid task API response (HTTP 200)", regardless of its other fields.
    ok: true,
    status: task.status,
    message: task.message || '',
  };
  if (task.attemptId) body.attemptId = task.attemptId;
  if (task.reportId) body.reportId = task.reportId;
  if (includePayload) {
    const payload = {};
    if (task.attemptId) {
      payload.attemptId = task.attemptId;
      payload.previousAttemptId = task.previousAttemptId || null;
    }
    if (task.attemptId && task.sessions && task.sessions[task.attemptId]) {
      payload.session = task.sessions[task.attemptId];
    }
    // The app throws "The session is unavailable..." if "payload" isn't a JSON
    // object at all, so this key is always present even when empty.
    body.payload = payload;
  }
  return body;
}

function loadTask(req, res) {
  const task = store.get(req.params.id);
  if (!task) {
    // This "error" string is shown to the person directly if present (confirmed
    // from the app's bytecode), so it's written for them, not as a log code.
    res.status(404).json({ error: 'This task is unavailable. Ask your operator for a fresh link.' });
    return null;
  }
  if (!safeEqual(req.body && req.body.access, task.access)) {
    res.status(401).json({ error: 'This link is not valid for this task. Ask your operator for a fresh link.' });
    return null;
  }
  if (task.expiresAt && Date.now() > task.expiresAt && task.status !== 'accepted') {
    task.status = 'expired';
    task.message = 'This link has expired.';
    store.put(task);
  }
  return task;
}

router.post('/:id/open', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  res.json(taskPublic(task));
});

router.post('/:id/start', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  if (task.status === 'expired' || task.status === 'accepted') {
    res.json(taskPublic(task));
    return;
  }

  const attemptId = String((req.body && req.body.attemptId) || randomId());
  const previousAttemptId = (req.body && req.body.previousAttemptId) || null;

  task.previousAttemptId = previousAttemptId;
  task.attemptId = attemptId;
  task.reportId = null;
  task.result = null;
  task.sessions = task.sessions || {};

  if (task.pendingSession) {
    // The extension already handed us the sessionToken/transactionId/webAdapterUrl
    // for this task; seal them for this specific attempt now (the AAD binds the
    // ciphertext to this attemptId).
    task.sessions[attemptId] = encryptSession(task.key, task.id, attemptId, task.pendingSession);
    task.status = 'preparing';
    task.message = 'Preparing the camera on the BLS page…';
  } else {
    task.status = 'pending';
    task.message = 'Waiting for the operator to hand off the session.';
  }

  store.put(task);
  res.json(taskPublic(task));
});

router.post('/:id/report', (req, res) => {
  const task = loadTask(req, res);
  if (!task) return;
  if (!task.attemptId) {
    res.status(409).json({ error: 'There is no selfie attempt waiting for a result right now.' });
    return;
  }

  const reportId = String((req.body && req.body.reportId) || randomId());
  const result = (req.body && req.body.result) || {};

  task.reportId = reportId;
  task.result = result;
  task.status = 'submitted';
  task.message = 'Result sent. Waiting for your operator to verify it with BLS.';
  task.submittedAt = Date.now();
  store.put(task);

  res.json(taskPublic(task, { includePayload: false }));
});

module.exports = router;
