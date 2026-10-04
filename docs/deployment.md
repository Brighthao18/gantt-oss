# 部署指南

## 本地与静态网页

Node.js 22 或 24：

```sh
node scripts/serve.mjs
```

开发服务器只监听本机，提供公开资源并应用 `_headers` 中的安全头。若需要发布静态网页，执行 `npm ci` 和 `npm run build`，在托管服务选择 `dist/` 为发布目录。Cloudflare Pages 可读取 `_headers`；其他托管服务应配置同等响应头。

不要发布仓库根目录，也不要在公共演示浏览器中保存维护者 JSONBin Key。本地模式不需要部署 Worker。

## JSONBin 云端同步

在自己的 [JSONBin](https://jsonbin.io/) 账户获取 Key，在应用设置中配置。首次上传自动创建私有 Bin；已有 Bin 应填入正确 ID。手动下载会替换当前档案的本地记录，请先确认云端内容。

这是个人自托管模式，Key 在浏览器中可读。请使用独立账户或适当受限的访问权限。无需邮件时，不配置通知邮箱、主控 Bin 或 Worker。

## Cloudflare 邮件提醒 Worker

1. 在自己的 [Resend](https://resend.com/) 账户验证发件域名，获取发送密钥。
2. 准备自己的 JSONBin Key，以及需要提醒的用户 Bin ID 列表。
3. 安装项目依赖，并从无密钥模板创建本地配置。

PowerShell：

```powershell
npm ci
Copy-Item wrangler.example.jsonc wrangler.jsonc
Copy-Item .dev.vars.example .dev.vars
```

macOS / Linux：

```sh
npm ci
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
```

在 `wrangler.jsonc` 调整 Worker 名称与 Cron。在 `.dev.vars` 填写自己的配置，两个本地文件均被 Git 忽略：

| 变量 | 用途 |
| --- | --- |
| `JSONBIN_API_KEY` | Worker 读取和更新自己的 JSONBin 数据 |
| `RESEND_API_KEY` | 服务端发送邮件 |
| `FROM_EMAIL` | 已验证的发件地址 |
| `USER_BINS` | 需要提醒的 Bin ID，逗号分隔 |
| `MASTER_BIN_ID` | 可替代 `USER_BINS` 的主控 Bin；包含 `{ "binIds": [] }` 或 ID 数组 |
| `ADMIN_TOKEN` | 可选，启用手动检查的管理令牌；留空则关闭接口 |
| `REMINDER_TIMEZONE` | IANA 时区，默认 `Asia/Shanghai` |

`USER_BINS` 非空时优先于 `MASTER_BIN_ID`。多个使用者应由部署者在服务器端管理列表；共享浏览器 Key 不能实现安全的团队权限分隔。主控列表采用整条记录读写，并发注册可能相互覆盖。

本地编译检查不会调用云端服务：

```sh
npm run worker:check
```

`npm run worker:dev` 会加载你的 `.dev.vars`。`GET /health` 是只读健康检查；测试邮件行为请使用本仓库的测试替身，避免向真实收件人发送。

## 发布 Worker

以下步骤会修改自己的 Cloudflare 账户并可能产生服务费用，请由部署者执行。不要在 Wrangler 的普通 `vars` 中放密钥。

```sh
npx wrangler login
npm run worker:deploy
npx wrangler secret put JSONBIN_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put FROM_EMAIL
npx wrangler secret put USER_BINS
```

使用主控 Bin 时可设置 `MASTER_BIN_ID` 替代 `USER_BINS`。需要手动触发时，再通过 `npx wrangler secret put ADMIN_TOKEN` 设置一个长随机令牌。Wrangler 的 secret put 通过交互输入，避免把凭据放在命令参数和终端历史中。

默认 Cron 为 `0 0 * * *`，即 UTC 00:00、上海与新加坡时间 08:00。Cron 和 Worker 的日历时区是两个设置，调整其中一个时应核对另一个。

手动检查仅支持 `POST /check`，请求头为 `Authorization: Bearer <管理员令牌>`。它会实际检查并发送所有符合条件的提醒，不应作为公共按钮或无成本健康检查。未配置令牌返回 404；错误方式返回 405；缺少或错误令牌返回 401。

## 迁移既有部署

旧的公开 `GET /check` 已停用。检查现有调用方并使用带鉴权的 POST，或者保持手动接口关闭。旧浏览器全局配置会迁移至当前档案，其他档案需重新配置。

本次源代码发布未部署到维护者的 Cloudflare 账户，也未发送真实邮件。自己的生产部署应确认收件人、服务权限和提供商日志。此前暴露过的密钥需要在提供商侧撤销或轮换；改用 secrets 不能撤销旧密钥。

参考：[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[JSONBin 创建 Bin](https://jsonbin.io/api-reference/bins/create)。
