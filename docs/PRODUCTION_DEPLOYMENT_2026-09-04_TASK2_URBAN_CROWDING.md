# Phát hành Task 2: đô thị đông đúc và ùn tắc giao thông

Ngày phát hành: 04/09/2026.

## Phạm vi

- Slug: `writing-task2-urban-crowding-traffic-congestion`.
- Phiên bản nội dung: `2026-09-04.1`.
- Manifest SHA-256: `6c8c2ebe60f926429a31875e44eebb46630b70ba695495003e946b62b8671296`.
- Dạng bài: Problems and solutions.
- Hai lớp được mở: `CS.070626` và `CS.160826`.
- Không có ngày hết hạn. Database lưu `DATE 'infinity'` cho activity và cả hai class scope.
- Prompt dùng chung: record `task2-web-template-v1`, phiên bản `2026-08-19.1`.

## Thay đổi đã phát hành

- GitHub Pages: commit `272797aeb5d7b9bebc75bb1f19fcc1b8193adbd3`.
- Backend và migration: commit `e899c4e70f07dbf8e8eda580c4e3c8273f64b4d3`.
- Production database: activity `active`, bốn section, hai class scope `active`.
- Roster readback: `CS.070626` có 32 hồ sơ; `CS.160826` có 14 hồ sơ.
- Không có hồ sơ tạm đang chờ và chưa có session học viên ở thời điểm phát hành.

## Backup và kiểm thử

- Backup trước migration: `/opt/backups/writing-practice/2026-09-04-task2-urban-crowding-no-expiry/writing-practice-production-before-urban-crowding.dump`.
- Kích thước backup: 5.450.776 byte; archive đã được `pg_restore -l` đọc thành công.
- SHA-256 backup: `ecaf45d7cc982750feaf21ffdf376d9f7d82127c360d9c69b324567be39c520a`.
- Frontend: 82/82 test đạt; `npm run check` đạt.
- Backend: 59/59 test đạt; `npm run check` đạt.
- Staging: activity và class scope đều đọc lại là `infinity`; bốn section, một roster giả và không còn session thử.
- Production dry-run: tạo đủ activity, bốn section, hai scope và roster rồi rollback; target trở lại 0 bản ghi trước lần chạy thật.
- Production readback: health/ready, manifest và roster API đều HTTP 200.
- Playwright production: không query hiện hai lớp; query lớp chọn sẵn đúng 32/14 lựa chọn; đề đúng nguyên văn; console không có lỗi hoặc cảnh báo.
- Dashboard giảng viên tải đúng manifest và màn đăng nhập. Không đăng nhập tài khoản thật trong phiên QA sạch.

## n8n

- Workflow `Chấm luyện Writing Task 2 trên web` (`CQnOdCf8XY3DeOWT`) vẫn `active`.
- Cấu hình readback: `saveDataErrorExecution=all`, `saveDataSuccessExecution=all`, `saveManualExecutions=true`.
- Không sửa, refresh hoặc restart n8n trong lần phát hành này.

## Kiểm thử E2E production bằng học viên demo

- Dùng lớp QA riêng `Kiểm thử nội bộ · Đô thị đông đúc` và học viên hoàn toàn giả `Học viên demo E2E`; không dùng dữ liệu học viên thật.
- Phiên demo: `1f5f3699-063c-4abc-835a-9921cbd36e89`.
- Topic Sentence đạt ở lượt 1; Supporting Idea 1 nhận `needs_revision` ở lượt 1 rồi đạt ở lượt 2; Supporting Idea 2 đạt ở lượt 1; Draft đạt ở lượt 1.
- Database ghi đúng 5 lượt chấm `completed`, 5 nhận xét `completed`, 0 lỗi kỹ thuật; cả bốn section đều `locked=true`.
- Bảng từ vựng mở đúng 12 mục. Draft 1 và Draft 2 được lưu trong `response_data` với độ dài lần lượt 966 và 939 ký tự; tải lại trang vẫn khôi phục đủ bốn trạng thái đạt và liên kết LMS.
- Liên kết kết quả LMS đã được kiểm tra đúng miền `practice.izone.edu.vn` và đúng tuyến `/shared/writing-essays/`.
- Execution n8n `1838871` của workflow `CQnOdCf8XY3DeOWT` kết thúc `success` lúc `2026-09-04T12:11:44.066Z`, khớp thời điểm Draft attempt hoàn tất lúc `2026-09-04T12:11:44.003Z`.
- Backup trước E2E: `/opt/backups/writing-practice/2026-09-04-task2-urban-crowding-e2e-demo/writing-practice-production-before-e2e-demo.dump`, 5.487.540 byte, SHA-256 `adce34a897034f49a1d23c1d5079a28b5c7e980cecc0504b2972513a11eef758`; `pg_restore -l` đọc thành công.
- Sau kiểm thử, class scope QA được đổi sang `closed`. Roster, session, 5 attempts và 5 comments demo được giữ làm bằng chứng; danh sách công khai chỉ còn `CS.070626` (32 học viên) và `CS.160826` (14 học viên).

## URL

- Học viên: `https://tranhoangduc90.github.io/izone-ai-team-pages/writing-handouts/lesson.html?task=writing-task2-urban-crowding-traffic-congestion`.
- Lớp `CS.070626`: thêm `&class=CS.070626`.
- Lớp `CS.160826`: thêm `&class=CS.160826`.
- Giảng viên: `https://tranhoangduc90.github.io/izone-ai-team-pages/writing-handouts/teacher.html?task=writing-task2-urban-crowding-traffic-congestion`.

## Giới hạn kiểm thử và rollback

- Không chạy Check AI bằng danh tính học viên thật trên production. Lượt E2E production dùng duy nhất fixture giả, tách biệt và đã đóng khỏi roster công khai sau khi hoàn tất.
- Nếu cần tạm dừng, đổi class scope hoặc activity sang `closed`; không xóa roster, session, comment hoặc bài làm.
- Nếu cần lùi giao diện, revert đúng commit Pages và chờ GitHub Pages build xong rồi đọc lại URL.
