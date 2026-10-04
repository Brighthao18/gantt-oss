# Project instructions

This repository is a Chinese-language, local-first Gantt planner. Keep changes focused on the requested behavior.

- Keep the browser app in plain HTML/CSS/JavaScript with no runtime dependencies unless the task explicitly requires them.
- Preserve the `gantt_data_<profile>` storage format and completed/progress compatibility. Explain migrations and avoid deleting user data.
- Local profile names are not authentication. Do not imply server-side access control.
- Keep credentials in ignored local files or service secret bindings. Never read or publish `.dev.vars`, `wrangler.jsonc`, personal email scripts, local backups, or provider caches as source artifacts.
- Use `scripts/project-files.mjs` as the public source and static asset allowlists. Update the allowlist when adding a public file.
- Do not deploy, send email, access real user bins, or submit third-party applications as part of a test.
- Use fictional data and mock external requests. Escape dynamic HTML text and attributes; do not allow raw data in inline styles.
- Run `npm run verify`. For interface changes, build and run `npm run test:e2e`. For Worker changes, run `npm run worker:check`.
- State actual checks, remaining limitations, and AI assistance in contribution notes. Do not describe pattern checks as a full security audit.
