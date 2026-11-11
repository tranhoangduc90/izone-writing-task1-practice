CREATE SCHEMA IF NOT EXISTS sw_roster;

CREATE TABLE IF NOT EXISTS sw_roster.projection (
  activity_class_id bigint NOT NULL REFERENCES writing_practice.activity_class_scope (id) ON DELETE CASCADE,
  student_ref uuid NOT NULL,
  PRIMARY KEY (activity_class_id, student_ref)
);

REVOKE ALL ON SCHEMA sw_roster FROM PUBLIC;
REVOKE ALL ON sw_roster.projection FROM PUBLIC;

DO $$
BEGIN
  IF current_database() IN ('sw_task1', 'sw_task1_test') THEN
    GRANT USAGE ON SCHEMA sw_roster TO task1_api;
    GRANT SELECT, INSERT ON sw_roster.projection TO task1_api;
  ELSIF current_database() = 'shops_writing' THEN
    GRANT USAGE ON SCHEMA sw_roster TO shops_api;
    GRANT SELECT, INSERT ON sw_roster.projection TO shops_api;
  END IF;
END $$;
