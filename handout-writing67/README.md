# Handout Writing 67 — backend riêng

Học viên xác nhận lớp/tên, làm Topic Sentence rồi lần lượt B–A–X của từng ý. API lưu bài và quyết định mở bước; n8n chỉ nhận một lượt chấm đã khóa định danh, gọi AI và gửi nhận xét về đúng phiên. Không import server, queue hoặc cấu hình sản phẩm Writing khác.

**Trạng thái:** candidate local. Có kiểm HTTP/SQL, lưu trên đĩa, callback và workflow contract. Chưa nối frontend mẫu, chưa chạy Docker/PostgreSQL server/n8n/AI thật; không dùng cho lớp ở trạng thái này. [Kế hoạch](PLAN.md) và [cổng chất lượng](quality-gate.json) giữ phạm vi và bằng chứng.

## Chạy kiểm local

Trong thư mục này, dùng Node 24 và `npm ci`, sau đó `npm test`. Test tự tạo database PGlite và học viên giả; không gọi roster/AI production. Có thể đặt `HANDOUT67_TEST_ROOT` vào thư mục riêng trên ổ E để lưu fixture đĩa tạm. Khi lỗi, Node in tên ca và assertion; không bật server production.

## Đơn vị phát hành

Build context là chính thư mục này; image chỉ chứa package lock, src và db của Handout 67. Compose chỉ có service `handout67`, mạng và tài nguyên riêng; bind loopback port 3187. Các bài học sau thuộc cùng backend của sản phẩm, không cần container mỗi bài.

Các biến bắt buộc: `HANDOUT67_DATABASE_URL`, `HANDOUT67_ALLOWED_ORIGINS`, `HANDOUT67_SESSION_SECRET`, `HANDOUT67_INTERNAL_SECRET`, `HANDOUT67_ROSTER_URL`, `HANDOUT67_ALLOWED_CLASSES`, `HANDOUT67_PROMPT_FILE`, `HANDOUT67_N8N_WAKE_URL`, `HANDOUT67_N8N_WAKE_SECRET`. Compose còn nhận `HANDOUT67_IMAGE` và `HANDOUT67_PROMPT_SOURCE`. Chỉ dùng tên biến ở tài liệu; giá trị thật giữ trong cấu hình riêng tư.

Rubric JSON đặt ngoài repo/image vì repo nguồn công khai. File có version `lesson5-rubric-v2` và `rubrics` gồm `topic`, `b1`, `b2`, `a`, `x`, `vocab`; cần chuyển đầy đủ rubric Lesson 5 đã duyệt, không dùng chữ placeholder hoặc prompt test. Backend tự gắn đúng ý và lịch sử của bước đang chấm. Nội dung chuyên môn vẫn cần giáo viên kiểm AI thật.

## Các cổng trước mở lớp

1. Chốt roster chỉ đọc đúng lớp, rubric riêng tư, người vận hành và quota AI/n8n thật.
2. Dựng database/role và container riêng sau khi được phép thay VPS; kiểm quyền dữ liệu bằng PostgreSQL thật, build/start/rollback và routing.
3. Bind workflow candidate riêng, test execution/callback/readback qua gateway thật; giữ các workflow Docs hiện hành nguyên vẹn.
4. Nối Pages với API, kiểm hành trình trên trình duyệt và canary lớp; đọc lại metadata runtime/cấu hình các sản phẩm cũ trước/sau.

Chi tiết trong [runbook](RUNBOOK.md). Không có automatic migration, tự bật workflow, tự xóa lịch sử hoặc tự chuyển bài Docs.
