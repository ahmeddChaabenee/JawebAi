/**
 * Resolution des secrets par client.
 *
 * `tenant_channels.secret_ref` ne contient jamais un secret, seulement une
 * reference. Cette implementation la resout depuis l'environnement :
 *
 *     secret_ref = "FITZONE_PAGE_TOKEN"  ->  process.env.SECRET_FITZONE_PAGE_TOKEN
 *
 * C'est volontairement rudimentaire mais deja correct : aucun token de page ne
 * transite par la base, donc une fuite de la base ne donne acces a aucun compte
 * Meta. Le jour ou tu passes a un vrai coffre (Doppler, Vault, Supabase Vault),
 * seule cette fonction change.
 */
export function resolveSecret(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (!/^[A-Z0-9_]{1,64}$/.test(ref)) return null; // pas de lecture arbitraire de l'env
  return process.env[`SECRET_${ref}`] ?? null;
}
