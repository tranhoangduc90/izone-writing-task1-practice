-- Nhận schema đã tạo; chuẩn bị role không đăng nhập và quyền đúng vùng RL67.
-- Mật khẩu/LOGIN được cấp riêng khi được phép production, không lưu vào source.
-- Không sửa quyền tài khoản Writing, mapping, learning hoặc PUBLIC của các vùng đó.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='reading_listening67_api') THEN
    CREATE ROLE reading_listening67_api NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='reading_listening67_api'
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit))
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='reading_listening67_api')) THEN
    RAISE EXCEPTION 'RL67_DATABASE_ROLE_OVERSCOPED';
  END IF;
END $$;
GRANT USAGE ON SCHEMA reading_listening67 TO reading_listening67_api;
GRANT SELECT, INSERT, UPDATE ON reading_listening67.document_unit, reading_listening67.classroom_binding,
  reading_listening67.job TO reading_listening67_api;
GRANT SELECT, INSERT ON reading_listening67.job_event TO reading_listening67_api;
ALTER ROLE reading_listening67_api SET search_path TO reading_listening67,pg_catalog;
ALTER ROLE reading_listening67_api SET statement_timeout TO '5s';
ALTER ROLE reading_listening67_api SET lock_timeout TO '3s';
COMMIT;
