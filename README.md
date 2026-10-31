# Transaction Management System

A cashbook for company accounts, users, external receipts, and contracts—with images, voice notes, and printable statements. Built with React, FastAPI, and PostgreSQL, with a responsive interface for desktop and mobile.

## What it does

| Area | Features |
| --- | --- |
| Home | Balance overview, rearrangeable action cards, and pinned accounts. |
| Users & access | Normal and external users, profiles, multiple contacts, account status, passwords, head permissions, and a safe user preview. |
| Head management | Nested heads, search, transaction permissions, staged edits/moves/merges, backups, and undo/redo before Apply. |
| Entry workflows | User debit for payments, User credit for bills recorded on a user’s behalf, and Admin credit for external receipts. Images, voice, description, and review steps keep evidence with entries. |
| Statements | Company and user statements; date/time, user, head/contract, and description filters; credit/debit views, ordering, carry-forward balances, and scroll to last. |
| Selection & reports | Select individual entries or ranges, unselect them, preview, print, export PDF/Excel/CSV, share supported files, or export attachments only. |
| Attachments | Camera/gallery/file uploads, voice recording and audio uploads, head-wise browsing, image previews, and image-only PDFs. |
| Contracts & receipts | Shared contracts linked to external users, individual contributions, contract/profit/direct receipt portions, Receipt ID search, and field-by-field inheritance of descriptions, images, and voice notes. |
| Outstanding balances | Receivable and Payable include contract balances; overpaid contracts move to Payable and zero balances are excluded. |
| Admin payable | Personal obligations remain separate from company cash; payments appear in Company Statement. User statements can show or hide these entries. |
| History | Versioned edits and retained evidence, deactivated-entry review, and checks against saving stale changes. |

## Production screenshots

Amounts and private details are heavily blurred. These are captures of the live application, not mockups. Click an image to inspect it.

<table>
<tr>
<td width="50%"><strong>Home dashboard</strong><br><a href="docs/screenshots/01-home.webp"><img src="docs/screenshots/01-home.webp" alt="Production dashboard with financial amounts blurred" width="520"></a></td>
<td width="50%"><strong>Head management</strong><br><a href="docs/screenshots/02-heads.webp"><img src="docs/screenshots/02-heads.webp" alt="Nested head management and staged-change controls" width="520"></a></td>
</tr>
<tr>
<td><strong>User management</strong><br><a href="docs/screenshots/04-users.webp"><img src="docs/screenshots/04-users.webp" alt="User account cards and management actions with private details blurred" width="520"></a></td>
<td><strong>Company Statement</strong><br><a href="docs/screenshots/09-company-statement.webp"><img src="docs/screenshots/09-company-statement.webp" alt="Company Statement filters and ledger with amounts blurred" width="520"></a></td>
</tr>
<tr>
<td><strong>Preview & export</strong><br><a href="docs/screenshots/11-report-preview.webp"><img src="docs/screenshots/11-report-preview.webp" alt="Printable report preview with PDF Excel CSV share and print controls" width="520"></a></td>
<td><strong>Attachment browsing</strong><br><a href="docs/screenshots/15-attachments.webp"><img src="docs/screenshots/15-attachments.webp" alt="Head-wise attachment browsing with voice notes and export controls" width="520"></a></td>
</tr>
<tr>
<td><strong>Contracts & linked users</strong><br><a href="docs/screenshots/13-contract-details.webp"><img src="docs/screenshots/13-contract-details.webp" alt="Contract balance and linked external user contributions with amounts blurred" width="520"></a></td>
<td><strong>Details for each receipt portion</strong><br><a href="docs/screenshots/14-portion-details.webp"><img src="docs/screenshots/14-portion-details.webp" alt="Receipt portion editor showing inherited description and attachment controls" width="520"></a></td>
</tr>
</table>

## Run, test & maintain

Start with the [development guide](docs/DEVELOPMENT.md) for local setup and commands. See the [backend API guide](backend/README.md), [database notes](database/README.md), and [production deployment guide](deploy/README.md) for implementation and operations.

GitHub Actions runs frontend, backend, database, and desktop/mobile browser checks before deployment. Production uses HTTPS and private attachment storage. Keep credentials out of Git and back up the database together with its media.
