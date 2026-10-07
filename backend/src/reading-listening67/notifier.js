/**
 * Đánh thức n8n bằng mã lượt đã lưu; không gửi bài làm hoặc danh tính học viên.
 * Nhịp riêng, timeout ngắn và tối đa sáu lần; mất ACK không tạo thêm lượt chấm.
 * Lỗi DB/network được ghi riêng, không ném sang notifier Writing hoặc dừng server.
 */
export function createReadingListening67Notifier({ store, url, token, fetchFn = fetch, intervalMs = 5000 }) {
  let timer, running = false, closed = false, settled;
  async function tick() {
    if (running || closed || !url) return;
    running = true;
    let resolveSettled;
    settled = new Promise(resolve => { resolveSettled = resolve; });
    try {
      await store.recoverExpired();
      const job = await store.dispatchDue();
      if (job) {
        try {
          const result = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ jobId: job.jobId }), signal: AbortSignal.timeout(4000), redirect: 'error' });
          if (!result.ok) throw new Error('DISPATCH_HTTP_FAILED');
          await result.body?.cancel();
        } catch { await store.dispatchFailed(job); }
      }
    } catch { console.error('Reading/Listening 67: chưa xử lý được hàng chờ; Writing tiếp tục chạy.'); }
    finally { running = false; resolveSettled(); }
  }
  return {
    tick,
    start() { if (!timer && url && !closed) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref(); void tick(); } },
    async close() { closed = true; clearInterval(timer); timer = null; if (running) await settled; },
  };
}
