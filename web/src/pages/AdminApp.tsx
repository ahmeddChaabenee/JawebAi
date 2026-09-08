import { useEffect, useMemo, useState } from 'react';

import { Shell, Who, type NavItem } from '../components/Shell.tsx';
import {
  ConversationsScreen, DocumentsScreen, GapsScreen, OverviewScreen, PendingScreen,
} from '../components/screens.tsx';
import { Card, Empty } from '../components/ui.tsx';
import { adminApi, checkAdminToken, type Tenant } from '../lib/api.ts';

const TITLES: Record<string, string> = {
  overview: "Vue d'ensemble", pending: 'À répondre',
  conversations: 'Conversations', gaps: 'Lacunes', documents: 'Documents',
};

/**
 * Back-office operateur.
 *
 * Difference de fond avec l'espace client : le tenant se choisit dans un
 * selecteur. C'est pourquoi cette URL ne doit jamais etre donnee a un client --
 * elle lui montrerait les autres.
 */
export function AdminApp() {
  const [token, setToken] = useState(() => localStorage.getItem('admin_token') ?? '');
  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [tenantId, setTenantId] = useState('');
  const [screen, setScreen] = useState('overview');
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!token) { setTenants(null); return; }
    checkAdminToken(token).then((list) => {
      if (!list) { localStorage.removeItem('admin_token'); setToken(''); setError('Jeton refusé.'); return; }
      setTenants(list);
      setTenantId((prev) => prev || list[0]?.id || '');
    });
  }, [token]);

  const api = useMemo(() => (tenantId ? adminApi(token, tenantId) : null), [token, tenantId]);

  useEffect(() => {
    api?.overview().then((o) => setPendingCount(o.pending_count?.n ?? 0)).catch(() => {});
  }, [api, screen]);

  if (!token || !tenants) {
    return (
      <div className="gate">
        <div className="card">
          <div className="brand" style={{ paddingBottom: 14 }}><span className="mark">◆</span> Back-office</div>
          <p className="sub" style={{ margin: '0 0 6px' }}>
            Jeton défini dans <code>ADMIN_TOKEN</code>.
          </p>
          <input type="password" placeholder="jeton" value={entry}
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { localStorage.setItem('admin_token', entry); setToken(entry); }
            }} />
          {error && <div className="err">{error}</div>}
          <button className="btn" style={{ width: '100%', marginTop: 12 }}
            onClick={() => { localStorage.setItem('admin_token', entry); setToken(entry); }}>
            Entrer
          </button>
        </div>
      </div>
    );
  }

  if (!api) return <div className="gate"><Card><Empty>Aucun client en base.</Empty></Card></div>;

  const tenant = tenants.find((t) => t.id === tenantId);
  const items: NavItem[] = [
    { key: 'overview', label: "Vue d'ensemble", icon: '▦' },
    { key: 'conversations', label: 'Conversations', icon: '▤' },
    { key: 'pending', label: 'À répondre', icon: '✉', badge: pendingCount || undefined },
    { key: 'gaps', label: 'Lacunes', icon: '◈' },
    { key: 'documents', label: 'Documents', icon: '▣' },
  ];

  return (
    <Shell
      brand="Back-office"
      items={items}
      current={screen}
      onNavigate={setScreen}
      title={TITLES[screen] ?? ''}
      right={
        <>
          <select className="pill" style={{ width: 'auto', cursor: 'pointer' }}
            value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <Who name={tenant?.name ?? '—'} sub="opérateur" />
        </>
      }
      footer={
        <>
          <div>{tenant?.slug} · {tenant?.status}</div>
          <button className="btn ghost" style={{ width: '100%', marginTop: 10, padding: 7 }}
            onClick={() => { localStorage.removeItem('admin_token'); setToken(''); }}>Quitter</button>
        </>
      }
    >
      {screen === 'overview' && <OverviewScreen api={api} forClient={false} />}
      {screen === 'conversations' && <ConversationsScreen api={api} allowTestFilter={false} />}
      {screen === 'pending' && <PendingScreen api={api} />}
      {screen === 'gaps' && <GapsScreen api={api} />}
      {screen === 'documents' && <DocumentsScreen api={api} />}
    </Shell>
  );
}
