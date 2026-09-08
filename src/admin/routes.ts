import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';

import type { Db } from '../db.ts';

export interface AdminOptions {
  db: Db;
  adminToken: string;
}

/**
 * Comparaison a temps constant du jeton d'administration.
 *
 * Une egalite de chaines ordinaire abandonne au premier caractere different,
 * ce qui laisse deviner le jeton caractere par caractere en mesurant le temps
 * de reponse.
 */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createAdmin(options: AdminOptions) {
  const { db, adminToken } = options;
  const app = new Hono();

  // La page elle-meme ne contient aucune donnee : elle demande le jeton au
  // chargement et le garde localement. Seules les routes /api sont protegees.
  app.use('/api/*', async (c, next) => {
    if (!tokenMatches(c.req.header('x-admin-token'), adminToken)) {
      return c.json({ error: 'jeton invalide' }, 401);
    }
    await next();
  });

  app.get('/api/tenants', async (c) => {
    const { rows } = await db.query(
      `SELECT id, slug, name, status, vector_namespace
         FROM tenants ORDER BY name`,
    );
    return c.json({ tenants: rows });
  });

  /**
   * Tout ce que la page affiche au chargement, en une seule requete : les
   * compteurs, la courbe, la repartition par canal et les conversations
   * recentes. Un aller-retour au lieu de cinq.
   */
  app.get('/api/overview', async (c) => {
    const tenantId = c.req.query('tenant_id');
    if (!tenantId) return c.json({ error: 'tenant_id requis' }, 400);

    const kpis = await db.query(`SELECT * FROM v_tenant_kpis WHERE tenant_id = $1`, [tenantId]);
    const daily = await db.query(
      `SELECT day, conversations_started, messages
         FROM v_tenant_daily_usage WHERE tenant_id = $1 ORDER BY day`,
      [tenantId],
    );
    const channels = await db.query(
      `SELECT tc.kind, count(c.id)::int AS n
         FROM tenant_channels tc
         LEFT JOIN conversations c ON c.channel_id = tc.id
        WHERE tc.tenant_id = $1
        GROUP BY tc.kind ORDER BY n DESC`,
      [tenantId],
    );
    const recent = await db.query(
      `SELECT c.id, c.session_key, c.status, c.last_message_at, tc.kind AS channel,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT m.content FROM messages m
                WHERE m.conversation_id = c.id AND m.sender = 'user'
                ORDER BY m.id DESC LIMIT 1) AS last_question
         FROM conversations c
         JOIN tenant_channels tc ON tc.id = c.channel_id
        WHERE c.tenant_id = $1
        ORDER BY c.last_message_at DESC
        LIMIT 12`,
      [tenantId],
    );
    const pending = await db.query(
      `SELECT count(*)::int AS n FROM pending_answers
        WHERE tenant_id = $1 AND status = 'pending'`,
      [tenantId],
    );
    const docs = await db.query(
      `SELECT name, status, chunk_count, indexed_at
         FROM v_document_freshness WHERE tenant_id = $1 ORDER BY indexed_at DESC NULLS LAST LIMIT 8`,
      [tenantId],
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

  app.get('/api/conversations/:id', async (c) => {
    const { rows } = await db.query(
      `SELECT id, sender, content, created_at, latency_ms, tokens_in, tokens_out,
              model, retrieval_score, escalated
         FROM messages WHERE conversation_id = $1 ORDER BY id`,
      [c.req.param('id')],
    );
    return c.json({ messages: rows });
  });

  app.get('/api/pending', async (c) => {
    const tenantId = c.req.query('tenant_id');
    if (!tenantId) return c.json({ error: 'tenant_id requis' }, 400);
    const { rows } = await db.query(
      `SELECT p.id, p.question, p.created_at, p.conversation_id, c.session_key
         FROM pending_answers p
         JOIN conversations c ON c.id = p.conversation_id
        WHERE p.tenant_id = $1 AND p.status = 'pending'
        ORDER BY p.created_at DESC`,
      [tenantId],
    );
    return c.json({ pending: rows });
  });

  app.get('/api/gaps', async (c) => {
    const tenantId = c.req.query('tenant_id');
    if (!tenantId) return c.json({ error: 'tenant_id requis' }, 400);
    const { rows } = await db.query(
      `SELECT question, times_asked, last_asked_at, has_human_answer
         FROM v_knowledge_gaps WHERE tenant_id = $1 LIMIT 20`,
      [tenantId],
    );
    return c.json({ gaps: rows });
  });

  /**
   * Repondre a une question escaladee.
   *
   * Ferme la boucle humaine : la reponse est enregistree, ajoutee au transcript
   * comme un tour d'agent humain, et la conversation repasse en actif.
   *
   * `promotable` a false interdit de reverser cette reponse dans la base
   * documentaire plus tard -- indispensable pour tout ce qui touche au medical,
   * au juridique ou au financier.
   */
  app.post('/api/pending/:id/answer', async (c) => {
    let body: { answer?: string; promotable?: boolean; answered_by?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'json invalide' }, 400);
    }

    const answer = body.answer?.trim();
    if (!answer) return c.json({ error: 'reponse vide' }, 400);

    const found = await db.query<{ tenant_id: string; conversation_id: string }>(
      `SELECT tenant_id, conversation_id FROM pending_answers
        WHERE id = $1 AND status = 'pending'`,
      [c.req.param('id')],
    );
    const row = found.rows[0];
    if (!row) return c.json({ error: 'question introuvable ou deja traitee' }, 404);

    await db.query(
      `UPDATE pending_answers
          SET status = 'answered', answer = $2, answered_at = now(),
              answered_by = $3, promotable = $4
        WHERE id = $1`,
      [c.req.param('id'), answer, body.answered_by ?? 'admin', body.promotable !== false],
    );

    // sender='human_agent' et non 'assistant' : la reponse vient d'un humain,
    // elle ne doit pas gonfler le taux de resolution automatique.
    await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, sender, content)
       VALUES ($1, $2, 'human_agent', $3)`,
      [row.tenant_id, row.conversation_id, answer],
    );

    await db.query(
      `UPDATE conversations SET status = 'active', last_message_at = now() WHERE id = $1`,
      [row.conversation_id],
    );

    return c.json({ ok: true });
  });

  return app;
}
