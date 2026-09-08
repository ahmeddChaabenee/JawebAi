import { useEffect, useState } from 'react';

import type { Api, Conversation, Gap, Message, Overview, PendingQuestion } from '../lib/api.ts';
import { Bars, Donut, Legend, Ring, type Part } from './charts.tsx';
import { Card, CardHead, Empty, Kpi, Tag, num, when } from './ui.tsx';

const CHANNEL_COLORS: Record<string, string> = {
  web_widget: 'var(--blue)', messenger: 'var(--violet)',
  whatsapp: 'var(--green)', instagram: 'var(--amber)',
};

/** Charge une donnee au montage et expose l'etat, sans bibliotheque de data-fetching. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const reload = () => load().then(setData).catch(setError);
  useEffect(() => { reload(); }, deps);
  return { data, error, reload };
}

// ---------------------------------------------------------------------------

export function OverviewScreen({ api, forClient }: { api: Api; forClient: boolean }) {
  const { data } = useLoad<Overview>(() => api.overview());
  if (!data) return <Card span={4}><Empty>Chargement…</Empty></Card>;

  const k = data.kpis;
  const total = num(k?.total_conversations);
  const escalated = num(k?.escalated_conversations);
  const rate = k?.auto_resolution_rate == null ? null : Number(k.auto_resolution_rate);
  const costRaw = k?.total_cost_usd;
  const cost = costRaw == null ? null : Number(costRaw);
  const pending = data.pending_count?.n ?? 0;

  const channels: Part[] = data.channels.map((c) => ({
    key: c.kind, n: Number(c.n), color: CHANNEL_COLORS[c.kind] ?? 'var(--teal)',
  }));
  const issue: Part[] = [
    { key: 'résolues', n: total - escalated, color: 'var(--green)' },
    { key: 'escaladées', n: escalated, color: 'var(--red)' },
  ];

  return (
    <>
      <Kpi label="Conversations" value={total} icon="▤"
        delta={<><b className="up">{total - escalated}</b> {forClient ? 'traitées sans vous' : 'résolues sans humain'}</>} />
      <Kpi label="Résolution auto" value={rate == null ? '—' : `${Math.round(rate * 100)}%`} icon="✦"
        delta={rate == null ? undefined :
          rate >= 0.7 ? <b className="up">↑ bon niveau</b> : <b className="down">↓ à améliorer</b>} />
      <Kpi label="Messages" value={num(k?.total_messages)} icon="✉"
        delta={<><b>{num(k?.user_messages)}</b> {forClient ? 'de vos clients' : 'clients'}</>} />
      <Kpi label="À répondre" value={pending} icon="⚑"
        delta={pending ? <b className="down">action requise</b> : <b className="up">rien en attente</b>} />

      <Card span={2}>
        <CardHead title="Volume quotidien" sub="conversations démarrées, 30 jours" />
        <Bars series={data.daily.map((d) => ({ k: String(d.day).slice(8, 10), v: Number(d.conversations_started) }))} />
      </Card>

      <Card>
        <CardHead title="Canaux" sub={forClient ? "d'où viennent vos clients" : 'répartition'} />
        <Donut parts={channels} total={channels.reduce((a, b) => a + b.n, 0)} />
        <Legend parts={channels} />
      </Card>

      <Card>
        <CardHead title="Issue" sub="résolues vs escaladées" />
        <Donut parts={issue} total={total} />
        <Legend parts={issue} />
      </Card>

      <Card>
        <Ring pct={Math.min(1, (k?.latency_p50_ms ?? 0) / 10000)}
          label={forClient ? 'Temps de réponse' : 'Latence médiane'}
          value={k?.latency_p50_ms ? `${Math.round(k.latency_p50_ms)} ms` : '—'} />
        <div className="sub">
          {forClient ? '95 % sous ' : 'p95 · '}
          {k?.latency_p95_ms ? `${Math.round(k.latency_p95_ms)} ms` : '—'}
        </div>
      </Card>

      {!forClient && (
        <Card>
          <Ring pct={cost == null ? 0 : Math.min(1, cost)} label="Coût cumulé"
            value={cost == null ? 'non configuré' : `$${cost.toFixed(4)}`} color="var(--violet)" />
          <div className="sub">
            {num(k?.tokens_in)} tokens entrée · {num(k?.tokens_out)} sortie
            {cost == null && <><br /><span style={{ color: '#98a2b3' }}>renseigner LLM_PRICE_*_PER_M</span></>}
          </div>
        </Card>
      )}

      <Card span={forClient ? 3 : 2}>
        <CardHead title="Dernières conversations" sub={forClient ? 'vos clients, en direct' : '12 dernières'} />
        {data.recent.length === 0
          ? <Empty>Aucune conversation pour l'instant.</Empty>
          : (
            <table>
              <thead><tr><th>Client</th><th>Canal</th><th>Statut</th><th>Dernière question</th><th>Quand</th></tr></thead>
              <tbody>
                {data.recent.slice(0, 6).map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.session_key.slice(0, 22)}</td>
                    <td><Tag value={r.channel} /></td>
                    <td><Tag value={r.status} /></td>
                    <td className="trim">{r.last_question ?? '—'}</td>
                    <td className="mono">{when(r.last_message_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

export function Thread({ messages }: { messages: Message[] }) {
  return (
    <>
      {messages.map((m) => (
        <div key={m.id} className={`msg m-${m.sender}`}>
          {m.content}
          <div className="meta">
            {when(m.created_at)}
            {m.latency_ms ? ` · ${m.latency_ms} ms` : ''}
            {m.tokens_in ? ` · ${m.tokens_in}/${m.tokens_out} tokens` : ''}
            {m.retrieval_score ? ` · pertinence ${Number(m.retrieval_score).toFixed(2)}` : ''}
          </div>
        </div>
      ))}
    </>
  );
}

export function ConversationsScreen({ api, allowTestFilter }: { api: Api; allowTestFilter: boolean }) {
  const [withTests, setWithTests] = useState(false);
  const [thread, setThread] = useState<Message[] | null>(null);
  const { data } = useLoad<Conversation[]>(() => api.conversations(withTests), [withTests]);

  return (
    <>
      <Card span={4}>
        <CardHead title="Conversations" sub="cliquer pour lire l'échange"
          right={allowTestFilter ? (
            <label className="chk" style={{ whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={withTests} onChange={(e) => setWithTests(e.target.checked)} />
              afficher mes essais
            </label>
          ) : undefined} />
        {!data ? <Empty>Chargement…</Empty> : data.length === 0 ? (
          <Empty>
            Aucune conversation.
            {allowTestFilter && !withTests && <><br />Cochez « afficher mes essais » pour voir vos tests.</>}
          </Empty>
        ) : (
          <table>
            <thead><tr><th>Client</th><th>Canal</th><th>Statut</th><th>Msg</th><th>Quand</th></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} style={{ cursor: 'pointer' }}
                  onClick={() => api.messages(r.id).then(setThread)}>
                  <td className="mono">{r.session_key}</td>
                  <td>{r.channel === 'internal_test'
                    ? <Tag value="internal_test" label="essai" /> : <Tag value={r.channel} />}</td>
                  <td><Tag value={r.status} /></td>
                  <td>{r.message_count}</td>
                  <td className="mono">{when(r.last_message_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {thread && (
        <Card span={4}>
          <CardHead title="Échange" sub={`${thread.length} messages`} />
          <Thread messages={thread} />
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

export function PendingScreen({ api, onChange }: { api: Api; onChange?: () => void }) {
  const { data, reload } = useLoad<PendingQuestion[]>(() => api.pending());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [promote, setPromote] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function submit(id: string) {
    const answer = (drafts[id] ?? '').trim();
    if (!answer) return;
    setBusy(id);
    try {
      await api.answer(id, answer, promote[id] !== false);
      await reload();
      onChange?.();
    } finally { setBusy(null); }
  }

  return (
    <Card span={4}>
      <CardHead title="Questions en attente"
        sub="votre assistant n'a pas su répondre — le client attend" />
      {!data ? <Empty>Chargement…</Empty> : data.length === 0
        ? <Empty>Rien en attente. Votre assistant répond à tout.</Empty>
        : data.map((p) => (
          <div key={p.id} style={{ border: '1px solid var(--line)', borderRadius: 14, padding: 16, marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="mono">{p.session_key}</span>
              <span className="mono" style={{ marginLeft: 'auto' }}>{when(p.created_at)}</span>
            </div>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>{p.question}</div>
            <textarea rows={3} value={drafts[p.id] ?? ''}
              placeholder="Votre réponse, telle qu'elle sera envoyée au client…"
              onChange={(e) => setDrafts({ ...drafts, [p.id]: e.target.value })} />
            <div className="row" style={{ marginTop: 10 }}>
              <label className="chk">
                <input type="checkbox" checked={promote[p.id] !== false}
                  onChange={(e) => setPromote({ ...promote, [p.id]: e.target.checked })} />
                l'assistant pourra réutiliser cette réponse
              </label>
              <button className="btn" style={{ marginLeft: 'auto' }}
                disabled={busy === p.id} onClick={() => submit(p.id)}>
                {busy === p.id ? 'Envoi…' : 'Envoyer'}
              </button>
            </div>
          </div>
        ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function GapsScreen({ api }: { api: Api }) {
  const { data } = useLoad<Gap[]>(() => api.gaps());
  return (
    <Card span={4}>
      <CardHead title="Ce que vos clients demandent"
        sub="et que vos documents ne couvrent pas — ajoutez-les pour que l'assistant sache répondre" />
      {!data ? <Empty>Chargement…</Empty> : data.length === 0
        ? <Empty>Aucune lacune détectée.</Empty>
        : (
          <table>
            <thead><tr><th>Question</th><th>Posée</th><th>Dernière fois</th><th>Traitée</th></tr></thead>
            <tbody>
              {data.map((g, i) => (
                <tr key={i}>
                  <td>{g.question}</td>
                  <td><b>{g.times_asked}×</b></td>
                  <td className="mono">{when(g.last_asked_at)}</td>
                  <td>{g.has_human_answer ? <Tag value="active" label="répondue" /> : <Tag value="escalated" label="ouverte" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Card>
  );
}

export function DocumentsScreen({ api }: { api: Api }) {
  const { data } = useLoad<Overview>(() => api.overview());
  const docs = data?.documents ?? [];
  return (
    <Card span={4}>
      <CardHead title="Vos documents" sub="ce sur quoi l'assistant s'appuie pour répondre" />
      {docs.length === 0
        ? <Empty>La liste est vide.<br />L'ingestion tourne encore dans n8n et n'alimente pas encore cette table.</Empty>
        : (
          <table>
            <thead><tr><th>Nom</th><th>Statut</th><th>Extraits</th><th>Indexé le</th></tr></thead>
            <tbody>
              {docs.map((d, i) => (
                <tr key={i}>
                  <td>{d.name}</td><td><Tag value={d.status} /></td>
                  <td>{d.chunk_count ?? '—'}</td><td className="mono">{when(d.indexed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Card>
  );
}
