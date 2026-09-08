import { config } from './config.ts';
import { createPgDb } from './db.ts';
import { createChatModel } from './agent/agent.ts';
import { createPineconeRetriever } from './agent/retrieval.ts';
import { createDelivery } from './delivery.ts';
import { claimNextEvent, processEvent, type ProcessDeps } from './processEvent.ts';

const db = createPgDb(config.databaseUrl());

const deps: ProcessDeps = {
  db,
  retriever: createPineconeRetriever({
    pineconeApiKey: config.pineconeKey(),
    indexName: config.pineconeIndex(),
    googleApiKey: config.googleApiKey(),
    embeddingModel: config.embeddingModel,
  }),
  model: createChatModel({
    apiKey: config.llmApiKey(),
    baseURL: config.llmBaseUrl,
    model: config.llmModel,
  }),
  delivery: createDelivery(),
};

let running = true;
process.on('SIGINT', () => {
  running = false;
});
process.on('SIGTERM', () => {
  running = false;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.info('[worker] demarre');

while (running) {
  let event;
  try {
    event = await claimNextEvent(db);
  } catch (err) {
    console.error('[worker] lecture de la file impossible :', err);
    await sleep(config.workerPollMs * 5);
    continue;
  }

  if (!event) {
    await sleep(config.workerPollMs);
    continue;
  }

  try {
    await processEvent(deps, event);
    console.info(`[worker] evenement ${event.id} traite`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] evenement ${event.id} en echec :`, message);
    // L'evenement reste en base avec son compteur de tentatives : rien n'est
    // perdu, et une supervision peut alerter sur les echecs repetes.
    await db.query(
      `UPDATE inbound_events
          SET status = 'failed', last_error = $2, processed_at = now()
        WHERE id = $1`,
      [event.id, message.slice(0, 2000)],
    );
  }
}

console.info('[worker] arrete');
await db.close();
