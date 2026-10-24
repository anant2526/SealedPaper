'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { homeFor } from '@/lib/roles';
import QuorumSeal from '@/components/QuorumSeal';

const USES = [
  { title: 'Research and R&D', body: 'Trial results, patent filings and unpublished findings stay sealed until publication day.' },
  { title: 'Financial results', body: 'Quarterly results open only at the stock-exchange filing time, with every analyst’s copy traceable.' },
  { title: 'Board and M&A', body: 'Merger plans and board decks need three directors to open, and every copy carries its reader’s name.' },
  { title: 'Legal and government', body: 'Judgments before pronouncement, tender bids before opening, budget and policy drafts.' },
  { title: 'Exam papers', body: 'Setters fill a question pool, the paper is drawn at release, and each centre prints its own shuffled copies.' },
];

const FACTORS = [
  { title: 'Their key file', body: 'One share of the document’s key. Any k of N shares open it; fewer reveal nothing.' },
  { title: 'Their authenticator code', body: 'The 6-digit code from Google Authenticator or a similar app. It changes every 30 seconds and works once.' },
  { title: 'Their own face', body: 'A live scan: look straight, turn left, turn right, in a random order, checked on the server.' },
];

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && user) router.replace(homeFor(user.role));
  }, [loading, user, router]);

  return (
    <div className="space-y-14 py-4 md:py-8">
      <div className="grid items-center gap-10 md:grid-cols-[1fr_auto] md:gap-16">
        <div className="max-w-xl">
          <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">Confidential documents that no single person can open early.</h1>
          <p className="mt-5 text-lg leading-relaxed text-ink-soft">
            SealedPaper encrypts a document the moment it is uploaded and splits its key among several officials. It opens
            only after a set time, when enough of them unlock it together. Every copy it hands out carries its reader’s name
            and a unique code, so a leak points back to its source.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/login" className="btn-primary">Log in</Link>
            <Link href="/register" className="btn-quiet">Create an account</Link>
          </div>
        </div>
        <div className="justify-self-center">
          <QuorumSeal total={5} threshold={3} submitted={2} released={false} size={280} />
        </div>
      </div>

      <section>
        <h2 className="text-xl font-bold">Built for anything that must not leak before its time</h2>
        <div className="mt-5 grid gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-5">
          {USES.map((u) => (
            <div key={u.title} className="bg-panel p-5">
              <h3 className="font-semibold">{u.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{u.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold">Each official who unlocks a document brings three things</h2>
        <div className="mt-5 grid gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-3">
          {FACTORS.map((f) => (
            <div key={f.title} className="bg-panel p-5">
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{f.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
