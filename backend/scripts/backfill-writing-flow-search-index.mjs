import { createDatabasePool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { keyFromHex, open } from '../src/writing-flow-crypto.js';
import { writingSearchTokens } from '../src/writing-flow-search.js';

// Nhận vào: các cặp bài đã mã hóa nhưng chưa có chỉ mục tìm nội dung.
// Việc chính: giải mã trong bộ nhớ, tạo HMAC từng từ, ghi theo lô và không in nội dung học viên.
// Trả ra: chỉ số lượng đã đọc, đã lập chỉ mục và lỗi; lỗi không làm mất dữ liệu nguồn.
const config = loadConfig();
const pool = createDatabasePool(config);
const key = keyFromHex(config.writingFlowEncryptionKey);
if (!key) throw new Error('WRITING_FLOW_ENCRYPTION_NOT_READY');
let indexed = 0;
let failed = 0;
while (true) {
  const result = await pool.query(`SELECT p.pair_id,p.source_ciphertext
    FROM writing_flow.pair AS p
    WHERE p.status<>'superseded' AND NOT EXISTS (
      SELECT 1 FROM writing_flow.pair_search_token AS token WHERE token.pair_id=p.pair_id)
    ORDER BY p.created_at,p.pair_id LIMIT 100`);
  if (!result.rowCount) break;
  for (const row of result.rows) {
    try {
      const decoded = JSON.parse(open(row.source_ciphertext, key));
      const tokens = writingSearchTokens(decoded[0], key);
      if (tokens.length) await pool.query(`INSERT INTO writing_flow.pair_search_token (pair_id,token_hash)
        SELECT $1,token FROM unnest($2::bytea[]) AS token ON CONFLICT DO NOTHING`,
      [row.pair_id, tokens]);
      indexed += 1;
    } catch { failed += 1; }
  }
  if (result.rowCount < 100) break;
}
process.stdout.write(`${JSON.stringify({ ok: failed === 0, indexed, failed })}\n`);
await pool.end();
