FROM node:24-alpine
WORKDIR /app
COPY backend/ops/listening-homework67/package*.json ./
RUN npm ci --omit=dev
COPY backend/src/reading-listening67 ./src/reading-listening67
COPY backend/src/listening-homework67 ./src/listening-homework67
COPY backend/scripts/serve-listening-homework67.mjs ./scripts/serve-listening-homework67.mjs
COPY backend/ops/listening-homework67/fixture-service.mjs ./ops/listening-homework67/fixture-service.mjs
USER node
EXPOSE 8963
CMD ["node","scripts/serve-listening-homework67.mjs","/run/listening-homework/config.json"]
