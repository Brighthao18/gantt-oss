import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../api.js', import.meta.url), 'utf8');
function setup(initial = {}, fetch = async () => { throw new Error('Unexpected network request'); }) {
    const values = new Map(Object.entries(initial));
    const localStorage = { getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(String(key), String(value)), removeItem: key => values.delete(key) };
    const context = vm.createContext({ localStorage, fetch, console: { log() {}, error() {} } });
    vm.runInContext(`${source}\nglobalThis.api = CloudAPI;`, context);
    return { api: context.api, values, localStorage };
}

test('unconfigured sync remains local and performs no request', async () => {
    const { api } = setup();
    const data = { projects: [], lastModified: 1 };
    const result = await api.syncData(data);
    assert.equal(result.synced, false);
    assert.equal(result.data, data);
});

test('legacy settings migrate once to the active profile, without sharing keys', () => {
    const { api, values, localStorage } = setup({ gantt_current_user: '张同学',
        jsonbin_api_key: 'test-key', notification_email: 'you@example.com', master_bin_id: 'test-master' });
    assert.equal(api.apiKey, 'test-key');
    assert.equal(values.has('jsonbin_api_key'), false);
    assert.equal(api.getProfileSetting('notification_email'), 'you@example.com');
    localStorage.setItem('gantt_current_user', '李同学'); api.init();
    assert.equal(api.apiKey, null);
    assert.equal(api.getProfileSetting('notification_email'), null);
    assert.equal(api.getProfileSetting('master_bin_id'), null);
    localStorage.setItem('gantt_current_user', '张同学'); api.init();
    assert.equal(api.apiKey, 'test-key');
});

test('saveConfig can disable sync and clear an old bin selection', () => {
    const { api, values } = setup({ gantt_current_user: 'test-profile' });
    api.saveConfig('test-key', 'test-bin');
    assert.equal(api.isConfigured(), true);
    api.saveConfig('', null);
    assert.equal(api.isConfigured(), false);
    assert.equal(values.has('jsonbin_bin_id_test-profile'), false);
});

test('new bins are private and use ASCII metadata for Chinese profiles', async () => {
    let captured;
    const { api } = setup({ gantt_current_user: '张同学' }, async (url, init) => {
        captured = { url, init };
        return Response.json({ metadata: { id: 'test-bin' } });
    });
    api.saveConfig('test-key');
    await api.createBin({ projects: [] });
    assert.equal(captured.init.headers['X-Bin-Private'], 'true');
    assert.match(captured.init.headers['X-Bin-Name'], /^[\x20-\x7e]+$/);
    assert.equal(api.binId, 'test-bin');
});

test('an in-flight bin creation stores the result in the initiating profile', async () => {
    let finish;
    const { api, localStorage, values } = setup({ gantt_current_user: 'profile-one' },
        () => new Promise(resolve => { finish = resolve; }));
    api.saveConfig('test-key');
    const pending = api.createBin({ projects: [] });
    localStorage.setItem('gantt_current_user', 'profile-two'); api.init();
    finish(Response.json({ metadata: { id: 'test-bin' } })); await pending;
    assert.equal(values.get('jsonbin_bin_id_profile-one'), 'test-bin');
    assert.equal(values.has('jsonbin_bin_id_profile-two'), false);
    assert.equal(api.binId, null);
});

test('failed master registry reads never overwrite the registry with an empty list', async () => {
    const calls = [];
    const { api } = setup({ gantt_current_user: 'profile-one' }, async (url, init) => {
        calls.push(init.method || 'GET'); return new Response('', { status: 403 });
    });
    api.saveConfig('test-key', 'test-bin');
    api.saveProfileSetting('master_bin_id', 'test-master');
    await api.registerToMasterBin();
    assert.deepEqual(calls, ['GET']);
});

test('malformed downloaded records are rejected before local data can be replaced', async () => {
    const { api } = setup({ gantt_current_user: 'profile-one' },
        async () => Response.json({ record: { projects: 'invalid' } }));
    api.saveConfig('test-key', 'test-bin');
    await assert.rejects(api.readData(), /数据格式无效/);
    assert.throws(() => api.validateData({ projects: [{ id: 'p', name: 'Project', tasks: [{
        id: 't', name: 'Task', startDate: 'invalid', endDate: '2026-10-06'
    }] }] }), /任务数据格式无效/);
});

test('well-formed legacy completed tasks are accepted without migration', () => {
    const { api } = setup();
    const legacy = { projects: [{ id: 'p', name: 'Project', tasks: [{
        id: 't', name: 'Task', startDate: '2026-10-05', endDate: '2026-10-06', progress: 100
    }] }] };
    assert.equal(api.validateData(legacy), legacy);
});
