-- =====================================================================
--  Verrouillage RLS  --  OBLIGATOIRE sur Supabase
--
--  Supabase publie automatiquement les tables du schema public via une API
--  REST (PostgREST) accessible avec la cle "anon", qui est publique par
--  conception : elle est livree dans le code du frontend.
--
--  Sans ce fichier, n'importe qui possedant cette cle peut lire les
--  conversations, les messages et les coordonnees des prospects de tous tes
--  clients. Ce n'est pas une precaution theorique : c'est le comportement par
--  defaut de la plateforme.
--
--  Activer RLS sans definir la moindre politique = refus par defaut pour les
--  roles anon et authenticated. Le backend, lui, se connecte avec le role
--  postgres (proprietaire des tables) ou service_role, qui contournent RLS :
--  il continue de fonctionner sans aucune adaptation.
--
--  Le jour ou tu voudras interroger ces tables directement depuis le frontend,
--  tu ajouteras des politiques ciblees ici -- pas avant.
-- =====================================================================

BEGIN;

ALTER TABLE prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_channels  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_tools     ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_answers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads            ENABLE ROW LEVEL SECURITY;

-- Ceinture et bretelles : Supabase accorde par defaut des privileges aux roles
-- de l'API sur les nouvelles tables du schema public. RLS suffirait a bloquer
-- les lignes, mais retirer aussi les privileges evite qu'une politique ajoutee
-- par megarde plus tard n'ouvre tout d'un coup.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Les vues KPI heritent des droits de leur createur : les retirer aussi.
REVOKE ALL ON v_tenant_kpis        FROM anon, authenticated;
REVOKE ALL ON v_tenant_daily_usage FROM anon, authenticated;
REVOKE ALL ON v_knowledge_gaps     FROM anon, authenticated;
REVOKE ALL ON v_document_freshness FROM anon, authenticated;

COMMIT;
