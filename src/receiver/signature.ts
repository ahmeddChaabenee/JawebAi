import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifie l'en-tete X-Hub-Signature-256 que Meta joint a chaque livraison.
 *
 * Sans cette verification, n'importe qui connaissant l'URL peut injecter de
 * faux messages : conversations empoisonnees et budget modele vide. L'URL n'est
 * pas un secret -- elle transite par les journaux, les proxys, les captures.
 *
 * La comparaison passe par timingSafeEqual : une comparaison de chaines
 * ordinaire abandonne au premier octet different, ce qui laisse deviner la
 * signature octet par octet en mesurant le temps de reponse.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;

  const [algorithm, provided] = header.split('=');
  if (algorithm !== 'sha256' || !provided) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  // timingSafeEqual exige des longueurs egales, sinon il leve.
  if (a.length !== b.length || a.length === 0) return false;

  return timingSafeEqual(a, b);
}
