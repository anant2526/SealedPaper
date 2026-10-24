'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, formatDateTime } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import { Table, Td } from '@/components/PaperBits';

function resultText(r) {
  if (r.reader_name) return `${r.reader_name}, copy ${r.copy_code}`;
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
  const [docs, setDocs] = useState([]);
  const [reports, setReports] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [form, setForm] = useState({
    target: params.get('paper') ? `paper:${params.get('paper')}` : params.get('document') ? `doc:${params.get('document')}` : '',
    source: '', text: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready) return;
    Promise.all([api('/papers'), api('/documents')]).then(([p, d]) => {
      setPapers(p.papers);
      const ds = d.documents.filter((x) => !x.paper_id);
      setDocs(ds);
      const first = ds[0] ? `doc:${ds[0].document_id}` : p.papers[0] ? `paper:${p.papers[0].id}` : '';
      setForm((f) => (f.target ? f : { ...f, target: first }));
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
          Paste the leaked text, for example copied from a forwarded PDF, a screenshot or a message. For a confidential
          document the tracer finds the copy code stamped on every page and names the reader it was issued to. For an exam
          paper it names the setter before release, and the centre or exact printed copy after release.
        </p>
      </div>

      <form className="panel space-y-4 p-6" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const [kind, id0] = form.target.split(':');
          const body = { text: form.text, source: form.source, ...(kind === 'doc' ? { documentId: id0 } : { paperId: id0 }) };
          const { id } = await api('/leaks', { method: 'POST', body });
          router.push(`/leaks/${id}`);
        } catch (err) {
          setError(err.message);
          setBusy(false);
        }
      }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">Leaked document</span>
            <select className="field" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} required>
              {papers.length + docs.length === 0 && <option value="">Nothing sealed yet</option>}
              {docs.length > 0 && (
                <optgroup label="Confidential documents">
                  {docs.map((d) => <option key={d.document_id} value={`doc:${d.document_id}`}>{d.title} ({d.status})</option>)}
                </optgroup>
              )}
              {papers.length > 0 && (
                <optgroup label="Exam papers">
                  {papers.map((p) => <option key={p.id} value={`paper:${p.id}`}>{p.subject}: {p.title} ({p.status})</option>)}
                </optgroup>
              )}
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
          <button className="btn-wax" disabled={busy || !form.target}>{busy ? 'Tracing…' : 'Trace this leak'}</button>
          <label className="text-[15px] text-ink-soft">
            or load a .txt file{' '}
            <input type="file" accept=".txt,text/plain" onChange={loadFile} className="ml-2 text-sm" />
          </label>
        </div>
        {error && <p role="alert" className="text-wax">{error}</p>}
      </form>

      {analytics?.readers?.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-bold">Readers whose copies leaked</h2>
          <Table head={['Reader', 'Leaked copies', 'Documents held', 'Last copy']}>
            {analytics.readers.map((r) => (
              <tr key={r.reader_id}>
                <Td>{r.name}<span className="block text-sm text-ink-soft">{r.email}</span></Td>
                <Td className="font-semibold text-wax">{r.leaked_copies}</Td>
                <Td>{r.documents}</Td>
                <Td>{formatDateTime(r.last_copy)}</Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

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
          <Table head={['Reported', 'Document', 'Stage', 'Result', 'By']}>
            {reports.map((r) => (
              <tr key={r.id}>
                <Td><Link href={`/leaks/${r.id}`} className="font-semibold underline">{formatDateTime(r.created_at)}</Link></Td>
                <Td>{r.target_title}</Td>
                <Td>{r.phase === 'pre_release' ? 'Before release' : 'After release'}</Td>
                <Td className={r.centre_code || r.copy_code || Number(r.matches) > 0 ? 'font-semibold text-wax' : 'text-ink-soft'}>{resultText(r)}</Td>
                <Td>{r.reported_by_name}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
