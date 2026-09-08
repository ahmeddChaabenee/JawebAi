import { config } from './config.ts';
import type { Db } from './db.ts';
import type { Retriever } from './agent/retrieval.ts';
import type { ChatModel } from './agent/agent.ts';
import { runAgentTurn } from './agent/agent.ts';
import type { Delivery } from './delivery.ts';

export interface InboundEventRow {
  id: string;
  tenant_id: string;
  channel_id: string;
  provider_message_id: string;
  payload: { session_key?: string; text?: string };
}

export interface ProcessDeps {
  db: Db;
  retriever: Retriever;
  model: ChatModel;
  delivery: Delivery;
}

/**
 * Prend un evenement en attente, de facon atomique.
 *
 * FOR UPDATE SKIP LOCKED est le motif de file d'attente sur PostgreSQL :
 * plusieurs workers peuvent tourner en parallele sans jamais reserver le meme
 * evenement, et sans se bloquer les uns les autres.
 */
export async function claimNextEvent(db: Db): Promise<InboundEventRow | null> {
  const { rows } = await db.query<InboundEventRow>(
    `UPDATE inbound_events
        SET status = 'processing', attempts = attempts + 1
      WHERE id = (
            SELECT id FROM inbound_events
             WHERE status = 'received'
             ORDER BY received_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED)
     RETURNING id, tenant_id, channel_id, provider_message_id, payload`,
  );
  return rows[0] ?? null;
}

async function getOrCreateConversation(
  db: Db,
  tenantId: string,
  channelId: string,
  sessionKey: string,
): Promise<string> {
  // ON CONFLICT s'appuie sur UNIQUE (tenant_id, channel_id, session_key) : deux
  // workers qui traitent simultanement deux messages d'un meme utilisateur ne
  // peuvent pas creer deux conversations.
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_id, session_key, last_message_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, channel_id, session_key)
       DO UPDATE SET last_message_at = now()
     RETURNING id`,
    [tenantId, channelId, sessionKey],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('creation de conversation impossible');
  return id;
}

/**
 * Traite un evenement de bout en bout : conversation, agent, ecriture,
 * livraison.
 *
 * Note d'etape : rien n'empeche encore deux messages d'une meme conversation
 * d'etre traites en parallele. C'est l'etape 2 qui ajoutera la prise du verrou
 * `conversations.processing_until` autour de cet appel.
 */
export async function processEvent(deps: ProcessDeps, event: InboundEventRow): Promise<void> {
  const { db, delivery } = deps;

  const sessionKey = event.payload?.session_key?.trim();
  const text = event.payload?.text?.trim();
  if (!sessionKey || !text) {
    await db.query(
      `UPDATE inbound_events
          SET status = 'failed', last_error = $2, processed_at = now()
        WHERE id = $1`,
      [event.id, 'payload sans session_key ou sans texte'],
    );
    return;
  }

  const { rows: channelRows } = await db.query<{ kind: string; config: Record<string, unknown> }>(
    `SELECT kind, config FROM tenant_channels WHERE id = $1`,
    [event.channel_id],
  );
  const channel = channelRows[0];
  if (!channel) throw new Error(`canal introuvable : ${event.channel_id}`);

  const conversationId = await getOrCreateConversation(
    db,
    event.tenant_id,
    event.channel_id,
    sessionKey,
  );

  // Le message du client est ecrit avant l'appel au modele : si la generation
  // echoue, la question reste visible dans le fil au lieu de disparaitre.
  await db.query(
    `INSERT INTO messages (tenant_id, conversation_id, sender, content, provider_message_id)
     VALUES ($1, $2, 'user', $3, $4)`,
    [event.tenant_id, conversationId, text, event.provider_message_id],
  );

  const result = await runAgentTurn(deps, {
    tenantId: event.tenant_id,
    conversationId,
    userMessage: text,
  });

  const replyToCustomer = result.needsHuman ? result.holdingMessage : result.cleanReply;

  // null tant que les tarifs ne sont pas renseignes : la vue KPI affichera
  // "non configure" au lieu d'un faux zero rassurant.
  const priced = config.llmPriceIn > 0 || config.llmPriceOut > 0;
  const costUsd = priced
    ? (result.tokensIn / 1_000_000) * config.llmPriceIn +
      (result.tokensOut / 1_000_000) * config.llmPriceOut
    : null;

  await db.query(
    `INSERT INTO messages (tenant_id, conversation_id, sender, content,
                           model, latency_ms, tokens_in, tokens_out,
                           retrieval_score, escalated, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      event.tenant_id,
      conversationId,
      result.needsHuman ? 'system' : 'assistant',
      result.needsHuman
        ? `[ESCALADE] Aucune reponse dans la base documentaire. Message d'attente envoye : "${result.holdingMessage}"`
        : result.cleanReply,
      result.model,
      result.latencyMs,
      result.tokensIn,
      result.tokensOut,
      result.topScore,
      result.needsHuman,
      costUsd,
    ],
  );

  if (result.needsHuman) {
    await db.query(
      `INSERT INTO pending_answers (tenant_id, conversation_id, question)
       VALUES ($1, $2, $3)`,
      [event.tenant_id, conversationId, text],
    );
  }

  await db.query(
    `UPDATE conversations
        SET status = $2, last_message_at = now()
      WHERE id = $1`,
    [conversationId, result.needsHuman ? 'escalated' : 'active'],
  );

  if (replyToCustomer) {
    await delivery.send({
      channelKind: channel.kind,
      channelConfig: channel.config,
      recipientId: sessionKey,
      text: replyToCustomer,
    });
  }

  await db.query(
    `UPDATE inbound_events SET status = 'done', processed_at = now() WHERE id = $1`,
    [event.id],
  );
}
