export async function readQueueStatus(pool,includeRecovery=false){
 // Match recoverJobs, which repairs expired leases and failed attempts with queued comments.
 const {rows:[row]}=await pool.query(`
  SELECT current_database() AS database,
   (SELECT count(*) FROM writing_practice.check_attempt a
    JOIN writing_practice.activity_session s ON s.id=a.session_id
    JOIN writing_practice.activity task ON task.id=s.activity_id
    WHERE a.status='queued' AND task.grading_pool='task2') AS queued,
   CASE WHEN $1::boolean THEN (
    EXISTS (SELECT 1 FROM writing_practice.check_attempt
            WHERE status='leased' AND lease_expires_at<=now())
    OR EXISTS (SELECT 1 FROM writing_practice.comment c
               JOIN writing_practice.check_attempt a ON a.id=c.attempt_id
               WHERE c.status='queued' AND a.status='failed')
   ) END AS "recoverDue"`,[includeRecovery]);
 return {database:row.database,queued:Number(row.queued),...(includeRecovery?{recoverDue:row.recoverDue}:{})};
}
