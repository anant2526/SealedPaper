'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, saveJson, formatBytes, formatDateTime } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import QuorumSeal from '@/components/QuorumSeal';
import FaceScan from '@/components/FaceScan';
import { StatusPill, countdown } from '@/components/status';

function CodeInput({ value, onChange, id }) {
  return (
    <input
      id={id}
      className="field w-40 text-center text-xl tracking-[0.3em]"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
    />
  );
}

function CollectKey({ docId, onDone }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function collect(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { keyFile, fileName } = await api(`/documents/${docId}/key-file`, { method: 'POST', body: { code } });
      saveJson(keyFile, fileName);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={collect} className="space-y-4">
      <h2 className="text-xl font-bold">Collect your key file</h2>
      <p className="text-[15px] leading-relaxed text-ink-soft">
        Your key file downloads once and is then deleted from the server. Store it somewhere only you can reach, such as
        an encrypted USB drive. You will upload it again in the unlock window.
      </p>
      <label className="block" htmlFor="collect-code">
        <span className="label">Code from your authenticator app</span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <CodeInput id="collect-code" value={code} onChange={setCode} />
        <button className="btn-primary" disabled={busy || code.length !== 6}>{busy ? 'Preparing…' : 'Download my key file'}</button>
      </div>
      {error && <p role="alert" className="text-[15px] text-wax">{error}</p>}
    </form>
  );
}

function SubmitKey({ docId, onDone }) {
  const [keyFile, setKeyFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [code, setCode] = useState('');

  async function pickFile(e) {
    setFileError('');
    setKeyFile(null);
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      if (parsed.format !== 'sealedpaper-key') throw new Error('This is not a SealedPaper key file');
      if (parsed.documentId !== docId) throw new Error(`This key file is for "${parsed.documentTitle}", not this document`);
      setKeyFile(parsed);
    } catch (err) {
      setFileError(err instanceof SyntaxError ? 'This file is not a SealedPaper key file' : err.message);
    }
  }

  const ready = keyFile && code.length === 6;

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold">Submit your key</h2>
      <p className="text-[15px] leading-relaxed text-ink-soft">
        You need all three: your key file, the current code from your authenticator app, and a live face scan.
      </p>
      <div>
        <label className="block">
          <span className="label">Key file</span>
          <input type="file" accept=".json,application/json" onChange={pickFile}
            className="block w-full text-[15px] file:mr-4 file:rounded-md file:border-0 file:bg-ink file:px-4 file:py-2 file:font-semibold file:text-paper" />
        </label>
        {keyFile && <span className="mt-1 block text-sm text-open">Key {keyFile.shareIndex} of {keyFile.totalShares}, issued to {keyFile.custodian}</span>}
        {fileError && <span role="alert" className="mt-1 block text-sm text-wax">{fileError}</span>}
      </div>
      <div>
        <label className="label" htmlFor="unlock-code">Code from your authenticator app</label>
        <CodeInput id="unlock-code" value={code} onChange={setCode} />
        <p className="mt-1 text-sm text-ink-soft">If a scan fails, wait for a new code before trying again; each code works once.</p>
      </div>
      {ready ? (
        <FaceScan
          startLabel="Scan my face and submit the key"
          getChallenge={() => api(`/documents/${docId}/face-challenge`, { method: 'POST' })}
          onFrames={async (challengeId, frames) => {
            await api(`/documents/${docId}/unlock`, { method: 'POST', body: { challengeId, frames, code, keyFile } });
            onDone();
          }}
        />
      ) : (
        <p className="rounded-md border border-dashed border-line px-4 py-3 text-[15px] text-ink-soft">
          Choose your key file and type the code to start the face scan.
        </p>
      )}
    </div>
  );
}

export default function DocumentPage() {
  const { id } = useParams();
  const { ready } = useRequireAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [offset, setOffset] = useState(0);   // server clock minus browser clock

  const load = useCallback(async () => {
    try {
      const d = await api(`/documents/${id}`);
      setOffset(new Date(d.serverTime).getTime() - Date.now());
      setData(d);
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    if (!ready) return;
    load();
    const poll = setInterval(load, 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [ready, load]);

  if (!ready) return null;
  if (error && !data) return <p role="alert" className="text-wax">{error}</p>;
  if (!data) return <p className="text-ink-soft">Loading…</p>;

  const { document: doc, custodians, recipients, me } = data;
  const serverNow = now + offset;
  const released = doc.status === 'released';
  const windowOpen = serverNow >= new Date(doc.submit_opens_at).getTime();
  const timeLeft = new Date(doc.unlock_at).getTime() - serverNow;

  let yourPart;
  if (released) {
    yourPart = (
      <div className="space-y-4">
        <h2 className="text-xl font-bold">The paper is open</h2>
        <p className="text-[15px] text-ink-soft">Every download is recorded in the audit log with your name and IP address.</p>
        <a className="btn-primary" href={`/api/documents/${doc.document_id}/download`}>Download {doc.original_name}</a>
      </div>
    );
  } else if (me.isCustodian && !me.keyPickedUp) {
    yourPart = <CollectKey docId={doc.document_id} onDone={load} />;
  } else if (me.isCustodian && me.keySubmitted) {
    yourPart = (
      <div>
        <h2 className="text-xl font-bold">Your key is in</h2>
        <p className="mt-2 text-[15px] text-ink-soft">
          {doc.keys_submitted >= doc.threshold_k
            ? 'Enough keys are in. The paper opens automatically at the unlock time.'
            : `Waiting for ${doc.threshold_k - doc.keys_submitted} more custodian${doc.threshold_k - doc.keys_submitted === 1 ? '' : 's'}.`}
        </p>
      </div>
    );
  } else if (me.isCustodian && me.lockedOut) {
    yourPart = (
      <div>
        <h2 className="text-xl font-bold">Key submission paused</h2>
        <p className="mt-2 text-[15px] text-wax">Too many failed attempts on this document. Try again in 10 minutes.</p>
      </div>
    );
  } else if (me.isCustodian && !windowOpen) {
    yourPart = (
      <div>
        <h2 className="text-xl font-bold">You hold key {me.shareIndex} for this paper</h2>
        <p className="mt-2 text-[15px] text-ink-soft">
          Key submission opens {formatDateTime(doc.submit_opens_at)}, in {countdown(doc.submit_opens_at, serverNow)}. Keep your
          key file safe until then.
        </p>
      </div>
    );
  } else if (me.isCustodian) {
    yourPart = <SubmitKey docId={doc.document_id} onDone={load} />;
  } else {
    yourPart = (
      <div>
        <h2 className="text-xl font-bold">Sealed</h2>
        <p className="mt-2 text-[15px] text-ink-soft">
          {me.isAdmin
            ? `As exam controller you cannot open this paper. It opens only when ${doc.threshold_k} of the ${doc.total_shares_n} custodians submit their keys after the unlock time.`
            : 'You can download the paper here once it is released.'}
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[320px_1fr]">
      <aside className="space-y-6">
        <div className="panel flex flex-col items-center p-6 text-center">
          <QuorumSeal total={doc.total_shares_n} threshold={doc.threshold_k} submitted={doc.keys_submitted} released={released} size={240} />
          <div className="mt-4"><StatusPill doc={doc} /></div>
          {!released && (
            <p className="mt-3 text-[15px] text-ink-soft">
              {timeLeft > 0 ? <>Unlock time in <span className="font-semibold text-ink">{countdown(doc.unlock_at, serverNow)}</span></> : 'Unlock time has passed'}
            </p>
          )}
        </div>
        <dl className="panel divide-y divide-line text-[15px]">
          {[
            ['File', `${doc.original_name}, ${formatBytes(doc.size_bytes)}`],
            ['Unlock time', formatDateTime(doc.unlock_at)],
            ['Keys accepted from', formatDateTime(doc.submit_opens_at)],
            ['Keys needed', `${doc.threshold_k} of ${doc.total_shares_n}`],
            ...(released ? [['Released', formatDateTime(doc.released_at)]] : []),
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
              <dt className="text-ink-soft">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </aside>

      <div className="min-w-0 space-y-8">
        <h1 className="text-3xl font-bold tracking-tight">{doc.title}</h1>
        <section className="panel p-6">{yourPart}</section>

        <section>
          <h2 className="mb-3 text-lg font-bold">Key custodians</h2>
          <div className="overflow-x-auto rounded-[10px] border border-line bg-panel">
            <table className="w-full text-left text-[15px]">
              <thead className="border-b border-line text-sm text-ink-soft">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Key</th>
                  <th className="px-4 py-2.5 font-semibold">Custodian</th>
                  <th className="px-4 py-2.5 font-semibold">Key file collected</th>
                  <th className="px-4 py-2.5 font-semibold">{released ? 'Used to open' : 'Key submitted'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {custodians.map((c) => (
                  <tr key={c.share_index}>
                    <td className="px-4 py-2.5 font-semibold">{c.share_index}</td>
                    <td className="px-4 py-2.5">{c.name}<span className="block text-sm text-ink-soft">{c.email}</span></td>
                    <td className="px-4 py-2.5">{c.picked_up_at ? formatDateTime(c.picked_up_at) : <span className="text-ink-soft">Not yet</span>}</td>
                    <td className="px-4 py-2.5">
                      {released
                        ? c.used_in_release ? <span className="font-semibold text-open">Yes</span> : <span className="text-ink-soft">No</span>
                        : c.submitted ? <span className="font-semibold text-wax">Submitted</span> : <span className="text-ink-soft">Not yet</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {recipients.length > 0 && (
            <p className="mt-3 text-[15px] text-ink-soft">
              Also allowed to download after release: {recipients.map((r) => r.name).join(', ')}.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
