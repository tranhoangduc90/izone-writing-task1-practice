import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const base = {
  NODE_ENV: 'test', DATABASE_URL: 'postgres://fixture.invalid/test',
  ALLOWED_ORIGINS: 'https://fixture.invalid', GOOGLE_CLIENT_ID: 'fixture-client',
  INTERNAL_API_TOKEN: 'i'.repeat(32),
  PROVISIONAL_STUDENT_PIN_PEPPER: 'p'.repeat(32),
};

// Dữ liệu vào: ba khóa giả; không dùng credential hay endpoint thật.
// Việc chính: bảo đảm quyền mở/nộp và quyền lấy việc chấm không dùng chung khóa.
// Kết quả: thiếu khóa giữ chức năng mới đóng; cấu hình trùng khóa bị từ chối.
// Khi lỗi: server không khởi động với quyền vượt phạm vi.
test('khóa gateway và grader Substitute phải độc lập', () => {
  const unconfigured = loadConfig(base);
  assert.equal(unconfigured.webSubstituteApiToken, null);
  assert.equal(unconfigured.webSubstituteGraderToken, null);
  assert.equal(unconfigured.webSubstitutePortalToken, null);
  assert.equal(unconfigured.webSubstituteEnabled, false);
  assert.equal(unconfigured.webSubstitutePortalEnabled, false);
  const configured = loadConfig({ ...base,
    WEB_SUBSTITUTE_API_TOKEN: 'w'.repeat(32),
    WEB_SUBSTITUTE_GRADER_TOKEN: 'g'.repeat(32) });
  assert.equal(configured.webSubstituteApiToken, 'w'.repeat(32));
  assert.equal(configured.webSubstituteGraderToken, 'g'.repeat(32));
  assert.throws(() => loadConfig({ ...base,
    WEB_SUBSTITUTE_ENABLED: 'true' }),
  /Mở Substitute cần hai khóa riêng và khóa mã hóa Writing/u);
  const enabled = loadConfig({ ...base,
    WEB_SUBSTITUTE_API_TOKEN: 'w'.repeat(32),
    WEB_SUBSTITUTE_GRADER_TOKEN: 'g'.repeat(32),
    WRITING_FLOW_ENCRYPTION_KEY: 'a'.repeat(64),
    WEB_SUBSTITUTE_ENABLED: 'true' });
  assert.equal(enabled.webSubstituteEnabled, true);
  assert.throws(() => loadConfig({ ...base,
    WEB_SUBSTITUTE_API_TOKEN: base.INTERNAL_API_TOKEN }),
  /Khóa gateway, bộ chấm và API nội bộ phải khác nhau/u);
  assert.throws(() => loadConfig({ ...base,
    WEB_SUBSTITUTE_API_TOKEN: 'w'.repeat(32),
    WEB_SUBSTITUTE_GRADER_TOKEN: 'w'.repeat(32) }),
  /Khóa gateway, bộ chấm và API nội bộ phải khác nhau/u);
  assert.throws(() => loadConfig({ ...base,
    WEB_SUBSTITUTE_PORTAL_ENABLED: 'true' }),
  /Mở đồng bộ Portal cần bật Substitute/u);
  assert.throws(() => loadConfig({ ...base,
    WEB_SUBSTITUTE_PORTAL_TOKEN: 'w'.repeat(32),
    WEB_SUBSTITUTE_API_TOKEN: 'w'.repeat(32) }),
  /khóa Portal cũng phải khác/u);
  const portal = loadConfig({ ...base,
    WEB_SUBSTITUTE_API_TOKEN: 'w'.repeat(32),
    WEB_SUBSTITUTE_GRADER_TOKEN: 'g'.repeat(32),
    WEB_SUBSTITUTE_PORTAL_TOKEN: 't'.repeat(32),
    WRITING_FLOW_ENCRYPTION_KEY: 'a'.repeat(64),
    WEB_SUBSTITUTE_ENABLED: 'true', WEB_SUBSTITUTE_PORTAL_ENABLED: 'true' });
  assert.equal(portal.webSubstitutePortalEnabled, true);
});
