function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`variable d'environnement manquante : ${name}`);
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  databaseUrl: () => required('DATABASE_URL'),

  // Fournisseur de modele interchangeable. Groq, OpenRouter, OpenAI, Together
  // et la plupart des autres exposent la meme API : seule l'URL de base change.
  // Garder ces trois valeurs en configuration evite d'avoir a toucher au code
  // pour changer de fournisseur ou de modele.
  llmBaseUrl: optional('LLM_BASE_URL', 'https://api.groq.com/openai/v1'),
  llmApiKey: () => required('LLM_API_KEY'),
  llmModel: optional('LLM_MODEL', 'openai/gpt-oss-120b'),

  // Tarif du modele, en dollars par million de tokens. Laisse a 0, le cout
  // reste nul en base : mieux vaut une colonne vide qu'un chiffre invente a
  // partir d'un tarif suppose. A renseigner depuis la page de tarification du
  // fournisseur, elle change souvent.
  llmPriceIn: Number(optional('LLM_PRICE_IN_PER_M', '0')),
  llmPriceOut: Number(optional('LLM_PRICE_OUT_PER_M', '0')),

  googleApiKey: () => required('GOOGLE_API_KEY'),
  embeddingModel: optional('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001'),

  pineconeKey: () => required('PINECONE_API_KEY'),
  pineconeIndex: () => required('PINECONE_INDEX'),

  port: Number(optional('PORT', '8787')),
  workerPollMs: Number(optional('WORKER_POLL_MS', '1000')),

  // Jeton de la console d'administration. Un secret partage suffit tant qu'il
  // n'y a qu'un exploitant ; un vrai systeme de comptes viendra avec le
  // multi-client.
  adminToken: optional('ADMIN_TOKEN'),

  metaAppSecret: optional('META_APP_SECRET'),
  metaVerifyToken: optional('META_VERIFY_TOKEN'),

  isProduction: optional('NODE_ENV', 'development') === 'production',
} as const;

/**
 * Une signature non verifiee laisse n'importe qui injecter de faux messages et
 * vider le budget modele. On tolere l'absence de secret en developpement, mais
 * jamais en production : mieux vaut un demarrage qui echoue bruyamment qu'un
 * endpoint ouvert que personne ne remarque.
 */
export function assertProductionSafety(): void {
  if (config.isProduction && !config.adminToken) {
    throw new Error(
      "ADMIN_TOKEN est obligatoire en production : sans lui, la console d'administration est ouverte.",
    );
  }
  if (config.isProduction && !config.metaAppSecret) {
    throw new Error(
      'META_APP_SECRET est obligatoire en production : sans lui, les webhooks Meta ne sont pas verifies.',
    );
  }
}
