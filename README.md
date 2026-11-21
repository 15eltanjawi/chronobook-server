# chronobook-server

Relay server between:
- the **Liveness Customer** Android app (`liveness-customer-android.apk`) — unmodified, no source available
- the **Sweven BLS** Chrome extension (`bls-autofill-extension`)

The app hands the customer's phone an already-logged-in BLS session (cookies + the
appointment URL), lets the phone's WebView run BLS's own page and the real Oz Forensics
liveness check with the phone's camera, then reports the outcome back here so the
extension can confirm it and move on to payment.

## How this was built

`liveness-customer-android.apk` ships with no source and no documentation. Its exact
client/server protocol (paths, request/response field names, link format, and the
AES-256-GCM scheme it uses) was recovered by disassembling `classes.dex` with
`dexdump` and reading the bytecode by hand — there was nothing else to go on.

**Confirmed directly from the bytecode** (high confidence):
- Link format: `https://<any host>/liveness-customer#<base64url JSON>`, where the
  JSON is `{"v":1,"id":"<uuid-v4>","server":"https://<api host>","key":"<32 random
  bytes, base64url>","access":"<32 random bytes, base64url>"}`. The `https://.../
  liveness-customer#...` text is only ever parsed locally by the app — it is never
  fetched — but the embedded `server` field is the real API base URL the app calls.
- Endpoints: `POST {server}/api/v1/liveness-tasks/customer/{id}/open|start|report`,
  every body carrying `{"access": "<access>", ...}`.
- The sensitive payload travels as `{"v":1,"iv":"...","data":"..."}`, AES-256-GCM with
  the task's 32-byte `key`, a random 12-byte nonce (`iv`), and AAD
  `"chronobook-liveness-v1|<id>|<attemptId>"`. Verified end-to-end against this
  server's own encrypt/decrypt in testing.
- The app throws an error if an `open`/`start` response's `"payload"` field is ever
  missing or not a JSON object — this server always includes it, even empty.
- **The decrypted payload itself must be `{"sessionToken": "...", "transactionId":
  "...", "webAdapterUrl": "..."}`** — the app checks these three keys by name and
  requires all three to be present and non-blank, then adds `lang:"en"` and
  `action:["video_selfie_blank"]` itself and opens the Oz Forensics Web SDK plugin
  directly. This means the phone isn't shown BLS's own web page or a transplanted
  browser session at all — it runs the *same Oz Forensics transaction* BLS's page
  already started (same `transactionId`), just from the phone's camera instead of a
  desktop's. Whichever device finishes that transaction, BLS resolves it the same way.
  This is why `bls-autofill-extension/main.js` captures BLS's own
  `sessionToken`/`transactionId`/`webAdapterUrl` response rather than this server
  minting its own — reusing BLS's own (short-lived) token is required, not optional.

**This server's own design, not confirmed against the app** (test before relying on
it in production — ideally against the real APK and a real BLS liveness session):
- The exact state machine around when `attemptId`/`reportId` appear and disappear
  across repeated `open` calls, and the precise cool-down/retry timing. The disassembly
  showed enough to build a self-consistent version of this, but not every branch could
  be pinned down without a decompiler.
- Everything under `/api/v1/liveness-tasks/operator/*` — the phone app never calls
  this; it exists purely for the extension and can be changed freely.

If the real app ever rejects something this server sends, the fix is almost always in
`routes/customer.js` (the shapes going back to the app), not in the crypto.

## Running it locally

```sh
npm install
cp .env.example .env
# edit .env: set OPERATOR_API_KEY to a random secret, and PUBLIC_BASE_URL to
# http://127.0.0.1:8787 for a local test
npm start
```

## Deploying (recommended: Render.com — free, automatic HTTPS, no server to manage)

1. Push this `chronobook-server` folder to its own GitHub repo (or a subfolder of one).
2. On [render.com](https://render.com), **New → Web Service**, connect that repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. In the service's **Environment** tab, add:
   - `OPERATOR_API_KEY` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   - `PUBLIC_BASE_URL` — the `https://your-service.onrender.com` URL Render gives you
     (set this *after* the first deploy, once you know the URL, then redeploy)
4. Render's free tier sleeps after inactivity and wakes on the next request (a few
   seconds of delay). That's fine for occasional liveness tasks; upgrade the plan if
   it isn't.

Any other host that runs Node and gives you a public HTTPS URL works the same way —
Render is just the least amount of setup.

## API

### For the extension (`/api/v1/liveness-tasks/operator/*`)
Every call needs header `x-operator-key: <OPERATOR_API_KEY>`.

- `POST /tasks` `{appointmentId?, note?, ttlMinutes?}` → `{id, link, expiresAt}`
- `POST /tasks/:id/session` `{sessionToken, transactionId, webAdapterUrl}` — the exact
  triple BLS's own page got from Oz Forensics for this appointment (captured by
  `bls-autofill-extension/main.js` from BLS's own `POST /api/v1/oz-forensics/session-token`
  call — confirmed from the app's bytecode that this is exactly what it expects to
  decrypt, down to the three field names). Not cookies, not a BLS page URL: the phone
  runs the Oz Forensics plugin directly, for the same transaction BLS already started.
- `GET /tasks/:id` → `{status, message, attemptId, reportId, result, decision, link}`
- `POST /tasks/:id/decision` `{decision: "accepted"|"rejected", message?}`
- `POST /tasks/:id/cancel`

### For the phone app (`/api/v1/liveness-tasks/customer/*`)
Matches the app exactly — see "How this was built" above. Not meant to be called by
anything else.
