import { copyFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, STATIC_FILES } from './project-files.mjs';

const output = join(ROOT, 'dist');
await mkdir(output, { recursive: true });
// Refuse an unexpected output tree rather than deploy private leftovers.
for (const entry of await readdir(output)) {
    if (!STATIC_FILES.includes(entry) || !(await lstat(join(output, entry))).isFile()) {
        throw new Error(`Unexpected dist entry: ${entry}. Remove it from this generated directory before building.`);
    }
}
for (const name of STATIC_FILES) await copyFile(join(ROOT, name), join(output, name));
console.log(`Built ${STATIC_FILES.length} public browser assets in dist/.`);
