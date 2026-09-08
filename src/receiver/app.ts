import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';

import type { Db } from '../db.ts';
import { recordInboundEvent, resolveChannel } from '../db.ts';
import { verifyMetaSignature } from './signature.ts';
import { resolveSecret } from '../secrets.ts';

export interface ReceiverOptions {
  db: Db;
  metaAppSecret: string;
  metaVerifyToken: string;
  /** Injectable pour les tests : evite tout appel reseau. */
  sendTypingIndicator?: (pageToken: string, recipientId: string) => void;
}

interface IncomingMessage {
  pageId: string;
  senderId: string;
  messageId: string;
  text: string;
}

/**
 * Extrait les messages texte d'une livraison Messenger.
 *
 * Une seule requete peut contenir plusieurs entrees et plusieurs messages :
 * Meta regroupe. Tout ce qui n'est pas un message texte (accuses de lecture,
 * livraisons, postbacks) est ignore ici sans que la requete echoue -- Meta doit
 * recevoir 200 quoi qu'il arrive, sinon il rejoue.
 */
export function parseMessengerPayload(body: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    const e = entry as { id?: string; messaging?: unknown[] };
    const pageId = e.id;
    if (!pageId || !Array.isArray(e.messaging)) continue;

    for (const raw of e.messaging) {
      const m = raw as {
        sender?: { id?: string };
        message?: { mid?: string; text?: string; is_echo?: boolean };
      };
      // is_echo : message envoye par la page elle-meme, renvoye par Meta.
      // Le traiter creerait une boucle ou le bot se repond a lui-meme.
      if (m.message?.is_echo) continue;

      const senderId = m.sender?.id;
      const messageId = m.message?.mid;
      const text = m.message?.text;
      if (!senderId || !messageId || typeof text !== 'string' || text.trim() === '') continue;

      out.push({ pageId, senderId, messageId, text: text.trim() });
    }
  }
  return out;
}

export function createReceiver(options: ReceiverOptions) {
  const { db, metaAppSecret, metaVerifyToken } = options;
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  // -------------------------------------------------------------------
  //  Messenger : handshake de verification de l'abonnement
  // -------------------------------------------------------------------
  app.get('/webhook/messenger', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode === 'subscribe' && token && metaVerifyToken && token === metaVerifyToken) {
      return c.text(challenge ?? '');
    }
    return c.text('forbidden', 403);
  });

  // -------------------------------------------------------------------
  //  Messenger : livraison des messages
  //
  //  Contrat : accuser reception en moins d'une seconde. Aucun appel au
  //  modele, aucune recherche vectorielle ici -- uniquement verifier,
  //  router, enregistrer.
  // -------------------------------------------------------------------
  app.post('/webhook/messenger', async (c) => {
    const rawBody = await c.req.text();

    // En developpement sans secret configure, on laisse passer. config.ts
    // refuse ce cas en production.
    if (metaAppSecret) {
      const header = c.req.header('x-hub-signature-256');
      if (!verifyMetaSignature(rawBody, header, metaAppSecret)) {
        return c.text('invalid signature', 401);
      }
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.text('bad json', 400);
    }

    const messages = parseMessengerPayload(payload);

    for (const msg of messages) {
      const channel = await resolveChannel(db, 'messenger', msg.pageId);
      if (!channel) {
        // Page inconnue : rien a faire, mais surtout pas d'erreur -- un 4xx
        // ferait rejouer Meta indefiniment pour un message qu'on n'accepterait
        // de toute facon jamais.
        console.warn(`[receiver] page Messenger inconnue : ${msg.pageId}`);
        continue;
      }

      const event = await recordInboundEvent(db, {
        tenantId: channel.tenant_id,
        channelId: channel.channel_id,
        providerMessageId: msg.messageId,
        payload: { session_key: msg.senderId, text: msg.text, raw: msg },
      });

      if (!event) {
        console.info(`[receiver] doublon ignore : ${msg.messageId}`);
        continue;
      }

      // Sans attendre : l'indicateur de frappe est un confort, il ne doit
      // jamais retarder l'accuse de reception ni le faire echouer.
      const token = resolveSecret(
        (channel.config as { secret_ref?: string } | null)?.secret_ref ?? null,
      );
      if (token && options.sendTypingIndicator) {
        options.sendTypingIndicator(token, msg.senderId);
      }
    }

    return c.body(null, 200);
  });

  // -------------------------------------------------------------------
  //  Widget web : meme contrat, sans signature
  // -------------------------------------------------------------------
  app.post('/webhook/widget', async (c) => {
    let body: { channel_key?: string; session_id?: string; message?: string; message_id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad json' }, 400);
    }

    const channelKey = body.channel_key?.trim();
    const sessionId = body.session_id?.trim();
    const message = body.message?.trim();
    if (!channelKey || !sessionId || !message) {
      return c.json({ error: 'channel_key, session_id et message sont requis' }, 400);
    }

    const channel = await resolveChannel(db, 'web_widget', channelKey);
    if (!channel) return c.json({ error: 'canal inconnu' }, 404);

    // Un navigateur ne rejoue pas tout seul, mais accepter un message_id fourni
    // par le client rend l'envoi idempotent en cas de reessai manuel.
    const providerMessageId = body.message_id?.trim() || randomUUID();

    const event = await recordInboundEvent(db, {
      tenantId: channel.tenant_id,
      channelId: channel.channel_id,
      providerMessageId,
      payload: { session_key: sessionId, text: message },
    });

    return c.json(
      { accepted: true, duplicate: event === null, event_id: event?.id ?? null },
      202,
    );
  });

  // -------------------------------------------------------------------
  //  Widget web : recuperation des reponses
  //
  //  La reponse n'arrive plus dans la reponse HTTP du message : le widget
  //  interroge ce point d'entree jusqu'a voir apparaitre le tour assistant.
  // -------------------------------------------------------------------
  app.get('/widget/messages', async (c) => {
    const channelKey = c.req.query('channel_key');
    const sessionId = c.req.query('session_id');
    const after = Number(c.req.query('after') ?? '0');
    if (!channelKey || !sessionId) {
      return c.json({ error: 'channel_key et session_id sont requis' }, 400);
    }

    const channel = await resolveChannel(db, 'web_widget', channelKey);
    if (!channel) return c.json({ error: 'canal inconnu' }, 404);

    const { rows } = await db.query(
      `SELECT m.id, m.sender, m.content, m.created_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.channel_id = $1
          AND c.session_key = $2
          AND m.id > $3
        ORDER BY m.id
        LIMIT 50`,
      [channel.channel_id, sessionId, Number.isFinite(after) ? after : 0],
    );

    return c.json({ messages: rows });
  });

  return app;
}
