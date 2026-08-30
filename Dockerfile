# syntax=docker/dockerfile:1

# --- build the client --------------------------------------------------------
FROM node:24-slim AS client-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY client client
RUN npm run build -w client

# --- production dependencies (server workspace only) -------------------------
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev -w server

# --- runtime ------------------------------------------------------------------
# python3 + curl_cffi: Chrome-impersonated transport for ChatGPT/Claude checks
# (chatgpt.com 403-challenges Node TLS fingerprints; see server/src/impersonate.js)
FROM node:24-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages curl_cffi \
 && apt-get purge -y python3-pip \
 && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY --from=deps /app/node_modules /app/node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=client-build /app/client/dist /app/client/dist
# bind all interfaces inside the container; publish ports at the host level.
# NODE_ENV is deliberately NOT set: it enables `trust proxy`, which is only
# correct behind a trusted reverse proxy — set it there, not here.
ENV HOST=0.0.0.0
EXPOSE 3000
VOLUME ["/app/server/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.status===200||r.status===401?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
