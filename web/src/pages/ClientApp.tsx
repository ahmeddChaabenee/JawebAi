import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Shell, Who, type NavItem } from '../components/Shell.tsx';
import { TestAgent } from '../components/TestAgent.tsx';
import {
  ConversationsScreen, DocumentsScreen, GapsScreen, OverviewScreen, PendingScreen,
} from '../components/screens.tsx';
import { Card, Empty } from '../components/ui.tsx';
import { Unauthorized, clientApi, type SessionUser } from '../lib/api.ts';

const TITLES: Record<string, string> = {
  overview: "Vue d'ensemble", test: "Tester l'agent", pending: 'À répondre',
  conversations: 'Conversations', gaps: 'Lacunes', documents: 'Documents',
};

export function ClientApp({ token, onSignedOut }: { token: string; onSignedOut: () => void }) {
  const api = useMemo(() => clientApi(token), [token]);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [screen, setScreen] = useState('overview');
  const [pendingCount, setPendingCount] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    api.me()
      .then((r) => setUser(r.user))
      .catch((err) => { if (err instanceof Unauthorized) { onSignedOut(); navigate('/login'); } });
  }, [api]);

  const refreshBadge = () => api.overview().then((o) => setPendingCount(o.pending_count?.n ?? 0)).catch(() => {});
  useEffect(() => { refreshBadge(); }, [api, screen]);

  if (!user) return <div className="gate"><Card><Empty>Chargement…</Empty></Card></div>;

  const items: NavItem[] = [
    { key: 'overview', label: "Vue d'ensemble", icon: '▦' },
    { key: 'test', label: "Tester l'agent", icon: '◐' },
    { key: 'pending', label: 'À répondre', icon: '✉', badge: pendingCount || undefined },
    { key: 'conversations', label: 'Conversations', icon: '▤' },
    { key: 'gaps', label: 'Lacunes', icon: '◈' },
    { key: 'documents', label: 'Documents', icon: '▣' },
  ];

  async function signOut() {
    try { await api.logout(); } catch { /* la session sera de toute facon oubliee */ }
    onSignedOut();
    navigate('/');
  }

  return (
    <Shell
      brand={user.tenant_name}
      items={items}
      current={screen}
      onNavigate={setScreen}
      title={TITLES[screen] ?? ''}
      right={<Who name={user.name || user.email} sub={user.role === 'owner' ? 'responsable' : 'équipe'} />}
      footer={
        <>
          <div>{user.email}</div>
          <button className="btn ghost" style={{ width: '100%', marginTop: 10, padding: 7 }}
            onClick={signOut}>Déconnexion</button>
        </>
      }
    >
      {screen === 'overview' && <OverviewScreen api={api} forClient />}
      {screen === 'test' && <TestAgent api={api} />}
      {screen === 'pending' && <PendingScreen api={api} onChange={refreshBadge} />}
      {screen === 'conversations' && <ConversationsScreen api={api} allowTestFilter />}
      {screen === 'gaps' && <GapsScreen api={api} />}
      {screen === 'documents' && <DocumentsScreen api={api} />}
    </Shell>
  );
}
