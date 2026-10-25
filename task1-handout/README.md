# Handout Task 1 Speaking Writing chuyên sâu — backend riêng

Bản local/candidate ngày 25/10/2026. Chưa merge, chưa push, chưa dựng container/VPS, chưa chuyển dữ liệu hoặc URL học viên thật.

## Phần đã xây

Sáu đề Task 1 dùng chung một sản phẩm `sw-task1`: API, PostgreSQL, worker, hàng chờ và bản phát hành riêng. Không gọi hàng chấm Shops/Task 2 hoặc Writing 56–67. Dùng lại sáu module thuần đã ghim ở `vendor-lock.json`; build context chỉ là thư mục này. Không import server hay cấu hình từ runtime khác.

Giữ năm ô Overview, Body 1, Body 2, Draft 1, Draft 2 và ba chặng Overview → Outline → Draft. Draft luyện Overview và Body 1. Bài đã đạt bị khóa; quản trị có thể mở lại có lý do. Lưu nháp chống ghi đè, Check chống trùng, học viên tạm dùng PIN, trao đổi giảng viên có neo và lịch sử được giữ qua lõi đã ghim.

Draft nhận phản hồi tiếng Việt và quyết định học thuật `passed/needs_revision`. Không cần link LMS, không có trường câu viết thay, không gọi Lark/Docs hoặc writer bài chữa. Lỗi AI không tăng chuỗi cần sửa; retry là lượt mới, kết quả quá lease bị từ chối. Callback cùng nội dung đã lưu có biên nhận chống ghi trùng.

Mỗi lượt chấm đóng băng template, phiên bản/hash, đề, năm ô và lịch sử ngay khi xếp hàng. Hàng chờ tối đa hai lease cho cả sản phẩm, kể cả có nhiều tiến trình worker. Một lượt AI tối đa 150 giây, lease 420 giây cho chuẩn bị và 1.200 giây cho Draft; mỗi lượt claim tối đa hai việc, tối đa ba lần claim. Worker ghi trạng thái và mã lượt, không ghi bài học viên ra stdout.

## Nguồn tham chiếu và thay đổi có chủ đích

Kiến trúc học theo [chat làm Shops](codex://threads/01a16bb5-4fad-76c2-88ee-0d2988cb9a12): tách runtime, dữ liệu, queue, cấu hình, phát hành và quay lui; dùng chung hạ tầng và danh tính qua hợp đồng. Task 1 dùng phản hồi Socratic trong trang, nên không sao chép chuỗi tạo câu sửa của Shops. Nguồn lõi ghim `5e09afa6b3467cf88d4a9c9e5a7e72ecea4a6fb8`; bản sao service đổi hợp đồng Draft, biên nhận kết quả/lease, giới hạn toàn cục hai việc và tính timeout theo lease đang xử lý thay vì thời gian đợi hàng. Mã chung ngoài thư mục này không đổi.

## Kiểm local

Node 24, `npm ci`, `npm run check`, `node --test test/product.test.mjs`. SQL thật chạy trên PostgreSQL/PGlite; HTTP được gọi qua Supertest. Fixture trong Git chỉ có học viên/giảng viên giả. Gói prompt và ca bài cũ lưu riêng, không đi vào image hoặc repository.

Các ca gồm: Draft Socratic RED ở lõi cũ và GREEN ở bản riêng, lưu/Check trùng, xung đột nháp, PIN, phiên/quyền lớp giảng viên, comment hai chiều, hai worker, lease hết hạn, callback sai hoặc lặp, lỗi từng phần và hoàn tất đảo thứ tự. Kiểm role SQL bị từ chối khi sửa prompt/quyền, đọc schema khác hoặc xóa bài.

## Cấu hình và phạm vi còn phải kiểm trước mở lớp

Xem [RUNBOOK](RUNBOOK.md). Chuẩn giảng viên dùng `createSharedTeacherVerifier` đã ghim, nguồn mới `task1`; broker xác minh phiên chung 90/365 ngày và API kiểm lại grant/subject/lớp ở mỗi lần gọi. Chưa đăng ký nguồn này trên broker thật; chưa có bằng chứng Google thật cho Task 1 riêng.

Compose khai báo database riêng `sw_task1`, role runtime `task1_api`, cổng API đề xuất `127.0.0.1:18928`, mỗi API/worker tối đa 4 kết nối DB, CPU 0,5 và RAM 256 MiB; DB 384 MiB. Đây là trần cấu hình đề xuất, chưa phải bằng chứng tải lớp đông hoặc cách ly VPS. Docker chưa khả dụng trên máy kiểm, nên chưa xác minh image/Compose hoạt động. Image PostgreSQL bắt buộc ghim digest trước khi dựng; không có mặc định trỏ sang hệ đang chạy.

Chưa chuyển frontend, thư viện, quyền/lớp hay 91 phiên/571 lượt lịch sử. Các phần này phải dùng bản xuất đầy đủ, giữ UUID, bài, comment, PIN và trạng thái cũ; bản audit không đủ thay backup chuyển dữ liệu. Không tự đưa cả Task 2 vào DB Task 1 hoặc coi Draft cũ có link là đã đạt học thuật theo rubric mới.

Giới hạn của AI: prompt giảm bắt oan và việc viết hộ trên bộ hồi quy đã chọn, không bảo đảm mọi lần sinh. Bộ chặn nhận câu trả lời thiếu/đứt, yêu cầu viết thay và vượt độ dài là lỗi kỹ thuật. Nếu phản hồi có hai khối và quá dài, chỉ giữ nguyên khối đầu còn đầy đủ; khi thiếu bước sửa thì thêm chỉ dẫn chung “Em tự sửa phần vừa được hỏi và giữ các phần đúng”. Không viết lại câu bài làm. Báo cáo so sánh giữ cả phản hồi gốc và phản hồi sau lớp giới hạn này.
