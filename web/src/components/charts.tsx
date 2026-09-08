/**
 * Graphiques en SVG, sans bibliotheque.
 *
 * Un donut, des barres et un anneau font une vingtaine de lignes chacun. Une
 * bibliotheque de graphiques apporterait ici plus de poids et de surface de
 * mise a jour que de valeur.
 */

export interface Part { key: string; n: number; color: string }

export function Donut({ parts, total }: { parts: Part[]; total: number }) {
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = parts.filter((p) => p.n > 0).map((p) => {
    const len = total ? (p.n / total) * C : 0;
    const el = (
      <circle key={p.key} cx="70" cy="70" r={R} fill="none" stroke={p.color} strokeWidth="18"
        strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}
        transform="rotate(-90 70 70)" />
    );
    offset += len;
    return el;
  });
  return (
    <svg viewBox="0 0 140 140" width="140" height="140" style={{ display: 'block', margin: '2px auto' }}>
      <circle cx="70" cy="70" r={R} fill="none" stroke="#f2f4f7" strokeWidth="18" />
      {arcs}
      <text x="70" y="76" textAnchor="middle" fontSize="24" fontWeight="700" fill="#101828">{total}</text>
    </svg>
  );
}

export function Legend({ parts }: { parts: Part[] }) {
  if (parts.length === 0) return <div className="legend"><div>aucun</div></div>;
  return (
    <div className="legend">
      {parts.map((p) => (
        <div key={p.key}>
          <span className="dot" style={{ background: p.color }} />
          {p.key} · <b style={{ color: 'var(--ink)' }}>{p.n}</b>
        </div>
      ))}
    </div>
  );
}

export function Bars({ series }: { series: { k: string; v: number }[] }) {
  const W = 620, H = 190, pad = 26;
  const max = Math.max(1, ...series.map((d) => d.v));
  const step = (W - pad * 2) / Math.max(1, series.length);
  const bw = Math.max(4, step - 7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
      {series.map((d, i) => {
        const x = pad + i * step;
        const h = Math.round((d.v / max) * (H - 46));
        return (
          <g key={i}>
            {/* barre fantome : donne l'echelle meme quand la valeur est nulle */}
            <rect x={x} y={8} width={bw} height={H - 38} rx="4" fill="#f2f4f7" />
            <rect x={x} y={H - 30 - h} width={bw} height={h} rx="4" fill="var(--blue)">
              <title>{`${d.k} : ${d.v}`}</title>
            </rect>
            {(series.length <= 12 || i % 5 === 0) && (
              <text x={x + bw / 2} y={H - 10} fontSize="10" fill="#98a2b3" textAnchor="middle">{d.k}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function Ring({ pct, label, value, color = 'var(--blue)' }:
  { pct: number; label: string; value: string; color?: string }) {
  const R = 26, C = 2 * Math.PI * R;
  const len = C * Math.max(0, Math.min(1, pct));
  return (
    <div className="card-head">
      <div><h3>{label}</h3><div className="sub">{value}</div></div>
      <svg viewBox="0 0 64 64" width="62" height="62">
        <circle cx="32" cy="32" r={R} fill="none" stroke="#f2f4f7" strokeWidth="7" />
        <circle cx="32" cy="32" r={R} fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={`${len} ${C}`} strokeLinecap="round" transform="rotate(-90 32 32)" />
        <text x="32" y="36" textAnchor="middle" fontSize="13" fontWeight="700" fill="#101828">
          {Math.round(pct * 100)}%
        </text>
      </svg>
    </div>
  );
}
