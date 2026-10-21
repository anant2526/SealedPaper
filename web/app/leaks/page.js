'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, formatDateTime } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import { Table, Td } from '@/components/PaperBits';

function resultText(r) {
  if (r.copy_code) return `Copy ${r.copy_code}`;
  if (r.centre_code) return `Centre ${r.centre_code}`;
  if (Number(r.matches) > 0) return `${r.matches} question${Number(r.matches) === 1 ? '' : 's'} matched`;
  return 'No match';
}

export default function LeaksPage() {
  const { ready } = useRequireAuth(['admin', 'investigator']);
  const router = useRouter();
  const params = useSearchParams();
  const [papers, setPapers] = useState([]);
  const [reports, setReports] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [form, setForm] = useState({ paperId: params.get('paper') || '', source: '', text: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready) return;
    api('/papers').then((r) => {
      setPapers(r.papers);
      setForm((f) => (f.paperId ? f : { ...f, paperId: r.papers[0]?.id || '' }));
    }).catch((e) => setError(e.message));
    api('/leaks').then((r) => setReports(r.reports)).catch(() => {});
    api('/leaks/analytics').then(setAnalytics).catch(() => {});
  }, [ready]);

  if (!ready) return null;

  async function loadFile(e) {
    const f = e.target.files?.[0];
    if (f) setForm({ ...form, text: await f.text() });
  }

  const flaggedCentres = analytics?.centres.filter((c) => c.above_average) || [];

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Trace a leak</h1>
        <p className="mt-1 max-w-prose text-ink-soft">
          Paste the leaked questions as text, for example copied from a screenshot or a forwarded message. Before release the
          tracer names the setter whose questions match. After release it names the centre from the question order, and the
          exact copy if a copy code is visible.
        </p>
      </div>

      <form className="panel space-y-4 p-6" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const { id } = await api('/leaks', { method: 'POST', body: form });
          router.push(`/leaks/${id}`);
        } catch (err) {
          setError(err.message);
          setBusy(false);
        }
      }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">Paper</span>
            <select className="field" value={form.paperId} onChange={(e) => setForm({ ...form, paperId: e.target.value })} required>
              {papers.length === 0 && <option value="">No papers yet</option>}
              {papers.map((p) => <option key={p.id} value={p.id}>{p.subject}: {p.title} ({p.status})</option>)}
            </select>
          </label>
          <label className="block">
            <span className="label">Where it was found</span>
            <input className="field" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} maxLength={300}
              placeholder="Telegram group, 22 Oct, 9:40 pm" />
          </label>
        </div>
        <label className="block">
          <span className="label">Leaked text</span>
          <textarea className="field min-h-48" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} required minLength={10} />
        </label>
        <div className="flex flex-wrap items-center gap-4">
          <button className="btn-wax" disabled={busy || !form.paperId}>{busy ? 'Tracing…' : 'Trace this leak'}</button>
          <label className="text-[15px] text-ink-soft">
            or load a .txt file{' '}
            <input type="file" accept=".txt,text/plain" onChange={loadFile} className="ml-2 text-sm" />
          </label>
        </div>
        {error && <p role="alert" className="text-wax">{error}</p>}
      </form>

      {analytics && (analytics.setters.length > 0 || flaggedCentres.length > 0) && (
        <section className="grid gap-8 lg:grid-cols-2">
          <div>
            <h2 className="mb-3 text-lg font-bold">Setters with more than one leaked question</h2>
            {analytics.setters.length === 0 ? <p className="text-ink-soft">None.</p> : (
              <Table head={['Setter', 'Leaked questions', 'Reports']}>
                {analytics.setters.map((s) => (
                  <tr key={s.setter_id}>
                    <Td>{s.name}<span className="block text-sm text-ink-soft">{s.email}</span></Td>
                    <Td className="font-semibold text-wax">{s.leaked_questions}</Td>
                    <Td>{s.reports}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
          <div>
            <h2 className="mb-3 text-lg font-bold">Centres reprinting more than average</h2>
            {flaggedCentres.length === 0 ? <p className="text-ink-soft">None.</p> : (
              <Table head={['Centre', 'Reprints', 'Rate', 'Average']}>
                {flaggedCentres.map((c) => (
                  <tr key={c.centre_id}>
                    <Td className="font-semibold">{c.code}<span className="block text-sm font-normal text-ink-soft">{c.name}</span></Td>
                    <Td>{c.reprints} of {c.copies}</Td>
                    <Td className="font-semibold text-wax">{(Number(c.reprint_rate) * 100).toFixed(1)}%</Td>
                    <Td>{(Number(c.average_rate) * 100).toFixed(1)}%</Td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-bold">Reports</h2>
        {reports && reports.length === 0 && <p className="text-ink-soft">No leaks reported yet.</p>}
        {reports && reports.length > 0 && (
          <Table head={['Reported', 'Paper', 'Stage', 'Result', 'By']}>
            {reports.map((r) => (
              <tr key={r.id}>
                <Td><Link href={`/leaks/${r.id}`} className="font-semibold underline">{formatDateTime(r.created_at)}</Link></Td>
                <Td>{r.subject}: {r.title}</Td>
                <Td>{r.phase === 'pre_release' ? 'Before release' : 'After release'}</Td>
                <Td className={r.centre_code || Number(r.matches) > 0 ? 'font-semibold text-wax' : 'text-ink-soft'}>{resultText(r)}</Td>
                <Td>{r.reported_by_name}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
