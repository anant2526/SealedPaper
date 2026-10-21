'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, formatDateTime } from '@/lib/api';
import { DIFFICULTY } from './PaperBits';

const LETTERS = 'ABCDEF';
const empty = (cell) => ({ cell: cell || '', text: '', options: ['', '', '', ''], answer: 0 });

function QuestionForm({ blueprint, initial, onSave, onCancel, saveLabel }) {
  const [q, setQ] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    const [topic, difficulty] = q.cell.split('|');
    if (!topic) return setError('Choose the topic and difficulty');
    setBusy(true);
    try {
      await onSave({ topic, difficulty, text: q.text, options: q.options.map((o) => o.trim()), answer: Number(q.answer) });
      setQ(empty(q.cell));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block max-w-sm">
        <span className="label">Topic and difficulty</span>
        <select className="field" value={q.cell} onChange={(e) => setQ({ ...q, cell: e.target.value })} required>
          <option value="">Choose…</option>
          {blueprint.map((b) => (
            <option key={`${b.topic}|${b.difficulty}`} value={`${b.topic}|${b.difficulty}`}>{b.topic}, {DIFFICULTY[b.difficulty].toLowerCase()}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="label">Question</span>
        <textarea className="field min-h-24" value={q.text} onChange={(e) => setQ({ ...q, text: e.target.value })} required minLength={10} maxLength={2000} />
      </label>
      <fieldset>
        <legend className="label">Options, and the correct one</legend>
        <div className="space-y-2">
          {q.options.map((opt, i) => (
            <div key={i} className="flex items-center gap-3">
              <input type="radio" name="answer" className="h-4 w-4 accent-[var(--color-open)]" checked={Number(q.answer) === i}
                onChange={() => setQ({ ...q, answer: i })} aria-label={`Option ${LETTERS[i]} is correct`} />
              <span className="w-6 font-semibold">{LETTERS[i]}</span>
              <input className="field" value={opt} required maxLength={300} aria-label={`Option ${LETTERS[i]}`}
                onChange={(e) => setQ({ ...q, options: q.options.map((o, j) => (j === i ? e.target.value : o)) })} />
              <button type="button" className="text-sm text-ink-soft underline disabled:opacity-40" disabled={q.options.length <= 2}
                onClick={() => setQ({ ...q, options: q.options.filter((_, j) => j !== i), answer: Number(q.answer) === i ? 0 : Number(q.answer) > i ? q.answer - 1 : q.answer })}>
                Remove
              </button>
            </div>
          ))}
        </div>
        {q.options.length < 6 && (
          <button type="button" className="mt-2 text-sm font-semibold underline" onClick={() => setQ({ ...q, options: [...q.options, ''] })}>Add an option</button>
        )}
      </fieldset>
      {error && <p role="alert" className="text-[15px] text-wax">{error}</p>}
      <div className="flex gap-3">
        <button className="btn-primary" disabled={busy}>{busy ? 'Encrypting…' : saveLabel}</button>
        {onCancel && <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function ImportBox({ paperId, onDone }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  async function pick(e) {
    setError('');
    setResult(null);
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      const questions = Array.isArray(parsed) ? parsed : parsed.questions;
      if (!Array.isArray(questions)) throw new Error('The file must hold a list of questions');
      const r = await api(`/papers/${paperId}/questions/import`, { method: 'POST', body: { questions } });
      setResult(r);
      onDone();
    } catch (err) {
      setError(err instanceof SyntaxError ? 'That file is not valid JSON' : err.message);
    }
    e.target.value = '';
  }
  return (
    <div className="space-y-2">
      <p className="text-[15px] text-ink-soft">
        A JSON list like <code className="rounded bg-white px-1">{'[{"topic":"Trees","difficulty":"medium","text":"…","options":["…","…"],"answer":0}]'}</code>.
        Answer counts from 0.
      </p>
      <input type="file" accept=".json,application/json" onChange={pick} aria-label="Question file"
        className="block text-[15px] file:mr-4 file:rounded-md file:border-0 file:bg-ink file:px-4 file:py-2 file:font-semibold file:text-paper" />
      {error && <p role="alert" className="text-[15px] text-wax">{error}</p>}
      {result && (
        <div className="text-[15px]" role="status">
          <p className="font-semibold text-open">Added {result.added} question{result.added === 1 ? '' : 's'}.</p>
          {result.skipped.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-wax">
              {result.skipped.map((s) => <li key={s.index}>Question {s.index}: {s.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function SetterPool({ paper, blueprint, onChange }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [tab, setTab] = useState('write');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api(`/papers/${paper.id}/questions/mine`).then(setData).catch((e) => setError(e.message));
  }, [paper.id]);
  useEffect(load, [load]);

  const refresh = () => {
    load();
    onChange?.();
  };

  if (!data) return <p className="text-ink-soft">{error || 'Loading your questions…'}</p>;

  if (data.locked) {
    const burned = data.questions.filter((q) => q.status === 'burned').length;
    return (
      <section className="panel p-6">
        <h2 className="text-xl font-bold">Your questions are sealed</h2>
        <p className="mt-2 max-w-prose text-[15px] leading-relaxed text-ink-soft">
          You added {data.questions.length} question{data.questions.length === 1 ? '' : 's'}. The paper key was split among the custodians and deleted,
          so nobody, including you, can read or change them now. {paper.status === 'released'
            ? 'The paper has been drawn; you are not told which of your questions were picked.'
            : `The final paper is drawn from the pool at ${formatDateTime(paper.unlockAt)}.`}
          {burned > 0 && ` ${burned} of your questions were withdrawn after a leak report.`}
        </p>
      </section>
    );
  }

  const cellOf = (q) => `${q.topic}|${q.difficulty}`;

  return (
    <div className="space-y-6">
      <section className="panel p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold">Add to the question pool</h2>
          <div className="flex gap-1 rounded-md border border-line bg-white p-1 text-sm" role="tablist">
            {[['write', 'Write one'], ['import', 'Import a file']].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`rounded px-3 py-1.5 font-semibold ${tab === k ? 'bg-ink text-paper' : 'text-ink-soft'}`}>{l}</button>
            ))}
          </div>
        </div>
        <p className="mb-5 text-[15px] text-ink-soft">
          Each question is encrypted the moment you save it. You can edit until {formatDateTime(paper.sealDeadline)}.
        </p>
        {tab === 'write' ? (
          <QuestionForm blueprint={blueprint} initial={empty()} saveLabel="Save question"
            onSave={async (q) => { await api(`/papers/${paper.id}/questions`, { method: 'POST', body: q }); refresh(); }} />
        ) : (
          <ImportBox paperId={paper.id} onDone={refresh} />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-bold">Your questions ({data.questions.length})</h2>
        {data.questions.length === 0 && <p className="text-ink-soft">None yet. Other setters’ questions are never shown to you.</p>}
        <ol className="space-y-3">
          {data.questions.map((q, i) => (
            <li key={q.id} className="panel p-5">
              {editing === q.id ? (
                <QuestionForm blueprint={blueprint} saveLabel="Save changes" onCancel={() => setEditing(null)}
                  initial={{ cell: cellOf(q), text: q.text, options: q.options, answer: q.answer }}
                  onSave={async (body) => { await api(`/papers/questions/${q.id}`, { method: 'PATCH', body }); setEditing(null); refresh(); }} />
              ) : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <p className="text-sm text-ink-soft">
                      {i + 1}. {q.topic}, {DIFFICULTY[q.difficulty].toLowerCase()}
                      {q.status === 'burned' && <span className="ml-2 font-semibold text-wax">Withdrawn after a leak</span>}
                    </p>
                    {q.status === 'active' && (
                      <div className="flex gap-3 text-sm">
                        <button className="font-semibold underline" onClick={() => setEditing(q.id)}>Edit</button>
                        <button className="font-semibold text-wax underline" onClick={async () => {
                          if (!window.confirm('Delete this question from the pool?')) return;
                          try { await api(`/papers/questions/${q.id}`, { method: 'DELETE' }); refresh(); } catch (e) { setError(e.message); }
                        }}>Delete</button>
                      </div>
                    )}
                  </div>
                  <p className="mt-1 font-medium">{q.text}</p>
                  <ul className="mt-2 grid gap-1 text-[15px] sm:grid-cols-2">
                    {q.options.map((o, j) => (
                      <li key={j} className={j === q.answer ? 'font-semibold text-open' : 'text-ink-soft'}>
                        ({LETTERS[j]}) {o}{j === q.answer ? ', correct' : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </li>
          ))}
        </ol>
        {error && <p role="alert" className="mt-3 text-wax">{error}</p>}
      </section>
    </div>
  );
}
