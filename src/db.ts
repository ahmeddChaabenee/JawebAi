import pg from 'pg';

/**
 * Surface minimale d'acces a la base. Le recepteur et le worker ne dependent
 * que de cette interface, pas de `pg` : les tests peuvent donc injecter une
 * base PostgreSQL en memoire (PGlite) et exercer le vrai SQL, contraintes
 * d'unicite comprises, sans serveur.
 */
export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}

export function createPgDb(connectionString: string): Db & { close(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    // Supabase passe par un pooler : garder les connexions courtes evite de
    // monopoliser des slots pendant les longues generations du modele.
    idleTimeoutMillis: 30_000,
  });

  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async close() {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
//  Requetes partagees entre le recepteur et le worker
// ---------------------------------------------------------------------------

export interface ResolvedChannel {
  channel_id: string;
  tenant_id: string;
  kind: string;
  config: Record<string, unknown>;
}

/**
 * Retrouve le client a partir de l'identifiant du canal cote fournisseur :
 * page id Messenger, numero WhatsApp, cle du widget. Sans cette resolution, un
 * webhook entrant est inexploitable -- on ne sait pas a qui appartient le
 * message. C'est le role de la contrainte UNIQUE (kind, external_id).
 */
export async function resolveChannel(
  db: Db,
  kind: string,
  externalId: string,
): Promise<ResolvedChannel | null> {
  const { rows } = await db.query<ResolvedChannel>(
    `SELECT id AS channel_id, tenant_id, kind, config
       FROM tenant_channels
      WHERE kind = $1 AND external_id = $2 AND status = 'active'`,
    [kind, externalId],
  );
  return rows[0] ?? null;
}

/**
 * Enregistre l'evenement entrant. Renvoie null si le message a deja ete recu.
 *
 * Messenger, WhatsApp et Telegram livrent en at-least-once et rejouent tout ce
 * qui n'est pas acquitte rapidement. La deduplication n'est pas ecrite ici :
 * elle est deleguee a la contrainte UNIQUE (channel_id, provider_message_id).
 * La base refuse le doublon, ON CONFLICT DO NOTHING ne renvoie aucune ligne,
 * et l'appelant sait qu'il n'a rien a faire.
 */
export async function recordInboundEvent(
  db: Db,
  args: {
    tenantId: string;
    channelId: string;
    providerMessageId: string;
    payload: unknown;
  },
): Promise<{ id: string } | null> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO inbound_events (tenant_id, channel_id, provider_message_id, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel_id, provider_message_id) DO NOTHING
     RETURNING id`,
    [args.tenantId, args.channelId, args.providerMessageId, JSON.stringify(args.payload)],
  );
  return rows[0] ?? null;
}
