import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';

import { assertProductionSafety, config } from '../config.ts';
import { createPgDb } from '../db.ts';
import { createDelivery } from '../delivery.ts';
import { createReceiver } from './app.ts';
import { createAdmin } from '../admin/routes.ts';
import { createClientApp } from '../client/routes.ts';

assertProductionSafety();

const db = createPgDb(config.databaseUrl());
const delivery = createDelivery();

const app = createReceiver({
  db,
  metaAppSecret: config.metaAppSecret,
  metaVerifyToken: config.metaVerifyToken,
  // Sans await : l'indicateur de frappe ne doit jamais retarder l'accuse de
  // reception. Un echec se logge et s'oublie.
  sendTypingIndicator: (_token, recipientId) => {
    void delivery
      .typing({ channelConfig: {}, recipientId })
      .catch((err) => console.warn('[receiver] indicateur de frappe :', err.message));
  },
});

// La console vit sur le meme service : elle lit la meme base, et cela evite
// un second processus a deployer et a surveiller.
if (config.adminToken) {
  app.route('/admin', createAdmin({ db, adminToken: config.adminToken }));
} else {
  console.warn('[receiver] ADMIN_TOKEN absent : console desactivee');
}

// Espace client : comptes propres, un seul client visible, tenant_id impose
// par la session. Le back-office operateur reste sur /admin.
app.route('/app', createClientApp(db));

// L'interface React est servie par le meme processus que l'API : un seul
// service a deployer et a surveiller. Ces routes viennent APRES celles de
// l'API, sinon le catch-all avalerait /app/api et /webhook.
const DIST = './web/dist';
const INDEX = `${DIST}/index.html`;

app.use('/assets/*', serveStatic({ root: DIST }));
app.get('*', (c) => {
  if (!existsSync(INDEX)) {
    return c.text("Interface non construite. Lancer : npm run web:build", 503);
  }
  // Toutes les routes de page renvoient la meme page : c'est le routeur cote
  // navigateur qui decide quoi afficher.
  return c.html(readFileSync(INDEX, 'utf8'));
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`[receiver] a l'ecoute sur :${info.port}`);
});
