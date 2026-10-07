# Thư viện Writing đã ghim; deployment kiểm image ID trước mỗi lần build.
FROM writing-recovery-upgrades:20261004
COPY --chown=node:node src/reading-listening67/ /app/src/reading-listening67/
COPY --chown=node:node scripts/serve-reading-listening67.mjs /app/scripts/serve-reading-listening67.mjs
USER node
CMD ["node", "scripts/serve-reading-listening67.mjs"]
