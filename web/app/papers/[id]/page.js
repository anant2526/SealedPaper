'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, formatDateTime } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import QuorumSeal from '@/components/QuorumSeal';
import SetterPool from '@/components/SetterPool';
import CentrePrint from '@/components/CentrePrint';
import { PaperStatus, PaperTimeline, DIFFICULTY, Table, Td } from '@/components/PaperBits';

function SealPanel({ data, onSealed }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const problems = data.sealProblems || [];
  return (
    <section className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-prose">
          <h2 className="text-xl font-bold">{problems.length ? 'Not ready to seal' : 'Ready to seal'}</h2>
          <p className="mt-1 text-[15px] text-ink-soft">
            The pool seals automatically at {formatDateTime(data.paper.sealDeadline)}. Sealing splits the paper key into{' '}
            {data.paper.totalSharesN} key files and deletes the key, so after this even the server cannot read a question.
          </p>
        </div>
        <div className="flex gap-3">
          <Link href={`/papers/${data.paper.id}/edit`} className="btn-quiet">Edit setup</Link>
          <button className="btn-wax" disabled={busy || problems.length > 0} onClick={async () => {
            if (!window.confirm('Seal this paper now? Setters can no longer add or change questions, and nobody can read them until the key quorum unlocks it.')) return;
            setBusy(true);
            setError('');
            try {
              await api(`/papers/${data.paper.id}/seal`, { method: 'POST' });
              onSealed();
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}>{busy ? 'Sealing…' : 'Seal now'}</button>
        </div>
      </div>
      {problems.length > 0 && (
        <ul className="mt-4 list-disc space-y-1 pl-5 text-[15px] text-wax">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      {error && <p role="alert" className="mt-3 text-wax">{error}</p>}
    </section>
  );
}

function KeysPanel({ data, mine }) {
  const k = data.keys;
  const released = data.paper.status === 'released';
  return (
    <section className="panel flex flex-wrap items-center gap-6 p-6">
      <QuorumSeal total={k.total_shares_n} threshold={k.threshold_k} submitted={k.keys_submitted} released={released} size={140} />
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-bold">{released ? 'Opened by the key quorum' : 'Key quorum'}</h2>
        <p className="mt-1 max-w-prose text-[15px] text-ink-soft">
          {released
            ? `Released ${formatDateTime(k.released_at)} with ${k.keys_submitted} key files, each checked with an authenticator code and a live face scan.`
            : `${k.keys_picked_up} of ${k.total_shares_n} key files collected, ${k.keys_submitted} of ${k.threshold_k} needed keys submitted. Keys are accepted from ${formatDateTime(k.submit_opens_at)}.`}
        </p>
        <Link href={`/documents/${data.paper.documentId}`} className={`mt-3 ${mine && !released ? 'btn-wax' : 'btn-quiet'}`}>
          {mine && !released ? 'Collect or submit my key' : 'Open the key page'}
        </Link>
      </div>
    </section>
  );
}

function ReprintRequests({ list, onDecide }) {
  const [error, setError] = useState('');
  if (!list?.length) return null;
  return (
    <section>
      <h2 className="mb-3 text-lg font-bold">Reprint requests</h2>
      <Table head={['Copy', 'Centre', 'Reason', 'Asked by', 'Decision']}>
        {list.map((r) => (
          <tr key={r.id}>
            <Td className="font-semibold">{r.copy_code}</Td>
            <Td>{r.centre_code}</Td>
            <Td>{r.reason}</Td>
            <Td>{r.requested_by_name}<span className="block text-sm text-ink-soft">{formatDateTime(r.created_at)}</span></Td>
            <Td>
              {r.status === 'pending' ? (
                <div className="flex gap-2">
                  {['approved', 'rejected'].map((d) => (
                    <button key={d} className={d === 'approved' ? 'btn-primary py-1.5 text-sm' : 'btn-quiet py-1.5 text-sm'} onClick={async () => {
                      try { await api(`/papers/reprint-requests/${r.id}`, { method: 'PATCH', body: { decision: d } }); onDecide(); } catch (e) { setError(e.message); }
                    }}>{d === 'approved' ? 'Approve' : 'Reject'}</button>
                  ))}
                </div>
              ) : <span className={r.status === 'approved' ? 'text-open' : 'text-wax'}>{r.status === 'approved' ? 'Approved' : 'Rejected'}</span>}
            </Td>
          </tr>
        ))}
      </Table>
      {error && <p role="alert" className="mt-2 text-wax">{error}</p>}
    </section>
  );
}

export default function PaperPage() {
  const { id } = useParams();
  const { ready } = useRequireAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    api(`/papers/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    if (!ready) return;
    load();
    const poll = setInterval(load, 10000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [ready, load]);

  if (!ready) return null;
  if (!data) return <p className={error ? 'text-wax' : 'text-ink-soft'}>{error || 'Loading…'}</p>;

  const { paper, me, blueprint, centres } = data;
  const overseer = me.admin || me.investigator;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[15px] text-ink-soft">{paper.examName}</p>
          <h1 className="text-3xl font-bold tracking-tight">{paper.subject}: {paper.title}</h1>
          <p className="mt-1 text-[15px] text-ink-soft">
            {paper.durationMinutes} minutes, {paper.totalMarks} marks, exam {formatDateTime(paper.examStart)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <PaperStatus status={paper.status} />
          {paper.status === 'released' && overseer && <Link href={`/papers/${paper.id}/content`} className="btn-primary">Open the final paper</Link>}
        </div>
      </div>

      <PaperTimeline paper={paper} />

      {me.admin && paper.status === 'draft' && <SealPanel data={data} onSealed={load} />}
      {data.keys && (overseer || me.custodian) && <KeysPanel data={data} mine={me.custodian} />}
      {me.custodian && paper.status === 'draft' && (
        <section className="panel p-6">
          <h2 className="text-xl font-bold">You are a key custodian for this paper</h2>
          <p className="mt-1 text-[15px] text-ink-soft">Your key file becomes available when the paper is sealed, by {formatDateTime(paper.sealDeadline)}.</p>
        </section>
      )}

      {me.setter && <SetterPool paper={paper} blueprint={blueprint} onChange={load} />}

      {me.superintendent && !overseer && centres.map((c) => (
        <CentrePrint key={c.centre_id} paper={paper} centre={c} canPrint now={now} />
      ))}

      <section>
        <h2 className="mb-3 text-lg font-bold">Blueprint</h2>
        <Table head={overseer ? ['Section', 'Topic', 'Difficulty', 'Questions', 'Marks each', 'In the pool', 'Withdrawn'] : ['Section', 'Topic', 'Difficulty', 'Questions', 'Marks each']}>
          {blueprint.map((b) => (
            <tr key={b.position}>
              <Td>{String.fromCharCode(64 + b.position)}</Td>
              <Td className="font-medium">{b.topic}</Td>
              <Td>{DIFFICULTY[b.difficulty]}</Td>
              <Td>{b.count_needed}</Td>
              <Td>{b.marks_each}</Td>
              {overseer && (
                <>
                  <Td className={b.covered ? 'text-open' : 'font-semibold text-wax'}>{b.active_count}{!b.covered && ` (needs ${b.count_needed})`}</Td>
                  <Td className={b.burned_count > 0 ? 'text-wax' : 'text-ink-soft'}>{b.burned_count}</Td>
                </>
              )}
            </tr>
          ))}
        </Table>
      </section>

      {overseer && (
        <div className="grid gap-8 lg:grid-cols-2">
          <section>
            <h2 className="mb-3 text-lg font-bold">Paper setters</h2>
            <Table head={['Setter', 'Questions', 'Withdrawn']}>
              {data.setters.map((s) => (
                <tr key={s.id}>
                  <Td>{s.name}<span className="block text-sm text-ink-soft">{s.email}</span></Td>
                  <Td>{s.questions}</Td>
                  <Td className={s.burned > 0 ? 'font-semibold text-wax' : ''}>{s.burned}</Td>
                </tr>
              ))}
            </Table>
          </section>
          <section>
            <h2 className="mb-3 text-lg font-bold">Key custodians, {paper.thresholdK} of {paper.totalSharesN} needed</h2>
            <Table head={['Custodian', 'Account']}>
              {data.custodians.map((c) => (
                <tr key={c.id}>
                  <Td>{c.name}<span className="block text-sm text-ink-soft">{c.email}</span></Td>
                  <Td className={c.status === 'active' ? '' : 'text-wax'}>{c.status === 'active' ? 'Active' : 'Not active'}</Td>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {overseer && (
        <section>
          <h2 className="mb-3 text-lg font-bold">Centres</h2>
          <Table head={['Centre', 'Superintendent', 'Candidates', 'Printed', paper.status === 'released' ? 'Variant' : 'Ready']}>
            {centres.map((c) => (
              <tr key={c.centre_id}>
                <Td className="font-semibold">{c.centre_code}<span className="block text-sm font-normal text-ink-soft">{c.centre_name}, {c.city}</span></Td>
                <Td>{c.superintendent_name}</Td>
                <Td>{c.candidate_count} + {c.print_buffer} spare</Td>
                <Td>{c.copies_printed} of {c.print_cap}{c.copies_voided > 0 && <span className="block text-sm text-ink-soft">{c.copies_voided} replaced</span>}</Td>
                <Td>{paper.status === 'released' ? (c.variant_id ? 'Own order built' : 'Missing') : c.superintendent_ready ? 'Yes' : <span className="text-wax">Superintendent not active</span>}</Td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {me.admin && <ReprintRequests list={data.reprints} onDecide={load} />}

      {overseer && (
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold">Leak reports</h2>
            <Link href={`/leaks?paper=${paper.id}`} className="btn-quiet">Trace a leak</Link>
          </div>
          {data.leaks.length === 0 ? <p className="text-ink-soft">No leaks reported for this paper.</p> : (
            <Table head={['Reported', 'Stage', 'Result']}>
              {data.leaks.map((l) => (
                <tr key={l.id}>
                  <Td><Link className="font-semibold underline" href={`/leaks/${l.id}`}>{formatDateTime(l.created_at)}</Link></Td>
                  <Td>{l.phase === 'pre_release' ? 'Before release' : 'After release'}</Td>
                  <Td>{l.centre_code ? `Traced to ${l.centre_code}` : `${l.matches} question${Number(l.matches) === 1 ? '' : 's'} matched`}</Td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      )}
    </div>
  );
}
