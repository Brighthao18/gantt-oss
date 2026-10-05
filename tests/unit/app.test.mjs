import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// A zone west of UTC with daylight saving exposes date-only parsing and day-boundary errors.
process.env.TZ = 'America/New_York';

const [apiSource, appSource] = await Promise.all(['api.js', 'app.js']
    .map(name => readFile(new URL(`../../${name}`, import.meta.url), 'utf8')));

function setup(initial = {}) {
    const values = new Map(Object.entries(initial));
    const localStorage = { getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(String(key), String(value)), removeItem: key => values.delete(key) };
    const context = vm.createContext({ localStorage, setTimeout, clearTimeout,
        document: { addEventListener() {}, getElementById: () => null },
        fetch: async () => { throw new Error('Unexpected network request'); }, console: { log() {}, error() {} } });
    vm.runInContext(`${apiSource}\n${appSource}\nglobalThis.app = { DateUtils, DataStore, AppState, UI, CloudAPI };`, context);
    const { app } = context;
    // These tests cover data logic; rendering and toasts need the page and are covered by browser tests.
    app.UI.render = () => {};
    app.UI.showToast = () => {};
    return { ...app, values, localStorage };
}
const local = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

test('task dates parse as local wall-clock dates and convert to datetime-local values', () => {
    const { DateUtils } = setup();
    const legacyDay = DateUtils.parse('2026-09-01');
    assert.deepEqual([legacyDay.getFullYear(), legacyDay.getMonth(), legacyDay.getDate(), legacyDay.getHours()], [2026, 8, 1, 0]);
    assert.equal(DateUtils.toInputValue('2026-10-06T09:00'), '2026-10-06T09:00');
    assert.equal(DateUtils.toInputValue('2026-10-13T13:00:00.000Z'), '2026-10-13T09:00');
    assert.equal(DateUtils.toInputValue('invalid-date'), '');
    // 2026-11-01 has 25 hours in this zone; calendar days must stay whole.
    assert.equal(DateUtils.daysBetween('2026-10-31T23:00', '2026-11-02T00:30'), 2);
});

test('timeline cells start at midnight and bars align with the header cell containing their dates', () => {
    const { AppState, UI } = setup();
    // Past dates make the range start at the task rather than today, so the layout is deterministic.
    const tasks = [{ startDate: '2020-03-04T09:00', endDate: '2020-03-05T01:00' }];
    const layout = viewMode => {
        AppState.viewMode = viewMode;
        const range = UI.calculateTimeRange(tasks);
        return { range, bar: UI.calculateBarPosition(tasks[0], range, UI.getCellWidth(viewMode)) };
    };

    const day = layout('day');
    assert.equal(local(day.range.dates[0].date), '2020-02-26');
    assert.equal(day.range.dates[0].date.getHours(), 0);
    assert.deepEqual({ ...day.bar }, { left: 7 * 40, width: 2 * 40 - 4 }); // Mar 4 and Mar 5 cells

    const week = layout('week');
    assert.equal(local(week.range.dates[0].date), '2020-03-02'); // first Monday cell
    assert.equal(week.bar.left, 2 / 7 * 60);

    const month = layout('month');
    assert.equal(local(month.range.dates[0].date), '2020-02-01');
    assert.equal(Math.floor(month.bar.left / 80), 1); // March cell, not February
    assert.ok(Math.abs(month.bar.left - (1 + 3 / 31) * 80) < 1e-6);
});

test('the zoomed cell width is shared by the header, grid lines, and bars', () => {
    const { AppState, UI } = setup();
    AppState.zoomLevel = 1.5;
    AppState.viewMode = 'day';
    const range = UI.calculateTimeRange([{ startDate: '2020-03-04T09:00', endDate: '2020-03-04T10:00' }]);
    assert.equal(UI.getCellWidth('day'), 60);
    assert.equal(UI.getCellWidth('week'), 60);
    assert.match(UI.renderGridHtml(range, UI.getCellWidth('day')), /^<div class="grid-line [^"]*" style="min-width: 60px;">/);
});

test('extending an overdue task counts from today and keeps local wall-clock times', () => {
    const { UI } = setup();
    const now = new Date(2026, 9, 6, 10, 30);
    const task = { startDate: '2026-09-16T08:00', endDate: '2026-09-26T18:00' };
    UI.extendOverdueTask(task, 1, now);
    assert.deepEqual({ ...task }, { startDate: '2026-09-27T08:00', endDate: '2026-10-07T18:00' });

    // Legacy UTC ISO values are converted to the datetime-local format.
    const legacy = { startDate: '2026-09-16T12:00:00.000Z', endDate: '2026-09-26T22:00:00.000Z' };
    UI.extendOverdueTask(legacy, 3, now);
    assert.deepEqual({ ...legacy }, { startDate: '2026-09-29T08:00', endDate: '2026-10-09T18:00' });
});

test('completing a recurring task replaces it with an incomplete next cycle in datetime-local format', () => {
    const { UI } = setup();
    const done = { id: 'once', name: 'One-off', startDate: '2026-10-01T09:00', endDate: '2026-10-01T10:30', recurrence: 0 };
    const weekly = { id: 'weekly', name: 'Weekly review', startDate: '2026-10-01T09:00', endDate: '2026-10-01T10:30',
        recurrence: 7, color: '#10b981', reminder: { enabled: true, methods: { email: false }, timing: [1] } };
    const project = { tasks: [done, weekly] };
    const nextDay = () => { const date = new Date(); date.setDate(date.getDate() + 7); return local(date); };
    const before = nextDay();
    UI.completeTask(project, done);
    UI.completeTask(project, weekly);
    const after = nextDay();

    assert.equal(done.completed, true);
    assert.equal(project.tasks.length, 2);
    const next = project.tasks[1];
    assert.notEqual(next.id, 'weekly');
    assert.ok([before, after].includes(next.startDate.slice(0, 10)));
    assert.match(next.startDate, /^\d{4}-\d{2}-\d{2}T09:00$/);
    assert.match(next.endDate, /^\d{4}-\d{2}-\d{2}T10:30$/);
    assert.deepEqual([next.completed, next.recurrence, next.color], [false, 7, '#10b981']);
});

test('legacy tasks completed through progress can be marked incomplete', () => {
    const { AppState, UI } = setup({ gantt_current_user: 'test-profile' });
    AppState.init();
    AppState.data.projects = [{ id: 'p', name: 'Project', tasks: [
        { id: 'legacy', name: 'Task', startDate: '2026-09-01', endDate: '2026-09-03', progress: 100 }
    ] }];
    AppState.currentProjectId = 'p';
    // Documented compatibility rule, also applied by the reminder Worker.
    const isCompleted = task => task.completed === true || task.progress === 100;
    UI.toggleTaskComplete('legacy');
    const task = AppState.data.projects[0].tasks[0];
    assert.equal(isCompleted(task), false);
    UI.toggleTaskComplete('legacy');
    assert.equal(isCompleted(task), true);
});

test('random task colors are always hex values the renderer accepts', () => {
    const { AppState, UI } = setup();
    AppState.data = { projects: [{ id: 'p', tasks: ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b',
        '#10b981', '#14b8a6', '#06b6d4', '#3b82f6'].map(color => ({ color })) }] };
    AppState.currentProjectId = 'p';
    for (let i = 0; i < 20; i++) {
        const color = UI.generateRandomColor();
        assert.match(color, /^#[0-9a-f]{6}$/);
        assert.equal(UI.safeColor(color), color);
    }
    assert.equal(UI.hslToHex(0, 100, 50), '#ff0000');
    assert.equal(UI.hslToHex(120, 100, 25), '#008000');
});

test('saves go to the profile that owns the loaded data after another tab switches profiles', () => {
    const { AppState, CloudAPI, values, localStorage } = setup({ gantt_current_user: 'profile-one',
        'jsonbin_api_key_profile-two': 'test-key' });
    AppState.init();
    AppState.data.projects.push({ id: 'p1', name: 'Profile one project', tasks: [] });
    // Another tab switched profiles; this page has not processed the storage event yet.
    localStorage.setItem('gantt_current_user', 'profile-two');
    CloudAPI.init();
    AppState.save();
    assert.equal(JSON.parse(values.get('gantt_data_profile-one')).projects[0].name, 'Profile one project');
    assert.equal(values.has('gantt_data_profile-two'), false);
    // No upload is scheduled with the other profile's cloud settings.
    assert.equal(AppState.autoSyncTimer, null);
    AppState.cancelAutoSync();
});
