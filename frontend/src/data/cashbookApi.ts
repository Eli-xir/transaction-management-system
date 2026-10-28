import type { AppSession, Attachment, ReferenceType, CreateUserInput, CashbookData, StagedChange, Transaction, TransactionInput, UserAction, UserOverview, UserProfile, ContractInput } from '../pages/Admin/types';
import { prepareAttachment } from './prepareAttachment';

type State = CashbookData & { transactionTypes: ReferenceType[]; headRevision: number };
let headRevision = 0;
const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, { ...options, credentials: 'same-origin',
      headers: { 'X-Cashbook': '1', ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
  } catch (cause) {
    throw new Error(path === '/attachments'
      ? 'We couldn’t upload your file. Check your internet connection and try again.'
      : 'We couldn’t connect. Check your internet connection and try again.', { cause });
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== '/session') window.dispatchEvent(new Event('cashbook:session-expired'));
    const detail = body?.detail;
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail)
      ? detail.map((item: { msg: string }) => item.msg).join(' · ')
      : 'Something went wrong. Please try again in a moment.');
  }
  return body as T;
}

function change<T>(body: object): Promise<T> {
  return request('/changes', { method: 'POST', body: JSON.stringify(body) });
}
function remember(data: State) { headRevision = data.headRevision; return data; }

// The sole frontend/backend boundary. Components keep their existing interfaces.
export const cashbookApi = {
  saveContract: (input: ContractInput, contractId?: string, expectedRevision?: number) => change<State>({ op: 'contract', action: contractId ? 'edit' : 'create', input, contractId, expectedRevision }),
  contractAction: (contractId: string, expectedRevision: number, action: 'archive' | 'reactivate' | 'delete') => change<State>({ op: 'contract', action, contractId, expectedRevision }),
  saveHomeOrder: (ids: string[]) => change<{ homeOrder: string[] }>({ op: 'homeOrder', ids }),
  attachmentImages: (ids: string[]) => request<Record<string, string>>('/attachments/export', { method: 'POST', body: JSON.stringify({ ids: ids.map(Number) }) }),
  currentSession: () => request<AppSession | null>('/session'),
  signIn: (username: string, password: string) => request<AppSession>('/session', { method: 'POST', body: JSON.stringify({ username, password }) }),
  signOut: () => request('/session', { method: 'DELETE' }),
  refresh: async () => remember(await request<State>('/state')),
  ledger: () => request<State>('/state'),
  saveHeads: async (changes: StagedChange[]) => remember(await change<State>({ op: 'heads', revision: headRevision, changes })),
  savePermissions: (userId: string, ids: number[]) => change<State>({ op: 'permissions', userId, ids }),
  saveProfile: (userId: string, profile: UserProfile) => change<State>({ op: 'user', action: 'profile', userId, profile }),
  createUser: ({ password, ...profile }: CreateUserInput) => change<{ data: State; user: State['users'][number] }>({ op: 'user', action: 'create', profile, password }),
  createCreditUser: (profile: UserProfile) => change<State>({ op: 'creditUser', action: 'create', profile }),
  editCreditUser: (creditUserId: string, profile: UserProfile) => change<State>({ op: 'creditUser', action: 'edit', creditUserId, profile }),
  pinCreditUser: (creditUserId: string, pinned: boolean) => change<State>({ op: 'creditUser', action: 'pin', creditUserId, pinned }),
  deleteCreditUser: (creditUserId: string) => change<State>({ op: 'creditUser', action: 'delete', creditUserId }),
  deactivateCreditUser: (creditUserId: string) => change<State>({ op: 'creditUser', action: 'deactivate', creditUserId }),
  reactivateCreditUser: (creditUserId: string) => change<State>({ op: 'creditUser', action: 'reactivate', creditUserId }),
  changePassword: (userId: string, password: string) => change<State>({ op: 'user', action: 'password', userId, password }),
  userAction: (userId: string, action: UserAction) => change<State>({ op: 'user', action, userId }),
  userOverview: (userId: string) => request<UserOverview>(`/state?userId=${encodeURIComponent(userId)}`),
  submitTransaction: (userId: string, input: TransactionInput) => change<{ id: string; applied: boolean }>({ op: 'transaction', action: 'submit', userId, input }),
  creditUser: (userId: string, input: TransactionInput, creditUserId?: string, contractId?: string) => change<Transaction>({ op: 'transaction', action: 'credit', userId, creditUserId, contractId, input }),
  editTransaction: (id: string, input: TransactionInput, expectedVersion: string, contractId?: string) => change<Transaction>({ op: 'transaction', action: 'edit', id: Number(id), input, expectedVersion: Number(expectedVersion), contractId }),
  transactionAction: (id: string, action: 'deactivate' | 'reactivate' | 'delete', expectedVersion: string) => change<Transaction | null>({ op: 'transaction', action, id: Number(id), expectedVersion: Number(expectedVersion) }),
  async uploadAttachment(file: File, kind: Attachment['kind'], maxBytes = 5 * 1024 * 1024) {
    const prepared = await prepareAttachment(file, maxBytes);
    const form = new FormData(); form.append('file', prepared); form.append('kind', kind);
    return request<Attachment>('/attachments', { method: 'POST', body: form });
  },
};
