'use client';

import { formatDateTime } from '@/lib/api';

export function PaperStatus({ status }) {
  const map = {
    draft: ['Collecting questions', 'bg-wait-soft text-wait'],
    sealed: ['Sealed', 'bg-wax-soft text-wax'],
    released: ['Released', 'bg-open-soft text-open'],
  };
  const [text, cls] = map[status] || [status, 'bg-panel'];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-sm font-semibold ${cls}`}>{text}</span>;
}

/** The paper's life as three stages; the current one is highlighted. */
export function PaperTimeline({ paper }) {
  const stages = [
    { key: 'draft', title: 'Question pool open', when: `Until ${formatDateTime(paper.sealDeadline)}`,
      body: 'Setters add questions. Nobody sees the final paper because it does not exist yet.' },
    { key: 'sealed', title: 'Sealed', when: `Unlocks ${formatDateTime(paper.unlockAt)}`,
      body: `The key is split among ${paper.totalSharesN} custodians and deleted. ${paper.thresholdK} must unlock it together.` },
    { key: 'released', title: 'Released and printed', when: `Exam starts ${formatDateTime(paper.examStart)}`,
      body: 'Questions are drawn now. Each centre prints its own shuffled, numbered copies.' },
  ];
  const at = stages.findIndex((s) => s.key === paper.status);
  return (
    <ol className="grid gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-3">
      {stages.map((s, i) => (
        <li key={s.key} aria-current={i === at ? 'step' : undefined}
          className={`p-4 ${i === at ? 'bg-ink text-paper' : i < at ? 'bg-open-soft' : 'bg-panel'}`}>
          <p className={`text-sm font-semibold ${i === at ? 'text-paper/80' : i < at ? 'text-open' : 'text-ink-soft'}`}>
            {i < at ? 'Done' : i === at ? 'Now' : 'Next'}
          </p>
          <p className="mt-1 font-bold">{s.title}</p>
          <p className={`text-sm ${i === at ? 'text-paper/85' : 'text-ink-soft'}`}>{s.when}</p>
          <p className={`mt-2 text-sm leading-relaxed ${i === at ? 'text-paper/80' : 'text-ink-soft'}`}>{s.body}</p>
        </li>
      ))}
    </ol>
  );
}

export const DIFFICULTY = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

export function Table({ head, children, className = '' }) {
  return (
    <div className={`overflow-x-auto rounded-[10px] border border-line bg-panel ${className}`}>
      <table className="w-full text-left text-[15px]">
        <thead className="border-b border-line text-sm text-ink-soft">
          <tr>{head.map((h) => <th key={h} className="whitespace-nowrap px-4 py-2.5 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = '' }) {
  return <td className={`px-4 py-2.5 align-top ${className}`}>{children}</td>;
}
