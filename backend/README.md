# Cashbook API

Run `uvicorn main:app --reload` from this folder. Configuration is loaded from
`.env`; see the root README for PostgreSQL and initial administrator setup.
Interactive request/response documentation is at `/docs`; OpenAPI is at
`/openapi.json`. All resource routes are under `/api`.

## Compatibility and accounting

The frontend now uses the resource routes for reads and writes. `/state` and
`/changes` remain compatibility adapters for older installed clients; their
success responses and accounting workflows are preserved.
No schema migration is required by this API refactor.

Amounts are PKR with at most two decimal places. Regular users submit their own
bills against active transactionable heads they are permitted to use. They see
received credits and their account totals, but never their own submitted bill
history. Administrators manage accounts, heads, assignments, and transactions.
Administrator advances/payments retain the existing direct-payment rules.

External users are payers. Contracts share one total across their linked external
users; there are no allocations per user. Receipts cannot exceed the contract's
remaining amount. Assigning a previously direct receipt to a contract creates a
new edit-trail version without recording another receipt. Transaction history
snapshots contract names and head paths; current head paths follow the tree.

## Resource routes

UUIDs identify users, external users, and contracts. Positive integer IDs identify
transactions and attachments. Resource identity is supplied in the URL; request
bodies cannot override it. Unknown body fields are rejected.

| Method | Route | Purpose / request body |
| --- | --- | --- |
| GET | `/session` | Current `{userId, role}`, or null |
| POST | `/session` | Login: `{username, password}` |
| DELETE | `/session` | Revoke session and clear cookie |
| GET | `/users` | Administrator's user directory, including inactive accounts |
| POST | `/users` | Create: `{profile, password}` |
| GET | `/users/{id}` | Administrator's view of one user |
| PUT | `/users/{id}/profile` | Replace profile: `{user_name, description?, contacts?}` |
| PUT | `/users/{id}/password` | Reset: `{password}`; revoke other sessions |
| PUT | `/users/{id}/status` | `{active}` |
| PUT | `/users/{id}/pin` | `{pinned}` |
| DELETE | `/users/{id}` | Delete only when accounting history permits |
| GET | `/users/{id}/overview` | Own account totals/current credits, or administrator preview |
| GET | `/users/{id}/permissions` | Administrator: explicit rules; self: effective allowed heads |
| PUT | `/users/{id}/permissions` | Replace rules: `{ids:[...]}`; negative IDs deny inheritance |
| GET | `/permissions` | Administrator's complete signed permission-rule map |
| GET | `/transaction-types` | Authenticated transaction type catalog |
| GET | `/external-users` | Administrator's external user directory |
| POST | `/external-users` | Create with a profile body |
| GET | `/external-users/{id}` | One external user |
| PUT | `/external-users/{id}/profile` | Replace profile |
| PUT | `/external-users/{id}/status` | `{active}` |
| PUT | `/external-users/{id}/pin` | `{pinned}` |
| DELETE | `/external-users/{id}` | Delete only if unlinked and without history |
| GET | `/contracts` | Administrator's contracts, shared total, revision and linked payer IDs |
| POST | `/contracts` | `{name, description?, totalAmount, creditUserIds}` |
| GET | `/contracts/{id}` | One contract |
| PUT | `/contracts/{id}?expectedRevision=N` | Replace contract details with the create body |
| PUT | `/contracts/{id}/status` | `{active, expectedRevision}`; false archives |
| DELETE | `/contracts/{id}?expectedRevision=N` | Delete only without receipt history |
| GET | `/transactions?userId=UUID&limit=100&offset=0` | Administrator ledger or regular user's current received credits |
| GET | `/transactions/{id}` | One authorized transaction; regular users never receive edit history |
| POST | `/transactions/bills` | Submit own bill: `{input}`; administrator preview cannot submit |
| POST | `/users/{id}/bills` | Administrator records that active user's bill: `{input}`, using their assigned active transactionable heads |
| POST | `/users/{id}/admin-payable` | Administrator adds a personal amount owed to a normal user: `{input}`; direct, no head |
| POST | `/users/{id}/admin-payable/payments` | Administrator pays part or all of that personal obligation: `{input}`; cannot exceed remaining amount |
| POST | `/transactions/credits` | Administrator credit: `{userId, creditUserId?, contractId?, input}` |
| PUT | `/transactions/{id}` | Edit: `{expectedVersion, input, contractId?}` |
| PUT | `/transactions/{id}/status` | `{active, expectedVersion}` |
| DELETE | `/transactions/{id}?expectedVersion=N` | Delete using the current version |
| GET | `/heads` | `{heads, revision}`; normal users receive permitted active heads |
| POST | `/heads/batch` | Atomic tree draft: `{revision, changes:[...]}` |
| GET | `/preferences/home-order` | Administrator's saved Home card order |
| PUT | `/preferences/home-order` | `{ids:[...]}`; each supported card once |
| POST | `/attachments` | Multipart `file` and `kind` (`image` or `voice`), up to 5 MiB |
| GET | `/attachments/{id}?export=false` | Authorized private media |
| POST | `/attachments/export` | Administrator report images: `{ids:[...]}` |

Resource creation returns 201 with the created resource (bill submission returns
`{id, applied:true}`). Updates return the updated resource. Deletes and password
changes return 204. Login/logout keep their existing 200 responses.

`GET /transactions` returns `{items, limit, offset, nextOffset}`. `limit` is 1–500,
default 100; a null `nextOffset` means there are no more entries. Entries retain
the existing ascending transaction-date/ID order. Concurrent edits may move an
offset page; refresh the ledger when a coherent new report is needed. The
compatibility `/state` snapshot remains complete for older clients.

Resource reads return `X-Cashbook-Snapshot`, an opaque token bound to the account
and PostgreSQL transaction snapshot. Send it on subsequent resource requests and
ledger pages that must form one consistent UI/report. If it changed, the server
returns 409 with `X-Cashbook-Retry-Read: 1`. Discard the partial read and start
again. The frontend retries the complete read at most twice, never publishes
partial totals, and never retries writes. Background ledger reads do not advance
the revision attached to an existing head draft.

`input` is `{amount, headId?, description?, transactionTypeId?:1,
attachments?:[{id,kind,name,url}]}`. Only attachment IDs are authoritative;
display names, kinds and URLs supplied in this reference cannot replace stored
metadata. Regular-user uploads must belong to that user and be unused.

Home's User credit is an explicit admin bill-entry flow, separate from User debit
(direct payments) and Admin credit (external receipts). It does not create or
replace a user session. Bills retain the existing owner/creator accounting
discriminator so balances, company cash statements and regular-user visibility
remain consistent. Statements and transaction cards show the selected user as
Entered by, using the existing `createdBy` field. The initial version retains
the actual admin editor in the edit trail. Existing Home orders
with 7, 9, 10 or 11 cards remain accepted; new orders include all 12 cards.

Admin payable uses transaction types 2 (added) and 3 (paid), registered by migration
011. Normal entries retain type 1. Obligations are direct, ledger-only entries;
payments appear once as company cash outflow. Both affect the normal user's
statement and can be hidden together with its Show Admin payable toggle,
including opening balances, totals and exports. They are excluded from the
ordinary Receivable/Payable cards. The Admin payable card tracks only the personal
remaining balance. Writes use the common ledger lock, so simultaneous payments
cannot exceed it. Editing, deleting, deactivating or reactivating entries cannot
leave personal payments greater than personal obligations. Generic transaction
creation cannot forge these transaction types.

Head operations are `create`, `edit`, `move`, `merge`, `delete`, `backup`, and
`active`, documented in OpenAPI. A single batch preserves temporary negative
IDs, merges, permission inheritance, and all-or-nothing draft application.
The server retains the existing tree/accounting semantics, including descendant
deactivation, branch deletion, and inactive history-preserving backups.

## Existing frontend adapters

| Route | Preserved response |
| --- | --- |
| `GET /state` | Role-filtered heads/users/permissions/transactions/contracts/catalogs/preferences |
| `GET /state?userId=UUID` | Own account overview or administrator preview |
| `POST /changes` | Existing discriminated command (`op` and `action`) and success body |

The adapter and resource routes call the same accounting services. Neither has a
weaker authorization path. Contract/transaction edits require the current
revision/version and return 409 if stale. Automatic retries of money-changing
requests are unsafe and are not performed. After an interrupted write, refresh
and check whether it was recorded before submitting it again.

## Security and failures

All writes require `X-Cashbook: 1`; cross-site fetch mutations are rejected. CORS
is not enabled. Use the same-origin frontend proxy. Sessions are HttpOnly,
SameSite=Strict, expire after seven days, and require an active user. Set
`COOKIE_SECURE=true` in HTTPS production (already set by deployment); local HTTP
development uses false. Passwords use salted scrypt hashes and never appear in
resource responses. Credentials are locked during login so password changes and
session revocation cannot race a login using old credentials.

Login is limited to 20 attempts per minute per effective client address, with
429 and `Retry-After`. This bounded limiter is per backend process. If adding
workers/instances, enforce a shared limit at the trusted proxy. The server uses
the address supplied by the ASGI server, never independently trusts a client
`X-Forwarded-For` header; restrict trusted proxies and keep the backend private.

Errors retain `{detail: string}` or validation `{detail:[{loc,msg,type}]}` for
the current frontend. Statuses: 400 business rule, 401 expired/absent session,
403 forbidden, 404 unavailable resource, 409 stale/conflicting record, 413 export
too large, 422 invalid input, 429 login throttling, 503 dependency unavailable.
Unexpected errors return a generic 500. Internal errors/inputs are not exposed
in responses. Every response has no-store, nosniff and a generated X-Request-ID
for troubleshooting. Logs never intentionally include credentials or bodies.

Private attachments retain authorization checks before storage access. Storage
outages receive a useful error. Exports read at most 5 MiB per file and 50 MiB
total raw image bytes; larger reports must select fewer entries per export to
avoid exhausting server memory. Files used by history/backups remain retained.

## Code boundaries and transactions

- `main.py`: application composition, transport policy, safe error responses,
  legacy adapter routes.
- `auth.py`: sessions, cookies, credential locking and login throttling.
- `api_dependencies.py`: request-scoped database connection, authentication and
  shared/exclusive ledger locks acquired before authentication.
- `resources.py`, `resource_models.py`, `responses.py`, `queries.py`: resource
  routing, request validation and public serialization.
- `commands.py`: shared legacy/resource command execution and explicit commit.
- `service.py`, `contracts.py`: existing accounting and permission rules.
- `attachments.py`, `storage.py`: upload/download authorization and storage.
- `db.py`, `models.py`: existing connection/bootstrap and domain input schemas.

Each request owns a PostgreSQL transaction. Mutations retain the established
advisory lock so tree, permission, deletion and transaction operations cannot
race each other. Multi-query ledger reads hold its shared lock. Authentication
is checked after waiting for that lock. Resource responses are assembled before
commit; commits (including deferred constraints) finish before a success response.
Dependency cleanup also runs before sending responses. No schema, money formula,
ORM, queue, cache, or database migration was introduced by this refactor.

## External receipt allocations

Receipt creation stays on `POST /api/transactions/credits`. Only external-user
receipts receive a permanent eight-character alphanumeric `receiptKey`.
`PUT /api/receipts/{id}/allocations` saves the receipt's `input`,
`expectedVersion` and complete `allocations` list atomically. Each allocation is
`{kind: "contract", contractId, amount}` or `{kind: "profit", amount}`. Contract
allocations must use a linked payer; overpayment is allowed. Contract balances
use allocated amounts, with negative remaining balances classified as Payable.

`POST /api/receipts/{id}/returns` accepts `expectedVersion`, `amount`, and an
optional `description`. It creates one compensating cash debit, linked to the
original receipt, limited to its unallocated amount. Original receipts and their
returns share the same public key. Returns cannot be edited or deleted; an
incorrect return can be deactivated, with history retained. Normal-user and
Admin payable entry routes are unaffected.

Migration012 introduces only `receipt_allocations`. Its `kind` distinguishes
receipt identity, return links, and versioned contract/profit allocation rows.
Existing table definitions are unchanged; the table can reference any transaction
for future extensions, while the application enables this workflow only for
external users. Backfill preserves legacy receipt and version values. The
existing schema-version tracker records migration12 as usual.

Receipt totals stay in the original transaction, and attachments stay on its
versions. Do not sum allocations into company cash or assume every external-user
transaction is a credit: `receiptParentId` identifies a debit return. Contract
statements project only the contract's allocated portion; editing one opens the
original full receipt. Receipt keys/search controls are omitted from print/PDF
and spreadsheet report documents.

## Verification

Install test dependencies with `python -m pip install -r requirements-dev.txt`.
From this directory run:

```powershell
python -m unittest discover -p 'test_*.py'
python -m compileall -q . -x .venv
```

Unit and HTTP tests cover resource/legacy parity, authorization, request shapes,
public response filtering, lock ordering, commit failures, contracts, upload
failures, and bounded exports. `test_database_api.py` additionally exercises
accounting and concurrency against a disposable PostgreSQL database. It is
skipped unless `CASHBOOK_TEST_DATABASE_URL` is explicitly set, refuses a nonlocal
or nonempty database, and never uses the application DATABASE_URL. The file
contains commands to create and remove a temporary test container. CI runs it
against a fresh PostgreSQL service.
