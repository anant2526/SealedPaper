# SealedPaper

**An exam paper that no single official can open.**

SealedPaper keeps a question paper encrypted from the moment its questions are written until a fixed time before the exam.
Opening it needs **k of N officials together**, each bringing three things:

1. **their key file**: one Shamir share of the paper's key, unique to that paper and that person;
2. **the current 6-digit code** from their authenticator app (changes every 30 s, works once);
3. **their own face** in a live scan: look straight, turn left, turn right, in a random order.

The paper does not even exist until it is opened: setters fill a **question pool**, and the server **draws the final paper at release**.
Every exam centre then prints its **own shuffled variant** with a **copy code on every page**, so a leaked copy names its centre and its copy.

Screenshots of every screen are in [`docs/screenshots`](docs/screenshots). The step-by-step viva demo is in [`docs/DEMO.md`](docs/DEMO.md).

---

## How a paper moves through the system

| # | Stage | Who | What happens |
| --- | --- | --- | --- |
| 1 | Accounts | Everyone | Register with password → **face scan** → **authenticator app**. Log in with password → fresh face scan. The admin gives each person a role. |
| 2 | Setup | Exam controller | Creates the paper: blueprint (topic × difficulty × count × marks), setters, key custodians and **k**, centres with superintendents and candidate counts, and three times: seal deadline → unlock → exam start. A fresh 256-bit **paper key** is generated. |
| 3 | Question pool | Paper setters | Add questions one by one or **import a JSON file**. Each is encrypted with the paper key (AES-256-GCM) and stored with an **HMAC of its text**. A setter sees only their own questions. |
| 4 | Early leak? | Investigator → admin | Pasted leaked text is HMAC-matched against the pool **without decrypting anything**. The tracer names the setter; the admin **burns** those questions so the draw can never pick them. |
| 5 | Seal | Admin or the worker at the deadline | The key is split into N Shamir shares, one per custodian, and the server's copy is **deleted**. From now on nobody, not even the setter or the server, can read a question. |
| 6 | Key files | Each custodian | Downloads their key file **once** (needs the 6-digit code). The server keeps only its SHA-256 hash. |
| 7 | Unlock | k custodians | In the submission window: key file + code + live face scan. 5 failures in 10 min lock that custodian out. |
| 8 | Release | Server | At the unlock time with k keys: **one locked transaction** rebuilds the key, proves it with the GCM tag, flips the status (a trigger re-checks time and quorum), **draws the final questions** with `draw_final_questions()`, and builds **one variant per centre** (question order + option order). |
| 9 | Print | Superintendents | Download numbered copies of their own centre's variant as a PDF. Each copy has a unique code like `DEL01-0003-K7QX` in the footer and as a watermark. The database caps printing at candidates + spares. |
| 10 | Reprint | Superintendent → admin | A spoiled copy is replaced only after an admin approves; the old copy is voided. Nobody can approve their own reprint. |
| 11 | Late leak? | Investigator | The tracer finds the leaked questions, compares their **order and option order** with every centre's variant, and reads any **copy code**. Result: the centre, or the exact copy and who printed it. |

Every step is written to a **hash-chained, append-only audit log** that the database itself refuses to edit.

## Roles

| Role | Can | Cannot |
| --- | --- | --- |
| Exam controller (admin) | Create papers and centres, assign roles, seal, approve reprints, burn leaked questions, read the audit log | Read any question before release, or open a paper alone |
| Paper setter | Add, edit and import their own questions until the seal | See other setters' questions, the final paper, or their own questions after sealing |
| Key custodian | Collect their key file once, submit it in the unlock window | Open a paper alone, or see their key file twice |
| Centre superintendent | Print their own centre's copies after release, ask for reprints | Print early, print another centre's copy, or go over the print cap |
| Investigator | Trace leaks, read the audit log, verify the hash chain | Change any record |

An uploaded **file vault** is also included (admin → Vault → "Seal an uploaded file"): the same k-of-N key files, code and face unlock for any finished document.

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js 16 (App Router) + Tailwind CSS 4, plain JavaScript |
| API | Node.js 22 + Express, raw SQL with `pg` (no ORM, so every trigger and lock is visible) |
| Database | PostgreSQL 16: **28 tables, 20 triggers, 5 stored functions, 7 views**, window functions, DCL |
| Crypto | Node `crypto` (AES-256-GCM, SHA-256, HMAC, HKDF), `shamir-secret-sharing` (audited), Argon2id passwords |
| Rotating code | TOTP (RFC 6238) via `otplib`, QR code for Google/Microsoft Authenticator |
| Face | `@vladmandic/face-api` on the **server** (TensorFlow.js WASM). The browser runs two tiny models only to guide and auto-capture. |
| PDFs | PDFKit with an embedded Unicode font (DejaVu Sans) |
| Jobs | `node-cron` worker in the API: seals papers at the deadline, releases them at unlock time |
| Tests | Node's built-in test runner + Supertest, plus a SQL rule-check script |

---

## Run it on your laptop

You need **Node.js 22.9 or newer** and **PostgreSQL 16** (easiest: Docker Desktop).

```bash
# 1. database
docker compose up -d                    # PostgreSQL on localhost:5432, user postgres / password postgres

# 2. API (terminal 1)
cd server
npm install
cp .env.example .env
npm run keygen                          # prints MASTER_KEY=... and JWT_SECRET=... — paste both into .env
npm run migrate                         # creates all tables, triggers, functions, views
npm run dev                             # http://localhost:4000

# 3. website (terminal 2)
cd web
npm install
cp .env.example .env.local
npm run dev                             # http://localhost:3000
```

No Docker? Install PostgreSQL 16 and run `createdb sealedpaper` and `createdb sealedpaper_test`.
The camera only works on `localhost` or `https`. The first account you register becomes the exam controller.

**Full walkthrough with every role:** [`docs/DEMO.md`](docs/DEMO.md). Sample question files for the setters are in [`docs/sample-questions`](docs/sample-questions).

---

## Tests

```bash
cd server
npm test                                # 23 API tests, ~1 minute
npm run viva:sql                        # 29 database rule checks, PASS/FAIL table
```

Tests use the `sealedpaper_test` database and `FACE_MODE=mock` (a frame is the string `mock:<person>:<yaw>`, so the real liveness and matching logic runs without a camera).

**`test/exam.test.js`, the whole exam:** centres and paper setup · setters add and import questions, each sees only their own, ciphertext only in the database · an early leak names the setter, the investigator cannot burn, the admin can · sealing deletes the key; questions, blueprint and dates are frozen even in raw SQL · custodians unlock with key file + code + face; the draw skips the burned question; each centre gets its own order · printing PDFs with copy codes, another centre's superintendent is refused, the print cap holds · reprint needs approval, the old copy is voided, self-approval and deleting copies fail in SQL · a leak after release is traced to the right centre by order, and to the exact copy by its code · analytics views and the audit chain.

**`test/flow.test.js` and `test/race.test.js`, accounts and the vault:** login needs password and a matching face; wrong person, wrong pose order, no head turn and replayed challenges fail · key files download once · wrong key file, forged share, wrong code and wrong face are rejected · the time lock holds even in SQL · a TOTP code cannot be reused · **5 parallel unlock requests produce exactly one release**.

**`sql/viva_checks.sql`** runs inside a transaction and rolls back. It shows 29 rules the database enforces on its own: k-of-N limits, time lock, quorum, frozen settings, immutable share hashes, composite foreign keys for setters and blueprint cells, duplicate questions, no sealing while the key exists, frozen questions and blueprint, burning still allowed, no release before the quorum, `draw_final_questions()` skipping burned questions, the print cap, four-eyes reprints, undeletable copies, append-only audit, and `verify_audit_chain()` catching an edited row.

---

## Where each DBMS concept is used

| Concept | Where |
| --- | --- |
| 3NF, PK/FK, composite keys | `paper_setters`, `paper_custodians`, `paper_centres`, `final_questions` use composite keys. `questions` → `(paper_id, setter_id)` and `(paper_id, topic, difficulty)` composite FKs, so only an assigned setter can write, and only for a blueprint cell. |
| CHECK / UNIQUE / EXCLUDE | `papers_timeline`, `papers_threshold`, `papers_key_only_in_draft` (the key must be gone once sealed), `questions_no_duplicates` (HMAC), `reprint_four_eyes`, `reprint_one_open_per_copy` (exclusion constraint), centre code format |
| Triggers (20) | Time lock + quorum on release; paper status machine; questions frozen after seal (burn still allowed); blueprint/setters/custodians/centres frozen; print cap with an advisory lock; printed copies and leak reports immutable; audit hash chain + append-only; key shares immutable; activation needs face + authenticator |
| Transactions + row locks | Release: `SELECT … FOR UPDATE` on the document, rebuild key, `finalize_release()`, `draw_final_questions()`, variants: all one transaction. Sealing and printing are transactions too. |
| Stored functions | `finalize_release()`, `draw_final_questions()` (secure shuffle via `gen_random_bytes`), `verify_audit_chain()`, `custodian_locked_out()`, `audit_row_hash()` |
| Window functions | `LAG()` in `verify_audit_chain()`; `COUNT(*) OVER (… RANGE '10 minutes' PRECEDING)` in `suspicious_key_attempts`; `row_number() OVER ()` in the draw |
| Views | `unlock_status`, `pool_coverage`, `centre_readiness`, `suspicious_key_attempts`, `face_failure_report`, `setter_leak_report`, `centre_reprint_rates` |
| GROUP BY / HAVING, subqueries | `setter_leak_report` (setters with more than one leaked question), `centre_reprint_rates` (centres above the average reprint rate), `face_failure_report` |
| Indexes | Partial indexes `documents(unlock_at) WHERE status='sealed'`, `papers(seal_deadline) WHERE status='draft'`, `questions(…) WHERE status='active'`; `variants(signature)` |
| DCL | Role `sealedpaper_app` gets INSERT/SELECT only on evidence tables (audit log, copies, leak reports, submissions) |

---

## Deploy (free tiers)

| Part | Service | Settings |
| --- | --- | --- |
| Database | **Neon** (or Supabase) | Create a project, copy the connection string |
| API + worker | **Render** web service | Root `server`, build `npm ci && npm run migrate`, start `npm start`. `render.yaml` sets this up as a Blueprint. |
| Website | **Vercel** | Root directory `web`. Environment variable `API_URL=https://<your-render-app>.onrender.com` (needed at build time). |

Render environment variables: `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_SSL=true`, `MASTER_KEY`, `JWT_SECRET` (from `npm run keygen`), `FACE_MODE=real`, `TRUST_PROXY=2`.
Secrets live only in these dashboards, never in git. The browser talks only to Vercel, which proxies `/api/*` to Render, so login cookies stay first-party.

> Render's free plan sleeps after 15 idle minutes. Open the site a minute before your demo so the API wakes up and loads the face models.

---

## How the face check works

1. The server issues a **one-time challenge**: the three poses in a random order, valid for 2 minutes.
2. The browser shows a mirrored preview with an oval, guides the person with two tiny models, and **auto-captures** a raw frame for each pose (a **Capture** button appears if the guide models cannot load).
3. The server analyses the three frames: exactly one face, close enough; **head turn** from the 68 landmarks (under 0.15 = straight, over 0.2 = turned, in the right direction); the turned frames must be the **same person** as the straight one (distance ≤ 0.6); the straight frame must match the **stored template** (distance ≤ 0.5), which is stored AES-encrypted.
4. Every attempt is logged in `face_checks`. Tune in `server/.env`: `FACE_MATCH_THRESHOLD` (lower = stricter), `FACE_STRAIGHT_MAX_YAW`, `FACE_TURN_MIN_YAW`.

## How the leak tracer works

- **Before release** the questions are encrypted, so the tracer never decrypts. Each line of the leak, and each run of up to 4 lines, is normalised (case, punctuation, numbering and "[2 marks]" removed) and HMAC'd with a key derived from the master key. Matches against `questions.body_hmac` name the setter.
- **After release** the final paper is decrypted with the key the quorum rebuilt. The tracer finds where each final question appears in the leak and which options follow it, then scores every centre's variant: the share of question pairs in the same order plus the share of option orders that match. A copy code anywhere in the text names the exact copy (confidence 100%).

---

## Project structure

```
sealedpaper/
├── docker-compose.yml            local PostgreSQL (+ test database)
├── render.yaml                   Render blueprint for the API
├── docs/
│   ├── DEMO.md                   viva demo, step by step
│   ├── sample-questions/         JSON files for setters to import
│   └── screenshots/
├── server/                       Express API + worker
│   ├── migrations/               001 tables · 002 triggers · 003 functions/views · 004 DCL · 005 exam papers
│   ├── sql/viva_checks.sql       29 database rule checks
│   ├── assets/fonts/             DejaVu Sans for the PDFs
│   ├── src/routes/               auth, users, documents, papers, centres, leaks, audit
│   ├── src/services/             crypto, shamir, totp, face, faceCheck, questions, papers, release, pdf, tracer, audit
│   ├── src/worker.js             seals at the deadline, releases at unlock time
│   └── test/                     exam, flow and race tests
└── web/                          Next.js + Tailwind
    ├── app/                      register, login, papers, papers/[id] (+edit, content), centres, leaks, dashboard (vault), documents, admin/users, audit
    └── components/               FaceScan, QuorumSeal, PaperForm, SetterPool, CentrePrint, PaperBits, TotpSetup…
```

## API

| Method | Endpoint | Who | Does |
| --- | --- | --- | --- |
| POST | `/api/auth/register` · `/face-challenge` · `/enroll/face` · `/enroll/totp` · `/enroll/totp/confirm` | Registering | Account, face template, authenticator |
| POST | `/api/auth/login` → `/login/face` · `/refresh` · `/logout` | Anyone | Password, then face → session |
| GET · PATCH | `/api/users` · `/api/users/:id` | Admin | List, change role, disable |
| GET · POST · PATCH | `/api/centres` · `/:id` | Admin (investigator reads) | Exam centres |
| GET · POST | `/api/papers` | Involved users · admin | List · create |
| GET · PUT | `/api/papers/:id` · `/:id/setup` | Involved users · admin | Role-shaped detail · edit while draft |
| POST | `/api/papers/:id/seal` | Admin | Split and delete the key |
| GET · POST | `/api/papers/:id/questions/mine` · `/questions` · `/questions/import` | Setter | Own questions · add · bulk import |
| PATCH · DELETE | `/api/papers/questions/:qid` | Setter | Edit · delete own question before seal |
| GET | `/api/papers/:id/content` | Admin, investigator | Final paper + answer key per centre (after release) |
| GET · POST | `/api/papers/:id/centres/:centreId/copies` · `/print` | Superintendent | Copy list · print copies (PDF) |
| POST · PATCH · POST | `/api/papers/copies/:id/reprint-requests` · `/reprint-requests/:id` · `/reprint-requests/:id/print` | Superintendent · admin · superintendent | Ask · decide · print the replacement |
| POST · GET | `/api/leaks` · `/:id` · `/analytics` | Investigator, admin | Trace · report · setter and centre analytics |
| POST | `/api/leaks/:id/burn` | Admin | Withdraw matched questions before release |
| POST | `/api/documents/:id/key-file` · `/face-challenge` · `/unlock` | Custodian | Collect key · face challenge · submit key |
| GET | `/api/audit` · `/verify` · `/suspicious` | Admin, investigator | Log, hash-chain check, brute-force view |

## Honest limitations (say these in the viva before the examiner does)

- **Liveness is head-turn based.** A printed photo fails, but a video of the person turning on cue could pass. Production would add an anti-spoofing model.
- **Before sealing, the server's master key could decrypt the pool.** In production that key would live in a cloud KMS. After sealing the paper key is deleted.
- **During release the server briefly holds the rebuilt key in memory**, and keeps it wrapped so centres can print. A fully trustless design would decrypt on the custodians' devices.
- **Nobody can stop a photo of a printed paper.** SealedPaper shrinks the window to minutes and makes the photo traceable.
- **Question order identifies the centre, not the copy.** Copy-level tracing relies on the printed copy code, which can be cropped (the watermark makes that harder).
- **Late assembly reduces setter leaks but does not remove them**: a leaked pool question that is not caught still has a chance of being drawn.
- **Reworded leaks are not matched** (exact text after normalising). Fuzzy matching such as MinHash is a stretch goal.
- A lost key file cannot be re-issued; k-of-N tolerates N − k lost files.
