import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../export-enhanced.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(`${source}\nglobalThis.exporter = EnhancedExport;`, context);
// Every character is 10px wide in this measuring stub.
const ctx = { measureText: text => ({ width: [...text].length * 10 }) };

test('export notes wrap by character and keep manual line breaks', () => {
    assert.deepEqual([...context.exporter.wrapText(ctx, '第一行内容较长\n第二行', 30)], ['第一行', '内容较', '长', '第二行']);
    assert.deepEqual([...context.exporter.wrapText(ctx, 'ab', 30)], ['ab']);
});
