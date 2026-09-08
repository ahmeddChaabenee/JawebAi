import OpenAI from 'openai';

import type { Db } from '../db.ts';
import { classifyReply, type EscalationVerdict } from './escalation.ts';
import { loadTenantContext, renderPrompt } from './prompt.ts';
import { formatChunks, type Retriever } from './retrieval.ts';

export interface AgentTurnInput {
  tenantId: string;
  conversationId: string;
  userMessage: string;
}

export interface AgentTurnResult extends EscalationVerdict {
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
  topScore: number | null;
}

export interface ChatModel {
  complete(args: {
    system: string;
    history: { role: 'user' | 'assistant'; content: string }[];
    user: string;
  }): Promise<{ text: string; tokensIn: number; tokensOut: number; model: string }>;
}

/**
 * Groq, OpenRouter, OpenAI et la plupart des autres fournisseurs exposent la
 * meme API : un seul client suffit, seule l'URL de base distingue l'un de
 * l'autre. Changer de fournisseur devient une variable d'environnement.
 */
export function createChatModel(opts: {
  apiKey: string;
  baseURL: string;
  model: string;
}): ChatModel {
  const { apiKey, baseURL, model } = opts;
  const client = new OpenAI({ apiKey, baseURL });

  return {
    async complete({ system, history, user }) {
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          ...history,
          { role: 'user', content: user },
        ],
        temperature: 0.2,
      });

      return {
        text: completion.choices[0]?.message?.content ?? '',
        tokensIn: completion.usage?.prompt_tokens ?? 0,
        tokensOut: completion.usage?.completion_tokens ?? 0,
        model: completion.model ?? model,
      };
    },
  };
}

const HISTORY_TURNS = 10;

/**
 * Un tour de conversation.
 *
 * L'historique est relu depuis `messages` a chaque tour plutot que garde en
 * memoire du processus. C'est ce qui permet a plusieurs workers de traiter la
 * meme conversation sans se marcher dessus -- le defaut exact du Window Buffer
 * Memory de n8n, ou deux messages simultanes lisaient tous deux un historique
 * vide et le second escaladait faute de contexte.
 */
export async function runAgentTurn(
  deps: { db: Db; retriever: Retriever; model: ChatModel },
  input: AgentTurnInput,
): Promise<AgentTurnResult> {
  const startedAt = Date.now();
  const { db, retriever, model } = deps;

  const ctx = await loadTenantContext(db, input.tenantId);
  if (!ctx) throw new Error(`client introuvable ou inactif : ${input.tenantId}`);
  const system = renderPrompt(ctx);

  const { rows: historyRows } = await db.query<{ sender: string; content: string }>(
    `SELECT sender, content
       FROM (SELECT sender, content, id
               FROM messages
              WHERE conversation_id = $1
                AND sender IN ('user', 'assistant', 'human_agent')
              ORDER BY id DESC
              LIMIT $2) recent
      ORDER BY id ASC`,
    [input.conversationId, HISTORY_TURNS],
  );

  const history = historyRows.map((row) => ({
    // Une reponse humaine tient la meme place qu'une reponse de l'agent dans
    // le fil : cote modele, c'est un tour assistant.
    role: row.sender === 'user' ? ('user' as const) : ('assistant' as const),
    content: row.content,
  }));

  const chunks = await retriever.retrieve(input.userMessage, ctx.vector_namespace);
  const topScore = chunks.length > 0 ? Math.max(...chunks.map((c) => c.score)) : null;

  const userBlock = [
    'EXTRAITS DES DOCUMENTS DE L\'ENTREPRISE :',
    formatChunks(chunks),
    '',
    'MESSAGE DU CLIENT :',
    input.userMessage,
  ].join('\n');

  const completion = await model.complete({ system, history, user: userBlock });
  const verdict = classifyReply(completion.text, input.userMessage);

  return {
    ...verdict,
    latencyMs: Date.now() - startedAt,
    tokensIn: completion.tokensIn,
    tokensOut: completion.tokensOut,
    model: completion.model,
    topScore,
  };
}
