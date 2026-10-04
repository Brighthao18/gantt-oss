import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const STATIC_FILES = ['index.html', 'styles.css', 'api.js', 'app.js', 'export-enhanced.js', '_headers'];
export const ROOT_FILES = [...STATIC_FILES, 'worker.js', '.gitignore', '.gitattributes',
    'package.json', 'package-lock.json', 'wrangler.example.jsonc', '.dev.vars.example', 'playwright.config.mjs',
    'README.md', 'README.en.md', 'LICENSE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
    'AGENTS.md', 'CHANGELOG.md', 'CLOUDFLARE_SETUP_GUIDE.md'];
export const SOURCE_DIRS = ['scripts', 'tests', 'docs', '.github'];

export async function publicFiles() {
    const files = [...ROOT_FILES];
    async function walk(dir) {
        for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw new Error(`Source symlinks are not allowed: ${dir}/${entry.name}`);
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) await walk(path);
            else if (entry.isFile()) files.push(path);
        }
    }
    for (const dir of SOURCE_DIRS) await walk(dir);
    return files.sort();
}
