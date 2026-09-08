export interface EscalationVerdict {
  needsHuman: boolean;
  cleanReply: string;
  holdingMessage: string;
  leakedReasoning: boolean;
}

/**
 * Marqueurs de raisonnement laisse dans la reponse.
 *
 * Certains modeles laissent filtrer leur brouillon malgre la consigne. On ne
 * tente pas de nettoyer le texte -- impossible a faire de facon fiable : on
 * bascule vers l'humain. Mieux vaut une escalade de trop qu'un client qui lit
 * les hesitations du modele.
 */
const REASONING_LEAK_MARKERS = [
  "let's ",
  'drafting:',
  'draft:',
  'wait, the user',
  'the user is asking',
  '\nthought\n',
  'this is perfect,',
];

const ARABIZI = /(chnowa|chnuwa|kaddeh|9addeh|b9addeh|famma|3andkom|kifech|nheb|barcha|ya3tik|w9tech)/i;
const ENGLISH = /\b(the|how much|price|hello|hi|what|when|where|do you|can i)\b/i;
const ARABIC_SCRIPT = /[؀-ۿ]/;

/**
 * Message d'attente, dans la langue et l'ecriture du client.
 *
 * Une escalade ne doit jamais se traduire par un silence : le client doit
 * savoir que sa question est partie vers un humain.
 */
export function holdingMessageFor(userMessage: string): string {
  if (ARABIC_SCRIPT.test(userMessage)) {
    return 'سؤالك بعثناه لواحد من الفريق، باش يجاوبك في أقرب وقت.';
  }
  if (ARABIZI.test(userMessage)) {
    return "Sou'alek b3athneh lel équipe, bech yjewbouk fi a9rab wa9t.";
  }
  if (ENGLISH.test(userMessage)) {
    return 'I have passed your question to our team — someone will get back to you shortly.';
  }
  return "J'ai transmis votre question à notre équipe, vous aurez une réponse très vite.";
}

/**
 * Applique le contrat [[NEEDS_HUMAN]].
 *
 * L'agent a pour consigne de ne jamais inventer : s'il ne trouve pas la
 * reponse, il emet ce jeton seul. C'est le garde-fou central du produit, et il
 * vaut mieux que la plupart des chatbots RAG, qui hallucinent plutot que
 * d'admettre leur ignorance.
 */
export function classifyReply(rawReply: string, userMessage: string): EscalationVerdict {
  const raw = rawReply.trim();
  const explicit = raw === '[[NEEDS_HUMAN]]';

  const lower = raw.toLowerCase();
  const leaked = !explicit && REASONING_LEAK_MARKERS.some((m) => lower.includes(m));
  const escalate = explicit || leaked;

  return {
    needsHuman: escalate,
    cleanReply: escalate ? '' : raw,
    holdingMessage: escalate ? holdingMessageFor(userMessage) : '',
    leakedReasoning: leaked,
  };
}
