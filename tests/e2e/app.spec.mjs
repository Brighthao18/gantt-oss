import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function enter(page, profile = '示例档案') {
    await page.goto('/');
    await page.locator('#loginUsername').fill(profile);
    await page.locator('#loginBtn').click();
    await expect(page.locator('#loginModal')).not.toHaveClass(/active/);
}
async function addProject(page, name = '示例研究计划') {
    await page.locator('#addProjectBtn').click();
    await page.locator('#projectName').fill(name);
    await page.locator('#saveProject').click();
    await page.locator('.project-item').filter({ hasText: name }).click();
}
async function futureDates(page) {
    return page.evaluate(() => {
        const format = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T09:00`;
        const start = new Date(); start.setDate(start.getDate() + 2);
        const end = new Date(); end.setDate(end.getDate() + 8);
        return [format(start), format(end)];
    });
}
async function addTask(page, name = '文献整理') {
    const [start, end] = await futureDates(page);
    await page.locator('#addTaskBtn').click();
    await page.locator('#taskName').fill(name);
    await page.locator('#startDate').fill(start);
    await page.locator('#endDate').fill(end);
    await page.locator('#taskNotes').fill('示例备注，仅用于测试');
    await page.locator('#saveTask').click();
    await expect(page.locator('.task-name').filter({ hasText: name })).toBeVisible();
}

test('local use creates and persists tasks, changes views, completes and deletes tasks', async ({ page }) => {
    const errors = [];
    const external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4175/')) external.push(request.url()); });
    await enter(page);
    await expect(page.locator('#autoSyncStatus')).toHaveClass(/disabled/);
    await addProject(page);
    await addTask(page);
    await page.reload();
    await page.locator('.project-item').click();
    await expect(page.locator('.task-name')).toHaveText('文献整理');
    for (const mode of ['week', 'month', 'day']) {
        await page.locator(`[data-view="${mode}"]`).click();
        await expect(page.locator('.gantt-bar')).toBeVisible();
    }
    await page.locator('.task-checkbox').click();
    await expect(page.locator('.task-name')).toHaveClass(/completed/);
    await page.locator('.task-name').click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#deleteTask').click();
    await expect(page.locator('.task-name')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
});

test('PNG preview and downloaded PNG are readable', async ({ page }) => {
    await enter(page); await addProject(page); await addTask(page);
    await page.locator('#exportBtn').click();
    await expect(page.locator('#exportPreview canvas')).toBeVisible();
    for (const style of ['light', 'academic', 'cyber', 'cartoon', 'festive', 'dark']) {
        await page.locator(`label:has(input[name="exportStyle"][value="${style}"])`).click();
        await expect(page.locator(`input[name="exportStyle"][value="${style}"]`)).toBeChecked();
        await expect(page.locator('#exportPreview canvas')).toBeVisible();
    }
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#doExport').click();
    const download = await downloadPromise;
    const bytes = await readFile(await download.path());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.readUInt32BE(16)).toBeGreaterThan(300);
    expect(bytes.readUInt32BE(20)).toBeGreaterThan(300);
});

test('settings, data, and pending uploads remain isolated when switching profiles', async ({ page }) => {
    let providerCalls = 0;
    await page.route('https://api.jsonbin.io/**', async route => {
        providerCalls++;
        await route.fulfill({ json: { metadata: { id: 'test-bin' }, record: { projects: [] } } });
    });
    await enter(page, '档案甲'); await addProject(page, '甲的项目');
    await page.locator('#settingsBtn').click();
    await page.locator('#jsonbinApiKey').fill('test-profile-key');
    await page.locator('#notificationEmail').fill('you@example.com');
    await page.locator('#saveSettings').click();
    await expect(page.locator('#settingsModal')).not.toHaveClass(/active/);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#logoutBtn').click();
    await page.locator('#loginUsername').fill('档案乙'); await page.locator('#loginBtn').click();
    await page.locator('#settingsBtn').click();
    await expect(page.locator('#jsonbinApiKey')).toHaveValue('');
    await expect(page.locator('#notificationEmail')).toHaveValue('');
    await expect(page.locator('.project-item')).toHaveCount(0);
    expect(await page.evaluate(() => AppState.autoSyncTimer)).toBeNull();
    expect(providerCalls).toBe(0);
});

test('blank key disables cloud sync for the active profile', async ({ page }) => {
    await enter(page);
    await page.evaluate(() => { CloudAPI.saveConfig('test-key', 'test-bin'); AppState.scheduleAutoSync(); });
    await page.locator('#settingsBtn').click();
    await page.locator('#jsonbinApiKey').fill('');
    await page.locator('#saveSettings').click();
    expect(await page.evaluate(() => CloudAPI.isConfigured())).toBe(false);
    expect(await page.evaluate(() => AppState.autoSyncTimer)).toBeNull();
    await expect(page.locator('#autoSyncStatus')).toHaveClass(/disabled/);
});

test('hostile profile, attribute and style strings are rendered as inert text', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await enter(page, '<img src=x>');
    const dates = await futureDates(page);
    await page.evaluate(([startDate, endDate]) => {
        globalThis.injectionRan = false;
        AppState.data.projects = [{ id: 'project" data-injected="yes', name: '<script>example()</script>', tasks: [{
            id: 'task" data-injected="yes', name: '<img src=x onerror="injectionRan=true">',
            startDate, endDate,
            notes: '" onmouseover="injectionRan=true', color: 'red;" data-injected="yes', completed: false
        }] }];
        UI.selectProject(AppState.data.projects[0].id);
        UI.showToast('<img src=x onerror="injectionRan=true">');
    }, dates);
    await expect(page.locator('[data-injected]')).toHaveCount(0);
    await expect(page.locator('.task-name img, .toast-message img, .project-name script')).toHaveCount(0);
    await expect(page.locator('.gantt-bar')).toHaveCSS('background-color', 'rgb(99, 102, 241)');
    expect(await page.evaluate(() => globalThis.injectionRan)).toBe(false);
    expect(errors).toEqual([]);
});

test('static server exposes public browser assets only and applies CSP', async ({ request }) => {
    const home = await request.get('/');
    expect(home.status()).toBe(200);
    expect(home.headers()['content-security-policy']).toContain("script-src 'self';");
    for (const path of ['/.dev.vars', '/wrangler.jsonc', '/worker.js', '/package.json', '/.git/config', '/Codex/work/', '/%2e%2e/.dev.vars']) {
        expect((await request.get(path)).status()).toBe(404);
    }
    expect((await request.post('/')).status()).toBe(405);
});

test('sample overview screenshot uses fictional data only', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await enter(page, '示例档案');
    await page.evaluate(() => {
        const start = new Date(); start.setDate(start.getDate() - 2); start.setHours(9, 0, 0, 0);
        const format = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T09:00`;
        const tasks = [ ['资料准备', 0, 2, '#6366f1'], ['文献整理', 1, 5, '#0ea5e9'],
            ['实验计划', 3, 8, '#10b981'], ['阶段汇报', 6, 10, '#f59e0b'] ].map(([name, offset, duration, color], index) => {
            const from = new Date(start); from.setDate(from.getDate()+offset);
            const to = new Date(start); to.setDate(to.getDate()+duration);
            return { id: `sample-task-${index}`, name, startDate: format(from), endDate: format(to), color,
                notes: '虚构任务，仅用于展示', completed: false, recurrence: 0, reminder: { enabled: false } };
        });
        AppState.data.projects = [{ id: 'sample-project', name: '示例研究计划', tasks }];
        UI.selectProject('sample-project');
        document.getElementById('toastContainer').replaceChildren();
    });
    await expect(page.locator('.gantt-bar')).toHaveCount(4);
    // Screenshots are test artifacts; normal test runs never rewrite documentation.
    await page.screenshot({ path: testInfo.outputPath('overview.png'), fullPage: true, animations: 'disabled' });
});

test('configured upload and download round-trip fictional project data', async ({ page }) => {
    let cloud;
    await page.route('https://api.jsonbin.io/**', async route => {
        if (route.request().method() === 'PUT') {
            cloud = route.request().postDataJSON();
            await route.fulfill({ json: { metadata: { id: 'test-bin' } } });
        } else await route.fulfill({ json: { record: cloud } });
    });
    await enter(page); await addProject(page, '本地示例项目');
    await page.evaluate(() => {
        CloudAPI.saveConfig('test-key', 'test-bin');
        CloudAPI.saveProfileSetting('notification_email', 'you@example.com');
    });
    await page.locator('#uploadBtn').click();
    await expect(page.locator('#uploadBtn')).toBeEnabled();
    expect(cloud.notificationEmail).toBe('you@example.com');
    cloud.projects[0].name = '云端示例项目';
    await page.locator('#downloadBtn').click();
    await expect(page.locator('.project-name')).toHaveText('云端示例项目');
    expect(await page.evaluate(() => DataStore.load().projects[0].name)).toBe('云端示例项目');
});

test('a delayed download cannot overwrite another profile after logout', async ({ page }) => {
    let release;
    let requested = false;
    const waiting = new Promise(resolve => { release = resolve; });
    await page.route('https://api.jsonbin.io/**', async route => {
        requested = true;
        await waiting;
        await route.fulfill({ json: { record: { projects: [{ id: 'old-project', name: '旧档案项目', tasks: [] }] } } });
    });
    await enter(page, '档案甲');
    await page.evaluate(() => CloudAPI.saveConfig('test-key', 'test-bin'));
    await page.locator('#downloadBtn').click();
    await expect.poll(() => requested).toBe(true);
    page.once('dialog', dialog => dialog.accept()); await page.locator('#logoutBtn').click();
    await page.locator('#loginUsername').fill('档案乙'); await page.locator('#loginBtn').click();
    release();
    await expect(page.locator('#downloadBtn')).toBeEnabled();
    await expect(page.locator('.project-item')).toHaveCount(0);
    expect(await page.evaluate(() => DataStore.load().projects)).toEqual([]);
});
