import { createTeacherApi } from './api.js';
import { createRequestId } from './core.js';
import { teacherAuthFailure } from './teacher-auth-ui.js';

// Nhận vào: trạng thái từng cặp từ API quản trị đã kiểm quyền.
// Việc chính: hiện bước đang chạy và danh sách cần kiểm tra, chỉ gửi yêu cầu retry sau khi người vận hành xác nhận.
// Trả ra: màn hình cập nhật từ database; không hiển thị bài làm hay điểm chi tiết.
// Khi lỗi: giữ dữ liệu cũ trên màn hình và báo rõ; không coi cú bấm là đã chấm xong.
const $ = id => document.getElementById(id);
const state = { token: '', api: null, timer: null, pendingRequestIds: new Map(), pairLimit: 100 };
const stageNames = {
  intake: 'Tiếp nhận', precheck: 'Kiểm trước khi chấm', main: 'Chấm chính',
  critic: 'Phản biện', arbiter: 'Phân xử', render: 'Xuất kết quả', deliver: 'Ghi link vào homework',
};
const statusNames = {
  received: 'Chờ chấm', running: 'Đang xử lý', needs_review: 'Cần kiểm tra',
  delivered: 'Đã có link trong homework', superseded: 'Đã có phiên bản mới',
};

function showError(id, message = '') {
  const node = $(id);
  node.textContent = message;
  node.hidden = !message;
}

function metadata(row) {
  return `Lớp ${row.class_code} · Hồ sơ ${row.source_record_id} · Tài liệu ${row.homework_file_id} · link ${row.source_link_index} · bài số ${row.essay_slot}`;
}

function makeText(tag, value, className = '') {
  const node = document.createElement(tag);
  node.textContent = String(value ?? '');
  if (className) node.className = className;
  return node;
}

function renderSummary(summary, selectedClass) {
  const root = $('flow-summary');
  root.replaceChildren();
  const counts = new Map();
  for (const row of summary) {
    if (selectedClass && row.class_code !== selectedClass) continue;
    counts.set(row.status, (counts.get(row.status) || 0) + Number(row.pair_count || 0));
  }
  for (const status of ['received', 'running', 'needs_review', 'delivered']) {
    const card = document.createElement('article');
    card.append(makeText('strong', counts.get(status) || 0), makeText('span', statusNames[status]));
    root.append(card);
  }
}

function renderPairs(pairs) {
  const root = $('flow-pairs');
  root.replaceChildren();
  if (!pairs.length) return root.append(makeText('p', 'Chưa có bài nào trong phạm vi đã chọn.', 'muted'));
  for (const pair of pairs) {
    const row = document.createElement('article'); row.className = 'flow-row';
    const body = document.createElement('div');
    const stage = pair.stage_key ? ` · ${stageNames[pair.stage_key] || pair.stage_key}` : '';
    body.append(makeText('strong', `${statusNames[pair.status] || pair.status}${stage}`),
      makeText('p', metadata(pair), 'flow-meta'));
    row.append(body); root.append(row);
  }
}

async function retryReview(review, button) {
  if (!confirm(`Bạn đã kiểm tra lỗi ở bước “${stageNames[review.stage_key] || review.stage_key}” và muốn chạy lại đúng bài này?`)) return;
  const requestId = state.pendingRequestIds.get(review.review_id) || createRequestId();
  state.pendingRequestIds.set(review.review_id, requestId);
  button.disabled = true;
  showError('flow-error');
  try {
    await state.api.retryWritingReview(review.review_id, requestId);
    state.pendingRequestIds.delete(review.review_id);
    await refresh();
  } catch (error) {
    showError('flow-error', `Chưa xác nhận được yêu cầu chạy lại: ${error.message}. Hãy tải lại trạng thái trước khi bấm tiếp.`);
    button.disabled = false;
  }
}

function renderReviews(reviews) {
  const root = $('flow-reviews'); root.replaceChildren();
  if (!reviews.length) return root.append(makeText('p', 'Không có bài nào cần kiểm tra.', 'muted'));
  for (const review of reviews) {
    const row = document.createElement('article'); row.className = 'flow-row';
    const body = document.createElement('div');
    body.append(makeText('strong', `${stageNames[review.stage_key] || review.stage_key} · ${review.status === 'open' ? 'Cần kiểm tra' : 'Đã yêu cầu chạy lại'}`),
      makeText('p', metadata(review), 'flow-meta'),
      makeText('p', `Đã thử ${review.attempt_count}/3 lần · Lỗi gần nhất: ${review.error_code}`, 'flow-meta'));
    row.append(body);
    if (review.status === 'open') {
      const button = makeText('button', 'Chạy lại từ bước này');
      button.type = 'button'; button.className = 'primary';
      button.addEventListener('click', () => void retryReview(review, button));
      row.append(button);
    }
    root.append(row);
  }
}

function renderSourceIssues(issues) {
  const root = $('flow-source-issues'); root.replaceChildren();
  if (!issues.length) return root.append(makeText('p', 'Không có tài liệu cần kiểm tra.', 'muted'));
  for (const issue of issues) {
    const row = document.createElement('article'); row.className = 'flow-row';
    const body = document.createElement('div');
    const location = `Lớp ${issue.class_code || 'chưa rõ'} · Hồ sơ ${issue.source_record_id}`
      + (issue.homework_file_id ? ` · Tài liệu ${issue.homework_file_id}` : '')
      + (issue.source_link_index ? ` · link ${issue.source_link_index}` : '');
    body.append(makeText('strong', `Chưa nhận bài: ${issue.reason_code}`),
      makeText('p', location, 'flow-meta'));
    row.append(body); root.append(row);
  }
}

function populateClasses(rows) {
  const select = $('flow-class');
  const selected = select.value;
  select.replaceChildren(new Option('Tất cả lớp', ''));
  for (const code of [...new Set(rows.map(row => row.class_code).filter(Boolean))].sort()) {
    select.append(new Option(code, code));
  }
  select.value = [...select.options].some(option => option.value === selected) ? selected : '';
}

async function loadAllReviews() {
  const reviews = [];
  for (let offset = 0; offset <= 100000; offset += 200) {
    const page = (await state.api.writingReviews(offset, 200)).data.reviews || [];
    reviews.push(...page);
    if (page.length < 200) return reviews;
  }
  throw new Error('Danh sách cần kiểm tra quá dài để tải đầy đủ.');
}

async function loadAllSourceIssues() {
  const issues = [];
  for (let offset = 0; offset <= 100000; offset += 200) {
    const page = (await state.api.writingSourceIssues(offset, 200)).data.issues || [];
    issues.push(...page);
    if (page.length < 200) return issues;
  }
  throw new Error('Danh sách tài liệu lỗi quá dài để tải đầy đủ.');
}

async function loadPairs(classCode, count) {
  const pairs = [];
  while (pairs.length < count) {
    const size = Math.min(200, count - pairs.length);
    const page = (await state.api.writingPairs(classCode, pairs.length, size)).data.pairs || [];
    pairs.push(...page);
    if (page.length < size) break;
  }
  return pairs;
}

async function refresh() {
  clearTimeout(state.timer);
  if (!state.token || !state.api) return;
  try {
    const selectedBeforeLoad = $('flow-class').value;
    const [allPairs, summaryResult, allReviews, sourceIssues] = await Promise.all([
      loadPairs(selectedBeforeLoad, state.pairLimit), state.api.writingSummary(),
      loadAllReviews(), loadAllSourceIssues(),
    ]);
    const summary = summaryResult.data.summary || [];
    populateClasses([...summary, ...allReviews, ...sourceIssues]);
    const selectedClass = $('flow-class').value;
    renderSummary(summary, selectedClass);
    renderPairs(allPairs);
    renderReviews(allReviews.filter(review => !selectedClass || review.class_code === selectedClass));
    renderSourceIssues(sourceIssues.filter(issue => !selectedClass || issue.class_code === selectedClass));
    const totalPairs = summary
      .filter(row => !selectedClass || row.class_code === selectedClass)
      .reduce((total, row) => total + Number(row.pair_count || 0), 0);
    $('flow-more').hidden = allPairs.length >= totalPairs;
    $('flow-login').hidden = true;
    $('flow-dashboard').hidden = false;
    $('flow-updated').textContent = `Đã cập nhật ${new Date().toLocaleTimeString('vi-VN')}`;
    showError('flow-login-error'); showError('flow-error');
  } catch (error) {
    const failure = teacherAuthFailure(error.status);
    if (failure) {
      state.token = '';
      $('flow-dashboard').hidden = true;
      $('flow-login').hidden = false;
      $('flow-updated').textContent = failure.header;
      showError('flow-login-error', failure.message);
      globalThis.google?.accounts?.id?.disableAutoSelect?.();
      return;
    }
    showError($('flow-dashboard').hidden ? 'flow-login-error' : 'flow-error',
      'Chưa thể đọc trạng thái chấm. Hệ thống sẽ thử cập nhật lại.');
  }
  state.timer = setTimeout(refresh, 30_000);
}

function handleCredential(response) {
  if (!response?.credential) return showError('flow-login-error', 'Không nhận được thông tin đăng nhập.');
  state.token = response.credential;
  $('flow-updated').textContent = 'Đang xác minh quyền…';
  void refresh();
}

async function waitForGoogle(clientId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const accounts = globalThis.google?.accounts?.id;
    if (accounts) {
      accounts.initialize({ client_id: clientId, callback: handleCredential, auto_select: false });
      accounts.renderButton($('google-signin'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'vi' });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Không tải được dịch vụ đăng nhập Google.');
}

async function init() {
  try {
    const response = await fetch('./config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Thiếu cấu hình trang chấm bài.');
    const config = await response.json();
    if (!config.googleClientId) throw new Error('Trang chưa được cấu hình đăng nhập.');
    state.api = createTeacherApi(config.apiBase || '', () => state.token);
    $('flow-class').addEventListener('change', () => { state.pairLimit = 100; void refresh(); });
    $('flow-more').addEventListener('click', () => { state.pairLimit += 100; void refresh(); });
    await waitForGoogle(config.googleClientId);
  } catch (error) { showError('flow-login-error', error.message); }
}

void init();
