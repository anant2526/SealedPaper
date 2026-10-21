'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, formatDateTime } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import { roleName } from '@/components/Header';

const ROLES = ['admin', 'custodian', 'superintendent', 'investigator', 'setter'];

export default function UsersPage() {
  const { user: me, ready } = useRequireAuth(['admin']);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => api('/users').then((r) => setUsers(r.users)).catch((e) => setError(e.message)), []);
  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  async function update(id, patch) {
    setError('');
    try {
      await api(`/users/${id}`, { method: 'PATCH', body: patch });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!ready) return null;

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">People</h1>
      <p className="mt-1 max-w-prose text-ink-soft">
        New accounts start as key custodians. An account becomes active only after its face scan and authenticator app are set up.
      </p>
      {error && <p role="alert" className="mt-4 text-wax">{error}</p>}
      <div className="mt-6 overflow-x-auto rounded-[10px] border border-line bg-panel">
        <table className="w-full text-left text-[15px]">
          <thead className="border-b border-line text-sm text-ink-soft">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Name</th>
              <th className="px-4 py-2.5 font-semibold">Role</th>
              <th className="px-4 py-2.5 font-semibold">Set-up</th>
              <th className="px-4 py-2.5 font-semibold">Failed face scans, 24 h</th>
              <th className="px-4 py-2.5 font-semibold">Account</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users?.map((u) => {
              const self = u.id === me.id;
              return (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <span className="font-semibold">{u.name}</span>
                    <span className="block text-sm text-ink-soft">{u.email}, joined {formatDateTime(u.created_at)}</span>
                  </td>
                  <td className="px-4 py-3">
                    {self ? roleName(u.role) : (
                      <select className="field py-1.5" value={u.role} aria-label={`Role for ${u.name}`}
                        onChange={(e) => update(u.id, { role: e.target.value })}>
                        {ROLES.map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.face_enrolled && u.totp_enabled ? 'Face and app' : u.face_enrolled ? 'Face only' : 'Not started'}
                  </td>
                  <td className={`px-4 py-3 ${u.failed_scans_24h >= 3 ? 'font-semibold text-wax' : ''}`}>{u.failed_scans_24h}</td>
                  <td className="px-4 py-3">
                    {u.status === 'pending' && <span className="text-ink-soft">Unfinished</span>}
                    {u.status !== 'pending' && !self && (
                      <button className="btn-quiet py-1.5" onClick={() => update(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })}>
                        {u.status === 'active' ? 'Disable' : 'Re-enable'}
                      </button>
                    )}
                    {self && <span className="text-ink-soft">You</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
