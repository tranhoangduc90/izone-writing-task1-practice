import { test, expect } from 'playwright/test';

test.use({ channel: 'chrome' });

test('học viên tạm đăng ký và mở Task 1 trên desktop', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8080/?task=pie-app-users-by-age');
  await page.selectOption('#class-id', '11111111-1111-4111-8111-111111111111');
  await page.click('#show-provisional');
  await page.screenshot({ path: '../output/provisional-task1-desktop.png', fullPage: true });
  await page.fill('#provisional-name', 'Học viên giao diện');
  await page.fill('#provisional-pin', '2468');
  await page.fill('#provisional-pin-confirm', '2468');
  await page.click('#create-provisional');
  await expect(page.locator('#access-code-row')).toBeVisible();
  await page.click('#identity-form button[type=submit]');
  await expect(page.locator('#workspace')).toBeVisible();
  await page.fill('textarea[name="overview"]', 'Bản lưu cục bộ để thử tiếp tục.');
  await page.waitForTimeout(700);
  expect(await page.evaluate(async () => { const database = await new Promise((resolve, reject) => { const request = indexedDB.open('izone-task1-practice'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); const values = await new Promise((resolve, reject) => { const request = database.transaction('drafts').objectStore('drafts').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); return JSON.stringify(values).includes('2468'); })).toBe(false);
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.locator('#resume-recent')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.click('#resume-recent');
  await expect(page.locator('#workspace')).toBeVisible();
  expect(errors).toEqual([]);
});

test('form học viên tạm dùng được trên màn hình điện thoại và bàn phím', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:8080/?task=pie-app-users-by-age');
  await page.selectOption('#class-id', '11111111-1111-4111-8111-111111111111');
  await page.focus('#show-provisional'); await page.keyboard.press('Enter');
  await expect(page.locator('#provisional-panel')).toBeVisible();
  await page.screenshot({ path: '../output/provisional-task1-mobile.png', fullPage: true });
});

test('dashboard một cột ưu tiên hỗ trợ, tiến trình thấp rồi chưa làm', async ({ page }) => {
  await page.addInitScript(() => {
    const accounts = { initialize(options) { globalThis.__googleCallback = options.callback; }, renderButton(root) { const button = document.createElement('button'); button.id = 'mock-google-login'; button.textContent = 'Đăng nhập thử'; button.addEventListener('click', () => globalThis.__googleCallback({ credential: 'mock-token' })); root.append(button); } };
    Object.defineProperty(globalThis, 'google', { value: { accounts: { id: accounts } }, configurable: false });
  });
  await page.route('https://accounts.google.com/**', route => route.abort());
  await page.goto('http://127.0.0.1:8080/teacher.html?task=pie-app-users-by-age');
  await page.click('#mock-google-login');
  await expect(page.locator('[data-group="support"] .teacher-student-card')).toHaveCount(2);
  const names = await page.locator('.teacher-student-card .teacher-student-header strong').allTextContents();
  expect(names.slice(0, 5)).toEqual(['Học viên mốc 9', 'Học viên tạm mốc 3', 'Tiến trình thấp', 'Tiến trình cao', 'Chưa bắt đầu']);
  await expect(page.locator('.teacher-provisional-badge')).toHaveText('Học viên tạm · Cần đối soát');
  await expect(page.locator('[data-group="not_started"] .teacher-not-started-badge')).toHaveText('Chưa làm');
  await page.screenshot({ path: '../output/teacher-dashboard-priority.png', fullPage: true });
  await page.locator('[data-group="support"] .teacher-student-card').nth(1).click();
  await expect(page.locator('#teacher-detail')).toHaveAttribute('open', '');
  await expect(page.locator('.teacher-detail-section[data-section-key="outline"]')).toBeVisible();
});
