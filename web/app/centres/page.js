'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import { Table, Td } from '@/components/PaperBits';

export default function CentresPage() {
  const { user, ready } = useRequireAuth(['admin', 'investigator']);
  const [centres, setCentres] = useState(null);
  const [form, setForm] = useState({ code: '', name: '', city: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api('/centres').then((r) => setCentres(r.centres)).catch((e) => setError(e.message)), []);
  useEffect(() => {
    if (ready) load();
  }, [ready, load]);
  if (!ready) return null;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Exam centres</h1>
        <p className="mt-1 max-w-prose text-ink-soft">
          The centre code is printed in every copy’s footer and copy code, so keep it short, for example DEL01.
        </p>
      </div>

      {user.role === 'admin' && (
        <form className="panel grid gap-4 p-6 sm:grid-cols-[140px_1fr_1fr_auto] sm:items-end" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('/centres', { method: 'POST', body: form });
            setForm({ code: '', name: '', city: '' });
            load();
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}>
          <label className="block">
            <span className="label">Code</span>
            <input className="field uppercase" value={form.code} onChange={set('code')} required pattern="[A-Za-z0-9]{2,8}" maxLength={8} placeholder="DEL01" />
          </label>
          <label className="block">
            <span className="label">Name</span>
            <input className="field" value={form.name} onChange={set('name')} required minLength={3} placeholder="Delhi Public School, Sector 12" />
          </label>
          <label className="block">
            <span className="label">City</span>
            <input className="field" value={form.city} onChange={set('city')} required minLength={2} placeholder="Delhi" />
          </label>
          <button className="btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add centre'}</button>
          {error && <p role="alert" className="text-wax sm:col-span-4">{error}</p>}
        </form>
      )}

      {centres && centres.length === 0 && <p className="text-ink-soft">No centres yet.</p>}
      {centres && centres.length > 0 && (
        <Table head={['Code', 'Centre', 'City', 'Papers', 'Candidates']}>
          {centres.map((c) => (
            <tr key={c.id}>
              <Td className="font-semibold tracking-wide">{c.code}</Td>
              <Td>{c.name}</Td>
              <Td>{c.city}</Td>
              <Td>{c.papers}</Td>
              <Td>{c.candidates}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
