'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import { DIFFICULTY, Table, Td } from '@/components/PaperBits';

const LETTERS = 'ABCDEF';

export default function PaperContent() {
  const { id } = useParams();
  const { ready } = useRequireAuth(['admin', 'investigator']);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (ready) api(`/papers/${id}/content`).then(setData).catch((e) => setError(e.message));
  }, [ready, id]);

  if (!ready) return null;
  if (!data) return <p className={error ? 'text-wax' : 'text-ink-soft'}>{error || 'Decrypting the final paper…'}</p>;

  let section = null;
  return (
    <div className="space-y-10">
      <div>
        <Link href={`/papers/${id}`} className="text-[15px] text-ink-soft underline">Back to the paper</Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Final paper, base order</h1>
        <p className="mt-1 max-w-prose text-ink-soft">
          Drawn from the pool at release with a cryptographically secure shuffle. Every centre prints these same questions in its
          own order, with the options shuffled too.
        </p>
        {data.shortfalls.length > 0 && (
          <p role="alert" className="mt-3 rounded-md bg-wax-soft px-3 py-2.5 text-wax">
            Short of questions after withdrawals: {data.shortfalls.map((s) => `${s.topic} (${s.difficulty}) ${s.drawn} of ${s.needed}`).join('; ')}.
          </p>
        )}
      </div>

      <ol className="space-y-4">
        {data.questions.map((q) => {
          const head = q.section !== section;
          section = q.section;
          return (
            <li key={q.id}>
              {head && <h2 className="mb-3 mt-6 text-lg font-bold">Section {LETTERS[q.section - 1]}: {q.topic}, {DIFFICULTY[q.difficulty].toLowerCase()}</h2>}
              <div className="panel p-5">
                <div className="flex flex-wrap justify-between gap-2 text-sm text-ink-soft">
                  <span>Question {q.position}, {q.marks} mark{q.marks === 1 ? '' : 's'}</span>
                  <span>Set by {q.setterName}</span>
                </div>
                <p className="mt-1 font-medium">{q.text}</p>
                <ul className="mt-2 grid gap-1 text-[15px] sm:grid-cols-2">
                  {q.options.map((o, j) => (
                    <li key={j} className={j === q.answer ? 'font-semibold text-open' : 'text-ink-soft'}>({LETTERS[j]}) {o}{j === q.answer ? ', correct' : ''}</li>
                  ))}
                </ul>
              </div>
            </li>
          );
        })}
      </ol>

      <section>
        <h2 className="mb-1 text-lg font-bold">Answer keys by centre</h2>
        <p className="mb-3 text-[15px] text-ink-soft">Question numbers and option letters as printed at each centre, for marking.</p>
        <Table head={['Centre', 'Fingerprint', 'Printed number: answer (base question)']}>
          {data.centres.map((c) => (
            <tr key={c.code}>
              <Td className="font-semibold">{c.code}<span className="block text-sm font-normal text-ink-soft">{c.name}</span></Td>
              <Td className="text-sm text-ink-soft">{c.signature}</Td>
              <Td>
                <span className="flex flex-wrap gap-x-4 gap-y-1">
                  {c.key.map((k) => <span key={k.number}><span className="font-semibold">{k.number}: {k.answer}</span> <span className="text-sm text-ink-soft">(Q{k.basePosition})</span></span>)}
                </span>
              </Td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  );
}
