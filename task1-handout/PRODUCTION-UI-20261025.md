# Projection lịch sử phục vụ giao diện SW Task 1 — 25/10/2026

Sau khi Đức chốt Earnings và yêu cầu làm tiếp, API riêng đã lên image `sw-task1:20261025.5-ui-snapshots`, image ID `sha256:bbac014a10115ad8e027b75ee4cba2882d48b5ecdc02daebd148baea5d2f1d54`. Chỉ thay `src/service.mjs` và `src/history.mjs` bằng source đã nhập main PR59/60. Không thay app/router/server/authority/vendor/prompt/worker, không migration hoặc thay dữ liệu.

`sessionDetails`, `getAttempt` và phản hồi `saveDraft` bổ sung snapshot bất biến lấy từ đúng attempt/phiên. Thiếu snapshot cũ trả null; UI không lấy nháp mới thay đầu vào cũ. Kiểm 23/23 backend trên đúng source, gồm save response khác draft mới, lịch sử chỉ đọc, scope/PIN/lease/retry/conflict/comment và CSV.

Đã build từ overlay runtime production hiện hành, canary localhost18931, rồi đổi riêng API localhost18930. Network, env, mount, quyền, giới hạn CPU/RAM/PID và log giữ theo cấu hình cũ. `/task1-api/ready` xác nhận `productId=sw-task1`; `/writing-api/ready` vẫn healthy qua đường tương thích. Worker giữ image `.3` và container cũ; mọi container đang chạy khác giữ nguyên ID.

Đối chiếu toàn bộ hàng trước/sau của đủ18 bảng `writing_practice`: **allRowsUnchanged=true**. Mốc triển khai có108 phiên,671 attempt/comment,772 draft_request,10 thread/15 tin nhắn,1 status event;7 activity gồm6 bài thật và1 bài QA,14 scope gồm13 thật và1 QA đã đóng. Không coi số scope/bài QA là đã mở thêm lớp. Config/prompt/PIN và lịch sử giữ nguyên. Snapshot dữ liệu là backup riêng, không phải nguồn để restore khi quay code.

Biên nhận VPS: `/opt/izone-sw-task1/private/ui-rollout-20261025/deployed.json`, `before-data.private.json`, `after-data.private.json`. Kho laptop gốc `E:/Codex-Data/task1-earnings-ui-20261025/production-ui-*`; hồ sơ bàn giao trong project chính dẫn kho private-deployments. Không đưa snapshot bài/PIN lên Pages.

SHA-256 source live: `service.mjs` `f691c57ad8c3b918b0c5f9016bf2a3cb104ab1585f3672093755f663e6f1eb18`; `history.mjs` `5bbccf4b93dc7b454585fe66b266416b22fbcda70c55e24c52a73ddbe5ba6bab`.

Quay code API bằng container dừng `sw-task1-api-before-ui-20261025` hoặc image `.4`, giữ DB hiện hành/env/mount/network và bài mới; không restore DB hoặc mở lại nguồn Writing cũ. Canary `.5` đã dừng, giữ để truy vết. Rollback UI riêng bằng hai bootstrap Pages; không cần đổi API vì projection tương thích controller cũ.
