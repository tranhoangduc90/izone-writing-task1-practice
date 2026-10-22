ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/reading-listening67 ./src/reading-listening67
COPY scripts/serve-reading67-web.mjs ./scripts/serve-reading67-web.mjs
USER node
EXPOSE 8958
CMD ["node","scripts/serve-reading67-web.mjs","/run/reading67/config.json"]
