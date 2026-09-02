FROM oven/bun:1-alpine

WORKDIR /app
COPY package.json ./
COPY *.ts ./
COPY public ./public

# Refuse loopback / RFC1918 targets by default: an exposed instance must not
# become a scanner for the network it runs in.
ENV BLOCK_PRIVATE_IPS=1 \
    PORT=3000 \
    DATA_DIR=/app/data \
    NODE_ENV=production

# L'historique des audits vit ici : montez un volume nommé dessus pour qu'il
# survive à la recreation du conteneur.
RUN mkdir -p /app/data && chown bun:bun /app/data
VOLUME /app/data

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["bun", "server.ts"]
