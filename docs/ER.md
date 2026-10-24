# SealedPaper ER diagrams

29 tables in four views. PK = primary key, FK = foreign key, UK = unique. `||--o{` = one to many, `||--||` = one to one, `|o--o{` = optional one to many.

## 1. Accounts, face checks and audit

```mermaid
erDiagram
  users ||--o{ sessions : "logs in"
  users ||--|| face_templates : "has"
  users ||--o{ face_challenges : "is asked"
  users ||--o{ face_checks : "passes or fails"
  face_challenges |o--o{ face_checks : "answered by"
  users |o--o{ audit_log : "acts (null = worker)"
  users { uuid id PK
    text email UK
    role role
    text totp_secret_enc }
  sessions { uuid id PK
    uuid user_id FK }
  face_templates { uuid user_id PK,FK
    real[] descriptor }
  face_challenges { uuid id PK
    uuid user_id FK }
  face_checks { uuid id PK
    uuid user_id FK
    uuid challenge_id FK }
  audit_log { bigint id PK
    uuid actor_id FK
    text prev_hash
    text hash }
```

## 2. Key vault (any confidential document)

```mermaid
erDiagram
  users ||--o{ documents : "creates"
  documents ||--|| document_blobs : "ciphertext"
  documents ||--o{ key_shares : "split into"
  users ||--o{ key_shares : "holds (custodian)"
  key_shares ||--o| share_submissions : "submitted"
  key_shares ||--o| pending_shares : "waiting"
  documents ||--o| releases : "opened once"
  documents ||--o{ document_recipients : "readers"
  users ||--o{ document_recipients : "reads"
  documents ||--o{ document_copies : "traced copies"
  users ||--o{ document_copies : "receives"
  documents ||--o{ downloads : "logged"
  documents { uuid id PK
    uuid created_by FK
    uuid paper_id FK,UK
    int threshold_k
    timestamptz unlock_at
    document_category category }
  document_blobs { uuid document_id PK,FK }
  key_shares { uuid document_id PK,FK
    uuid custodian_id PK,FK
    text share_hash }
  share_submissions { uuid id PK
    uuid document_id FK
    uuid custodian_id FK }
  pending_shares { uuid id PK
    uuid document_id FK
    uuid custodian_id FK }
  releases { uuid document_id PK,FK }
  document_recipients { uuid document_id PK,FK
    uuid user_id PK,FK }
  document_copies { uuid id PK
    uuid document_id FK
    uuid reader_id FK
    text copy_code UK }
  downloads { uuid id PK
    uuid document_id FK
    uuid user_id FK }
```

## 3. Exam papers

```mermaid
erDiagram
  exams ||--o{ papers : "has"
  papers ||--o| documents : "sealed as"
  papers ||--o{ paper_setters : "set by"
  papers ||--o{ paper_custodians : "guarded by"
  papers ||--o{ blueprint_items : "blueprint"
  paper_setters ||--o{ questions : "writes"
  blueprint_items ||--o{ questions : "slot"
  papers ||--o{ paper_centres : "sat at"
  centres ||--o{ paper_centres : "hosts"
  papers ||--o{ final_questions : "drawn"
  questions ||--o| final_questions : "chosen"
  paper_centres ||--|| variants : "shuffled copy"
  exams { uuid id PK
    uuid created_by FK }
  papers { uuid id PK
    uuid exam_id FK
    paper_status status
    timestamptz seal_at
    timestamptz unlock_at }
  centres { uuid id PK
    text code UK }
  paper_setters { uuid paper_id PK,FK
    uuid setter_id PK,FK }
  paper_custodians { uuid paper_id PK,FK
    uuid custodian_id PK,FK }
  blueprint_items { uuid id PK
    uuid paper_id FK
    text topic
    difficulty difficulty }
  questions { uuid id PK
    uuid paper_id FK
    uuid setter_id FK
    bytea body_enc
    text body_hmac }
  paper_centres { uuid paper_id PK,FK
    uuid centre_id PK,FK
    uuid superintendent_id FK }
  final_questions { uuid paper_id PK,FK
    uuid question_id PK,FK }
  variants { uuid id PK
    uuid paper_id FK
    uuid centre_id FK }
```

## 4. Printing and leaks

```mermaid
erDiagram
  variants ||--o{ printed_copies : "printed"
  users ||--o{ printed_copies : "prints"
  printed_copies ||--o{ reprint_requests : "spoiled"
  reprint_requests |o--o| printed_copies : "replacement"
  users ||--o{ leak_reports : "reports"
  papers |o--o{ leak_reports : "leak of paper"
  documents |o--o{ leak_reports : "leak of document"
  variants |o--o{ leak_reports : "matched variant"
  printed_copies |o--o{ leak_reports : "matched copy"
  document_copies |o--o{ leak_reports : "matched copy"
  leak_reports ||--o{ leak_matches : "evidence"
  questions ||--o{ leak_matches : "matched question"
  leak_reports |o--o{ questions : "burns"
  printed_copies { uuid id PK
    uuid variant_id FK
    uuid printed_by FK
    text copy_code UK
    uuid reprint_request_id FK }
  reprint_requests { uuid id PK
    uuid copy_id FK
    uuid requested_by FK
    uuid decided_by FK }
  leak_reports { uuid id PK
    uuid paper_id FK
    uuid document_id FK
    uuid matched_variant_id FK
    uuid matched_copy_id FK
    uuid matched_document_copy_id FK }
  leak_matches { uuid id PK
    uuid leak_report_id FK
    uuid question_id FK
    uuid setter_id FK }
```

Constraints, normalisation (1NF to BCNF) and the full relationship table are in the guide doc's "ER diagram and normalisation" tab.
