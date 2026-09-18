import { createTeacherApi } from './api.js';
import { createRequestId } from './core.js';
import { teacherAuthFailure } from './teacher-auth-ui.js';
import { groupWritingPairs } from './writing-flow-groups.js';

// Nhận vào: trạng thái từng cặp từ API quản trị đã kiểm quyền.
// Việc chính: hiện bước đang chạy và danh sách cần kiểm tra, chỉ gửi yêu cầu retry sau khi người vận hành xác nhận.
// Trả ra: màn hình cập nhật từ database; không hiển thị bài làm hay điểm chi tiết.
// Khi lỗi: giữ dữ liệu cũ trên màn hình và báo rõ; không coi cú bấm là đã chấm xong.
const $ = id => document.getElementById(id);
const state = { token: '', api: null, timer: null, pendingRequestIds: new Map(),
  pairLimit: 100, failureLimit: 100 };
const stageNames = {
  intake: 'Tiếp nhận', precheck: 'Kiểm trước khi chấm', main: 'Chấm chính',
  critic: 'Phản biện', arbiter: 'Phân xử', render: 'Xuất kết quả', deliver: 'Ghi link vào homework',
};
const stageWorkflowIds = {
  precheck: 'P2p5N7iZzwHFDufk', main: 'X0qzwWc5CgBzgOWT',
  critic: '4o6jEwyQM4U29XU6', arbiter: 'yFdVOEBVhLitToQD',
  render: 'o8uncH0TWsJybeS2', deliver: 'KqWtSbjkHDMSAgbN',
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

function describeHistoryEvent(event) {
  const step = stageNames[event.stage_key] || event.stage_key || '';
  const status = event.status || 'chưa rõ';
  if (event.kind === 'stage') return `${step}: ${status}${event.error_code ? ` · lỗi ${event.error_code}` : ''}`;
  if (event.kind === 'attempt') return `${step}: lần thử ${event.attempt_no}, ${status}${event.error_code ? ` · lỗi ${event.error_code}` : ''}`;
  if (event.kind === 'ai_call') return `${step}: gọi AI nhóm ${Number(event.batch_index) + 1}, ${status}${event.provider ? ` · ${event.provider}` : ''}${event.error_code ? ` · lỗi ${event.error_code}` : ''}`;
  if (event.kind === 'handoff') return `Chuyển từ ${stageNames[event.from_stage] || event.from_stage} sang ${stageNames[event.to_stage] || event.to_stage}: ${status}, đã gửi ${event.send_count} lần`;
  return `${step}: danh sách Cần kiểm tra, ${status}${event.error_code ? ` · lỗi ${event.error_code}` : ''}`;
}

function historyDetails(pair) {
  const details = document.createElement('details');
  details.append(makeText('summary', 'Xem nhật ký từng bước'));
  const content = makeText('div', '', 'flow-history');
  details.append(content);
  details.addEventListener('toggle', async () => {
    if (!details.open || details.dataset.loaded) return;
    content.textContent = 'Đang tải nhật ký…';
    try {
      const history = (await state.api.writingPairHistory(pair.pair_id)).data.history;
      content.replaceChildren();
      if (!history.events.length) content.append(makeText('p', 'Bài chưa bắt đầu xử lý.', 'muted'));
      for (const event of history.events) {
        const time = event.at ? new Date(event.at).toLocaleString('vi-VN') : 'Chưa rõ giờ';
        const execution = event.n8n_execution_id ? ` · mã lượt n8n ${event.n8n_execution_id}` : '';
        const line = makeText('p', `${time} · ${describeHistoryEvent(event)}${execution}`, 'flow-meta');
        const workflowId = stageWorkflowIds[event.stage_key];
        if (workflowId && event.n8n_execution_id) {
          const link = makeText('a', 'Mở lượt chạy');
          link.href = `https://ducizone.ddns.net/workflow/${workflowId}/executions/${encodeURIComponent(event.n8n_execution_id)}`;
          link.target = '_blank'; link.rel = 'noopener noreferrer';
          line.append(' · ', link);
        }
        content.append(line);
      }
      details.dataset.loaded = 'true';
    } catch (error) {
      content.textContent = `Chưa đọc được nhật ký: ${error.message}`;
    }
  });
  return details;
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
  for (const classGroup of groupWritingPairs(pairs)) {
    const classSection = document.createElement('section');
    classSection.className = 'flow-class-group';
    classSection.append(makeText('h3', `Lớp ${classGroup.classCode}`));
    for (const [homeworkIndex, homework] of classGroup.homeworks.entries()) {
      const homeworkSection = document.createElement('section');
      homeworkSection.className = 'flow-homework-group';
      homeworkSection.append(makeText('h4', `Homework ${homeworkIndex + 1} · ${homework.files.length} file`),
        makeText('p', `Mã hồ sơ: ${homework.recordId}`, 'flow-meta'));
      for (const file of homework.files) {
        const fileSection = document.createElement('div');
        fileSection.className = 'flow-file-group';
        const title = makeText('strong', `Link ${file.linkIndex ?? 'chưa rõ'} · ${file.pairs.length} bài`);
        fileSection.append(title);
        if (file.docId) {
          const link = makeText('a', 'Mở file homework');
          link.href = `https://drive.google.com/open?id=${encodeURIComponent(file.docId)}`;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          fileSection.append(link);
        }
        for (const pair of file.pairs) {
          const row = document.createElement('article'); row.className = 'flow-row';
          const body = document.createElement('div');
          const stage = pair.stage_key ? ` · ${stageNames[pair.stage_key] || pair.stage_key}` : '';
          const task = pair.task_type === 'task_1' ? 'Task 1'
            : pair.task_type === 'task_2' ? 'Task 2' : 'Chưa rõ Task';
          body.append(makeText('strong', `Bài số ${pair.essay_slot} · ${task}`),
            makeText('p', `${statusNames[pair.status] || pair.status}${stage}`, 'flow-meta'),
            historyDetails(pair));
          row.append(body); fileSection.append(row);
        }
        homeworkSection.append(fileSection);
      }
      classSection.append(homeworkSection);
    }
    root.append(classSection);
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
  if (!issues.length) return root.append(makeText('p', 'Không có bài hoặc tài liệu cần kiểm tra.', 'muted'));
  const reasonLabels = {
    FILE_TYPE_UNSUPPORTED: 'File không phải Google Docs hoặc DOCX',
    FETCH_FAILED: 'Không mở được tài liệu',
    PARSER_FAILED: 'Không đọc được nội dung bài',
    MIME_UNVERIFIED: 'Chưa xác minh loại file',
    SOURCE_METADATA_MISSING: 'Thiếu thông tin file',
    SOURCE_LINK_INVALID: 'Link tài liệu không hợp lệ',
    CLASS_MISSING: 'Thiếu mã lớp',
    INTAKE_TOPIC_MISSING: 'Ô bài có bài làm nhưng thiếu đề',
    INTAKE_CHART_LINK_INVALID: 'Link ảnh biểu đồ không hợp lệ',
    INTAKE_CHART_LINK_AMBIGUOUS: 'Ô ảnh biểu đồ có nhiều link',
    INTAKE_TASK_TYPE_MISMATCH: 'Loại đề không khớp ảnh biểu đồ',
  };
  for (const issue of issues) {
    const row = document.createElement('article'); row.className = 'flow-row';
    const body = document.createElement('div');
    const location = `Lớp ${issue.class_code || 'chưa rõ'} · Hồ sơ ${issue.source_record_id}`
      + (issue.homework_file_id ? ` · Tài liệu ${issue.homework_file_id}` : '')
      + (issue.source_link_index ? ` · link ${issue.source_link_index}` : '')
      + (issue.essay_slot ? ` · bài số ${issue.essay_slot}` : '');
    body.append(makeText('strong', reasonLabels[issue.reason_code] || issue.reason_code),
      makeText('p', location, 'flow-meta'));
    row.append(body); root.append(row);
  }
}

function renderWorkflowFailures(failures) {
  const root = $('flow-technical-errors'); root.replaceChildren();
  if (!failures.length) return root.append(makeText('p', 'Chưa có lỗi kỹ thuật được ghi nhận.', 'muted'));
  for (const failure of failures) {
    const row = document.createElement('article'); row.className = 'flow-row';
    const time = new Date(failure.last_seen_at).toLocaleString('vi-VN');
    const body = document.createElement('div');
    body.append(makeText('strong', `${failure.workflow_name} · ${failure.last_node}`),
      makeText('p', `${time} · ${failure.error_kind} · mã lượt n8n ${failure.execution_id}`
        + (Number(failure.seen_count) > 1 ? ` · gửi lại ${failure.seen_count} lần` : ''), 'flow-meta'));
    const link = makeText('a', 'Mở lượt chạy trên n8n');
    link.href = `https://ducizone.ddns.net/workflow/${encodeURIComponent(failure.workflow_id)}/executions/${encodeURIComponent(failure.execution_id)}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    body.append(link);
    row.append(body);
    root.append(row);
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

async function loadWorkflowFailures(count) {
  const failures = [];
  while (failures.length < count) {
    const size = Math.min(200, count - failures.length);
    const page = (await state.api.writingWorkflowFailures(failures.length, size)).data.failures || [];
    failures.push(...page);
    if (page.length < size) break;
  }
  return failures;
}

async function refresh() {
  clearTimeout(state.timer);
  if (!state.token || !state.api) return;
  try {
    const selectedBeforeLoad = $('flow-class').value;
    const [allPairs, summaryResult, allReviews, sourceIssues, failureResult] = await Promise.all([
      loadPairs(selectedBeforeLoad, state.pairLimit), state.api.writingSummary(),
      loadAllReviews(), loadAllSourceIssues(),
      loadWorkflowFailures(state.failureLimit)
        .then(rows => ({ rows })).catch(error => ({ error })),
    ]);
    const summary = summaryResult.data.summary || [];
    populateClasses([...summary, ...allReviews, ...sourceIssues]);
    const selectedClass = $('flow-class').value;
    renderSummary(summary, selectedClass);
    renderPairs(allPairs);
    renderReviews(allReviews.filter(review => !selectedClass || review.class_code === selectedClass));
    renderSourceIssues(sourceIssues.filter(issue => !selectedClass || issue.class_code === selectedClass));
    if (failureResult.error) {
      $('flow-technical-errors').replaceChildren(makeText('p',
        'Chưa tải được lỗi kỹ thuật; các trạng thái bài ở trên vẫn là dữ liệu mới.', 'muted'));
      $('flow-technical-more').hidden = true;
    } else {
      renderWorkflowFailures(failureResult.rows);
      $('flow-technical-more').hidden = failureResult.rows.length < state.failureLimit;
    }
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
    $('flow-technical-more').addEventListener('click', () => { state.failureLimit += 100; void refresh(); });
    await waitForGoogle(config.googleClientId);
  } catch (error) { showError('flow-login-error', error.message); }
}

void init();
