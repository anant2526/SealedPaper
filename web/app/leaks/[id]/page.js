'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, formatDateTime } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import { DIFFICULTY, Table, Td } from '@/components/PaperBits';

function Verdict({ r, matches }) {
  if (r.document_id) {
    if (r.reader_name) {
      return (
        <>
          <p className="text-sm font-semibold text-wax">Traced to the reader by the copy code</p>
          <p className="mt-1 text-2xl font-bold">{r.reader_name}</p>
          <p className="mt-1 text-[15px]">
            Copy {r.doc_copy_code} was issued to {r.reader_name} ({r.reader_email}) on {formatDateTime(r.doc_issued_at)}
            {r.doc_copy_ip ? ` from ${r.doc_copy_ip}` : ''}. Confidence 100%.
          </p>
        </>
      );
    }
    return (
      <>
        <p className="text-sm font-semibold text-ink-soft">No copy code found</p>
        <p className="mt-1 text-2xl font-bold">The text does not carry any of this document’s copy codes</p>
        <p className="mt-1 text-[15px]">
          {r.document_status === 'released'
            ? 'Ask for the original file or a full-page photo: the code is in every footer, in the watermark and hidden in the text.'
            : 'The document is still sealed, so no copies exist yet. The leak came from before upload, or it is fake.'}
        </p>
      </>
    );
  }
  if (r.copy_code) {
    return (
      <>
        <p className="text-sm font-semibold text-wax">Traced to one printed copy</p>
        <p className="mt-1 text-2xl font-bold">Copy {r.copy_code}</p>
        <p className="mt-1 text-[15px]">
          Centre {r.centre_code}, {r.centre_name}, {r.centre_city}. Printed {formatDateTime(r.printed_at)} by {r.printed_by_name}
          {r.voided_at ? '; this copy had been replaced as spoiled.' : '.'}
        </p>
      </>
    );
  }
  if (r.centre_code) {
    return (
      <>
        <p className="text-sm font-semibold text-wax">Traced to a centre by question and option order</p>
        <p className="mt-1 text-2xl font-bold">Centre {r.centre_code}</p>
        <p className="mt-1 text-[15px]">{r.centre_name}, {r.centre_city}. Confidence {Math.round((r.confidence || 0) * 100)}%.</p>
      </>
    );
  }
  if (matches.length) {
    const setters = [...new Set(matches.map((m) => m.setter_name))];
    return (
      <>
        <p className="text-sm font-semibold text-wax">{r.phase === 'pre_release' ? 'Leaked from the question pool before release' : 'Questions matched, centre unclear'}</p>
        <p className="mt-1 text-2xl font-bold">{matches.length} question{matches.length === 1 ? '' : 's'} from {setters.join(', ')}</p>
        <p className="mt-1 text-[15px]">
          {r.phase === 'pre_release'
            ? 'Only the setter who wrote a question ever saw it. Withdraw the matched questions so the draw at release cannot pick them.'
            : 'Too few questions in the leak to tell the centres apart. More text, or a visible copy code, will narrow it down.'}
        </p>
      </>
    );
  }
  return (
    <>
      <p className="text-sm font-semibold text-ink-soft">No match</p>
      <p className="mt-1 text-2xl font-bold">None of this paper’s questions appear in the text</p>
      <p className="mt-1 text-[15px]">The leak may be fake, reworded, or from another paper.</p>
    </>
  );
}

export default function LeakReport() {
  const { id } = useParams();
  const { user, ready } = useRequireAuth(['admin', 'investigator']);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [burnMsg, setBurnMsg] = useState('');

  const load = useCallback(() => api(`/leaks/${id}`).then(setData).catch((e) => setError(e.message)), [id]);
  useEffect(() => {
    if (ready) load();
  }, [ready, load]);
  if (!ready) return null;
  if (!data) return <p className={error ? 'text-wax' : 'text-ink-soft'}>{error || 'Loading…'}</p>;

  const { report: r, matches } = data;
  const ranking = r.summary?.ranking || [];
  const burnable = matches.filter((m) => m.status === 'active');
  const canBurn = user.role === 'admin' && r.paper_status !== 'released' && burnable.length > 0;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/leaks" className="text-[15px] text-ink-soft underline">All leak reports</Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Leak report</h1>
        <p className="mt-1 text-ink-soft">
          <Link href={r.paper_id ? `/papers/${r.paper_id}` : `/documents/${r.document_id}`} className="underline">
            {r.paper_id ? `${r.subject}: ${r.title}` : r.title}
          </Link>, reported {formatDateTime(r.created_at)} by {r.reported_by_name}
          {r.source && `, found on ${r.source}`}. {r.phase === 'pre_release' ? 'It was still sealed.' : 'It had been released.'}
        </p>
      </div>

      <section className={`rounded-[10px] border p-6 ${matches.length || r.centre_code || r.reader_name ? 'border-wax/40 bg-wax-soft/60' : 'border-line bg-panel'}`}>
        <Verdict r={r} matches={matches} />
        {canBurn && (
          <button className="btn-wax mt-4" onClick={async () => {
            if (!window.confirm(`Withdraw ${burnable.length} question${burnable.length === 1 ? '' : 's'} from the pool? This cannot be undone.`)) return;
            try {
              const res = await api(`/leaks/${id}/burn`, { method: 'POST' });
              setBurnMsg(`Withdrew ${res.burned} question${res.burned === 1 ? '' : 's'}.${res.uncoveredCells.length
                ? ` The pool is now short for ${res.uncoveredCells.map((c) => `${c.topic} (${c.difficulty}), ${c.active_count} of ${c.count_needed}`).join('; ')}. Ask setters for more before the seal deadline.`
                : ' The pool still covers the blueprint.'}`);
              load();
            } catch (e) {
              setBurnMsg(e.message);
            }
          }}>Withdraw the matched questions</button>
        )}
        {burnMsg && <p role="status" className="mt-3 text-[15px] font-medium">{burnMsg}</p>}
      </section>

      {ranking.length > 0 && (
        <section>
          <h2 className="mb-1 text-lg font-bold">How each centre’s copy compares</h2>
          <p className="mb-3 text-[15px] text-ink-soft">
            Every pair of leaked questions either appears in the same order as a centre’s copy or not, and so does the order of
            each question’s options. The centre that agrees most is the source.
          </p>
          <Table head={['Centre', 'Question pairs in the same order', 'Option orders matching', 'Agreement']}>
            {ranking.map((v, i) => (
              <tr key={v.variantId} className={i === 0 && r.centre_code === v.centreCode ? 'bg-wax-soft/50' : ''}>
                <Td className="font-semibold">{v.centreCode}<span className="block text-sm font-normal text-ink-soft">{v.centreName}</span></Td>
                <Td>{v.orderAgree} of {v.orderPairs}</Td>
                <Td>{v.optionAgree} of {v.optionChecks}</Td>
                <Td>
                  <div className="flex items-center gap-3">
                    <div className="h-2 w-28 overflow-hidden rounded-full bg-line" aria-hidden="true">
                      <div className="h-full bg-wax" style={{ width: `${Math.round(v.score * 100)}%` }} />
                    </div>
                    <span className="text-sm">{Math.round(v.score * 100)}%</span>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {matches.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-bold">Matched questions</h2>
          <Table head={['Setter', 'Topic', 'State']}>
            {matches.map((m) => (
              <tr key={m.question_id}>
                <Td>{m.setter_name}<span className="block text-sm text-ink-soft">{m.setter_email}</span></Td>
                <Td>{m.topic}, {DIFFICULTY[m.difficulty].toLowerCase()}</Td>
                <Td className={m.status === 'burned' ? 'text-wax' : ''}>
                  {m.status === 'burned' ? 'Withdrawn' : m.in_final_paper ? 'In the final paper' : r.paper_status === 'released' ? 'Not drawn' : 'Still in the pool'}
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      <details className="panel p-5">
        <summary className="cursor-pointer font-semibold">Leaked text as reported</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-sm text-ink-soft">{r.leaked_text}</pre>
      </details>
    </div>
  );
}
