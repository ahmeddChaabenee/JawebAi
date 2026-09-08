/**
 * Reconstruit la table `documents` a partir de ce qui est reellement indexe
 * dans Pinecone.
 *
 *     node --env-file=.env scripts/sync_documents.ts
 *     node --env-file=.env scripts/sync_documents.ts --dry-run
 *
 * Pourquoi lire le vector store plutot que le pipeline d'ingestion : celui-ci
 * tourne encore dans n8n et n'ecrit pas dans Postgres. Or Pinecone sait
 * exactement ce qu'il contient -- chaque chunk porte file_id, file_name et
 * indexed_at, poses lors de la reindexation. Le vector store est donc, pour
 * l'instant, la source de verite sur l'etat de la base documentaire.
 *
 * C'est une reconciliation, pas une ingestion : elle ne cree ni ne supprime
 * aucun vecteur, elle met le catalogue en accord avec la realite.
 */
import { Pinecone } from '@pinecone-database/pinecone';

import { config } from '../src/config.ts';
import { createPgDb } from '../src/db.ts';

const dryRun = process.argv.includes('--dry-run');

const db = createPgDb(config.databaseUrl());
const pinecone = new Pinecone({ apiKey: config.pineconeKey() });
const index = pinecone.index(config.pineconeIndex());

const tenants = await db.query<{ id: string; slug: string; vector_namespace: string }>(
  `SELECT id, slug, vector_namespace FROM tenants WHERE status IN ('trial', 'active')`,
);

interface Doc {
  fileId: string;
  name: string;
  chunks: number;
  indexedAt: string | null;
}

for (const tenant of tenants.rows) {
  const ns = index.namespace(tenant.vector_namespace);

  // Parcours de tous les identifiants du namespace, page par page.
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await ns.listPaginated({ limit: 100, paginationToken: cursor });
    for (const v of page.vectors ?? []) if (v.id) ids.push(v.id);
    cursor = page.pagination?.next;
  } while (cursor);

  if (ids.length === 0) {
    console.log(`  ${tenant.slug.padEnd(18)} namespace "${tenant.vector_namespace}" vide`);
    continue;
  }

  // fetch accepte des lots : on decoupe pour ne pas depasser la taille de requete.
  const byFile = new Map<string, Doc>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = await ns.fetch(ids.slice(i, i + 100));
    for (const record of Object.values(batch.records ?? {})) {
      const meta = (record.metadata ?? {}) as Record<string, unknown>;
      const fileId = typeof meta['file_id'] === 'string' ? meta['file_id'] : null;
      const name = typeof meta['file_name'] === 'string' ? meta['file_name'] : null;
      const indexedAt = typeof meta['indexed_at'] === 'string' ? meta['indexed_at'] : null;
      // Sans file_id, le chunk vient d'une indexation anterieure aux metadonnees :
      // on le regroupe sous une entree explicite plutot que de l'ignorer en silence.
      const key = fileId ?? `sans-metadonnees`;
      const entry = byFile.get(key) ?? {
        fileId: key,
        name: name ?? '(document indexé sans métadonnées)',
        chunks: 0,
        indexedAt,
      };
      entry.chunks += 1;
      if (name) entry.name = name;
      if (indexedAt && (!entry.indexedAt || indexedAt > entry.indexedAt)) entry.indexedAt = indexedAt;
      byFile.set(key, entry);
    }
  }

  console.log(`  ${tenant.slug.padEnd(18)} ${ids.length} vecteurs, ${byFile.size} document(s)`);
  for (const d of byFile.values()) {
    console.log(`     ${d.name.padEnd(40)} ${String(d.chunks).padStart(3)} extraits`);
    if (dryRun) continue;
    await db.query(
      `INSERT INTO documents (tenant_id, source, external_id, name, chunk_count, status, indexed_at)
       VALUES ($1, 'google_drive', $2, $3, $4, 'indexed', $5)
       ON CONFLICT (tenant_id, source, external_id)
         DO UPDATE SET name = EXCLUDED.name,
                       chunk_count = EXCLUDED.chunk_count,
                       status = 'indexed',
                       indexed_at = EXCLUDED.indexed_at`,
      [tenant.id, d.fileId, d.name, d.chunks, d.indexedAt],
    );
  }

  if (!dryRun) {
    // Un document present en base mais absent du vector store n'est plus
    // interrogeable : le marquer plutot que le supprimer garde la trace.
    const present = [...byFile.keys()];
    const { rowCount } = await db.query(
      `UPDATE documents SET status = 'stale'
        WHERE tenant_id = $1 AND status = 'indexed' AND NOT (external_id = ANY($2::text[]))`,
      [tenant.id, present],
    );
    if (rowCount > 0) console.log(`     ${rowCount} document(s) marque(s) obsolete(s)`);
  }
}

console.log(dryRun ? '\n--dry-run : rien ecrit.' : '\nCatalogue synchronise.');
await db.close();
