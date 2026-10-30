import type { AdminUser, Transaction } from '../types.ts';
import { roundMoney } from '../../Ledger/ledgerModel.ts';

export type BalanceCategory = 'receivable' | 'payable';
export interface OutstandingUser { user: AdminUser; category: BalanceCategory; amount: number; }

// Positive net is an advance recoverable from the user; negative net is an unpaid bill.
export function outstandingBalances(users: AdminUser[], transactions: Transaction[]): OutstandingUser[] {
  const balances = new Map<string, number>();
  for (const entry of transactions) {
    if (!entry.active || entry.creditUserId || entry.transactionTypeId === 2 || entry.transactionTypeId === 3) continue;
    const signed = entry.createdBy === entry.userId ? -entry.amount : entry.amount;
    balances.set(entry.userId, roundMoney((balances.get(entry.userId) ?? 0) + signed));
  }
  return users.filter((user) => user.role !== 'admin').flatMap((user) => {
    const balance = balances.get(user.user_id) ?? 0;
    return balance === 0 ? [] : [{ user, category: balance > 0 ? 'receivable' as const : 'payable' as const, amount: Math.abs(balance) }];
  });
}

export function balanceTotal(entries: OutstandingUser[]) {
  return entries.reduce((sum, entry) => roundMoney(sum + entry.amount), 0);
}
