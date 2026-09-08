import { resolveSecret } from './secrets.ts';

export interface Delivery {
  send(args: {
    channelKind: string;
    channelConfig: Record<string, unknown>;
    recipientId: string;
    text: string;
  }): Promise<void>;
  typing(args: { channelConfig: Record<string, unknown>; recipientId: string }): Promise<void>;
}

const GRAPH = 'https://graph.facebook.com/v21.0/me';

async function callSendApi(token: string, body: unknown): Promise<void> {
  const response = await fetch(`${GRAPH}/messages?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Send API : HTTP ${response.status} ${await response.text()}`);
  }
}

export function createDelivery(): Delivery {
  return {
    /**
     * Sur Messenger, la reponse ne passe pas par la reponse HTTP du webhook --
     * son corps est ignore par Meta. Il faut un appel sortant distinct, avec
     * le token de la page.
     *
     * Le widget web, lui, interroge /widget/messages : rien a envoyer ici,
     * le message est deja en base.
     */
    async send({ channelKind, channelConfig, recipientId, text }) {
      if (channelKind !== 'messenger' && channelKind !== 'instagram') return;

      const token = resolveSecret((channelConfig as { secret_ref?: string }).secret_ref);
      if (!token) throw new Error('token de page introuvable pour ce canal');

      await callSendApi(token, {
        recipient: { id: recipientId },
        messaging_type: 'RESPONSE',
        message: { text },
      });
    },

    async typing({ channelConfig, recipientId }) {
      const token = resolveSecret((channelConfig as { secret_ref?: string }).secret_ref);
      if (!token) return;
      await callSendApi(token, { recipient: { id: recipientId }, sender_action: 'typing_on' });
    },
  };
}
