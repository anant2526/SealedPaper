'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, formatDateTime } from '@/lib/api';
import { useRequireAuth } from '@/components/AuthProvider';
import QuorumSeal from '@/components/QuorumSeal';
import { StatusPill } from '@/components/status';

function myPart(doc) {
  if (doc.i_am_custodian) {
    if (doc.my_key_submitted) return `Your key ${doc.my_share_index} is in`;
    if (doc.my_key_picked_up_at) return `You hold key ${doc.my_share_index}`;
    return `Key ${doc.my_share_index} is waiting for you to collect`;
  }
  if (doc.i_am_recipient) return 'You can download it after release';
  return null;
}

export default function Dashboard() {
  const { user, ready } = useRequireAuth();
  const [docs, setDocs] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ready) return;
    const load = () => api('/documents').then((r) => setDocs(r.documents)).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [ready]);

  if (!ready) return null;
  const isAdmin = user.role === 'admin';

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Documents</h1>
          <p className="mt-1 text-ink-soft">
            {isAdmin ? 'Every sealed and released document.' : 'Documents where you hold a key or may download the paper.'}
          </p>
        </div>
        {isAdmin && <Link href="/documents/new" className="btn-wax">Seal a new document</Link>}
      </div>

      {error && <p role="alert" className="text-wax">{error}</p>}
      {docs && docs.length === 0 && (
        <div className="panel p-8">
          <p className="text-lg font-semibold">{isAdmin ? 'No documents yet.' : 'Nothing is assigned to you yet.'}</p>
          <p className="mt-1 text-ink-soft">
            {isAdmin
              ? 'Upload a paper, choose its key custodians and an unlock time, and it is sealed straight away.'
              : 'The exam controller will add you as a key custodian or a recipient.'}
          </p>
        </div>
      )}

      {docs && docs.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-panel">
          {docs.map((d) => (
            <li key={d.document_id}>
              <Link href={`/documents/${d.document_id}`} className="flex items-center gap-4 px-4 py-4 hover:bg-white sm:gap-6 sm:px-5">
                <QuorumSeal total={d.total_shares_n} threshold={d.threshold_k} submitted={d.keys_submitted} released={d.status === 'released'} size={56} label={false} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-semibold">{d.title}</p>
                  <p className="text-[15px] text-ink-soft">
                    {d.status === 'released' ? `Released ${formatDateTime(d.released_at)}` : `Unlocks ${formatDateTime(d.unlock_at)}`}
                    {', '}
                    {d.threshold_k} of {d.total_shares_n} keys needed
                  </p>
                  {myPart(d) && <p className="mt-0.5 text-[15px] font-medium">{myPart(d)}</p>}
                </div>
                <StatusPill doc={d} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
