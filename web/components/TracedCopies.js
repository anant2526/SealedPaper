'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, formatDateTime } from '@/lib/api';

async function downloadCopy(documentId) {
  const res = await fetch(`/api/documents/${documentId}/download`, { credentials: 'same-origin' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || 'Download failed');
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] || 'document');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return res.headers.get('X-Copy-Code');
}

/** Released document: download a traced copy, and see who holds which copy. */
export default function TracedCopies({ doc, me }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const overseer = me.isAdmin || me.isInvestigator;

  const load = useCallback(() => {
    api(`/documents/${doc.document_id}/copies`).then(setData).catch((e) => setError(e.message));
  }, [doc.document_id]);
  useEffect(load, [load]);

  const mine = data ? data.copies.filter((c) => !overseer || c.reader_email === me.email).length : 0;
  const left = data ? Math.max(0, data.copiesPerReader - mine) : 0;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold">The document is open</h2>
        <p className="mt-1 max-w-prose text-[15px] leading-relaxed text-ink-soft">
          Every download is a numbered copy issued to one reader. A PDF is stamped on every page with the reader’s name, a
          unique copy code, a faint watermark and a hidden copy of the code, so a leaked page, photo or pasted text names its reader.
        </p>
      </div>
      {me.canDownload && (
        <div className="flex flex-wrap items-center gap-4">
          <button className="btn-primary" disabled={busy} onClick={async () => {
            setBusy(true);
            setError('');
            setMsg('');
            try {
              const code = await downloadCopy(doc.document_id);
              setMsg(`Downloaded your copy ${code}. It is registered to you.`);
              load();
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}>{busy ? 'Stamping your copy…' : `Download my traced copy of ${doc.original_name}`}</button>
          {data && <span className="text-[15px] text-ink-soft">Up to {data.copiesPerReader} cop{data.copiesPerReader === 1 ? 'y' : 'ies'} per reader.</span>}
        </div>
      )}
      {msg && <p role="status" className="rounded-md bg-open-soft px-3 py-2.5 text-[15px] text-open">{msg}</p>}
      {error && <p role="alert" className="rounded-md bg-wax-soft px-3 py-2.5 text-[15px] text-wax">{error}</p>}

      {data?.copies?.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-line bg-white">
          <table className="w-full text-left text-[15px]">
            <thead className="border-b border-line text-sm text-ink-soft">
              <tr>
                <th className="px-3 py-2 font-semibold">Copy code</th>
                {overseer && <th className="px-3 py-2 font-semibold">Issued to</th>}
                <th className="px-3 py-2 font-semibold">Issued</th>
                <th className="px-3 py-2 font-semibold">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.copies.map((c) => (
                <tr key={c.id} className={c.leaked ? 'bg-wax-soft/50' : ''}>
                  <td className="px-3 py-2 font-semibold tracking-wide">{c.copy_code}</td>
                  {overseer && <td className="px-3 py-2">{c.reader_name}<span className="block text-sm text-ink-soft">{c.reader_email}</span></td>}
                  <td className="px-3 py-2">{formatDateTime(c.issued_at)}</td>
                  <td className="px-3 py-2">
                    {c.leaked ? <span className="font-semibold text-wax">Found in a leak</span> : c.stamped ? 'Stamped PDF' : 'Logged (not a PDF)'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {left === 0 && me.canDownload && data && !overseer && <p className="text-sm text-ink-soft">You have used all your copies.</p>}
    </div>
  );
}
