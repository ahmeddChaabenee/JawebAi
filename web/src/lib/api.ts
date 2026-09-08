export interface Kpis {
  total_conversations: string | number;
  active_conversations: string | number;
  escalated_conversations: string | number;
  total_messages: string | number;
  user_messages: string | number;
  assistant_messages: string | number;
  human_agent_messages: string | number;
  auto_resolution_rate: string | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  tokens_in: string | null;
  tokens_out: string | null;
  total_cost_usd: string | null;
}

export interface Conversation {
  id: string;
  session_key: string;
  status: string;
  last_message_at: string;
  channel: string;
  message_count: number;
  last_question: string | null;
}

export interface Message {
  id: number;
  sender: 'user' | 'assistant' | 'human_agent' | 'system';
  content: string;
  created_at: string;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  retrieval_score: number | null;
  escalated?: boolean;
}

export interface Overview {
  kpis: Kpis | null;
  daily: { day: string; conversations_started: string; messages: string }[];
  channels: { kind: string; n: number }[];
  recent: Conversation[];
  pending_count: { n: number };
  documents: { name: string; status: string; chunk_count: number | null; indexed_at: string | null }[];
}

export interface PendingQuestion {
  id: string;
  question: string;
  created_at: string;
  conversation_id: string;
  session_key: string;
}

export interface Gap {
  question: string;
  times_asked: string;
  last_asked_at: string;
  has_human_answer: boolean;
}

export class Unauthorized extends Error {}

/**
 * Client HTTP d'un espace.
 *
 * Les deux consoles parlent a des API differentes -- /app pour le client,
 * /admin pour l'operateur -- mais affichent les memes ecrans. Cette interface
 * est ce qui permet de partager les composants sans dupliquer une ligne.
 */
export interface Api {
  overview(): Promise<Overview>;
  conversations(includeTests: boolean): Promise<Conversation[]>;
  messages(conversationId: string): Promise<Message[]>;
  pending(): Promise<PendingQuestion[]>;
  answer(id: string, answer: string, promotable: boolean): Promise<void>;
  gaps(): Promise<Gap[]>;
}

async function request<T>(url: string, headers: Record<string, string>, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...headers, ...(init?.headers as object) },
  });
  if (res.status === 401) throw new Unauthorized('session invalide');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
//  Espace client : le tenant vient de la session, jamais de l'URL
// ---------------------------------------------------------------------------
export function clientApi(token: string): Api & {
  me(): Promise<{ user: SessionUser }>;
  logout(): Promise<void>;
  sendTest(sessionId: string, message: string): Promise<void>;
  testMessages(sessionId: string, after: number): Promise<Message[]>;
} {
  const h = { authorization: `Bearer ${token}` };
  const at = (p: string) => `/app/api${p}`;
  return {
    me: () => request(at('/me'), h),
    logout: () => request<void>(at('/logout'), h, { method: 'POST' }),
    overview: () => request<Overview>(at('/overview'), h),
    conversations: async (includeTests) =>
      (await request<{ conversations: Conversation[] }>(
        at(`/conversations?include_tests=${includeTests ? 1 : 0}`), h)).conversations,
    messages: async (id) =>
      (await request<{ messages: Message[] }>(at(`/conversations/${id}`), h)).messages,
    pending: async () => (await request<{ pending: PendingQuestion[] }>(at('/pending'), h)).pending,
    answer: async (id, answer, promotable) => {
      await request(at(`/pending/${id}/answer`), h, {
        method: 'POST', body: JSON.stringify({ answer, promotable }),
      });
    },
    gaps: async () => (await request<{ gaps: Gap[] }>(at('/gaps'), h)).gaps,
    sendTest: async (session_id, message) => {
      await request(at('/test/message'), h, { method: 'POST', body: JSON.stringify({ session_id, message }) });
    },
    testMessages: async (sessionId, after) =>
      (await request<{ messages: Message[] }>(
        at(`/test/messages?session_id=${encodeURIComponent(sessionId)}&after=${after}`), h)).messages,
  };
}

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

export async function loginRequest(email: string, password: string) {
  const res = await fetch('/app/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  return res.json() as Promise<{ token: string; user: SessionUser }>;
}

// ---------------------------------------------------------------------------
//  Back-office operateur : le tenant est choisi dans un selecteur
// ---------------------------------------------------------------------------
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  vector_namespace: string;
}

export function adminApi(token: string, tenantId: string): Api & { tenants(): Promise<Tenant[]> } {
  const h = { 'x-admin-token': token };
  const at = (p: string) => `/admin/api${p}`;
  const q = `tenant_id=${encodeURIComponent(tenantId)}`;
  return {
    tenants: async () => (await request<{ tenants: Tenant[] }>(at('/tenants'), h)).tenants,
    overview: () => request<Overview>(at(`/overview?${q}`), h),
    // Le back-office n'a pas de filtre d'essais : l'operateur voit tout.
    conversations: async () => (await request<Overview>(at(`/overview?${q}`), h)).recent,
    messages: async (id) =>
      (await request<{ messages: Message[] }>(at(`/conversations/${id}`), h)).messages,
    pending: async () => (await request<{ pending: PendingQuestion[] }>(at(`/pending?${q}`), h)).pending,
    answer: async (id, answer, promotable) => {
      await request(at(`/pending/${id}/answer`), h, {
        method: 'POST', body: JSON.stringify({ answer, promotable }),
      });
    },
    gaps: async () => (await request<{ gaps: Gap[] }>(at(`/gaps?${q}`), h)).gaps,
  };
}

export async function checkAdminToken(token: string): Promise<Tenant[] | null> {
  try {
    return (await request<{ tenants: Tenant[] }>('/admin/api/tenants', { 'x-admin-token': token })).tenants;
  } catch {
    return null;
  }
}
