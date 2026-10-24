'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, formatBytes, formatDateTime } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import { roleName } from '@/components/Header';
import QuorumSeal from '@/components/QuorumSeal';
import { CATEGORIES } from '@/lib/categories';

function defaultUnlock() {
  const d = new Date(Date.now() + 2 * 3600_000);
  d.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MAX_MB = 4;

function PeoplePicker({ people, selected, onToggle, empty }) {
  if (people.length === 0) return <p className="text-[15px] text-ink-soft">{empty}</p>;
  return (
    <ul className="divide-y divide-line rounded-md border border-line bg-white">
      {people.map((p) => (
        <li key={p.id}>
          <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-ink)]" checked={selected.includes(p.id)} onChange={() => onToggle(p.id)} />
            <span className="font-medium">{p.name}</span>
            <span className="truncate text-sm text-ink-soft">{p.email}, {roleName(p.role).toLowerCase()}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

export default function NewDocument() {
  const { ready } = useRequireAuth(['admin']);
  const router = useRouter();
  const [users, setUsers] = useState([]);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('research');
  const [description, setDescription] = useState('');
  const [copies, setCopies] = useState(CATEGORIES.research.copies);
  const [file, setFile] = useState(null);
  const [unlockAt, setUnlockAt] = useState(defaultUnlock);
  const [windowMin, setWindowMin] = useState(60);
  const [custodians, setCustodians] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [k, setK] = useState(2);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ready) api('/users').then((r) => setUsers(r.users.filter((u) => u.status === 'active'))).catch((e) => setError(e.message));
  }, [ready]);

  const n = custodians.length;
  useEffect(() => {
    if (n >= 2 && (k > n || k < 2)) setK(Math.max(2, Math.ceil(n / 2)));
  }, [n, k]);

  const custodianPool = users.filter((u) => u.role === 'custodian');
  const recipientPool = useMemo(
    () => users.filter((u) => !custodians.includes(u.id) && u.role !== 'admin')
      .sort((a, b) => (a.role === 'superintendent' ? -1 : 0) - (b.role === 'superintendent' ? -1 : 0)),
    [users, custodians],
  );
  const toggle = (list, setList) => (id) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const unlockDate = unlockAt ? new Date(unlockAt) : null;
  const opensAt = unlockDate ? new Date(unlockDate.getTime() - windowMin * 60_000) : null;

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!file) return setError('Choose the file to seal');
    if (file.size > MAX_MB * 1048576) return setError(`The file is ${formatBytes(file.size)}; the limit is ${MAX_MB} MB`);
    if (n < 2) return setError('Choose at least 2 key custodians');
    setBusy(true);
    const form = new FormData();
    form.append('title', title);
    form.append('category', category);
    form.append('description', description);
    form.append('copiesPerReader', String(copies));
    form.append('file', file);
    form.append('unlockAt', unlockDate.toISOString());
    form.append('submitWindowMinutes', String(windowMin));
    form.append('thresholdK', String(k));
    form.append('custodianIds', JSON.stringify(custodians));
    form.append('recipientIds', JSON.stringify(recipients.filter((r) => !custodians.includes(r))));
    try {
      const { document } = await api('/documents', { method: 'POST', form });
      router.push(`/documents/${document.document_id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (!ready) return null;

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_300px]">
      <form onSubmit={submit} className="space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Seal a new document</h1>
          <p className="mt-1 max-w-prose text-ink-soft">
            Research results, financial results, board decks, judgments, tenders or exam papers. The file is encrypted with a brand-new key the moment you upload it. The key is split among the custodians and
            then deleted, so after this step nobody, including you, can read it alone.
          </p>
        </div>

        <section className="panel space-y-4 p-6">
          <h2 className="text-lg font-bold">Document</h2>
          <label className="block">
            <span className="label">Kind of document</span>
            <select className="field" value={category} onChange={(e) => {
              const c = CATEGORIES[e.target.value];
              setCategory(e.target.value);
              setWindowMin(c.window);
              setCopies(c.copies);
              setK(c.k);
            }}>
              {Object.entries(CATEGORIES).map(([key, c]) => <option key={key} value={key}>{c.label}</option>)}
            </select>
            <span className="mt-1 block text-sm text-ink-soft">For example: {CATEGORIES[category].example}.</span>
          </label>
          <label className="block">
            <span className="label">Title</span>
            <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3}
              placeholder="Q3 FY27 results before announcement" />
          </label>
          <label className="block">
            <span className="label">Note for readers (optional)</span>
            <textarea className="field min-h-16" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000}
              placeholder="Embargoed until the stock-exchange filing at 4 pm." />
          </label>
          <div>
            <label className="block">
              <span className="label">File</span>
              <input type="file" required onChange={(e) => setFile(e.target.files?.[0] || null)} aria-describedby="file-hint"
                className="block w-full text-[15px] file:mr-4 file:rounded-md file:border-0 file:bg-ink file:px-4 file:py-2 file:font-semibold file:text-paper" />
            </label>
            <span id="file-hint" className="mt-1 block text-sm text-ink-soft">
              {file ? `${file.name}, ${formatBytes(file.size)}` : `PDF or any file up to ${MAX_MB} MB`}
            </span>
          </div>
        </section>

        <section className="panel space-y-4 p-6">
          <h2 className="text-lg font-bold">Time lock</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="label">Unlock time</span>
              <input type="datetime-local" className="field" value={unlockAt} onChange={(e) => setUnlockAt(e.target.value)} required />
            </label>
            <label className="block">
              <span className="label">Custodians can submit keys from</span>
              <select className="field" value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))}>
                <option value={15}>15 minutes before</option>
                <option value={30}>30 minutes before</option>
                <option value={60}>1 hour before</option>
                <option value={180}>3 hours before</option>
                <option value={1440}>1 day before</option>
              </select>
            </label>
          </div>
          {opensAt && <p className="text-sm text-ink-soft">Key submission opens {formatDateTime(opensAt)}. The paper cannot open before {formatDateTime(unlockDate)}.</p>}
        </section>

        <section className="panel space-y-4 p-6">
          <h2 className="text-lg font-bold">Key custodians</h2>
          <p className="text-[15px] text-ink-soft">Each person you tick gets one key file. Only active accounts with the key custodian role are listed.</p>
          <PeoplePicker people={custodianPool} selected={custodians} onToggle={toggle(custodians, setCustodians)}
            empty="No active key custodians yet. Ask officials to register, then give them the key custodian role on the People page." />
          {n >= 2 && (
            <label className="block max-w-xs">
              <span className="label">Keys needed to open</span>
              <select className="field" value={k} onChange={(e) => setK(Number(e.target.value))}>
                {Array.from({ length: n - 1 }, (_, i) => i + 2).map((v) => (
                  <option key={v} value={v}>{v} of {n}</option>
                ))}
              </select>
            </label>
          )}
        </section>

        <section className="panel space-y-4 p-6">
          <h2 className="text-lg font-bold">Readers after release</h2>
          <p className="text-[15px] text-ink-soft">
            Custodians and the admin can always read a released document. Every download is a traced copy: PDFs are stamped
            with the reader’s name and a unique copy code on every page, so a leaked copy names its reader.
          </p>
          <PeoplePicker people={recipientPool} selected={recipients} onToggle={toggle(recipients, setRecipients)} empty="No other active users." />
          <label className="block max-w-xs">
            <span className="label">Copies each reader may download</span>
            <select className="field" value={copies} onChange={(e) => setCopies(Number(e.target.value))}>
              {[1, 2, 3, 5, 10].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        </section>

        {error && <p role="alert" className="rounded-md bg-wax-soft px-3 py-2.5 text-wax">{error}</p>}
        <button className="btn-wax" disabled={busy}>{busy ? 'Encrypting and splitting…' : 'Seal document'}</button>
      </form>

      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div className="panel flex flex-col items-center p-6 text-center">
          <QuorumSeal total={Math.max(n, 2)} threshold={n >= 2 ? k : 2} submitted={0} released={false} size={200} />
          <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
            {n >= 2
              ? `${n} key files will be made. Any ${k} of them open the paper after ${unlockDate ? formatDateTime(unlockDate) : 'the unlock time'}.`
              : 'Choose at least 2 key custodians.'}
          </p>
        </div>
      </aside>
    </div>
  );
}
