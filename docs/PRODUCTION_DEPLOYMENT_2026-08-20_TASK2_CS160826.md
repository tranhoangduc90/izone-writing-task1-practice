# Biên bản mở Task 2 cho CS.160826 · 20/08/2026

## Phạm vi

- Gắn lớp ERP `CS.160826` (course class `1283`) vào activity `writing-task2-public-health-ban`.
- Lấy họ tên hiển thị từ ERP, không lấy tên rút gọn trong Google Classroom.
- Đưa đủ 12 học viên vào roster: 11 mapping đã duyệt và 1 ngoại lệ ERP chưa có tài khoản Classroom.
- Không sửa hoặc restart n8n.

## Thay đổi production

- Backup database trước thay đổi, kiểm tra archive bằng `pg_restore -l`.
- Hàm làm mới roster ưu tiên `erp_student_name_snapshot`; chỉ fallback sang tên Classroom khi ERP không có tên.
- Thêm class scope `CS.160826` và một ngoại lệ roster có lưu lý do/phê duyệt nội bộ.
- Đóng class scope kiểm thử nội bộ sau khi QA hoàn tất; giữ lịch sử nhưng không hiển thị trên web production.
- API công khai chỉ trả `studentRef`, `displayName`, `alias`, `provisional`, `requiresAccessCode`; không trả ERP ID, Google ID hoặc email.

Migration: `docs/migrations/2026-08-20-release-public-health-cs160826-erp-names.sql`.

## Readback

| Kiểm tra | Kết quả |
| --- | --- |
| Class scope | 1 active |
| Roster lớp thật | 12 active |
| Tên khớp chính xác ERP | 12/12 |
| Alias không trùng | 12/12 |
| Ngoại lệ ERP | 1 active |
| Lớp kiểm thử nội bộ | closed, 0 học viên active |
| API roster trên web | Lớp xuất hiện, 12 lựa chọn họ tên |
| API `/health` và `/ready` | HTTP 200 |

## Kiểm thử chức năng

- Web: 68/68 test đạt; toàn bộ syntax check đạt.
- Backend: 47/47 test đạt; toàn bộ syntax check đạt.
- Phiên kiểm thử production bằng dữ liệu giả tải lại thành công:
  - Topic Sentence: có ca cần sửa và ca đạt.
  - Supporting Idea 1: có ca cần sửa và ca đạt.
  - Supporting Idea 2: đạt và còn artifact từ vựng.
  - Draft: đạt, còn nội dung sau tải lại, có artifact LMS và thẻ chấm từng câu hiển thị trong web.
- Bốn section cuối cùng đều `locked=true`, `fail_streak=0`.

## Khôi phục

Backup trước phát hành nằm trên VPS tại:

`/opt/backups/writing-practice/2026-08-20-cs160826/mapping_db-before-release.dump`

Không xóa roster hoặc phiên học viên khi rollback. Đóng class scope trước, giữ database chỉ đọc để đối soát rồi mới khôi phục từ backup nếu thật sự cần.
