FROM node:24.15.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY scripts/serve-k67-cta-runtime.mjs ./scripts/serve-k67-cta-runtime.mjs
USER node
ENTRYPOINT ["node", "scripts/serve-k67-cta-runtime.mjs"]
