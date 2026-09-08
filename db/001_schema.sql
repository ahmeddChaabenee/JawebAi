-- =====================================================================
--  Socle de donnees multi-tenant  --  etape 0
--  PostgreSQL 14+
--
--  Trois contraintes portent tout le reste, et doivent exister AVANT
--  qu'il y ait des donnees a migrer :
--    * UNIQUE (kind, external_id)                  -> routage webhook -> client
--    * UNIQUE (channel_id, provider_message_id)    -> deduplication gratuite
--    * UNIQUE (tenant_id, channel_id, session_key) -> plus de course sur l'upsert
-- =====================================================================

BEGIN;

-- gen_random_uuid() fait partie du coeur depuis PostgreSQL 13 : pas d'extension
-- a installer. Sur une base geree comme Supabase, creer une extension peut
-- echouer faute de droits, ou l'installer dans le mauvais schema.

-- ---------------------------------------------------------------------
--  Personnalisation : templates de prompt, versionnes
--
--  "key" est une etiquette LIBRE, choisie par toi : 'default', 'support-fr',
--  'gym', 'vente'... Le produit n'a pas de metier -- rien dans le schema ne
--  presuppose un secteur d'activite, et aucun client n'est oblige d'etre
--  classe dans une categorie pour exister.
--
--  Plusieurs clients partageant la meme cle partagent le meme prompt :
--  le corriger une fois le corrige pour tous.
-- ---------------------------------------------------------------------
CREATE TABLE prompt_templates (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key        text        NOT NULL,
    version    integer     NOT NULL,
    body       text        NOT NULL,   -- contient {{business_name}}, {{city}}, ...
    notes      text,
    is_active  boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (key, version)
);

-- Une seule version active par cle, garantie par la base. Faire evoluer un
-- prompt = inserer la version n+1 active et desactiver la precedente dans la
-- meme transaction ; l'historique reste, le retour arriere est immediat.
CREATE UNIQUE INDEX prompt_templates_one_active_per_key
    ON prompt_templates (key) WHERE is_active;

-- ---------------------------------------------------------------------
--  Le client
-- ---------------------------------------------------------------------
CREATE TABLE tenants (
    id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug   text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    name   text NOT NULL,
    status text NOT NULL DEFAULT 'trial'
           CHECK (status IN ('trial', 'active', 'suspended', 'archived')),

    -- Simple etiquette descriptive, facultative, pour tes propres statistiques
    -- commerciales. AUCUNE contrainte ni logique ne s'appuie dessus : un client
    -- peut parfaitement exister sans secteur d'activite.
    industry text,

    -- Isole la connaissance d'un client des autres dans le vector store.
    vector_namespace text NOT NULL UNIQUE,

    -- Toute la personnalisation "sans code" vit ici : nom commercial, ville,
    -- ton, langues, fuseau, devise, regles d'escalade, branding du widget.
    -- C'est ce qui evite d'avoir a forker le code par client.
    config jsonb NOT NULL DEFAULT '{}'::jsonb,

    prompt_template_id uuid REFERENCES prompt_templates (id),
    prompt_overrides   jsonb NOT NULL DEFAULT '{}'::jsonb,

    monthly_message_quota integer,   -- NULL = illimite

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
--  Canaux connectes
-- ---------------------------------------------------------------------
CREATE TABLE tenant_channels (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    kind      text NOT NULL CHECK (kind IN (
                  'web_widget', 'messenger', 'instagram',
                  'whatsapp', 'telegram', 'internal_test')),

    -- Identifiant cote fournisseur : page id Messenger, phone_number_id
    -- WhatsApp, cle publique du widget. C'est la cle de routage d'un webhook
    -- entrant vers le bon client : sans elle, impossible de savoir a qui
    -- appartient un message qui arrive.
    external_id text NOT NULL,

    -- Reference vers le coffre a secrets, jamais le secret lui-meme.
    secret_ref text,

    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),

    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, external_id)
);

CREATE INDEX tenant_channels_tenant_idx ON tenant_channels (tenant_id);

-- ---------------------------------------------------------------------
--  Outils activables par client  (la reponse a "prendre des actions")
-- ---------------------------------------------------------------------
CREATE TABLE tenant_tools (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    tool_key  text NOT NULL,
    enabled   boolean NOT NULL DEFAULT true,

    -- Parametres propres au client : id de calendrier, endpoint CRM, et pour
    -- http_custom / mcp le schema JSON des arguments. C'est ce qui permet une
    -- integration sur mesure sans deployer une ligne de code.
    config jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, tool_key)
);

-- ---------------------------------------------------------------------
--  Documents indexes  (fraicheur de la base, purge ciblee, citations)
-- ---------------------------------------------------------------------
CREATE TABLE documents (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    source      text NOT NULL DEFAULT 'google_drive',
    external_id text NOT NULL,          -- file id Drive
    name        text NOT NULL,
    mime_type   text,
    checksum    text,                   -- evite de reindexer un fichier inchange
    chunk_count integer,
    status      text NOT NULL DEFAULT 'indexed'
                CHECK (status IN ('indexed', 'stale', 'failed', 'deleted')),
    indexed_at  timestamptz,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, source, external_id)
);

-- ---------------------------------------------------------------------
--  Conversations
-- ---------------------------------------------------------------------
CREATE TABLE conversations (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES tenant_channels (id) ON DELETE CASCADE,

    -- Identifiant de l'utilisateur final cote canal : PSID Messenger,
    -- numero WhatsApp, session du widget.
    session_key text NOT NULL,

    status text NOT NULL DEFAULT 'active'
           CHECK (status IN ('active', 'escalated', 'closed')),
    locale text,

    started_at      timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz NOT NULL DEFAULT now(),

    -- Verrou de serialisation par conversation (etape 2).
    -- Une seule instruction atomique suffit a le prendre :
    --
    --   UPDATE conversations
    --      SET processing_until = now() + interval '60 seconds'
    --    WHERE id = $1
    --      AND (processing_until IS NULL OR processing_until < now())
    --   RETURNING id;
    --
    -- Si elle renvoie une ligne, le worker detient le verrou ; sinon un autre
    -- le detient deja. Le TTL le libere tout seul si le worker meurt en pleine
    -- generation, ce qu'un verrou en memoire ne sait pas faire.
    processing_until timestamptz,

    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

    UNIQUE (tenant_id, channel_id, session_key)
);

CREATE INDEX conversations_recent_idx ON conversations (tenant_id, last_message_at DESC);
CREATE INDEX conversations_status_idx ON conversations (tenant_id, status);
CREATE INDEX conversations_lock_idx   ON conversations (processing_until)
    WHERE processing_until IS NOT NULL;

-- ---------------------------------------------------------------------
--  Messages
-- ---------------------------------------------------------------------
CREATE TABLE messages (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    sender          text NOT NULL
                    CHECK (sender IN ('user', 'assistant', 'human_agent', 'system')),
    content         text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- Champs de mesure. Les remplir des le depart coute exactement le meme
    -- INSERT et debloque latence, cout, langue, intention et qualite de
    -- retrieval -- aucun ne peut etre reconstruit apres coup.
    language        text,
    intent          text,
    model           text,
    latency_ms      integer,
    tokens_in       integer,
    tokens_out      integer,
    cost_usd        numeric(12, 6),
    retrieval_score real,
    escalated       boolean NOT NULL DEFAULT false,

    provider_message_id text
);

CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_tenant_time_idx  ON messages (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------
--  Evenements entrants  (idempotence)
-- ---------------------------------------------------------------------
CREATE TABLE inbound_events (
    id         bigserial PRIMARY KEY,
    tenant_id  uuid REFERENCES tenants (id) ON DELETE CASCADE,
    channel_id uuid REFERENCES tenant_channels (id) ON DELETE CASCADE,

    -- Identifiant du message chez le fournisseur : mid Messenger, id WhatsApp,
    -- update_id Telegram. Ces plateformes livrent en at-least-once et rejouent
    -- ce qui n'est pas acquitte : c'est cette contrainte d'unicite qui rend la
    -- deduplication gratuite -- la base refuse le doublon, l'application n'a
    -- rien a verifier elle-meme.
    provider_message_id text NOT NULL,

    payload      jsonb   NOT NULL,
    status       text    NOT NULL DEFAULT 'received'
                 CHECK (status IN ('received', 'processing', 'done', 'failed')),
    attempts     integer NOT NULL DEFAULT 0,
    last_error   text,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,

    UNIQUE (channel_id, provider_message_id)
);

CREATE INDEX inbound_events_backlog_idx ON inbound_events (status, received_at)
    WHERE status IN ('received', 'processing');

-- ---------------------------------------------------------------------
--  Escalades
-- ---------------------------------------------------------------------
CREATE TABLE pending_answers (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    question        text NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'answered', 'dismissed')),
    answer          text,
    answered_by     text,

    -- Empeche la promotion vers la base documentaire d'une reponse medicale,
    -- juridique ou financiere. Sans ce garde-fou, la boucle d'apprentissage
    -- finirait par enseigner a l'agent qu'il peut repondre sur le diabete.
    promotable  boolean NOT NULL DEFAULT true,
    promoted_at timestamptz,

    created_at  timestamptz NOT NULL DEFAULT now(),
    answered_at timestamptz,

    CHECK (status <> 'answered' OR answer IS NOT NULL)
);

CREATE INDEX pending_answers_queue_idx
    ON pending_answers (tenant_id, status, created_at DESC);

-- ---------------------------------------------------------------------
--  Leads
-- ---------------------------------------------------------------------
CREATE TABLE leads (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
    name            text,
    phone           text,
    email           text,
    interest        text,
    status          text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'contacted', 'converted', 'lost')),
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX leads_tenant_idx ON leads (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------
--  updated_at automatique
-- ---------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger AS $fn$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_set_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER documents_set_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
