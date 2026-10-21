// The quorum seal: one ring segment per key custodian (N), filled as keys come in.
// The wax-red centre turns green once the document is released.
// Purely visual; every number is also given as text for screen readers.

function arcPath(cx, cy, r, startDeg, endDeg) {
  const rad = (d) => ((d - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(startDeg));
  const y1 = cy + r * Math.sin(rad(startDeg));
  const x2 = cx + r * Math.cos(rad(endDeg));
  const y2 = cy + r * Math.sin(rad(endDeg));
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

export default function QuorumSeal({ total, threshold, submitted, released, size = 220, label = true }) {
  const c = 100;
  const gap = total > 1 ? 7 : 0;
  const seg = 360 / total;
  const centreColor = released ? 'var(--color-open)' : 'var(--color-wax)';
  const description = released
    ? `Released with ${submitted} of ${total} keys`
    : `${submitted} of ${threshold} required keys submitted, ${total} custodians in total`;

  return (
    <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-label={description}>
      {/* guilloche rosette */}
      <g fill="none" stroke="var(--color-line)" strokeWidth="0.6" opacity="0.9">
        {Array.from({ length: 18 }, (_, i) => (
          <ellipse key={i} cx={c} cy={c} rx="94" ry="40" transform={`rotate(${i * 10} ${c} ${c})`} />
        ))}
      </g>
      {/* one segment per custodian */}
      <g fill="none" strokeWidth="13" strokeLinecap="butt">
        {Array.from({ length: total }, (_, i) => {
          const filled = i < submitted;
          return (
            <path
              key={i}
              d={arcPath(c, c, 72, i * seg + gap / 2, (i + 1) * seg - gap / 2)}
              stroke={filled ? centreColor : 'var(--color-panel)'}
              strokeOpacity={1}
            />
          );
        })}
      </g>
      <g fill="none" strokeWidth="1" stroke="var(--color-ink-soft)">
        {Array.from({ length: total }, (_, i) => (
          <path key={i} d={arcPath(c, c, 79, i * seg + gap / 2, (i + 1) * seg - gap / 2)} />
        ))}
      </g>
      {/* wax centre */}
      <circle cx={c} cy={c} r="56" fill={centreColor} />
      <circle cx={c} cy={c} r="50" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="2 3" />
      {label && (
        <g fill="#fff" textAnchor="middle" fontFamily="var(--font-sans)">
          {released ? (
            <text x={c} y={c + 8} fontSize="24" fontWeight="700">Open</text>
          ) : (
            <>
              <text x={c} y={c + 6} fontSize="30" fontWeight="700">
                {submitted}/{threshold}
              </text>
              <text x={c} y={c + 26} fontSize="11" opacity="0.85">keys in</text>
            </>
          )}
        </g>
      )}
    </svg>
  );
}

/** Small static mark for the header. */
export function SealMark({ className }) {
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="14" opacity="0.9">
        {Array.from({ length: 5 }, (_, i) => (
          <path key={i} d={arcPath(100, 100, 84, i * 72 + 6, (i + 1) * 72 - 6)} />
        ))}
      </g>
      <circle cx="100" cy="100" r="54" fill="var(--color-wax)" />
    </svg>
  );
}
