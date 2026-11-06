import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Requires a disposable, initialized backend and the normal Vite /api proxy.
// Every fixture and assertion uses real HTTP/SQL; no API responses are mocked.
const baseURL = process.env.CASHBOOK_E2E_BASE_URL || 'http://127.0.0.1:5173';
const adminPassword = process.env.CASHBOOK_E2E_ADMIN_PASSWORD || 'api-e2e-admin-password';
const userPassword = 'e2e-worker-password';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');

interface FixtureUser { user_id: string; user_name: string; }
let api: APIRequestContext;
let adminCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'];
let prefix: string;
let receivable: FixtureUser;
let payable: FixtureUser;
let zero: FixtureUser;
let payer: { credit_user_id: string; user_name: string };
let contract: { id: string; name: string };
let rootHead: string;
let leafHead: string;
let forbiddenHead: string;
let creditId: string;
let attachmentName: string;
let uiRequests: string[] = [];
let browserErrors: string[] = [];

async function call(context: APIRequestContext, method: string, path: string, data?: unknown, expected = 200) {
  const response = await context.fetch(`/api${path}`, { method, data, headers: { 'X-Cashbook': '1' } });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(expected);
  return response.status() === 204 ? null : response.json();
}

async function home(page: Page, card: string) {
  await page.goto('/Admin');
  const item = page.locator(`[data-home-card="${card}"]`);
  await expect(item).toBeVisible();
  await item.getByRole('button').click();
}

function accountCard(page: Page, name: string) {
  return page.locator('.home-card').filter({ has: page.getByText(name, { exact: true }) }).filter({ visible: true }).first();
}

async function workerLogin(page: Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(receivable.user_name);
  await page.getByLabel('Password', { exact: true }).fill(userPassword);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Remaining balance', exact: true })).toBeVisible();
}

test.beforeAll(async ({ playwright }, info) => {
  prefix = `E2E ${info.project.name} ${Date.now()}`;
  rootHead = `${prefix} project`;
  leafHead = `${prefix} expense`;
  forbiddenHead = `${prefix} restricted`;
  api = await playwright.request.newContext({ baseURL });
  const admin = await call(api, 'POST', '/session', { username: 'admin', password: adminPassword });
  adminCookies = (await api.storageState()).cookies;
  const makeUser = (name: string) => call(api, 'POST', '/users', {
    profile: { user_name: `${prefix} ${name}`, description: 'Browser regression fixture', contacts: [] }, password: userPassword,
  }, 201);
  receivable = await makeUser('advance');
  payable = await makeUser('owed');
  zero = await makeUser('zero');
  payer = await call(api, 'POST', '/external-users', { user_name: `${prefix} payer`, contacts: [] }, 201);
  contract = await call(api, 'POST', '/contracts', {
    name: `${prefix} contract`, description: 'Shared contract total', totalAmount: 2000, creditUserIds: [payer.credit_user_id],
  }, 201);
  const current = await call(api, 'GET', '/heads');
  const tree = await call(api, 'POST', '/heads/batch', { revision: current.revision, changes: [
    { op: 'create', temp_id: -1, head_name: rootHead, parent_head_id: null },
    { op: 'create', temp_id: -2, head_name: leafHead, parent_head_id: -1, is_transactionable: true },
    { op: 'create', temp_id: -3, head_name: forbiddenHead, parent_head_id: null, is_transactionable: true },
  ] });
  const rootId = tree.heads.find((head: { head_name: string }) => head.head_name === rootHead).head_id;
  const leafId = tree.heads.find((head: { head_name: string }) => head.head_name === leafHead).head_id;
  for (const worker of [receivable, payable]) {
    await call(api, 'PUT', `/users/${worker.user_id}/permissions`, { ids: [rootId] });
    const workerApi = await playwright.request.newContext({ baseURL });
    await call(workerApi, 'POST', '/session', { username: worker.user_name, password: userPassword });
    await call(workerApi, 'POST', '/transactions/bills', { input: {
      amount: worker === receivable ? 100 : 750, headId: leafId, description: `${prefix} initial bill`, attachments: [],
    } }, 201);
    await workerApi.dispose();
  }
  attachmentName = `${prefix.replaceAll(' ', '-')}-receipt.png`;
  const upload = await api.post('/api/attachments', {
    headers: { 'X-Cashbook': '1' }, multipart: { kind: 'image', file: { name: attachmentName, mimeType: 'image/png', buffer: png } },
  });
  expect(upload.status(), await upload.text()).toBe(200);
  const evidence = await upload.json();
  const credit = await call(api, 'POST', '/transactions/credits', {
    userId: receivable.user_id, input: { amount: 600, headId: null, description: `${prefix} funding evidence`, attachments: [evidence] },
  }, 201);
  creditId = credit.id;
  await call(api, 'POST', '/transactions/credits', {
    userId: payable.user_id, input: { amount: 200, headId: null, description: `${prefix} payment`, attachments: [] },
  }, 201);
  await call(api, 'POST', '/transactions/credits', {
    userId: admin.userId, creditUserId: payer.credit_user_id, contractId: contract.id,
    input: { amount: 350, headId: null, description: `${prefix} contract receipt`, attachments: [] },
  }, 201);
});

test.afterAll(async () => { await api?.dispose(); });

test.beforeEach(async ({ page }) => {
  uiRequests = [];
  browserErrors = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) uiRequests.push(`${request.method()} ${url.pathname}`);
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.context().addCookies(adminCookies);
});

test.afterEach(async () => {
  expect(uiRequests.filter((entry) => / \/api\/(?:state|changes)$/.test(entry)), 'UI must use the resource API').toEqual([]);
  expect(browserErrors, 'Browser must not throw uncaught errors').toEqual([]);
});

for (const view of ['statement', 'attachments'] as const) {
  test(`${view} selection toolbar exports attachments only from individually selected transactions`, async ({ page }) => {
    const worker = await call(api, 'POST', '/users', { profile: {
      user_name: `Selected ${view === 'statement' ? 'S' : 'A'} images ${Date.now()}`, contacts: [],
    }, password: userPassword }, 201);
    const images = [];
    const entries = [];
    for (let index = 0; index < 3; index++) {
      const uploaded = await api.post('/api/attachments', { headers: { 'X-Cashbook': '1' }, multipart: {
        kind: 'image', file: { name: `selected-${index}.png`, mimeType: 'image/png', buffer: png },
      } });
      expect(uploaded.status()).toBe(200);
      const image = await uploaded.json();
      images.push(image);
      entries.push(await call(api, 'POST', '/transactions/credits', { userId: worker.user_id,
        input: { amount: 10 + index, headId: null, description: `Private selected row ${index}`, attachments: [image] },
      }, 201));
    }
    const withoutImages = await call(api, 'POST', '/transactions/credits', { userId: worker.user_id,
      input: { amount: 5, headId: null, description: 'Selected entry without evidence', attachments: [] },
    }, 201);
    if (view === 'statement') {
      await home(page, 'receivable');
      await accountCard(page, worker.user_name).getByRole('button', { name: 'View statement', exact: true }).click();
    } else {
      await home(page, 'attachments');
      await page.getByLabel('Search attachment users', { exact: true }).fill(worker.user_name);
      await accountCard(page, worker.user_name).locator('button.home-card-main').click();
    }
    await page.getByRole('button', { name: 'Select entries', exact: true }).click();
    const toolbar = page.getByRole('region', { name: 'Selected entry actions', exact: true });
    const exportButton = toolbar.getByRole('button', { name: 'Attachments only', exact: true });
    await expect(exportButton).toBeDisabled();
    await page.getByRole('checkbox', { name: `Select entry ${withoutImages.id}`, exact: true }).check();
    await expect(exportButton).toBeDisabled();
    // Deliberately choose nonadjacent transactions without enabling Select range.
    await page.getByRole('checkbox', { name: `Select entry ${entries[0].id}`, exact: true }).check();
    await page.getByRole('checkbox', { name: `Select entry ${entries[2].id}`, exact: true }).check();
    await expect(toolbar).toContainText('3 entries selected');
    await expect(toolbar.getByRole('button', { name: 'Select range', exact: true })).toHaveAttribute('aria-pressed', 'false');
    const exported = page.waitForResponse((response) => response.url().endsWith('/api/attachments/export'));
    await exportButton.click();
    expect((await exported).request().postDataJSON().ids).toEqual([Number(images[0].id), Number(images[2].id)]);
    const preview = page.getByRole('dialog', { name: 'Attachments only', exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Print', exact: true })).toBeEnabled();
    await expect(preview.getByRole('button', { name: 'Share…', exact: true })).toBeEnabled();
    const downloaded = page.waitForEvent('download');
    await preview.getByRole('button', { name: 'Download PDF', exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe('attachments.pdf');
    await preview.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(toolbar).toContainText('3 entries selected');
    await page.getByRole('checkbox', { name: `Select entry ${entries[0].id}`, exact: true }).uncheck();
    const reexported = page.waitForResponse((response) => response.url().endsWith('/api/attachments/export'));
    await exportButton.click();
    expect((await reexported).request().postDataJSON().ids).toEqual([Number(images[2].id)]);
    await preview.getByRole('button', { name: 'Close', exact: true }).click();
    await toolbar.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(exportButton).toBeDisabled();
  });
}

test('login errors stay friendly and a valid login loads every home card', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Incorrect username or password.');
  await page.getByLabel('Password', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.locator('[data-home-card]')).toHaveCount(12);
  await expect(page.locator('[data-home-card="receivable"]')).toContainText('PKR');
  expect(uiRequests).toContain('GET /api/users');
  expect(uiRequests).toContain('GET /api/contracts');
  expect(uiRequests).toContain('GET /api/transactions');
});

test('receivable and payable preserve amounts, filters, and zero-balance exclusion', async ({ page }) => {
  await home(page, 'receivable');
  await page.getByRole('searchbox', { name: 'Search users or contracts', exact: true }).fill(prefix);
  await expect(accountCard(page, receivable.user_name)).toContainText('PKR 500');
  await expect(accountCard(page, contract.name)).toContainText('PKR 1,650');
  await expect(accountCard(page, zero.user_name)).toHaveCount(0);
  await expect(accountCard(page, payable.user_name)).toHaveCount(0);
  await page.getByLabel('Receivable type').selectOption('contract');
  await expect(accountCard(page, contract.name)).toBeVisible();
  await expect(accountCard(page, receivable.user_name)).toHaveCount(0);
  await page.getByRole('button', { name: '← Back to Home', exact: true }).click();
  await page.locator('[data-home-card="payable"]').getByRole('button').click();
  await page.getByRole('searchbox', { name: 'Search users or contracts', exact: true }).fill(prefix);
  await expect(accountCard(page, payable.user_name)).toContainText('PKR 550');
  await expect(accountCard(page, zero.user_name)).toHaveCount(0);
  await expect(accountCard(page, receivable.user_name)).toHaveCount(0);
  await expect(accountCard(page, payable.user_name).getByRole('button', { name: 'Pay user', exact: true })).toBeVisible();
});

test('a scoped payable statement does not stick to the Home Users Statement card', async ({ page }) => {
  await home(page, 'payable');
  await accountCard(page, payable.user_name).getByRole('button', { name: 'View statement', exact: true }).click();
  await expect(page.getByRole('heading', { name: payable.user_name, exact: true })).toBeVisible();
  await expect(page.locator('tr.ledger-entry')).toHaveCount(2);
  await page.getByRole('button', { name: '← Back to Payable', exact: true }).click();
  await page.getByRole('button', { name: '← Back to Home', exact: true }).click();
  await page.locator('[data-home-card="statement"]').getByRole('button').click();
  await expect(page.getByRole('heading', { name: 'Users Statement', exact: true })).toBeVisible();
  await page.getByLabel('Rows per page').selectOption('100');
  await expect(page.locator('tr.ledger-entry').filter({ hasText: prefix })).toHaveCount(4);
});

test('contract contributions and receiving a payment refresh the shared balance', async ({ page }) => {
  await home(page, 'contracts');
  await page.getByRole('searchbox', { name: 'Search contracts', exact: true }).fill(contract.name);
  await accountCard(page, contract.name).click();
  await expect(accountCard(page, payer.user_name)).toContainText('PKR 350 paid');
  await expect(page.getByText('PKR 1,650', { exact: true }).filter({ visible: true })).toBeVisible();
  await accountCard(page, payer.user_name).getByRole('button', { name: 'Receive payment', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount (PKR)', { exact: true }).fill('100');
  await dialog.getByLabel('Description', { exact: true }).fill(`${prefix} UI contract payment`);
  await dialog.getByRole('button', { name: 'Review payment', exact: true }).click();
  const receipt = page.waitForResponse((response) => response.url().endsWith('/api/transactions/credits') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Confirm receipt', exact: true }).click();
  expect((await receipt).status()).toBe(201);
  await expect(dialog).not.toBeVisible();
  await expect(accountCard(page, payer.user_name)).toContainText('PKR 450 paid');
  await expect(page.getByText('PKR 1,550', { exact: true }).filter({ visible: true })).toBeVisible();
  await accountCard(page, payer.user_name).getByRole('button', { name: 'View statement', exact: true }).click();
  await expect(page.locator('tr.ledger-entry')).toHaveCount(2);
  await expect(page.locator('table thead')).toContainText('Contract');
});

test('statement filters keep the head picker open and selected entries can be unselected and previewed', async ({ page }) => {
  await home(page, 'statement');
  await page.getByRole('button', { name: 'Head ▾', exact: true }).click();
  const filter = page.getByRole('dialog', { name: 'Filter · Head' });
  await filter.getByLabel('Search heads', { exact: true }).fill(rootHead);
  await filter.getByRole('button', { name: rootHead, exact: true }).click();
  await expect(filter).toBeVisible();
  await filter.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('tr.ledger-entry')).toHaveCount(2);
  await page.getByRole('button', { name: 'Select entries', exact: true }).click();
  const entries = page.locator('tr.ledger-entry input[type="checkbox"]');
  await entries.nth(0).check();
  await entries.nth(1).check();
  await expect(page.getByRole('region', { name: 'Selected entry actions' })).toContainText('2 entries selected');
  await entries.nth(0).uncheck();
  await expect(page.getByRole('region', { name: 'Selected entry actions' })).toContainText('1 entry selected');
  await page.getByRole('button', { name: 'Preview selected', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Ledger preview' });
  await expect(preview.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  const download = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
});

test('editing a transaction adds history and deactivation/reactivation keeps evidence intact', async ({ page }) => {
  await home(page, 'receivable');
  await accountCard(page, receivable.user_name).getByRole('button', { name: 'View statement', exact: true }).click();
  await page.locator('tr.ledger-entry').filter({ hasText: `${prefix} funding evidence` }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByLabel('Amount', { exact: true }).fill('625');
  await dialog.getByRole('textbox').fill(`${prefix} edited advance`);
  await dialog.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(dialog.getByText(/Edited · PKR 625/)).toBeVisible();
  await expect(dialog.getByText(/Created · PKR 600/)).toBeVisible();
  await expect(dialog.getByAltText(attachmentName).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Reactivate', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Reactivate', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Deactivate', exact: true })).toBeVisible();
  const saved = await call(api, 'GET', `/transactions/${creditId}`);
  expect(saved.active).toBe(true);
  expect(saved.amount).toBe(625);
  expect(saved.versions.map((version: { action: string }) => version.action)).toEqual(['Created', 'Edited', 'Deactivated', 'Reactivated']);
  expect(saved.attachments).toHaveLength(1);
});

test('a normal user sees only permitted heads, uploads an image, submits a bill, and receives only credits in their ledger', async ({ page }) => {
  await workerLogin(page);
  await page.getByLabel('Enter amount in PKR', { exact: true }).fill('75');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('button', { name: forbiddenHead, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: rootHead, exact: true }).click();
  await page.getByRole('button', { name: leafHead, exact: true }).click();
  await page.getByRole('button', { name: 'Make a new transaction', exact: true }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'worker-receipt.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByAltText('worker-receipt.png')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByLabel('Description (optional)', { exact: true }).fill(`${prefix} browser bill`);
  await page.getByRole('button', { name: 'Review transaction', exact: true }).click();
  const submit = page.waitForResponse((response) => response.url().endsWith('/api/transactions/bills') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send transaction', exact: true }).click();
  const result = await submit;
  expect(result.status()).toBe(201);
  expect(result.request().postDataJSON().input.attachments).toHaveLength(1);
  await expect(page.getByText('Transaction sent successfully.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Your ledger', exact: true }).click();
  const ledger = page.getByRole('region', { name: 'Your credits ledger' });
  await expect(ledger.getByRole('button').filter({ hasText: 'Credit received' })).toHaveCount(1);
  await expect(ledger).not.toContainText(`${prefix} browser bill`);
  await expect(ledger.getByRole('heading', { name: 'Edit trail' })).toHaveCount(0);
  expect(uiRequests).not.toContain('GET /api/users');
  expect(uiRequests).not.toContain('GET /api/external-users');
});

test('external credit offers searchable linked contracts and supports skipping to direct credit', async ({ page }) => {
  await home(page, 'credit');
  await page.getByRole('button', { name: 'Credit amount', exact: true }).click();
  await accountCard(page, payer.user_name).locator('button.home-card-main').click();
  await page.getByLabel('Enter amount in PKR', { exact: true }).fill('25');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose a contract', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search contracts', exact: true }).fill(contract.name);
  await expect(page.getByRole('button', { name: new RegExp(contract.name) })).toBeEnabled();
  await page.getByRole('button', { name: 'Skip · Direct credit', exact: true }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByLabel('Description (optional)', { exact: true }).fill(`${prefix} browser direct credit`);
  await page.getByRole('button', { name: 'Review transaction', exact: true }).click();
  await expect(page.getByText('Direct credit', { exact: true })).toBeVisible();
  const submit = page.waitForResponse((response) => response.url().endsWith('/api/transactions/credits') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Record credit', exact: true }).click();
  const result = await submit;
  expect(result.status()).toBe(201);
  expect(result.request().postDataJSON().creditUserId).toBe(payer.credit_user_id);
  expect(result.request().postDataJSON().contractId).toBeUndefined();
  await expect(page.locator('[data-home-card="contracts"]')).toBeVisible();
});

test('attachments retain head-wise default, selection, preview and PDF downloads', async ({ page }) => {
  await home(page, 'attachments');
  await page.getByLabel('Search attachment users', { exact: true }).fill(receivable.user_name);
  await accountCard(page, receivable.user_name).locator('button.home-card-main').click();
  await expect(page.getByLabel('Arrangement')).toHaveValue('by-head');
  await expect(page.getByLabel('Rows per page')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Open ${attachmentName}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select entries', exact: true }).click();
  const selected = page.getByRole('checkbox', { name: `Select entry ${creditId}`, exact: true });
  await selected.check();
  await page.getByRole('button', { name: 'Preview selected', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Attachment pages' });
  await expect(preview).toBeVisible();
  const download = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Download PDF', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
});

test('Home card arrangement saves through preferences and survives reload', async ({ page }) => {
  await page.goto('/Admin');
  await expect(page.locator('[data-home-card]')).toHaveCount(12);
  await page.getByRole('button', { name: 'Rearrange', exact: true }).click();
  await page.locator('[data-home-card="contracts"]').getByRole('button').click();
  await page.locator('[data-home-card="payable"]').getByRole('button').click();
  const save = page.waitForResponse((response) => response.url().endsWith('/api/preferences/home-order') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect((await save).status()).toBe(200);
  const order = await page.locator('[data-home-card]').evaluateAll((items) => items.map((item) => item.getAttribute('data-home-card')));
  await page.reload();
  await expect(page.locator('[data-home-card]')).toHaveCount(12);
  expect(await page.locator('[data-home-card]').evaluateAll((items) => items.map((item) => item.getAttribute('data-home-card')))).toEqual(order);
});

test('a saved user survives a failed refresh and reconnect never submits the create form twice', async ({ page }) => {
  await home(page, 'users');
  const name = `${prefix} recovery`;
  let failReads = false;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/users' && response.request().method() === 'POST' && response.status() === 201) failReads = true;
  });
  await page.route('**/api/users', async (route) => {
    if (route.request().method() === 'GET' && failReads) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Temporary connection problem.' }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '+ Create user', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Create user', exact: true });
  await editor.getByLabel('Name', { exact: true }).fill(name);
  await editor.getByLabel('New password', { exact: true }).fill(userPassword);
  await editor.getByLabel('Confirm new password', { exact: true }).fill(userPassword);
  await editor.getByRole('button', { name: 'Create user', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your change was saved');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
  await page.unroute('**/api/users');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.locator('[data-home-card]')).toHaveCount(12);
  expect(uiRequests.filter((request) => request === 'POST /api/users')).toHaveLength(1);
  const users = await call(api, 'GET', '/users');
  expect(users.filter((user: FixtureUser) => user.user_name === name)).toHaveLength(1);
});

test('a saved external user leaves the create form before a failed refresh and cannot be submitted twice', async ({ page }) => {
  await home(page, 'credit');
  await page.getByRole('button', { name: 'New external user', exact: true }).click();
  const name = `${prefix} ext recovery`;
  let failReads = false;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/external-users' && response.request().method() === 'POST' && response.status() === 201) failReads = true;
  });
  await page.route('**/api/users', async (route) => {
    if (route.request().method() === 'GET' && failReads) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Temporary connection problem.' }) });
    } else await route.continue();
  });
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save external user', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('external user was saved');
  await expect(page.getByRole('button', { name: 'Save external user', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New external user', exact: true })).toBeVisible();
  await page.unroute('**/api/users');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Credit amount', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Credit amount', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search external users', exact: true }).fill(name);
  await expect(accountCard(page, name)).toBeVisible();
  expect(uiRequests.filter((request) => request === 'POST /api/external-users')).toHaveLength(1);
});

test('Home Admin debit records a bill on behalf of a user while User debit card remains a direct payment', async ({ page }) => {
  const session = await call(api, 'GET', '/session');
  const administrator = await call(api, 'GET', `/users/${session.userId}`);
  const target = await call(api, 'POST', '/users', { profile: {
    user_name: `Credit target ${Date.now()}`, contacts: [],
  }, password: userPassword }, 201);
  const inactive = await call(api, 'POST', '/users', { profile: {
    user_name: `Inactive target ${Date.now()}`, contacts: [],
  }, password: userPassword }, 201);
  await call(api, 'PUT', `/users/${inactive.user_id}/status`, { active: false });
  const tree = await call(api, 'GET', '/heads');
  const root = tree.heads.find((head: { head_name: string }) => head.head_name === rootHead);
  const leaf = tree.heads.find((head: { head_name: string }) => head.head_name === leafHead);
  await call(api, 'PUT', `/users/${target.user_id}/permissions`, { ids: [root.head_id] });

  await home(page, 'debit');
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill(target.user_name);
  await accountCard(page, target.user_name).locator('button.home-card-main').click();
  await page.getByLabel('Enter amount in PKR', { exact: true }).fill('200');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Images', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  const paymentDescription = `Payment for ${target.user_name}`;
  await page.getByLabel('Description (optional)', { exact: true }).fill(paymentDescription);
  await page.getByRole('button', { name: 'Review transaction', exact: true }).click();
  const paid = page.waitForResponse((response) => response.url().endsWith('/api/transactions/credits') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send transaction', exact: true }).click();
  const payment = await (await paid).json();
  expect(payment.headId).toBeNull();
  expect(payment.createdBy).toBe(session.userId);
  await expect(page.locator('[data-home-card="user-credit"]')).toBeVisible();

  await home(page, 'user-credit');
  await expect(page.getByRole('heading', { name: 'Admin debit', exact: true })).toBeVisible();
  await expect(accountCard(page, inactive.user_name)).toHaveCount(0);
  await expect(accountCard(page, administrator.user_name)).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill(target.user_name);
  await accountCard(page, target.user_name).locator('button.home-card-main').click();
  await expect(page.getByRole('heading', { name: 'Remaining balance', exact: true })).toBeVisible();
  await page.getByLabel('Enter amount in PKR', { exact: true }).fill('125');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('button', { name: forbiddenHead, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close transaction workflow', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Discard this transaction draft?', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await page.getByRole('button', { name: rootHead, exact: true }).click();
  await page.getByRole('button', { name: leafHead, exact: true }).click();
  await page.getByRole('button', { name: 'Make a new transaction', exact: true }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'admin-user-credit.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByAltText('admin-user-credit.png')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  const billDescription = `Bill for ${target.user_name}`;
  await page.getByLabel('Description (optional)', { exact: true }).fill(billDescription);
  await page.getByRole('button', { name: 'Review transaction', exact: true }).click();
  await expect(page.getByText(target.user_name, { exact: true }).filter({ visible: true })).toBeVisible();
  const posted = page.waitForResponse((response) => response.url().endsWith(`/api/users/${target.user_id}/bills`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Record user credit', exact: true }).click();
  const recorded = await posted;
  expect(recorded.status()).toBe(201);
  const bill = await recorded.json();
  expect(bill.headId).toBe(leaf.head_id);
  expect(bill.createdBy).toBe(target.user_id);
  expect(bill.attachments).toHaveLength(1);
  expect(bill.versions[0].editorId).toBe(session.userId);
  expect(bill.versions[0].action).toBe('Recorded by admin');
  await expect(page.locator('[data-home-card="user-credit"]')).toBeVisible();
  expect(await call(api, 'GET', '/session')).toEqual(session);
  expect(uiRequests.filter((item) => item === 'POST /api/session')).toEqual([]);
  expect(await call(api, 'GET', `/users/${target.user_id}/overview`)).toMatchObject({
    totalReceived: 200, totalBillPayment: 125, balance: 75,
  });

  await home(page, 'receivable');
  await accountCard(page, target.user_name).getByRole('button', { name: 'View statement', exact: true }).click();
  const row = page.locator('tr.ledger-entry').filter({ hasText: billDescription });
  await expect(row.locator('td').nth(2)).toHaveText(target.user_name);
  await row.click();
  await expect(page.getByRole('dialog').getByText(/Recorded by admin · PKR 125/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await home(page, 'company');
  await page.getByLabel('Rows per page').selectOption('100');
  await expect(page.locator('tr.ledger-entry').filter({ hasText: billDescription })).toHaveCount(0);
  await expect(page.locator('tr.ledger-entry').filter({ hasText: paymentDescription })).toBeVisible();
});

test('Admin payable is separate, direct, toggleable, and payable from its cards and User debit', async ({ page }) => {
  const target = await call(api, 'POST', '/users', { profile: {
    user_name: `Personal ${Date.now()}`, contacts: [],
  }, password: userPassword }, 201);
  const session = await call(api, 'GET', '/session');
  const companyBefore = await call(api, 'GET', `/users/${session.userId}/overview`);
  const url = `/api/users/${target.user_id}/admin-payable`;
  async function finish(amount: string, description: string, action: string, image = false) {
    await page.getByLabel('Enter amount in PKR', { exact: true }).fill(amount);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Images', exact: true })).toBeVisible();
    if (image) {
      await page.locator('input[type="file"]').first().setInputFiles({ name: 'personal.png', mimeType: 'image/png', buffer: png });
      await expect(page.getByAltText('personal.png')).toBeVisible();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    } else await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.getByLabel('Description (optional)', { exact: true }).fill(description);
    await page.getByRole('button', { name: 'Review transaction', exact: true }).click();
    await expect(page.locator('.review-details')).not.toContainText('Head');
    const saved = page.waitForResponse((response) => response.url().endsWith(action === 'Add Admin payable' ? url : url+'/payments') && response.request().method() === 'POST');
    await page.getByRole('button', { name: action, exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    return response.json();
  }
  await home(page, 'admin-payable');
  await page.getByRole('button', { name: 'Add Admin payable', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill(target.user_name);
  await accountCard(page, target.user_name).locator('button.home-card-main').click();
  const description = `Personal obligation ${target.user_name}`;
  const added = await finish('1000', description, 'Add Admin payable', true);
  expect(added.transactionTypeId).toBe(2);
  expect(added.headId).toBeNull();
  await expect(accountCard(page, target.user_name)).toContainText('PKR 1,000');
  expect((await call(api, 'GET', `/users/${session.userId}/overview`)).balance).toBe(companyBefore.balance);
  await accountCard(page, target.user_name).getByRole('button', { name: 'Pay Admin payable', exact: true }).click();
  await page.getByLabel('Enter amount in PKR', { exact: true }).fill('1001');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  const paymentNote = `Personal payment ${target.user_name}`;
  const payment = await finish('400', paymentNote, 'Record Admin payable payment');
  expect(payment.transactionTypeId).toBe(3);
  await expect(accountCard(page, target.user_name)).toContainText('PKR 600');
  expect((await call(api, 'GET', `/users/${session.userId}/overview`)).balance).toBe(companyBefore.balance-400);
  await accountCard(page, target.user_name).getByRole('button', { name: 'View statement', exact: true }).click();
  await expect(page.locator('tr.ledger-entry')).toHaveCount(2);
  await expect(page.locator('tr.ledger-entry').filter({ hasText: description })).toContainText('Admin payable added');
  await expect(page.locator('tr.ledger-entry').filter({ hasText: paymentNote })).toContainText('Admin payable paid');
  const toggle = page.getByRole('button', { name: 'Show Admin payable', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(page.locator('tr.ledger-entry')).toHaveCount(0);
  await toggle.click();
  await expect(page.locator('tr.ledger-entry')).toHaveCount(2);
  await toggle.click(); // Leaving this off must not hide actual cash payments in Company Statement.
  await home(page, 'company');
  await page.getByLabel('Rows per page').selectOption('100');
  await expect(page.locator('tr.ledger-entry').filter({ hasText: description })).toHaveCount(0);
  await expect(page.locator('tr.ledger-entry').filter({ hasText: paymentNote })).toHaveCount(1);
  await home(page, 'payable');
  await expect(accountCard(page, target.user_name)).toHaveCount(0);
  await home(page, 'debit');
  await page.getByRole('button', { name: 'Pay Admin payable', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill(target.user_name);
  await accountCard(page, target.user_name).locator('button.home-card-main').click();
  await finish('600', `Personal final ${target.user_name}`, 'Record Admin payable payment');
  await expect(page.locator('[data-home-card="admin-payable"]')).toBeVisible();
  await home(page, 'admin-payable');
  await expect(accountCard(page, target.user_name)).toHaveCount(0);
});

test('external receipt splits share evidence,  hide keys in print and move overpaid contracts to Payable', async ({ page }, info) => {
  const unique = `Split ${info.project.name} ${Date.now()}`;
  const source = await call(api, 'GET', `/transactions/${creditId}`);
  const admin = await call(api, 'GET', '/session');
  const external = await call(api, 'POST', '/external-users', { user_name: `${unique} payer` }, 201);
  const projectA = await call(api, 'POST', '/contracts', { name: `${unique} A`, totalAmount: 200, creditUserIds: [external.credit_user_id] }, 201);
  const projectB = await call(api, 'POST', '/contracts', { name: `${unique} B`, totalAmount: 500, creditUserIds: [external.credit_user_id] }, 201);
  const receipt = await call(api, 'POST', '/transactions/credits', { userId: admin.userId, creditUserId: external.credit_user_id,
    input: { amount: 1000, description: unique, attachments: source.attachments } }, 201);
  const unrelated = await call(api, 'POST', '/transactions/credits', { userId: admin.userId, creditUserId: external.credit_user_id, input: { amount: 77 } }, 201);
  await call(api, 'PUT', `/transactions/${unrelated.id}/status`, { expectedVersion: Number(unrelated.versions.at(-1).versionId), active: false });
  expect(receipt.receiptKey).toMatch(/^[A-Z0-9]{8}$/);
  await home(page, 'company');
  await page.getByRole('searchbox', { name: 'Search Receipt ID', exact: true }).fill(receipt.receiptKey);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('tr.ledger-entry')).toHaveCount(1);
  const inactive = page.locator('details.disclosure').filter({ has: page.locator('summary', { hasText: 'Deactivated entries' }) });
  await inactive.locator('summary').click();
  await expect(inactive.getByRole('button')).toHaveCount(0);
  await page.locator('tr.ledger-entry .ledger-row-link').click();
  let dialog = page.getByRole('dialog').filter({ visible: true }).last();
  await expect(dialog).toContainText(receipt.receiptKey);
  await expect(dialog.getByAltText(attachmentName).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByLabel('Search allocation contracts', { exact: true }).fill(projectA.name);
  await dialog.getByLabel('Allocate to', { exact: true }).selectOption(projectA.id);
  await dialog.getByRole('button', { name: 'Add allocation', exact: true }).click();
  await dialog.getByLabel('Allocation amount 1', { exact: true }).fill('300');
  await dialog.getByLabel('Search allocation contracts', { exact: true }).fill(projectB.name);
  await dialog.getByLabel('Allocate to', { exact: true }).selectOption(projectB.id);
  await dialog.getByRole('button', { name: 'Add allocation', exact: true }).click();
  await dialog.getByLabel('Allocation amount 2', { exact: true }).fill('200');
  await dialog.getByLabel('Allocate to', { exact: true }).selectOption('__profit__');
  await dialog.getByRole('button', { name: 'Add allocation', exact: true }).click();
  await dialog.getByLabel('Allocation amount 3', { exact: true }).fill('250');
  await expect(dialog.getByRole('status')).toContainText('Remaining direct receipt: PKR 250');
  const save = page.waitForResponse((r) => r.url().endsWith(`/api/receipts/${receipt.id}/allocations`) && r.request().method() === 'PUT');
  await dialog.getByRole('button', { name: 'Save new version', exact: true }).click();
  expect((await save).status()).toBe(200);
  await expect(dialog.getByRole('button', { name: 'Return unallocated money', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('tr.ledger-entry')).toHaveCount(4);
  await expect(page.locator('tr.ledger-entry').filter({ hasText: 'Direct receipt' })).toContainText('PKR 250');
  await expect(page.getByRole('button', { name: receipt.receiptKey, exact: true })).toHaveCount(4);
  await page.getByRole('button', { name: receipt.receiptKey, exact: true }).first().click();
  await expect(dialog).toContainText('PKR 1,000');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Preview / export', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Ledger preview' });
  const printBody = preview.locator('iframe').contentFrame().locator('body');
  await expect(printBody).toContainText('Direct receipt');
  await expect(printBody).not.toContainText(receipt.receiptKey);
  await expect(printBody).not.toContainText('Show all allocations');
  await preview.getByRole('button', { name: 'Close', exact: true }).click();
  await home(page, 'payable');
  await page.getByRole('searchbox', { name: 'Search users or contracts', exact: true }).fill(projectA.name);
  const card = accountCard(page, projectA.name);
  await expect(card).toContainText('PKR 100');
  await expect(card.getByRole('button', { name: 'Pay user', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'View contract', exact: true }).click();
  await expect(page.getByText('Overpaid · Payable', { exact: true })).toBeVisible();
  await expect(accountCard(page, external.user_name)).toContainText('PKR 300 paid');
  await page.getByRole('button', { name: 'View contract statement', exact: true }).click();
  await expect(page.locator('tr.ledger-entry')).toHaveCount(1);
  await expect(page.locator('tr.ledger-entry')).toContainText('PKR 300');
  await expect(page.getByRole('searchbox', { name: 'Search Receipt ID', exact: true })).toHaveCount(0);
  await page.locator('tr.ledger-entry .ledger-row-link').click();
  dialog = page.getByRole('dialog').filter({ visible: true }).last();
  // Editing from a contract view must still open the full1000 receipt.
  await expect(dialog).toContainText('Receipt amount');
  await expect(dialog).toContainText('PKR 1,000');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: '← Back to contract', exact: true }).click();
  await page.getByRole('button', { name: '← Back to Payable', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payable', exact: true })).toBeVisible();
  await home(page, 'receivable');
  await page.getByRole('searchbox', { name: 'Search users or contracts', exact: true }).fill(unique);
  await expect(accountCard(page, projectA.name)).toHaveCount(0);
  await expect(accountCard(page, projectB.name)).toContainText('PKR 300');
});


test('receipt portions inherit fields independently, keep custom evidence, and can restore inheritance', async ({ page }, info) => {
  const name = `Details ${info.project.name} ${Date.now()}`;
  const admin = await call(api, 'GET', '/session');
  const external = await call(api, 'POST', '/external-users', { user_name: name }, 201);
  const c = await call(api, 'POST', '/contracts', { name, totalAmount: 400, creditUserIds: [external.credit_user_id] }, 201);
  const evidence = (await call(api, 'GET', `/transactions/${creditId}`)).attachments;
  const voice = await api.post('/api/attachments', { headers: { 'X-Cashbook': '1' }, multipart: { kind: 'voice', file: { name: 'shared.ogg', mimeType: 'audio/ogg', buffer: Buffer.from('OggSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') } } });
  expect(voice.status()).toBe(200);
  const input = { amount: 1000, headId: null, description: 'Shared receipt description', attachments: [...evidence, await voice.json()] };
  const receipt = await call(api, 'POST', '/transactions/credits', { userId: admin.userId, creditUserId: external.credit_user_id, input }, 201);
  await call(api, 'PUT', `/receipts/${receipt.id}/allocations`, { expectedVersion: Number(receipt.versions.at(-1).versionId), input, allocations: [{ kind: 'contract', contractId: c.id, amount: 400 }, { kind: 'profit', amount: 600 }] });
  await home(page, 'company');
  await page.getByRole('searchbox', { name: 'Search Receipt ID', exact: true }).fill(receipt.receiptKey);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  const rows = page.locator('tr.ledger-entry');
  const profit = rows.filter({ hasText: 'Company profit' });
  const contractRow = rows.filter({ hasNotText: 'Company profit' });
  await expect(rows).toHaveCount(2);
  await profit.locator('.ledger-row-link').click();
  const dialog = page.getByRole('dialog').filter({ visible: true }).last();
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = dialog.getByRole('region', { name: 'Portion details editor' });
  await expect(editor.getByLabel('Portion description', { exact: true })).toHaveValue('Shared receipt description');
  await editor.getByLabel('Portion description', { exact: true }).fill('Profit explanation');
  await editor.getByRole('button', { name: `Remove ${attachmentName}`, exact: true }).click();
  await editor.locator('input[type=file]').first().setInputFiles({ name: 'profit.png', mimeType: 'image/png', buffer: png });
  await expect(editor.getByAltText('profit.png')).toBeVisible();
  await editor.getByRole('button', { name: 'Remove shared.ogg', exact: true }).click();
  await editor.locator('input[type=file]').last().setInputFiles({ name: 'profit.ogg', mimeType: 'audio/ogg', buffer: Buffer.from('OggSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') });
  await expect(editor.getByText('profit.ogg', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(profit).toContainText('Profit explanation');
  await expect(contractRow).toContainText('Shared receipt description');
  await page.getByRole('button', { name: receipt.receiptKey, exact: true }).first().click();
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByLabel('Description', { exact: true }).fill('Updated receipt description');
  await dialog.getByRole('button', { name: `Remove ${attachmentName}`, exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove shared.ogg', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(contractRow).toContainText('Updated receipt description');
  await expect(profit).toContainText('Profit explanation');
  await profit.locator('.ledger-row-link').click();
  await expect(dialog.getByAltText('profit.png').first()).toBeVisible();
  await expect(dialog.getByText('profit.ogg', { exact: true }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  for (const label of ['Use receipt description', 'Use receipt images', 'Use receipt voice notes']) await editor.getByRole('button', { name: label, exact: true }).click();
  await expect(editor.getByLabel('Portion description', { exact: true })).toHaveValue('Updated receipt description');
  await dialog.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(profit).toContainText('Updated receipt description');
  const saved = await call(api, 'GET', `/transactions/${receipt.id}`);
  expect(saved.attachments).toEqual([]);
  expect(saved.portionDetails).toEqual({});
  expect(saved.versions.some((v: { portionDetails?: Record<string, { description?: string }> }) => v.portionDetails?.profit?.description === 'Profit explanation')).toBe(true);
});
