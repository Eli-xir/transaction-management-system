import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCashbookApi, SavedChangeError } from '../src/data/cashbookClient.ts';
import { ApiError } from '../src/data/apiRequest.ts';
import type { AppSession, Transaction, TransactionInput, UserAction } from '../src/pages/Admin/types.ts';

const adminId = '00000000-0000-0000-0000-000000000001';
const workerId = '00000000-0000-0000-0000-000000000002';
const payerId = '00000000-0000-0000-0000-000000000003';
const contractId = '00000000-0000-0000-0000-000000000004';
const worker = { user_id: workerId, user_name: 'Worker', role: 'user', contacts: ['03001234567'], description: 'Worker profile', is_active: true, is_pinned: false };
const admin = { ...worker, user_id: adminId, user_name: 'Admin', role: 'admin', contacts: [] };
const payer = { credit_user_id: payerId, user_name: 'Payer', contacts: [], description: '', is_active: true, is_pinned: false };
const heads = [{ head_id: 7, parent_head_id: null, head_name: 'Project', is_active: true, is_transactionable: true }];
const contractInput = { name: 'Contract', description: 'Build', totalAmount: 1000, creditUserIds: [payerId] };
const contract = { ...contractInput, id: contractId, isActive: true, revision: 4 };
const profile = { user_name: 'Edited Worker', contacts: ['03001111111'], description: 'Updated profile' };
const input: TransactionInput = { amount: 125.5, headId: 7, description: 'Bill details', attachments: [] };
const transaction: Transaction = {
  ...input, id: '12', userId: workerId, createdBy: adminId, active: true, createdAt: '2026-10-30T10:00:00Z',
  creditUserId: null, contractId: null, headPath: 'Project',
  versions: [{ ...input, active: true, versionId: '28', recordedAt: '2026-10-30T10:00:00Z', editorId: adminId, action: 'Created' }],
};
const homeOrder = ['attachments', 'users', 'company', 'statement', 'heads', 'credit', 'debit', 'receivable', 'payable', 'contracts'];
const overview = { balance: 100, totalReceived: 350, totalBillPayment: 250, remainingPayable: -100, credits: [transaction] };

type Call = { path: string; method: string; body: unknown; options: RequestInit; snapshotToken?: string; snapshot?: { token?: string } };
type Overrides = {
  session?: AppSession | null;
  transactions?: Transaction[];
  fail?: (call: Call) => Error | undefined;
  respond?: (call: Call) => unknown;
  onSavedRefreshFailure?: (error: Error) => void;
};

function harness(overrides: Overrides = {}) {
  const calls: Call[] = [];
  const entries = overrides.transactions ?? [transaction];
  let revision = 9;
  const session = Object.hasOwn(overrides, 'session') ? overrides.session : { userId: adminId, role: 'admin' };
  async function request<T>(path: string, options: RequestInit = {}, snapshot?: { token?: string }): Promise<T> {
    const method = options.method ?? 'GET';
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    const call = { path, method, body, options, snapshotToken: snapshot?.token, snapshot };
    calls.push(call);
    const failure = overrides.fail?.(call);
    if (failure) throw failure;
    if (snapshot && !snapshot.token) snapshot.token = 'consistent-resource-snapshot';
    const custom = overrides.respond?.(call);
    if (custom !== undefined) return custom as T;
    const url = new URL(path, 'https://cashbook.test');
    if (method === 'GET') {
      if (path === '/session') return structuredClone(session) as T;
      if (path === '/heads') return { heads: structuredClone(heads), revision } as T;
      if (path === '/users') return structuredClone([admin, worker]) as T;
      if (path === `/users/${workerId}`) return structuredClone({ ...worker, contacts: [] }) as T;
      if (path === '/permissions') return { permissions: { [workerId]: [7, -8] } } as T;
      if (path === `/users/${workerId}/permissions`) return { userId: workerId, ids: [7] } as T;
      if (path === `/users/${workerId}/overview`) return structuredClone(overview) as T;
      if (path === '/external-users') return structuredClone([payer]) as T;
      if (path === '/contracts') return structuredClone([contract]) as T;
      if (path === '/preferences/home-order') return { homeOrder: [...homeOrder] } as T;
      if (path === '/transaction-types') return [{ id: 1, name: 'General' }] as T;
      if (url.pathname === '/transactions') {
        const limit = Number(url.searchParams.get('limit'));
        const offset = Number(url.searchParams.get('offset'));
        assert.ok(limit >= 1 && limit <= 500, 'Every ledger page must use a bounded page size');
        return {
          items: structuredClone(entries.slice(offset, offset + limit)), limit, offset,
          nextOffset: offset + limit < entries.length ? offset + limit : null,
        } as T;
      }
    } else {
      if (path === '/session') return (method === 'DELETE' ? { applied: true } : { userId: adminId, role: 'admin' }) as T;
      if (method === 'DELETE' || path.endsWith('/password')) return undefined as T;
      if (path === '/heads/batch') { revision += 1; return { heads: structuredClone(heads), revision } as T; }
      if (path.endsWith('/permissions')) return { userId: workerId, ids: [7, -8] } as T;
      if (path === '/users' || path.startsWith('/users/')) return structuredClone(worker) as T;
      if (path === '/external-users' || path.startsWith('/external-users/')) return structuredClone(payer) as T;
      if (url.pathname === '/contracts' || url.pathname.startsWith('/contracts/')) return structuredClone(contract) as T;
      if (path === '/preferences/home-order') return { homeOrder: body.ids } as T;
      if (path === '/transactions/bills') return { id: '12', applied: true } as T;
      if (path.startsWith('/transactions/')) return structuredClone(transaction) as T;
      if (path === '/attachments') return { id: '5', kind: body.get('kind'), name: body.get('file').name, url: '/api/attachments/5' } as T;
      if (path === '/attachments/export') return { '5': 'data:image/png;base64,aW1hZ2U=' } as T;
    }
    assert.fail(`Unexpected API request: ${method} ${path}`);
  }
  return { api: createCashbookApi(request, overrides.onSavedRefreshFailure), calls };
}

function writes(calls: Call[]) {
  return calls.filter((call) => call.method !== 'GET');
}

function assertWrite(call: Call, method: string, path: string, body?: unknown) {
  assert.equal(call.method, method);
  assert.equal(call.path, path);
  assert.deepEqual(call.body, body);
  if (body && !(body instanceof FormData)) {
    assert.ok(!Object.hasOwn(body, 'op'), 'Resource requests must not use legacy command envelopes');
    assert.ok(!Object.hasOwn(body, 'action'), 'The resource method/path determines the action');
  }
}

test('admin refresh assembles the existing application data shape from resources', async () => {
  const { api, calls } = harness();
  const saved = await api.refresh();
  assert.deepEqual(saved, {
    heads, users: [admin, worker], permissions: { [workerId]: [7, -8] }, creditUsers: [payer], contracts: [contract],
    homeOrder, transactions: [transaction], transactionTypes: [{ id: 1, name: 'General' }], headRevision: 9,
  });
  assert.equal(calls[0].path, '/session');
  assert.ok(calls.some((call) => call.path === '/heads'));
  for (const path of ['/users', '/permissions', '/external-users', '/contracts', '/preferences/home-order', '/transaction-types']) {
    assert.ok(calls.some((call) => call.path === path), `${path} must participate in the app refresh`);
  }
  assert.ok(calls.every((call) => !/^\/(state|changes)(\?|$)/.test(call.path)), 'The migrated frontend must not use legacy data endpoints');
});

test('regular refresh only requests its own permitted resources and never administrator data', async () => {
  const { api, calls } = harness({ session: { userId: workerId, role: 'user' } });
  const saved = await api.refresh();
  assert.deepEqual(saved.users, [{ ...worker, contacts: [] }]);
  assert.deepEqual(saved.permissions, { [workerId]: [7] });
  assert.deepEqual(saved.transactions, []);
  assert.deepEqual(saved.creditUsers, []);
  assert.deepEqual(saved.contracts, []);
  for (const path of ['/users', '/external-users', '/contracts', '/permissions', '/preferences/home-order']) {
    assert.ok(!calls.some((call) => call.path === path), `${path} would expose an administrator-only resource`);
  }
  assert.ok(!calls.some((call) => call.path.startsWith('/transactions?')));
});

test('ledger loads all pages so totals, filtering, statements and exports never stop at 500 entries', async () => {
  const entries = Array.from({ length: 1003 }, (_, index) => ({ ...transaction, id: String(index + 1), amount: index + 1 }));
  const { api, calls } = harness({ transactions: entries });
  const saved = await api.ledger();
  assert.equal(saved.transactions.length, 1003);
  assert.equal(saved.transactions.at(-1)?.id, '1003');
  assert.equal(saved.transactions.reduce((total, entry) => total + entry.amount, 0), 1003 * 1004 / 2);
  const pages = calls.filter((call) => call.path.startsWith('/transactions?'));
  assert.deepEqual(pages.map((call) => Number(new URL(call.path, 'https://cashbook.test').searchParams.get('offset'))), [0, 500, 1000]);
});

test('empty ledger page returns an empty complete list', async () => {
  const { api } = harness({ transactions: [] });
  assert.deepEqual((await api.ledger()).transactions, []);
});

test('failed resource reads reject the whole refresh instead of publishing partial balances', async () => {
  const failure = new Error('Contracts are unavailable');
  const { api } = harness({ fail: (call) => call.path === '/contracts' ? failure : undefined });
  await assert.rejects(api.refresh(), (error) => error === failure);
});

test('resource reads and all ledger pages share one snapshot captured before parallel loading', async () => {
  const entries = Array.from({ length: 501 }, (_, index) => ({ ...transaction, id: String(index + 1) }));
  const { api, calls } = harness({ transactions: entries });
  await api.refresh();
  const reads = calls.filter((call) => call.path !== '/session');
  assert.equal(reads[0].path, '/heads', 'Capture the initial snapshot before starting related reads');
  assert.equal(reads[0].snapshotToken, undefined);
  assert.ok(reads[0].snapshot);
  for (const call of reads.slice(1)) {
    assert.equal(call.snapshotToken, 'consistent-resource-snapshot');
    assert.equal(call.snapshot, reads[0].snapshot, 'Every resource/page must use the same read snapshot context');
  }
});

test('changed resource snapshots retry the entire read with a fresh context', async () => {
  let failed = false;
  const { api, calls } = harness({ fail: (call) => {
    if (!failed && call.path.startsWith('/transactions?')) {
      failed = true;
      return new ApiError('Data changed while loading. Refresh and try again.', 409, true);
    }
  } });
  assert.deepEqual((await api.refresh()).transactions, [transaction]);
  const beginnings = calls.filter((call) => call.path === '/heads');
  assert.equal(beginnings.length, 2);
  assert.notEqual(beginnings[0].snapshot, beginnings[1].snapshot);
  assert.ok(beginnings.every((call) => call.snapshotToken === undefined));
  assert.equal(writes(calls).length, 0);
});

test('continuously changing data stops after three snapshot read attempts', async () => {
  const { api, calls } = harness({ fail: (call) => call.path === '/heads' ? new ApiError('Data changed', 409, true) : undefined });
  await assert.rejects(api.refresh(), /Data changed/);
  assert.equal(calls.filter((call) => call.path === '/heads').length, 3);
  assert.equal(writes(calls).length, 0);
});

test('ordinary conflict errors do not trigger snapshot retries', async () => {
  const { api, calls } = harness({ fail: (call) => call.path === '/contracts' ? new ApiError('Contract conflict', 409) : undefined });
  await assert.rejects(api.refresh(), /Contract conflict/);
  assert.equal(calls.filter((call) => call.path === '/heads').length, 1);
});

test('a failed later ledger page cannot return the first page as a complete report', async () => {
  const entries = Array.from({ length: 501 }, (_, index) => ({ ...transaction, id: String(index + 1) }));
  const { api } = harness({ transactions: entries, fail: (call) => call.path.includes('offset=500') ? new Error('Connection interrupted') : undefined });
  await assert.rejects(api.ledger(), /Connection interrupted/);
});

test('session checks use the existing session endpoint', async () => {
  const { api, calls } = harness();
  assert.deepEqual(await api.currentSession(), { userId: adminId, role: 'admin' });
  assert.deepEqual(calls.map(({ method, path }) => ({ method, path })), [{ method: 'GET', path: '/session' }]);
});

test('login sends credentials only to the session endpoint', async () => {
  const { api, calls } = harness();
  await api.signIn('Ali', 'private password');
  assertWrite(writes(calls)[0], 'POST', '/session', { username: 'Ali', password: 'private password' });
  assert.equal(calls.length, 1);
});

test('logout revokes the existing session without replaying the request', async () => {
  const { api, calls } = harness();
  await api.signOut();
  assertWrite(writes(calls)[0], 'DELETE', '/session');
  assert.equal(calls.length, 1);
});

test('head batches retain the loaded revision and all staged operations atomically', async () => {
  const { api, calls } = harness();
  await api.refresh();
  const changes = [{ op: 'create' as const, temp_id: -1, parent_head_id: 7, head_name: 'New head' },
    { op: 'move' as const, head_id: -1, new_parent_id: null }, { op: 'backup' as const, head_id: 7 }];
  await api.saveHeads(changes);
  assertWrite(writes(calls)[0], 'POST', '/heads/batch', { revision: 9, changes });
});

test('background ledger reads do not advance the revision of an existing head draft', async () => {
  let revision = 9;
  const { api, calls } = harness({ respond: (call) => call.path === '/heads' ? { heads, revision } : undefined });
  await api.refresh();
  revision = 10;
  await api.ledger();
  await api.saveHeads([{ op: 'delete', head_id: 7 }]);
  assert.equal((writes(calls)[0].body as { revision: number }).revision, 9,
    'Using revision 10 here could apply an old draft over an unseen tree change');
});

test('successful head saves update the revision used by the next draft', async () => {
  const { api, calls } = harness();
  await api.refresh();
  await api.saveHeads([{ op: 'backup', head_id: 7 }]);
  await api.saveHeads([{ op: 'active', head_id: 7, is_active: false }]);
  assert.deepEqual(writes(calls).map((call) => (call.body as { revision: number }).revision), [9, 10]);
});

test('permission updates preserve negative denial rules and refresh the app data', async () => {
  const { api, calls } = harness();
  const saved = await api.savePermissions(workerId, [7, -8]);
  assertWrite(writes(calls)[0], 'PUT', `/users/${workerId}/permissions`, { ids: [7, -8] });
  assert.deepEqual(saved.permissions[workerId], [7, -8]);
});

test('profile updates put the profile on its resource and retain the State return shape', async () => {
  const { api, calls } = harness();
  const saved = await api.saveProfile(workerId, profile);
  assertWrite(writes(calls)[0], 'PUT', `/users/${workerId}/profile`, profile);
  assert.ok(saved.users.some((user) => user.user_id === workerId));
});

test('user creation separates the initial password from profile and returns created user plus refreshed data', async () => {
  const { api, calls } = harness();
  const saved = await api.createUser({ ...profile, password: 'initial password' });
  assertWrite(writes(calls)[0], 'POST', '/users', { profile, password: 'initial password' });
  assert.equal(saved.user.user_id, workerId);
  assert.ok(saved.data.users.some((user) => user.user_id === workerId));
});

test('password reset uses its dedicated endpoint and accepts a bodyless 204', async () => {
  const { api, calls } = harness();
  await api.changePassword(workerId, 'replacement password');
  assertWrite(writes(calls)[0], 'PUT', `/users/${workerId}/password`, { password: 'replacement password' });
});

for (const [action, method, suffix, body] of [
  ['deactivate', 'PUT', '/status', { active: false }],
  ['reactivate', 'PUT', '/status', { active: true }],
  ['pin', 'PUT', '/pin', { pinned: true }],
  ['unpin', 'PUT', '/pin', { pinned: false }],
  ['delete', 'DELETE', '', undefined],
] as const) {
  test(`normal user ${action} uses its resource endpoint and refreshes app data`, async () => {
    const { api, calls } = harness();
    const saved = await api.userAction(workerId, action as UserAction);
    assertWrite(writes(calls)[0], method, `/users/${workerId}${suffix}`, body);
    assert.ok(Array.isArray(saved.users));
    assert.equal(writes(calls).length, 1);
  });
}

test('external user creation sends the profile directly', async () => {
  const { api, calls } = harness();
  await api.createCreditUser(profile);
  assertWrite(writes(calls)[0], 'POST', '/external-users', profile);
});

test('external user profile editing preserves the selected payer ID', async () => {
  const { api, calls } = harness();
  await api.editCreditUser(payerId, profile);
  assertWrite(writes(calls)[0], 'PUT', `/external-users/${payerId}/profile`, profile);
});

for (const [methodName, method, suffix, body] of [
  ['deactivateCreditUser', 'PUT', '/status', { active: false }],
  ['reactivateCreditUser', 'PUT', '/status', { active: true }],
  ['deleteCreditUser', 'DELETE', '', undefined],
] as const) {
  test(`external user ${methodName} uses its specific endpoint`, async () => {
    const { api, calls } = harness();
    await api[methodName](payerId);
    assertWrite(writes(calls)[0], method, `/external-users/${payerId}${suffix}`, body);
  });
}

for (const pinned of [true, false]) {
  test(`external user pin=${pinned} retains the explicit boolean`, async () => {
    const { api, calls } = harness();
    await api.pinCreditUser(payerId, pinned);
    assertWrite(writes(calls)[0], 'PUT', `/external-users/${payerId}/pin`, { pinned });
  });
}

test('contract creation sends its shared total and payer links without a legacy envelope', async () => {
  const { api, calls } = harness();
  await api.saveContract(contractInput);
  assertWrite(writes(calls)[0], 'POST', '/contracts', contractInput);
});

test('contract edits preserve expected revision separately from editable details', async () => {
  const { api, calls } = harness();
  await api.saveContract(contractInput, contractId, 4);
  assertWrite(writes(calls)[0], 'PUT', `/contracts/${contractId}?expectedRevision=4`, contractInput);
});

for (const [action, method, suffix, body] of [
  ['archive', 'PUT', '/status', { active: false, expectedRevision: 4 }],
  ['reactivate', 'PUT', '/status', { active: true, expectedRevision: 4 }],
  ['delete', 'DELETE', '?expectedRevision=4', undefined],
] as const) {
  test(`contract ${action} carries the expected revision`, async () => {
    const { api, calls } = harness();
    await api.contractAction(contractId, 4, action);
    assertWrite(writes(calls)[0], method, `/contracts/${contractId}${suffix}`, body);
  });
}

test('home card order is saved through preferences', async () => {
  const { api, calls } = harness();
  assert.deepEqual(await api.saveHomeOrder(homeOrder), { homeOrder });
  assertWrite(writes(calls)[0], 'PUT', '/preferences/home-order', { ids: homeOrder });
});

test('user overview uses the dedicated account endpoint', async () => {
  const { api, calls } = harness();
  assert.deepEqual(await api.userOverview(workerId), overview);
  assert.equal(calls[0].path, `/users/${workerId}/overview`);
});

test('bill submission sends only transaction input; server determines the signed-in owner', async () => {
  const { api, calls } = harness();
  assert.deepEqual(await api.submitTransaction(workerId, input), { id: '12', applied: true });
  assertWrite(writes(calls)[0], 'POST', '/transactions/bills', { input });
  assert.equal(writes(calls).length, 1);
});

test('admin User debit records a bill for the selected user without changing the signed-in session', async () => {
  const bill = { ...transaction, createdBy: workerId };
  const { api, calls } = harness({ respond: (call) => call.path === `/users/${workerId}/bills` ? bill : undefined });
  assert.deepEqual(await api.recordUserBill(workerId, input), bill);
  assertWrite(writes(calls)[0], 'POST', `/users/${workerId}/bills`, { input });
  assert.equal(calls.length, 1, 'Do not log into or impersonate the selected user');
});

test('failed admin bill entries are not automatically replayed', async () => {
  const failure = new ApiError('This head is not assigned to the user.', 403);
  const { api, calls } = harness({ fail: (call) => call.path.endsWith('/bills') ? failure : undefined });
  await assert.rejects(api.recordUserBill(workerId, input), failure);
  assert.equal(writes(calls).length, 1);
});

test('normal-user credit preserves its recipient and transaction input', async () => {
  const { api, calls } = harness();
  assert.deepEqual(await api.creditUser(workerId, input), transaction);
  assertWrite(writes(calls)[0], 'POST', '/transactions/credits', { userId: workerId, input });
});

for (const [method, suffix] of [['addAdminPayable', ''], ['payAdminPayable', '/payments']] as const) {
  test(`${method} uses the dedicated personal obligation endpoint without replaying writes`, async () => {
    const { api, calls } = harness();
    await api[method](workerId, { ...input, headId: null });
    assertWrite(writes(calls)[0], 'POST', `/users/${workerId}/admin-payable${suffix}`, { input: { ...input, headId: null } });
    assert.equal(writes(calls).length, 1);
  });
}

test('external contract receipt retains payer, contract and administrator recipient', async () => {
  const { api, calls } = harness();
  await api.creditUser(adminId, input, payerId, contractId);
  assertWrite(writes(calls)[0], 'POST', '/transactions/credits', { userId: adminId, input, creditUserId: payerId, contractId });
});

test('direct external receipt does not attach an arbitrary contract', async () => {
  const { api, calls } = harness();
  await api.creditUser(adminId, input, payerId);
  assertWrite(writes(calls)[0], 'POST', '/transactions/credits', { userId: adminId, input, creditUserId: payerId });
});

test('transaction edits retain expected version and optional retrospective contract assignment', async () => {
  const { api, calls } = harness();
  await api.editTransaction('12', input, '28', contractId);
  assertWrite(writes(calls)[0], 'PUT', '/transactions/12', { input, expectedVersion: 28, contractId });
});

for (const [action, active] of [['deactivate', false], ['reactivate', true]] as const) {
  test(`transaction ${action} retains its optimistic concurrency version`, async () => {
    const { api, calls } = harness();
    assert.deepEqual(await api.transactionAction('12', action, '28'), transaction);
    assertWrite(writes(calls)[0], 'PUT', '/transactions/12/status', { active, expectedVersion: 28 });
  });
}

test('transaction deletion accepts 204 and returns null to the existing card workflow', async () => {
  const { api, calls } = harness();
  assert.equal(await api.transactionAction('12', 'delete', '28'), null);
  assertWrite(writes(calls)[0], 'DELETE', '/transactions/12?expectedVersion=28');
});

test('failed money-changing requests are surfaced exactly once and never automatically retried', async () => {
  const failure = new Error('This entry changed. Refresh and try again.');
  const { api, calls } = harness({ fail: (call) => call.method === 'POST' && call.path === '/transactions/credits' ? failure : undefined });
  await assert.rejects(api.creditUser(adminId, input, payerId, contractId), (error) => error === failure);
  assert.equal(writes(calls).length, 1);
  assert.equal(calls.length, 1);
});

test('a rejected head batch is not retried against a newer revision', async () => {
  const failure = new Error('Heads changed in another session. Refresh before applying your edits.');
  const { api, calls } = harness({ fail: (call) => call.path === '/heads/batch' ? failure : undefined });
  await api.refresh();
  await assert.rejects(api.saveHeads([{ op: 'delete', head_id: 7 }]), (error) => error === failure);
  assert.equal(writes(calls).length, 1);
});

for (const operation of ['profile', 'createUser'] as const) {
  test(`a saved ${operation} followed by refresh failure is identified as saved and cannot silently replay`, async () => {
    let changed = false;
    const callbacks: Error[] = [];
    const { api, calls } = harness({
      respond: (call) => { if (call.method !== 'GET') changed = true; },
      fail: (call) => changed && call.method === 'GET' ? new Error('Refresh unavailable') : undefined,
      onSavedRefreshFailure: (error) => callbacks.push(error),
    });
    const operationPromise = operation === 'profile'
      ? api.saveProfile(workerId, profile)
      : api.createUser({ ...profile, password: 'initial password' });
    await assert.rejects(operationPromise, (error) => {
      assert.ok(error instanceof SavedChangeError);
      assert.match(error.message, /saved/i);
      return true;
    });
    assert.equal(writes(calls).length, 1, 'Refreshing after a successful mutation must never replay that mutation');
    assert.equal(callbacks.length, 1, 'The app must leave the stale form and offer a reconnect instead of a duplicate save');
  });
}

test('attachment uploads use a stable byte copy with filename and kind preserved', async () => {
  const { api, calls } = harness();
  const bytes = new Uint8Array([255, 216, 255, 0, 123, 128]);
  const source = new File([bytes], 'faysal-slip.jpg', { type: 'image/jpeg', lastModified: 123 });
  const result = await api.uploadAttachment(source, 'image');
  const call = writes(calls)[0];
  assert.equal(call.path, '/attachments');
  assert.equal(call.method, 'POST');
  assert.ok(call.body instanceof FormData);
  assert.equal(call.body.get('kind'), 'image');
  const file = call.body.get('file') as File;
  assert.notEqual(file, source);
  assert.equal(file.name, 'faysal-slip.jpg');
  assert.equal(file.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  assert.deepEqual(result, { id: '5', kind: 'image', name: 'faysal-slip.jpg', url: '/api/attachments/5' });
});

test('unreadable attachment fails before any network request', async () => {
  const { api, calls } = harness();
  const source = new File(['receipt'], 'receipt.jpg');
  Object.defineProperty(source, 'arrayBuffer', { value: async () => { throw new DOMException('Unreadable', 'NotReadableError'); } });
  await assert.rejects(api.uploadAttachment(source, 'image'), /Could not read/);
  assert.equal(calls.length, 0);
});

test('oversized attachments retain the size validation before networking', async () => {
  const { api, calls } = harness();
  await assert.rejects(api.uploadAttachment(new File(['1234'], 'receipt.jpg'), 'image', 3), /up to 5 MB/);
  assert.equal(calls.length, 0);
});

test('image export sends numeric IDs and preserves the existing response shape', async () => {
  const { api, calls } = harness();
  assert.deepEqual(await api.attachmentImages(['5']), { '5': 'data:image/png;base64,aW1hZ2U=' });
  assertWrite(writes(calls)[0], 'POST', '/attachments/export', { ids: [5] });
});
