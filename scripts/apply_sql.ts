/**
 * Applique les fichiers SQL de db/ dans l'ordre.
 *
 * Equivalent Node de scripts/apply_sql.py, sans dependance Python : le projet
 * tourne deja sous Node, exiger une seconde chaine d'outils pour les
 * migrations n'apporte rien.
 *
 *     node --env-file=.env scripts/apply_sql.ts --dry-run
 *     node --env-file=.env scripts/apply_sql.ts
 *     node --env-file=.env scripts/apply_sql.ts --only 004_client_space.sql
 *     node --env-file=.env scripts/apply_sql.ts --file db/dev/reset.sql
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? '') : undefined;
};

const only = flag('--only');
const single = flag('--file');
const dryRun = args.includes('--dry-run');

let files: string[];
if (single) {
  files = [resolve(ROOT, single)];
} else {
  // Volontairement non recursif : db/dev/ et db/examples/ ne doivent jamais
  // partir par accident lors d'une application normale.
  files = readdirSync(join(ROOT, 'db'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(ROOT, 'db', f));
  if (only) files = files.filter((f) => f.endsWith(only));
}

if (files.length === 0) {
  console.error('aucun fichier a appliquer');
  process.exit(1);
}

if (dryRun) {
  console.log('fichiers qui seraient appliques, dans cet ordre :');
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n').length;
    console.log(`  ${f.split(/[\\/]/).pop()!.padEnd(28)} ${String(lines).padStart(4)} lignes`);
  }
  process.exit(0);
}

const dsn = process.env.DATABASE_URL;
if (!dsn) {
  console.error('DATABASE_URL non defini');
  process.exit(1);
}

const client = new pg.Client({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
await client.connect();

const info = await client.query('SELECT current_database() d, current_user u, version() v');
console.log(`connecte  base=${info.rows[0].d}  role=${info.rows[0].u}`);
console.log(`          ${String(info.rows[0].v).split(',')[0]}\n`);

let failed = false;
for (const f of files) {
  const name = f.split(/[\\/]/).pop()!;
  try {
    // Chaque fichier porte son propre BEGIN/COMMIT : il s'applique en entier
    // ou pas du tout.
    await client.query(readFileSync(f, 'utf8'));
    console.log(`  OK      ${name}`);
  } catch (err) {
    failed = true;
    console.log(`  ECHEC   ${name}`);
    console.log(`          ${err instanceof Error ? err.message : String(err)}`);
    break;
  }
}

await client.end();
console.log(failed ? '\nInterrompu. Corriger puis relancer.' : '\nSchema applique.');
process.exit(failed ? 1 : 0);
