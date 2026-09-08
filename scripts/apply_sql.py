#!/usr/bin/env python3
"""
Applique les fichiers SQL de db/ dans l'ordre, sans avoir psql installe.

    pip install "psycopg[binary]"
    export DATABASE_URL="postgresql://postgres.<ref>:<motdepasse>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres"
    python scripts/apply_sql.py --dry-run
    python scripts/apply_sql.py

Sur Supabase, prendre la chaine "Session pooler" (port 5432) dans
Project Settings -> Database, pas la "Transaction pooler" (6543) : le mode
transaction ne supporte ni les instructions preparees ni tout ce qui tient sur
la duree d'une session, ce qui gene les migrations.
Les instructions preparees sont desactivees ci-dessous par precaution, pour que
le script fonctionne aussi via le pooler en mode transaction.
"""

from __future__ import annotations

import argparse
import glob
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="liste les fichiers sans se connecter")
    ap.add_argument("--only", help="n'appliquer qu'un fichier de db/, ex. 003_rls_supabase.sql")
    ap.add_argument("--file", help="appliquer un chemin precis, y compris hors de db/ "
                                   "(ex. db/dev/reset.sql, db/examples/seed_fitzone.sql)")
    args = ap.parse_args()

    if args.file:
        path = args.file if os.path.isabs(args.file) else os.path.join(HERE, args.file)
        if not os.path.isfile(path):
            sys.exit(f"fichier introuvable : {args.file}")
        files = [path]
    else:
        # Glob volontairement non recursif : db/dev/ et db/examples/ ne doivent
        # jamais partir par accident.
        files = sorted(glob.glob(os.path.join(HERE, "db", "*.sql")))
        if args.only:
            files = [f for f in files if os.path.basename(f) == args.only]
            if not files:
                sys.exit(f"fichier introuvable : {args.only}")

    if args.dry_run:
        print("fichiers qui seraient appliques, dans cet ordre :")
        for f in files:
            n = sum(1 for line in open(f, encoding="utf-8"))
            print(f"  {os.path.basename(f):<28} {n:>4} lignes")
        return 0

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL non defini")

    try:
        import psycopg
    except ImportError:
        sys.exit('psycopg manquant :  pip install "psycopg[binary]"')

    # autocommit : chaque fichier porte son propre BEGIN/COMMIT, on le laisse
    # piloter ses transactions plutot que d'en ouvrir une par-dessus.
    with psycopg.connect(dsn, autocommit=True, prepare_threshold=None) as conn:
        cur = conn.cursor()
        cur.execute("SELECT current_database(), current_user, version()")
        db, user, version = cur.fetchone()
        print(f"connecte  base={db}  role={user}")
        print(f"          {version.split(',')[0]}")
        print()

        for f in files:
            name = os.path.basename(f)
            sql = open(f, encoding="utf-8").read()
            try:
                cur.execute(sql)
                print(f"  OK      {name}")
            except Exception as exc:
                print(f"  ECHEC   {name}")
                print(f"          {type(exc).__name__}: {exc}")
                print("\nRien de ce fichier n'a ete applique (son BEGIN/COMMIT "
                      "garantit le tout-ou-rien). Corriger puis relancer.")
                return 1

    print("\nschema applique.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
