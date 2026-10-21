'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** Shows the QR code for an authenticator app and confirms the first code. */
export default function TotpSetup({ onDone }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/enroll/totp', { method: 'POST' }).then(setSetup).catch((e) => setError(e.message));
  }, []);

  async function confirm(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api('/auth/enroll/totp/confirm', { method: 'POST', body: { code } });
      onDone(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="panel p-6">
      <p className="max-w-prose text-[15px] leading-relaxed text-ink-soft">
        Open Google Authenticator, Microsoft Authenticator or any TOTP app, add an account and scan this code. You will
        type the 6-digit code it shows whenever you collect or use a key file.
      </p>
      {setup && (
        <div className="mt-5 flex flex-wrap items-center gap-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qrDataUrl} alt="QR code for your authenticator app" width={180} height={180} className="rounded-md border border-line bg-white p-2" />
          <div className="text-sm text-ink-soft">
            <p>Cannot scan? Enter this key by hand:</p>
            <p className="mt-1 select-all break-all font-semibold tracking-wider text-ink">{setup.secret}</p>
          </div>
        </div>
      )}
      <form onSubmit={confirm} className="mt-6 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">Code from the app</span>
          <input
            className="field w-40 text-center text-xl tracking-[0.3em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
          />
        </label>
        <button className="btn-primary" disabled={busy || code.length !== 6}>
          {busy ? 'Checking…' : 'Confirm code'}
        </button>
      </form>
      {error && <p role="alert" className="mt-3 text-[15px] text-wax">{error}</p>}
    </div>
  );
}
