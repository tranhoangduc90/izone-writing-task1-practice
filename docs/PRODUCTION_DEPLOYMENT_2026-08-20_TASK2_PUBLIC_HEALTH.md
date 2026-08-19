# Biên bản phát hành Task 2 · Public health · 20/08/2026

## Phạm vi

- Một web app Task 2 dùng chung; đề mới là record cấu hình, không phải bản sao ứng dụng.
- Đề: “Shops should be banned from selling any food or drink that has been scientifically proven to be damaging to public health. Do you agree or disagree?”
- Activity production chỉ gắn lớp và học viên kiểm thử giả. Chưa gán lớp học thật hoặc đưa dữ liệu học viên thật qua hệ thống.

## Cổng đã đạt

| Cổng | Kết quả |
| --- | --- |
| Backup PostgreSQL production và staging | Đạt; cả hai archive đọc được bằng `pg_restore -l` |
| Migration staging | Đạt; activity, bốn section, lớp và roster giả được readback |
| API staging/production | `health` và `ready` đạt |
| Web unit/check | 68/68 và syntax check đạt |
| Backend unit/check | 46/46 và syntax check đạt |
| Prompt dùng chung | Ba section nhận đề lúc chạy; không ghim đề mẫu |
| Khóa thứ tự | Idea 1 bị chặn trước khi Topic Sentence đạt |
| Chống bấm đôi | Hai request cùng mã trả cùng một attempt |
| Topic Sentence | Câu yếu `needs_revision`; câu sửa `passed` và khóa |
| Supporting Idea 1 | Chuỗi yếu `needs_revision`; chuỗi sửa `passed` và khóa |
| Supporting Idea 2 | `passed`; tạo 11 dòng từ vựng |
| Draft | `passed`; tạo link LMS hợp lệ và API đọc được kết quả nội tuyến |
| Trạng thái cuối | Cả bốn section `passed` và `locked=true` |

## Lỗi phát hiện trong kiểm thử thật

Lượt Draft đầu tiên trả `DRAFT_LMS_DISPATCH_FAILED`. Giao diện n8n cho thấy node ghi kết quả dùng URL từ biến môi trường chưa được cấu hình nên hiển thị `POST: undefined`. Bản sửa dùng địa chỉ API nội bộ giống workflow chính; workflow được backup, validate, cập nhật riêng và lượt Draft mới đã đạt. Không restart n8n khi áp dụng bản sửa này.

## Vận hành

- Workflow chính nhận riêng `workerPool=task2`; workflow Draft chỉ được gọi nội bộ.
- Hai workflow không lưu execution payload thành công/lỗi để tránh lưu bài học viên trong n8n.
- Prompt Registry chỉ có một record template; `task_prompt` của từng activity được chèn lúc học viên bấm Check.
- Muốn mở cho lớp thật cần một migration gán class scope/roster riêng; không sửa web app hoặc workflow.
