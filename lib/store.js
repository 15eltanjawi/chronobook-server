'use strict';
// A tiny file-backed store. This is built for one operator's traffic (a handful of
// liveness tasks at a time), not for scale — if this ever needs to survive concurrent
// writers or heavy load, swap this file for a real database without changing the
// routes, which only call the functions below.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'tasks.json');

let tasks = new Map();

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const arr = JSON.parse(raw);
    tasks = new Map(arr.map((t) => [t.id, t]));
  } catch {
    tasks = new Map();
  }
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...tasks.values()], null, 2));
  fs.renameSync(tmp, FILE);
}

load();

function get(id) {
  return tasks.get(id) || null;
}

function put(task) {
  tasks.set(task.id, task);
  persist();
  return task;
}

function remove(id) {
  tasks.delete(id);
  persist();
}

// Drops tasks that expired more than a day ago, so the file doesn't grow forever.
function sweepExpired() {
  const now = Date.now();
  let changed = false;
  for (const [id, t] of tasks) {
    if (t.expiresAt && now - t.expiresAt > 24 * 60 * 60 * 1000) {
      tasks.delete(id);
      changed = true;
    }
  }
  if (changed) persist();
}

module.exports = { get, put, remove, sweepExpired };
