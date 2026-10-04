# Gantt OSS

[中文](README.md) · [MIT](LICENSE) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

A lightweight, local-first Gantt planner for coursework, research, and personal projects. The interface is in Chinese. The browser app uses plain HTML, CSS, and JavaScript with no runtime dependencies. JSONBin cloud sync and Cloudflare Workers / Resend email reminders are optional.

![Gantt overview with fictional sample data](docs/images/overview.png)

## Features

- Projects and tasks with dates, notes, colors, completion, and recurring tasks.
- Daily, weekly, monthly, and cross-project summary views.
- PNG exports with multiple sizes and six visual themes.
- Separate local profiles and optional per-profile cloud sync settings.
- Optional due-date and overdue email reminders.

Local profile names select browser storage; they do not authenticate users or protect data from another person using the same browser. Team deployments need server-side authentication and authorization.

## Run locally

Use Node.js 22 or 24:

```sh
git clone https://github.com/Brighthao18/gantt-oss.git
cd gantt-oss
node scripts/serve.mjs
```

Open <http://127.0.0.1:4173>. No npm install, account, or API key is required for local use. Storage belongs to the browser and website origin. Clearing site data or changing origin can make it unavailable. PNG exports are not recoverable data backups.

## Contribute and verify

```sh
npm ci
npm run verify
npx playwright install chromium
npm run test:e2e
npm run worker:check
```

Tests use synthetic data and mocked provider requests. They do not send real emails. `npm run build` copies only public browser assets into `dist/`; use that directory for static hosting.

See [deployment](docs/deployment.md), [architecture](docs/architecture.md), [privacy](docs/privacy.md), and [contribution guidelines](CONTRIBUTING.md). All frontend JSONBin credentials stay in the selected browser profile; do not use this personal sync model as a shared service. Worker secrets belong in Cloudflare secret bindings. Manual `POST /check` is disabled unless an admin token is configured, and then requires bearer authorization.

The source is MIT licensed. Third-party services and development dependencies retain their own terms and licenses. [Codex for OSS notes](docs/codex-for-oss.md) describe application preparation; no program acceptance is claimed.
