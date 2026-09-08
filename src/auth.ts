import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { Db } from './db.ts';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

// Parametres scrypt. N=16384 est le compromis courant : assez couteux pour
// rendre une attaque par dictionnaire penible, assez rapide pour une connexion.
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

export const SESSION_TTL_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEYLEN, PARAMS);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length, PARAMS);
  // timingSafeEqual : une comparaison ordinaire s'arrete au premier octet
  // different et laisse deviner l'empreinte en mesurant le temps de reponse.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Le jeton circule en clair chez le client ; seule son empreinte est stockee. */
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export interface SessionUser {
  user_id: string;
  tenant_id: string;
  email: string;
  name: string | null;
  role: string;
  tenant_name: string;
  tenant_slug: string;
  vector_namespace: string;
}

export async function login(
  db: Db,
  email: string,
  password: string,
  userAgent?: string,
): Promise<{ token: string; user: SessionUser } | null> {
  const { rows } = await db.query<SessionUser & { password_hash: string }>(
    `SELECT u.id AS user_id, u.tenant_id, u.email, u.name, u.role, u.password_hash,
            t.name AS tenant_name, t.slug AS tenant_slug, t.vector_namespace
       FROM tenant_users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE lower(u.email) = lower($1)
        AND u.status = 'active'
        AND t.status IN ('trial', 'active')`,
    [email],
  );

  const row = rows[0];
  // Verifier le mot de passe meme quand le compte n'existe pas : sans cela, la
  // difference de temps de reponse revele quelles adresses sont enregistrees.
  const ok = await verifyPassword(password, row?.password_hash ?? 'scrypt$00$00');
  if (!row || !ok) return null;

  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [digest(token), row.user_id, expires, (userAgent ?? '').slice(0, 300)],
  );
  await db.query(`UPDATE tenant_users SET last_login_at = now() WHERE id = $1`, [row.user_id]);

  const { password_hash: _ignored, ...user } = row;
  return { token, user };
}

/**
 * Resout la session en un client.
 *
 * C'est ici que se joue toute l'isolation de l'espace client : le tenant_id
 * est LU DEPUIS LA SESSION, jamais recu du navigateur. Un utilisateur ne peut
 * donc pas demander les donnees d'un autre client, meme en modifiant l'URL.
 */
export async function resolveSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const { rows } = await db.query<SessionUser>(
    `SELECT u.id AS user_id, u.tenant_id, u.email, u.name, u.role,
            t.name AS tenant_name, t.slug AS tenant_slug, t.vector_namespace
       FROM sessions s
       JOIN tenant_users u ON u.id = s.user_id
       JOIN tenants t ON t.id = u.tenant_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND u.status = 'active'
        AND t.status IN ('trial', 'active')`,
    [digest(token)],
  );
  return rows[0] ?? null;
}

export async function logout(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [digest(token)]);
}

export async function purgeExpiredSessions(db: Db): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  return rowCount;
}
