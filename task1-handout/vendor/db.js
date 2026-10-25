import pg from 'pg';

const { Pool } = pg;

export function createDatabasePool(config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    // Một lớp có thể đăng ký đồng thời; chờ pool tối đa 15 giây thay vì trả lỗi giả khi PostgreSQL vẫn khỏe.
    connectionTimeoutMillis: 15_000,
    application_name: 'izone_writing_task1_practice_api'
  });
  pool.on('error', () => console.error('PostgreSQL pool gặp lỗi kết nối nền.'));
  return pool;
}

export async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
