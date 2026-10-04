/**
 * Cloudflare Worker - 甘特图任务提醒邮件服务
 *
 * 功能：
 * - 每天定时检查所有用户的任务
 * - 根据任务的提醒设置发送邮件通知
 * - 使用 Resend API 发送邮件
 *
 * 环境变量配置（在 Cloudflare Dashboard 设置）：
 * - JSONBIN_API_KEY: JSONBin.io 的 API Key
 * - RESEND_API_KEY: Resend.com 的 API Key
 * - FROM_EMAIL: 发送邮件的地址（需要在 Resend 验证）
 *
 * Cron 触发器设置：
 * - 推荐: 0 0 * * * (每天 UTC 00:00，即北京时间 08:00)
 */

const DAY_MS = 86400000;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

// Datetime-local values are wall dates in the configured timezone. ISO values
// with an offset are converted to that timezone before comparing calendar days.
export function calendarDay(value, timeZone = 'Asia/Shanghai') {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(value)) {
        const [year, month, day] = value.slice(0, 10).split('-').map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
        return date.getTime() / DAY_MS;
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return NaN;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day)) / DAY_MS;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', ...extraHeaders }
    });
}

async function isAuthorized(request, token) {
    const header = request.headers.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) return false;
    const encode = value => new TextEncoder().encode(value);
    const [expected, received] = await Promise.all([
        crypto.subtle.digest('SHA-256', encode(token)),
        crypto.subtle.digest('SHA-256', encode(header.slice(7)))
    ]);
    const a = new Uint8Array(expected);
    const b = new Uint8Array(received);
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    return difference === 0;
}

export default {
    // 定时任务触发器
    async scheduled(event, env, ctx) {
        ctx.waitUntil(this.handleScheduled(env));
    },

    // 手动触发必须使用管理员令牌；不配置令牌时关闭此接口。
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/check') {
            if (!env.ADMIN_TOKEN) return jsonResponse({ error: 'Not found' }, 404);
            if (request.method !== 'POST') return jsonResponse({ error: 'Use POST' }, 405, { Allow: 'POST' });
            if (!await isAuthorized(request, env.ADMIN_TOKEN)) {
                return jsonResponse({ error: 'Unauthorized' }, 401);
            }
            const result = await this.handleScheduled(env);
            return jsonResponse(result);
        }

        // 健康检查
        if (url.pathname === '/health') {
            if (request.method !== 'GET') return jsonResponse({ error: 'Use GET' }, 405, { Allow: 'GET' });
            return jsonResponse({
                status: 'ok',
                time: new Date().toISOString()
            });
        }

        return jsonResponse({ error: 'Not found' }, 404);
    },

    // 主处理逻辑
    async handleScheduled(env) {
        console.log('开始检查任务提醒...');

        const results = {
            checked: 0,
            reminded: 0,
            overdueReminded: 0,
            errors: [],
            time: new Date().toISOString()
        };

        if (!env.JSONBIN_API_KEY || !env.RESEND_API_KEY || !env.FROM_EMAIL) {
            return { ...results, skipped: 'Reminder service is not configured' };
        }

        try {
            // 获取所有需要检查的 Bin IDs
            const userBins = await this.getUserBins(env);

            for (const binId of userBins) {
                try {
                    const userData = await this.fetchUserData(binId, env);
                    if (!userData || !userData.projects) continue;

                    // 从用户数据中获取通知邮箱
                    const email = userData.notificationEmail;
                    if (!email) {
                        console.log(`Bin ${binId} 没有设置通知邮箱，跳过`);
                        continue;
                    }

                    // 检查即将到期的任务
                    const now = new Date();
                    const timeZone = env.REMINDER_TIMEZONE || 'Asia/Shanghai';
                    const tasksToRemind = this.findTasksNeedingReminder(userData, now, timeZone);
                    results.checked += tasksToRemind.length;

                    for (const task of tasksToRemind) {
                        if (task.reminder?.methods?.email) {
                            await this.sendEmailReminder(email, task, env);
                            results.reminded++;
                        }
                    }

                    // 检查过期任务（每3天提醒一次）
                    const overdueTasks = this.findOverdueTasksNeedingReminder(userData, now, timeZone);
                    let needsUpdate = false;

                    for (const overdueTask of overdueTasks) {
                        await this.sendOverdueReminder(email, overdueTask, env);
                        results.overdueReminded++;

                        // 更新最后提醒时间
                        const project = userData.projects.find(p => p.id === overdueTask.projectId);
                        if (project) {
                            const task = project.tasks.find(t => t.id === overdueTask.id);
                            if (task) {
                                task.lastOverdueReminderDate = new Date().toISOString();
                                needsUpdate = true;
                            }
                        }
                    }

                    // 如果有更新，保存回 JSONBin
                    if (needsUpdate) {
                        await this.updateUserData(binId, userData, env);
                    }
                } catch (error) {
                    results.errors.push({ binId, error: error.message });
                }
            }
        } catch (error) {
            results.errors.push({ general: error.message });
        }

        console.log('检查完成:', { checked: results.checked, reminded: results.reminded,
            overdueReminded: results.overdueReminded, errors: results.errors.length });
        return results;
    },

    // 获取用户 Bin 列表
    // 只需要 Bin ID，邮箱会从用户数据中读取
    async getUserBins(env) {
        // 方式1：从环境变量读取（逗号分隔的 Bin ID 列表）
        // 例如：USER_BINS = "binId1,binId2,binId3"
        if (env.USER_BINS) {
            return [...new Set(env.USER_BINS.split(',').map(id => id.trim()).filter(Boolean))];
        }

        // 方式2：从主控 Bin 读取用户 Bin ID 列表
        if (env.MASTER_BIN_ID) {
            const response = await fetch(`https://api.jsonbin.io/v3/b/${env.MASTER_BIN_ID}/latest`, {
                headers: {
                    'X-Master-Key': env.JSONBIN_API_KEY
                }
            });

            if (response.ok) {
                const data = await response.json();
                // 支持两种格式：数组或对象 { binIds: [...] }
                const bins = data.record?.binIds || data.record;
                if (!Array.isArray(bins) || bins.some(id => typeof id !== 'string')) {
                    throw new Error('主控 Bin 数据格式无效');
                }
                return [...new Set(bins.map(id => id.trim()).filter(Boolean))];
            }
            throw new Error(`读取主控 Bin 失败: ${response.status}`);
        }

        // 默认返回空数组
        return [];
    },

    // 从 JSONBin 获取用户数据
    async fetchUserData(binId, env) {
        const response = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
            headers: {
                'X-Master-Key': env.JSONBIN_API_KEY
            }
        });

        if (!response.ok) {
            throw new Error(`获取数据失败: ${response.status}`);
        }

        const data = await response.json();
        return data.record;
    },

    // 查找需要提醒的任务
    findTasksNeedingReminder(userData, now = new Date(), timeZone = 'Asia/Shanghai') {
        const tasksToRemind = [];
        const today = calendarDay(now, timeZone);

        for (const project of userData.projects || []) {
            for (const task of project.tasks || []) {
                // 跳过已完成的任务
                if (task.completed === true || task.progress === 100) continue;

                // 跳过没有启用提醒的任务
                if (!task.reminder?.enabled) continue;

                const daysUntilDue = calendarDay(task.endDate, timeZone) - today;
                if (!Number.isFinite(daysUntilDue)) continue;

                // 检查是否在提醒时间内
                const timings = task.reminder.timing || [1];
                if (timings.includes(daysUntilDue)) {
                    tasksToRemind.push({
                        ...task,
                        projectName: project.name,
                        daysUntilDue
                    });
                }
            }
        }

        return tasksToRemind;
    },

    // 查找需要过期提醒的任务（每3天提醒一次）
    findOverdueTasksNeedingReminder(userData, now = new Date(), timeZone = 'Asia/Shanghai') {
        const overdueTasks = [];
        const today = calendarDay(now, timeZone);
        const REMINDER_INTERVAL_DAYS = 3;

        for (const project of userData.projects || []) {
            for (const task of project.tasks || []) {
                // 跳过已完成的任务
                if (task.completed === true || task.progress === 100) continue;
                if (!task.reminder?.enabled || !task.reminder?.methods?.email) continue;

                const endDate = calendarDay(task.endDate, timeZone);

                // 检查是否过期
                if (!Number.isFinite(endDate) || endDate >= today) continue;

                // 计算距离上次提醒的天数
                let shouldRemind = false;
                if (task.lastOverdueReminderDate) {
                    const lastReminder = calendarDay(task.lastOverdueReminderDate, timeZone);
                    const daysSinceLastReminder = today - lastReminder;
                    shouldRemind = daysSinceLastReminder >= REMINDER_INTERVAL_DAYS;
                } else {
                    // 从未发送过过期提醒，需要发送
                    shouldRemind = true;
                }

                if (shouldRemind) {
                    const daysOverdue = today - endDate;
                    overdueTasks.push({
                        ...task,
                        projectId: project.id,
                        projectName: project.name,
                        daysOverdue
                    });
                }
            }
        }

        return overdueTasks;
    },

    // 更新用户数据到 JSONBin
    async updateUserData(binId, userData, env) {
        const response = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': env.JSONBIN_API_KEY
            },
            body: JSON.stringify(userData)
        });

        if (!response.ok) {
            throw new Error(`更新数据失败: ${response.status}`);
        }

        console.log(`已更新 Bin ${binId} 的过期提醒时间`);
    },

    // 发送邮件提醒
    async sendEmailReminder(toEmail, task, env) {
        if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
            console.log('邮件配置未完成，跳过发送');
            return;
        }

        const dueText = task.daysUntilDue === 0 ? '今天到期' :
            task.daysUntilDue === 1 ? '明天到期' :
                `${task.daysUntilDue} 天后到期`;

        // 格式化截止日期
        const endDate = new Date(calendarDay(task.endDate, env.REMINDER_TIMEZONE || 'Asia/Shanghai') * DAY_MS);
        const formattedDate = endDate.toLocaleDateString('zh-CN', {
            timeZone: 'UTC',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long'
        });

        // 纯文本版本（Gmail更喜欢同时有HTML和纯文本）
        const textContent = `
任务提醒

任务名称: ${task.name}
项目: ${task.projectName}
截止时间: ${formattedDate} (${dueText})
当前进度: ${Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress)) : 0}%
${task.notes ? `\n备注: ${task.notes}\n` : ''}

---
这是您在甘特图项目管理系统中设置的自动提醒。
您可以随时在应用中修改或关闭提醒设置。

如果您不想再收到此类提醒，请登录应用关闭任务提醒功能。
        `.trim();

        const emailContent = {
            // 添加发件人名称，使邮件更可信
            from: `甘特图任务提醒 <${env.FROM_EMAIL}>`,
            to: toEmail,
            // 优化主题行，更清晰专业
            subject: `任务提醒: ${task.name} - ${dueText}`,
            // 纯文本版本
            text: textContent,
            // HTML版本 - 简化样式，避免被识别为垃圾邮件
            html: `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>任务提醒</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 20px 0;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <tr>
                        <td style="background-color: #4f46e5; padding: 30px; text-align: center;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">📋 任务提醒</h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 30px;">
                            <!-- Task Info -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                                <tr>
                                    <td style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; border-left: 4px solid #4f46e5;">
                                        <h2 style="margin: 0 0 10px 0; color: #1f2937; font-size: 18px;">${escapeHtml(task.name)}</h2>
                                        <p style="margin: 0; color: #6b7280; font-size: 14px;">项目: ${escapeHtml(task.projectName)}</p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Details -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                                <tr>
                                    <td width="48%" style="background-color: #fef3c7; padding: 15px; border-radius: 6px; vertical-align: top;">
                                        <p style="margin: 0 0 5px 0; color: #92400e; font-size: 12px; font-weight: 600;">截止时间</p>
                                        <p style="margin: 0; color: #78350f; font-size: 16px; font-weight: 700;">${dueText}</p>
                                        <p style="margin: 5px 0 0 0; color: #92400e; font-size: 12px;">${formattedDate}</p>
                                    </td>
                                    <td width="4%"></td>
                                    <td width="48%" style="background-color: #d1fae5; padding: 15px; border-radius: 6px; vertical-align: top;">
                                        <p style="margin: 0 0 5px 0; color: #065f46; font-size: 12px; font-weight: 600;">当前进度</p>
                                        <p style="margin: 0; color: #047857; font-size: 16px; font-weight: 700;">${Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress)) : 0}%</p>
                                    </td>
                                </tr>
                            </table>

                            ${task.notes ? `
                            <!-- Notes -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                                <tr>
                                    <td style="background-color: #f8f9fa; padding: 15px; border-radius: 6px;">
                                        <p style="margin: 0 0 5px 0; color: #6b7280; font-size: 12px; font-weight: 600;">备注</p>
                                        <p style="margin: 0; color: #374151; font-size: 14px; line-height: 1.5;">${escapeHtml(task.notes)}</p>
                                    </td>
                                </tr>
                            </table>
                            ` : ''}
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
                            <p style="margin: 0 0 10px 0; color: #6b7280; font-size: 12px; line-height: 1.6;">
                                这是您在甘特图项目管理系统中设置的自动提醒<br>
                                您可以随时在应用中修改或关闭提醒设置
                            </p>
                            <p style="margin: 0; color: #9ca3af; font-size: 11px;">
                                如果您不想再收到此类提醒，请登录应用关闭任务提醒功能
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
            `.trim()
        };

        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(emailContent)
        });

        if (!response.ok) {
            throw new Error(`发送邮件失败: HTTP ${response.status}`);
        }

        console.log('到期提醒邮件已发送');
    },

    // 发送过期任务提醒邮件
    async sendOverdueReminder(toEmail, task, env) {
        if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
            console.log('邮件配置未完成，跳过发送');
            return;
        }

        const overdueText = task.daysOverdue === 1 ? '已过期1天' : `已过期${task.daysOverdue}天`;

        // 格式化截止日期
        const endDate = new Date(calendarDay(task.endDate, env.REMINDER_TIMEZONE || 'Asia/Shanghai') * DAY_MS);
        const formattedDate = endDate.toLocaleDateString('zh-CN', {
            timeZone: 'UTC',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long'
        });

        const textContent = `
⚠️ 任务过期提醒

任务名称: ${task.name}
项目: ${task.projectName}
原截止时间: ${formattedDate}
状态: ${overdueText}

请登录系统处理此任务：
- 延长任务期限
- 或标记为已完成

---
这是自动过期提醒邮件，每3天发送一次直到任务被处理。
        `.trim();

        const emailContent = {
            from: `甘特图任务提醒 <${env.FROM_EMAIL}>`,
            to: toEmail,
            subject: `⚠️ 任务过期: ${task.name} - ${overdueText}`,
            text: textContent,
            html: `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>任务过期提醒</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 20px 0;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <tr>
                        <td style="background-color: #ef4444; padding: 30px; text-align: center;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">⚠️ 任务过期提醒</h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 30px;">
                            <!-- Task Info -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                                <tr>
                                    <td style="background-color: #fef2f2; padding: 20px; border-radius: 6px; border-left: 4px solid #ef4444;">
                                        <h2 style="margin: 0 0 10px 0; color: #1f2937; font-size: 18px;">${escapeHtml(task.name)}</h2>
                                        <p style="margin: 0; color: #6b7280; font-size: 14px;">项目: ${escapeHtml(task.projectName)}</p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Overdue Info -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                                <tr>
                                    <td style="background-color: #fee2e2; padding: 20px; border-radius: 6px; text-align: center;">
                                        <p style="margin: 0 0 5px 0; color: #991b1b; font-size: 14px; font-weight: 600;">任务状态</p>
                                        <p style="margin: 0; color: #dc2626; font-size: 24px; font-weight: 700;">${overdueText}</p>
                                        <p style="margin: 10px 0 0 0; color: #991b1b; font-size: 12px;">原截止时间: ${formattedDate}</p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Action Prompt -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                                <tr>
                                    <td style="background-color: #f3f4f6; padding: 20px; border-radius: 6px; text-align: center;">
                                        <p style="margin: 0 0 10px 0; color: #374151; font-size: 14px;">请登录系统处理此任务：</p>
                                        <p style="margin: 0; color: #6b7280; font-size: 13px;">
                                            • 延长任务期限<br>
                                            • 或标记为已完成
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
                            <p style="margin: 0; color: #9ca3af; font-size: 11px;">
                                这是自动过期提醒邮件，每3天发送一次直到任务被处理
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
            `.trim()
        };

        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(emailContent)
        });

        if (!response.ok) {
            throw new Error(`发送过期提醒邮件失败: HTTP ${response.status}`);
        }

        console.log('过期提醒邮件已发送');
    }
};
