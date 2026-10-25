# SW chuyên sâu · Writing Task 2 · phát hành 25/10/2026

Module này mở rộng nền Shops thành 8 bài SW, tách khỏi runtime/data/queue/writer của Writing 56–67. Google dùng nguồn `shops`; API giữ `/shops-writing-api/`, database `shops_writing`. Nguồn 7 bài cũ chỉ đóng ghi theo activity, giữ dữ liệu để đối chiếu.

Runtime được ghép vào source/dependency của image Shops đã kiểm ngày 24/10, không build từ toàn bộ `main` của repo này. Gói VPS: `/opt/izone-shops-writing/releases/20261025.sw-task2`. Image sau vá URL kết quả: `sw-task2-production-api:20261025.2`, digest `sha256:a53cc196b568186b9a8ce0166bd37644c623f9bdd65ce58f184c5b9fe1d3dfb8`. Khi sửa tiếp phải kiểm runtime hiện hành trước, không coi digest có ngày là bất biến vĩnh viễn.

Các script migration/freeze chỉ chạy trong một đợt chuyển đã được cho phép. Chúng đọc snapshot ERP riêng tư trên VPS, giữ UUID và lịch sử, đối chiếu đủ cột trước khi đổi cấu hình giao diện/phạm vi lớp. `activate-erp-rosters.py` chỉ mở lại định danh có đăng ký ERP chính xác, không ghép hồ sơ theo tên hoặc chấp thuận mapping toàn cục.

Kết quả Draft dùng writer riêng và callback có readback. Tuyến chính thức phải được chấp nhận bởi `service-runtime.js`; tuyến preview phải bị từ chối. Hồi quy ở `test/sw-task2-production-result-url.test.js`. Không dùng thành công của workflow cha/writer để kết luận callback đã hoàn tất.

Giữ backup, trạng thái chuyển và các bản image trước trên VPS. Quay code không restore đè database. Sau khi 7 bài đã nhận ghi ở nền mới, không mở lại nguồn cũ hoặc chuyển về API chỉ hỗ trợ Shops.
