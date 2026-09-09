FROM node:24-trixie

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY index.mjs server.mjs ./

ENV PORT=8080
ENV PKG_DIR=/pkgs
ENV SCAN_INTERVAL_MS=30000

# Read-only by convention -- the container only ever reads .pkg files, and the
# volume mount in docker-compose.yml is :ro to make that the enforced case too.
VOLUME ["/pkgs"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/api/coffeeshop/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
