# Viva demo, step by step

About 15 minutes. Every step shows a rule being **enforced**, not just a screen being clicked.

## Before the viva (the day before)

You need 9 accounts. Use one normal browser window plus **Chrome profiles** (or different browsers) so each stays logged in.
You can scan your own face for every account; each account stores its own face template.

| Account | Role to give it on **People** |
| --- | --- |
| You (first account) | Exam controller (automatic) |
| Setter A, Setter B | Paper setter |
| Custodian 1, 2, 3 | Key custodian (default) |
| Superintendent Delhi, Superintendent Pune | Centre superintendent |
| Investigator | Investigator |

1. **Centres**: add `DEL01` (Delhi) and `PUN02` (Pune).
2. **Papers → New exam paper**:
   - Exam "Mid-semester examination 2026", subject "Data Structures", title "Paper A", 90 minutes.
   - Blueprint: Arrays / easy / 3 / 2 marks · Trees / medium / 3 / 4 marks · Graphs / hard / 2 / 6 marks.
   - Setters A and B; custodians 1, 2, 3 with **2 of 3**; DEL01 (Delhi superintendent, 3 candidates, 1 spare) and PUN02 (Pune superintendent, 40 candidates).
   - Times: seal deadline in about 20 minutes, unlock 5 minutes after that, exam start 45 minutes after unlock.
     For the live demo set these so the unlock lands at the right moment, or create the paper fresh during the viva.
3. As Setter A import `docs/sample-questions/setter-a.json`; as Setter B import `setter-b.json`.

## In the viva

| # | Do | What it proves |
| --- | --- | --- |
| 1 | Log in as the controller: password, then **face scan** (straight, left, right in random order). | Two factors at every login; the server checks liveness and identity. |
| 2 | Open the paper: blueprint table shows "In the pool" counts, **Seal now** is available. In `psql`: `SELECT topic, body_enc FROM questions LIMIT 3;` | The database holds only ciphertext. The admin cannot read questions either. |
| 3 | Log in as Setter A: only **their** questions are listed. | Setters never see each other's work, or the final paper. |
| 4 | As Investigator, **Leaks**: paste one of Setter A's questions as if found on Telegram. | Before release the tracer matches by HMAC without decrypting, and names **Setter A**. |
| 5 | As the controller open that report → **Withdraw the matched questions**. Blueprint shows 1 withdrawn. | The draw can never pick a leaked question. |
| 6 | **Seal now**. Setter A's page now says the questions are sealed. In `psql`: `SELECT status, data_key_wrapped FROM papers;` → `sealed`, `NULL`. | The key is split and **deleted**: nobody can read the pool now. |
| 7 | In `psql`: `UPDATE papers SET status = 'released';` and `DELETE FROM questions;` | Both refused by triggers: "still locked", "frozen". |
| 8 | As Custodian 1: **My keys** → the paper → enter the 6-digit code → **Download my key file**. Try again: refused. | Each key file is shown once; the server keeps only its hash. |
| 9 | As Custodian 1: upload **Custodian 2's** key file. | Refused: "This key file is not yours". |
| 10 | Custodians 1 and 3 submit (key file + code + face). The quorum seal shows 2/2 but stays red until the unlock time. | Quorum alone is not enough; the time lock holds. |
| 11 | Run `npm test` in another terminal (or show the result): **5 parallel unlock requests produce exactly one release**. | `SELECT … FOR UPDATE` serialises racing custodians. |
| 12 | At unlock time the paper turns **Released**. Controller → **Open the final paper**: the drawn questions and an answer key per centre. | Late assembly: the final paper was chosen only now, with a secure shuffle. |
| 13 | As Superintendent Delhi → print 3 copies → open the PDF: centre and copy code on every page plus a watermark. Try a 4th copy. | Print cap (candidates + spares) is a database trigger. |
| 14 | Superintendent Pune cannot print Delhi's copies. Report one Delhi copy spoiled → controller approves → **Print replacement**. | Four-eyes reprint; the old copy is voided and stays on record. |
| 15 | Copy the text of one Delhi copy (select all in the PDF) → Investigator → **Leaks** → paste. | Names the **exact copy** and who printed it. |
| 16 | Paste just the questions of a copy without the footer lines. | Names the **centre** from the question and option order. |
| 17 | `npm run viva:sql` | 29 PASS rows: every rule above enforced by the database itself. |
| 18 | **Audit log → Verify the hash chain**. Then as superuser: `ALTER TABLE audit_log DISABLE TRIGGER audit_no_edit; UPDATE audit_log SET payload = '{}' WHERE id = 5; ALTER TABLE audit_log ENABLE TRIGGER audit_no_edit;` and verify again. | The tampered row is flagged by number. |
| 19 | Finish on the live URL. | Deployed on Vercel + Render + Neon. |
