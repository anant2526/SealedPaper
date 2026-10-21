'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiDownload, formatDateTime } from '@/lib/api';
import { countdown } from './status';

const REASONS = ['Printer jam or torn page', 'Ink smudged, unreadable', 'Pages missing', 'Damaged during handling'];

function ReprintAsk({ copy, onDone }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(REASONS[0]);
  const [error, setError] = useState('');
  if (!open) return <button className="text-sm font-semibold underline" onClick={() => setOpen(true)}>Report spoiled</button>;
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={async (e) => {
      e.preventDefault();
      try {
        await api(`/papers/copies/${copy.id}/reprint-requests`, { method: 'POST', body: { reason } });
        setOpen(false);
        onDone();
      } catch (err) {
        setError(err.message);
      }
    }}>
      <select className="field w-auto py-1.5 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
        {REASONS.map((r) => <option key={r}>{r}</option>)}
      </select>
      <button className="btn-quiet py-1.5 text-sm">Ask for a reprint</button>
      <button type="button" className="text-sm underline" onClick={() => setOpen(false)}>Cancel</button>
      {error && <span className="text-sm text-wax">{error}</span>}
    </form>
  );
}

export default function CentrePrint({ paper, centre, canPrint, now }) {
  const [data, setData] = useState(null);
  const [count, setCount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [printed, setPrinted] = useState('');

  const load = useCallback(() => {
    api(`/papers/${paper.id}/centres/${centre.centre_id}/copies`).then(setData).catch((e) => setError(e.message));
  }, [paper.id, centre.centre_id]);
  useEffect(load, [load, paper.status]);

  const released = paper.status === 'released';
  const r = data?.readiness || centre;
  const left = Math.max(0, r.print_cap - r.copies_printed);

  async function print(path, body) {
    setBusy(true);
    setError('');
    setPrinted('');
    try {
      const headers = await apiDownload(path, body);
      setPrinted(headers.get('X-Copy-Codes')?.split(',').join(', ') || '');
      setCount('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-6 py-4">
        <h2 className="text-xl font-bold">{r.centre_code}, {r.centre_name}</h2>
        <p className="text-[15px] text-ink-soft">
          {r.candidate_count} candidates, {r.print_buffer} spare, printed {r.copies_printed} of {r.print_cap}
        </p>
      </div>
      <div className="space-y-5 p-6">
        {!released && (
          <p className="text-[15px] leading-relaxed text-ink-soft">
            Printing opens when the paper is released at {formatDateTime(paper.unlockAt)}
            {now < new Date(paper.unlockAt).getTime() && <>, in <span className="font-semibold text-ink">{countdown(paper.unlockAt, now)}</span></>}.
            Your centre gets its own question order, and every copy carries a unique copy code on every page.
          </p>
        )}

        {released && canPrint && (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
            e.preventDefault();
            print(`/papers/${paper.id}/centres/${centre.centre_id}/print`, { count: Number(count || left) });
          }}>
            <label className="block">
              <span className="label">Copies to print</span>
              <input className="field w-32" type="number" min={1} max={left || 1} value={count} placeholder={String(left)}
                onChange={(e) => setCount(e.target.value)} disabled={left === 0} />
            </label>
            <button className="btn-primary" disabled={busy || left === 0}>{busy ? 'Preparing PDF…' : 'Download copies to print'}</button>
            <p className="w-full text-sm text-ink-soft">
              {left === 0 ? 'Your centre has printed every copy it is allowed. A spoiled copy can be replaced with an approved reprint.'
                : `${left} more cop${left === 1 ? 'y' : 'ies'} allowed. Each download is logged and numbered; the same copy cannot be downloaded twice.`}
            </p>
          </form>
        )}
        {printed && <p role="status" className="rounded-md bg-open-soft px-3 py-2.5 text-[15px] text-open">Downloaded copies {printed}.</p>}
        {error && <p role="alert" className="rounded-md bg-wax-soft px-3 py-2.5 text-[15px] text-wax">{error}</p>}

        {data?.copies?.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-line bg-white">
            <table className="w-full text-left text-[15px]">
              <thead className="border-b border-line text-sm text-ink-soft">
                <tr>
                  <th className="px-3 py-2 font-semibold">Copy code</th>
                  <th className="px-3 py-2 font-semibold">Printed</th>
                  <th className="px-3 py-2 font-semibold">State</th>
                  {canPrint && <th className="px-3 py-2 font-semibold">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.copies.map((c) => (
                  <tr key={c.id} className={c.voided_at ? 'text-ink-soft' : ''}>
                    <td className="px-3 py-2 font-semibold tracking-wide">{c.copy_code}</td>
                    <td className="px-3 py-2">{formatDateTime(c.printed_at)}, {c.printed_by_name}</td>
                    <td className="px-3 py-2">
                      {c.voided_at ? 'Replaced' : c.replaces ? `Replaces ${c.replaces}` : 'In use'}
                      {c.reprint && !c.voided_at && <span className="block text-sm">Reprint {c.reprint.status}</span>}
                    </td>
                    {canPrint && (
                      <td className="px-3 py-2">
                        {!c.voided_at && (!c.reprint || c.reprint.status === 'rejected') && <ReprintAsk copy={c} onDone={load} />}
                        {!c.voided_at && c.reprint?.status === 'approved' && (
                          <button className="btn-quiet py-1.5 text-sm" disabled={busy}
                            onClick={() => print(`/papers/reprint-requests/${c.reprint.id}/print`)}>Print replacement</button>
                        )}
                        {c.reprint?.status === 'pending' && <span className="text-sm text-wait">Waiting for the exam controller</span>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
