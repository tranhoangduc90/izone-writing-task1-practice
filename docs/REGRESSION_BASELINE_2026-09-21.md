# Mốc regression Writing ngày 21/09/2026

## Bản nguồn đã khóa

- Nhánh chuẩn: `main`.
- Commit nguồn của image production: `f84bc5112b0eb30a05a85f01f6d0745f48ae369c`.
- Commit sửa kết quả Draft từng câu: `e90733052c63d52a41a860871a4b065a4f8e0f16`.
- `e907330` là tổ tiên của `f84bc511`; vì vậy bản chuẩn giữ đồng thời sửa Draft và các sửa giao bài/TRCC.
- Image đã đọc lại khi chốt sự cố: `izone-writing-practice-api:20260921.12-delivery-sql-fix-main`.

Git giữ nguyên nội dung mọi test tại commit nền. Khi cần đối chiếu hoặc khôi phục, dùng commit trên thay vì lấy file rời từ một worktree cũ.

## Regression bắt buộc cho lỗi Draft

| Hành vi cần giữ | Test hiện hành |
| --- | --- |
| Link Writing viewer mới trả đủ câu gốc, câu sửa và giải thích | `backend/test/draft-viewer-result.test.js` |
| Link Quick Aid cũ vẫn đọc được | `backend/test/draft-viewer-result.test.js` |
| Snapshot rỗng hợp lệ không bị báo lỗi | `backend/test/draft-viewer-result.test.js` |
| Payload lỗi, lỗi tải và hai phiên đồng thời không ghép nhầm dữ liệu | `backend/test/draft-viewer-result.test.js` |
| Chỉ nhận host/đường dẫn LMS hợp lệ và chỉ lấy phần essay | `backend/test/lms-result-service.test.js` |
| Callback Draft nhận cả hai định dạng link LMS chính thức | `backend/test/service.test.js` |
| Giao diện học viên và giảng viên dùng cùng bộ thẻ LMS | `web/test/lms-draft-result.test.js`, `web/test/teacher-draft-result.test.js` |

## Regression bắt buộc cho bản backend kết hợp

| Hành vi cần giữ | Test hiện hành |
| --- | --- |
| Cứu TRCC không chấm lại bài và chỉ chạy trên phạm vi đã đối chiếu | `backend/test/writing-flow-trcc-repair-contract.test.js` |
| Kiểm chứng tuyến cứu trên staging | `backend/integration/trcc-repair-staging.mjs` |
| Không cấp đồng thời hai lượt ghi vào cùng một Google Homework | `backend/test/writing-flow-handoff.test.js` |
| SQL khóa giao bài cân bằng ngoặc và chịu được lỗi/lease quá hạn | `backend/test/writing-flow-handoff.test.js`, `backend/test/writing-flow-stage-resilience.test.js` |
| Intake không tạo lại cặp sau khi cứu TRCC | `backend/test/writing-flow-intake.test.js` |
| Dashboard và thống kê vẫn đọc đúng trạng thái lớp | `backend/test/writing-flow-service.test.js` |

## Lệnh kiểm tra đầy đủ

Chạy đúng hai bộ test và hai bộ kiểm tra cú pháp dưới đây trên cùng revision:

```powershell
Set-Location backend
npm ci
npm test
npm run check

Set-Location ..\web
npm test
npm run check
```

Tại commit nền, kết quả là:

- backend: 196/196 test đạt;
- web: 81/81 test đạt;
- tổng: 277/277 test đạt;
- không có test bị skip.

Workflow `.github/workflows/pages.yml` chạy lại cả backend và web trên mọi push hoặc pull request vào `main`. Bước deploy Pages chỉ chạy khi có `workflow_dispatch`, nên push source/test không tự phát hành Pages.

## Kết quả rà các worktree

- Đã rà 18 worktree của repository.
- Không có commit chứa test nào nằm ngoài `main`; mọi commit test đã là tổ tiên của commit nền.
- Hai worktree trực tiếp tạo bản production đều sạch và không còn test chưa commit.
- Các file chưa commit còn thấy ở worktree lịch sử thuộc một trong bốn nhóm: ca đã được đổi tên hoặc thay bằng test hiện hành; test cho kiến trúc event-dispatch đã bị thay thế; fixture cho manifest/slug cũ không còn tồn tại; file `.bak` hoặc script audit vận hành. Không chép các file này vào suite hiện hành vì chúng không kiểm đúng mã đang chạy.

Khi sửa hệ thống, không được chỉ chạy file test của phần vừa đổi. Phải chạy full suite trên revision cuối cùng sau khi rebase `origin/main`, rồi kiểm lại rằng commit đang phát hành vẫn chứa các test Draft và giao bài nêu trên.
