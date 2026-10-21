// Numbered progress for multi-step flows (registration, login). The content IS a sequence.
export default function Steps({ steps, current }) {
  return (
    <ol className="mb-8 flex flex-wrap gap-x-6 gap-y-2 text-[15px]">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'now' : 'later';
        return (
          <li key={s} aria-current={state === 'now' ? 'step' : undefined} className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${
                state === 'done' ? 'bg-open text-white' : state === 'now' ? 'bg-ink text-paper' : 'border border-line text-ink-soft'
              }`}
            >
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span className={state === 'later' ? 'text-ink-soft' : 'font-semibold'}>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}
