# Vận hành backend Task 1 riêng

Chỉ chạy với quyền cho môi trường đích. Sáu bài Task 1 lớp Speaking Writing chuyên sâu đã chuyển sang backend riêng ngày 25/10/2026 theo yêu cầu Đức, giữ nguyên link. Xem [biên nhận production](PRODUCTION-20261025.md) trước mọi thao tác; phần dưới mô tả quy trình dựng mới và chuyển đổi đã thực hiện, không phải lệnh cần chạy lại. Bản [preview](PREVIEW-20261025.md) vẫn là môi trường riêng.

## Ranh giới và cách chạy

1. Xác minh VPS/port chưa dùng, ghi metadata các runtime Writing/Task 2 trước thử. Chọn thư mục riêng, đề xuất `/opt/izone-sw-task1`; không mount source/env/DB của Shops hay Writing 56–67.
2. Sao chép `.env.example` thành `.env` chỉ dành cho Compose; điền digest PostgreSQL 16 đã xác minh và mật khẩu owner mới. `private/runtime.env` chỉ chứa thông số runtime theo `runtime.env.example`; không chứa mật khẩu owner. Tạo khóa consumer Task 1 riêng; không dùng lại khóa Shops. Volume database mới và network mới.
3. Dựng DB, tạo schema bằng `node tools/migrate.mjs` với `TASK1_OWNER_DATABASE_URL` trỏ đúng database `sw_task1`/role `task1_owner`, và `TASK1_API_PASSWORD_FILE` chứa mật khẩu runtime riêng. Công cụ từ chối database/owner khác, không đặt lại mật khẩu role đã có, không in credential. Chỉ owner có quyền quản lý prompt và quyền giảng viên.
4. Nạp gói prompt riêng bằng `node tools/seed-prompts.mjs`, dùng cùng owner URL và `TASK1_PROMPT_PACKAGE_DIR`. Đủ 18 prompt, đúng SHA và phiên bản bất biến mới được nạp. Không đưa gói prompt lên Pages/Git public. Seed fixture giả và cấp quyền giảng viên thử đúng lớp trước khi mở API.
5. API chạy `node src/server.mjs`, worker chạy `node src/worker.mjs`. Cả hai chỉ đọc cấu hình `TASK1_*`; API không có route nội bộ nhận job/callback công khai. Worker chấm qua Cổng AI dùng chung, giữ queue và biên nhận riêng trong DB của sản phẩm.
6. Đăng ký nguồn `task1` trên broker hiện hành, nối consumer bằng hợp đồng identity v1. Không dựng broker mới hoặc khôi phục DB phiên chung. Kiểm Google thật từ thư viện sang Task 1, tải lại/tab mới/đăng xuất và thu hồi quyền. Địa chỉ broker trong mẫu env chỉ là ví dụ, phải xác minh network/address thật.

## Chuyển dữ liệu sau khi bản thử được duyệt

- Xuất nhất quán riêng sáu activity Task 1, class scope/roster/override, provisional/PIN/alias/audit, sessions, section states, draft request, attempt, AI comment, teacher thread/message/status và admin audit. Giữ mọi UUID/thời gian/phiên bản/nội dung gốc; các trường bổ sung của schema nguồn cũng phải được đối chiếu. Snapshot audit 24/10 thiếu một số bảng nên chưa dùng để import.
- Import bằng owner vào DB mới khi luồng nhận bài thật vẫn chưa bật. Trigger đóng băng context chỉ áp dụng cho lượt mới; lượt lịch sử giữ metadata gốc và nhãn legacy, không tự chấm lại. Không suy phiên bản prompt lịch sử từ prompt đang có.
- So số lượng và digest theo ID của toàn bộ bảng liên quan trước/sau. Kiểm nháp, toàn bộ lịch sử, PIN cũ và nhận xét hai chiều bằng bản sao; không mở/nộp/chấm thay học viên thật để thử.
- Khi chốt chuyển, đóng ghi đúng activity ở nguồn cũ, lấy delta, đối chiếu lại rồi mới chuyển route/manifest/thư viện của Task 1. Không đóng hàng chờ hay scope của Task 2/56–67. Chưa chuyển frontend thì không quảng bá API candidate là handout đã phát hành.

## Vận hành, lỗi và quay lui

API `health/ready` nhận diện `sw-task1`. Worker phát heartbeat mỗi vòng, mỗi lần AI tối đa 150 giây, hai job toàn cục. HTTP lỗi, đầu ra bị cắt, sai format, viết hộ hoặc quá dài không xử lý được đều là lỗi kỹ thuật; học viên có retry trong giới hạn, chuỗi học thuật không tăng. Sau restart, lease hết hạn được phục hồi; callback cũ không được gắn sang một attempt khác.

Quota CPU/RAM/kết nối chỉ giới hạn từng container; VPS, Docker host và Cổng AI vẫn là điểm chung. Trước mở cả lớp cần đo hai job thật và tải lưu/đọc tương đương lớp, theo dõi tuổi queue, job hết lease, lỗi AI, pool DB và số lần giữ khối đầu vì quá dài. Chưa có phép đo tải hoặc chi phí theo lớp.

Quay image/code Task 1 riêng, giữ DB và các bài mới. Không restore đè dữ liệu hoặc mở đồng thời hai backend nhận ghi cho cùng bài. Sau cutover có bài mới, muốn quay route về hệ cũ phải có kế hoạch đồng bộ ngược và đối soát riêng. Không sửa image/env/workflow của Shops/Task 2 hoặc Writing 56–67 để quay Task 1.
