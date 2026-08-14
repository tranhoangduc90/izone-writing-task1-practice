import { appendMarkdown } from './markdown.js';

const params = new URLSearchParams(window.location.search);
const requestedId = params.get('case');
const response = await fetch('./demo-draft-cases.json', { cache: 'no-store' });
if (!response.ok) throw new Error('Không tải được dữ liệu demo Draft.');
const { cases } = await response.json();
const selected = cases.find((item) => item.id === requestedId) || cases[0];

const nav = document.querySelector('#demo-case-nav');
for (const item of cases) {
  const link = document.createElement('a');
  link.href = `./demo-draft.html?case=${encodeURIComponent(item.id)}`;
  link.textContent = item.label;
  if (item.id === selected.id) link.setAttribute('aria-current', 'page');
  nav.append(link);
}

document.querySelector('#demo-overview').textContent = selected.overview;
document.querySelector('#demo-body1').textContent = selected.body1;
document.querySelector('#demo-body2').textContent = selected.body2;
document.querySelector('#demo-draft1').value = selected.draft1;
document.querySelector('#demo-draft2').value = selected.draft2;

const passed = selected.resultStatus === 'passed';
const workspace = document.querySelector('.demo-draft-workspace');
workspace.dataset.state = passed ? 'passed' : 'revision';
const status = document.querySelector('#demo-status');
status.dataset.state = passed ? 'passed' : 'revision';
status.textContent = passed ? 'Đã đạt' : 'Cần chỉnh sửa';
document.querySelector('#demo-comment').dataset.status = passed ? 'passed' : 'revision';
appendMarkdown(document.querySelector('#demo-feedback'), selected.feedback);
