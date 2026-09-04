# Phát hành Task 2: ngân sách phòng bệnh và chữa bệnh

Ngày phát hành: 04/09/2026.

## Phạm vi

- Slug: `writing-task2-public-health-spending`.
- Phiên bản nội dung: `2026-09-04.1`.
- Manifest SHA-256: `578478d5fd4797e4ba6a1d260b209d578a60758a05877407cbecee0e520fb45b`.
- Dạng bài: Agree or disagree.
- Hai lớp được mở: `CS.070626` và `CS.160826`.
- Ngày kết thúc activity và class scope: 31/12/2026.
- Prompt dùng chung: record `task2-web-template-v1`, phiên bản `2026-08-19.1`.

## Thay đổi đã phát hành

- GitHub Pages: commit `8bd63a676f2cb9eb42fd244e4b34367d1824790a`.
- Backend và migration: commit `aca7bc6a458bbf85f75932aaae39141ee6bec94c`.
- Database: activity `active`, bốn section và đúng hai class scope thật `active`.
- Roster readback: `CS.070626` có 32 hồ sơ; `CS.160826` có 14 hồ sơ.
- Không có hồ sơ tạm đang chờ.

## Backup và kiểm thử

- Backup staging trước seed: `/opt/backups/writing-practice/2026-09-04-task2-public-health-staging/writing-practice-staging-before-public-health.dump`, 123.651 byte, SHA-256 `17e7bf9ddadb25738ecd15b4ae5b56e5c08d008df57b76f0c0558fbc64fabb47`; archive đọc thành công.
- Seed staging tạo đúng activity `draft` và bốn section. Migration mở lớp từ chối an toàn vì staging không chứa hai source scope thật; transaction tự rollback.
- Production dry-run của migration mở lớp tạo đủ hai scope và roster rồi rollback thành công trước lần chạy thật.
- Backup trước migration: `/opt/backups/writing-practice/2026-09-04-task2-public-health-spending/writing-practice-production-before-public-health.dump`, 5.505.107 byte, SHA-256 `09d670488aa1a775a6268e3a4535fb9ea45e0d5e80d65c6ad70994c2806e648e`; archive đọc thành công.
- Frontend: 82/82 test đạt; `npm run check` đạt.
- Backend: 59/59 test đạt; `npm run check` đạt.
- Production readback: `/health`, `/ready`, manifest và roster API đều đạt; đề và checksum khớp.
- Playwright production: không query hiện đúng hai lớp; query lớp chọn sẵn đúng 32/14 lựa chọn; mobile 390 px không tràn ngang; dashboard tải màn đăng nhập; console có 0 lỗi và 0 cảnh báo.

## n8n

- Workflow `Chấm luyện Writing Task 2 trên web` (`CQnOdCf8XY3DeOWT`) vẫn `active`.
- Cấu hình readback: `saveDataErrorExecution=all`, `saveDataSuccessExecution=all`, `saveManualExecutions=true`.
- Không sửa, refresh hoặc restart n8n.

## E2E bằng học viên demo

- Backup trước E2E: `/opt/backups/writing-practice/2026-09-04-task2-public-health-e2e-demo/writing-practice-production-before-e2e-demo.dump`, 5.505.737 byte, SHA-256 `f82cf85afa31e269f10acc0d35935df78b2f5a09b9d790ba48c0c0c97867a5ce`; archive đọc thành công.
- Dùng lớp QA và học viên hoàn toàn giả; không dùng dữ liệu học viên thật.
- Phiên demo: `c90204ce-d681-4b2e-95a0-07eefcf3e41b`.
- Có 7 lượt Check hoàn tất: 3 `needs_revision`, 4 `passed`, 0 lỗi kỹ thuật; bấm đôi Topic Sentence trả cùng lượt.
- Cả bốn section đều `locked=true`; bảng từ vựng có 14 mục.
- Draft 1 và Draft 2 được lưu với độ dài 748 và 749 ký tự; liên kết LMS đúng miền `practice.izone.edu.vn` và tuyến `/shared/writing-essays/`.
- Ba execution n8n gần cuối cửa sổ E2E (`1843587`, `1843593`, `1843598`) đều `success`.
- Sau kiểm thử, scope QA đã được dry-run rồi đổi sang `closed`. Roster, session, 7 attempts và 7 comments demo được giữ làm bằng chứng; API công khai chỉ còn hai lớp thật.

## URL

- Học viên: `https://tranhoangduc90.github.io/izone-ai-team-pages/writing-handouts/lesson.html?task=writing-task2-public-health-spending`.
- Lớp `CS.070626`: thêm `&class=CS.070626`.
- Lớp `CS.160826`: thêm `&class=CS.160826`.
- Giảng viên: `https://tranhoangduc90.github.io/izone-ai-team-pages/writing-handouts/teacher.html?task=writing-task2-public-health-spending`.

## Rollback

- Tạm dừng bằng cách đổi hai class scope hoặc activity sang `closed`; không xóa roster, session, comment hoặc bài.
- Lùi giao diện bằng cách revert đúng commit Pages và chờ GitHub Pages build xong rồi đọc lại URL.
- Chỉ phục hồi database từ backup khi xác định có hỏng dữ liệu; ưu tiên migration bù hoặc đóng scope.
