# Thêm học viên SW theo lớp · Issue #563

Hai dashboard Task 1 và Task 2 xác minh GV bằng phiên và quyền lớp hiện hành. API chỉ nhận thao tác trên phạm vi đang mở của mã lớp `CS.`. Lưu một hồ sơ và UUID ở cấp lớp, sau đó ghi UUID đó vào roster của các bài. Ghi và đọc lại bài đang dùng trước khi báo sẵn sàng. Một kho đích nền có lỗi thì bộ đồng bộ của kho đó thử lại theo trạng thái trong `sw_roster.delivery`.

Từ 15/11, học viên tải lại trang handout đang có và chọn lớp, tên để vào bài. Dashboard cung cấp link lớp dùng lại được. Màn học viên bỏ mã mời cũ trong fragment. API kiểm bài, lớp và trạng thái roster hiện hành cùng `member.active` ở registry. Học viên có thể mở bài tương lai khi còn quyền học dù `erp_contact_id` còn trống. Cơ chế PIN của hồ sơ tự đăng ký cũ vẫn dùng các route cũ.

## Chuẩn bị backend và bật Pages

1. Xác định hai container production, ghim image ID và băm các tệp thay đổi. Giữ image, bản inspect riêng tư và đường quay lại. Ghép thay đổi SW roster trên source trích từ **hai image đang chạy**, đối chiếu diff từng tệp. Tại mốc 11/11, Task 2 có route tổng hợp tiến độ `admin/sw/lesson9/overview` trong live overlay. Task 1 giữ lớp xác thực, xử lý lưu và lịch sử của image hiện hành.
2. Áp dụng `sw-roster-registry.sql` trong database `sw_roster` của một PostgreSQL độc lập với hai kho bài. Cả hai API dùng một mạng Docker nội bộ để kết nối với registry. Một database đích dừng vẫn cho phép API còn lại ghi bài hiện hành. Lưu registry trong volume bền vững và sao lưu riêng bằng `pg_dump -Fc -d sw_roster`. Áp dụng `task1-handout/db/005-sw-roster-projection.sql` trong **cả hai** kho bài. Cấp `USAGE` schema cùng `SELECT, INSERT, UPDATE` trên các bảng `member`, `invitation`, `delivery` cho vai trò registry. Vai trò ứng dụng cũ chỉ thêm quyền `SELECT, INSERT` trên bảng projection của kho mình.
3. Cùng cấu hình `SW_ROSTER_REGISTRY_URL` trên hai API. Giữ cấu hình trong kho riêng tư trên máy chủ. `SW_ROSTER_ALLOW_ADDS=0` tắt thao tác tạo mới, giữ truy cập và thử lại đồng bộ cho học viên đã thêm. Bảng invitation giữ dữ liệu trước 15/11. Với image Task 2 có `WORKDIR /app` và entry `/app/ops/sw-task2-production/server.mjs`, đặt module roster dưới `/task1-handout/vendor`. Task 1 đặt chúng dưới `/app/vendor`.
4. Khởi động candidate riêng, xác nhận quyền SQL tối thiểu và kết nối hai kho. Đối chiếu danh sách, phiên và URL cũ bằng đọc lại. Chuyển từng API, giữ network, mount đọc riêng, hạn mức, cổng, worker, writer và cơ chế phiên chung. Bật thêm trên cả hai API rồi phát hành Pages. Phần xác minh production chỉ đọc các lớp thật và dùng phép kiểm hợp lệ không tạo học viên.
5. Nếu cần dừng thêm, chuyển `SW_ROSTER_ALLOW_ADDS=0` và giữ module kiểm quyền lớp. Quay về cả cặp bản 11/11 sẽ áp lại yêu cầu link dùng một lần. Giữ nguyên DB và bài đã làm.

## Xử lý sau buổi học

- Tra theo ID lớp ERP và UUID. Bảng `member` giữ người thao tác, mã yêu cầu, trạng thái quyền học và contact ERP nếu có. Nhật ký `sw_roster_save` nối mã yêu cầu tới đích đang dùng. `sw_roster_delivery` và bảng `delivery` giữ danh sách bài đã đọc lại hoặc còn lỗi.
- Sau khi học vụ xác nhận contact thuộc đúng lớp, rà UUID hiện có ở cả Task 1 và Task 2 bằng nguồn đã xác minh. Nếu contact chưa sở hữu UUID khác, người vận hành gắn contact vào chính dòng `member` đó. Khi đã có UUID khác, lưu căn cứ đối soát để xử lý thủ công. Giữ cả hai UUID và bài đã làm trong lúc chờ quyết định.
- Thu hồi quyền bằng cách đặt `member.active=false` trên đúng cặp lớp và UUID. Lần mở hoặc đọc tiếp theo sẽ bị từ chối. `sw_roster_open_access` ghi product, lớp, UUID và quyết định cho phép khi mở. Mỗi kho tắt các dòng roster đã chiếu qua lượt đồng bộ. Dữ liệu học và lịch sử vẫn còn.

## Ca kiểm cách ly

Chạy từ repo backend với dependency của cả `backend` và `task1-handout`, cùng checkout Pages đã chỉ định qua `SW_ROSTER_PAGES_ROOT`.

```text
node --test task1-handout/integration/sw-roster-native.mjs task1-handout/integration/sw-roster-browser.mjs
```

Runner trình duyệt dùng dữ liệu giả, hai kho bài và registry PGlite độc lập, với logic mở phiên native. Tùy chọn `SW_ROSTER_FIXTURE_TLS` trỏ tới thư mục có chứng thư cách ly `key.pem` và `cert.pem`. Runner kiểm mở bài qua hai origin HTTPS khác site, từ trình duyệt mới và sau khi tải lại link cũ, cùng quyền lớp qua tài khoản fixture.
