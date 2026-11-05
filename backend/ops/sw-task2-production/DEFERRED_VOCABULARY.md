# Trả nhận xét trước khi tạo từ vựng · 05/11/2026

SW Task 2 công bố kết luận chấm `supporting_idea_2` ngay khi AI chấm xong. Khi đạt theo schema v2, cùng transaction đó xếp một `deferred_vocabulary_job`. Worker hai slot và workflow Shops hiện hành nhận cả hai loại việc theo thứ tự tạo. Không thay rubric, model chấm, model từ vựng (`gemini-3.1-pro-preview`, HIGH), điều kiện khóa/mở phần hoặc bộ chấm Draft.

`deferred-vocabulary.sql` là migration cộng thêm. Chạy bằng owner DB `shops_writing`, cấp SELECT/INSERT/UPDATE cho role API hiện hành trước phát code. Không xóa hay chuyển các attempt, phản hồi, nháp hoặc job từ vựng cũ. Không áp migration này sang Writing 67 hoặc SW Task 1.

Job ghim prompt và snapshot theo source attempt. Việc nhận xét đã commit và việc xếp từ vựng là nguyên tử; gửi trùng cùng lease/nội dung chỉ có một receipt/job. Từ vựng không sửa feedback, kết quả đạt/cần sửa, fail streak, ngày hoàn tất chấm hay section locks. Trước claim và callback phải còn đúng nội dung lập luận, thân bài, vòng chấm và lượt mới nhất; sửa Draft không làm cũ từ vựng. Callback lặp phải cùng lease và output hash. Thử lại tối đa ba lần, chờ 5/15 giây; hết lease được worker phục hồi. Thử lại thủ công của cùng snapshot giữ model/prompt ghim và tăng generation để tránh dùng lại response lỗi đã cache.

`installDeferredVocabularyRoutes` phải đặt trước các route `/shops/status` và `/lesson9/sessions/:ref/vocabulary` cũ. Tuyến nội bộ mới dùng cùng Bearer credential native. `/shops/status` gom cả hai hàng chờ trong một SQL; cờ recovery chỉ trả cho worker có credential. Tuyến cũ và cơ chế tạo từ vựng sau Edit của legacy vẫn giữ nguyên khi không có job tách phù hợp.

Thứ tự phát: migration → API overlay từ đúng live image → Pages → workflow đã kiểm. Nguồn `server.mjs` live còn các overlay overview/worker trước đây chưa có hết trên main; khi đóng gói phải áp đúng hai hunk import/install lên server live, không ghi đè server bằng bản main. `service-runtime.js` đã đối chiếu baseline live trước khi sửa.

Quay lại: đổi workflow sang cách tạo inline nhưng giữ nhánh nhận job từ vựng mới để rút hết hàng hiện có, rồi quay API/Pages riêng. Hoặc giữ API mới để xử lý hết job trước khi trở lại exact workflow cũ. Không bỏ consumer khi còn job mới, không restore database hoặc DROP bảng để quay code.

Kiểm hữu hạn: test service/HTTP/lease/retry/định danh, n8n Code và expression trên instance thật, PostgreSQL thật 30 lượt xen kẽ/đảo callback, giao diện đủ tám đề và hai vai trò qua nhiều nhịp, một lần AI thật với prompt/model hiện hành. Số đo giả lập chỉ chứng minh thời điểm công bố tách khỏi từ vựng, không là p95 AI production.
