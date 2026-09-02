FROM oven/bun:1-alpine

WORKDIR /app
COPY package.json ./
COPY *.ts ./
COPY public ./public

# Refuse loopback / RFC1918 targets by default: an exposed instance must not
# become a scanner for the network it runs in.
ENV BLOCK_PRIVATE_IPS=1 \
    PORT=3000 \
    NODE_ENV=production

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["bun", "server.ts"]
