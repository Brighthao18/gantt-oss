/**
 * 增强版导出功能模块
 *
 * 功能特性：
 * 1. 时间轴和表头合并在同一行
 * 2. 表头宽度自适应任务名称长度（60-200px）
 * 3. 时间刻度间隔一致且居中对齐
 * 4. 虚线网格更明显（1.5px粗度 + 对比色）
 * 5. 斜线表头（左上到右下）
 * 6. 支持6种样式主题
 *
 * index.html 在 app.js 之前加载此文件，UI.updateExportPreview 与 UI.doExport 调用 EnhancedExport.createCanvas。
 */

const EnhancedExport = {
    /**
     * 创建增强版导出画布
     * @param {Object} project - 项目对象
     * @param {string} size - 尺寸 ('a4-landscape', 'a4-portrait', 'mobile')
     * @param {string} version - 版本 ('simple', 'detailed')
     * @param {string} style - 样式 ('dark', 'light', 'academic', 'cyber', 'cartoon', 'festive')
     * @returns {HTMLCanvasElement} 导出画布
     */
    async createCanvas(project, size, version, style = 'dark') {
        // 样式配置
        const styleConfigs = {
            dark: {
                background: '#0f0f23',
                titleColor: '#f1f5f9',
                textColor: '#94a3b8',
                gridColor: '#334155',
                dashGridColor: '#475569',
                headerBg: '#1a1a2e',
                barBg: '#1e293b',
                font: 'Inter, sans-serif'
            },
            light: {
                background: '#ffffff',
                titleColor: '#1e293b',
                textColor: '#64748b',
                gridColor: '#cbd5e1',
                dashGridColor: '#94a3b8',
                headerBg: '#f8fafc',
                barBg: '#f1f5f9',
                font: 'Inter, sans-serif'
            },
            academic: {
                background: '#fefefe',
                titleColor: '#1a202c',
                textColor: '#4a5568',
                gridColor: '#e2e8f0',
                dashGridColor: '#a0aec0',
                headerBg: '#edf2f7',
                barBg: '#f7fafc',
                font: 'Georgia, serif',
                pattern: 'grid'
            },
            cyber: {
                background: '#000000',
                titleColor: '#00ff9f',
                textColor: '#00d9ff',
                gridColor: '#0a4d4d',
                dashGridColor: '#00ff9f',
                headerBg: '#0d1b2a',
                barBg: '#1a1a2a',
                font: 'Courier New, monospace',
                glow: true,
                pattern: 'circuit'
            },
            cartoon: {
                background: '#fff9e6',
                titleColor: '#ff6b6b',
                textColor: '#4a4a4a',
                gridColor: '#ffe0b2',
                dashGridColor: '#ff9800',
                headerBg: '#fff3cd',
                barBg: '#fffaeb',
                font: 'Comic Sans MS, cursive',
                roundedCorners: 12,
                pattern: 'dots'
            },
            festive: {
                background: '#fff5f5',
                titleColor: '#dc2626',
                textColor: '#991b1b',
                gridColor: '#fecaca',
                dashGridColor: '#f87171',
                headerBg: '#fee2e2',
                barBg: '#fef2f2',
                font: 'KaiTi, serif',
                pattern: 'lantern'
            }
        };

        const styleConfig = styleConfigs[style] || styleConfigs.dark;

        // 定义尺寸配置
        const sizeConfigs = {
            'a4-landscape': { width: 1123, height: 794 },
            'a4-portrait': { width: 794, height: 1123 },
            'mobile': { width: 375, height: 667 }
        };

        const config = sizeConfigs[size] || sizeConfigs['a4-landscape'];
        const canvas = document.createElement('canvas');
        canvas.width = config.width;
        canvas.height = config.height;

        const ctx = canvas.getContext('2d');

        // 布局配置
        const margins = { top: 20, bottom: 20, left: 20, right: 20 };
        const headerHeight = 60;
        const combinedHeaderHeight = 45; // 合并后的表头+时间轴高度
        const rowHeight = version === 'detailed' ? 35 : 30;
        const notesMaxWidth = canvas.width - (margins.left + 10) - margins.right - 30;

        // 任务较多或备注较长时加高画布，避免超出页面的任务和备注被截掉。
        // 高度按下方绘制使用的行高与间距计算；修改画布尺寸会重置绘图状态，因此在绘制前完成。
        const tasks = project.tasks || [];
        if (tasks.length > 0) {
            let contentBottom = margins.top + headerHeight + combinedHeaderHeight + 5 + tasks.length * rowHeight + 20;
            const tasksWithNotes = version === 'detailed' ? tasks.filter(t => t.notes && t.notes.trim()) : [];
            if (tasksWithNotes.length > 0) {
                ctx.font = `11px ${styleConfig.font}`;
                contentBottom += 45 + tasksWithNotes.reduce((sum, task) =>
                    sum + 28 + this.wrapText(ctx, task.notes, notesMaxWidth).length * 16, 0);
            }
            canvas.height = Math.max(config.height, Math.ceil(contentBottom + margins.bottom));
        }

        // 背景
        ctx.fillStyle = styleConfig.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 标题
        ctx.fillStyle = styleConfig.titleColor;
        ctx.font = `bold 24px ${styleConfig.font}`;
        ctx.fillText(project.name, margins.left + 10, margins.top + 30);

        // 日期
        ctx.fillStyle = styleConfig.textColor;
        ctx.font = `14px ${styleConfig.font}`;
        ctx.fillText(`导出时间: ${new Date().toLocaleString('zh-CN')}`, margins.left + 10, margins.top + 55);

        // 任务数据
        if (tasks.length === 0) {
            ctx.fillStyle = styleConfig.textColor;
            ctx.fillText('暂无任务', margins.left + 10, margins.top + headerHeight + 50);
            return canvas;
        }

        // 计算时间范围（精确匹配任务时间）
        const allDates = tasks.flatMap(t => [new Date(t.startDate), new Date(t.endDate)]);
        const minDate = new Date(Math.min(...allDates));
        const maxDate = new Date(Math.max(...allDates));

        // 设置时间为当天的开始和结束
        minDate.setHours(0, 0, 0, 0);
        maxDate.setHours(23, 59, 59, 999);

        const adjustedTotalDays = Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24)) + 1;

        // 计算布局位置
        const leftPadding = margins.left + 10;

        // 计算最长任务名称的宽度（自适应）
        ctx.font = `13px ${styleConfig.font}`;
        let maxTaskNameWidth = 60;
        tasks.forEach(task => {
            const nameWidth = ctx.measureText(task.name).width;
            maxTaskNameWidth = Math.max(maxTaskNameWidth, nameWidth + 30);
        });
        const taskNameWidth = Math.min(maxTaskNameWidth, 200);

        const barStartX = leftPadding + taskNameWidth + 20;
        const barMaxWidth = canvas.width - barStartX - margins.right - 10;

        let currentY = margins.top + headerHeight;

        // ===== 绘制合并的表头和时间轴（同一行） =====
        const tableHeaderY = currentY;
        const headerWidth = canvas.width - margins.left - margins.right - 20;

        // 表头背景
        ctx.fillStyle = styleConfig.headerBg;
        ctx.fillRect(leftPadding, tableHeaderY, headerWidth, combinedHeaderHeight);

        // 绘制任务名称区域的右侧边框
        ctx.strokeStyle = styleConfig.gridColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(leftPadding + taskNameWidth, tableHeaderY);
        ctx.lineTo(leftPadding + taskNameWidth, tableHeaderY + combinedHeaderHeight);
        ctx.stroke();

        // 绘制斜线分隔（从左上到右下）
        ctx.beginPath();
        ctx.moveTo(leftPadding, tableHeaderY);
        ctx.lineTo(leftPadding + taskNameWidth, tableHeaderY + combinedHeaderHeight);
        ctx.stroke();

        // 绘制"任务"和"日期"文字
        ctx.fillStyle = styleConfig.titleColor;
        ctx.font = `bold 12px ${styleConfig.font}`;
        ctx.fillText('任务', leftPadding + 10, tableHeaderY + combinedHeaderHeight - 8);
        ctx.fillText('日期', leftPadding + taskNameWidth - 40, tableHeaderY + 15);

        // 在同一行绘制时间刻度
        ctx.fillStyle = styleConfig.textColor;
        ctx.font = `10px ${styleConfig.font}`;

        // 根据天数决定刻度密度
        let tickInterval = 1;
        if (adjustedTotalDays > 90) tickInterval = 7;
        else if (adjustedTotalDays > 30) tickInterval = 3;

        // 计算每天的像素宽度
        const dayWidth = barMaxWidth / adjustedTotalDays;

        // 绘制时间刻度（日期居中显示在每天的中心位置）
        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        for (let i = 0; i < adjustedTotalDays; i += tickInterval) {
            const tickDate = new Date(minDate);
            tickDate.setDate(tickDate.getDate() + i);
            // 日期标签位于该天的中心位置
            const dayCenterX = barStartX + (i + 0.5) * dayWidth;

            // 日期文字（居中对齐在该天中心，包含星期几）
            const weekday = weekdays[tickDate.getDay()];
            const dateStr = `${tickDate.getMonth() + 1}/${tickDate.getDate()}`;
            const fullDateStr = `${dateStr}\n周${weekday}`;

            // 分两行显示：第一行日期，第二行星期
            const textWidth = ctx.measureText(dateStr).width;
            ctx.fillStyle = styleConfig.textColor;
            ctx.fillText(dateStr, dayCenterX - textWidth / 2, tableHeaderY + 22);

            // 绘制星期（稍小一点的字体）
            ctx.font = `9px ${styleConfig.font}`;
            const weekdayStr = `周${weekday}`;
            const weekdayWidth = ctx.measureText(weekdayStr).width;
            ctx.fillText(weekdayStr, dayCenterX - weekdayWidth / 2, tableHeaderY + 35);
            ctx.font = `10px ${styleConfig.font}`; // 恢复原字体大小
        }

        currentY += combinedHeaderHeight + 5;

        // ===== 绘制垂直网格线（双虚线框住每个日期） =====
        const tasksStartY = currentY;
        const tasksEndY = tasksStartY + tasks.length * rowHeight;

        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = styleConfig.dashGridColor || styleConfig.gridColor;
        ctx.lineWidth = 1;

        // 在每天的边界绘制单根虚线（包括首尾）
        for (let i = 0; i <= adjustedTotalDays; i += tickInterval) {
            const lineX = barStartX + i * dayWidth;
            ctx.beginPath();
            ctx.moveTo(lineX, tableHeaderY + combinedHeaderHeight);
            ctx.lineTo(lineX, tasksEndY);
            ctx.stroke();
        }

        ctx.setLineDash([]);

        // ===== 绘制每个任务 =====
        tasks.forEach((task, index) => {
            const y = tasksStartY + index * rowHeight;

            // 任务名称
            ctx.fillStyle = styleConfig.titleColor;
            ctx.font = `13px ${styleConfig.font}`;
            const displayName = task.name.length > 20 ? task.name.substring(0, 20) + '...' : task.name;
            ctx.fillText(displayName, leftPadding + 10, y + 20);

            // 计算条形位置
            const taskStart = new Date(task.startDate);
            const taskEnd = new Date(task.endDate);

            // 使用日期开始时间来精确计算天数差异，避免时间部分导致的偏差
            const taskStartDay = new Date(taskStart);
            taskStartDay.setHours(0, 0, 0, 0);
            const taskEndDay = new Date(taskEnd);
            taskEndDay.setHours(0, 0, 0, 0);
            const minDateDay = new Date(minDate);
            minDateDay.setHours(0, 0, 0, 0);

            const startOffset = Math.round((taskStartDay - minDateDay) / (1000 * 60 * 60 * 24));
            const duration = Math.round((taskEndDay - taskStartDay) / (1000 * 60 * 60 * 24)) + 1;

            // 任务条从第一天的左边界开始，到最后一天的右边界结束
            // 添加小边距避免直接接触虚线边界
            const barPadding = 3;
            const barX = barStartX + startOffset * dayWidth + barPadding;
            const barWidth = Math.max(duration * dayWidth - barPadding * 2, 20);

            // 绘制条形背景
            ctx.fillStyle = task.color || '#6366f1';
            ctx.beginPath();
            ctx.roundRect(barX, y + 5, barWidth, 20, 4);
            ctx.fill();

            // 绘制进度
            if (task.progress > 0) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
                ctx.beginPath();
                ctx.roundRect(barX, y + 5, barWidth * (task.progress / 100), 20, 4);
                ctx.fill();
            }
        });

        currentY = tasksStartY + tasks.length * rowHeight + 20;

        // ===== 详细版：在底部绘制备注区域 =====
        if (version === 'detailed') {
            const tasksWithNotes = tasks.filter(t => t.notes && t.notes.trim());

            if (tasksWithNotes.length > 0) {
                currentY += 20;

                // 备注标题
                ctx.fillStyle = styleConfig.titleColor;
                ctx.font = `bold 16px ${styleConfig.font}`;
                ctx.fillText('任务备注', leftPadding, currentY);

                currentY += 25;

                // 绘制每个任务的备注
                tasksWithNotes.forEach((task) => {
                    // 任务序号和名称
                    ctx.fillStyle = task.color || '#6366f1';
                    ctx.font = `bold 12px ${styleConfig.font}`;
                    const taskIndex = tasks.indexOf(task) + 1;
                    ctx.fillText(`${taskIndex}. ${task.name}`, leftPadding + 10, currentY);

                    currentY += 18;

                    // 备注内容（自动换行）
                    ctx.fillStyle = styleConfig.textColor;
                    ctx.font = `11px ${styleConfig.font}`;
                    for (const line of this.wrapText(ctx, task.notes, notesMaxWidth)) {
                        ctx.fillText(line, leftPadding + 20, currentY);
                        currentY += 16;
                    }

                    currentY += 10;
                });
            }
        }

        return canvas;
    },

    /**
     * 按字符换行（适用于中文），保留备注中的手动换行
     * @returns {string[]} 各行文本
     */
    wrapText(ctx, text, maxWidth) {
        const lines = [];
        for (const paragraph of String(text).split('\n')) {
            let line = '';
            for (const char of paragraph) {
                const testLine = line + char;
                if (ctx.measureText(testLine).width > maxWidth && line.length > 0) {
                    lines.push(line);
                    line = char;
                } else {
                    line = testLine;
                }
            }
            lines.push(line);
        }
        return lines;
    }
};

// 如果在浏览器环境中，将其暴露到全局
if (typeof window !== 'undefined') {
    window.EnhancedExport = EnhancedExport;
}

// 如果在 Node.js 环境中，导出模块
if (typeof module !== 'undefined' && module.exports) {
    module.exports = EnhancedExport;
}
