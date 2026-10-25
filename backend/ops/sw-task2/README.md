# SW Task 2 — bản thử ngày 25/10/2026

Phạm vi được duyệt: nền nhiều bài và toàn tuyến buổi 2 trên môi trường thử. Không mở lớp thật, không đổi đường ghi của Shops hay Writing 56–67.

## Runtime và định danh

- VPS root `/opt/izone-sw-task2-preview-20261025`; API port loopback `18935`.
- HTTPS `/sw-task2-preview-api/`; internal grading endpoints bị chặn ở public Nginx.
- Database `sw_task2_preview_20261025`, role `sw_api`; server dừng nếu database khác. DB không public port.
- Container API/DB/writer và results mount riêng; service `sw-task2-preview-worker.service`, hai việc đồng thời cho cả môi trường thử. Worker sống độc lập máy Windows.
- Hàng chờ 45 phút; Draft lease 1.200 giây; recover 30 giây. Hạn hàng chờ và lease được kiểm riêng.
- Cấu hình tám đề trong `lessons.json`; cả tám cho phép preview trên SW-THU-A/B. Không fallback đề hoặc registry khi khóa không hợp lệ. Chưa mở lớp thật.
- Workflow parent `o1loAzKOWq3OIJbC`, Draft child `xvqBcpFXJRDw33DE`, error `mIpNjaCkiXvuiMio`. Redis registry `ielts:writing:sw-task2-preview:prompt_registry:20261025.1`.
- Dùng chung AI gateway/quota của sản phẩm SW; operation key, DB, callback credentials, writer, result capabilities và workflow riêng. Không gọi Lark để chấm/ghi kết quả.
- Google dùng nguồn phiên SW hiện có qua broker; xác minh identity phía máy chủ rồi kiểm tài khoản/quyền trong DB thử. Không thay cấu hình broker/production. Đây là phần dùng chung danh tính, không phải dùng chung dữ liệu bài với Writing 56–67.

## Dữ liệu và thử nghiệm

Lớp ghi thử `SW-THU-A/B`; mỗi lớp có sáu hồ sơ giả. Bản sao lịch sử Shops/buổi 2 chỉ giảng viên đúng quyền được đọc và mọi mutation bị chặn. Bản nguồn không bị thay đổi. Giữ UUID công khai, ánh xạ tất cả ID nội bộ/FK; đã thử collision ID 14. Đối chiếu trường dữ liệu trước khi áp metadata UI mới, giữ NULL, timestamp, snapshot và feedback.

`preview-contract.sql` chỉ áp vào DB thử, sửa bất tương thích CHECK constraint khi mã ghi `SHOPS_GRADING_TIMEOUT`. Chưa áp bản vá này vào Shops chính thức.

`runtime-regression.test.mjs` và `vocabulary.test.mjs`: 19 ca không gọi AI. Các script `native-*` gọi AI thật trên hồ sơ giả; `protocol-tests.py` dùng callback giả trên API/DB thật. Sáu bài mới đã qua 26 lượt Check/Draft, gồm hai ca sai đề cần sửa, sáu bảng từ và 12 thẻ sửa câu thực tế. Không coi callback giả là kiểm AI thật. Các script vận hành không dành để chạy mù trên môi trường khác; đọc guard/điều kiện có sẵn trước khi dùng.

`migrate-six.py` nối tiếp kho thử, không seed lại dữ liệu đợt trước. Đã thêm 91 phiên/677 Check/62 luồng trao đổi, gồm hồ sơ tạm, alias và audit. Phân biệt khóa UUID với ID số và trường tự tính `purge_after`; so mọi trường bằng SQL theo kiểu trước khi áp metadata UI. `audit-eight-archives.py` đọc đủ 119 phiên lịch sử và xác nhận mọi hàng preview có trước đợt mở rộng vẫn còn nguyên.

`load-24-47.py` dùng HTTPS/API/DB thật và bản riêng của đúng mã lịch xử lý đã triển khai; chỉ đổi assert địa chỉ webhook sang mock cục bộ trong bản test. Nguồn/config worker gốc không sửa, service thử gốc được khởi động lại. Hai ca 24 người một bài và 47 người tám bài hoàn tất 71 việc, tối đa hai việc đồng thời; không mất nháp, không trùng lượt hoặc nhầm kết quả. Phản hồi giả trễ 1,5/2 giây; không suy thời gian này thành tốc độ AI thật. Lớp tải được đóng sau phép kiểm, dữ liệu giữ lại. P95 lưu: 512 ms / 1.027 ms; P95 tạo Check: 544 ms / 802 ms. Đăng nhập tải dùng fixture, không phải benchmark broker Google.

## Source và bàn giao

Đã ghim baseline thực chạy ngày 24/10 trong `source-lock.json`. Phần runtime riêng nằm trong module này; import phần chung đã được kiểm từ image nguồn. Docker build preview dùng Node image ghim và mã nguồn baseline, không kế thừa image ứng dụng đang chạy. `worker.py` và unit là bản đã đọc lại từ VPS. Exact workflow JSON, registry, migration và fixture receipts giữ riêng trong thư mục công việc của Đức, không chứa trong public Pages.

Báo cáo và evidence tại `C:/Users/ADMIN/Documents/Codex/sw-task2-expansion-plan-20261025/`, đợt sáu bài trong `evidence-private/six/`. Backend chỉ commit vào branch riêng; chưa push/merge main. Pages preview phát hành qua PR 275, 278 và 281; thư viện/lớp thật không đổi. Workflow tạm giữ để Đức kiểm, mốc rà 01/11/2026, chưa tự xóa hay tạo lịch dọn.

Chưa phải gói chuyển production: tải API/queue 24/47 người đã kiểm với AI giả; còn chi phí/độ trễ AI thật khi cả lớp chấm, Google broker khi nhiều giảng viên, chuyển nháp thiết bị và đổi thư viện/đường vào cũ theo từng activity. Chỉ chuyển thật sau khi Đức chốt bản thử và phạm vi lớp.
