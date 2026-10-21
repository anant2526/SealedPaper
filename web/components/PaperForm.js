'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, toLocalInput, formatDateTime } from '@/lib/api';
import PeoplePicker from './PeoplePicker';

const blankRow = () => ({ topic: '', difficulty: 'easy', count: 2, marks: 2 });
const blankCentre = () => ({ centreId: '', superintendentId: '', candidateCount: 30, printBuffer: 2 });

function defaults() {
  const seal = new Date(Date.now() + 2 * 3600_000);
  seal.setMinutes(0, 0, 0);
  return {
    examName: '', subject: '', title: '', instructions: 'Answer all questions. Each question has exactly one correct option.',
    durationMinutes: 90,
    sealDeadline: toLocalInput(seal),
    unlockAt: toLocalInput(new Date(seal.getTime() + 3600_000)),
    examStart: toLocalInput(new Date(seal.getTime() + 3600_000 + 45 * 60_000)),
    submitWindowMinutes: 60, thresholdK: 2,
    blueprint: [blankRow()], setterIds: [], custodianIds: [], centres: [blankCentre()],
  };
}

function Section({ title, hint, children }) {
  return (
    <section className="panel space-y-4 p-6">
      <div>
        <h2 className="text-lg font-bold">{title}</h2>
        {hint && <p className="mt-1 text-[15px] text-ink-soft">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export default function PaperForm({ paperId }) {
  const router = useRouter();
  const [form, setForm] = useState(paperId ? null : defaults());
  const [users, setUsers] = useState([]);
  const [centres, setCentres] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/users').then((r) => setUsers(r.users.filter((u) => u.status === 'active'))).catch((e) => setError(e.message));
    api('/centres').then((r) => setCentres(r.centres)).catch((e) => setError(e.message));
    if (paperId) {
      api(`/papers/${paperId}/setup`).then(({ setup, status }) => {
        if (status !== 'draft') return router.replace(`/papers/${paperId}`);
        setForm({
          ...setup,
          sealDeadline: toLocalInput(setup.sealDeadline), unlockAt: toLocalInput(setup.unlockAt), examStart: toLocalInput(setup.examStart),
        });
      }).catch((e) => setError(e.message));
    }
  }, [paperId, router]);

  if (!form) return <p className="text-ink-soft">{error || 'Loading…'}</p>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setRow = (list, i, k, v) => setForm({ ...form, [list]: form[list].map((r, j) => (j === i ? { ...r, [k]: v } : r)) });
  const removeRow = (list, i) => setForm({ ...form, [list]: form[list].filter((_, j) => j !== i) });
  const toggle = (list) => (id) => setForm({ ...form, [list]: form[list].includes(id) ? form[list].filter((x) => x !== id) : [...form[list], id] });

  const n = form.custodianIds.length;
  const k = Math.min(Math.max(2, Number(form.thresholdK)), Math.max(2, n));
  const totalQuestions = form.blueprint.reduce((s, b) => s + Number(b.count || 0), 0);
  const totalMarks = form.blueprint.reduce((s, b) => s + Number(b.count || 0) * Number(b.marks || 0), 0);
  const byRole = (role) => users.filter((u) => u.role === role);
  const supers = byRole('superintendent');

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (n < 2) return setError('Choose at least 2 key custodians');
    if (form.setterIds.length === 0) return setError('Choose at least one paper setter');
    if (form.centres.some((c) => !c.centreId || !c.superintendentId)) return setError('Every centre row needs a centre and a superintendent');
    setBusy(true);
    const body = {
      ...form,
      thresholdK: k,
      sealDeadline: new Date(form.sealDeadline).toISOString(),
      unlockAt: new Date(form.unlockAt).toISOString(),
      examStart: new Date(form.examStart).toISOString(),
      blueprint: form.blueprint.map((b) => ({ ...b, count: Number(b.count), marks: Number(b.marks) })),
      centres: form.centres.map((c) => ({ ...c, candidateCount: Number(c.candidateCount), printBuffer: Number(c.printBuffer) })),
    };
    try {
      const r = paperId
        ? await api(`/papers/${paperId}`, { method: 'PUT', body })
        : await api('/papers', { method: 'POST', body });
      router.push(`/papers/${r.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{paperId ? 'Edit paper setup' : 'New exam paper'}</h1>
        <p className="mt-1 max-w-prose text-ink-soft">
          Setters fill a question pool for the blueprint below. At unlock time the server draws the final paper from the
          pool, so no setter knows which of their questions will appear.
        </p>
      </div>

      <Section title="Paper">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="label">Exam</span>
            <input className="field" value={form.examName} onChange={set('examName')} required minLength={3} placeholder="Mid-semester examination 2026" />
          </label>
          <label className="block">
            <span className="label">Subject</span>
            <input className="field" value={form.subject} onChange={set('subject')} required minLength={2} placeholder="Data Structures" />
          </label>
          <label className="block">
            <span className="label">Paper title</span>
            <input className="field" value={form.title} onChange={set('title')} required minLength={3} placeholder="Paper A" />
          </label>
          <label className="block">
            <span className="label">Duration (minutes)</span>
            <input className="field" type="number" min={10} max={600} value={form.durationMinutes} onChange={set('durationMinutes')} required />
          </label>
          <label className="block sm:col-span-2">
            <span className="label">Instructions printed on the paper</span>
            <textarea className="field min-h-20" value={form.instructions} onChange={set('instructions')} maxLength={2000} />
          </label>
        </div>
      </Section>

      <Section title="Time lock" hint="The pool closes at the seal deadline. The paper cannot open before the unlock time, and centres print between unlock and the exam start.">
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="label">Seal deadline</span>
            <input type="datetime-local" className="field" value={form.sealDeadline} onChange={set('sealDeadline')} required />
          </label>
          <label className="block">
            <span className="label">Unlock time</span>
            <input type="datetime-local" className="field" value={form.unlockAt} onChange={set('unlockAt')} required />
          </label>
          <label className="block">
            <span className="label">Exam starts</span>
            <input type="datetime-local" className="field" value={form.examStart} onChange={set('examStart')} required />
          </label>
        </div>
        <label className="block max-w-xs">
          <span className="label">Custodians can submit keys from</span>
          <select className="field" value={form.submitWindowMinutes} onChange={set('submitWindowMinutes')}>
            {[[15, '15 minutes before unlock'], [30, '30 minutes before unlock'], [60, '1 hour before unlock'], [180, '3 hours before unlock'], [1440, '1 day before unlock']]
              .map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </Section>

      <Section title="Blueprint" hint={`The final paper has ${totalQuestions} questions worth ${totalMarks} marks. Setters should add more questions than each row needs, so the draw has a real choice.`}>
        <div className="space-y-3">
          {form.blueprint.map((b, i) => (
            <div key={i} className="grid grid-cols-2 items-end gap-3 rounded-md border border-line bg-white p-3 sm:grid-cols-[1fr_140px_110px_110px_auto]">
              <label className="col-span-2 block sm:col-span-1">
                <span className="label">Topic</span>
                <input className="field" value={b.topic} onChange={(e) => setRow('blueprint', i, 'topic', e.target.value)} required minLength={2} placeholder="Trees" />
              </label>
              <label className="block">
                <span className="label">Difficulty</span>
                <select className="field" value={b.difficulty} onChange={(e) => setRow('blueprint', i, 'difficulty', e.target.value)}>
                  <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
                </select>
              </label>
              <label className="block">
                <span className="label">Questions</span>
                <input className="field" type="number" min={1} max={100} value={b.count} onChange={(e) => setRow('blueprint', i, 'count', e.target.value)} required />
              </label>
              <label className="block">
                <span className="label">Marks each</span>
                <input className="field" type="number" min={1} max={100} value={b.marks} onChange={(e) => setRow('blueprint', i, 'marks', e.target.value)} required />
              </label>
              <button type="button" className="btn-quiet" onClick={() => removeRow('blueprint', i)} disabled={form.blueprint.length === 1}
                aria-label={`Remove blueprint row ${i + 1}`}>Remove</button>
            </div>
          ))}
        </div>
        <button type="button" className="btn-quiet" onClick={() => setForm({ ...form, blueprint: [...form.blueprint, blankRow()] })}>Add a row</button>
      </Section>

      <Section title="Paper setters" hint="Each setter sees only their own questions, and only until the paper is sealed.">
        <PeoplePicker people={byRole('setter')} selected={form.setterIds} onToggle={toggle('setterIds')}
          empty="No active paper setters. Give people the paper setter role on the People page." />
      </Section>

      <Section title="Key custodians" hint="Each custodian gets one key file at sealing. Opening the paper needs a key file, an authenticator code and a face scan from enough of them.">
        <PeoplePicker people={byRole('custodian')} selected={form.custodianIds} onToggle={toggle('custodianIds')}
          empty="No active key custodians yet." />
        {n >= 2 && (
          <label className="block max-w-xs">
            <span className="label">Keys needed to open</span>
            <select className="field" value={k} onChange={(e) => setForm({ ...form, thresholdK: Number(e.target.value) })}>
              {Array.from({ length: n - 1 }, (_, i) => i + 2).map((v) => <option key={v} value={v}>{v} of {n}</option>)}
            </select>
          </label>
        )}
      </Section>

      <Section title="Exam centres" hint="Each centre gets its own question and option order, and can print at most its candidates plus the spare copies.">
        {centres.length === 0 ? (
          <p className="text-[15px] text-ink-soft">No centres yet. <Link href="/centres" className="underline">Add centres first</Link>.</p>
        ) : (
          <div className="space-y-3">
            {form.centres.map((c, i) => (
              <div key={i} className="grid grid-cols-2 items-end gap-3 rounded-md border border-line bg-white p-3 sm:grid-cols-[1fr_1fr_110px_100px_auto]">
                <label className="col-span-2 block sm:col-span-1">
                  <span className="label">Centre</span>
                  <select className="field" value={c.centreId} onChange={(e) => setRow('centres', i, 'centreId', e.target.value)} required>
                    <option value="">Choose…</option>
                    {centres.map((x) => <option key={x.id} value={x.id}>{x.code}, {x.name}</option>)}
                  </select>
                </label>
                <label className="col-span-2 block sm:col-span-1">
                  <span className="label">Superintendent</span>
                  <select className="field" value={c.superintendentId} onChange={(e) => setRow('centres', i, 'superintendentId', e.target.value)} required>
                    <option value="">{supers.length ? 'Choose…' : 'No superintendents yet'}</option>
                    {supers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="label">Candidates</span>
                  <input className="field" type="number" min={1} value={c.candidateCount} onChange={(e) => setRow('centres', i, 'candidateCount', e.target.value)} required />
                </label>
                <label className="block">
                  <span className="label">Spares</span>
                  <input className="field" type="number" min={0} max={100} value={c.printBuffer} onChange={(e) => setRow('centres', i, 'printBuffer', e.target.value)} required />
                </label>
                <button type="button" className="btn-quiet" onClick={() => removeRow('centres', i)} disabled={form.centres.length === 1}
                  aria-label={`Remove centre row ${i + 1}`}>Remove</button>
              </div>
            ))}
            <button type="button" className="btn-quiet" onClick={() => setForm({ ...form, centres: [...form.centres, blankCentre()] })}>Add a centre</button>
          </div>
        )}
      </Section>

      {error && <p role="alert" className="rounded-md bg-wax-soft px-3 py-2.5 text-wax">{error}</p>}
      <div className="flex flex-wrap items-center gap-4">
        <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : paperId ? 'Save changes' : 'Create paper and open the pool'}</button>
        {form.sealDeadline && <span className="text-[15px] text-ink-soft">The pool closes {formatDateTime(new Date(form.sealDeadline))}.</span>}
      </div>
    </form>
  );
}
