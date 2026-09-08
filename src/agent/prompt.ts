import type { Db } from '../db.ts';

export interface TenantContext {
  tenant_id: string;
  slug: string;
  name: string;
  vector_namespace: string;
  config: Record<string, unknown>;
  prompt_body: string | null;
  prompt_overrides: Record<string, unknown>;
}

export async function loadTenantContext(db: Db, tenantId: string): Promise<TenantContext | null> {
  const { rows } = await db.query<TenantContext>(
    `SELECT t.id AS tenant_id, t.slug, t.name, t.vector_namespace,
            t.config, t.prompt_overrides, p.body AS prompt_body
       FROM tenants t
       LEFT JOIN prompt_templates p ON p.id = t.prompt_template_id
      WHERE t.id = $1 AND t.status IN ('trial', 'active')`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/**
 * Remplace les {{placeholders}} du template par les valeurs du client.
 *
 * C'est le mecanisme qui evite de dupliquer le systeme par client : le prompt
 * est un objet partage, les valeurs sont des donnees. Corriger le template
 * corrige tous les clients qui l'utilisent.
 *
 * Les surcharges du client l'emportent sur sa configuration, ce qui permet un
 * ecart ponctuel sans quitter le template commun.
 *
 * Un placeholder sans valeur est laisse tel quel plutot que remplace par du
 * vide : un prompt visiblement casse se repere en lecture, un prompt
 * silencieusement ampute produit des reponses fausses sans prevenir.
 */
export function renderPrompt(ctx: TenantContext): string {
  if (!ctx.prompt_body) {
    throw new Error(`le client ${ctx.slug} n'a pas de template de prompt associe`);
  }

  const values: Record<string, unknown> = {
    business_name: ctx.name,
    ...ctx.config,
    ...ctx.prompt_overrides,
  };

  return ctx.prompt_body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? whole : String(value);
  });
}
