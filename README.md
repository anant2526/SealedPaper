# SealedPaper

An exam paper that no single official can open. SealedPaper encrypts a document the moment it is uploaded, splits its key among **N** officials, and opens it only **after the unlock time** when **k of them** each bring:

1. **their key file** (one share of the key, unique to that document and that person),
2. **the current 6-digit code** from their authenticator app (changes every 30 s, single use),
3. **their own face** in a live scan (look straight, turn left, turn right, in a random order).

Screenshots of every screen are in [`docs/screenshots`](docs/screenshots).

Phase 1 (this code) is the *document vault*. Phase 2 (question pool, centres, per-centre copies, leak tracer) builds on the same database.

---

## How a paper moves through the system

| Step | Who | What happens |
| --- | --- | --- |
| 1. Register | Everyone | Name, email, password → face scan → link an authenticator app. The account stays inactive until both are done. |
| 2. Log in | Everyone | Password → fresh face scan with a new random pose order. |
| 3. Upload and split | Exam controller (admin) | Picks N custodians, k, unlock time, recipients. A **new random 256-bit key** encrypts the file (AES-256-GCM). The key is split into N Shamir shares and then forgotten. |
| 4. Collect key files | Each custodian | Downloads their key file **once** (needs the 6-digit code). The server keeps only a SHA-256 hash of it. |
| 5. Submit keys | k custodians | From 60 min before unlock (configurable): key file + code + live face scan. 5 failures in 10 min = locked out. |
| 6. Release | Server | At unlock time with k valid keys: one locked transaction rebuilds the key, the AES-GCM tag proves it, a trigger re-checks time and quorum. |
| 7. Download | Admin, custodians, recipients | Every download is logged. |

Every step lands in a **hash-chained, append-only audit log**.

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js 16 (App Router) + Tailwind CSS 4, plain JavaScript |
| API | Node.js 22 + Express, raw SQL with `pg` (no ORM, so every trigger and lock is visible) |
| Database | PostgreSQL 16: 14 tables, 11 triggers, stored functions, 3 views, window functions, DCL |
| Crypto | Node `crypto` (AES-256-GCM, SHA-256), `shamir-secret-sharing` (audited), Argon2id passwords |
| Rotating code | TOTP (RFC 6238) via `otplib`, QR code for Google/Microsoft Authenticator |
| Face | `@vladmandic/face-api` on the **server** (TensorFlow.js WASM): face detection, 68 landmarks, 128-number face descriptor. The browser runs two tiny models only to guide the person and auto-capture. |
| Jobs | `node-cron` worker inside the API (releases papers at unlock time) |
| Tests | Node's built-in test runner + Supertest |

---

## Run it on your laptop

You need **Node.js 22.9 or newer** and **PostgreSQL 16** (easiest: Docker Desktop).

### 1. Database

```bash
docker compose up -d          # PostgreSQL on localhost:5432, user postgres / password postgres
```

No Docker? Install PostgreSQL 16 and run `createdb sealedpaper` and `createdb sealedpaper_test`.

### 2. API (terminal 1)

```bash
cd server
npm install
cp .env.example .env
npm run keygen                # prints MASTER_KEY=... and JWT_SECRET=... — paste both into .env
npm run migrate               # creates all tables, triggers, functions, views
npm run dev                   # http://localhost:4000  (first start loads the face models, ~2 s)
```

### 3. Website (terminal 2)

```bash
cd web
npm install
cp .env.example .env.local
npm run dev                   # http://localhost:3000
```

Open **http://localhost:3000**. The camera only works on `localhost` or `https`.

### 4. Try the whole flow

1. **Register** the first account: it becomes the **exam controller (admin)**.
2. Register 3 more accounts in **private/incognito windows** (or other browsers / a phone on the same Wi-Fi via your laptop's IP over https). You can use your own face for all of them while testing; each account stores its own face template.
3. As admin, open **People** and check the roles (new accounts are key custodians already). Make one person a **centre superintendent** if you want a download-only recipient.
4. **Seal a new document**: pick a file, set the unlock time 5–10 minutes ahead, tick 3 custodians, choose "2 of 3".
5. As each custodian: open the document → **Download my key file** (needs the authenticator code).
6. As two custodians: upload the key file, type the code, **scan your face** → "Your key is in".
7. At the unlock time the paper opens by itself (worker runs every 30 s). Download it.
8. As admin: **Audit log → Verify the hash chain**.

---

## Tests

```bash
cd server
npm test
```

13 tests, run against the `sealedpaper_test` database with `FACE_MODE=mock` (a frame is the string `mock:<person>:<yaw>`, so the real liveness and matching *logic* runs without a camera). They cover:

- login needs password **and** matching face; wrong person, wrong pose order, no head turn and replayed challenges are rejected
- only the admin uploads; `k > N` is refused; the database holds ciphertext only
- each key file downloads exactly once; the server keeps no copy
- someone else's key file, a forged share, a wrong code and a wrong face are all rejected and logged
- keys before the unlock time are accepted, but the time lock holds — even a direct SQL `UPDATE` fails
- the worker releases at unlock time; the downloaded file equals the original; only 2 of 3 keys were used
- a TOTP code cannot be used twice
- **5 parallel unlock requests produce exactly one release**

### Database rule checks (great for the viva)

```bash
psql "postgres://postgres:postgres@localhost:5432/sealedpaper" -f server/sql/viva_checks.sql
# or without psql:  cd server && npm run viva:sql
```

Prints a PASS/FAIL table of 16 rules the database enforces on its own (time lock, quorum, frozen settings, immutable share hashes, append-only audit, tamper detection by `verify_audit_chain()`…). It runs inside a transaction and rolls back, so it leaves nothing behind.

---

## Deploy (free tiers)

| Part | Service | Settings |
| --- | --- | --- |
| Database | **Neon** (or Supabase) | Create a project, copy the connection string |
| API + worker | **Render** web service | Root `server`, build `npm ci && npm run migrate`, start `npm start`. `render.yaml` in this repo sets it up as a Blueprint. |
| Website | **Vercel** | Root directory `web`. Environment variable `API_URL=https://<your-render-app>.onrender.com` (needed at build time). |

Render environment variables: `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_SSL=true`, `MASTER_KEY`, `JWT_SECRET` (from `npm run keygen`), `FACE_MODE=real`, `TRUST_PROXY=2`.

Secrets live only in these dashboards, never in git. The browser talks only to Vercel; Vercel proxies `/api/*` to Render, so login cookies stay first-party.

> Render's free plan sleeps after 15 idle minutes. Open the site a minute before your demo so the API wakes up and loads the face models.

---

## How the face check works

1. The server issues a **one-time challenge**: the three poses in a random order, valid for 2 minutes.
2. The browser shows a mirrored preview with an oval, guides the person with two tiny models, and **auto-captures** a raw frame for each pose (a **Capture** button appears if the guide models cannot load).
3. The server analyses the three frames:
   - exactly one face, not too far away;
   - **head turn** from the 68 landmarks: `(dist(nose, right jaw) − dist(nose, left jaw)) / sum`. Under 0.15 counts as straight, over 0.2 as turned, and the direction must match the pose;
   - the turned frames must be the **same person** as the straight one (distance ≤ 0.6);
   - the straight frame must match the **stored template** (distance ≤ 0.5). The template is the 128-number descriptor from registration, stored AES-encrypted.
4. Every attempt is logged in `face_checks` with its distances and head-turn values.

Tune in `server/.env` if needed: `FACE_MATCH_THRESHOLD` (lower = stricter), `FACE_STRAIGHT_MAX_YAW`, `FACE_TURN_MIN_YAW`.

---

## Project structure

```
sealedpaper/
├── docker-compose.yml          local PostgreSQL (+ test database)
├── render.yaml                 Render blueprint for the API
├── server/                     Express API + release worker
│   ├── migrations/             001 tables · 002 triggers · 003 functions/views · 004 DCL
│   ├── sql/viva_checks.sql     16 database rule checks
│   ├── scripts/                migrate, keygen, run-sql
│   ├── src/
│   │   ├── routes/             auth, documents, users, audit
│   │   ├── services/           crypto, shamir, totp, face, faceCheck, release, audit
│   │   ├── middleware/auth.js  cookie JWT sessions, roles
│   │   └── worker.js           releases papers at unlock time
│   └── test/                   flow + race tests
└── web/                        Next.js + Tailwind
    ├── app/                    register, login, dashboard, documents/new, documents/[id], admin/users, audit
    └── components/             FaceScan, QuorumSeal, TotpSetup, Enrollment…
```

## API

| Method | Endpoint | Who | Does |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | Anyone | Create account (first one = admin) |
| POST | `/api/auth/face-challenge` | Half-logged-in | One-time pose order |
| POST | `/api/auth/enroll/face` | Registering | Store face template |
| POST | `/api/auth/enroll/totp` · `/confirm` | Registering | QR code, then activate |
| POST | `/api/auth/login` → `/login/face` | Anyone | Password, then face → session |
| POST | `/api/auth/refresh` · `/logout` | Logged in | Rotate / end session |
| GET | `/api/users` · PATCH `/api/users/:id` | Admin | List, change role, disable |
| POST | `/api/documents` | Admin | Upload, encrypt, split (multipart) |
| GET | `/api/documents` · `/:id` | Involved users | List, detail + unlock status |
| POST | `/api/documents/:id/key-file` | Custodian | One-time key file (needs code) |
| POST | `/api/documents/:id/face-challenge` | Custodian | Challenge for key submission |
| POST | `/api/documents/:id/unlock` | Custodian | Key file + code + face frames |
| GET | `/api/documents/:id/download` | Admin, custodians, recipients | After release only |
| GET | `/api/audit` · `/verify` · `/suspicious` | Admin, investigator | Log, hash-chain check, brute-force view |

## Honest limitations (say these in the viva before the examiner does)

- **Liveness is head-turn based.** A printed photo fails, but a video of the person turning on cue could pass. Production would add a dedicated anti-spoofing model or a paid liveness service.
- **Accepted key shares wait on the server**, encrypted with the master key, from submission until release (at most the submission window). A fully trustless design would combine shares on the custodians' own devices.
- **The master key lives in an environment variable.** In production it would sit in a cloud KMS.
- **A lost key file cannot be re-issued** (the server keeps only its hash). k-of-N tolerates N − k lost files.
- Face matching uses an open model with a fixed threshold; lighting and camera quality affect it. Tune the thresholds on your own data.
- Files are capped at 4 MB because they are stored in PostgreSQL and pass through the Vercel proxy.
