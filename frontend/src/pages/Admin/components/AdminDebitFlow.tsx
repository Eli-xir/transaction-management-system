import { useCallback, useState } from 'react';
import type { AdminUser, Head, Permissions, Transaction } from '../types';
import { adminPayableBalance } from '../utils/adminPayable';
import { UserCards } from './UserCards';
import { Dialog } from './Dialog';
import { UserPreview } from './UserPreview';

export function AdminDebitFlow({ users, heads, onClose, onSubmitted, onDirtyChange, onBusyChange, initialUserId = '', returnToSource = false, mode = 'debit', permissions = {}, transactions = [] }: {
  users: AdminUser[]; heads: Head[]; initialUserId?: string;
  mode?: 'debit' | 'credit' | 'personal-add' | 'personal-pay'; permissions?: Permissions; transactions?: Transaction[];
  returnToSource?: boolean;
  onClose: () => void; onSubmitted: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [userId, setUserId] = useState(initialUserId);
  const [paymentMode, setPaymentMode] = useState<'debit' | 'personal-pay'>('debit');
  const activeMode = mode === 'debit' && !initialUserId ? paymentMode : mode;
  const label = activeMode === 'credit' ? 'User credit' : activeMode === 'personal-add' ? 'Add Admin payable' : activeMode === 'personal-pay' ? 'Pay Admin payable' : 'User debit';
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const changeDirty = useCallback((value: boolean) => { setDirty(value); onDirtyChange(value); }, [onDirtyChange]);
  const changeBusy = useCallback((value: boolean) => { setBusy(value); onBusyChange(value); }, [onBusyChange]);
  const user = users.find((item) => item.user_id === userId && item.is_active && item.role !== 'admin');
  function leaveUser() { if (returnToSource) onClose(); else setUserId(''); }
  function back() { if (!busy) { if (dirty) setDiscard(true); else leaveUser(); } }
  return <section className="admin-credit-page flex-col gap-md">
    {user ? <UserPreview key={userId} user={user} heads={heads} assigned={permissions[userId] ?? []} pending={false}
      adminCredit={activeMode === 'debit'} adminBill={activeMode === 'credit'} adminPayable={activeMode === 'personal-add' ? 'add' : activeMode === 'personal-pay' ? 'pay' : undefined} transactionLabel={label}
      onClose={back} onDirtyChange={changeDirty} onBusyChange={changeBusy}
      onSubmitted={async () => { await onSubmitted(); onClose(); }} /> : <>
      <header className="flex-row items-center gap-sm">{(mode === 'personal-add' || mode === 'personal-pay') && <button className="btn" onClick={onClose}>← Admin payable</button>}<h1>{label}</h1></header>
      {mode === 'debit' && !initialUserId && <div className="flex-row flex-wrap gap-sm" role="group" aria-label="Payment type">
        <button className="btn" aria-pressed={paymentMode === 'debit'} onClick={() => setPaymentMode('debit')}>Pay user</button>
        <button className="btn" aria-pressed={paymentMode === 'personal-pay'} onClick={() => setPaymentMode('personal-pay')}>Pay Admin payable</button>
      </div>}
      <UserCards users={activeMode === 'personal-pay' ? users.filter((item) => adminPayableBalance(transactions, item.user_id) > 0) : users} onOpen={(item) => setUserId(item.user_id)} onChanged={onSubmitted} />
    </>}
    {discard && <Dialog title="Discard this transaction draft?" onClose={() => setDiscard(false)}>
      <div className="flex-row gap-sm"><button className="btn" onClick={() => setDiscard(false)}>Keep editing</button>
        <button className="btn btn--primary" onClick={() => { setDiscard(false); leaveUser(); }}>Discard</button></div>
    </Dialog>}
  </section>;
}
