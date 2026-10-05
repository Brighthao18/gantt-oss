/**
 * 研究生项目管理 - 甘特图应用
 * 核心逻辑模块
 */

// ==========================================
// 日期工具
// ==========================================

const DateUtils = {
    // 任务日期按 datetime-local 本地墙钟字符串保存。仅含日期的旧值按本地午夜解析
    // （new Date 会将其视为 UTC）；带时区的 ISO 值按其表示的时刻解析。
    parse(value) {
        const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (!match) return new Date(value);
        const [year, month, day] = match.slice(1).map(Number);
        const date = new Date(year, month - 1, day);
        // 与 new Date 一致，不存在的日期（如 2 月 30 日）无效，而不是顺延到下个月
        return date.getMonth() === month - 1 && date.getDate() === day ? date : new Date(NaN);
    },

    startOfDay(value) {
        const date = value instanceof Date ? new Date(value) : this.parse(value);
        date.setHours(0, 0, 0, 0);
        return date;
    },

    // 两个日期之间相差的日历天数（按本地日期计算，不受夏令时影响）
    daysBetween(from, to) {
        return Math.round((this.startOfDay(to) - this.startOfDay(from)) / 86400000);
    },

    // 格式化为 datetime-local 输入框的值：YYYY-MM-DDTHH:mm（本地时间）
    toInputValue(value) {
        const date = value instanceof Date ? value : this.parse(value);
        if (!Number.isFinite(date.getTime())) return '';
        const pad = n => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
};

// ==========================================
// 用户管理
// ==========================================

const UserManager = {
    CURRENT_USER_KEY: 'gantt_current_user',

    // 获取当前用户
    getCurrentUser() {
        return localStorage.getItem(this.CURRENT_USER_KEY);
    },

    // 设置当前用户
    setCurrentUser(username) {
        if (username) {
            localStorage.setItem(this.CURRENT_USER_KEY, username);
        } else {
            localStorage.removeItem(this.CURRENT_USER_KEY);
        }
    },

    // 登出
    logout() {
        this.setCurrentUser(null);
    },

    // 检查是否已登录
    isLoggedIn() {
        return !!this.getCurrentUser();
    }
};

// ==========================================
// 数据管理
// ==========================================

const DataStore = {
    // 获取档案的存储 key（默认为当前档案）
    getStorageKey(profile = UserManager.getCurrentUser()) {
        return profile ? `gantt_data_${profile}` : 'gantt_project_data';
    },

    // 默认数据结构
    getDefaultData() {
        return {
            projects: [],
            lastModified: Date.now(),
            version: 1
        };
    },

    // 从本地存储加载数据
    load(profile = UserManager.getCurrentUser()) {
        try {
            const saved = localStorage.getItem(this.getStorageKey(profile));
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            console.error('加载数据失败:', e);
        }
        return this.getDefaultData();
    },

    // 保存到本地存储；profile 应为数据所属的档案
    save(data, profile = UserManager.getCurrentUser()) {
        try {
            const key = this.getStorageKey(profile);
            data.lastModified = Date.now();
            localStorage.setItem(key, JSON.stringify(data));
            return true;
        } catch (e) {
            console.error('保存数据失败:', e);
            return false;
        }
    },

    // 生成唯一 ID
    generateId() {
        return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
};

// ==========================================
// 应用状态
// ==========================================

const AppState = {
    data: null,
    // 内存中数据所属的档案。当前档案记录在 localStorage 中、由所有标签页共享；
    // 其他标签页切换档案后，本页的数据仍只能写回这里记录的档案。
    profile: null,
    currentProjectId: null,
    viewMode: 'day', // 'day', 'week', 'month'
    editingTaskId: null,

    // 汇总视图状态
    isSummaryView: false,

    // 拖拽状态
    isDragging: false,
    dragType: null, // 'left' or 'right'
    dragTaskId: null,
    dragStartX: 0,
    dragInitialLeft: 0,
    dragInitialWidth: 0,
    currentTimeRange: null,

    init() {
        this.loadProfile(UserManager.getCurrentUser());
    },

    // 载入档案数据（未登录时为空数据），默认进入汇总视图
    loadProfile(profile) {
        this.profile = profile || null;
        this.data = this.profile ? DataStore.load(this.profile) : DataStore.getDefaultData();
        this.isSummaryView = true;
        this.currentProjectId = null;
    },

    getCurrentProject() {
        if (!this.currentProjectId) return null;
        return this.data.projects.find(p => p.id === this.currentProjectId);
    },

    save() {
        if (!DataStore.save(this.data, this.profile)) {
            UI.showToast('本地保存失败，浏览器存储空间可能已满', 'error');
        }
        // 触发自动同步（防抖）
        this.scheduleAutoSync();
    },

    // 自动同步定时器
    autoSyncTimer: null,
    autoSyncDelay: 5000, // 5秒后自动同步

    cancelAutoSync() {
        clearTimeout(this.autoSyncTimer);
        this.autoSyncTimer = null;
    },

    scheduleAutoSync() {
        // 清除之前的定时器
        this.cancelAutoSync();
        // 只为本页数据所属的档案上传；其他标签页已切换档案时，云端配置属于另一个档案
        const profile = this.profile;
        if (profile !== UserManager.getCurrentUser()) return;

        const statusEl = document.getElementById('autoSyncStatus');
        const textEl = statusEl?.querySelector('.sync-text');

        // 如果已配置云端同步，5秒后自动上传
        if (CloudAPI.isConfigured()) {
            if (statusEl) {
                statusEl.classList.remove('disabled');
                textEl.textContent = '等待同步...';
            }

            this.autoSyncTimer = setTimeout(async () => {
                this.autoSyncTimer = null;
                if (UserManager.getCurrentUser() !== profile) return;
                try {
                    if (statusEl) {
                        statusEl.classList.add('syncing');
                        textEl.textContent = '正在同步...';
                    }

                    CloudAPI.init();
                    const dataToUpload = {
                        ...this.data,
                        notificationEmail: CloudAPI.getProfileSetting('notification_email') || null
                    };
                    await CloudAPI.updateData(dataToUpload);
                    if (UserManager.getCurrentUser() !== profile) return;
                    await CloudAPI.registerToMasterBin();

                    if (statusEl) {
                        statusEl.classList.remove('syncing');
                        textEl.textContent = '已同步 ✓';
                    }
                    console.log('自动同步完成');
                } catch (error) {
                    console.error('自动同步失败:', error);
                    if (statusEl) {
                        statusEl.classList.remove('syncing');
                        textEl.textContent = '同步失败';
                    }
                }
            }, this.autoSyncDelay);
        } else {
            if (statusEl) {
                statusEl.classList.add('disabled');
                textEl.textContent = '未配置云端';
            }
        }
    }
};

// Local data is saved immediately. A pending cloud upload may not finish when
// closing the page; the sync indicator is the authoritative completion status.

// ==========================================
// UI 控制器
// ==========================================

const UI = {
    // DOM 元素缓存
    elements: {},

    init() {
        this.cacheElements();
        this.bindEvents();
        this.render();
    },

    cacheElements() {
        this.elements = {
            // 项目相关
            projectList: document.getElementById('projectList'),
            addProjectBtn: document.getElementById('addProjectBtn'),
            currentProjectName: document.getElementById('currentProjectName'),

            // 任务相关
            addTaskBtn: document.getElementById('addTaskBtn'),
            ganttContainer: document.getElementById('ganttContainer'),
            ganttHeader: document.getElementById('ganttHeader'),
            ganttBody: document.getElementById('ganttBody'),
            timelineHeader: document.getElementById('timelineHeader'),
            ganttTasks: document.getElementById('ganttTasks'),
            emptyState: document.getElementById('emptyState'),
            emptyAddProject: document.getElementById('emptyAddProject'),

            // 视图控制
            viewControls: document.querySelectorAll('.btn-view'),

            // 任务模态框
            taskModal: document.getElementById('taskModal'),
            taskForm: document.getElementById('taskForm'),
            modalTitle: document.getElementById('modalTitle'),
            taskName: document.getElementById('taskName'),
            startDate: document.getElementById('startDate'),
            endDate: document.getElementById('endDate'),

            taskNotes: document.getElementById('taskNotes'),
            taskId: document.getElementById('taskId'),
            taskColorValue: document.getElementById('taskColorValue'),
            colorPicker: document.getElementById('colorPicker'),
            customColorBtn: document.getElementById('customColorBtn'),
            customColorPicker: document.getElementById('customColorPicker'),
            closeModal: document.getElementById('closeModal'),
            cancelTask: document.getElementById('cancelTask'),
            saveTask: document.getElementById('saveTask'),
            deleteTask: document.getElementById('deleteTask'),

            // 提醒设置
            reminderEnabled: document.getElementById('reminderEnabled'),
            reminderSettings: document.getElementById('reminderSettings'),
            reminderBrowser: document.getElementById('reminderBrowser'),
            reminderEmail: document.getElementById('reminderEmail'),
            remind0: document.getElementById('remind0'),
            remind1: document.getElementById('remind1'),
            remind3: document.getElementById('remind3'),
            remind7: document.getElementById('remind7'),
            remindCustom: document.getElementById('remindCustom'),
            remindCustomDays: document.getElementById('remindCustomDays'),

            // 任务重复
            taskRecurrence: document.getElementById('taskRecurrence'),
            recurrenceCustomRow: document.getElementById('recurrenceCustomRow'),
            recurrenceCustomDays: document.getElementById('recurrenceCustomDays'),

            // 项目模态框
            projectModal: document.getElementById('projectModal'),
            projectForm: document.getElementById('projectForm'),
            projectModalTitle: document.getElementById('projectModalTitle'),
            projectName: document.getElementById('projectName'),
            projectId: document.getElementById('projectId'),
            closeProjectModal: document.getElementById('closeProjectModal'),
            cancelProject: document.getElementById('cancelProject'),
            saveProject: document.getElementById('saveProject'),
            deleteProject: document.getElementById('deleteProject'),

            // 设置模态框
            settingsModal: document.getElementById('settingsModal'),
            settingsBtn: document.getElementById('settingsBtn'),
            jsonbinApiKey: document.getElementById('jsonbinApiKey'),
            jsonbinBinId: document.getElementById('jsonbinBinId'),
            closeSettingsModal: document.getElementById('closeSettingsModal'),
            cancelSettings: document.getElementById('cancelSettings'),
            saveSettings: document.getElementById('saveSettings'),
            syncStatus: document.getElementById('syncStatus'),
            notificationEmail: document.getElementById('notificationEmail'),

            // 同步按钮
            uploadBtn: document.getElementById('uploadBtn'),
            downloadBtn: document.getElementById('downloadBtn'),

            // Toast
            toastContainer: document.getElementById('toastContainer'),

            // 用户登录
            loginModal: document.getElementById('loginModal'),
            loginUsername: document.getElementById('loginUsername'),
            loginBtn: document.getElementById('loginBtn'),
            userInfo: document.getElementById('userInfo'),
            userAvatar: document.getElementById('userAvatar'),
            userName: document.getElementById('userName'),
            logoutBtn: document.getElementById('logoutBtn'),

            // 导出功能
            exportBtn: document.getElementById('exportBtn'),
            exportModal: document.getElementById('exportModal'),
            closeExportModal: document.getElementById('closeExportModal'),
            cancelExport: document.getElementById('cancelExport'),
            doExport: document.getElementById('doExport'),
            exportPreview: document.getElementById('exportPreview'),

            // 主控 Bin（邮件提醒用户注册）
            masterBinId: document.getElementById('masterBinId'),
            createMasterBin: document.getElementById('createMasterBin'),

            // 汇总视图
            summaryViewEntry: document.getElementById('summaryViewEntry'),

            // 过期任务弹窗
            overdueModal: document.getElementById('overdueModal'),
            overdueTaskList: document.getElementById('overdueTaskList'),
            confirmOverdue: document.getElementById('confirmOverdue')
        };
    },

    bindEvents() {
        // 添加项目
        this.elements.addProjectBtn.addEventListener('click', () => this.openProjectModal());
        this.elements.emptyAddProject.addEventListener('click', () => this.openProjectModal());

        // 项目模态框
        this.elements.closeProjectModal.addEventListener('click', () => this.closeProjectModal());
        this.elements.cancelProject.addEventListener('click', () => this.closeProjectModal());
        this.elements.saveProject.addEventListener('click', (e) => {
            e.preventDefault();
            this.saveProject();
        });
        this.elements.deleteProject.addEventListener('click', () => this.deleteProject());

        // 阻止项目表单默认提交（按 Enter 时）
        this.elements.projectForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveProject();
        });

        // 添加任务
        this.elements.addTaskBtn.addEventListener('click', () => this.openTaskModal());

        // 任务模态框
        this.elements.closeModal.addEventListener('click', () => this.closeTaskModal());
        this.elements.cancelTask.addEventListener('click', () => this.closeTaskModal());
        this.elements.saveTask.addEventListener('click', (e) => {
            e.preventDefault();
            this.saveTask();
        });
        this.elements.deleteTask.addEventListener('click', () => this.deleteTask());

        // 阻止任务表单默认提交（按 Enter 时）
        this.elements.taskForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveTask();
        });



        // 颜色选择
        this.elements.colorPicker.addEventListener('click', (e) => {
            if (e.target.classList.contains('color-option')) {
                this.elements.colorPicker.querySelectorAll('.color-option').forEach(btn => {
                    btn.classList.remove('active');
                });
                e.target.classList.add('active');
                this.elements.taskColorValue.value = e.target.dataset.color;
            }
        });

        // 自定义颜色选择器
        this.elements.customColorBtn?.addEventListener('click', () => {
            this.elements.customColorPicker.click();
        });

        this.elements.customColorPicker?.addEventListener('input', (e) => {
            const customColor = e.target.value;
            this.elements.taskColorValue.value = customColor;

            // 取消所有预设颜色的激活状态
            this.elements.colorPicker.querySelectorAll('.color-option').forEach(btn => {
                btn.classList.remove('active');
            });

            // 更新自定义按钮的背景色以显示当前选择
            this.elements.customColorBtn.style.background = `linear-gradient(135deg, ${customColor} 50%, transparent 50%)`;
        });

        // 日期输入框点击任意位置都能唤出选择器
        [this.elements.startDate, this.elements.endDate].forEach(input => {
            input.parentElement?.addEventListener('click', (e) => {
                if (e.target !== input && !input.contains(e.target)) {
                    input.showPicker?.(); // 使用 showPicker API（现代浏览器支持）
                }
            });
        });

        // 开始日期变化时，更新结束日期的最小值
        this.elements.startDate.addEventListener('change', () => {
            const startValue = this.elements.startDate.value;
            if (startValue) {
                // 设置结束日期的最小值为开始日期
                this.elements.endDate.min = startValue;

                // 如果当前结束日期早于开始日期，自动调整
                if (this.elements.endDate.value && this.elements.endDate.value < startValue) {
                    // 将结束日期设置为开始日期后1小时
                    const startDate = new Date(startValue);
                    startDate.setHours(startDate.getHours() + 1);
                    this.elements.endDate.value = DateUtils.toInputValue(startDate);
                }
            }
        });

        // 结束日期变化时，验证不能早于开始日期
        this.elements.endDate.addEventListener('change', () => {
            const startValue = this.elements.startDate.value;
            const endValue = this.elements.endDate.value;

            if (startValue && endValue && endValue < startValue) {
                this.showToast('结束时间不能早于开始时间', 'warning');
                // 重置为开始日期后1小时
                const startDate = new Date(startValue);
                startDate.setHours(startDate.getHours() + 1);
                this.elements.endDate.value = DateUtils.toInputValue(startDate);
            }
        });

        // 视图切换（汇总视图与项目视图共用）
        this.elements.viewControls.forEach(btn => {
            btn.addEventListener('click', () => {
                this.elements.viewControls.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                AppState.viewMode = btn.dataset.view;
                this.renderMainView();
            });
        });

        // 提醒设置开关
        this.elements.reminderEnabled.addEventListener('change', () => {
            this.elements.reminderSettings.style.display =
                this.elements.reminderEnabled.checked ? 'block' : 'none';
        });

        // 任务重复自定义显示
        this.elements.taskRecurrence.addEventListener('change', () => {
            this.elements.recurrenceCustomRow.style.display =
                this.elements.taskRecurrence.value === 'custom' ? 'flex' : 'none';
        });

        // 设置模态框
        this.elements.settingsBtn.addEventListener('click', () => this.openSettingsModal());
        this.elements.closeSettingsModal.addEventListener('click', () => this.closeSettingsModal());
        this.elements.cancelSettings.addEventListener('click', () => this.closeSettingsModal());
        this.elements.saveSettings.addEventListener('click', () => this.saveSettings());

        // 同步按钮
        this.elements.uploadBtn.addEventListener('click', () => this.uploadToCloud());
        this.elements.downloadBtn.addEventListener('click', () => this.downloadFromCloud());

        // 导出功能
        this.elements.exportBtn.addEventListener('click', () => this.openExportModal());
        this.elements.closeExportModal.addEventListener('click', () => this.closeExportModal());
        this.elements.cancelExport.addEventListener('click', () => this.closeExportModal());
        this.elements.doExport.addEventListener('click', () => this.doExport());

        // 导出选项变化时更新预览
        document.querySelectorAll('input[name="exportSize"], input[name="exportVersion"], input[name="exportStyle"]').forEach(radio => {
            radio.addEventListener('change', () => this.updateExportPreview());
        });

        // 创建主控 Bin
        this.elements.createMasterBin.addEventListener('click', async (e) => {
            e.preventDefault();
            await this.handleCreateMasterBin();
        });

        // 点击模态框外部关闭
        const dismissibleModals = [this.elements.taskModal, this.elements.projectModal, this.elements.settingsModal, this.elements.exportModal];
        dismissibleModals.forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('active');
                }
            });
        });

        // Esc 先关闭大图预览，再关闭可关闭的弹窗（登录与过期任务弹窗需明确操作）。
        // 输入法组字时的 Esc 用于取消输入，不关闭弹窗。
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || e.isComposing) return;
            const preview = document.querySelector('.preview-fullscreen-overlay');
            if (preview) {
                preview.remove();
                return;
            }
            dismissibleModals.forEach(modal => modal.classList.remove('active'));
        });

        // 移动端侧边栏切换
        document.querySelector('.toolbar-left')?.addEventListener('click', (e) => {
            if (window.innerWidth <= 768) {
                document.querySelector('.sidebar').classList.toggle('open');
            }
        });

        // 用户登录
        this.elements.loginBtn.addEventListener('click', () => this.handleLogin());
        this.elements.loginUsername.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleLogin();
        });
        this.elements.logoutBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleLogout();
        });

        // 滚动同步：时间轴头部和任务区域同步滚动
        this.elements.timelineHeader.addEventListener('scroll', () => {
            this.syncScroll(this.elements.timelineHeader.scrollLeft);
        });

        // 任务行被单独横向滚动（触控板、Shift+滚轮）时，带动表头和其他行保持对齐。
        // scroll 事件不冒泡，因此在捕获阶段监听。
        this.elements.ganttTasks.addEventListener('scroll', (e) => {
            if (e.target.classList?.contains('task-timeline')) {
                this.elements.timelineHeader.scrollLeft = e.target.scrollLeft;
            }
        }, true);

        // 日历栏拖拽滚动
        this.initTimelineDragScroll();

        // 日视图滚轮缩放（表头元素常驻，只需绑定一次）
        this.bindTimelineZoom();

        // 汇总视图点击
        this.elements.summaryViewEntry.addEventListener('click', () => {
            this.enterSummaryView();
        });

        // 过期任务弹窗确认
        this.elements.confirmOverdue.addEventListener('click', () => {
            this.confirmOverdueActions();
        });
    },

    // 初始化日历栏拖拽滚动
    initTimelineDragScroll() {
        const header = this.elements.timelineHeader;
        let isDragging = false;
        let startX = 0;
        let scrollStart = 0;

        const startDrag = (e) => {
            isDragging = true;
            startX = e.type === 'mousedown' ? e.pageX : e.touches[0].pageX;
            scrollStart = header.scrollLeft;
            header.style.cursor = 'grabbing';
            header.style.userSelect = 'none';
        };

        const doDrag = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const currentX = e.type === 'mousemove' ? e.pageX : e.touches[0].pageX;
            const diff = startX - currentX;
            header.scrollLeft = scrollStart + diff;
            this.syncScroll(header.scrollLeft);
        };

        const endDrag = () => {
            isDragging = false;
            header.style.cursor = 'grab';
            header.style.userSelect = '';
        };

        // 鼠标事件
        header.addEventListener('mousedown', startDrag);
        document.addEventListener('mousemove', doDrag);
        document.addEventListener('mouseup', endDrag);

        // 触摸事件（移动端）
        header.addEventListener('touchstart', startDrag, { passive: true });
        document.addEventListener('touchmove', doDrag, { passive: false });
        document.addEventListener('touchend', endDrag);

        // 设置初始光标样式
        header.style.cursor = 'grab';
    },

    // 同步滚动
    syncScroll(scrollLeft) {
        // 同步所有任务行的时间线区域
        document.querySelectorAll('.task-timeline').forEach(timeline => {
            timeline.scrollLeft = scrollLeft;
        });
    },

    // ==========================================
    // 渲染方法
    // ==========================================

    render() {
        this.renderProjectList();
        this.elements.summaryViewEntry.classList.toggle('active', AppState.isSummaryView);
        this.renderMainView();
    },

    // 根据是否为汇总视图渲染主区域
    renderMainView() {
        if (AppState.isSummaryView) {
            this.renderSummaryView();
        } else {
            this.renderGantt();
        }
    },

    renderProjectList() {
        const { projects } = AppState.data;

        if (projects.length === 0) {
            this.elements.projectList.innerHTML = `
                <li class="no-projects">暂无项目</li>
            `;
            return;
        }

        this.elements.projectList.innerHTML = projects.map(project => `
            <li class="project-item ${project.id === AppState.currentProjectId ? 'active' : ''}"
                data-project-id="${this.escapeHtml(project.id)}">
                <span class="project-icon">📋</span>
                <span class="project-name">${this.escapeHtml(project.name)}</span>
                <span class="project-count">${project.tasks?.length || 0}</span>
                <button class="btn-icon project-menu" title="编辑项目">✏️</button>
            </li>
        `).join('');

        // 绑定项目点击事件
        this.elements.projectList.querySelectorAll('.project-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('project-menu')) {
                    e.stopPropagation();
                    this.openProjectModal(item.dataset.projectId);
                } else {
                    this.selectProject(item.dataset.projectId);
                }
            });
        });
    },

    renderGantt() {
        const project = AppState.getCurrentProject();

        if (!project) {
            this.elements.emptyState.style.display = 'block';
            this.elements.ganttHeader.style.display = 'none';
            this.elements.ganttBody.style.display = 'none';
            this.elements.addTaskBtn.disabled = true;
            this.elements.currentProjectName.textContent = '选择一个项目';
            return;
        }

        this.elements.emptyState.style.display = 'none';
        this.elements.ganttHeader.style.display = 'flex';
        this.elements.ganttBody.style.display = 'block';
        this.elements.addTaskBtn.disabled = false;
        this.elements.currentProjectName.textContent = project.name;

        // 计算时间范围
        const timeRange = this.calculateTimeRange(project.tasks);

        // 渲染时间轴头部
        this.renderTimelineHeader(timeRange);

        // 渲染任务列表
        this.renderTasks(project.tasks, timeRange);
    },

    calculateTimeRange(tasks) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let startDate = new Date(today);
        let endDate = new Date(today);

        // 根据视图模式调整默认显示范围
        const viewMode = AppState.viewMode;

        if (viewMode === 'day') {
            // 日视图：显示任务的完整范围 + 前后缓冲
            if (tasks && tasks.length > 0) {
                const dates = tasks.flatMap(t => [DateUtils.parse(t.startDate), DateUtils.parse(t.endDate)]);
                const minDate = new Date(Math.min(...dates));
                const maxDate = new Date(Math.max(...dates));

                // 起始日期：取今天和最早任务日期中较早的，再往前7天
                startDate = new Date(Math.min(today.getTime(), minDate.getTime()));
                startDate.setDate(startDate.getDate() - 7);

                // 结束日期：取今天和最晚任务日期中较晚的，再往后14天
                endDate = new Date(Math.max(today.getTime(), maxDate.getTime()));
                endDate.setDate(endDate.getDate() + 14);
            } else {
                // 无任务：当前日期的前三天和后三天
                startDate.setDate(startDate.getDate() - 3);
                endDate.setDate(endDate.getDate() + 7);
            }
        } else if (viewMode === 'week') {
            endDate.setDate(endDate.getDate() + 90); // 显示约3个月

            if (tasks && tasks.length > 0) {
                const dates = tasks.flatMap(t => [DateUtils.parse(t.startDate), DateUtils.parse(t.endDate)]);
                const minDate = new Date(Math.min(...dates));
                const maxDate = new Date(Math.max(...dates));

                // 向前扩展7天，向后扩展14天
                startDate = new Date(Math.min(today, minDate));
                startDate.setDate(startDate.getDate() - 7);

                endDate = new Date(Math.max(endDate, maxDate));
                endDate.setDate(endDate.getDate() + 14);
            }
        } else if (viewMode === 'month') {
            endDate.setMonth(endDate.getMonth() + 6); // 显示6个月

            if (tasks && tasks.length > 0) {
                const dates = tasks.flatMap(t => [DateUtils.parse(t.startDate), DateUtils.parse(t.endDate)]);
                const minDate = new Date(Math.min(...dates));
                const maxDate = new Date(Math.max(...dates));

                // 向前扩展7天，向后扩展14天
                startDate = new Date(Math.min(today, minDate));
                startDate.setDate(startDate.getDate() - 7);

                endDate = new Date(Math.max(endDate, maxDate));
                endDate.setDate(endDate.getDate() + 14);
            }
        }

        // 单元格从本地午夜开始，才能与"今天"及任务日期按日对齐
        startDate.setHours(0, 0, 0, 0);

        // 根据视图模式构建日期数组
        const dates = [];
        const current = new Date(startDate);

        if (viewMode === 'day') {
            // 每天一个单元格
            while (current <= endDate) {
                dates.push({ date: new Date(current), type: 'day' });
                current.setDate(current.getDate() + 1);
            }
        } else if (viewMode === 'week') {
            // 找到第一个周一
            while (current.getDay() !== 1 && current <= endDate) {
                current.setDate(current.getDate() + 1);
            }
            // 每周一个单元格
            while (current <= endDate) {
                dates.push({ date: new Date(current), type: 'week' });
                current.setDate(current.getDate() + 7);
            }
        } else if (viewMode === 'month') {
            // 每月一个单元格
            current.setDate(1); // 移到月初
            while (current <= endDate) {
                dates.push({ date: new Date(current), type: 'month' });
                current.setMonth(current.getMonth() + 1);
            }
        }

        return { startDate, endDate, dates, today, viewMode };
    },

    renderTimelineHeader(timeRange) {
        const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
        const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
        const cellWidth = this.getCellWidth(timeRange.viewMode);

        // 更新 CSS 变量以便任务条计算使用
        document.documentElement.style.setProperty('--gantt-cell-width', `${cellWidth}px`);

        this.elements.timelineHeader.innerHTML = timeRange.dates.map(item => {
            const date = item.date;
            let label1 = '';
            let label2 = '';

            if (item.type === 'day') {
                label1 = dayNames[date.getDay()];
                label2 = `${date.getMonth() + 1}/${date.getDate()}`;
            } else if (item.type === 'week') {
                label1 = `第${this.getWeekNumber(date)}周`;
                label2 = `${date.getMonth() + 1}/${date.getDate()}`;
            } else if (item.type === 'month') {
                label1 = `${date.getFullYear()}`;
                label2 = monthNames[date.getMonth()];
            }

            return `
                <div class="timeline-cell ${this.isTodayCell(item, timeRange.today) ? 'today' : ''}" style="min-width: ${cellWidth}px;">
                    <span class="day-name">${label1}</span>
                    <span class="day-num">${label2}</span>
                </div>
            `;
        }).join('');
    },

    // 单元格宽度；缩放仅作用于日视图。表头、网格线和任务条必须使用同一宽度
    getCellWidth(viewMode) {
        const baseCellWidth = { day: 40, week: 60, month: 80 }[viewMode] || 40;
        return viewMode === 'day' ? baseCellWidth * (AppState.zoomLevel || 1) : baseCellWidth;
    },

    // 今天是否落在该单元格（日、周、月）内
    isTodayCell(item, today) {
        const date = item.date;
        if (item.type === 'week') {
            const weekEnd = new Date(date);
            weekEnd.setDate(weekEnd.getDate() + 6);
            return today >= date && today <= weekEnd;
        }
        if (item.type === 'month') {
            return today.getFullYear() === date.getFullYear() && today.getMonth() === date.getMonth();
        }
        return date.getTime() === today.getTime();
    },

    // 任务条位置以第一个表头单元格为原点、按日历日计算，保证与表头对齐：
    // 周视图的第一格是周一，月视图的第一格是月初，二者都可能早于时间范围的起点。
    calculateBarPosition(task, timeRange, cellWidth) {
        const origin = timeRange.dates[0]?.date;
        if (!origin) return { left: 0, width: 20 };
        const startDay = DateUtils.startOfDay(task.startDate);
        const endDay = DateUtils.startOfDay(task.endDate);

        let offset;
        let span;
        if (timeRange.viewMode === 'month') {
            const daysInMonth = date => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
            const monthPosition = date => date.getFullYear() * 12 + date.getMonth() + (date.getDate() - 1) / daysInMonth(date);
            offset = monthPosition(startDay) - monthPosition(origin);
            span = monthPosition(endDay) + 1 / daysInMonth(endDay) - monthPosition(startDay);
        } else {
            const daysPerCell = timeRange.viewMode === 'week' ? 7 : 1;
            offset = DateUtils.daysBetween(origin, startDay) / daysPerCell;
            span = (DateUtils.daysBetween(startDay, endDay) + 1) / daysPerCell;
        }

        // 日视图任务条比所占单元格略短，使相邻日期的任务条之间留有间隙
        const inset = timeRange.viewMode === 'day' ? 4 : 0;
        return {
            left: Math.max(0, offset) * cellWidth,
            width: Math.max(span * cellWidth - inset, 20)
        };
    },

    renderGridHtml(timeRange, cellWidth) {
        return timeRange.dates.map(item =>
            `<div class="grid-line ${this.isTodayCell(item, timeRange.today) ? 'today' : ''}" style="min-width: ${cellWidth}px;"></div>`
        ).join('');
    },

    // 提示框中的时间：同一天只显示时刻，跨天显示日期和时刻
    formatTaskTime(task) {
        const start = DateUtils.parse(task.startDate);
        const end = DateUtils.parse(task.endDate);
        const pad = n => String(n).padStart(2, '0');
        const time = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const dateTime = d => `${d.getMonth() + 1}/${d.getDate()} ${time(d)}`;
        return start.toDateString() === end.toDateString()
            ? `${time(start)} ~ ${time(end)}`
            : `${dateTime(start)} ~ ${dateTime(end)}`;
    },

    isTaskCompleted(task) {
        // 兼容旧数据：progress === 100 也视为已完成
        return task.completed === true || task.progress === 100;
    },

    getWeekNumber(date) {
        const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
        const pastDaysOfYear = (date - firstDayOfYear) / 86400000;
        return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
    },

    renderTasks(tasks, timeRange) {
        if (!tasks || tasks.length === 0) {
            this.elements.ganttTasks.innerHTML = `
                <div class="gantt-empty-tasks">
                    <p style="padding: 40px; text-align: center; color: var(--text-muted);">
                        暂无任务，点击"添加任务"开始
                    </p>
                </div>
            `;
            return;
        }

        // 排序任务：未完成任务按截止时间排序在前，已完成任务在后
        const sortedTasks = [...tasks].sort((a, b) => {
            const aCompleted = this.isTaskCompleted(a);
            const bCompleted = this.isTaskCompleted(b);

            // 已完成的排在后面
            if (aCompleted !== bCompleted) {
                return aCompleted ? 1 : -1;
            }

            // 同类任务按截止时间排序（早的在前）
            return DateUtils.parse(a.endDate) - DateUtils.parse(b.endDate);
        });

        const cellWidth = this.getCellWidth(timeRange.viewMode);
        const gridHtml = this.renderGridHtml(timeRange, cellWidth);

        this.elements.ganttTasks.innerHTML = sortedTasks.map(task => {
            const { left, width } = this.calculateBarPosition(task, timeRange, cellWidth);
            const isCompleted = this.isTaskCompleted(task);
            const tooltipTime = this.formatTaskTime(task);
            const tooltipNotes = task.notes?.trim() || '';

            return `
                <div class="gantt-task-row" data-task-id="${this.escapeHtml(task.id)}">
                    <div class="task-info">
                        <div class="task-checkbox ${isCompleted ? 'checked' : ''}"
                             data-task-id="${this.escapeHtml(task.id)}"></div>
                        <span class="task-name ${isCompleted ? 'completed' : ''}">${this.escapeHtml(task.name)}</span>
                    </div>
                    <div class="task-timeline">
                        <div class="timeline-grid">
                            ${gridHtml}
                        </div>
                        <div class="gantt-bar ${isCompleted ? 'completed' : ''}"
                             style="left: ${left}px; width: ${width}px; background: ${this.safeColor(task.color)};"
                             data-task-id="${this.escapeHtml(task.id)}"
                             data-start-date="${this.escapeHtml(task.startDate)}"
                             data-end-date="${this.escapeHtml(task.endDate)}"
                             data-tooltip-time="${this.escapeHtml(tooltipTime)}"
                             data-tooltip-notes="${this.escapeHtml(tooltipNotes)}">
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // 新渲染的任务行滚动位置为 0，需与表头当前位置对齐
        this.syncScroll(this.elements.timelineHeader.scrollLeft);

        // 绑定任务事件
        this.elements.ganttTasks.querySelectorAll('.task-checkbox').forEach(checkbox => {
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleTaskComplete(checkbox.dataset.taskId);
            });
        });

        this.elements.ganttTasks.querySelectorAll('.task-name').forEach(el => {
            el.addEventListener('click', () => {
                this.openTaskModal(el.closest('.gantt-task-row').dataset.taskId);
            });
        });

        // 甘特条点击（非拖拽时）
        this.elements.ganttTasks.querySelectorAll('.gantt-bar').forEach(bar => {
            bar.addEventListener('click', (e) => {
                // 如果正在拖拽，不触发点击
                if (AppState.isDragging) return;
                // 如果点击的是拖拽手柄，不触发点击
                if (e.target.classList.contains('gantt-bar-handle')) return;
                this.openTaskModal(bar.dataset.taskId);
            });
        });

        // 绑定 Tooltip 事件
        this.bindTooltipEvents();
    },

    // ==========================================
    // Tooltip 功能
    // ==========================================

    bindTooltipEvents() {
        const tooltip = document.getElementById('globalTooltip');
        if (!tooltip) return;

        this.elements.ganttTasks.querySelectorAll('.gantt-bar').forEach(bar => {
            bar.addEventListener('mouseenter', (e) => {
                const time = bar.dataset.tooltipTime;
                const notes = bar.dataset.tooltipNotes;

                if (!time) return;

                // 设置 tooltip 内容
                tooltip.querySelector('.tooltip-time').textContent = time;
                tooltip.querySelector('.tooltip-notes').textContent = notes || '';

                // 计算位置
                const rect = bar.getBoundingClientRect();
                const tooltipRect = tooltip.getBoundingClientRect();

                // 显示 tooltip 以获取其尺寸
                tooltip.classList.add('visible');

                // 居中于任务条下方
                let left = rect.left + (rect.width / 2) - (tooltip.offsetWidth / 2);
                let top = rect.bottom + 10;

                // 边界检查
                if (left < 10) left = 10;
                if (left + tooltip.offsetWidth > window.innerWidth - 10) {
                    left = window.innerWidth - tooltip.offsetWidth - 10;
                }

                tooltip.style.left = `${left}px`;
                tooltip.style.top = `${top}px`;
            });

            bar.addEventListener('mouseleave', () => {
                tooltip.classList.remove('visible');
            });
        });
    },

    // ==========================================
    // 时间轴缩放功能
    // ==========================================

    bindTimelineZoom() {
        // 缩放级别状态（存储在 AppState 中）
        if (!AppState.zoomLevel) {
            AppState.zoomLevel = 1; // 默认缩放级别
        }

        // 绑定滚轮事件到时间轴头部
        this.elements.timelineHeader.addEventListener('wheel', (e) => {
            // 只在日视图下启用缩放；以横向为主的滚动（触控板左右滑动）交给浏览器正常滚动
            if (AppState.viewMode !== 'day' || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;

            e.preventDefault();

            // 根据滚轮方向调整缩放级别
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            AppState.zoomLevel = Math.max(0.5, Math.min(3, AppState.zoomLevel + delta));

            // 重新渲染当前视图（项目或汇总）以应用新的缩放级别
            this.renderMainView();
        }, { passive: false });
    },

    // ==========================================
    // 项目操作
    // ==========================================

    selectProject(projectId) {
        AppState.currentProjectId = projectId;
        AppState.isSummaryView = false;

        // 更新侧边栏选中状态
        this.elements.summaryViewEntry.classList.remove('active');

        this.render();

        // 移动端关闭侧边栏
        if (window.innerWidth <= 768) {
            document.querySelector('.sidebar').classList.remove('open');
        }
    },

    openProjectModal(projectId = null) {
        const modal = this.elements.projectModal;

        if (projectId) {
            const project = AppState.data.projects.find(p => p.id === projectId);
            if (project) {
                this.elements.projectModalTitle.textContent = '编辑项目';
                this.elements.projectName.value = project.name;
                this.elements.projectId.value = project.id;
                this.elements.deleteProject.style.display = 'block';
            }
        } else {
            this.elements.projectModalTitle.textContent = '新建项目';
            this.elements.projectForm.reset();
            this.elements.projectId.value = '';
            this.elements.deleteProject.style.display = 'none';
        }

        modal.classList.add('active');
        this.elements.projectName.focus();
    },

    closeProjectModal() {
        this.elements.projectModal.classList.remove('active');
    },

    saveProject() {
        const name = this.elements.projectName.value.trim();
        const id = this.elements.projectId.value;

        if (!name) {
            this.showToast('请输入项目名称', 'warning');
            return;
        }

        if (id) {
            // 编辑现有项目
            const project = AppState.data.projects.find(p => p.id === id);
            if (project) {
                project.name = name;
                this.showToast('项目已更新', 'success');
            }
        } else {
            // 创建新项目
            const newProject = {
                id: DataStore.generateId(),
                name: name,
                tasks: [],
                createdAt: Date.now()
            };
            AppState.data.projects.push(newProject);
            // 打开新建的项目（从汇总视图创建时也切换到项目视图）
            AppState.currentProjectId = newProject.id;
            AppState.isSummaryView = false;

            this.showToast('项目已创建', 'success');
        }

        AppState.save();


        this.closeProjectModal();
        this.render();

    },

    deleteProject() {
        const id = this.elements.projectId.value;
        if (!id) return;

        if (confirm('确定要删除这个项目吗？所有任务都将被删除。')) {
            AppState.data.projects = AppState.data.projects.filter(p => p.id !== id);

            if (AppState.currentProjectId === id) {
                AppState.currentProjectId = AppState.data.projects[0]?.id || null;
            }

            AppState.save();
            this.closeProjectModal();
            this.render();
            this.showToast('项目已删除', 'success');
        }
    },

    // ==========================================
    // 任务操作
    // ==========================================

    openTaskModal(taskId = null) {
        const modal = this.elements.taskModal;
        const project = AppState.getCurrentProject();

        if (!project) {
            this.showToast('请先选择一个项目', 'warning');
            return;
        }

        // 设置默认日期时间（datetime-local格式: YYYY-MM-DDTHH:mm）
        const today = DateUtils.toInputValue(new Date());
        const nextWeek = DateUtils.toInputValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

        // 重置提醒设置和任务重复到默认值
        const resetReminderSettings = () => {
            this.elements.reminderEnabled.checked = false;
            this.elements.reminderSettings.style.display = 'none';
            this.elements.reminderBrowser.checked = true;
            this.elements.reminderEmail.checked = false;
            this.elements.remind0.checked = false;
            this.elements.remind1.checked = true;
            this.elements.remind3.checked = false;
            this.elements.remind7.checked = false;
            this.elements.remindCustom.checked = false;
            this.elements.remindCustomDays.value = 14;
            // 任务重复
            this.elements.taskRecurrence.value = '0';
            this.elements.recurrenceCustomRow.style.display = 'none';
            this.elements.recurrenceCustomDays.value = 14;
        };

        // 加载提醒设置的辅助函数
        const loadReminderSettings = (reminder, recurrence) => {
            // 提醒设置
            if (!reminder) {
                this.elements.reminderEnabled.checked = false;
                this.elements.reminderSettings.style.display = 'none';
                this.elements.reminderBrowser.checked = true;
                this.elements.reminderEmail.checked = false;
                this.elements.remind0.checked = false;
                this.elements.remind1.checked = true;
                this.elements.remind3.checked = false;
                this.elements.remind7.checked = false;
                this.elements.remindCustom.checked = false;
                this.elements.remindCustomDays.value = 14;
            } else {
                this.elements.reminderEnabled.checked = reminder.enabled;
                this.elements.reminderSettings.style.display = reminder.enabled ? 'block' : 'none';
                this.elements.reminderBrowser.checked = reminder.methods?.browser ?? true;
                this.elements.reminderEmail.checked = reminder.methods?.email ?? false;

                // 提醒时间
                const timing = reminder.timing || [1];
                this.elements.remind0.checked = timing.includes(0);
                this.elements.remind1.checked = timing.includes(1);
                this.elements.remind3.checked = timing.includes(3);
                this.elements.remind7.checked = timing.includes(7);

                // 检查是否有自定义时间
                const customTiming = timing.find(t => ![0, 1, 3, 7].includes(t));
                this.elements.remindCustom.checked = !!customTiming;
                this.elements.remindCustomDays.value = customTiming || 14;
            }

            // 任务重复
            const standardRecurrences = [0, 1, 7, 14, 30, 90, 180, 365];
            const rec = recurrence || 0;
            if (standardRecurrences.includes(rec)) {
                this.elements.taskRecurrence.value = rec.toString();
                this.elements.recurrenceCustomRow.style.display = 'none';
            } else {
                this.elements.taskRecurrence.value = 'custom';
                this.elements.recurrenceCustomRow.style.display = 'flex';
                this.elements.recurrenceCustomDays.value = rec;
            }
        };

        if (taskId) {
            const task = project.tasks.find(t => t.id === taskId);
            if (task) {
                this.elements.modalTitle.textContent = '编辑任务';
                this.elements.taskName.value = task.name;
                // datetime-local 输入框不接受带时区的 ISO 值（旧版周期任务曾这样保存），统一转换为本地时间
                this.elements.startDate.value = DateUtils.toInputValue(task.startDate);
                this.elements.endDate.value = DateUtils.toInputValue(task.endDate);

                this.elements.taskNotes.value = task.notes || '';
                this.elements.taskId.value = task.id;
                this.elements.taskColorValue.value = task.color || '#6366f1';
                this.elements.deleteTask.style.display = 'block';

                // 设置颜色选择
                this.elements.colorPicker.querySelectorAll('.color-option').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.color === (task.color || '#6366f1'));
                });

                // 加载提醒设置和任务重复
                loadReminderSettings(task.reminder, task.recurrence);
            }
        } else {
            this.elements.modalTitle.textContent = '添加任务';
            this.elements.taskForm.reset();
            this.elements.startDate.value = today;
            this.elements.endDate.value = nextWeek;

            this.elements.taskId.value = '';

            // 生成随机颜色（避免与现有任务重复）
            const randomColor = this.generateRandomColor();
            this.elements.taskColorValue.value = randomColor;
            this.elements.deleteTask.style.display = 'none';

            // 设置颜色选择器的激活状态
            this.elements.colorPicker.querySelectorAll('.color-option').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.color === randomColor);
            });

            // 重置提醒设置
            resetReminderSettings();
        }

        modal.classList.add('active');
        this.elements.taskName.focus();
    },

    closeTaskModal() {
        this.elements.taskModal.classList.remove('active');
    },

    saveTask() {
        const project = AppState.getCurrentProject();
        if (!project) return;

        const name = this.elements.taskName.value.trim();
        const startDate = this.elements.startDate.value;
        const endDate = this.elements.endDate.value;

        const notes = this.elements.taskNotes.value.trim();
        const color = this.elements.taskColorValue.value;
        const id = this.elements.taskId.value;

        // 收集提醒设置（移除repeat，现在是独立的任务重复功能）
        const reminder = {
            enabled: this.elements.reminderEnabled.checked,
            methods: {
                browser: this.elements.reminderBrowser.checked,
                email: this.elements.reminderEmail.checked
            },
            timing: []
        };

        // 收集提醒时间（多选）
        if (this.elements.remind0.checked) reminder.timing.push(0);
        if (this.elements.remind1.checked) reminder.timing.push(1);
        if (this.elements.remind3.checked) reminder.timing.push(3);
        if (this.elements.remind7.checked) reminder.timing.push(7);
        if (this.elements.remindCustom.checked) {
            reminder.timing.push(parseInt(this.elements.remindCustomDays.value));
        }

        // 任务重复（循环任务）
        const recurrence = this.elements.taskRecurrence.value === 'custom'
            ? parseInt(this.elements.recurrenceCustomDays.value)
            : parseInt(this.elements.taskRecurrence.value);

        if (!name) {
            this.showToast('请输入任务名称', 'warning');
            return;
        }

        if (!startDate || !endDate) {
            this.showToast('请选择日期', 'warning');
            return;
        }

        if (new Date(startDate) > new Date(endDate)) {
            this.showToast('结束日期不能早于开始日期', 'warning');
            return;
        }

        if (id) {
            // 编辑现有任务
            const task = project.tasks.find(t => t.id === id);
            if (task) {
                Object.assign(task, { name, startDate, endDate, notes, color, reminder, recurrence });
                this.showToast('任务已更新', 'success');
            }
        } else {
            // 创建新任务
            project.tasks.push({
                id: DataStore.generateId(),
                name,
                startDate,
                endDate,
                completed: false,
                notes,
                color,
                reminder,
                recurrence,
                createdAt: Date.now()
            });
            this.showToast('任务已创建', 'success');
        }

        AppState.save();
        this.closeTaskModal();
        this.render();
    },

    deleteTask() {
        const project = AppState.getCurrentProject();
        const id = this.elements.taskId.value;
        if (!project || !id) return;

        if (confirm('确定要删除这个任务吗？')) {
            project.tasks = project.tasks.filter(t => t.id !== id);
            AppState.save();
            this.closeTaskModal();
            this.render();
            this.showToast('任务已删除', 'success');
        }
    },

    toggleTaskComplete(taskId) {
        const project = AppState.getCurrentProject();
        if (!project) return;

        const task = project.tasks.find(t => t.id === taskId);
        if (task) {
            if (this.isTaskCompleted(task)) {
                task.completed = false;
                // 旧数据以 progress === 100 表示完成，取消完成时需一并清除，否则任务仍显示为已完成
                if (task.progress === 100) delete task.progress;
            } else {
                this.completeTask(project, task);
            }

            AppState.save();
            this.render();
        }
    },

    // 标记任务完成；周期任务会创建下一个周期的任务，并直接删除已完成的当前任务
    completeTask(project, task) {
        task.completed = true;
        if (Number(task.recurrence) > 0) {
            this.createNextRecurringTask(project, task);
            const taskIndex = project.tasks.indexOf(task);
            if (taskIndex !== -1) {
                project.tasks.splice(taskIndex, 1);
            }
        }
    },

    // 创建下一个周期的重复任务
    createNextRecurringTask(project, completedTask) {
        const now = new Date();

        // 计算原任务的持续时间（毫秒）
        const originalStart = DateUtils.parse(completedTask.startDate);
        const originalEnd = DateUtils.parse(completedTask.endDate);
        const duration = originalEnd - originalStart;

        // 新任务的开始时间 = 当前时间 + 重复周期（天）
        const newStartDate = new Date(now);
        newStartDate.setDate(newStartDate.getDate() + Number(completedTask.recurrence));
        // 保持原任务的时分
        newStartDate.setHours(originalStart.getHours(), originalStart.getMinutes(), 0, 0);

        // 新任务的结束时间 = 新开始时间 + 原持续时间
        const newEndDate = new Date(newStartDate.getTime() + duration);

        // 创建新任务；日期与表单一致，保存为本地 datetime-local 字符串
        const newTask = {
            id: DataStore.generateId(),
            name: completedTask.name,
            startDate: DateUtils.toInputValue(newStartDate),
            endDate: DateUtils.toInputValue(newEndDate),
            completed: false,
            notes: completedTask.notes || '',
            color: completedTask.color || '#6366f1',
            reminder: completedTask.reminder ? { ...completedTask.reminder } : null,
            recurrence: completedTask.recurrence,
            createdAt: Date.now()
        };

        project.tasks.push(newTask);

        // 格式化日期显示
        const formatDate = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
        this.showToast(`已创建下一个周期任务: ${formatDate(newStartDate)}`, 'success');
    },

    // ==========================================
    // 设置和同步
    // ==========================================

    openSettingsModal() {
        const config = CloudAPI.getConfig();
        this.elements.jsonbinApiKey.value = config.apiKey || '';
        this.elements.jsonbinBinId.value = config.binId || '';
        this.elements.notificationEmail.value = CloudAPI.getProfileSetting('notification_email') || '';
        this.elements.masterBinId.value = CloudAPI.getProfileSetting('master_bin_id') || '';
        this.elements.syncStatus.className = 'sync-status';
        this.elements.syncStatus.textContent = '';
        this.elements.settingsModal.classList.add('active');
    },

    closeSettingsModal() {
        this.elements.settingsModal.classList.remove('active');
    },

    saveSettings() {
        if (this.followActiveProfile()) return;
        const apiKey = this.elements.jsonbinApiKey.value.trim();
        const binId = this.elements.jsonbinBinId.value.trim();
        const email = this.elements.notificationEmail.value.trim();
        const masterBinId = this.elements.masterBinId.value.trim();

        AppState.cancelAutoSync();
        CloudAPI.saveConfig(apiKey, binId || null);

        CloudAPI.saveProfileSetting('notification_email', email);
        CloudAPI.saveProfileSetting('master_bin_id', masterBinId);
        AppState.scheduleAutoSync();

        this.elements.syncStatus.className = 'sync-status success';
        this.elements.syncStatus.textContent = '设置已保存';

        setTimeout(() => {
            this.closeSettingsModal();
            this.showToast('设置已保存', 'success');
        }, 1000);
    },

    // 创建主控 Bin
    async handleCreateMasterBin() {
        if (this.followActiveProfile()) return;
        const profile = UserManager.getCurrentUser();
        if (!CloudAPI.isConfigured()) {
            this.showToast('请先填写 API Key', 'warning');
            return;
        }

        try {
            this.elements.syncStatus.textContent = '正在创建...';
            const masterBinId = await CloudAPI.createMasterBin();
            if (UserManager.getCurrentUser() !== profile) return;
            this.elements.masterBinId.value = masterBinId;
            this.elements.syncStatus.className = 'sync-status success';
            this.elements.syncStatus.textContent = '主控 Bin 已创建！请复制 ID 保存到 Cloudflare Worker 环境变量';
            this.showToast('主控 Bin 创建成功！', 'success');
        } catch (error) {
            this.elements.syncStatus.className = 'sync-status error';
            this.elements.syncStatus.textContent = '创建失败: ' + error.message;
        }
    },

    async uploadToCloud() {
        if (this.followActiveProfile()) return;
        const btn = this.elements.uploadBtn;
        const profile = UserManager.getCurrentUser();

        if (!CloudAPI.isConfigured()) {
            this.openSettingsModal();
            return;
        }

        btn.classList.add('syncing');
        btn.disabled = true;

        try {
            // 更新云端API的BinId（可能切换了用户）
            CloudAPI.init();

            // 上传数据时包含通知邮箱
            const dataToUpload = {
                ...AppState.data,
                notificationEmail: CloudAPI.getProfileSetting('notification_email') || null
            };

            await CloudAPI.updateData(dataToUpload);
            if (UserManager.getCurrentUser() !== profile) return;

            // 注册到主控 Bin（用于邮件提醒服务发现用户）
            await CloudAPI.registerToMasterBin();

            this.showToast('已上传到云端', 'success');
        } catch (error) {
            this.showToast('上传失败: ' + error.message, 'error');
        } finally {
            btn.classList.remove('syncing');
            btn.disabled = false;
        }
    },

    async downloadFromCloud() {
        if (this.followActiveProfile()) return;
        const btn = this.elements.downloadBtn;
        const profile = UserManager.getCurrentUser();

        if (!CloudAPI.isConfigured()) {
            this.openSettingsModal();
            return;
        }

        btn.classList.add('syncing');
        btn.disabled = true;

        try {
            // 更新云端API的BinId（可能切换了用户）
            CloudAPI.init();

            const cloudData = await CloudAPI.readData();
            if (UserManager.getCurrentUser() !== profile) return;

            if (cloudData) {
                AppState.data = cloudData;
                DataStore.save(AppState.data, profile);

                // 更新当前项目（汇总视图不选中项目）
                if (!AppState.isSummaryView && !AppState.getCurrentProject()) {
                    AppState.currentProjectId = AppState.data.projects[0]?.id || null;
                }

                this.render();
                this.showToast('已从云端下载', 'success');
            } else {
                this.showToast('云端无数据', 'warning');
            }
        } catch (error) {
            this.showToast('下载失败: ' + error.message, 'error');
        } finally {
            btn.classList.remove('syncing');
            btn.disabled = false;
        }
    },

    // ==========================================
    // 工具方法
    // ==========================================

    // 生成随机颜色（避免与现有任务重复）
    generateRandomColor() {
        const project = AppState.getCurrentProject();
        const existingColors = project?.tasks?.map(t => t.color) || [];

        // 预设颜色池
        const colorPool = [
            '#6366f1', // 靛蓝
            '#8b5cf6', // 紫色
            '#ec4899', // 粉色
            '#f43f5e', // 玫瑰
            '#f59e0b', // 琥珀
            '#10b981', // 翡翠
            '#14b8a6', // 青色
            '#06b6d4', // 天蓝
            '#3b82f6', // 蓝色
        ];

        // 找到未使用的颜色
        const availableColors = colorPool.filter(color => !existingColors.includes(color));

        if (availableColors.length > 0) {
            // 随机选择一个未使用的颜色
            return availableColors[Math.floor(Math.random() * availableColors.length)];
        }

        // 如果所有预设颜色都被使用，生成随机颜色。须为 #rrggbb，否则 safeColor 会将其替换为默认色
        const hue = Math.floor(Math.random() * 360);
        const saturation = 60 + Math.floor(Math.random() * 20); // 60-80%
        const lightness = 50 + Math.floor(Math.random() * 10); // 50-60%
        return this.hslToHex(hue, saturation, lightness);
    },

    hslToHex(hue, saturation, lightness) {
        const s = saturation / 100;
        const l = lightness / 100;
        const a = s * Math.min(l, 1 - l);
        const channel = n => {
            const k = (n + hue / 30) % 12;
            const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
            return Math.round(value * 255).toString(16).padStart(2, '0');
        };
        return `#${channel(0)}${channel(8)}${channel(4)}`;
    },

    escapeHtml(text) {
        return String(text ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    },

    safeColor(color) {
        return /^#[0-9a-f]{6}$/i.test(color) ? color : '#6366f1';
    },

    showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icons = {
            success: '✅',
            error: '❌',
            warning: '⚠️'
        };

        toast.innerHTML = `
            <span class="toast-icon">${icons[type]}</span>
            <span class="toast-message">${this.escapeHtml(message)}</span>
        `;

        this.elements.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideIn 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    },

    // ==========================================
    // 用户登录管理
    // ==========================================

    handleLogin() {
        const username = this.elements.loginUsername.value.trim();

        if (!username) {
            this.showToast('请输入用户名', 'warning');
            return;
        }

        if (username.length < 2) {
            this.showToast('用户名至少需要2个字符', 'warning');
            return;
        }

        // 保存用户
        AppState.cancelAutoSync();
        UserManager.setCurrentUser(username);
        CloudAPI.init();

        // 重新加载用户数据，进入汇总视图
        AppState.loadProfile(username);

        // 隐藏登录框
        this.elements.loginModal.classList.remove('active');

        // 更新用户显示，并完整渲染（包括侧边栏项目列表）
        this.updateUserDisplay();
        this.render();

        // 检查过期任务
        const overdueTasks = this.checkOverdueTasks();

        if (overdueTasks.length > 0) {
            // 有过期任务，显示处理弹窗
            this.showOverdueModal(overdueTasks);
            this.showToast(`欢迎回来，${username}！您有 ${overdueTasks.length} 个过期任务需要处理`, 'warning');
        } else {
            this.showToast(`欢迎回来，${username}！`, 'success');
        }
    },

    handleLogout() {
        if (confirm('确定要退出登录吗？')) {
            AppState.cancelAutoSync();
            UserManager.logout();
            CloudAPI.init();

            // 重置状态
            AppState.loadProfile(null);

            // 显示登录框
            this.elements.loginModal.classList.add('active');
            this.elements.loginUsername.value = '';

            // 更新用户显示
            this.updateUserDisplay();

            // 渲染界面
            this.render();

            this.showToast('已退出登录', 'success');
        }
    },

    updateUserDisplay() {
        const user = UserManager.getCurrentUser();
        const statusEl = document.getElementById('autoSyncStatus');
        const textEl = statusEl?.querySelector('.sync-text');
        if (statusEl && textEl) {
            statusEl.classList.toggle('disabled', !CloudAPI.isConfigured());
            statusEl.classList.remove('syncing');
            textEl.textContent = CloudAPI.isConfigured() ? '自动同步已启用' : '未配置云端';
        }

        if (user) {
            this.elements.userName.textContent = user;
            this.elements.userAvatar.textContent = user.charAt(0).toUpperCase();
            this.elements.logoutBtn.style.display = 'flex';
        } else {
            this.elements.userName.textContent = '未登录';
            this.elements.userAvatar.textContent = '👤';
            this.elements.logoutBtn.style.display = 'none';
        }
    },

    // ==========================================
    // 多标签页同步
    // ==========================================

    // 其他标签页修改 localStorage 时触发（本页自己的写入不会触发）
    handleStorageChange(event) {
        if (event.storageArea !== localStorage) return;
        if (this.followActiveProfile()) return;

        const profile = AppState.profile;
        if (!profile || event.key === null) return;

        if (event.key === DataStore.getStorageKey(profile)) {
            // 同一档案的数据在其他标签页被修改：重新载入，避免之后用本页的旧数据覆盖
            AppState.data = DataStore.load(profile);
            if (!AppState.isSummaryView && !AppState.getCurrentProject()) {
                AppState.isSummaryView = true;
                AppState.currentProjectId = null;
            }
            this.render();
        } else if (event.key.endsWith(`_${profile}`)) {
            // 当前档案的云端同步设置在其他标签页被修改
            CloudAPI.init();
            this.updateUserDisplay();
        }
    },

    // 当前档案已在其他标签页切换或退出时，本页跟随切换，避免把旧档案的数据写入新档案或其云端。
    // 返回 true 表示发生了切换，调用方应放弃原操作。
    followActiveProfile() {
        const profile = UserManager.getCurrentUser();
        if (profile === AppState.profile) return false;

        AppState.cancelAutoSync();
        CloudAPI.init();
        // 打开的表单仍是旧档案的内容
        this.closeAllModals();
        AppState.loadProfile(profile);
        this.elements.loginModal.classList.toggle('active', !profile);
        this.elements.loginUsername.value = '';
        this.updateUserDisplay();
        this.render();
        this.showToast(profile ? `已在其他标签页切换到档案：${profile}` : '已在其他标签页退出登录', 'warning');
        return true;
    },

    closeAllModals() {
        [this.elements.taskModal, this.elements.projectModal, this.elements.settingsModal,
            this.elements.exportModal, this.elements.overdueModal].forEach(modal => modal.classList.remove('active'));
        document.querySelector('.preview-fullscreen-overlay')?.remove();
    },

    checkLoginStatus() {
        if (UserManager.isLoggedIn()) {
            // 已登录，隐藏登录框
            this.elements.loginModal.classList.remove('active');
            this.updateUserDisplay();
        } else {
            // 未登录，显示登录框
            this.elements.loginModal.classList.add('active');
        }
    },

    // ==========================================
    // 汇总视图
    // ==========================================

    enterSummaryView() {
        AppState.isSummaryView = true;
        AppState.currentProjectId = null;

        // 完整渲染：同时刷新侧边栏（项目列表、任务数和选中状态）
        this.render();
    },

    renderSummaryView() {
        // 收集所有项目的未完成任务
        const allTasks = [];
        AppState.data.projects.forEach(project => {
            (project.tasks || []).forEach(task => {
                if (!this.isTaskCompleted(task)) {
                    allTasks.push({
                        ...task,
                        projectId: project.id,
                        projectName: project.name
                    });
                }
            });
        });

        // 按截止时间排序（早的在前）
        allTasks.sort((a, b) => DateUtils.parse(a.endDate) - DateUtils.parse(b.endDate));

        // 更新标题
        this.elements.currentProjectName.textContent = '汇总视图';
        this.elements.addTaskBtn.disabled = true;

        if (allTasks.length === 0) {
            this.elements.emptyState.style.display = 'block';
            this.elements.ganttHeader.style.display = 'none';
            this.elements.ganttBody.style.display = 'none';
            return;
        }

        this.elements.emptyState.style.display = 'none';
        this.elements.ganttHeader.style.display = 'flex';
        this.elements.ganttBody.style.display = 'block';

        // 计算时间范围
        const timeRange = this.calculateTimeRange(allTasks);

        // 渲染时间轴头部
        this.renderTimelineHeader(timeRange);

        // 渲染任务（不排序，因为已经排好了）
        this.renderSummaryTasks(allTasks, timeRange);
    },

    renderSummaryTasks(tasks, timeRange) {
        // 与 renderTasks 共用定位逻辑，但点击后跳转到所属项目
        const cellWidth = this.getCellWidth(timeRange.viewMode);
        const gridHtml = this.renderGridHtml(timeRange, cellWidth);

        this.elements.ganttTasks.innerHTML = tasks.map(task => {
            const { left, width } = this.calculateBarPosition(task, timeRange, cellWidth);
            const tooltipTime = this.formatTaskTime(task);
            const tooltipNotes = task.notes?.trim() || '';

            return `
                <div class="gantt-task-row" data-task-id="${this.escapeHtml(task.id)}" data-project-id="${this.escapeHtml(task.projectId)}">
                    <div class="task-info">
                        <span class="task-name">${this.escapeHtml(task.name)}</span>
                    </div>
                    <div class="task-timeline">
                        <div class="timeline-grid">
                            ${gridHtml}
                        </div>
                        <div class="gantt-bar"
                             style="left: ${left}px; width: ${width}px; background: ${this.safeColor(task.color)};"
                             data-task-id="${this.escapeHtml(task.id)}"
                             data-project-id="${this.escapeHtml(task.projectId)}"
                             data-tooltip-time="${this.escapeHtml(tooltipTime)}"
                             data-tooltip-notes="${this.escapeHtml(tooltipNotes)}">
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // 新渲染的任务行滚动位置为 0，需与表头当前位置对齐
        this.syncScroll(this.elements.timelineHeader.scrollLeft);

        // 绑定点击事件 - 跳转到项目视图
        this.elements.ganttTasks.querySelectorAll('.gantt-task-row').forEach(row => {
            row.addEventListener('click', () => {
                const projectId = row.dataset.projectId;
                const taskId = row.dataset.taskId;
                this.navigateToTask(projectId, taskId);
            });
        });

        this.elements.ganttTasks.querySelectorAll('.gantt-bar').forEach(bar => {
            bar.addEventListener('click', (e) => {
                e.stopPropagation();
                const projectId = bar.dataset.projectId;
                const taskId = bar.dataset.taskId;
                this.navigateToTask(projectId, taskId);
            });
        });

        // 绑定 Tooltip 事件
        this.bindTooltipEvents();
    },

    navigateToTask(projectId, taskId) {
        // 切换到项目视图
        AppState.isSummaryView = false;
        this.selectProject(projectId);

        // 滚动到任务并高亮
        setTimeout(() => {
            const taskRow = document.querySelector(`.gantt-task-row[data-task-id="${CSS.escape(taskId)}"]`);
            if (taskRow) {
                taskRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                taskRow.style.background = 'rgba(99, 102, 241, 0.3)';
                setTimeout(() => {
                    taskRow.style.background = '';
                }, 2000);
            }
        }, 100);
    },

    // ==========================================
    // 过期任务处理
    // ==========================================

    checkOverdueTasks() {
        const today = DateUtils.startOfDay(new Date());
        const overdueTasks = [];

        AppState.data.projects.forEach(project => {
            (project.tasks || []).forEach(task => {
                if (this.isTaskCompleted(task)) return;

                if (DateUtils.startOfDay(task.endDate) < today) {
                    overdueTasks.push({
                        ...task,
                        projectId: project.id,
                        projectName: project.name
                    });
                }
            });
        });

        return overdueTasks;
    },

    showOverdueModal(overdueTasks) {
        if (overdueTasks.length === 0) return;

        const formatDate = (dateStr) => {
            const d = DateUtils.parse(dateStr);
            return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
        };

        this.elements.overdueTaskList.innerHTML = overdueTasks.map(task => `
            <div class="overdue-task-item" data-task-id="${this.escapeHtml(task.id)}" data-project-id="${this.escapeHtml(task.projectId)}">
                <div class="overdue-task-header">
                    <div>
                        <div class="overdue-task-name">${this.escapeHtml(task.name)}</div>
                        <div class="overdue-task-project">${this.escapeHtml(task.projectName)}</div>
                    </div>
                    <div class="overdue-task-date">过期于 ${formatDate(task.endDate)}</div>
                </div>
                <div class="overdue-actions">
                    <button class="overdue-action-btn" data-action="extend" data-days="1">+1天</button>
                    <button class="overdue-action-btn" data-action="extend" data-days="3">+3天</button>
                    <button class="overdue-action-btn" data-action="extend" data-days="7">+1周</button>
                    <button class="overdue-action-btn" data-action="custom">自定义</button>
                    <button class="overdue-action-btn complete-btn" data-action="complete">标记完成</button>
                </div>
            </div>
        `).join('');

        // 绑定操作按钮事件
        this.elements.overdueTaskList.querySelectorAll('.overdue-action-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const taskItem = btn.closest('.overdue-task-item');
                let { action, days } = btn.dataset;

                if (action === 'custom') {
                    const input = prompt('请输入延长的天数（1-365）：', '7');
                    // 取消输入时保留原有选择
                    if (input === null) return;
                    const value = Number(input.trim());
                    if (!Number.isInteger(value) || value < 1 || value > 365) {
                        this.showToast('请输入 1 到 365 之间的整数天数', 'warning');
                        return;
                    }
                    action = 'extend';
                    days = String(value);
                    btn.textContent = `+${value}天`;
                }

                // 同一任务只保留当前选中的操作
                taskItem.querySelectorAll('.overdue-action-btn').forEach(b => b.classList.toggle('active', b === btn));
                taskItem.dataset.selectedAction = action;
                taskItem.dataset.extendDays = days || '';
            });
        });

        this.elements.overdueModal.classList.add('active');
    },

    // 延长过期任务：新的截止日期为"今天 + days 天"（保留原时刻）。若在已过去的截止日期上累加，
    // 过期较久的任务延期后仍然过期。开始时间已过去时按相同天数平移，保持任务时长。
    extendOverdueTask(task, days, now = new Date()) {
        const endDate = DateUtils.parse(task.endDate);
        const shift = Math.max(0, DateUtils.daysBetween(endDate, now)) + days;
        endDate.setDate(endDate.getDate() + shift);
        task.endDate = DateUtils.toInputValue(endDate);

        const startDate = DateUtils.parse(task.startDate);
        if (startDate < now) {
            startDate.setDate(startDate.getDate() + shift);
            task.startDate = DateUtils.toInputValue(startDate);
        }
    },

    confirmOverdueActions() {
        const taskItems = this.elements.overdueTaskList.querySelectorAll('.overdue-task-item');
        let hasChanges = false;

        taskItems.forEach(item => {
            const taskId = item.dataset.taskId;
            const projectId = item.dataset.projectId;
            const action = item.dataset.selectedAction;

            if (!action) return;

            const project = AppState.data.projects.find(p => p.id === projectId);
            if (!project) return;

            const task = project.tasks.find(t => t.id === taskId);
            if (!task) return;

            if (action === 'complete') {
                // 与勾选完成一致：周期任务会创建下一个周期
                this.completeTask(project, task);
                hasChanges = true;
            } else if (action === 'extend') {
                this.extendOverdueTask(task, parseInt(item.dataset.extendDays) || 1);
                hasChanges = true;
            }
        });

        if (hasChanges) {
            AppState.save();
            this.showToast('过期任务已处理', 'success');
        }

        this.elements.overdueModal.classList.remove('active');

        // 进入汇总视图
        this.enterSummaryView();
    },

    // ==========================================
    // 导出功能
    // ==========================================

    // 获取导出数据（支持汇总视图和项目视图）
    getExportData() {
        if (AppState.isSummaryView) {
            // 汇总视图：收集所有未完成任务
            const allTasks = [];
            AppState.data.projects.forEach(project => {
                (project.tasks || []).forEach(task => {
                    if (!this.isTaskCompleted(task)) {
                        allTasks.push(this.toExportTask(task));
                    }
                });
            });

            // 按截止时间排序
            allTasks.sort((a, b) => DateUtils.parse(a.endDate) - DateUtils.parse(b.endDate));

            return {
                name: '汇总视图',
                tasks: allTasks
            };
        } else {
            // 项目视图：过滤掉已完成任务
            const project = AppState.getCurrentProject();
            if (!project) return null;

            const incompleteTasks = (project.tasks || [])
                .filter(task => !this.isTaskCompleted(task))
                .map(task => this.toExportTask(task));

            return {
                name: project.name,
                tasks: incompleteTasks
            };
        }
    },

    // 导出用的任务副本：日期统一为本地时间字符串，颜色与页面显示一致
    toExportTask(task) {
        return {
            ...task,
            startDate: DateUtils.toInputValue(task.startDate),
            endDate: DateUtils.toInputValue(task.endDate),
            color: this.safeColor(task.color)
        };
    },

    openExportModal() {
        const exportData = this.getExportData();
        if (!exportData || !exportData.tasks || exportData.tasks.length === 0) {
            this.showToast('没有未完成的任务可导出', 'warning');
            return;
        }
        this.elements.exportModal.classList.add('active');
        this.updateExportPreview();
    },

    closeExportModal() {
        this.elements.exportModal.classList.remove('active');
    },

    async updateExportPreview() {
        const exportData = this.getExportData();
        if (!exportData) return;

        // 显示加载占位符
        this.elements.exportPreview.innerHTML = '<div class="preview-placeholder">生成预览中...</div>';

        try {
            // 获取选择的配置
            const sizeRadio = document.querySelector('input[name="exportSize"]:checked');
            const versionRadio = document.querySelector('input[name="exportVersion"]:checked');
            const styleRadio = document.querySelector('input[name="exportStyle"]:checked');
            const size = sizeRadio ? sizeRadio.value : 'a4-landscape';
            const version = versionRadio ? versionRadio.value : 'simple';
            const style = styleRadio ? styleRadio.value : 'dark';

            // 创建预览画布（缩小版本）- 使用增强版导出
            const canvas = await EnhancedExport.createCanvas(exportData, size, version, style);

            // 创建缩略图
            const previewCanvas = document.createElement('canvas');
            const maxWidth = 400;
            const maxHeight = 300;
            const scale = Math.min(maxWidth / canvas.width, maxHeight / canvas.height);

            previewCanvas.width = canvas.width * scale;
            previewCanvas.height = canvas.height * scale;

            const ctx = previewCanvas.getContext('2d');
            ctx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);

            // 添加样式和点击事件
            previewCanvas.style.cursor = 'pointer';
            previewCanvas.style.border = '1px solid var(--border-color)';
            previewCanvas.style.borderRadius = 'var(--radius-md)';
            previewCanvas.title = '点击查看大图';

            previewCanvas.addEventListener('click', () => {
                this.showFullscreenPreview(canvas);
            });

            // 显示预览
            this.elements.exportPreview.innerHTML = '';
            this.elements.exportPreview.appendChild(previewCanvas);
        } catch (error) {
            console.error('预览生成失败:', error);
            this.elements.exportPreview.innerHTML = '<div class="preview-placeholder">预览生成失败</div>';
        }
    },

    showFullscreenPreview(canvas) {
        // 创建全屏覆盖层
        const overlay = document.createElement('div');
        overlay.className = 'preview-fullscreen-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.9);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            cursor: pointer;
            animation: fadeIn 0.2s ease;
        `;

        // 创建图片容器
        const imgContainer = document.createElement('div');
        imgContainer.style.cssText = `
            max-width: 90vw;
            max-height: 90vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 16px;
        `;

        // 创建全尺寸图片
        const fullImg = document.createElement('img');
        fullImg.src = canvas.toDataURL('image/png');
        fullImg.style.cssText = `
            max-width: 100%;
            max-height: calc(90vh - 60px);
            object-fit: contain;
            border-radius: 8px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        `;

        // 创建关闭提示
        const closeHint = document.createElement('div');
        closeHint.textContent = '点击任意位置关闭';
        closeHint.style.cssText = `
            color: white;
            font-size: 14px;
            opacity: 0.8;
        `;

        imgContainer.appendChild(fullImg);
        imgContainer.appendChild(closeHint);
        overlay.appendChild(imgContainer);

        // 点击关闭
        overlay.addEventListener('click', () => {
            overlay.style.animation = 'fadeOut 0.2s ease';
            setTimeout(() => overlay.remove(), 200);
        });

        // 阻止图片点击事件冒泡
        imgContainer.addEventListener('click', (e) => e.stopPropagation());

        document.body.appendChild(overlay);
    },

    async doExport() {
        const exportData = this.getExportData();
        if (!exportData) return;

        const exportBtn = this.elements.doExport;
        const btnText = exportBtn.querySelector('.export-btn-text');
        const btnLoading = exportBtn.querySelector('.export-btn-loading');

        // 显示加载状态
        btnText.style.display = 'none';
        btnLoading.style.display = 'inline-flex';
        exportBtn.disabled = true;

        try {
            // 获取选择的配置
            const sizeRadio = document.querySelector('input[name="exportSize"]:checked');
            const versionRadio = document.querySelector('input[name="exportVersion"]:checked');
            const styleRadio = document.querySelector('input[name="exportStyle"]:checked');
            const size = sizeRadio ? sizeRadio.value : 'a4-landscape';
            const version = versionRadio ? versionRadio.value : 'simple';
            const style = styleRadio ? styleRadio.value : 'dark';

            // 创建导出画布 - 使用增强版导出
            const canvas = await EnhancedExport.createCanvas(exportData, size, version, style);

            // 下载图片
            const link = document.createElement('a');
            link.download = `${exportData.name}_甘特图_${DateUtils.toInputValue(new Date()).slice(0, 10)}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();

            this.showToast('导出成功！', 'success');
            this.closeExportModal();
        } catch (error) {
            console.error('导出失败:', error);
            this.showToast('导出失败: ' + error.message, 'error');
        } finally {
            btnText.style.display = 'inline';
            btnLoading.style.display = 'none';
            exportBtn.disabled = false;
        }
    }
};

// ==========================================
// 初始化应用
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    UI.cacheElements();
    UI.bindEvents();

    // 其他标签页切换档案或修改数据时保持同步
    window.addEventListener('storage', (event) => UI.handleStorageChange(event));

    // 检查登录状态
    UI.checkLoginStatus();

    // 只有已登录才加载数据
    if (UserManager.isLoggedIn()) {
        AppState.init();
        UI.render();

        // 更新自动同步状态显示
        const statusEl = document.getElementById('autoSyncStatus');
        const textEl = statusEl?.querySelector('.sync-text');
        if (statusEl && textEl) {
            if (CloudAPI.isConfigured()) {
                statusEl.classList.remove('disabled');
                textEl.textContent = '自动同步已启用';
            } else {
                statusEl.classList.add('disabled');
                textEl.textContent = '未配置云端';
            }
        }
    }
});
