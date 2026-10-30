# Cashbook frontend

Run `npm run dev` in this folder. Start the backend separately with `uvicorn main:app --reload` from its virtual environment. Vite proxies `/api` to localhost:8000, including cookie authentication, uploads and media downloads. No frontend environment file is needed for local development.

The mobile card workflow and admin sidebar/ledger use real backend data.
`src/data/cashbookApi.ts` connects the application to `cashbookClient.ts` (resource
API mapping and coherent data assembly) and `apiRequest.ts` (transport, cookies,
errors and read tokens). The frontend no longer calls `/api/state` or
`/api/changes`. No browser local-storage database or mock authentication remains.

See the [root setup guide](../README.md) for initial login and PostgreSQL startup, and the [API contract](../backend/README.md) for communication points.

Shared UI remains in `src/pages/Admin/components`; the same `UserPreview` drives user login, admin preview and crediting a user. `AttachmentInput` handles uploads/recording/review throughout. `src/pages/Ledger/ledgerModel.ts` owns filtering, head-branch selection, totals and frontend pagination; `ledgerExport.ts` exports those report rows to portrait PDF, XLSX and CSV, with PDF-based printing.

`ReportActions` provides the shared full-screen Preview / export dialog for both ledgers: all selected report pages, fit-width/zoom controls, PDF, Excel or CSV download, print and native file sharing. Portrait reports include the Sohail Malik Architects logo, branded headers, merged summary labels, aligned currency values and page footers. CSV is plain tabular data with UTF-8 BOM, escaped fields and formula-injection protection. Print opens the prepared PDF rather than printing the website; use the PDF viewer’s print control if the browser does not launch its dialog automatically. Its HTML preview uses the same report data as the exported files; PDF pagination may differ when long rows spill onto another page. Files are prepared before tapping Share so mobile user activation is preserved. Sharing opens the device's share sheet and requires a supporting browser and secure context (HTTPS or localhost). Available apps depend on the device; plain LAN HTTP or unsupported file types fall back to downloading and attaching the file manually. Reports are not uploaded or given public URLs.

Rightward finger swipes reveal the user's ledger with a slide transition; leftward swipes return to transaction entry. Hidden panes are inert, and reduced-motion preferences disable the transition.

No attachments or entry-ID column is included in reports. Normal users receive credit entries only and aggregate bill/payable figures, never their individual bill entries. Monetary inputs use at most two decimal places.

For local phone use, browse to the computer's LAN address on Vite's port. Direct microphone recording requires HTTPS or localhost; on plain LAN HTTP the upload-audio option is available. Camera/gallery file selection uses the mobile file picker.

## Regression checks

`npm test` runs the adapter, transport, accounting/report, selection, upload,
head-tree, permissions and profile tests. `npm run build` checks TypeScript and
the production bundle. Reads load all bounded ledger pages, sharing a resource
snapshot token; a changed snapshot discards the partial read. Writes are never
automatically replayed. If a change saves but its follow-up refresh fails, the
application shows a Reconnect screen that explicitly says the change was saved.

`npm run test:e2e` runs Playwright against a real backend/PostgreSQL with desktop
and mobile-width layouts. Install Chromium with `npx playwright install chromium`.
The tests check API usage, balances, contracts, statement scope, filters,
selection, edit trails, uploads, PDF previews/downloads and user submissions.

Use a disposable backend for these tests; test fixtures create accounting data.
For example, start a fresh PostgreSQL container without reusing an application
volume:

```powershell
docker run --name cashbook-frontend-e2e -d -p 127.0.0.1:55440:5432 -e POSTGRES_USER=cashbook_test -e POSTGRES_PASSWORD=cashbook_test -e POSTGRES_DB=cashbook_e2e postgres:17
```

From `backend/`, in a separate terminal:

```powershell
$env:CASHBOOK_E2E_DATABASE_URL='postgresql://cashbook_test:cashbook_test@127.0.0.1:55440/cashbook_e2e'
.\.venv\Scripts\python.exe e2e_server.py
```

This helper refuses a nonlocal or nonempty database, pins its network address,
uses temporary local uploads and disables external storage. Start Vite on port
5173, then run `npm run test:e2e` from this folder. Test login is `admin` with
password `api-e2e-admin-password`. Stop the helper/Vite and remove only this
temporary container afterward: `docker rm -f -v cashbook-frontend-e2e`.
The CI workflow runs the same tests against a separate disposable database.
