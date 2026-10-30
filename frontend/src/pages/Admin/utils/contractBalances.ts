import type { Contract, Transaction } from '../types.ts';
import { roundMoney } from '../../Ledger/ledgerModel.ts';
import { contractAmount } from '../../Ledger/receiptModel.ts';

export function contractContributions(contractId: string, transactions: Transaction[]) {
  const amounts = new Map<string, number>();
  for (const entry of transactions) {
    if (entry.active && entry.creditUserId && contractAmount(entry, contractId)) {
      amounts.set(entry.creditUserId, roundMoney((amounts.get(entry.creditUserId) ?? 0) + contractAmount(entry, contractId)));
    }
  }
  return amounts;
}

export function contractBalance(contract: Contract, transactions: Transaction[]) {
  const received = transactions.filter((entry) => entry.active && entry.creditUserId)
    .reduce((sum, entry) => roundMoney(sum + contractAmount(entry, contract.id)), 0);
  return { received, remaining: roundMoney(contract.totalAmount - received) };
}
