# 安全说明 / Security

当前维护版本为 `1.x`。安全报告通过 [GitHub 私密漏洞报告](https://github.com/Brighthao18/gantt-oss/security/advisories/new) 提交。请描述受影响版本、最小复现、影响与可行修复，使用虚构数据。请勿公开有效密钥、用户邮箱或原始项目数据。

## 使用边界

- 本地档案名不是身份验证。同一浏览器的使用者与同源脚本可以读取其 localStorage；它不适合作为共享多用户服务的权限边界。
- 浏览器 JSONBin Key 可访问该 Key 被授予的云端数据。仅使用自己的可信设备与独立服务账户，不在共享演示中配置维护者密钥。
- 提醒 Worker 使用服务端 secret bindings。`POST /check` 默认关闭，配置 `ADMIN_TOKEN` 后须使用 Bearer 令牌。不要将管理员令牌放在网址或前端中。
- 仅向主动配置邮件提醒的接收人发送邮件。关闭任务提醒或邮件方式后，到期与过期邮件均停止。
- Cron 建议每天运行一次。到期提醒尚无持久化幂等记录，重复手动触发或并发 Cron 可能重复发送。过期提醒记录三天间隔；并发读写仍可能发生冲突。
- JSONBin 的同步与主控列表更新使用整条记录覆盖，不提供多人协同冲突处理。部署者应自行确定账户权限、备份与费用限制。
- `npm run check` 检查已知敏感信息模式，不能发现所有秘密；发布前仍需人工检查变更。自动测试与依赖审计不等同于完整安全审计。

## 维护者处理

核对报告并在私密渠道讨论；在修复与验证完成后发布更新，协商披露时间。如果发现密钥泄露，应先在服务提供商撤销或轮换密钥。仅从代码中删除密钥不能使其失效。

Report privately through GitHub. Version `1.x` is maintained. Local profiles are storage selectors, not authenticated accounts. Never deploy a shared service with a browser-visible maintainer key. Manual reminder execution requires a server-side admin token. Duplicate or concurrent reminder runs and whole-record cloud sync have the limitations described above.
