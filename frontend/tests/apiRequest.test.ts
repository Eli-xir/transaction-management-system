import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createRequest } from '../src/data/apiRequest.ts';
import type { ReadSnapshot } from '../src/data/apiRequest.ts';

type FetchCall = { url: string; options: RequestInit };

function transport(response: () => Response | Promise<Response>, expired = () => {}) {
  const calls: FetchCall[] = [];
  const fetcher = (async (url: string, options: RequestInit) => {
    calls.push({ url: String(url), options });
    return response();
  }) as typeof fetch;
  return { request: createRequest('/api/', fetcher, expired), calls };
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('transport uses the configured API base, same-origin cookies and mutation protection header', async () => {
  const { request, calls } = transport(() => json({ heads: [] }));
  assert.deepEqual(await request('/heads'), { heads: [] });
  assert.equal(calls[0].url, '/api/heads');
  assert.equal(calls[0].options.credentials, 'same-origin');
  const headers = new Headers(calls[0].options.headers);
  assert.equal(headers.get('X-Cashbook'), '1');
  assert.equal(headers.get('Content-Type'), null, 'Bodyless reads do not need a JSON content type');
});

test('JSON writes preserve the body/method and send the correct content type', async () => {
  const { request, calls } = transport(() => json({ id: '1' }, 201));
  const body = JSON.stringify({ input: { amount: 123.45 } });
  await request('/transactions/credits', { method: 'POST', body, headers: { 'X-Test': 'keep', 'X-Cashbook': '0' } });
  assert.equal(calls[0].options.body, body);
  assert.equal(calls[0].options.method, 'POST');
  const headers = new Headers(calls[0].options.headers);
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get('X-Cashbook'), '1');
  assert.equal(headers.get('X-Test'), 'keep');
});

test('multipart uploads leave boundary/content type generation to the browser', async () => {
  const { request, calls } = transport(() => json({ id: '5' }));
  const form = new FormData();
  form.append('file', new File(['receipt'], 'receipt.jpg'));
  form.append('kind', 'image');
  await request('/attachments', { method: 'POST', body: form });
  assert.equal(calls[0].options.body, form);
  assert.equal(new Headers(calls[0].options.headers).get('Content-Type'), null);
  assert.equal(new Headers(calls[0].options.headers).get('X-Cashbook'), '1');
});

test('204 responses return null without trying to parse an empty JSON body', async () => {
  let parsed = false;
  const response = new Response(null, { status: 204 });
  response.json = async () => { parsed = true; throw new Error('No JSON'); };
  const { request, calls } = transport(() => response);
  assert.equal(await request('/transactions/1?expectedVersion=2', { method: 'DELETE' }), null);
  assert.equal(parsed, false);
  assert.equal(calls.length, 1);
});

test('a read captures the server snapshot and sends it on every related resource request', async () => {
  const { request, calls } = transport(() => json([], 200, { 'X-Cashbook-Snapshot': '123:124:' }));
  const snapshot: ReadSnapshot = {};
  await request('/heads', {}, snapshot);
  assert.equal(snapshot.token, '123:124:');
  await request('/transactions?limit=500&offset=0', {}, snapshot);
  assert.equal(new Headers(calls[0].options.headers).get('X-Cashbook-Snapshot'), null);
  assert.equal(new Headers(calls[1].options.headers).get('X-Cashbook-Snapshot'), '123:124:');
});

test('a missing resource snapshot cannot silently produce a mixed application state', async () => {
  const { request, calls } = transport(() => json({ heads: [] }));
  await assert.rejects(request('/heads', {}, {}), /complete update/);
  assert.equal(calls.length, 1);
});

test('a changed snapshot response is a retryable read conflict and retains the original token', async () => {
  const { request, calls } = transport(() => json([], 200, { 'X-Cashbook-Snapshot': 'new-snapshot' }));
  const snapshot = { token: 'old-snapshot' };
  await assert.rejects(request('/users', {}, snapshot), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.retryRead, true);
    return true;
  });
  assert.equal(snapshot.token, 'old-snapshot');
  assert.equal(calls.length, 1, 'The transport never retries requests itself');
});

for (const [status, marker, retryRead] of [
  [409, '1', true], [409, undefined, false], [409, 'true', false], [503, '1', false], [422, '1', false],
] as const) {
  test(`HTTP ${status} with read marker ${String(marker)} has retryRead=${retryRead}`, async () => {
    const { request, calls } = transport(() => json({ detail: 'Please refresh.' }, status,
      marker === undefined ? {} : { 'X-Cashbook-Retry-Read': marker }));
    await assert.rejects(request('/heads'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.equal(error.retryRead, retryRead);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test('expired protected requests notify the app and surface a session error exactly once', async () => {
  let expired = 0;
  const { request, calls } = transport(() => json({ detail: 'Your session expired. Please log in again.' }, 401), () => { expired += 1; });
  await assert.rejects(request('/users'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.match(error.message, /session expired/);
    return true;
  });
  assert.equal(expired, 1);
  assert.equal(calls.length, 1);
});

test('incorrect login does not dispatch a session-expired event or retry credentials', async () => {
  let expired = 0;
  const { request, calls } = transport(() => json({ detail: 'Incorrect username or password.' }, 401), () => { expired += 1; });
  await assert.rejects(request('/session', { method: 'POST', body: JSON.stringify({ username: 'Ali', password: 'wrong' }) }), /Incorrect username/);
  assert.equal(expired, 0);
  assert.equal(calls.length, 1);
});

test('validation messages are readable and do not include echoed submitted values', async () => {
  const { request } = transport(() => json({ detail: [
    { loc: ['body', 'profile', 'user_name'], msg: 'Enter a user name.', input: 'private-name' },
    { loc: ['body', 'password'], msg: 'Password is required.', input: 'private-password' },
  ] }, 422));
  await assert.rejects(request('/users', { method: 'POST', body: '{}' }), (error: Error) => {
    assert.equal(error.message, 'Enter a user name. · Password is required.');
    assert.doesNotMatch(error.message, /private-name|private-password/);
    return true;
  });
});

test('dependency failures preserve the safe service message and HTTP status', async () => {
  const { request } = transport(() => json({ detail: 'The service is temporarily unavailable. Please try again in a moment.' }, 503));
  await assert.rejects(request('/contracts'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 503);
    assert.equal(error.retryRead, false);
    assert.equal(error.message, 'The service is temporarily unavailable. Please try again in a moment.');
    return true;
  });
});

test('a non-JSON server failure returns a friendly fallback without leaking an HTML traceback', async () => {
  const { request } = transport(() => new Response('<html>internal database traceback</html>', { status: 502 }));
  await assert.rejects(request('/contracts'), (error: Error) => {
    assert.equal(error.message, 'Something went wrong. Please try again in a moment.');
    assert.doesNotMatch(error.message, /database|traceback|html/);
    return true;
  });
});

for (const path of ['/attachments', '/transactions/credits']) {
  test(`${path} connection failures are friendly and never replay potentially committed writes`, async () => {
    const cause = new TypeError('internal connection details');
    const { request, calls } = transport(async () => { throw cause; });
    await assert.rejects(request(path, { method: 'POST', body: '{}' }), (error: Error) => {
      assert.match(error.message, /internet connection/);
      assert.doesNotMatch(error.message, /backend|uvicorn|internal connection details/);
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test('aborted requests preserve the failure without attempting a second write', async () => {
  const controller = new AbortController();
  controller.abort();
  const { request, calls } = transport(async () => { throw new DOMException('Aborted', 'AbortError'); });
  await assert.rejects(request('/transactions/credits', { method: 'POST', body: '{}', signal: controller.signal }), /internet connection/);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls.length, 1);
});
