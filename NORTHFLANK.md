# Déploiement sur Northflank — plan gratuit

Deux services permanents depuis le même dépôt, HTTPS fourni, **sans nom de
domaine** et sans modifier une ligne de code.

| Plan Sandbox | |
|---|---|
| Services | 2 — *always-on, no sleeping* |
| Base de données | 1 (inutilisée ici : Postgres est chez Supabase) |
| Crons | 2 |
| Prix | 0 € — carte vérifiée, jamais débitée |

Les deux services correspondent exactement aux deux processus : le **récepteur**
et le **worker**.

---

## 1. Connecter le dépôt

Northflank → **Link account** → GitHub → autoriser `ahmeddChaabenee/JawebAi`.

Créer ensuite un **Project** (choisir une région proche, `europe-west` par
exemple).

---

## 2. Le groupe de secrets — à faire en premier

Les deux services partagent la même configuration. Northflank permet de la
déclarer une seule fois.

**Project → Secrets → Create secret group** → nom `env`, portée : les deux
services (à lier après leur création).

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | la chaîne *Session pooler* de Supabase, port 5432 |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` |
| `LLM_API_KEY` | votre clé Groq |
| `LLM_MODEL` | `openai/gpt-oss-120b` |
| `GOOGLE_API_KEY` | clé Gemini — Groq ne fait pas d'embeddings |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` |
| `PINECONE_API_KEY` | votre clé Pinecone |
| `PINECONE_INDEX` | `gym3` |
| `ADMIN_TOKEN` | **obligatoire** — sinon le service refuse de démarrer |
| `PORT` | `8787` |
| `NODE_ENV` | `production` |

`META_APP_SECRET` n'est **pas** requis : sans lui, les routes Messenger ne sont
simplement pas exposées. Le widget web et les deux consoles fonctionnent
normalement. À ajouter le jour où vous brancherez une page Facebook.

---

## 3. Service 1 — le récepteur

**Create new → Service → Combined service** *(construit et déploie)*

| Réglage | Valeur |
|---|---|
| Nom | `receiver` |
| Dépôt / branche | `JawebAi` / `main` |
| Build type | **Dockerfile** — chemin `/Dockerfile` |
| Port | `8787`, protocole **HTTP**, **Publicly exposed** ✅ |
| Health check | `GET /health` |
| Secret group | lier `env` |

La commande de démarrage est celle du `Dockerfile`, rien à saisir.

Northflank attribue une URL du type
`https://receiver--<projet>--<compte>.code.run`.

---

## 4. Service 2 — le worker

Même chose, **avec trois différences** :

| Réglage | Valeur |
|---|---|
| Nom | `worker` |
| **Command override** | `node` |
| **Arguments** | `src/worker.ts` |
| Port | **aucun** — il n'écoute rien |
| Secret group | lier `env` |

C'est tout ce qui distingue les deux : la même image, une commande différente.

---

## 5. Vérifier

```bash
curl https://<votre-url>.code.run/health      # {"ok":true}
```

Puis dans un navigateur :

| | |
|---|---|
| `/` | la page d'accueil |
| `/login` | espace client |
| `/admin` | back-office, avec `ADMIN_TOKEN` |

Le diagnostic complet, depuis l'onglet **Shell** du service `receiver` :

```bash
node scripts/doctor.ts
```

Il vérifie les six dépendances : Postgres, clients, canaux, prompt, Pinecone,
modèle.

Enfin, le test décisif : se connecter à l'espace client et poser une question
depuis **Tester l'agent**. Si la réponse arrive, toute la chaîne fonctionne —
récepteur, base, worker, Pinecone, Groq.

---

## Ce qu'il faut surveiller

**La mémoire.** Northflank ne publie pas l'allocation du Sandbox ; son plus
petit palier est `nf-compute-20` (0,2 vCPU / 0,5 Go), probablement celui
appliqué. Deux services Node consomment ~100-150 Mo chacun, donc la marge existe
— mais c'est à confirmer dans l'onglet **Metrics** après quelques heures.

Si un service redémarre en boucle, c'est le premier endroit à regarder.

**Le CPU n'est pas le sujet** : la charge est en attente réseau — Groq, Pinecone,
Postgres — pas en calcul.

**La construction de l'image** demande plus de ressources que l'exécution. Si le
build échoue faute de mémoire, c'est la limite la plus probable du plan gratuit.

---

## Mettre à jour

`git push` sur `main` : Northflank reconstruit et redéploie les deux services
automatiquement.

---

## Après le déploiement

Le premier client (`fitzone-tunis`) et son compte existent déjà en base, puisque
Postgres est chez Supabase et ne bouge pas. Rien à recréer.

Pour connecter Messenger plus tard : créer l'application Meta, renseigner
`META_APP_SECRET` et `META_VERIFY_TOKEN` dans le groupe de secrets, redéployer,
puis déclarer l'URL de callback
`https://<votre-url>.code.run/webhook/messenger`.
