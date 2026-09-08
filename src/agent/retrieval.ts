import { Pinecone } from '@pinecone-database/pinecone';

export interface RetrievedChunk {
  text: string;
  score: number;
  fileName: string | null;
}

export interface Retriever {
  retrieve(query: string, namespace: string, topK?: number): Promise<RetrievedChunk[]>;
}

/**
 * Embeddings Gemini appeles en REST plutot que via un SDK.
 *
 * Un appel `fetch` sur un endpoint documente ne casse pas au gre des versions
 * majeures d'un paquet, et evite une dependance de plus a suivre pour une
 * unique requete.
 */
async function embed(text: string, apiKey: string, model: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY',
    }),
  });

  if (!response.ok) {
    throw new Error(`embeddings Gemini : HTTP ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { embedding?: { values?: number[] } };
  const values = body.embedding?.values;
  if (!values?.length) throw new Error('embeddings Gemini : reponse sans vecteur');
  return values;
}

export function createPineconeRetriever(opts: {
  pineconeApiKey: string;
  indexName: string;
  googleApiKey: string;
  embeddingModel: string;
}): Retriever {
  const pinecone = new Pinecone({ apiKey: opts.pineconeApiKey });
  const index = pinecone.index(opts.indexName);

  return {
    async retrieve(query, namespace, topK = 6) {
      const vector = await embed(query, opts.googleApiKey, opts.embeddingModel);

      // Le namespace isole la connaissance d'un client. Le passer explicitement
      // a chaque requete est ce qui garantit qu'un client ne peut jamais voir
      // les documents d'un autre.
      const result = await index.namespace(namespace).query({
        vector,
        topK,
        includeMetadata: true,
      });

      return (result.matches ?? []).map((match) => {
        const metadata = (match.metadata ?? {}) as Record<string, unknown>;
        const text =
          typeof metadata['text'] === 'string'
            ? metadata['text']
            : typeof metadata['pageContent'] === 'string'
              ? metadata['pageContent']
              : '';
        const fileName = typeof metadata['file_name'] === 'string' ? metadata['file_name'] : null;
        return { text, score: match.score ?? 0, fileName };
      });
    },
  };
}

/**
 * Met en forme les extraits pour le modele.
 *
 * Ils sont transmis tels quels, contrairement au noeud Vector Store Tool de
 * n8n qui les fait d'abord resumer par un second modele -- soit deux appels
 * factures et deux fois la latence pour chaque message.
 */
export function formatChunks(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '(aucun extrait pertinent)';
  return chunks
    .filter((c) => c.text.trim() !== '')
    .map((c, i) => `[${i + 1}]${c.fileName ? ` (${c.fileName})` : ''}\n${c.text.trim()}`)
    .join('\n\n');
}
