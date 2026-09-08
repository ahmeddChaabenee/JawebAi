-- =====================================================================
--  DESTRUCTIF  --  outil de developpement uniquement
--
--  Supprime toutes les tables, vues et fonctions du socle, avec leurs
--  donnees. A n'utiliser que sur une base de developpement vide ou
--  jetable, jamais sur une base portant des conversations reelles.
--
--  Volontairement place hors de db/ : apply_sql.py ne lit que db/*.sql,
--  ce fichier ne peut donc pas partir par accident.
--
--  Usage :
--      python scripts/apply_sql.py --file db/dev/reset.sql
--      python scripts/apply_sql.py
-- =====================================================================

BEGIN;

DROP VIEW IF EXISTS
    v_document_freshness,
    v_knowledge_gaps,
    v_tenant_daily_usage,
    v_tenant_kpis
CASCADE;

DROP TABLE IF EXISTS
    leads,
    pending_answers,
    inbound_events,
    messages,
    conversations,
    documents,
    tenant_tools,
    tenant_channels,
    tenants,
    prompt_templates
CASCADE;

DROP FUNCTION IF EXISTS set_updated_at() CASCADE;

COMMIT;
