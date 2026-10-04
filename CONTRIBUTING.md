# 贡献指南 / Contributing

欢迎提交可复现的问题、文档改进和小范围功能修改。界面当前以中文为主，问题与代码审阅可以使用中文或英文。

## 提交问题

描述复现步骤、预期结果、实际结果、浏览器与 Node.js 版本。使用虚构数据；截图请遮盖邮箱、项目内容、密钥和 Bin ID。安全漏洞请遵循 [SECURITY.md](SECURITY.md)。

## 提交代码

1. Fork 仓库，创建描述用途的分支。
2. 执行 `npm ci`，使用 `npm start` 本地开发。
3. 保持前端无运行时依赖，尽量保留现有数据兼容性；不要把个人配置提交到代码中。
4. 执行 `npm run verify`；影响界面的修改另执行 `npm run build`、`npx playwright install chromium`、`npm run test:e2e`；影响 Worker 的修改另执行 `npm run worker:check`。
5. 创建 PR，说明用户可见的变化、验证结果与实际限制。

测试应验证行为或风险，例如档案隔离、模板转义与提醒开关。不要使用真实 API Key、连接生产数据或发送真实提醒进行测试。

使用 AI 辅助时，说明工具与辅助范围，由提交者独立复核代码、来源和测试结果。请勿向 AI 工具提供他人数据或凭据。贡献应为你有权提交的内容，按本仓库 MIT 许可证授权。

## English checklist

Use a focused branch, include reproduction steps, and validate the affected behavior. Run `npm run verify`, plus browser or Worker checks when applicable. Never commit personal configuration or use live recipients in tests. Disclose AI assistance and review the final code yourself. Contributions must be yours to submit and are licensed under this repository's MIT license.
