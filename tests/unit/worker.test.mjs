import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { calendarDay } from '../../worker.js';

const env = { JSONBIN_API_KEY: 'test-jsonbin-key', RESEND_API_KEY: 'test-resend-key',
    FROM_EMAIL: 'sender@example.com', ADMIN_TOKEN: 'test-admin-token', REMINDER_TIMEZONE: 'Asia/Shanghai' };
const now = new Date('2026-10-05T16:30:00Z'); // Oct 6 in Shanghai
function data(tasks) { return { projects: [{ id: 'project-one', name: 'Sample project', tasks }] }; }
function task(patch = {}) {
    return { id: 'task-one', name: 'Sample task', endDate: '2026-10-06T09:00', completed: false,
        reminder: { enabled: true, methods: { email: true }, timing: [0, 1] }, ...patch };
}

test('health is public, read-only, and does not fetch providers', async t => {
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider request'); });
    const response = await worker.fetch(new Request('https://worker.example.com/health'), {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await worker.fetch(new Request('https://worker.example.com/unknown'), {})).status, 404);
});

test('manual check is disabled without a token and rejects wrong methods and credentials', async t => {
    let calls = 0;
    t.mock.method(worker, 'handleScheduled', async () => { calls++; return { reminded: 0 }; });
    const url = 'https://worker.example.com/check';
    assert.equal((await worker.fetch(new Request(url, { method: 'POST' }), {})).status, 404);
    assert.equal((await worker.fetch(new Request(url), env)).status, 405);
    assert.equal((await worker.fetch(new Request(url, { method: 'POST' }), env)).status, 401);
    assert.equal((await worker.fetch(new Request(url, { method: 'POST',
        headers: { Authorization: 'Bearer wrong-token' } }), env)).status, 401);
    assert.equal(calls, 0);
    assert.equal((await worker.fetch(new Request(url, { method: 'POST',
        headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } }), env)).status, 200);
    assert.equal(calls, 1);
});

test('calendar days use the configured timezone, with invalid dates rejected', () => {
    assert.equal(calendarDay(now), calendarDay('2026-10-06'));
    assert.equal(calendarDay(now, 'America/New_York'), calendarDay('2026-10-05'));
    assert.equal(calendarDay('2026-10-06T09:00'), calendarDay('2026-10-06'));
    assert.ok(Number.isNaN(calendarDay('2026-02-30')));
    assert.ok(Number.isNaN(calendarDay('invalid-date')));
});

test('due reminders respect completed flags and configured dates', () => {
    const results = worker.findTasksNeedingReminder(data([
        task(), task({ id: 'done', completed: true }), task({ id: 'legacy-done', progress: 100 }),
        task({ id: 'off', reminder: { enabled: false } }), task({ id: 'invalid', endDate: 'invalid-date' })
    ]), now);
    assert.deepEqual(results.map(item => item.id), ['task-one']);
    assert.equal(results[0].daysUntilDue, 0);
});

test('overdue reminders require explicit email opt-in and observe the three-day interval', () => {
    const overdue = { endDate: '2026-10-01T09:00' };
    const results = worker.findOverdueTasksNeedingReminder(data([
        task(overdue), task({ ...overdue, id: 'done', completed: true }),
        task({ ...overdue, id: 'off', reminder: { enabled: false, methods: { email: true } } }),
        task({ ...overdue, id: 'browser-only', reminder: { enabled: true, methods: { browser: true } } }),
        task({ ...overdue, id: 'recent', lastOverdueReminderDate: '2026-10-04T00:00:00+08:00' }),
        task({ ...overdue, id: 'three-days', lastOverdueReminderDate: '2026-10-03T00:00:00+08:00' })
    ]), now);
    assert.deepEqual(results.map(item => item.id), ['task-one', 'three-days']);
});

test('missing service configuration skips all provider calls', async t => {
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider request'); });
    const results = await worker.handleScheduled({});
    assert.equal(results.reminded, 0);
    assert.ok(results.skipped);
});

test('scheduled handler delegates work to waitUntil', async t => {
    t.mock.method(worker, 'handleScheduled', async () => ({ reminded: 0 }));
    let pending;
    await worker.scheduled({}, {}, { waitUntil: promise => { pending = promise; } });
    assert.equal((await pending).reminded, 0);
});

test('email HTML escapes task text and provider errors do not expose response bodies', async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push(JSON.parse(init.body)); return Response.json({ id: 'test-message' });
    });
    const malicious = { ...task(), name: '<img src=x onerror=alert(1)>', projectName: '<b>Example</b>',
        notes: '"unsafe" <script>example()</script>', progress: '<script>progress()</script>', daysUntilDue: 0, daysOverdue: 3 };
    await worker.sendEmailReminder('you@example.com', malicious, env);
    await worker.sendOverdueReminder('you@example.com', malicious, env);
    for (const content of calls) {
        assert.ok(!content.html.includes('<img src=x'));
        assert.ok(!content.html.includes('<b>Example</b>'));
        assert.ok(content.html.includes('&lt;img'));
    }
    assert.ok(calls[0].html.includes('&lt;script&gt;'));
    assert.ok(!calls[0].html.includes('<script>'));
    t.mock.method(globalThis, 'fetch', async () => new Response('private-provider-detail', { status: 403 }));
    await assert.rejects(worker.sendEmailReminder('you@example.com', malicious, env), /HTTP 403$/);
});

test('user registry rejects non-array data and deduplicates bins', async t => {
    assert.deepEqual(await worker.getUserBins({ USER_BINS: ' one, two, one, ' }), ['one', 'two']);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ record: { binIds: 'invalid' } }));
    await assert.rejects(worker.getUserBins({ MASTER_BIN_ID: 'test-master' }), /数据格式无效/);
});
