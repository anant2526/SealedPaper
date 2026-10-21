// One place that turns a document's numbers into the words people see.
export function phaseOf(doc, now = Date.now()) {
  if (doc.status === 'released') return { key: 'released', text: 'Released', className: 'bg-open-soft text-open' };
  if (doc.status === 'revoked') return { key: 'revoked', text: 'Revoked', className: 'bg-wax-soft text-wax' };
  const opens = new Date(doc.submit_opens_at).getTime();
  if (now < opens) return { key: 'sealed', text: 'Sealed', className: 'bg-wax-soft text-wax' };
  if (doc.keys_submitted >= doc.threshold_k) {
    return { key: 'due', text: 'Quorum reached, opens at unlock time', className: 'bg-wait-soft text-wait' };
  }
  return { key: 'collecting', text: 'Collecting keys', className: 'bg-wait-soft text-wait' };
}

export function StatusPill({ doc }) {
  const p = phaseOf(doc);
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-sm font-semibold ${p.className}`}>{p.text}</span>;
}

export function countdown(target, now) {
  let s = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d} d ${h} h ${m} min`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min ${String(s).padStart(2, '0')} s`;
}
