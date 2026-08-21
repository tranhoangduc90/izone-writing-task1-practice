# Biên bản phát hành Task 2 · Living alone · CS.070626 · 21/08/2026

## Phạm vi

- Đề: “Nowadays, more and more people are choosing to live alone. Is this a positive or negative development?”
- Activity: `writing-task2-living-alone-development`, phiên bản nội dung `2026-08-21.1`.
- Lớp: `CS.070626`, mã lớp ERP `1184`.
- Dùng web app và bộ prompt Task 2 chung; không tạo HTML, JavaScript hoặc workflow n8n mới.

## Cấu hình và dữ liệu

- Manifest production có checksum SHA-256 `4ae0118dc1db04d46b2c32b9b2f242caac020047976136e992b1f1414f023c30`.
- Activity dùng `grading_pool='task2'`, Prompt Registry `task2-web-template-v1`, phiên bản `2026-08-19.1`.
- Bốn section giữ nguyên: `topic_sentence`, `supporting_idea_1`, `supporting_idea_2`, `draft`.
- Roster sao chép từ scope `CS.070626` đang hoạt động của activity Task 1 trước đó: 31 học viên, 31 alias không trùng.
- API công khai không trả email, ERP ID hoặc Google ID.

## Cổng phát hành

| Kiểm tra | Kết quả |
| --- | --- |
| Web local | 68/68 test đạt; syntax check đạt |
| Backend local | 47/47 test đạt; syntax check đạt |
| SQL dry run | Đạt; transaction rollback |
| CI PR #24 | Đạt |
| GitHub Pages | Workflow `32470801407` test và deploy đều đạt |
| Manifest công khai | HTTP 200; checksum và đề bài khớp |
| Backup database | Archive 4,1 MB đọc được bằng `pg_restore -l` |
| Migration production | Transaction commit; activity 1, section 4, scope 1, roster 31 |
| API production | `/health` và `/ready` HTTP 200 |
| Kiểm tra trình duyệt | Chỉ có lớp `CS.070626`, 31 học viên, không có lỗi console |

Không tạo lượt chấm bằng tên học viên thật trong lúc phát hành. Pipeline chấm Task 2 dùng chung không thay đổi và đã qua kiểm thử production ở activity Public Health.

## Đường dẫn và khôi phục

- Web: `https://tranhoangduc90.github.io/izone-writing-task1-practice/lesson.html?task=writing-task2-living-alone-development`
- Migration: `docs/migrations/2026-08-21-release-task2-living-alone-cs070626.sql`.
- Backup VPS: `/opt/backups/writing-practice/2026-08-21-task2-living-alone/mapping_db-before-release.dump`.

Khi cần tạm dừng, đổi class scope sang `closed`; không xóa roster hoặc phiên học viên. Không cần restart n8n.
