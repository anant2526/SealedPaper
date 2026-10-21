'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import Steps from '@/components/Steps';
import Enrollment from '@/components/Enrollment';

const STEP_NAMES = ['Your details', 'Face scan', 'Authenticator app'];
const STEP_INDEX = { details: 0, face: 1, totp: 2 };

export default function RegisterPage() {
  const [step, setStep] = useState('details');
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirm) return setError('The two passwords do not match');
    setBusy(true);
    try {
      const { next } = await api('/auth/register', {
        method: 'POST',
        body: { name: form.name, email: form.email, password: form.password },
      });
      setStep(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Create your account</h1>
      <Steps steps={STEP_NAMES} current={STEP_INDEX[step]} />

      {step === 'details' ? (
        <form onSubmit={submit} className="panel space-y-4 p-6">
          <label className="block">
            <span className="label">Full name</span>
            <input className="field" value={form.name} onChange={set('name')} autoComplete="name" required minLength={2} />
          </label>
          <label className="block">
            <span className="label">Email</span>
            <input className="field" type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block">
                <span className="label">Password</span>
                <input className="field" type="password" value={form.password} onChange={set('password')} autoComplete="new-password"
                  required minLength={10} aria-describedby="pw-hint" />
              </label>
              <span id="pw-hint" className="mt-1 block text-sm text-ink-soft">At least 10 characters</span>
            </div>
            <label className="block">
              <span className="label">Repeat password</span>
              <input className="field" type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
            </label>
          </div>
          {error && <p role="alert" className="text-[15px] text-wax">{error}</p>}
          <div className="flex flex-wrap items-center gap-4 pt-2">
            <button className="btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Continue to face scan'}</button>
            <Link href="/login" className="text-[15px] text-ink-soft underline underline-offset-2">I already have an account</Link>
          </div>
          <p className="text-sm text-ink-soft">The first account on a new installation becomes the exam controller.</p>
        </form>
      ) : (
        <Enrollment step={step} onStep={setStep} />
      )}
    </div>
  );
}
