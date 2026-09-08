import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import type { Db } from '../src/db.ts';
import { createReceiver, parseMessengerPayload } from '../src/receiver/app.ts';
import { classifyReply, holdingMessageFor } from '../src/agent/escalation.ts';
import { renderPrompt } from '../src/agent/prompt.ts';
import { claimNextEvent, processEvent } from '../src/processEvent.ts';
import type { Delivery } from '../src/delivery.ts';
import type { ChatModel } from '../src/agent/agent.ts';
import type { Retriever } from '../src/agent/retrieval.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_SECRET = 'secret-de-test';
const PAGE_ID = '111222333';
const WIDGET_KEY = 'demo-widget';

let pg: PGlite;
let db: Db;
let tenantId: string;

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex');
}

function messengerBody(mid: string, text: string, pageId = PAGE_ID) {
  return JSON.stringify({
    object: 'page',
    entry: [
      {
        id: pageId,
        messaging: [{ sender: { id: 'PSID-9' }, message: { mid, text } }],
      },
    ],
  });
}

async function postMessenger(app: ReturnType<typeof createReceiver>, body: string) {
  return app.request('/webhook/messenger', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    body,
  });
}

before(async () => {
  pg = new PGlite();
  // Le vrai fichier de schema, pas une copie simplifiee : les contraintes
  // testees ici sont exactement celles qui tourneront en production.
  await pg.exec(readFileSync(join(ROOT, 'db', '001_schema.sql'), 'utf8'));

  db = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const r = await pg.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rows.length };
    },
  };

  const tpl = await pg.query<{ id: string }>(
    `INSERT INTO prompt_templates (key, version, is_active, body)
     VALUES ('test', 1, true, 'Tu assistes {{business_name}} a {{city}}. Devise {{currency}}.')
     RETURNING id`,
  );
  const tenant = await pg.query<{ id: string }>(
    `INSERT INTO tenants (slug, name, status, vector_namespace, prompt_template_id, config)
     VALUES ('acme', 'Acme', 'active', 'acme-ns', $1,
             '{"city":"Tunis","currency":"TND"}'::jsonb)
     RETURNING id`,
    [tpl.rows[0]!.id],
  );
  tenantId = tenant.rows[0]!.id;

  await pg.query(
    `INSERT INTO tenant_channels (tenant_id, kind, external_id) VALUES ($1, 'messenger', $2)`,
    [tenantId, PAGE_ID],
  );
  await pg.query(
    `INSERT INTO tenant_channels (tenant_id, kind, external_id) VALUES ($1, 'web_widget', $2)`,
    [tenantId, WIDGET_KEY],
  );
});

after(async () => {
  await pg.close();
});

describe('recepteur', () => {
  const app = () =>
    createReceiver({ db, metaAppSecret: APP_SECRET, metaVerifyToken: 'verif-123' });

  it('rejette une signature invalide sans rien enregistrer', async () => {
    const body = messengerBody('mid-bad', 'coucou');
    const res = await app().request('/webhook/messenger', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00ff' },
      body,
    });
    assert.equal(res.status, 401);

    const { rows } = await db.query(
      `SELECT 1 FROM inbound_events WHERE provider_message_id = 'mid-bad'`,
    );
    assert.equal(rows.length, 0, 'aucun evenement ne doit etre cree');
  });

  it('accepte un message signe et l enregistre une fois', async () => {
    const body = messengerBody('mid-1', 'quels sont vos tarifs ?');
    const res = await postMessenger(app(), body);
    assert.equal(res.status, 200);

    const { rows } = await db.query(
      `SELECT tenant_id FROM inbound_events WHERE provider_message_id = 'mid-1'`,
    );
    assert.equal(rows.length, 1);
  });

  it('ignore le renvoi du meme message par Meta', async () => {
    const body = messengerBody('mid-1', 'quels sont vos tarifs ?');
    const res = await postMessenger(app(), body);
    assert.equal(res.status, 200, 'un renvoi doit recevoir 200, sinon Meta rejoue en boucle');

    const { rows } = await db.query(
      `SELECT id FROM inbound_events WHERE provider_message_id = 'mid-1'`,
    );
    assert.equal(rows.length, 1, 'la contrainte UNIQUE doit empecher le doublon');
  });

  it('repond 200 sur une page inconnue plutot qu une erreur', async () => {
    // Un 4xx ferait rejouer Meta indefiniment pour un message qu'on
    // n'accepterait de toute facon jamais.
    const body = messengerBody('mid-orphan', 'salut', '999999');
    const res = await postMessenger(app(), body);
    assert.equal(res.status, 200);

    const { rows } = await db.query(
      `SELECT 1 FROM inbound_events WHERE provider_message_id = 'mid-orphan'`,
    );
    assert.equal(rows.length, 0);
  });

  it('valide le handshake d abonnement Meta', async () => {
    const ok = await app().request(
      '/webhook/messenger?hub.mode=subscribe&hub.verify_token=verif-123&hub.challenge=42',
    );
    assert.equal(await ok.text(), '42');

    const ko = await app().request(
      '/webhook/messenger?hub.mode=subscribe&hub.verify_token=faux&hub.challenge=42',
    );
    assert.equal(ko.status, 403);
  });

  it('accepte un message du widget et signale les doublons', async () => {
    const send = (messageId: string) =>
      app().request('/webhook/widget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel_key: WIDGET_KEY,
          session_id: 'sess-1',
          message: 'bonjour',
          message_id: messageId,
        }),
      });

    const first = await send('w-1');
    assert.equal(first.status, 202);
    assert.equal(((await first.json()) as { duplicate: boolean }).duplicate, false);

    const second = await send('w-1');
    assert.equal(((await second.json()) as { duplicate: boolean }).duplicate, true);
  });

  it('refuse un canal widget inconnu', async () => {
    const res = await app().request('/webhook/widget', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel_key: 'inexistant', session_id: 's', message: 'x' }),
    });
    assert.equal(res.status, 404);
  });
});

describe('worker', () => {
  const retriever: Retriever = {
    async retrieve() {
      return [{ text: 'Abonnement standard : 89 TND par mois.', score: 0.83, fileName: 'tarifs.pdf' }];
    },
  };

  const delivered: { text: string; recipientId: string }[] = [];
  const delivery: Delivery = {
    async send(args) {
      delivered.push({ text: args.text, recipientId: args.recipientId });
    },
    async typing() {},
  };

  function modelReturning(text: string): ChatModel {
    return {
      async complete() {
        return { text, tokensIn: 120, tokensOut: 30, model: 'stub-model' };
      },
    };
  }

  it('traite un evenement et remplit les champs de mesure', async () => {
    const event = await claimNextEvent(db);
    assert.ok(event, 'un evenement doit etre disponible');

    await processEvent(
      { db, retriever, model: modelReturning("L'abonnement standard est a 89 TND par mois."), delivery },
      event,
    );

    const { rows } = await db.query<{
      sender: string;
      content: string;
      latency_ms: number | null;
      tokens_in: number | null;
      retrieval_score: number | null;
      model: string | null;
    }>(
      `SELECT sender, content, latency_ms, tokens_in, retrieval_score, model
         FROM messages ORDER BY id`,
    );

    assert.equal(rows.length, 2, 'un tour = un message client + une reponse');
    assert.equal(rows[0]!.sender, 'user');
    assert.equal(rows[1]!.sender, 'assistant');
    assert.match(rows[1]!.content, /89 TND/);

    // Les colonnes KPI de l'etape 0 sont effectivement alimentees.
    assert.equal(rows[1]!.tokens_in, 120);
    assert.equal(rows[1]!.model, 'stub-model');
    assert.ok(rows[1]!.latency_ms !== null && rows[1]!.latency_ms >= 0);
    assert.ok(Math.abs((rows[1]!.retrieval_score ?? 0) - 0.83) < 0.001);

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.recipientId, 'PSID-9');

    const done = await db.query<{ status: string }>(
      `SELECT status FROM inbound_events WHERE id = $1`,
      [event.id],
    );
    assert.equal(done.rows[0]!.status, 'done');
  });

  it('escalade, trace la question et livre un message d attente', async () => {
    // La file est globale et strictement FIFO, tous clients et canaux
    // confondus : les messages laisses par la suite "recepteur" seraient servis
    // avant celui-ci. On la vide pour que le test porte sur l'evenement voulu.
    await db.query(`UPDATE inbound_events SET status = 'done' WHERE status = 'received'`);

    const body = messengerBody('mid-esc', 'combien coute une navette vers Djerba ?');
    await postMessenger(
      createReceiver({ db, metaAppSecret: APP_SECRET, metaVerifyToken: 'v' }),
      body,
    );

    const event = await claimNextEvent(db);
    assert.ok(event);

    await processEvent({ db, retriever, model: modelReturning('[[NEEDS_HUMAN]]'), delivery }, event);

    const pending = await db.query<{ question: string; status: string }>(
      `SELECT question, status FROM pending_answers`,
    );
    assert.equal(pending.rows.length, 1);
    assert.equal(pending.rows[0]!.status, 'pending');

    const convo = await db.query<{ status: string }>(
      `SELECT status FROM conversations WHERE session_key = 'PSID-9'`,
    );
    assert.equal(convo.rows[0]!.status, 'escalated');

    // Le client ne doit jamais rester sans reponse pendant qu'on cherche un humain.
    const last = delivered.at(-1)!;
    assert.match(last.text, /transmis votre question/);

    const trace = await db.query<{ sender: string; escalated: boolean }>(
      `SELECT sender, escalated FROM messages ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(trace.rows[0]!.sender, 'system');
    assert.equal(trace.rows[0]!.escalated, true);
  });
});

describe('unites', () => {
  it('ignore les echos de la page pour ne pas boucler', () => {
    const parsed = parseMessengerPayload({
      entry: [
        {
          id: 'p1',
          messaging: [
            { sender: { id: 'a' }, message: { mid: 'm1', text: 'vrai' } },
            { sender: { id: 'p1' }, message: { mid: 'm2', text: 'echo', is_echo: true } },
          ],
        },
      ],
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.text, 'vrai');
  });

  it('detecte le jeton d escalade et la fuite de raisonnement', () => {
    assert.equal(classifyReply('[[NEEDS_HUMAN]]', 'x').needsHuman, true);
    assert.equal(classifyReply("Let's double-check the price...", 'x').needsHuman, true);
    assert.equal(classifyReply('89 TND par mois.', 'x').needsHuman, false);
  });

  it('choisit le message d attente selon la langue du client', () => {
    assert.match(holdingMessageFor('b9addeh el abonnement ?'), /Sou'alek/);
    assert.match(holdingMessageFor('how much is it ?'), /our team/);
    assert.match(holdingMessageFor('quels sont vos tarifs ?'), /transmis/);
    assert.match(holdingMessageFor('شنوة الأسعار'), /الفريق/);
  });

  it('laisse visible un placeholder sans valeur au lieu de l effacer', () => {
    const rendered = renderPrompt({
      tenant_id: 't',
      slug: 's',
      name: 'Acme',
      vector_namespace: 'ns',
      config: { city: 'Tunis' },
      prompt_overrides: {},
      prompt_body: '{{business_name}} a {{city}}, contact {{inconnu}}.',
    });
    assert.equal(rendered, 'Acme a Tunis, contact {{inconnu}}.');
  });
});
