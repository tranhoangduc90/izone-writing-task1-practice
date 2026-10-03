-- Dữ liệu nhận vào: activity draft đã ghim đúng prompt; Pages URL và registry đã kiểm.
-- Việc chính: mở đúng CS.070626 và CS.160826, làm mới roster cho riêng activity này.
-- Kết quả: activity active, hai scope active và roster đọc được theo API.
-- Khi lỗi: rollback toàn transaction; không đụng session/bài làm của đề khác.

BEGIN;

DO $open$
DECLARE
  v_activity_id BIGINT;
  v_expected_registry_key TEXT := '__PROMPT_REGISTRY_KEY__';
  v_expected_record_ref TEXT := '__PROMPT_RECORD_REF__';
  v_class RECORD;
  v_scope_count INTEGER;
  v_roster_count INTEGER;
  v_roster_scope_count INTEGER;
BEGIN
  IF v_expected_registry_key = '__PROMPT_REGISTRY_KEY__'
     OR v_expected_record_ref = '__PROMPT_RECORD_REF__' THEN
    RAISE EXCEPTION 'Chưa điền Redis key và record ref đã xác minh';
  END IF;

  SELECT id INTO v_activity_id
  FROM writing_practice.activity
  WHERE slug = 'average-earnings-by-sector-2000-2010'
    AND public_id = 'ed8162c1-2d54-4998-96a8-458fa75d26aa'
    AND content_version = 'task1-web-activity-v1'
    AND manifest_checksum = 'b8cd5a6723853e17e6882638764a83264ed4aa31c16ab4c1f2a16bcc9c7e7e7e'
    AND prompt_registry_key = v_expected_registry_key
    AND prompt_record_ref = v_expected_record_ref
    AND prompt_version = '1'
    AND grading_pool = 'task1'
    AND status IN ('draft', 'active')
  FOR UPDATE;

  IF v_activity_id IS NULL THEN
    RAISE EXCEPTION 'Activity draft/pin/checksum chưa đúng';
  END IF;

  -- Tái sử dụng mã lớp và hạn học từ scope đang hoạt động của cùng khóa.
  -- Nếu một tên lớp ánh xạ nhiều mã hoặc không có scope mẫu, dừng để đối soát.
  FOR v_class IN
    SELECT class_name_snapshot,
           min(erp_course_class_id) AS erp_course_class_id,
           max(scope.end_date) AS end_date,
           count(DISTINCT erp_course_class_id) AS id_count
    FROM writing_practice.activity_class_scope AS scope
    JOIN writing_practice.activity AS activity
      ON activity.id = scope.activity_id
    WHERE activity.slug = 'writing-task2-public-health-spending'
      AND activity.status = 'active'
      AND scope.class_name_snapshot IN ('CS.070626', 'CS.160826')
      AND scope.status = 'active'
    GROUP BY scope.class_name_snapshot
  LOOP
    IF v_class.id_count <> 1 OR v_class.end_date < CURRENT_DATE THEN
      RAISE EXCEPTION 'Ánh xạ/hạn học lớp % không duy nhất hoặc đã hết hạn', v_class.class_name_snapshot;
    END IF;

    INSERT INTO writing_practice.activity_class_scope (
      activity_id, erp_course_class_id, class_name_snapshot, end_date, status
    ) VALUES (
      v_activity_id, v_class.erp_course_class_id, v_class.class_name_snapshot,
      v_class.end_date, 'active'
    )
    ON CONFLICT (activity_id, erp_course_class_id) DO UPDATE
    SET class_name_snapshot = EXCLUDED.class_name_snapshot,
        end_date = EXCLUDED.end_date,
        status = EXCLUDED.status;
  END LOOP;

  SELECT count(*) INTO v_scope_count
  FROM writing_practice.activity_class_scope
  WHERE activity_id = v_activity_id
    AND class_name_snapshot IN ('CS.070626', 'CS.160826')
    AND status = 'active';

  IF v_scope_count <> 2 THEN
    RAISE EXCEPTION 'Cần đúng hai scope active, hiện có %', v_scope_count;
  END IF;

  -- Hai lớp CS dùng roster ngoại lệ đã duyệt; sao chép đúng từng lớp từ
  -- activity nguồn của cùng khóa, rồi để hàm chuẩn tạo alias ổn định.
  INSERT INTO writing_practice.activity_roster_override (
    activity_class_id, erp_student_contact_id, student_public_id,
    display_name, active, approved_by, reason, updated_at
  )
  SELECT target_scope.id, source_override.erp_student_contact_id,
         source_override.student_public_id, source_override.display_name,
         source_override.active, source_override.approved_by,
         source_override.reason, now()
  FROM writing_practice.activity_class_scope AS target_scope
  JOIN writing_practice.activity AS source_activity
    ON source_activity.slug = 'writing-task2-public-health-spending'
   AND source_activity.status = 'active'
  JOIN writing_practice.activity_class_scope AS source_scope
    ON source_scope.activity_id = source_activity.id
   AND source_scope.erp_course_class_id = target_scope.erp_course_class_id
   AND source_scope.status = 'active'
  JOIN writing_practice.activity_roster_override AS source_override
    ON source_override.activity_class_id = source_scope.id
   AND source_override.active
  WHERE target_scope.activity_id = v_activity_id
    AND target_scope.status = 'active'
    AND target_scope.class_name_snapshot IN ('CS.070626', 'CS.160826')
  ON CONFLICT (activity_class_id, erp_student_contact_id) DO UPDATE
  SET student_public_id = EXCLUDED.student_public_id,
      display_name = EXCLUDED.display_name,
      active = EXCLUDED.active,
      approved_by = EXCLUDED.approved_by,
      reason = EXCLUDED.reason,
      updated_at = now();

  UPDATE writing_practice.activity SET status = 'active', updated_at = now()
  WHERE id = v_activity_id;

  PERFORM writing_practice.refresh_activity_roster(v_activity_id);

  SELECT count(*), count(DISTINCT scope.id)
  INTO v_roster_count, v_roster_scope_count
  FROM writing_practice.activity_roster AS roster
  JOIN writing_practice.activity_class_scope AS scope
    ON scope.id = roster.activity_class_id
  WHERE scope.activity_id = v_activity_id
    AND scope.status = 'active'
    AND roster.active;

  IF v_roster_count = 0 OR v_roster_scope_count <> 2 THEN
    RAISE EXCEPTION 'Roster thiếu lớp hoặc rỗng: học viên=%, lớp=%',
      v_roster_count, v_roster_scope_count;
  END IF;
END
$open$;

COMMIT;
