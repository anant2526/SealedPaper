'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import Steps from '@/components/Steps';
import FaceScan from '@/components/FaceScan';
import Enrollment from '@/components/Enrollment';

export default function LoginPage() {
  const { user, setUser, loading } = useAuth();
  const router = useRouter();
  const [stage, setStage] = useState('password');   // password | face-login | face | totp
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [loading, user, router]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { next } = await api('/auth/login', { method: 'POST', body: form });
      setStage(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const unfinished = stage === 'face' || stage === 'totp';

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">{unfinished ? 'Finish setting up your account' : 'Log in'}</h1>
      {!unfinished && <Steps steps={['Password', 'Face scan']} current={stage === 'password' ? 0 : 1} />}

      {stage === 'password' && (
        <form onSubmit={submit} className="panel space-y-4 p-6">
          <label className="block">
            <span className="label">Email</span>
            <input className="field" type="email" autoComplete="email" required value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input className="field" type="password" autoComplete="current-password" required value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          {error && <p role="alert" className="text-[15px] text-wax">{error}</p>}
          <div className="flex flex-wrap items-center gap-4 pt-2">
            <button className="btn-primary" disabled={busy}>{busy ? 'Checking…' : 'Continue to face scan'}</button>
            <Link href="/register" className="text-[15px] text-ink-soft underline underline-offset-2">Create an account</Link>
          </div>
        </form>
      )}

      {stage === 'face-login' && (
        <FaceScan
          intro="Your password is correct. Now confirm it is really you."
          startLabel="Start face scan"
          getChallenge={() => api('/auth/face-challenge', { method: 'POST' })}
          onFrames={async (challengeId, frames) => {
            const { user } = await api('/auth/login/face', { method: 'POST', body: { challengeId, frames } });
            setUser(user);
            router.replace('/dashboard');
          }}
        />
      )}

      {unfinished && <Enrollment step={stage} onStep={setStage} />}
    </div>
  );
}
