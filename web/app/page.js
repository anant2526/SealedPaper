'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import QuorumSeal from '@/components/QuorumSeal';

const FACTORS = [
  { title: 'Their key file', body: 'A one-time file holding one share of the paper’s key. It works for one document and one person only.' },
  { title: 'Their authenticator code', body: 'The 6-digit code from Google Authenticator or a similar app. It changes every 30 seconds and cannot be reused.' },
  { title: 'Their own face', body: 'A live scan in which they look straight and turn left and right, checked on the server against the face they registered.' },
];

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [loading, user, router]);

  return (
    <div className="grid items-center gap-10 py-4 md:grid-cols-[1fr_auto] md:gap-16 md:py-10">
      <div className="max-w-xl">
        <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">An exam paper that no single official can open.</h1>
        <p className="mt-5 text-lg leading-relaxed text-ink-soft">
          SealedPaper encrypts a paper the moment it is uploaded and splits its key among several officials. It opens only
          after the unlock time, once enough of them unlock it together.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/login" className="btn-primary">Log in</Link>
          <Link href="/register" className="btn-quiet">Create an account</Link>
        </div>
      </div>
      <div className="justify-self-center">
        <QuorumSeal total={5} threshold={3} submitted={2} released={false} size={280} />
      </div>

      <section className="md:col-span-2">
        <h2 className="text-xl font-bold">Each official who unlocks a paper brings three things</h2>
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
