FROM node:24.15.0-alpine3.23
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/ ./src/
COPY db/ ./db/
USER node
ENV HANDOUT67_PORT=3187
EXPOSE 3187
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3187/api/handout67/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
