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

test('login errors stay friendly and a valid login loads every home card', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Incorrect username or password.');
  await page.getByLabel('Password', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.locator('[data-home-card]')).toHaveCount(10);
  await expect(page.locator('[data-home-card="receivable"]')).toContainText('PKR');
  expect(uiRequests).toContain('GET /api/users');
  expect(uiRequests).toContain('GET /api/contracts');
  expect(uiRequests).toContain('GET /api/transactions');
});

test('receivable and payable preserve amounts, filters, and zero-balance exclusion', async ({ page }) => {
  await home(page, 'receivable');
  await page.getByLabel('Search users or contracts').fill(prefix);
  await expect(accountCard(page, receivable.user_name)).toContainText('PKR 500');
  await expect(accountCard(page, contract.name)).toContainText('PKR 1,650');
  await expect(accountCard(page, zero.user_name)).toHaveCount(0);
  await expect(accountCard(page, payable.user_name)).toHaveCount(0);
  await page.getByLabel('Receivable type').selectOption('contract');
  await expect(accountCard(page, contract.name)).toBeVisible();
  await expect(accountCard(page, receivable.user_name)).toHaveCount(0);
  await page.getByRole('button', { name: '← Back to Home', exact: true }).click();
  await page.locator('[data-home-card="payable"]').getByRole('button').click();
  await page.getByRole('searchbox', { name: 'Search users', exact: true }).fill(prefix);
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
  await expect(page.locator('[data-home-card]')).toHaveCount(10);
  await page.getByRole('button', { name: 'Rearrange', exact: true }).click();
  await page.locator('[data-home-card="contracts"]').getByRole('button').click();
  await page.locator('[data-home-card="payable"]').getByRole('button').click();
  const save = page.waitForResponse((response) => response.url().endsWith('/api/preferences/home-order') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect((await save).status()).toBe(200);
  const order = await page.locator('[data-home-card]').evaluateAll((items) => items.map((item) => item.getAttribute('data-home-card')));
  await page.reload();
  await expect(page.locator('[data-home-card]')).toHaveCount(10);
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
  await expect(page.locator('[data-home-card]')).toHaveCount(10);
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
