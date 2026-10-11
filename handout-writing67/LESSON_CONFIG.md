# Mở lesson Writing 67 bằng cấu hình

Mọi lesson theo hành trình thân bài 2 B–A–X dùng cùng API, kho bài làm, hàng chấm và giao diện. Lesson 5 giữ nguyên đề/rubric và dữ liệu đã có. Lesson 7 thay đề, hướng dẫn theo đề và rubric; lớp mở là IC2304.

## Một nguồn cấu hình

File riêng tư được trỏ bởi `HANDOUT67_PROMPT_FILE` chứa cả cấu hình công khai và sáu rubric. File này nằm ngoài image và Git. Không sao chép rubric sang frontend.

```json
{
  "version": "handout67-lessons-v1",
  "lessons": {
    "lesson7": {
      "definition": {
        "activity": "lesson7",
        "number": 7,
        "body": 2,
        "title": "Tên bài",
        "shortTitle": "Trọng tâm ngắn",
        "topic": "Đề nguyên văn từ nguồn",
        "aInstruction": "Hướng dẫn A theo đúng trọng tâm đề",
        "ideaHint": "Hướng dẫn học viên tự chọn ý",
        "classes": ["IC2304"],
        "defaultClass": "IC2304"
      },
      "version": "lesson7-rubric-v1",
      "rubrics": {
        "topic": "Rubric đầy đủ đã rà",
        "b1": "Rubric đầy đủ đã rà",
        "b2": "Rubric đầy đủ đã rà",
        "a": "Rubric đầy đủ đã rà",
        "x": "Rubric đầy đủ đã rà",
        "vocab": "Rubric đầy đủ đã rà"
      }
    }
  }
}
```

Đây là minh họa một mục; registry chạy thật phải giữ cả mục `lesson5`. Điền đề/rubric thật, không dùng chữ minh họa để chấm. Backend đọc mỗi mục, kiểm lớp trong phạm vi runtime rồi cấp cấu hình công khai cho UI. Cấu hình sai làm tiến trình từ chối khởi động, giúp tránh chấm nhầm. Rubric/topic/version của từng job được ghim trước khi nhận bài; retry dùng lại prompt đã ghim.

`classes` là phạm vi server cho phép. `defaultClass` chọn lớp hiển thị tại trang học viên; phải thuộc `classes`. Roster vẫn lấy qua adapter chỉ đọc và quyền giảng viên vẫn theo registry Google riêng. Thêm lớp ngoài `HANDOUT67_ALLOWED_CLASSES` cần cập nhật phạm vi runtime theo quyền hiện hành.

## Trang dùng chung

Frontend dùng `writing-handouts/shared/student.html`, `teacher.html`, `loader.mjs`; bộ điều khiển vẫn là `lesson5-thu/app.js`, `lesson5/teacher.js` cùng theme/CSS Lesson 5. Route lesson chỉ giữ head/CSP, `data-activity`, `data-view` và script nạp chung. Không tạo app/CSS/workflow riêng cho lesson mới.

`GET /api/handout67/v1/lessons/lesson7` chỉ trả phần công khai. Mở session gửi `activity`; roster và bảng GV gửi `?activity=lesson7`. Đường cũ không có activity mặc định Lesson 5. Bài làm tách theo activity–lớp–học viên; nháp local theo UUID phiên. Danh tính đã nhớ có thể dùng chung giữa lesson, nội dung bài không dùng chung.

## Chuyển bản và quay lại

Chuyển backend và registry đã kiểm trước khi phát hành frontend. Workflow n8n hiện hành nhận tuple/job/prompt chung, không cần thêm workflow cho Lesson 7. Không chạy migration, không đổi đăng ký/secret/queue của sản phẩm khác.

Trước đổi, giữ image, file rubric, cấu hình runtime và revision Pages cũ. Khi quay lại image cũ chỉ hiểu registry Lesson 5, phải quay lại cả registry và Pages tương ứng. Giữ database; không restore đè bài phát sinh. Lesson 7 sẽ tạm chưa mở được trên bản cũ, nhưng bài và job đã ghi vẫn được bảo toàn.

## Kiểm theo rủi ro

Kiểm cùng học viên ở hai lesson, đúng topic/version trong job, GV lọc đúng activity, token khác phiên bị chặn và class ngoài phạm vi bị chặn. Kiểm prompt pin qua retry và các ca core hiện có. Trên browser, so giao diện với mẫu và kiểm hai ý, vocab, Edit, trao đổi, reload và mobile. Fixture giả chỉ chứng minh UI/contract; ghi riêng bằng chứng AI thật và readback sau phát hành.
