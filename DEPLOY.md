# Déploiement sur Oracle Cloud Always Free

Trois conteneurs sur une machine ARM gratuite à vie : le récepteur, le worker,
et Caddy qui gère HTTPS tout seul.

---

## 1. Créer la machine

Console Oracle → **Compute → Instances → Create instance**

| Réglage | Valeur |
|---|---|
| Image | Ubuntu 24.04 (ou 22.04) |
| Shape | **VM.Standard.A1.Flex** — ARM Ampere, `Always Free eligible` |
| OCPU / mémoire | 2 OCPU, 8 Go *(l'offre gratuite en couvre 4 et 24)* |
| Clé SSH | ajouter votre clé publique |

### « Out of host capacity »

C'est le message le plus fréquent, et il n'a rien à voir avec votre compte :
les machines ARM gratuites sont très demandées.

- Essayez un autre **domaine de disponibilité** dans la même région
- Réessayez à un autre moment de la journée
- Passer le compte en **Pay As You Go** donne la priorité **sans rendre payantes
  les ressources Always Free** — c'est la solution la plus fiable, et elle reste
  gratuite tant que vous restez dans les limites

---

## 2. Ouvrir les ports — les DEUX pare-feu

C'est **le** piège d'Oracle Cloud, celui qui fait perdre des heures. Il y a deux
filtrages indépendants, et il faut ouvrir les deux.

### a) Le réseau virtuel (VCN)

Networking → **Virtual Cloud Networks** → votre VCN → **Security Lists** →
*Default Security List* → **Add Ingress Rules** :

| Source | Protocole | Port |
|---|---|---|
| `0.0.0.0/0` | TCP | 80 |
| `0.0.0.0/0` | TCP | 443 |

### b) Le pare-feu de la machine

Les images Ubuntu d'Oracle arrivent avec des règles `iptables` qui **bloquent
tout sauf SSH**. Ouvrir le VCN ne suffit pas : le paquet arrive jusqu'à la
machine et y est rejeté.

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Vérification :

```bash
sudo iptables -L INPUT -n --line-numbers | head -12
```

*(Sur Oracle Linux, c'est `firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload`.)*

---

## 3. Installer Docker

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER
```

Se déconnecter puis se reconnecter pour que l'appartenance au groupe prenne effet.

---

## 4. Pointer le domaine

Un enregistrement **A** vers l'adresse IP publique de l'instance :

```
assistant.votredomaine.tn.   A   <IP publique>
```

Attendre la propagation avant l'étape suivante — Caddy demande le certificat au
démarrage, et Let's Encrypt doit pouvoir résoudre le nom.

```bash
dig +short assistant.votredomaine.tn
```

---

## 5. Déployer

```bash
git clone <votre-dépôt> rag-saas && cd rag-saas
cp .env.example .env
nano .env
```

À renseigner : `DATABASE_URL`, `LLM_API_KEY`, `GOOGLE_API_KEY`,
`PINECONE_API_KEY`, `ADMIN_TOKEN`, `DOMAIN`, et `NODE_ENV=production`.

⚠️ **`NODE_ENV=production` refuse le démarrage** si `ADMIN_TOKEN` ou
`META_APP_SECRET` manquent. C'est voulu : mieux vaut un démarrage qui échoue
bruyamment qu'une console d'administration ouverte sans que personne ne le
remarque.

```bash
docker compose up -d --build
docker compose logs -f
```

Le premier démarrage prend quelques minutes : construction de l'interface, puis
obtention du certificat.

---

## 6. Vérifier

```bash
curl https://assistant.votredomaine.tn/health          # {"ok":true}
docker compose ps                                      # 3 conteneurs "Up"
docker compose exec receiver node scripts/doctor.ts    # les 6 dépendances
```

Puis dans un navigateur : la page d'accueil, `/login`, `/admin`.

---

## Mettre à jour

```bash
git pull && docker compose up -d --build
```

Le worker cesse de réserver de nouveaux événements dès le `SIGTERM` mais termine
celui en cours — d'où le `stop_grace_period: 45s` dans `docker-compose.yml`. Le
délai par défaut de Docker (10 s) le tuerait en pleine génération.

**Limite connue :** un événement interrompu malgré tout resterait en statut
`processing` sans être repris — il n'existe pas encore de reprise automatique.
En cas de doute après un arrêt brutal :

```sql
UPDATE inbound_events SET status = 'received'
 WHERE status = 'processing' AND received_at < now() - interval '10 minutes';
```

## Journaux et redémarrage

```bash
docker compose logs -f worker
docker compose restart receiver
docker compose down          # tout arrêter
```

---

## Ce qui reste hors de la machine

| Service | Offre |
|---|---|
| Supabase | gratuit — **un projet inactif est suspendu après ~7 jours** |
| Pinecone | gratuit |
| Groq | gratuit — **7000 tokens/minute**, soit 2 à 3 messages |

Le plafond Groq sera le premier atteint, bien avant les ressources de la machine.

## Sauvegardes

La base est chez Supabase, donc rien de critique ne vit sur la machine. Pensez
tout de même à conserver `.env` ailleurs : il contient les seuls secrets qui
n'existent nulle part en double.

---

## Non vérifié

Le `Dockerfile` n'a pas pu être construit lors de sa rédaction — le démon Docker
n'était pas actif sur la machine de développement. La syntaxe de
`docker-compose.yml` est validée par `docker compose config` ; la construction
de l'image reste à confirmer au premier `docker compose up --build`.

En cas d'échec, l'étape la plus probable est `npm ci` : vérifier que
`package-lock.json` est bien versionné dans le dépôt.
