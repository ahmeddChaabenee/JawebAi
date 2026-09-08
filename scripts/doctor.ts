/**
 * Diagnostic : verifie les quatre dependances externes avant de chercher
 * pourquoi le systeme ne repond pas.
 *
 *     node --env-file=.env scripts/doctor.ts
 */
import { config } from '../src/config.ts';
import { createPgDb } from '../src/db.ts';
import { createChatModel } from '../src/agent/agent.ts';
import { createPineconeRetriever } from '../src/agent/retrieval.ts';

const ok = (label: string, detail = '') => console.log(`  OK      ${label.padEnd(22)} ${detail}`);
const ko = (label: string, detail = '') => console.log(`  ECHEC   ${label.padEnd(22)} ${detail}`);

let failures = 0;
async function step(label: string, fn: () => Promise<string>) {
  try {
    ok(label, await fn());
  } catch (err) {
    failures += 1;
    ko(label, err instanceof Error ? err.message.slice(0, 160) : String(err));
  }
}

const db = createPgDb(config.databaseUrl());

await step('Postgres', async () => {
  const { rows } = await db.query<{ v: string }>('SELECT version() AS v');
  return (rows[0]?.v ?? '').split(',')[0] ?? '';
});

let namespace = '';
let channelKey = '';

await step('Clients configures', async () => {
  const { rows } = await db.query<{ slug: string; name: string; vector_namespace: string }>(
    `SELECT slug, name, vector_namespace FROM tenants WHERE status IN ('trial','active') ORDER BY slug`,
  );
  if (rows.length === 0) throw new Error("aucun client : appliquer db/examples/seed_fitzone.sql");
  namespace = rows[0]!.vector_namespace;
  return rows.map((r) => `${r.name} (namespace ${r.vector_namespace})`).join(', ');
});

await step('Canaux', async () => {
  const { rows } = await db.query<{ kind: string; external_id: string }>(
    `SELECT kind, external_id FROM tenant_channels WHERE status = 'active' ORDER BY kind`,
  );
  if (rows.length === 0) throw new Error('aucun canal actif');
  const widget = rows.find((r) => r.kind === 'web_widget');
  if (widget) channelKey = widget.external_id;
  return rows.map((r) => `${r.kind}:${r.external_id}`).join(', ');
});

await step('Prompt', async () => {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tenants t
      JOIN prompt_templates p ON p.id = t.prompt_template_id`,
  );
  if (rows[0]?.n === '0') throw new Error('aucun client ne pointe vers un template de prompt');
  return `${rows[0]?.n} client(s) avec template`;
});

await step('Pinecone', async () => {
  const retriever = createPineconeRetriever({
    pineconeApiKey: config.pineconeKey(),
    indexName: config.pineconeIndex(),
    googleApiKey: config.googleApiKey(),
    embeddingModel: config.embeddingModel,
  });
  const chunks = await retriever.retrieve('tarifs abonnement', namespace || 'gym', 3);
  if (chunks.length === 0) {
    throw new Error(`index ${config.pineconeIndex()} / namespace "${namespace}" : aucun extrait`);
  }
  return `${chunks.length} extraits, meilleur score ${chunks[0]!.score.toFixed(3)}`;
});

await step('Modele', async () => {
  const model = createChatModel({
    apiKey: config.llmApiKey(),
    baseURL: config.llmBaseUrl,
    model: config.llmModel,
  });
  const out = await model.complete({
    system: 'Reponds uniquement par le mot: pret',
    history: [],
    user: 'test',
  });
  return `${out.model} -> "${out.text.trim().slice(0, 30)}"`;
});

console.log();
if (failures === 0) {
  console.log('Tout est joignable.');
  if (channelKey) console.log(`Cle du canal widget pour les tests : ${channelKey}`);
} else {
  console.log(`${failures} verification(s) en echec.`);
}

await db.close();
process.exit(failures === 0 ? 0 : 1);
