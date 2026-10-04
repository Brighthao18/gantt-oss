import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, STATIC_FILES } from './project-files.mjs';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg === -1 ? 4173 : Number(args[portArg + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
const root = args.includes('--dist') ? join(ROOT, 'dist') : ROOT;
const headerLines = (await readFile(join(root, '_headers'), 'utf8')).split(/\r?\n/);
const headers = Object.fromEntries(headerLines.filter(line => /^\s+[^:]+:/.test(line)).map(line => {
    const index = line.indexOf(':');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}));
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!STATIC_FILES.includes(name) || name === '_headers') { res.writeHead(404); res.end(); return; }
    try {
        const body = await readFile(join(root, name));
        const ext = name.slice(name.lastIndexOf('.'));
        res.writeHead(200, { 'Content-Type': `${mime[ext] || 'application/octet-stream'}; charset=utf-8` });
        res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404); res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Gantt: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
