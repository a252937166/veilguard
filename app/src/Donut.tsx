/** Pure-SVG donut for the public outcome breakdown (no external chart lib). */
export function Donut({ segments, total, size = 132 }: {
  segments: { label: string; value: number; color: string }[];
  total: number;
  size?: number;
}) {
  const r = size / 2 - 12;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const shown = total || 1;

  return (
    <div className="donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="#1e2635" strokeWidth={14} />
        {segments.filter((s) => s.value > 0).map((s) => {
          const frac = s.value / shown;
          const dash = frac * circ;
          const el = (
            <circle key={s.label} cx={c} cy={c} r={r} fill="none" stroke={s.color} strokeWidth={14}
              strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${c} ${c})`} strokeLinecap="butt" />
          );
          offset += dash;
          return el;
        })}
        <text x={c} y={c - 2} textAnchor="middle" fill="#e8edf6" fontSize="26" fontWeight="800" fontFamily="ui-monospace,monospace">{total}</text>
        <text x={c} y={c + 16} textAnchor="middle" fill="#8b96ab" fontSize="10.5">requests</text>
      </svg>
      <div className="donut-legend">
        {segments.map((s) => (
          <div key={s.label} className="dl-row">
            <span className="dl-dot" style={{ background: s.color }} />
            <span className="dl-label">{s.label}</span>
            <span className="dl-val">{s.value}{total ? ` · ${Math.round((s.value / shown) * 100)}%` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
