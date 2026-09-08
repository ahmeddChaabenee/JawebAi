#!/usr/bin/env python3
"""
Migration des Data Tables n8n vers Postgres.

Source : l'endpoint dashboard deja en production, qui expose conversations,
messages et questions en attente en un seul appel JSON. C'est le seul acces
possible depuis l'exterieur : les Data Tables vivent dans la base interne de
n8n et ne sont pas interrogeables directement.

Le script est idempotent -- ON CONFLICT DO NOTHING partout -- donc rejouable
sans creer de doublons.

    pip install "psycopg[binary]" requests

    export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
    python scripts/migrate_from_n8n.py --dry-run
    python scripts/migrate_from_n8n.py
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

import requests

# psycopg n'est importe qu'au moment d'ecrire : --dry-run doit tourner sur une
# machine sans pilote Postgres installe.
def _connect(dsn: str):
    try:
        import psycopg
    except ImportError:
        sys.exit('psycopg manquant :  pip install "psycopg[binary]"')
    return psycopg.connect(dsn)


DASHBOARD_URL = os.environ.get(
    "N8N_DASHBOARD_URL",
    "https://n8n-5otx.srv1908747.hstgr.cloud/webhook/rag-dashboard-data",
)
TENANT_SLUG = os.environ.get("TENANT_SLUG", "fitzone-tunis")

# Sessions generees automatiquement par les tests de charge et de verification
# du 2026-09-07. Elles fausseraient le taux de resolution automatique des le
# premier rapport client, donc elles ne passent pas la frontiere.
#
# A ne PAS confondre avec les sessions "test-widget-*" et les cas nommes
# ("test-arabizi-accuracy-1", "test-reasoning-leak-1", "test-pending-flow-*") :
# ce sont de vrais essais manuels, le seul historique d'usage qui existe, et
# les cas nommes sont l'amorce naturelle du jeu d'evaluation.
SYNTHETIC_PREFIXES = (
    "conc-", "load-", "burst-", "race-", "mem-", "memrace-", "debounce-",
    "iso-", "bat-", "probe-", "flake-", "claude-verif-", "gap5-", "gap20-",
    "loop-", "med-", "deb-", "ar-",
)


def is_test_session(session_key: str) -> bool:
    return any(session_key.startswith(p) for p in SYNTHETIC_PREFIXES)


def parse_ts(value, fallback: datetime) -> datetime:
    if not value:
        return fallback
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return fallback


def channel_kind_for(source: str) -> str:
    return "internal_test" if source == "internal_test" else "web_widget"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="analyse et affiche le plan sans rien ecrire")
    ap.add_argument("--keep-synthetic", action="store_true",
                    help="migre aussi les sessions generees par les tests de charge")
    args = ap.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn and not args.dry_run:
        return int(bool(sys.stderr.write("DATABASE_URL non defini\n"))) or 1

    print(f"lecture de {DASHBOARD_URL}")
    payload = requests.get(DASHBOARD_URL, timeout=60).json()

    conversations = [c for c in payload.get("conversations", []) if c.get("session_key")]
    pending_all = payload.get("pending", [])

    kept, skipped = [], []
    for c in conversations:
        if not args.keep_synthetic and is_test_session(c["session_key"]):
            skipped.append(c)
        else:
            kept.append(c)

    n_msgs = sum(len(c.get("messages", [])) for c in kept)
    keys = {c["session_key"] for c in kept}
    pending = [p for p in pending_all if p.get("session_key") in keys]

    print(f"  conversations retenues : {len(kept)}")
    print(f"  conversations de test ignorees : {len(skipped)}")
    print(f"  messages : {n_msgs}")
    print(f"  questions en attente : {len(pending)}")

    if args.dry_run:
        print("\n--dry-run : aucune ecriture.")
        for c in kept[:10]:
            print(f"    {c['session_key']:<40} {c.get('status'):<10} "
                  f"{len(c.get('messages', []))} msg")
        if len(kept) > 10:
            print(f"    ... et {len(kept) - 10} autres")
        return 0

    inserted_conv = inserted_msg = inserted_pending = 0

    with _connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM tenants WHERE slug = %s", (TENANT_SLUG,))
        row = cur.fetchone()
        if not row:
            sys.exit(f"tenant '{TENANT_SLUG}' absent : appliquer 003_seed_gym.sql d'abord")
        tenant_id = row[0]

        cur.execute(
            "SELECT kind, id FROM tenant_channels WHERE tenant_id = %s", (tenant_id,)
        )
        channels = dict(cur.fetchall())
        if "web_widget" not in channels:
            sys.exit("canal web_widget absent : appliquer 003_seed_gym.sql d'abord")

        for c in kept:
            session_key = c["session_key"]
            kind = channel_kind_for(c.get("channel") or "web_widget")
            channel_id = channels.get(kind) or channels["web_widget"]

            last_at = parse_ts(c.get("last_message_at"), datetime.now(timezone.utc))
            started_at = parse_ts(c.get("started_at"), last_at)
            status = c.get("status") if c.get("status") in ("active", "escalated", "closed") else "active"

            cur.execute(
                """
                INSERT INTO conversations
                       (tenant_id, channel_id, session_key, status,
                        started_at, last_message_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (tenant_id, channel_id, session_key) DO NOTHING
                RETURNING id
                """,
                (tenant_id, channel_id, session_key, status, started_at, last_at),
            )
            got = cur.fetchone()
            if got:
                conversation_id = got[0]
                inserted_conv += 1
            else:
                cur.execute(
                    """SELECT id FROM conversations
                        WHERE tenant_id = %s AND channel_id = %s AND session_key = %s""",
                    (tenant_id, channel_id, session_key),
                )
                conversation_id = cur.fetchone()[0]

            for m in c.get("messages", []):
                sender = m.get("sender")
                if sender not in ("user", "assistant", "human_agent", "system"):
                    sender = "system"
                content = m.get("content")
                if content is None or str(content).strip() == "":
                    continue
                cur.execute(
                    """
                    INSERT INTO messages
                           (tenant_id, conversation_id, sender, content, created_at)
                    SELECT %s, %s, %s, %s, %s
                     WHERE NOT EXISTS (
                           SELECT 1 FROM messages
                            WHERE conversation_id = %s
                              AND sender = %s
                              AND content = %s
                              AND created_at = %s)
                    """,
                    (tenant_id, conversation_id, sender, content,
                     parse_ts(m.get("created_at"), last_at),
                     conversation_id, sender, content,
                     parse_ts(m.get("created_at"), last_at)),
                )
                inserted_msg += cur.rowcount

            for p in pending:
                if p.get("session_key") != session_key:
                    continue
                p_status = p.get("status") if p.get("status") in ("pending", "answered", "dismissed") else "pending"
                answer = p.get("answer")
                if p_status == "answered" and not answer:
                    # La contrainte CHECK refuse un "answered" sans reponse :
                    # ces lignes venaient d'une edition manuelle dans l'UI n8n.
                    p_status = "pending"
                cur.execute(
                    """
                    INSERT INTO pending_answers
                           (tenant_id, conversation_id, question, status,
                            answer, created_at, answered_at)
                    SELECT %s, %s, %s, %s, %s, %s, %s
                     WHERE NOT EXISTS (
                           SELECT 1 FROM pending_answers
                            WHERE conversation_id = %s AND question = %s)
                    """,
                    (tenant_id, conversation_id, p.get("question"), p_status,
                     answer, parse_ts(p.get("created_at"), last_at),
                     parse_ts(p.get("answered_at"), None) if p.get("answered_at") else None,
                     conversation_id, p.get("question")),
                )
                inserted_pending += cur.rowcount

        conn.commit()

    print("\nmigration terminee")
    print(f"  conversations inserees   : {inserted_conv}")
    print(f"  messages inseres         : {inserted_msg}")
    print(f"  questions en attente     : {inserted_pending}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
