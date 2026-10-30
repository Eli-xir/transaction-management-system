export interface ReadSnapshot { token?: string; }
export type ApiRequest = <T>(path: string, options?: RequestInit, snapshot?: ReadSnapshot) => Promise<T>;

export class ApiError extends Error {
  readonly status: number;
  readonly retryRead: boolean;
  constructor(message: string, status: number, retryRead = false) {
    super(message);
    this.name = 'ApiError'; this.status = status; this.retryRead = retryRead;
  }
}

// Transport only: one request, no automatic retries of potentially committed writes.
export function createRequest(base: string, fetcher: typeof fetch = fetch,
  onExpired: () => void = () => window.dispatchEvent(new Event('cashbook:session-expired'))): ApiRequest {
  return async <T>(path: string, options: RequestInit = {}, snapshot?: ReadSnapshot): Promise<T> => {
    const headers = new Headers(options.headers);
    headers.set('X-Cashbook', '1');
    if (options.body !== undefined && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    if (snapshot?.token) headers.set('X-Cashbook-Snapshot', snapshot.token);
    let response: Response;
    try {
      response = await fetcher(`${base.replace(/\/$/, '')}${path}`, { ...options, credentials: 'same-origin', headers });
    } catch (cause) {
      throw new Error(path === '/attachments'
        ? 'We couldn’t upload your file. Check your internet connection and try again.'
        : 'We couldn’t connect. Check your internet connection and try again.', { cause });
    }
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && path !== '/session') onExpired();
      const detail = body?.detail;
      throw new ApiError(typeof detail === 'string' ? detail : Array.isArray(detail)
        ? detail.map((item: { msg: string }) => item.msg).join(' · ')
        : 'Something went wrong. Please try again in a moment.', response.status,
      response.status === 409 && response.headers.get('X-Cashbook-Retry-Read') === '1');
    }
    if (snapshot) {
      const token = response.headers.get('X-Cashbook-Snapshot');
      if (!token) throw new Error('We couldn’t load a complete update. Please refresh and try again.');
      if (snapshot.token && snapshot.token !== token) throw new ApiError('The cashbook changed while loading. Please refresh.', 409, true);
      snapshot.token = token;
    }
    return body as T;
  };
}
