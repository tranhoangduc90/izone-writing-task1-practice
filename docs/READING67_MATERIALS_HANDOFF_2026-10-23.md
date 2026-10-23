# Reading Materials — nguồn tiếp tục ngày 23/10/2026

Bài **Materials to take us beyond concrete**, Matching Information câu 1–4 và nén cấp 1 theo tám đoạn. Mã CTA có nghĩa: `67-reading-materials-beyond-concrete-matching-information-nen-cap-1`. Giao diện đã ở Pages, nháp/bản gửi/feedback/lịch sử ở API và database riêng. Lần lưu nguồn này không mở lớp, giao Classroom hoặc chấm bài học viên.

## Phần đã xây qua các chặng

- Bộ chấm web chạy các khối kiểm/gate/deterministic/oracle/prompt/audit/merge của snapshot Read 67 đã ghim hash. Giữ 20 target, ngưỡng tối thiểu 16/20; không thay bộ chuyên môn bằng chấm theo trình bày giao diện.
- Nháp có chủ/lớp/mã/version, lưu theo số phiên bản; retry giữ mutation/request ID, bản gửi bất biến. Sửa bài trong lúc chấm không đổi phản hồi lượt cũ. HTTP nhận chấm trả 202, UI đọc trạng thái và hiện phản hồi đúng bản gửi; lịch sử/sửa/chấm lại giữ liên kết lượt.
- Nhận diện lấy nguồn owner V1, kiểm UUID/ERP/lớp/mapping còn hợp lệ; giáo viên chỉ đọc nháp/bản nộp đúng quyền. Link thẳng giữ học viên/bài và nay dùng [phiên GV chung](https://github.com/tranhoangduc90/izone-ai-team-pages/blob/main/docs/TEACHER_SHARED_LOGIN.md).
- Homework nhận CTA, trạng thái và link đúng bản nộp, không sao chép toàn bài/phản hồi hoặc nộp Classroom. Kiểm chủ `STUDENT_COPY`, course/work/submission/attachment/mã/tab trước đăng ký và mỗi lần ghi; hàng Docs tách riêng, CAS/readback, không ghi đè dòng người sửa tay. Chưa có Homework thì chờ và nối sau.

## Nguồn và trạng thái

Source ở `backend/src/reading-listening67/web-*.js`, `authority/`, hai entrypoint `serve-reading67-web*.mjs`, ba migration ngày 22/10 và bảy nhóm `backend/test/reading67-web*.test.js`. Bốn commit gốc `f49b549`, `5fe17fb`, `fcddf2c`, `1197b9a` đã được ghép lên nền có SSO mới bằng các commit tương ứng trong gói lưu này; không ghép lại hai commit SSO lịch sử làm lùi broker.

Runtime Materials quan sát ngày 23/10: `izone-reading67-materials-ic2304`, image `sha256:f0d74a8602e86e52cbbfb8effa27a0d397018c2bb9c3c9a77ec446dd23f54875`. Grader snapshot SHA-256 `15b39bf30f5eb9a3c8f0b67cabeb65d72562fcc11cb25cb814c54a51bc0015ef`, đối chiếu đúng cấu hình. Snapshot chứa nội dung/credential riêng, không nằm trong Git. Preview cũ có image riêng; không lấy preview làm runtime lớp thật.

Các tài liệu [chặng 2](READING67_WEB_PREVIEW_2026-10-22.md) và [Homework thử](READING67_HOMEWORK_TRIAL.md) là hồ sơ lịch sử, giữ giới hạn ở thời điểm đó. Trạng thái mở bài/CTA thật được quản lý riêng theo lớp/buổi; không dùng câu “chưa mở” trong tài liệu thử để đóng lại bài hoặc suy việc nhập main đã giao Homework. Đợt đăng nhập/lưu nguồn này không thay cờ mở lớp hoặc đăng ký Classroom.

## Kiểm và cách sửa tiếp

- Bảy nhóm Reading chạy trên nguồn đã ghép: **43/43, không skip**, dùng PostgreSQL nhúng và snapshot bộ chấm thật đã ghim; AI/Google/Classroom là fixture trong nhóm tự động. Không gọi AI, tạo attempt hoặc ghi Docs/Portal production để chạy suite.
- Trình duyệt URL thật mở trực tiếp bài một học viên IC2304 ở chế độ GV, đúng tên và chỉ đọc, không đăng nhập Google lần hai sau K56. Đây là bằng chứng quyền/xem bài, không phải một lượt nộp/chấm mới.
- Bộ kiểm phủ CAS/mất ACK/hai người/callback đảo thứ tự/cache sau reset, thu hồi/hết hạn/sai subject, owner V1, CTA/Docs sai đích và bảo vệ chỉnh tay. Không suy số ca thành full suite mọi sản phẩm hoặc kiểm tải VPS/AI thật mới.
- Source main có thể khác image đang chạy do sửa lớp/CTA ở task khác. Trước sửa tiếp, đọc lại live module/config/private snapshot và đối chiếu gói này. Chỉ lưu Git không tự deploy, chạy migration, mở lớp hoặc nạp lại cấu hình lịch sử.
- Quay image/config, giữ database bài/nháp/lịch sử và job Docs; không restore dữ liệu cũ đè bài mới. Quay code không tự gỡ CTA đã ghi vào Homework.
