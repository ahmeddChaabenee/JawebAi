# Image unique pour les deux processus : le recepteur et le worker partagent le
# meme code, seule la commande de demarrage change. Une seule image a
# construire, a pousser et a garder a jour.
#
# node:24 : le code TypeScript est execute directement, sans compilation --
# le retrait des types est natif depuis Node 23.6. Il n'y a donc pas d'etape
# de build cote serveur, seulement pour l'interface.
#
# Les images officielles sont multi-architecture : la meme fonctionne sur les
# machines ARM Ampere d'Oracle Cloud et sur un x86 classique.

# --- construction de l'interface -------------------------------------------
FROM node:24-alpine AS web

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts ./
COPY web ./web
RUN npm run web:build

# --- image d'execution ------------------------------------------------------
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# --omit=dev : ni Vite, ni TypeScript, ni PGlite dans l'image finale.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY --from=web /build/web/dist ./web/dist

# Ne jamais tourner en root : si le processus est compromis, il ne l'est pas
# avec les droits de la machine.
USER node

EXPOSE 8787

# Surchargee par docker-compose pour le worker.
CMD ["node", "src/receiver/server.ts"]
