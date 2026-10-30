import type { AppSession, Attachment, ReferenceType, CreateUserInput, CashbookData, StagedChange,
  Transaction, TransactionInput, UserAction, UserOverview, UserProfile, ContractInput, AdminUser, CreditUser, Contract, Head } from '../pages/Admin/types.ts';
import { ApiError } from './apiRequest.ts';
import type { ApiRequest, ReadSnapshot } from './apiRequest.ts';
import { prepareAttachment } from './prepareAttachment.ts';

export type State = CashbookData & { transactionTypes: ReferenceType[]; headRevision: number };
interface HeadResult { heads: Head[]; revision: number; }
interface TransactionPage { items: Transaction[]; nextOffset: number | null; limit: number; offset: number; }

export class SavedChangeError extends Error {
  constructor(cause: unknown) {
    super('Your change was saved, but the updated cashbook couldn’t load. Reconnect to see it. Please don’t submit it again.', { cause });
    this.name = 'SavedChangeError';
  }
}

// Components retain their existing data interfaces while every call uses a resource API.
export function createCashbookApi(request: ApiRequest, onSavedRefreshFailure?: (error: Error) => void) {
  let headRevision = 0;
  const write = <T>(path: string, method: string, body?: unknown) => request<T>(path,
    { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const idPath = (id: string) => encodeURIComponent(id);

  async function transactions(snapshot: ReadSnapshot): Promise<Transaction[]> {
    const all: Transaction[] = [];
    let offset = 0;
    const seen = new Set<string>();
    for (;;) {
      const page = await request<TransactionPage>(`/transactions?limit=500&offset=${offset}`, {}, snapshot);
      for (const entry of page.items) {
        if (seen.has(entry.id)) throw new Error('The ledger changed while loading. Please refresh and try again.');
        seen.add(entry.id); all.push(entry);
      }
      if (page.nextOffset === null) return all;
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('We couldn’t load the full ledger. Please refresh and try again.');
      offset = page.nextOffset;
    }
  }

  async function loadState(): Promise<State> {
    for (let attempt = 0; ; attempt++) {
      try {
        const session = await request<AppSession | null>('/session');
        if (!session) throw new ApiError('Your session expired. Please log in again.', 401);
        const snapshot: ReadSnapshot = {};
        // Establish the read token before issuing parallel requests or ledger pages.
        const tree = await request<HeadResult>('/heads', {}, snapshot);
        if (session.role !== 'admin') {
          const [user, rules, types] = await Promise.all([
            request<AdminUser>(`/users/${idPath(session.userId)}`, {}, snapshot),
            request<{ userId: string; ids: number[] }>(`/users/${idPath(session.userId)}/permissions`, {}, snapshot),
            request<ReferenceType[]>('/transaction-types', {}, snapshot),
          ]);
          return { heads: tree.heads, headRevision: tree.revision, users: [user],
            permissions: { [session.userId]: rules.ids }, creditUsers: [], transactions: [], contracts: [],
            homeOrder: [], transactionTypes: types };
        }
        // Await every request before retrying a changed snapshot; discard partial reads.
        const results = await Promise.allSettled([
          request<AdminUser[]>('/users', {}, snapshot),
          request<{ permissions: State['permissions'] }>('/permissions', {}, snapshot),
          request<CreditUser[]>('/external-users', {}, snapshot),
          request<Contract[]>('/contracts', {}, snapshot),
          request<{ homeOrder: string[] }>('/preferences/home-order', {}, snapshot),
          request<ReferenceType[]>('/transaction-types', {}, snapshot), transactions(snapshot),
        ] as const);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        const [users, permissions, creditUsers, contracts, order, transactionTypes, entries] = results.map(
          (result) => { if (result.status === 'rejected') throw result.reason; return result.value; }) as
          [AdminUser[], { permissions: State['permissions'] }, CreditUser[], Contract[], { homeOrder: string[] }, ReferenceType[], Transaction[]];
        return { heads: tree.heads, headRevision: tree.revision, users, permissions: permissions.permissions,
          creditUsers, contracts, homeOrder: order.homeOrder, transactionTypes, transactions: entries };
      } catch (error) {
        if (error instanceof ApiError && error.retryRead && attempt < 2) continue;
        throw error;
      }
    }
  }

  async function refresh() { const data = await loadState(); headRevision = data.headRevision; return data; }
  async function savedState() {
    try { return await refresh(); }
    catch (cause) { const error = new SavedChangeError(cause); onSavedRefreshFailure?.(error); throw error; }
  }

  return {
    saveContract: (input: ContractInput, contractId?: string, expectedRevision?: number) => contractId
      ? write<Contract>(`/contracts/${idPath(contractId)}?expectedRevision=${expectedRevision}`, 'PUT', input)
      : write<Contract>('/contracts', 'POST', input),
    contractAction: (contractId: string, expectedRevision: number, action: 'archive' | 'reactivate' | 'delete') => action === 'delete'
      ? write<null>(`/contracts/${idPath(contractId)}?expectedRevision=${expectedRevision}`, 'DELETE')
      : write<Contract>(`/contracts/${idPath(contractId)}/status`, 'PUT', { active: action === 'reactivate', expectedRevision }),
    saveHomeOrder: (ids: string[]) => write<{ homeOrder: string[] }>('/preferences/home-order', 'PUT', { ids }),
    attachmentImages: (ids: string[]) => write<Record<string, string>>('/attachments/export', 'POST', { ids: ids.map(Number) }),
    currentSession: () => request<AppSession | null>('/session'),
    signIn: (username: string, password: string) => write<AppSession>('/session', 'POST', { username, password }),
    signOut: () => write('/session', 'DELETE'),
    refresh,
    ledger: loadState,
    async saveHeads(changes: StagedChange[]) {
      await write<HeadResult>('/heads/batch', 'POST', { revision: headRevision, changes });
      return savedState();
    },
    async savePermissions(userId: string, ids: number[]) {
      await write(`/users/${idPath(userId)}/permissions`, 'PUT', { ids }); return savedState();
    },
    async saveProfile(userId: string, profile: UserProfile) {
      await write(`/users/${idPath(userId)}/profile`, 'PUT', profile); return savedState();
    },
    async createUser({ password, ...profile }: CreateUserInput) {
      const user = await write<AdminUser>('/users', 'POST', { profile, password }); return { data: await savedState(), user };
    },
    createCreditUser: (profile: UserProfile) => write<CreditUser>('/external-users', 'POST', profile),
    editCreditUser: (id: string, profile: UserProfile) => write<CreditUser>(`/external-users/${idPath(id)}/profile`, 'PUT', profile),
    pinCreditUser: (id: string, pinned: boolean) => write<CreditUser>(`/external-users/${idPath(id)}/pin`, 'PUT', { pinned }),
    deleteCreditUser: (id: string) => write<null>(`/external-users/${idPath(id)}`, 'DELETE'),
    deactivateCreditUser: (id: string) => write<CreditUser>(`/external-users/${idPath(id)}/status`, 'PUT', { active: false }),
    reactivateCreditUser: (id: string) => write<CreditUser>(`/external-users/${idPath(id)}/status`, 'PUT', { active: true }),
    changePassword: (userId: string, password: string) => write<null>(`/users/${idPath(userId)}/password`, 'PUT', { password }),
    async userAction(userId: string, action: UserAction) {
      const path = `/users/${idPath(userId)}`;
      if (action === 'delete') await write(path, 'DELETE');
      else if (action === 'pin' || action === 'unpin') await write(`${path}/pin`, 'PUT', { pinned: action === 'pin' });
      else await write(`${path}/status`, 'PUT', { active: action === 'reactivate' });
      return savedState();
    },
    userOverview: (userId: string) => request<UserOverview>(`/users/${idPath(userId)}/overview`),
    submitTransaction: (_userId: string, input: TransactionInput) => write<{ id: string; applied: boolean }>('/transactions/bills', 'POST', { input }),
    recordUserBill: (userId: string, input: TransactionInput) => write<Transaction>(`/users/${idPath(userId)}/bills`, 'POST', { input }),
    creditUser: (userId: string, input: TransactionInput, creditUserId?: string, contractId?: string) =>
      write<Transaction>('/transactions/credits', 'POST', { userId, creditUserId, contractId, input }),
    editTransaction: (id: string, input: TransactionInput, expectedVersion: string, contractId?: string) =>
      write<Transaction>(`/transactions/${idPath(id)}`, 'PUT', { input, expectedVersion: Number(expectedVersion), contractId }),
    transactionAction: async (id: string, action: 'deactivate' | 'reactivate' | 'delete', expectedVersion: string) => {
      if (action === 'delete') { await write(`/transactions/${idPath(id)}?expectedVersion=${Number(expectedVersion)}`, 'DELETE'); return null; }
      return write<Transaction>(`/transactions/${idPath(id)}/status`, 'PUT', { active: action === 'reactivate', expectedVersion: Number(expectedVersion) });
    },
    async uploadAttachment(file: File, kind: Attachment['kind'], maxBytes = 5 * 1024 * 1024) {
      const prepared = await prepareAttachment(file, maxBytes);
      const form = new FormData(); form.append('file', prepared); form.append('kind', kind);
      return request<Attachment>('/attachments', { method: 'POST', body: form });
    },
  };
}
