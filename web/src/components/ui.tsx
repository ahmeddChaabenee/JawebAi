import type { ReactNode } from 'react';

export function Card({ span, children, className = '' }:
  { span?: 2 | 3 | 4; children: ReactNode; className?: string }) {
  return <div className={`card ${span ? 'c' + span : ''} ${className}`}>{children}</div>;
}

export function CardHead({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="card-head">
      <div><h3>{title}</h3>{sub && <div className="sub">{sub}</div>}</div>
      {right}
    </div>
  );
}

export function Kpi({ label, value, icon, delta }:
  { label: string; value: ReactNode; icon: string; delta?: ReactNode }) {
  return (
    <div className="card kpi">
      <div className="card-head"><h3>{label}</h3><span className="sq">{icon}</span></div>
      <div className="val">{value}</div>
      <div className="delta">{delta ?? <span style={{ color: '#98a2b3' }}>—</span>}</div>
    </div>
  );
}

export function Tag({ value, label }: { value: string; label?: string }) {
  return <span className={`tag t-${value}`}>{label ?? value}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner() {
  return <span className="typing"><i /><i /><i /></span>;
}

/** Formatage court, homogene dans toute l'interface. */
export const when = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('fr-FR',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export const num = (v: string | number | null | undefined) => Number(v ?? 0);
