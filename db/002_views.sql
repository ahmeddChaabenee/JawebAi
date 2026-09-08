-- =====================================================================
--  Vues KPI  --  remplacent le calcul JavaScript du workflow dashboard.
--  Ce qui etait recalcule a chaque appel dans un noeud Code devient une
--  requete indexee, et devient interrogeable par client.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
--  KPIs agreges par client
-- ---------------------------------------------------------------------
CREATE VIEW v_tenant_kpis AS
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

    -- Le KPI qui se vend : part des conversations closes sans intervention
    -- humaine. NULL tant qu'il n'y a aucun trafic, jamais 0 -- un taux de 0 %
    -- et une absence de donnees ne veulent pas dire la meme chose.
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
-- Le canal internal_test porte les essais faits depuis la console : les
-- compter fausserait le taux de resolution montre au client.
LEFT JOIN tenant_channels ch
       ON ch.tenant_id = t.id AND ch.kind <> 'internal_test'
LEFT JOIN conversations c ON c.channel_id = ch.id
LEFT JOIN messages      m ON m.conversation_id = c.id
GROUP BY t.id, t.slug, t.name;

-- ---------------------------------------------------------------------
--  Volume quotidien, 30 jours glissants
-- ---------------------------------------------------------------------
CREATE VIEW v_tenant_daily_usage AS
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
--  Lacunes de connaissance : ce que les clients demandent et que les
--  documents ne couvrent pas. C'est le livrable a valeur commerciale --
--  "voici les 12 questions auxquelles vos documents ne repondent pas".
-- ---------------------------------------------------------------------
CREATE VIEW v_knowledge_gaps AS
SELECT
    p.tenant_id,
    lower(btrim(p.question))       AS question,
    count(*)                       AS times_asked,
    min(p.created_at)              AS first_asked_at,
    max(p.created_at)              AS last_asked_at,
    bool_or(p.status = 'answered') AS has_human_answer,
    bool_and(p.promotable)         AS promotable_to_knowledge_base
FROM pending_answers p
GROUP BY p.tenant_id, lower(btrim(p.question))
ORDER BY count(*) DESC, max(p.created_at) DESC;

-- ---------------------------------------------------------------------
--  Fraicheur documentaire
-- ---------------------------------------------------------------------
CREATE VIEW v_document_freshness AS
SELECT
    d.tenant_id,
    d.name,
    d.status,
    d.chunk_count,
    d.indexed_at,
    (now() - d.indexed_at) AS age
FROM documents d
WHERE d.status <> 'deleted';

COMMIT;
