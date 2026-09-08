import type { ReactNode } from 'react';

export interface NavItem {
  key: string;
  label: string;
  icon: string;
  badge?: number;
}

export function Shell({ brand, items, current, onNavigate, title, right, footer, children }: {
  brand: string;
  items: NavItem[];
  current: string;
  onNavigate: (key: string) => void;
  title: string;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><span className="mark">◆</span> {brand}</div>
        <nav className="nav">
          {items.map((it) => (
            <a key={it.key} className={it.key === current ? 'on' : ''}
              onClick={() => onNavigate(it.key)}>
              <span className="ico">{it.icon}</span> {it.label}
              {it.badge ? <span className="badge">{it.badge}</span> : null}
            </a>
          ))}
        </nav>
        <div className="side-foot">{footer}</div>
      </aside>

      <main className="main">
        <header className="top">
          <h1>{title}</h1>
          <span className="pill">30 derniers jours</span>
          {right}
        </header>
        <div className="grid">{children}</div>
      </main>
    </div>
  );
}

export function Who({ name, sub }: { name: string; sub: string }) {
  return (
    <div className="who">
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontWeight: 600 }}>{name}</div>
        <div className="sub">{sub}</div>
      </div>
      <div className="avatar">{name.slice(0, 2).toUpperCase()}</div>
    </div>
  );
}
