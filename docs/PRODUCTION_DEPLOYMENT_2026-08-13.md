# Báo cáo triển khai production — Writing Task 1 web

## Phạm vi đã bật

- Đề: *The pie charts show the proportion of users across different age groups on three apps:Twitter, Facebook and YouTube.*
- Lớp pilot: `IC2200`.
- Roster được materialize: 14 học viên; trình duyệt chỉ nhận UUID công khai và tên hiển thị.
- Web: <https://tranhoangduc90.github.io/izone-writing-task1-practice/?task=pie-app-users-by-age>
- API: <https://ducizone.ddns.net/writing-api/>
- V1: Overview và Outline. Draft 2 chưa bật.

## Bảo vệ n8n

- Không restart container n8n; `RestartCount = 0`, thời điểm khởi động vẫn là `2026-07-30T09:47:08Z`.
- API Writing chạy container riêng, giới hạn `0,5 CPU` và `256 MB RAM`.
- Workflow dùng credential Header Auth riêng; token không nằm trong workflow, Git hoặc log.
- Workflow không lưu execution thành công/lỗi để tránh giữ bài làm và prompt trong n8n.
- API không áp trần số lease; `maxJobs` chỉ giới hạn kích thước một lần lấy hàng đợi. n8n là nơi duy nhất điều tiết số lượt chạy đồng thời; khóa hàng `SKIP LOCKED`, idempotency, lease và retry vẫn ngăn lấy trùng hoặc làm mất lượt.
- Worker `vps_2` được đặt trọng số `0` vì DNS không còn phân giải. Ba worker còn lại đã chạy vòng hai lượt liên tiếp, tất cả HTTP 200. Giá trị trước thay đổi đã được lưu trong thư mục backup cục bộ.

## Kiểm thử production

- Overview giả: hoàn tất, `passed`, có feedback, đúng `Comment lần 1`.
- Outline giả: hoàn tất, `needs_revision`, có feedback, đúng `Comment lần 1`.
- Workflow khôi phục đã trả đúng lease hết hạn về hàng đợi, không tạo Comment mới.
- Tất cả Code node đã được kiểm tra cú pháp bằng Node.js trước readback/deploy.
- GitHub Actions run `31666365501`: kiểm tra API, giao diện và deploy Pages đều đạt.
- Playwright desktop `1440×900` và mobile `390×844`: không có lỗi console; manifest, config, roster và ảnh đều HTTP 200.
- Sau khi xóa dữ liệu giả: activity pilot = 1, roster = 14, session = 0, attempt = 0, queued/leased = 0.
- Tài nguyên lúc bàn giao: ổ đĩa 43%; API khoảng 29 MB RAM; n8n khoảng 547 MB RAM.

## Backup và rollback

- PostgreSQL trước migration trên VPS: `/opt/backups/writing-practice/mapping_db-before-writing-20260813-103751.dump`.
- SHA-256: `50a10899a3518c5dce792c3c8e0c044d027c50873cef36a5a554f726a014a2ed`.
- Nginx trước sửa: `/etc/nginx/sites-available/ducizone.conf.before-writing-20260813-034218`.
- Workflow n8n có backup riêng trước lần cấu hình production và trước từng bản sửa.
- Rollback nhanh: tắt hai workflow Writing, bỏ route `/writing-api/`, dừng container API; Google Docs cũ vẫn được giữ nguyên.

## Việc chưa chặn pilot

- Hai link chatbot trong manifest đang ở trạng thái `pending_link`; Overview và Outline vẫn hoạt động đầy đủ.
- Sáu trường metadata web dự kiến chưa tồn tại trong Lark Base, nên chưa ghi đường dẫn/checksum vào record để tránh tự tạo sai kiểu field trên bảng production.
