/**
 * Cree un compte pour l'espace client.
 *
 *     node --env-file=.env scripts/create_user.ts fitzone-tunis contact@fitzone.tn "Nom Prenom"
 *
 * Le mot de passe est genere et affiche une seule fois : il n'est stocke
 * qu'en empreinte scrypt, personne ne peut le relire ensuite.
 */
import { randomBytes } from 'node:crypto';

import { config } from '../src/config.ts';
import { createPgDb } from '../src/db.ts';
import { hashPassword } from '../src/auth.ts';

const [slug, email, ...nameParts] = process.argv.slice(2);
if (!slug || !email) {
  console.error('usage : create_user.ts <slug-client> <email> [nom]');
  process.exit(1);
}

const db = createPgDb(config.databaseUrl());

const tenant = await db.query<{ id: string; name: string }>(
  `SELECT id, name FROM tenants WHERE slug = $1`,
  [slug],
);
if (!tenant.rows[0]) {
  console.error(`client introuvable : ${slug}`);
  await db.close();
  process.exit(1);
}

// 18 octets aleatoires en base64url : assez long pour resister au forcage,
// assez court pour etre transmis de vive voix si besoin.
const password = process.env.USER_PASSWORD || randomBytes(18).toString('base64url');
const hash = await hashPassword(password);

try {
  await db.query(
    `INSERT INTO tenant_users (tenant_id, email, password_hash, name, role)
     VALUES ($1, $2, $3, $4, 'owner')`,
    [tenant.rows[0].id, email, hash, nameParts.join(' ') || null],
  );
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('tenant_users_email_key')) {
    console.error(`cette adresse a deja un compte : ${email}`);
  } else {
    console.error(message);
  }
  await db.close();
  process.exit(1);
}

console.log(`compte cree pour ${tenant.rows[0].name}`);
console.log(`  email        : ${email}`);
console.log(`  mot de passe : ${password}`);
console.log('\nAffiche une seule fois : la base ne garde qu une empreinte scrypt.');

await db.close();
