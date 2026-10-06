# Dashboard giảng viên Lesson 5

Giảng viên đọc thẻ học viên để biết phần đang làm, số ô đã viết, phần đã thông qua, lượt Check, nhận xét AI và trao đổi mở. Nhấn thẻ mở bài hiện tại theo A → X → B; thứ tự chấm B → A → X giữ nguyên.

API teacher giữ quyền Google/lớp hiện có. Tổng hợp và chi tiết thêm `dashboard` cùng metadata xử lý; không trả prompt, token hoặc snapshot job. Check đếm logical job chấm, không đếm retry, từ vựng hoặc xác nhận cho qua. Mốc hỗ trợ 3/6/9 chỉ lấy nhận xét AI chưa đạt liên tiếp ở phần đang mở. Bước đã cho qua không còn cảnh báo từ lỗi chấm trước đó.

Mốc hoạt động lưu trong payload `dashboardActivity` bên trong cùng transaction với bài/job/trao đổi, tồn tại sau dọn nhật ký hai tháng. Góp ý GV và poll không thành hoạt động HV. Phiên cũ thiếu mốc lưu bài để null; không lấy `updated_at` làm giờ học viên hoạt động. Không cần migration hoặc hàng xử lý mới.

Frontend đọc lại sau năm giây kể từ lúc đọc xong, không chồng lượt; tab ẩn dừng. Giữ vùng nhập, selection, requestId, trang nhật ký và job đang mở. Nhật ký chỉ tải khi mở bài, cập nhật có chủ đích hoặc xem thêm/job. Sau lỗi đọc, giữ dữ liệu cùng lớp và giờ thành công trước đó; đổi lớp bỏ dữ liệu lớp cũ và response muộn.

Phát hành chỉ thay image Handout 67 và route teacher Lesson 5. Giữ backend Writing/Progress Log/n8n, auth, roster, rubric và dữ liệu bài. Quay lui image Handout 67 về digest ngay trước lần phát hành và revert gói frontend teacher; không restore đè database. Metadata bổ sung tương thích runtime trước đó.

Kiểm: `node --test --test-concurrency=1 test/*.test.mjs` trong backend; bộ kiểm Lesson 5, kiểm Writing và trình duyệt trên fixture riêng ở frontend. Máy Windows ít RAM cần chạy PGlite tuần tự; lỗi out-of-memory không chứng minh ca nghiệp vụ đạt.
