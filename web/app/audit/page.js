'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, formatDateTime } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';

const ACTION_TEXT = {
  'user.registered': 'Registered',
  'face.enrolled': 'Enrolled face',
  'user.activated': 'Activated account',
  'user.updated': 'Changed a user',
  'login.success': 'Logged in',
  'login.failed': 'Failed login (password)',
  'login.face_failed': 'Failed login (face)',
  'document.sealed': 'Sealed a document',
  'key.picked_up': 'Collected key file',
  'key.submitted': 'Submitted key',
  'key.rejected': 'Key rejected',
  'document.released': 'Document released',
  'document.release_failed': 'Release failed',
  'document.downloaded': 'Downloaded document',
};

const FILTERS = [
  ['', 'Everything'],
  ['key.', 'Keys'],
  ['login.', 'Logins'],
  ['document.', 'Documents'],
  ['user.', 'Accounts'],
];

export default function AuditPage() {
  const { ready } = useRequireAuth(['admin', 'investigator']);
  const [filter, setFilter] = useState('');
  const [entries, setEntries] = useState([]);
  const [verify, setVerify] = useState(null);
  const [suspicious, setSuspicious] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const q = filter ? `?action=${encodeURIComponent(filter)}&limit=200` : '?limit=200';
    api(`/audit${q}`).then((r) => setEntries(r.entries)).catch((e) => setError(e.message));
    api('/audit/suspicious').then(setSuspicious).catch(() => {});
  }, [filter]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  async function runVerify() {
    setVerify({ running: true });
    try {
      setVerify(await api('/audit/verify'));
    } catch (err) {
      setVerify({ error: err.message });
    }
  }

  if (!ready) return null;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audit log</h1>
          <p className="mt-1 max-w-prose text-ink-soft">
            Every row stores the hash of the row before it, and the database refuses edits and deletes. Verifying recomputes
            every hash, so any tampering shows up by row number.
          </p>
        </div>
        <button className="btn-primary" onClick={runVerify} disabled={verify?.running}>
          {verify?.running ? 'Verifying…' : 'Verify the hash chain'}
        </button>
      </div>

      {verify && !verify.running && (
        <div role="status" className={`rounded-[10px] px-5 py-4 ${verify.ok ? 'bg-open-soft text-open' : 'bg-wax-soft text-wax'}`}>
          {verify.error && verify.error}
          {verify.ok && <p className="font-semibold">All {verify.checkedRows} rows verified. Nothing was changed or removed.</p>}
          {verify.ok === false && (
            <>
              <p className="font-semibold">Tampering found in {verify.problems.length} row{verify.problems.length === 1 ? '' : 's'}.</p>
              <ul className="mt-2 list-disc pl-5">
                {verify.problems.map((p) => <li key={`${p.id}-${p.problem}`}>Row {p.id}: {p.problem}</li>)}
              </ul>
            </>
          )}
        </div>
      )}

      {suspicious && (suspicious.keyAttempts.length > 0 || suspicious.faceFailures.length > 0) && (
        <section className="rounded-[10px] border border-wax/40 bg-wax-soft/50 p-5">
          <h2 className="text-lg font-bold text-wax">Needs a look</h2>
          <ul className="mt-2 space-y-1 text-[15px]">
            {suspicious.faceFailures.map((f) => (
              <li key={f.user_id}>{f.name} ({f.email}) failed {f.failed_scans} of {f.total_scans} face scans, last {formatDateTime(f.last_scan)}.</li>
            ))}
            {suspicious.keyAttempts.slice(0, 10).map((k) => (
              <li key={k.id}>{k.email}: {k.failures_last_10_min} failed key attempts within 10 minutes on “{k.title}” ({k.reason}).</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter">
          {FILTERS.map(([value, label]) => (
            <button key={label} onClick={() => setFilter(value)}
              className={`rounded-full px-3 py-1 text-sm font-semibold ${filter === value ? 'bg-ink text-paper' : 'border border-line text-ink-soft hover:text-ink'}`}>
              {label}
            </button>
          ))}
        </div>
        {error && <p role="alert" className="text-wax">{error}</p>}
        <div className="overflow-x-auto rounded-[10px] border border-line bg-panel">
          <table className="w-full text-left text-[15px]">
            <thead className="border-b border-line text-sm text-ink-soft">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Row</th>
                <th className="px-4 py-2.5 font-semibold">When</th>
                <th className="px-4 py-2.5 font-semibold">Who</th>
                <th className="px-4 py-2.5 font-semibold">What</th>
                <th className="px-4 py-2.5 font-semibold">Details</th>
                <th className="px-4 py-2.5 font-semibold">Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {entries.map((e) => (
                <tr key={e.id} className={e.action.includes('fail') || e.action.includes('rejected') ? 'bg-wax-soft/40' : ''}>
                  <td className="px-4 py-2.5 text-ink-soft">{e.id}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{formatDateTime(e.created_at)}</td>
                  <td className="px-4 py-2.5">{e.actor_name || 'System'}</td>
                  <td className="px-4 py-2.5 font-medium">{ACTION_TEXT[e.action] || e.action}</td>
                  <td className="max-w-xs truncate px-4 py-2.5 text-sm text-ink-soft" title={JSON.stringify(e.payload)}>
                    {Object.entries(e.payload || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ')}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-ink-soft" title={`row ${e.row_hash}\nprevious ${e.prev_hash || 'none'}`}>
                    {e.row_hash.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
