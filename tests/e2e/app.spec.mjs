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
// Stores fictional data for a profile that has not been opened yet. Task dates are [days from today, 'HH:MM'].
async function seedProfile(page, profile, projects) {
    await page.evaluate(([profile, projects]) => {
        const at = ([days, time]) => {
            const date = new Date(); date.setDate(date.getDate() + days);
            return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${time}`;
        };
        localStorage.setItem(`gantt_data_${profile}`, JSON.stringify({ version: 1, lastModified: 1,
            projects: projects.map(project => ({ ...project, tasks: project.tasks.map(({ start, end, ...task }) => ({
                startDate: at(start), endDate: at(end), color: '#6366f1', completed: false, recurrence: 0, ...task })) })) }));
    }, [profile, projects]);
}
// Header label of the cell containing each bar's left edge, in display order.
function barStartLabels(page) {
    return page.evaluate(() => {
        const cells = [...document.querySelectorAll('#timelineHeader .timeline-cell')];
        const cellWidth = cells[0].getBoundingClientRect().width;
        return [...document.querySelectorAll('.gantt-bar')].map(bar =>
            cells[Math.floor(parseFloat(bar.style.left) / cellWidth + 1e-6)].querySelector('.day-num').textContent);
    });
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

test('bars start in the header cell of their start date in every view, with zoom and scrolling', async ({ page }) => {
    await page.goto('/');
    await seedProfile(page, '时间轴档案', [{ id: 'timeline-project', name: '示例时间轴', tasks: [
        { id: 'started', name: '进行中任务', start: [-2, '09:00'], end: [3, '18:00'] },
        { id: 'later', name: '后续任务', start: [20, '09:00'], end: [40, '18:00'] }
    ] }]);
    await page.locator('#loginUsername').fill('时间轴档案');
    await page.locator('#loginBtn').click();
    // The sidebar lists existing projects right after login.
    await expect(page.locator('.project-name')).toHaveText(['示例时间轴']);
    const expected = await page.evaluate(() => {
        const starts = [-2, 20].map(days => { const date = new Date(); date.setDate(date.getDate() + days); return date; });
        const label = date => `${date.getMonth() + 1}/${date.getDate()}`;
        const monday = date => { const day = new Date(date); day.setDate(day.getDate() - (day.getDay() + 6) % 7); return day; };
        return { day: starts.map(label), week: starts.map(date => label(monday(date))), month: starts.map(date => `${date.getMonth() + 1}月`) };
    });
    for (const [title, select] of [['汇总视图', null], ['示例时间轴', '.project-item']]) {
        if (select) await page.locator(select).click();
        for (const mode of ['week', 'month', 'day']) {
            await page.locator(`[data-view="${mode}"]`).click();
            await expect(page.locator('#currentProjectName')).toHaveText(title);
            await expect(page.locator('.gantt-bar')).toHaveCount(2);
            expect(await barStartLabels(page)).toEqual(expected[mode]);
        }
        await expect(page.locator('#timelineHeader .timeline-cell.today')).toHaveCount(1);
    }

    await page.locator('#timelineHeader').hover();
    await page.mouse.wheel(0, -200);
    await expect.poll(() => page.evaluate(() => AppState.zoomLevel)).toBeGreaterThan(1);
    const [headerCell, gridCell] = await page.evaluate(() => ['#timelineHeader .timeline-cell', '.grid-line']
        .map(selector => document.querySelector(selector).getBoundingClientRect().width));
    expect(headerCell).toBeGreaterThan(40);
    expect(gridCell).toBe(headerCell);
    expect(await barStartLabels(page)).toEqual(expected.day);

    // Rows follow the header after it scrolls and after the chart re-renders.
    await page.locator('#timelineHeader').evaluate(header => { header.scrollLeft = 120; });
    await page.locator('[data-view="day"]').click();
    expect(await page.evaluate(() => [...document.querySelectorAll('.task-timeline')].map(row => row.scrollLeft)))
        .toEqual([120, 120]);

    await page.locator('#summaryViewEntry').click();
    await page.locator('#timelineHeader').hover();
    await page.mouse.wheel(0, 200);
    await expect(page.locator('#currentProjectName')).toHaveText('汇总视图');
    await expect(page.locator('.gantt-bar')).toHaveCount(2);
});

test('completed recurring tasks continue as editable local-time tasks', async ({ page }) => {
    await enter(page); await addProject(page);
    const [start, end] = await futureDates(page);
    await page.locator('#addTaskBtn').click();
    await page.locator('#taskName').fill('每周例会');
    await page.locator('#startDate').fill(start);
    await page.locator('#endDate').fill(end);
    await page.locator('#taskRecurrence').selectOption('7');
    await page.locator('#saveTask').click();
    await page.locator('.task-checkbox').click();
    await expect(page.locator('.toast-message').filter({ hasText: '已创建下一个周期任务' })).toBeVisible();
    await expect(page.locator('.task-checkbox.checked')).toHaveCount(0);
    const next = await page.evaluate(() => AppState.getCurrentProject().tasks[0]);
    expect(next.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T09:00$/);
    await page.locator('.task-name').click();
    await expect(page.locator('#startDate')).toHaveValue(next.startDate);
    await expect(page.locator('#endDate')).toHaveValue(next.endDate);
    await page.keyboard.press('Escape');
    await expect(page.locator('#taskModal')).not.toHaveClass(/active/);

    // Earlier versions saved recurring tasks as UTC ISO strings, which datetime-local inputs reject.
    const local = await page.evaluate(() => {
        const start = new Date(); start.setDate(start.getDate() + 3); start.setHours(9, 0, 0, 0);
        const end = new Date(start); end.setHours(11);
        Object.assign(AppState.getCurrentProject().tasks[0], { startDate: start.toISOString(), endDate: end.toISOString() });
        UI.render();
        const format = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:00`;
        return [format(start), format(end)];
    });
    await page.locator('.task-name').click();
    await expect(page.locator('#startDate')).toHaveValue(local[0]);
    await expect(page.locator('#endDate')).toHaveValue(local[1]);
    await page.locator('#saveTask').click();
    await expect(page.locator('#taskModal')).not.toHaveClass(/active/);
    expect(await page.evaluate(() => AppState.getCurrentProject().tasks[0].startDate)).toBe(local[0]);
});

test('overdue tasks are extended from today, and completing a recurring one continues it', async ({ page }) => {
    await page.goto('/');
    await seedProfile(page, '过期示例', [{ id: 'overdue-project', name: '过期项目', tasks: [
        { id: 'late', name: '十天前到期', start: [-20, '08:00'], end: [-10, '18:00'] },
        { id: 'weekly', name: '每周汇报', start: [-9, '09:00'], end: [-8, '10:00'], recurrence: 7 }
    ] }]);
    await page.locator('#loginUsername').fill('过期示例');
    await page.locator('#loginBtn').click();
    await expect(page.locator('#overdueModal')).toHaveClass(/active/);
    await expect(page.locator('.project-name')).toHaveText(['过期项目']);
    const late = page.locator('.overdue-task-item[data-task-id="late"]');
    await late.locator('[data-days="1"]').click();
    page.once('dialog', dialog => dialog.accept('0'));
    await late.locator('[data-action="custom"]').click();
    await expect(page.locator('.toast-message').filter({ hasText: '1 到 365' })).toBeVisible();
    await expect(late.locator('.overdue-action-btn.active')).toHaveText('+1天');
    await page.locator('.overdue-task-item[data-task-id="weekly"] [data-action="complete"]').click();
    await page.locator('#confirmOverdue').click();

    const result = await page.evaluate(() => {
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
        return { tasks: AppState.data.projects[0].tasks, overdue: UI.checkOverdueTasks().length,
            tomorrow: `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}` };
    });
    expect(result.overdue).toBe(0);
    expect(result.tasks.find(task => task.id === 'late').endDate).toBe(`${result.tomorrow}T18:00`);
    expect(result.tasks.find(task => task.id === 'weekly')).toBeUndefined();
    expect(result.tasks.find(task => task.name === '每周汇报')).toMatchObject({ completed: false, recurrence: 7 });
});

test('a profile switch in another tab is followed instead of overwriting either profile', async ({ context }) => {
    const first = await context.newPage();
    await enter(first, '档案甲'); await addProject(first, '甲的项目');
    const second = await context.newPage();
    await second.goto('/');
    await expect(second.locator('#userName')).toHaveText('档案甲');
    second.once('dialog', dialog => dialog.accept());
    await second.locator('#logoutBtn').click();
    await expect(first.locator('#loginModal')).toHaveClass(/active/);
    await second.locator('#loginUsername').fill('档案乙');
    await second.locator('#loginBtn').click();
    await addProject(second, '乙的项目');
    await expect(first.locator('#userName')).toHaveText('档案乙');
    await expect(first.locator('.project-name')).toHaveText(['乙的项目']);
    await first.locator('.project-item').click();
    await addTask(first, '第一个标签页的任务');
    const stored = await first.evaluate(() => ['档案甲', '档案乙'].map(profile =>
        JSON.parse(localStorage.getItem(`gantt_data_${profile}`)).projects.map(project => [project.name, project.tasks.length])));
    expect(stored).toEqual([[['甲的项目', 0]], [['乙的项目', 1]]]);
});

test('changes saved in another tab of the same profile are kept', async ({ context }) => {
    const first = await context.newPage();
    await enter(first, '共享档案'); await addProject(first, '项目一');
    const second = await context.newPage();
    await second.goto('/');
    await addProject(second, '项目二');
    await expect(first.locator('.project-name')).toHaveText(['项目一', '项目二']);
    await addProject(first, '项目三');
    await expect(second.locator('.project-name')).toHaveText(['项目一', '项目二', '项目三']);
    expect(await first.evaluate(() => DataStore.load().projects.map(project => project.name)))
        .toEqual(['项目一', '项目二', '项目三']);
});

test('a tab that missed a profile switch saves to its own profile and resyncs before cloud actions', async ({ page }) => {
    let providerCalls = 0;
    await page.route('https://api.jsonbin.io/**', route => { providerCalls++; return route.fulfill({ json: {} }); });
    await enter(page, '档案甲'); await addProject(page, '甲的项目');
    // Same-page writes do not fire storage events, as if the event from another tab had not arrived yet.
    await page.evaluate(() => {
        localStorage.setItem('gantt_data_档案乙', JSON.stringify({ version: 1, lastModified: 1,
            projects: [{ id: 'second-project', name: '乙的项目', tasks: [] }] }));
        localStorage.setItem('jsonbin_api_key_档案乙', 'test-key');
        localStorage.setItem('jsonbin_bin_id_档案乙', 'test-bin');
        localStorage.setItem('gantt_current_user', '档案乙');
    });
    await page.locator('.project-menu').click();
    await page.locator('#projectName').fill('甲改名');
    await page.locator('#saveProject').click();
    expect(await page.evaluate(() => AppState.autoSyncTimer)).toBeNull();
    await page.locator('#uploadBtn').click();
    await expect(page.locator('#userName')).toHaveText('档案乙');
    await expect(page.locator('.project-name')).toHaveText(['乙的项目']);
    const stored = await page.evaluate(() => ['档案甲', '档案乙'].map(profile =>
        JSON.parse(localStorage.getItem(`gantt_data_${profile}`)).projects.map(project => project.name)));
    expect(stored).toEqual([['甲改名'], ['乙的项目']]);
    expect(providerCalls).toBe(0);
});

test('PNG export grows to fit many tasks instead of clipping them', async ({ page }) => {
    await enter(page); await addProject(page);
    const [startDate, endDate] = await futureDates(page);
    await page.evaluate(([startDate, endDate]) => {
        AppState.getCurrentProject().tasks = Array.from({ length: 40 }, (_, index) => ({ id: `bulk-${index}`,
            name: `示例任务${index + 1}`, startDate, endDate, color: '#6366f1', notes: '', completed: false }));
        AppState.save(); UI.render();
    }, [startDate, endDate]);
    await page.locator('#exportBtn').click();
    await expect(page.locator('#exportPreview canvas')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#doExport').click();
    const bytes = await readFile(await (await downloadPromise).path());
    // A4 landscape is 1123 x 794 px; 40 rows of 30 px need more height than one page.
    expect(bytes.readUInt32BE(16)).toBe(1123);
    expect(bytes.readUInt32BE(20)).toBeGreaterThan(40 * 30);
});
