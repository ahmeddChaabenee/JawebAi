-- =====================================================================
--  Espace client : comptes, sessions, et isolation des essais
--
--  Deux produits distincts partagent la meme base :
--    * le back-office operateur  -> voit tous les clients, un jeton partage
--    * la console client         -> voit UN client, un compte par personne
--
--  La difference tient a une seule regle : dans l'espace client, le
--  tenant_id vient de la session, jamais d'un parametre de requete.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
--  Comptes
-- ---------------------------------------------------------------------
CREATE TABLE tenant_users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    email         text NOT NULL,
    -- Format "scrypt$<sel>$<empreinte>". scrypt vient du coeur de Node :
    -- aucune dependance a suivre pour la partie la plus sensible du systeme.
    password_hash text NOT NULL,
    name          text,
    role          text NOT NULL DEFAULT 'owner'
                  CHECK (role IN ('owner', 'agent')),
    status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
);

-- Une adresse ne peut appartenir qu'a un seul client : sans cela, la
-- connexion serait ambigue.
CREATE UNIQUE INDEX tenant_users_email_key ON tenant_users (lower(email));
CREATE INDEX tenant_users_tenant_idx ON tenant_users (tenant_id);

-- ---------------------------------------------------------------------
--  Sessions
-- ---------------------------------------------------------------------
CREATE TABLE sessions (
    -- Empreinte SHA-256 du jeton, jamais le jeton lui-meme : une fuite de la
    -- base ne permet pas d'usurper une session en cours.
    token_hash text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES tenant_users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    user_agent text
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------
--  Les essais ne doivent pas fausser les chiffres montres au client
--
--  Le canal internal_test sert aux essais depuis la console. Sans cette
--  exclusion, chaque question posee pour verifier l'agent gonflerait le
--  taux de resolution automatique -- exactement ce qui est arrive avec les
--  71 sessions de test dans les Data Tables n8n.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_tenant_kpis AS
SELECT
    t.id   AS tenant_id,
    t.slug,
    t.name,

    count(DISTINCT c.id)                                              AS total_conversations,
    count(DISTINCT c.id) FILTER (WHERE c.status = 'active')           AS active_conversations,
    count(DISTINCT c.id) FILTER (WHERE c.status = 'escalated')        AS escalated_conversations,

    count(m.id)                                                       AS total_messages,
    count(m.id) FILTER (WHERE m.sender = 'user')                      AS user_messages,
    count(m.id) FILTER (WHERE m.sender = 'assistant')                 AS assistant_messages,
    count(m.id) FILTER (WHERE m.sender = 'human_agent')               AS human_agent_messages,

    CASE
        WHEN count(DISTINCT c.id) = 0 THEN NULL
        ELSE round(
            (count(DISTINCT c.id)
             - count(DISTINCT c.id) FILTER (WHERE c.status = 'escalated')
            )::numeric / count(DISTINCT c.id), 3)
    END                                                               AS auto_resolution_rate,

    percentile_cont(0.5)  WITHIN GROUP (ORDER BY m.latency_ms)        AS latency_p50_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY m.latency_ms)        AS latency_p95_ms,

    sum(m.tokens_in)                                                  AS tokens_in,
    sum(m.tokens_out)                                                 AS tokens_out,
    sum(m.cost_usd)                                                   AS total_cost_usd,
    CASE
        WHEN count(DISTINCT c.id) = 0 THEN NULL
        ELSE round(sum(m.cost_usd) / count(DISTINCT c.id), 6)
    END                                                               AS cost_per_conversation_usd
FROM tenants t
LEFT JOIN tenant_channels ch
       ON ch.tenant_id = t.id AND ch.kind <> 'internal_test'
LEFT JOIN conversations c ON c.channel_id = ch.id
LEFT JOIN messages      m ON m.conversation_id = c.id
GROUP BY t.id, t.slug, t.name;

CREATE OR REPLACE VIEW v_tenant_daily_usage AS
WITH days AS (
    SELECT generate_series(
               (current_date - interval '29 days')::date,
               current_date,
               interval '1 day')::date AS day
)
SELECT
    t.id AS tenant_id,
    t.slug,
    d.day,
    count(DISTINCT c.id) AS conversations_started,
    count(m.id)          AS messages
FROM tenants t
CROSS JOIN days d
LEFT JOIN tenant_channels ch
       ON ch.tenant_id = t.id AND ch.kind <> 'internal_test'
LEFT JOIN conversations c
       ON c.channel_id = ch.id
      AND c.started_at >= d.day
      AND c.started_at <  d.day + interval '1 day'
LEFT JOIN messages m
       ON m.conversation_id = c.id
      AND m.created_at >= d.day
      AND m.created_at <  d.day + interval '1 day'
GROUP BY t.id, t.slug, d.day;

-- ---------------------------------------------------------------------
--  Verrouillage, comme pour les autres tables (voir 003_rls_supabase.sql)
-- ---------------------------------------------------------------------
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions     ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tenant_users, sessions FROM anon, authenticated;

COMMIT;
