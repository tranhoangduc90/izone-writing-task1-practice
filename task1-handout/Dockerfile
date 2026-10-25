FROM node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY vendor ./vendor
COPY vendor-lock.json ./
COPY tools ./tools
COPY db ./db
RUN find src vendor tools db -type d -exec chmod 755 {} + \
 && find src vendor tools db -type f -exec chmod 644 {} +
USER node
CMD ["node","src/server.mjs"]
