import { loadConfig } from '../src/config.js';
import { createDatabasePool } from '../src/db.js';
import { createWritingFlowService } from '../src/writing-flow-service.js';
import { keyFromHex, open } from '../src/writing-flow-crypto.js';
import { normalizeWritingSearch } from '../src/writing-flow-search.js';

// Nhận vào: database của đúng môi trường và khóa Writing từ biến môi trường.
// Việc chính: đọc tối đa 50 dòng như dashboard, kiểm các field và thử tìm một từ nội bộ.
// Trả ra: chỉ số đếm, không in tên, đề, bài viết, URL riêng hoặc credential.
const config = loadConfig();
const pool = createDatabasePool(config);
const service = createWritingFlowService({ pool, encryptionKey: config.writingFlowEncryptionKey });
const rows = await service.listPairs({ limit: 50, includeCompleted: true });
const summary = {
  rows: rows.length,
  homeworkTitles: rows.filter(row => row.display_name).length,
  classroomUrls: rows.filter(row => row.classroom_url).length,
  topics: rows.filter(row => row.topic).length,
  trccValues: rows.filter(row => typeof row.tr_cc_check === 'boolean').length,
  essayPreviews: rows.filter(row => row.essay_preview).length,
  lmsUrls: rows.filter(row => row.lms_url).length,
  decryptIssues: rows.filter(row => row.data_issue_code).length,
  contentSearchReadback: null,
};
const source = await pool.query(`SELECT pair_id,source_ciphertext FROM writing_flow.pair
  WHERE status<>'superseded' ORDER BY updated_at DESC LIMIT 1`);
if (source.rowCount) {
  const key = keyFromHex(config.writingFlowEncryptionKey);
  const decoded = JSON.parse(open(source.rows[0].source_ciphertext, key));
  const word = normalizeWritingSearch(decoded[0]).split(' ').find(item => item.length >= 2);
  if (word) {
    const found = await service.listPairs({ search: word, searchScope: 'content',
      includeCompleted: true, limit: 50 });
    summary.contentSearchReadback = found.some(row => row.pair_id === source.rows[0].pair_id);
  }
}
process.stdout.write(`${JSON.stringify({ ok: summary.rows > 0 && summary.decryptIssues === 0
  && summary.contentSearchReadback !== false, summary })}\n`);
await pool.end();
