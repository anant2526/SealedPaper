'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, formatDateTime } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import { PaperStatus } from '@/components/PaperBits';

function myPart(p, role) {
  const parts = [];
  if (p.i_am_setter) parts.push(p.status === 'draft' ? `You have added ${p.my_questions} question${p.my_questions === 1 ? '' : 's'}` : `Your ${p.my_questions} questions are sealed`);
  if (p.i_am_custodian) parts.push(p.status === 'draft' ? 'You get a key file when it is sealed' : 'You hold a key');
  if (p.i_am_superintendent) parts.push(p.status === 'released' ? 'Ready to print at your centre' : 'Your centre prints after release');
  if (role === 'admin' && p.status === 'draft') parts.push(`Pool: ${p.pool_size} questions for ${p.questions_needed} places`);
  return parts.join('. ');
}

export default function PapersPage() {
  const { user, ready } = useRequireAuth();
  const [papers, setPapers] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ready) return;
    const load = () => api('/papers').then((r) => setPapers(r.papers)).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [ready]);

  if (!ready) return null;
  const isAdmin = user.role === 'admin';
  const intro = {
    admin: 'Every exam paper, from question pool to printed copies.',
    setter: 'Papers you write questions for. You only ever see your own questions.',
    superintendent: 'Papers your centre will print. Printing opens when a paper is released.',
    custodian: 'Papers you hold a key for.',
    investigator: 'Every exam paper. Open Leaks to trace a leaked copy.',
  }[user.role];

  // group by exam
  const groups = new Map();
  for (const p of papers || []) {
    if (!groups.has(p.exam_name)) groups.set(p.exam_name, []);
    groups.get(p.exam_name).push(p);
  }

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{user.role === 'superintendent' ? 'My centres' : 'Exam papers'}</h1>
          <p className="mt-1 text-ink-soft">{intro}</p>
        </div>
        {isAdmin && <Link href="/papers/new" className="btn-wax">New exam paper</Link>}
      </div>
      {error && <p role="alert" className="text-wax">{error}</p>}
      {papers && papers.length === 0 && (
        <div className="panel p-8">
          <p className="text-lg font-semibold">No papers yet.</p>
          <p className="mt-1 text-ink-soft">
            {isAdmin ? 'Add your exam centres, give people their roles, then create the first paper.' : 'The exam controller will assign you to a paper.'}
          </p>
        </div>
      )}
      <div className="space-y-8">
        {[...groups.entries()].map(([exam, list]) => (
          <section key={exam}>
            <h2 className="mb-3 text-lg font-bold">{exam}</h2>
            <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-panel">
              {list.map((p) => (
                <li key={p.id}>
                  <Link href={`/papers/${p.id}`} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 hover:bg-white">
                    <div className="min-w-0 flex-1">
                      <p className="text-lg font-semibold">{p.subject}: {p.title}</p>
                      <p className="text-[15px] text-ink-soft">
                        Exam {formatDateTime(p.exam_start)}, {p.centre_count} centre{Number(p.centre_count) === 1 ? '' : 's'}, {p.threshold_k} of {p.total_shares_n} keys
                      </p>
                      {myPart(p, user.role) && <p className="mt-0.5 text-[15px] font-medium">{myPart(p, user.role)}</p>}
                    </div>
                    <PaperStatus status={p.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
