/**
 * Nhận pool riêng và kiểm quyền thực tế của tài khoản trước mọi đường xử lý.
 * Không cấp quyền hoặc đọc bài Writing; chỉ tra metadata quyền PostgreSQL.
 * Sai role/quyền vượt phạm vi thì khóa Reading/Listening và giữ Writing hoạt động.
 */
export function createReadingListening67AccessGuard(pool) {
  let checkedAt = 0, checking;
  return async function check() {
    if (Date.now() - checkedAt < 30_000) return;
    if (!checking) checking = (async () => {
      const result = await pool.query(`SELECT current_user AS role_name,
        r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls AS elevated,
        EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS member_of_other_role,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('writing_flow','mapping','learning') AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege(current_user,c.oid,'SELECT') OR has_table_privilege(current_user,c.oid,'INSERT')
            OR has_table_privilege(current_user,c.oid,'UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE'))) AS cross_product_access
        FROM pg_roles r WHERE r.rolname=current_user`);
      const r = result.rows[0];
      if (!r || r.role_name !== 'reading_listening67_api' || r.elevated || r.member_of_other_role || r.cross_product_access) throw Error('RL67_DATABASE_ROLE_OVERSCOPED');
      checkedAt = Date.now();
    })().finally(() => { checking = null; });
    return checking;
  };
}
