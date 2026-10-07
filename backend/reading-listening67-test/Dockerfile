# Nhận image Writing đã có dependencies; chỉ thêm module và lệnh mở API thử.
# Không thay app/server Writing hoặc cài thêm gói. Kiểm image ID trước khi build.
FROM writing-recovery-upgrades:20261004
WORKDIR /app
COPY src/reading-listening67/ ./src/reading-listening67/
COPY scripts/serve-reading-listening67.mjs ./scripts/serve-reading-listening67.mjs
CMD ["node", "scripts/serve-reading-listening67.mjs"]
