'use client';

import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from './AuthProvider';
import FaceScan from './FaceScan';
import TotpSetup from './TotpSetup';

/** The face + authenticator part of registration. Used by /register and by /login for unfinished accounts. */
export default function Enrollment({ step, onStep }) {
  const { setUser } = useAuth();
  const router = useRouter();

  if (step === 'face') {
    return (
      <>
        <h2 className="mb-4 text-xl font-bold">Register your face</h2>
        <FaceScan
          intro="This scan becomes the reference for your account. You will repeat it at every login and every time you submit a key file."
          getChallenge={() => api('/auth/face-challenge', { method: 'POST' })}
          onFrames={async (challengeId, frames) => {
            await api('/auth/enroll/face', { method: 'POST', body: { challengeId, frames } });
            onStep('totp');
          }}
        />
      </>
    );
  }
  return (
    <>
      <h2 className="mb-4 text-xl font-bold">Link your authenticator app</h2>
      <TotpSetup
        onDone={(user) => {
          setUser(user);
          router.replace('/dashboard');
        }}
      />
    </>
  );
}
