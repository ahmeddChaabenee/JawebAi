#!/usr/bin/env python3
"""
Batterie d'evaluation : compare des modeles sur les comportements qui font le
produit, avant de changer de fournisseur.

Elle a deja servi a quelque chose : elle a montre que deux modeles Groq
degradaient l'agent la ou ils avaient l'air equivalents sur le papier. C'est
l'amorce de l'etape 7 -- a lancer a chaque changement de modele ou de prompt,
pas seulement quand on soupconne un probleme.

    export LLM_API_KEY=...
    python scripts/eval_models.py --model openai/gpt-oss-120b
    python scripts/eval_models.py --base-url https://openrouter.ai/api/v1 \
                                  --model google/gemini-3.5-flash
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DOCS = """[1] (tarifs.pdf)
Abonnements FitZone Tunis :
- Standard : 89 TND / mois, sans engagement, hors cours collectifs, sans acces coach.
- Premium : 139 TND / mois, engagement 3 mois minimum, cours collectifs illimites, 1 seance de coaching offerte par mois.
- Etudiant : 69 TND / mois, sans engagement, 2 cours collectifs par semaine, sans acces coach.
Frais d'inscription uniques : 30 TND (offerts pour l'abonnement Premium annuel a 1390 TND).
Paiement : prelevement mensuel par carte ou virement ; especes acceptees a l'accueil pour le mois en cours.

[2] (horaires.pdf)
Lundi a vendredi : 06:00 - 22:30. Samedi : 08:00 - 20:00. Dimanche : 09:00 - 14:00. Jours feries : 10:00 - 16:00.

[3] (activites.pdf)
Cours collectifs : Yoga Vinyasa, CrossTraining, Boxe Fitness, Pilates, Spinning, Zumba.
Zones : musculation, cardio, fonctionnelle.
Coaching particulier avec Aymen ou Salma : 45 minutes a 45 TND, pack de 10 seances a 380 TND.
Parking gratuit pour les adherents.
"""

TOKEN = "[[NEEDS_HUMAN]]"

# expect="answer" : le modele doit repondre.  expect="escalate" : il doit
# emettre le jeton et rien d'autre.  `must` liste ce que la reponse doit
# contenir -- c'est ce qui attrape les erreurs factuelles, pas seulement le
# fait d'avoir repondu quelque chose.
CASES = [
    {
        "id": "arabizi-prix",
        "q": "b9adeh les abonnements",
        "expect": "answer",
        "must": [r"89", r"139", r"69"],
        "must_not": [r"melyoun", r"mlayen"],
    },
    {
        "id": "arabizi-horaires",
        "q": "chnowa el horaires mte3kom",
        "expect": "answer",
        "must": [r"06:00", r"22:30"],
        # "khmiss" = jeudi. Un modele qui l'ecrit a confondu "lundi a vendredi"
        # avec un jour unique : erreur factuelle, pas maladresse de style.
        "must_not": [r"khmiss"],
    },
    {
        "id": "presuppose-faux",
        "q": "Combien coute la piscine ?",
        "expect": "answer",
        "must": [r"(?i)(pas de piscine|n.avons pas|ne proposons pas|ma 3andnech)"],
    },
    {
        "id": "medical",
        "q": "Est-ce que le sport peut soigner mon diabete ?",
        "expect": "escalate",
    },
    {
        "id": "francais-tarifs",
        "q": "Quels sont vos tarifs ?",
        "expect": "answer",
        "must": [r"89", r"139", r"69"],
    },
]


def load_system_prompt() -> str:
    path = os.path.join(ROOT, "db", "examples", "seed_fitzone.sql")
    body = open(path, encoding="utf-8").read().split("$prompt$")[1]
    return (
        body.replace("{{business_name}}", "FitZone Tunis")
        .replace("{{city}}", "Tunis")
        .replace("{{dialect_label}}", "Tunisian dialect")
        .replace("{{default_language}}", "French")
    )


def ask(base_url: str, api_key: str, model: str, system: str, question: str) -> tuple[str, int]:
    payload = {
        "model": model,
        "temperature": 0.2,
        "max_tokens": 1400,
        "messages": [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": f"EXTRAITS DES DOCUMENTS DE L'ENTREPRISE :\n{DOCS}\n\nMESSAGE DU CLIENT :\n{question}",
            },
        ],
    }
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Certains fournisseurs filtrent le User-Agent par defaut d'urllib
            # et repondent 403 : en fixer un explicitement evite un faux negatif.
            "User-Agent": "rag-saas-eval/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as response:
        data = json.load(response)

    message = data["choices"][0]["message"]
    text = (message.get("content") or "").strip()
    return text, data.get("usage", {}).get("completion_tokens", 0)


def judge(case: dict, reply: str) -> tuple[bool, str]:
    escalated = reply.strip() == TOKEN

    if case["expect"] == "escalate":
        return (escalated, "" if escalated else "aurait du escalader")

    if escalated:
        return (False, "escalade a tort : la reponse est dans les documents")
    if not reply:
        return (False, "reponse vide")

    for pattern in case.get("must", []):
        if not re.search(pattern, reply):
            return (False, f"il manque : {pattern}")
    for pattern in case.get("must_not", []):
        if re.search(pattern, reply, re.IGNORECASE):
            return (False, f"contient ce qu'il ne devrait pas : {pattern}")
    return (True, "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--base-url", default=os.environ.get("LLM_BASE_URL", "https://api.groq.com/openai/v1"))
    ap.add_argument("--delay", type=float, default=1.0,
                    help="pause entre appels, pour rester sous les limites de debit")
    args = ap.parse_args()

    api_key = os.environ.get("LLM_API_KEY")
    if not api_key:
        sys.exit("LLM_API_KEY non defini")

    system = load_system_prompt()
    print(f"modele   : {args.model}")
    print(f"endpoint : {args.base_url}\n")

    passed = 0
    for case in CASES:
        try:
            reply, tokens = ask(args.base_url, api_key, args.model, system, case["q"])
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:160]
            print(f"  ERREUR  {case['id']:<18} HTTP {exc.code} {detail}")
            continue
        except Exception as exc:  # noqa: BLE001
            print(f"  ERREUR  {case['id']:<18} {exc}")
            continue

        ok, why = judge(case, reply)
        passed += ok
        shown = TOKEN if reply.strip() == TOKEN else " ".join(reply.split())[:90]
        print(f"  {'OK    ' if ok else 'ECHEC '} {case['id']:<18} {shown}")
        if not ok:
            print(f"          -> {why}")
        time.sleep(args.delay)

    print(f"\n{passed}/{len(CASES)} reussis")
    return 0 if passed == len(CASES) else 1


if __name__ == "__main__":
    raise SystemExit(main())
