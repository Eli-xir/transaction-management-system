import { useEffect, useState } from 'react';
import { Navigate, Routes, Route, useNavigate } from 'react-router-dom';
import { Login } from './Login';
import { AdminPage } from './pages/Admin/AdminPage';
import { cashbookApi } from './data/cashbookApi';
import type { AppSession, CashbookData } from './pages/Admin/types';
import { UserPreview } from './pages/Admin/components/UserPreview';
import { permittedHeads } from './pages/Admin/utils/permissions';

export default function App() {
  const navigate = useNavigate();
  const [data, setData] = useState<CashbookData>({ heads: [], users: [], creditUsers: [], permissions: {}, transactions: [] });
  const [session, setSession] = useState<AppSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void (async () => {
      try {
        const next = await cashbookApi.currentSession();
        const saved = next ? await cashbookApi.refresh() : null;
        if (active) { setSession(next); if (saved) setData(saved); }
      } catch (error) { if (active) setError((error as Error).message); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [retry]);
  useEffect(() => {
    function refreshRequired(event: Event) {
      // A committed change must never look like an unsaved form that can be resubmitted.
      setError((event as CustomEvent<string>).detail);
    }
    function expired() {
      setSession(null); setData({ heads: [], users: [], creditUsers: [], permissions: {}, transactions: [] });
      navigate('/login', { replace: true });
    }
    window.addEventListener('cashbook:session-expired', expired);
    window.addEventListener('cashbook:refresh-required', refreshRequired);
    return () => {
      window.removeEventListener('cashbook:session-expired', expired);
      window.removeEventListener('cashbook:refresh-required', refreshRequired);
    };
  }, [navigate]);
  const user = data.users.find((item) => item.user_id === session?.userId && item.is_active);
  const home = !user ? '/login' : session?.role === 'admin' ? '/Admin' : '/User';
  async function logout() {
    try { await cashbookApi.signOut(); setSession(null); setData({ heads: [], users: [], creditUsers: [], permissions: {}, transactions: [] }); navigate('/login', { replace: true }); }
    catch (error) { setError((error as Error).message); }
  }
  if (loading) return <main className="user-page"><p>Loading cashbook…</p></main>;
  if (error) return <main className="user-page"><p role="alert">{error}</p><button className="btn" onClick={() => setRetry((n) => n + 1)}>Reconnect</button></main>;
  return (
    <Routes>
      <Route path="/login" element={<Login onSignedIn={async (next) => {
        setData(await cashbookApi.refresh()); setSession(next);
      }} />} />
      <Route path="/Admin" element={
        user && session?.role === 'admin' ? <AdminPage currentAdminUserId={session.userId} {...data}
          onSubmitHeadChanges={async (changes) => {
            const saved = await cashbookApi.saveHeads(changes); setData(saved); return saved.heads;
          }}
          onSavePermissions={async (userId, ids) => {
            const saved = await cashbookApi.savePermissions(userId, ids); setData(saved); return saved.permissions[userId] ?? [];
          }}
          onSaveProfile={async (userId, profile) => { setData(await cashbookApi.saveProfile(userId, profile)); }}
          onCreateUser={async (input) => {
            const saved = await cashbookApi.createUser(input); setData(saved.data); return saved.user;
          }}
          onChangePassword={async (userId, password) => { await cashbookApi.changePassword(userId, password); }}
          onUserAction={async (userId, action) => { setData(await cashbookApi.userAction(userId, action)); }}
          onRefresh={async () => { setData(await cashbookApi.refresh()); }}
          onLogout={() => { void logout(); }} /> : <Navigate to={home} replace />
      } />
      <Route path="/User" element={user && session?.role === 'user' ?
        <main className="user-page"><UserPreview key={user.user_id} user={user} preview={false} onRefresh={async () => setData(await cashbookApi.refresh())}
          heads={permittedHeads(data.heads, data.permissions[user.user_id] ?? [])}
          assigned={data.permissions[user.user_id] ?? []} pending={false} onClose={() => { void logout(); }} />
        </main> : <Navigate to={home} replace />} />
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
