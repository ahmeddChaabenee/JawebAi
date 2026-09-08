import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';

import type { Db } from '../db.ts';
import { recordInboundEvent } from '../db.ts';
import { login, logout, resolveSession, type SessionUser } from '../auth.ts';

type Vars = { user: SessionUser };

export function createClientApp(db: Db) {
  const app = new Hono<{ Variables: Vars }>();

  app.post('/api/login', async (c) => {
    let body: { email?: string; password?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'json invalide' }, 400);
    }
    const email = body.email?.trim();
    const password = body.password ?? '';
    if (!email || !password) return c.json({ error: 'email et mot de passe requis' }, 400);

    const result = await login(db, email, password, c.req.header('user-agent'));
    // Un seul message pour "compte inconnu" et "mot de passe faux" : distinguer
    // les deux revient a publier la liste des adresses enregistrees.
    if (!result) return c.json({ error: 'identifiants incorrects' }, 401);

    return c.json({ token: result.token, user: result.user });
  });

  /**
   * Toute la suite est bornee au client de la session.
   *
   * Le tenant_id vient d'ici et de nulle part ailleurs. C'est la seule
   * difference de fond avec le back-office operateur, ou il est choisi
   * librement dans un selecteur.
   */
  app.use('/api/*', async (c, next) => {
    if (c.req.path.endsWith('/api/login')) return next();
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const user = await resolveSession(db, token);
    if (!user) return c.json({ error: 'session expiree' }, 401);
    c.set('user', user);
    await next();
  });

  app.post('/api/logout', async (c) => {
    const header = c.req.header('authorization') ?? '';
    await logout(db, header.startsWith('Bearer ') ? header.slice(7) : undefined);
    return c.json({ ok: true });
  });

  app.get('/api/me', (c) => c.json({ user: c.get('user') }));

  app.get('/api/overview', async (c) => {
    const t = c.get('user').tenant_id;

    const kpis = await db.query(`SELECT * FROM v_tenant_kpis WHERE tenant_id = $1`, [t]);
    const daily = await db.query(
      `SELECT day, conversations_started, messages
         FROM v_tenant_daily_usage WHERE tenant_id = $1 ORDER BY day`,
      [t],
    );
    const channels = await db.query(
      `SELECT tc.kind, count(c.id)::int AS n
         FROM tenant_channels tc
         LEFT JOIN conversations c ON c.channel_id = tc.id
        WHERE tc.tenant_id = $1 AND tc.kind <> 'internal_test'
        GROUP BY tc.kind ORDER BY n DESC`,
      [t],
    );
    const recent = await db.query(
      `SELECT c.id, c.session_key, c.status, c.last_message_at, tc.kind AS channel,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT m.content FROM messages m
                WHERE m.conversation_id = c.id AND m.sender = 'user'
                ORDER BY m.id DESC LIMIT 1) AS last_question
         FROM conversations c
         JOIN tenant_channels tc ON tc.id = c.channel_id
        WHERE c.tenant_id = $1 AND tc.kind <> 'internal_test'
        ORDER BY c.last_message_at DESC LIMIT 15`,
      [t],
    );
    const pending = await db.query(
      `SELECT count(*)::int AS n FROM pending_answers WHERE tenant_id = $1 AND status = 'pending'`,
      [t],
    );
    const docs = await db.query(
      `SELECT name, status, chunk_count, indexed_at FROM v_document_freshness
        WHERE tenant_id = $1 ORDER BY indexed_at DESC NULLS LAST LIMIT 10`,
      [t],
    );

    return c.json({
      kpis: kpis.rows[0] ?? null,
      daily: daily.rows,
      channels: channels.rows,
      recent: recent.rows,
      pending_count: pending.rows[0] ?? { n: 0 },
      documents: docs.rows,
    });
  });

  /**
   * Liste des conversations.
   *
   * Les essais faits depuis "Tester l'agent" sont exclus par defaut -- ils ne
   * representent pas de vrais clients -- mais restent consultables sur demande.
   * Ne pas compter dans les statistiques et ne pas etre consultable sont deux
   * choses differentes : les donnees existent, elles doivent etre atteignables.
   */
  app.get('/api/conversations', async (c) => {
    const includeTests = c.req.query('include_tests') === '1';
    const { rows } = await db.query(
      `SELECT c.id, c.session_key, c.status, c.last_message_at, tc.kind AS channel,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT m.content FROM messages m
                WHERE m.conversation_id = c.id AND m.sender = 'user'
                ORDER BY m.id DESC LIMIT 1) AS last_question
         FROM conversations c
         JOIN tenant_channels tc ON tc.id = c.channel_id
        WHERE c.tenant_id = $1
          AND ($2 OR tc.kind <> 'internal_test')
        ORDER BY c.last_message_at DESC LIMIT 60`,
      [c.get('user').tenant_id, includeTests],
    );
    return c.json({ conversations: rows });
  });

  app.get('/api/conversations/:id', async (c) => {
    // Le tenant_id dans le WHERE n'est pas decoratif : sans lui, changer l'id
    // dans l'URL donnerait acces a la conversation d'un autre client.
    const { rows } = await db.query(
      `SELECT m.id, m.sender, m.content, m.created_at, m.latency_ms,
              m.tokens_in, m.tokens_out, m.model, m.retrieval_score, m.escalated
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1 AND c.tenant_id = $2
        ORDER BY m.id`,
      [c.req.param('id'), c.get('user').tenant_id],
    );
    return c.json({ messages: rows });
  });

  app.get('/api/pending', async (c) => {
    const { rows } = await db.query(
      `SELECT p.id, p.question, p.created_at, p.conversation_id, c.session_key
         FROM pending_answers p
         JOIN conversations c ON c.id = p.conversation_id
        WHERE p.tenant_id = $1 AND p.status = 'pending'
        ORDER BY p.created_at DESC`,
      [c.get('user').tenant_id],
    );
    return c.json({ pending: rows });
  });

  app.post('/api/pending/:id/answer', async (c) => {
    let body: { answer?: string; promotable?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'json invalide' }, 400);
    }
    const answer = body.answer?.trim();
    if (!answer) return c.json({ error: 'reponse vide' }, 400);

    const user = c.get('user');
    const found = await db.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM pending_answers
        WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
      [c.req.param('id'), user.tenant_id],
    );
    const row = found.rows[0];
    if (!row) return c.json({ error: 'question introuvable ou deja traitee' }, 404);

    await db.query(
      `UPDATE pending_answers
          SET status = 'answered', answer = $2, answered_at = now(),
              answered_by = $3, promotable = $4
        WHERE id = $1`,
      [c.req.param('id'), answer, user.email, body.promotable !== false],
    );
    // human_agent et non assistant : la reponse vient d'une personne, elle ne
    // doit pas compter dans le taux de resolution automatique.
    await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, sender, content)
       VALUES ($1, $2, 'human_agent', $3)`,
      [user.tenant_id, row.conversation_id, answer],
    );
    await db.query(
      `UPDATE conversations SET status = 'active', last_message_at = now() WHERE id = $1`,
      [row.conversation_id],
    );
    return c.json({ ok: true });
  });

  app.get('/api/gaps', async (c) => {
    const { rows } = await db.query(
      `SELECT question, times_asked, last_asked_at, has_human_answer
         FROM v_knowledge_gaps WHERE tenant_id = $1 LIMIT 30`,
      [c.get('user').tenant_id],
    );
    return c.json({ gaps: rows });
  });

  // -------------------------------------------------------------------
  //  Espace de test
  //
  //  Les essais passent par le canal internal_test, exclu des vues KPI :
  //  verifier son agent ne doit pas gonfler le taux de resolution qu'on
  //  affiche par ailleurs.
  // -------------------------------------------------------------------
  async function testChannelId(tenantId: string): Promise<string> {
    const found = await db.query<{ id: string }>(
      `SELECT id FROM tenant_channels WHERE tenant_id = $1 AND kind = 'internal_test' LIMIT 1`,
      [tenantId],
    );
    if (found.rows[0]) return found.rows[0].id;

    const created = await db.query<{ id: string }>(
      `INSERT INTO tenant_channels (tenant_id, kind, external_id)
       VALUES ($1, 'internal_test', $2)
       ON CONFLICT (kind, external_id) DO NOTHING
       RETURNING id`,
      [tenantId, `${tenantId}-internal`],
    );
    if (created.rows[0]) return created.rows[0].id;

    const again = await db.query<{ id: string }>(
      `SELECT id FROM tenant_channels WHERE tenant_id = $1 AND kind = 'internal_test' LIMIT 1`,
      [tenantId],
    );
    if (!again.rows[0]) throw new Error('canal de test indisponible');
    return again.rows[0].id;
  }

  app.post('/api/test/message', async (c) => {
    let body: { session_id?: string; message?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'json invalide' }, 400);
    }
    const sessionId = body.session_id?.trim();
    const message = body.message?.trim();
    if (!sessionId || !message) return c.json({ error: 'session_id et message requis' }, 400);

    const user = c.get('user');
    const channelId = await testChannelId(user.tenant_id);

    const event = await recordInboundEvent(db, {
      tenantId: user.tenant_id,
      channelId,
      providerMessageId: randomUUID(),
      payload: { session_key: sessionId, text: message },
    });

    return c.json({ accepted: true, event_id: event?.id ?? null }, 202);
  });

  app.get('/api/test/messages', async (c) => {
    const sessionId = c.req.query('session_id');
    if (!sessionId) return c.json({ error: 'session_id requis' }, 400);
    const after = Number(c.req.query('after') ?? '0');

    const { rows } = await db.query(
      `SELECT m.id, m.sender, m.content, m.created_at, m.latency_ms,
              m.tokens_in, m.tokens_out, m.retrieval_score, m.escalated
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN tenant_channels tc ON tc.id = c.channel_id
        WHERE c.tenant_id = $1
          AND tc.kind = 'internal_test'
          AND c.session_key = $2
          AND m.id > $3
        ORDER BY m.id LIMIT 60`,
      [c.get('user').tenant_id, sessionId, Number.isFinite(after) ? after : 0],
    );
    return c.json({ messages: rows });
  });

  return app;
}
