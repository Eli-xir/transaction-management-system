import type { Transaction } from '../types.ts';
import { roundMoney } from '../../Ledger/ledgerModel.ts';

export const isAdminPayable = (entry: Transaction) => entry.transactionTypeId === 2 || entry.transactionTypeId === 3;
export const adminPayableLabel = (entry: Transaction) => entry.transactionTypeId === 2 ? 'Admin payable added' : entry.transactionTypeId === 3 ? 'Admin payable paid' : '';
export function adminPayableBalance(entries: Transaction[], userId: string) {
  return entries.filter((entry) => entry.active && entry.userId === userId && isAdminPayable(entry))
    .reduce((sum, entry) => roundMoney(sum + (entry.transactionTypeId === 2 ? entry.amount : -entry.amount)), 0);
}
