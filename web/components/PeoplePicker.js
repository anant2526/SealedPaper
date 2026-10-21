'use client';

import { roleName } from '@/lib/roles';

/** Checkbox list of people. */
export default function PeoplePicker({ people, selected, onToggle, empty }) {
  if (people.length === 0) return <p className="text-[15px] text-ink-soft">{empty}</p>;
  return (
    <ul className="divide-y divide-line rounded-md border border-line bg-white">
      {people.map((p) => (
        <li key={p.id}>
          <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2.5">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-ink)]" checked={selected.includes(p.id)} onChange={() => onToggle(p.id)} />
            <span className="font-medium">{p.name}</span>
            <span className="truncate text-sm text-ink-soft">{p.email}, {roleName(p.role).toLowerCase()}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}
