import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, publicFiles } from './project-files.mjs';

const patterns = [
    ['JSONBin key', /\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}/],
    ['service token', /\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|re_)[A-Za-z0-9_-]{20,}\b/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['Cloudflare deployment metadata', /(?:"account_id"|"api_token")\s*:\s*"[^"\s]+"/]
];
let failed = false;
const files = await publicFiles();
for (const name of files) {
    const content = await readFile(join(ROOT, name));
    if (name.endsWith('.png')) continue;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    if (text.includes('\uFFFD') || text.includes('\0')) throw new Error(`Invalid text encoding: ${name}`);
    for (const [label, pattern] of patterns) {
        if (pattern.test(text)) { console.error(`Possible ${label} in ${name} (value hidden).`); failed = true; }
    }
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
    if (emails.some(email => !/(?:@example\.(?:com|org|net)|@users\.noreply\.github\.com)$/.test(email))) {
        console.error(`Non-example email in ${name} (value hidden).`); failed = true;
    }
    if (/\.m?js$/.test(name)) {
        const result = spawnSync(process.execPath, ['--check', join(ROOT, name)], { encoding: 'utf8' });
        if (result.status !== 0) { console.error(result.stderr); failed = true; }
    }
    if (name.endsWith('.json')) JSON.parse(text);
}
const config = JSON.parse(await readFile(join(ROOT, 'wrangler.example.jsonc'), 'utf8'));
if (['JSONBIN_API_KEY', 'RESEND_API_KEY', 'ADMIN_TOKEN'].some(key => key in (config.vars || {}))) {
    console.error('Secret bindings must not be in wrangler vars.'); failed = true;
}
if (failed) process.exitCode = 1;
else console.log(`Checked ${files.length} public source files: syntax, UTF-8, and credential patterns.`);
