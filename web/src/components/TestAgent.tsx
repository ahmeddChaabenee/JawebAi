import { useEffect, useRef, useState } from 'react';

import type { Message, clientApi } from '../lib/api.ts';
import { Card, CardHead, Empty, Spinner, when } from './ui.tsx';

type ClientApi = ReturnType<typeof clientApi>;

const newSession = () => 'test-' + Math.random().toString(36).slice(2, 10);

/**
 * Conversation reelle avec l'assistant du client : meme prompt, memes
 * documents, memes garde-fous.
 *
 * Les echanges passent par le canal internal_test, exclu des vues KPI :
 * verifier son assistant ne doit pas gonfler son propre taux de resolution.
 */
export function TestAgent({ api }: { api: ClientApi }) {
  const [session, setSession] = useState(newSession);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const afterRef = useRef(0);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, waiting]);

  // Le worker traite en asynchrone : on interroge jusqu'a voir arriver un tour
  // qui ne vient pas du client.
  useEffect(() => {
    if (!waiting) return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      try {
        const fresh = await api.testMessages(session, afterRef.current);
        if (fresh.length) {
          afterRef.current = Math.max(afterRef.current, ...fresh.map((m) => m.id));
          setMessages((prev) => [...prev, ...fresh]);
          if (fresh.some((m) => m.sender !== 'user')) setWaiting(false);
        }
      } catch { setWaiting(false); }
      if (tries > 40) { setWaiting(false); setTimedOut(true); }
    }, 1500);
    return () => clearInterval(timer);
  }, [waiting, session, api]);

  async function send() {
    const text = draft.trim();
    if (!text || waiting) return;
    setDraft(''); setTimedOut(false); setWaiting(true);
    try {
      await api.sendTest(session, text);
    } catch { setWaiting(false); }
  }

  function reset() {
    setSession(newSession());
    setMessages([]); afterRef.current = 0; setWaiting(false); setTimedOut(false);
  }

  return (
    <>
      <Card span={3}>
        <CardHead title="Tester votre assistant"
          sub="exactement ce que voient vos clients — ces échanges ne comptent pas dans vos statistiques"
          right={<button className="btn ghost" onClick={reset}>Nouvelle session</button>} />
        <div className="chat">
          <div className="chat-log" ref={logRef}>
            {messages.length === 0 && !waiting && <Empty>Posez une question à votre assistant.</Empty>}
            {messages.map((m) => (
              <div key={m.id} className={`msg m-${m.sender}`}>
                {m.content}
                {m.sender !== 'user' && (
                  <div className="meta">
                    {m.latency_ms ? `${m.latency_ms} ms` : ''}
                    {m.tokens_in ? ` · ${m.tokens_in}/${m.tokens_out} tokens` : ''}
                    {m.retrieval_score ? ` · pertinence ${Number(m.retrieval_score).toFixed(2)}` : ''}
                  </div>
                )}
              </div>
            ))}
            {waiting && <div className="msg m-assistant"><Spinner /></div>}
            {timedOut && (
              <div className="msg m-system">
                Aucune réponse. Le service de traitement (worker) est-il démarré&nbsp;?
              </div>
            )}
          </div>
          <div className="chat-bar">
            <textarea rows={2} value={draft} placeholder="Écrivez comme le ferait un client…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }} />
            <button className="btn" disabled={waiting} onClick={send}>Envoyer</button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHead title="Quoi essayer" sub="pour vérifier votre assistant" />
        <div className="legend" style={{ gap: 11 }}>
          <div>Une question dont la réponse est dans vos documents — tarifs, horaires.</div>
          <div>Une question dans la langue de vos clients, y compris en arabizi.</div>
          <div>Un service que vous ne proposez pas : l'assistant doit répondre qu'il n'existe pas.</div>
          <div>Une question hors sujet : elle doit arriver dans « À répondre ».</div>
        </div>
        <div className="sub" style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          Session <span className="mono">{session}</span><br />
          Vos essais sont conservés : retrouvez-les dans <b>Conversations</b>,
          en cochant « afficher mes essais ».
        </div>
      </Card>
    </>
  );
}
