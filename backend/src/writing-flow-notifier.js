// Dữ liệu nhận vào: trạng thái hàng bàn giao, tài liệu chờ tiếp nhận và lease quá hạn trong PostgreSQL.
// Việc chính: nghe tín hiệu sau commit, gộp tín hiệu trong hai giây và đánh thức đúng workflow n8n.
// Kết quả: bài mới chạy sau vài giây; khi webhook lỗi, công việc vẫn nằm trong database để thử lại.
// Khi lỗi: log chỉ loại hàng và mã lỗi, không ghi bài viết, tên học viên, URL riêng hay credential.
export const WRITING_FLOW_NOTIFY_CHANNEL = 'writing_flow_work_ready';
export const WRITING_FLOW_FALLBACK_MS = 5 * 60 * 1000;
const DIRECT_HANDOFF_GRACE_MS = 2_000;
const LEADER_LOCK_ID = 79202367;

export const writingFlowWorkStatusSql = `SELECT
  EXISTS (SELECT 1 FROM writing_flow.handoff h
    JOIN writing_flow.pair p ON p.pair_id=h.pair_id
    WHERE p.status<>'superseded'
      AND ((h.status='pending' AND h.next_send_at<=now())
        OR (h.status='sent' AND h.next_send_at<=now()
          AND h.last_sent_at<=now()-interval '6 hours'))
  ) OR EXISTS (SELECT 1 FROM writing_flow.stage_result s
    JOIN writing_flow.pair p ON p.pair_id=s.pair_id
    WHERE s.status='running' AND s.lease_expires_at<=now()
      AND p.status NOT IN ('delivered','superseded')) AS handoff_due,
  EXISTS (SELECT 1 FROM writing_flow.scan_item i
    JOIN writing_flow.scan_run r ON r.run_id=i.run_id
    WHERE r.status='open' AND i.status='pending'
      AND i.next_send_at<=now()
      AND (i.send_count=0 OR i.last_sent_at<=now()-interval '6 hours')
      AND (SELECT count(*) FROM writing_flow.scan_item busy
        JOIN writing_flow.scan_run open_run ON open_run.run_id=busy.run_id
        WHERE busy.status='pending' AND open_run.status='open'
          AND busy.send_count>0
          AND busy.last_sent_at>now()-interval '6 hours')<100) AS source_due,
  EXISTS (SELECT 1 FROM writing_flow.source_record s
      WHERE s.source_type IN ('manual','google_classroom','term_test')
        AND s.dispatch_status IN ('pending','sent')
        AND coalesce(s.next_dispatch_at,now())<=now()
        AND (s.dispatch_status='pending'
          OR coalesce(s.last_dispatched_at,'-infinity'::timestamptz)
            <=now()-interval '6 hours')
        AND NOT EXISTS (SELECT 1 FROM writing_flow.scan_run r
          WHERE r.status='open' AND r.source_app_id=s.source_app_id
            AND r.source_table_id=s.source_table_id)
        AND (SELECT count(*) FROM writing_flow.source_record busy
          WHERE busy.source_type IN ('manual','google_classroom','term_test')
            AND busy.dispatch_status='sent'
            AND busy.last_dispatched_at>now()-interval '6 hours')<100) AS intake_due,
  EXISTS (SELECT 1 FROM writing_flow.scan_item i
    JOIN writing_flow.scan_run r ON r.run_id=i.run_id
    WHERE r.status='open' AND i.status='pending'
      AND i.receipt_plan IS NOT NULL) AS receipt_pending,
  LEAST(
    (SELECT min(h.next_send_at) FROM writing_flow.handoff h
      JOIN writing_flow.pair p ON p.pair_id=h.pair_id
      WHERE h.status IN ('pending','sent')),
    (SELECT min(s.lease_expires_at) FROM writing_flow.stage_result s
      WHERE s.status='running'),
    (SELECT min(i.next_send_at) FROM writing_flow.scan_item i
      JOIN writing_flow.scan_run r ON r.run_id=i.run_id WHERE r.status='open'),
    (SELECT min(s.next_dispatch_at) FROM writing_flow.source_record s
      WHERE s.dispatch_status IN ('pending','sent'))
  ) AS next_at,
  now() AS server_now;`;

export function createWritingFlowNotifier({ pool, handoffUrl, sourceUrl, intakeUrl, secret,
  reconcileScans = null,
  fetchImpl = fetch, setTimer = setTimeout, clearTimer = clearTimeout,
  setRecurringTimer = setInterval, clearRecurringTimer = clearInterval,
  now = () => Date.now(), log = message => console.error(message) }) {
  const targets = { handoff: handoffUrl || null, source: sourceUrl || null,
    intake: intakeUrl || null };
  const enabled = Boolean(targets.handoff || targets.source || targets.intake);
  if (enabled && String(secret || '').length < 32) throw new Error('WRITING_FLOW_NOTIFY_CONFIG_INVALID');
  let listener = null;
  let timer = null;
  let timerDueAt = null;
  let fallback = null;
  let running = false;
  let pending = false;
  let closed = false;
  let isLeader = false;
  let lastSentAt = 0;
  let standby = null;
  let acquiring = null;

  function schedule(delay = 100) {
    if (!enabled || closed || !isLeader) return;
    if (timer) clearTimer(timer);
    const boundedDelay = Math.max(100, Math.min(delay, 2_147_000_000));
    timerDueAt = now() + boundedDelay;
    timer = setTimer(async () => { timer = null; timerDueAt = null; await pump(); }, boundedDelay);
    timer?.unref?.();
  }

  function kick() {
    if (!isLeader || closed) return;
    if (running) pending = true;
    // Bài mới phải rút lịch kiểm xa về gần; tín hiệu trùng không đẩy lùi lịch đã hẹn.
    else if (!timer || timerDueAt > now() + DIRECT_HANDOFF_GRACE_MS) schedule(DIRECT_HANDOFF_GRACE_MS);
  }

  async function send(kind) {
    const url = targets[kind];
    if (!url) return;
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ kind: `writing_flow_${kind}_ready` })
    });
    await response.body?.cancel?.();
    if (!response.ok) throw new Error('NOTIFY_HTTP_FAILED');
  }

  async function pump() {
    if (!enabled || closed || !isLeader) return;
    if (running) { pending = true; return; }
    running = true;
    try {
      const result = await pool.query(writingFlowWorkStatusSql);
      const row = result.rows[0];
      if (!row || closed || !isLeader) return;
      // Biên nhận có thể đến sau khi n8n gửi link; đối chiếu mà không gửi lại cả bài.
      let reconcileFailed = false;
      if (row.receipt_pending && reconcileScans) {
        try {
          const result = await reconcileScans();
          reconcileFailed = Boolean(result?.failureCount);
          if (reconcileFailed) log(JSON.stringify({ event: 'writing_flow_scan_reconcile_failed',
            failureCount: result.failureCount }));
        } catch {
          reconcileFailed = true;
          log(JSON.stringify({ event: 'writing_flow_scan_reconcile_failed', failureCount: 1 }));
        }
      }
      const kinds = [];
      if (row.handoff_due && targets.handoff) kinds.push('handoff');
      if (row.source_due && targets.source) kinds.push('source');
      if (row.intake_due && targets.intake) kinds.push('intake');
      if (kinds.length) {
        const wait = 2000 - (now() - lastSentAt);
        if (wait > 0) { schedule(wait); return; }
        lastSentAt = now();
        await Promise.all(kinds.map(send));
        log(JSON.stringify({ event: 'writing_flow_notify_sent', kinds }));
        schedule(30000);
      } else if (row.next_at) {
        const delay = new Date(row.next_at).getTime() - new Date(row.server_now).getTime();
        if (!Number.isFinite(delay)) throw new Error('STATUS_INVALID');
        // Một mốc cũ có thể đang bị khóa bởi lượt quét mở; tránh hỏi DB liên tục mỗi giây.
        schedule(reconcileFailed || delay < 0 ? 30_000 : Math.max(1000, delay + 100));
      } else if (reconcileFailed) schedule(30_000);
    } catch {
      log(JSON.stringify({ event: 'writing_flow_notify_failed', retrySeconds: 30 }));
      schedule(30000);
    } finally {
      running = false;
      if (pending) { pending = false; schedule(DIRECT_HANDOFF_GRACE_MS); }
    }
  }

  function ensureStandby() {
    if (standby || !enabled || closed) return;
    standby = setRecurringTimer(() => { void acquireLeadership(); }, WRITING_FLOW_FALLBACK_MS);
    standby?.unref?.();
  }

  function loseLeadership(candidate) {
    if (closed || listener !== candidate) return;
    // Mất kết nối PostgreSQL cũng làm mất advisory lock: dừng gửi trước khi thử nhận lại.
    listener = null;
    isLeader = false;
    if (timer) clearTimer(timer);
    if (fallback) clearRecurringTimer(fallback);
    timer = null;
    timerDueAt = null;
    fallback = null;
    try { candidate.release(true); } catch { /* Kết nối đã đóng. */ }
    log(JSON.stringify({ event: 'writing_flow_notify_listener_failed' }));
    ensureStandby();
  }

  async function acquireLeadership() {
    if (!enabled || closed) return false;
    if (listener || isLeader) return isLeader;
    if (acquiring) return acquiring;
    acquiring = (async () => {
      let candidate = null;
      try {
        candidate = await pool.connect();
        const lock = await candidate.query('SELECT pg_try_advisory_lock($1) AS acquired', [LEADER_LOCK_ID]);
        if (lock.rows[0]?.acquired !== true) {
          candidate.release();
          log(JSON.stringify({ event: 'writing_flow_notify_standby' }));
          ensureStandby();
          return false;
        }
        await candidate.query(`LISTEN ${WRITING_FLOW_NOTIFY_CHANNEL}`);
        if (closed) { candidate.release(true); return false; }
        listener = candidate;
        isLeader = true;
        candidate.on('notification', kick);
        candidate.on('error', () => loseLeadership(candidate));
        candidate.on('end', () => loseLeadership(candidate));
        if (standby) clearRecurringTimer(standby);
        standby = null;
        fallback = setRecurringTimer(() => {
          log(JSON.stringify({ event: 'writing_flow_fallback_sweep', intervalSeconds: 300 }));
          kick();
        }, WRITING_FLOW_FALLBACK_MS);
        fallback?.unref?.();
        kick();
        return true;
      } catch {
        try { candidate?.release(true); } catch { /* Kết nối đã đóng. */ }
        log(JSON.stringify({ event: 'writing_flow_notify_connect_failed' }));
        ensureStandby();
        return false;
      }
    })();
    try { return await acquiring; } finally { acquiring = null; }
  }

  async function start() {
    if (!enabled || closed) return false;
    const acquired = await acquireLeadership();
    if (!acquired) ensureStandby();
    return acquired;
  }

  async function close() {
    closed = true;
    if (acquiring) await acquiring;
    if (timer) clearTimer(timer);
    if (fallback) clearRecurringTimer(fallback);
    if (standby) clearRecurringTimer(standby);
    if (listener) {
      try { await listener.query(`UNLISTEN ${WRITING_FLOW_NOTIFY_CHANNEL}`); } catch { /* Đang tắt. */ }
      try { await listener.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_ID]); } catch { /* Đang tắt. */ }
      listener.release();
    }
    listener = null; timer = null; timerDueAt = null; fallback = null; standby = null; isLeader = false;
  }

  return { enabled, start, pump, kick, close };
}
