# Quyền lớp ở backend Task 1 riêng

Ngày 01/11/2026, Đức duyệt mở CS.181026 cho sáu bài Task 1 và cấp quyền thường trực cho Phạm Việt Anh, Phùng Duy Quang vào mọi bài của mọi lớp SW chuyên sâu mã CS. Định danh thật và biên nhận production giữ trong kho riêng của người vận hành, không đưa vào fixture.

## Nguyên nhân và thay đổi

Nguồn `task1_bridge.identity_grant` trước đây chỉ trả class ID đã có trong `writing_practice.activity_class_scope` của backend cũ. Sau tách backend, lớp mới chỉ tồn tại trong `sw_task1` nên không thể được cấp quyền bằng nguồn lớp đóng băng đó. Bảng phân công chung còn ràng buộc khóa ngoại tới Classroom; không tạo lớp Classroom giả hoặc mở lại backend cũ để né ràng buộc.

`authority-class-access.sql` tạo bảng cấp quyền riêng `task1_bridge.reviewer_class_access`, ghép các cặp email / ERP class ID được duyệt vào kết quả bridge. Vẫn xác minh đúng email, Google subject, trạng thái active; giữ vai trò và cờ quyền cũ. Consumer vẫn lọc class ID qua scope thật của chính backend Task 1. Thu hồi dòng phân công có hiệu lực ở lần đọc tiếp theo.

## Thực hiện và kiểm

- Chỉ áp SQL vào **mapping_db**, trong transaction; giữ bản `pg_get_functiondef`, quyền sở hữu và trạng thái phân công trước khi đổi. Không chạy file này qua công cụ migrate của sw_task1.
- Chỉ ghi cặp email / class ID đã được phép; không có fallback theo tên hoặc lỗi nguồn quyền. Bảng mới không cấp quyền đọc cho PUBLIC; function owner có SELECT, consumer tiếp tục đi qua SECURITY DEFINER hiện hành.
- Khi có bài hoặc lớp CS mới, cấp quyền cho cả hai giảng viên tại SW Task 2 native và bảng riêng của bridge Task 1, đọc lại theo từng dashboard. Đây là quy tắc thao tác; lượt này không cài bộ đồng bộ quyền nền.
- Việc cấp quyền giảng viên không tự đăng ký/mở bài cho học viên. CS.181026 đã được Đức duyệt riêng đủ sáu scope Task 1 / 24 học viên mỗi bài; không mở thêm các lớp khác vào bài.
- Kiểm hồi quy bằng `node --test test/authority-class-access.test.mjs`: cùng fixture lớp mới bị thiếu trên function production cũ, đạt trên SQL mới; giữ quyền legacy, chặn sai subject/khác giảng viên/tài khoản khóa và có thu hồi.

## Trạng thái production đã đọc lại

- SW Task 2: hai tài khoản có quyền trên 12 lớp CS hiện hành; kiểm đủ 8 bài × 12 lớp × 2 tài khoản.
- SW Task 1: hai tài khoản qua nguồn authority thật, đọc 6 bài × 3 lớp CS đã đăng ký × 2 tài khoản; CS.181026 mỗi bài 24 học viên, canManage=false.
- Sáu scope / 144 dòng roster mới của CS.181026 được thêm idempotent. Scope và roster cũ đối chiếu toàn văn không đổi. Không tạo lượt, nộp/chấm bài hoặc đổi worker/API image.
- Biên nhận riêng: `E:/Codex-Private/sw-cs181026-vietanh-20261101/`. Kiểm trạng thái mới nhất khi tiếp tục; báo riêng native authority, HTTP trình duyệt quản trị và việc chưa quan sát trình duyệt cá nhân của hai giảng viên.

## Quay lại

Khôi phục đúng định nghĩa function đã sao lưu và thu hồi đúng các dòng phân công của lượt này nếu có yêu cầu. Không restore database, xóa bài hoặc xóa scope đã có học viên làm. Bảng phân công mới có thể giữ trống khi quay function; không xóa dữ liệu của tác vụ khác. Không nâng giảng viên lên admin hoặc nới quyền ngoài CS để xử lý lỗi.
