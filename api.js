/**
 * 云端同步 API 模块
 * 使用 JSONBin.io 作为免费云端存储
 */

const CloudAPI = {
    // JSONBin.io 配置
    baseUrl: 'https://api.jsonbin.io/v3',
    apiKey: null,
    binId: null,

    /**
     * 获取当前用户的 Bin ID 存储 key
     */
    getBinIdKey() {
        const username = localStorage.getItem('gantt_current_user') || 'default';
        return `jsonbin_bin_id_${username}`;
    },

    getProfileKey(key) {
        const username = localStorage.getItem('gantt_current_user');
        return username ? `${key}_${username}` : null;
    },

    getProfileSetting(key) {
        const storageKey = this.getProfileKey(key);
        return storageKey ? localStorage.getItem(storageKey) : null;
    },

    saveProfileSetting(key, value) {
        const storageKey = this.getProfileKey(key);
        if (!storageKey) return;
        if (value) localStorage.setItem(storageKey, value);
        else localStorage.removeItem(storageKey);
    },

    /**
     * 初始化 API 配置
     */
    init() {
        // Migrate legacy global settings once, into the active local profile.
        // Keeping the old global fallback would share credentials across profiles.
        if (localStorage.getItem('gantt_current_user')) {
            for (const key of ['jsonbin_api_key', 'notification_email', 'master_bin_id']) {
                const legacy = localStorage.getItem(key);
                if (legacy !== null) {
                    if (this.getProfileSetting(key) === null) this.saveProfileSetting(key, legacy);
                    localStorage.removeItem(key);
                }
            }
        }
        this.apiKey = this.getProfileSetting('jsonbin_api_key') || null;
        this.binId = localStorage.getItem('gantt_current_user')
            ? localStorage.getItem(this.getBinIdKey()) || null : null;
    },

    /**
     * 检查是否已配置
     */
    isConfigured() {
        return this.apiKey !== null && this.apiKey !== '';
    },

    /**
     * 保存配置
     */
    saveConfig(apiKey, binId = null) {
        this.apiKey = apiKey || null;
        this.binId = binId;
        this.saveProfileSetting('jsonbin_api_key', apiKey);
        if (binId) {
            localStorage.setItem(this.getBinIdKey(), binId);
        } else localStorage.removeItem(this.getBinIdKey());
    },

    /**
     * 获取配置
     */
    getConfig() {
        this.init();
        return {
            apiKey: this.apiKey,
            binId: this.binId
        };
    },

    /**
     * 创建新的 Bin
     */
    async createBin(data) {
        if (!this.apiKey) {
            throw new Error('未配置 API Key');
        }

        // Do not put profile names in provider metadata or non-ASCII HTTP headers.
        const binName = `gantt-${Date.now()}`;
        const storageKey = this.getBinIdKey();

        const response = await fetch(`${this.baseUrl}/b`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': this.apiKey,
                'X-Bin-Name': binName,
                'X-Bin-Private': 'true'
            },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || '创建存储失败');
        }

        const result = await response.json();
        const binId = result.metadata.id;
        localStorage.setItem(storageKey, binId);
        if (storageKey === this.getBinIdKey()) this.binId = binId;
        return result;
    },

    /**
     * 读取数据
     */
    validateData(data) {
        if (!data || !Array.isArray(data.projects)) throw new Error('云端项目数据格式无效');
        for (const project of data.projects) {
            if (!project || typeof project.id !== 'string' || typeof project.name !== 'string' || !Array.isArray(project.tasks)) {
                throw new Error('云端项目数据格式无效');
            }
            for (const task of project.tasks) {
                if (!task || typeof task.id !== 'string' || typeof task.name !== 'string' ||
                    typeof task.startDate !== 'string' || typeof task.endDate !== 'string' ||
                    !Number.isFinite(new Date(task.startDate).getTime()) || !Number.isFinite(new Date(task.endDate).getTime()) ||
                    new Date(task.startDate) > new Date(task.endDate)) {
                    throw new Error('云端任务数据格式无效');
                }
            }
        }
        return data;
    },

    async readData() {
        if (!this.apiKey || !this.binId) {
            throw new Error('未配置 API Key 或 Bin ID');
        }

        const response = await fetch(`${this.baseUrl}/b/${this.binId}/latest`, {
            method: 'GET',
            headers: {
                'X-Master-Key': this.apiKey
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || '读取数据失败');
        }

        const result = await response.json();
        return this.validateData(result.record);
    },

    /**
     * 更新数据
     */
    async updateData(data) {
        if (!this.apiKey) {
            throw new Error('未配置 API Key');
        }

        // 如果没有 Bin ID，先创建一个
        if (!this.binId) {
            return this.createBin(data);
        }

        const response = await fetch(`${this.baseUrl}/b/${this.binId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': this.apiKey
            },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || '保存数据失败');
        }

        return response.json();
    },

    /**
     * 同步数据（智能合并）
     */
    async syncData(localData) {
        try {
            if (!this.isConfigured()) {
                // 未配置时仅使用本地存储
                return { success: true, data: localData, synced: false };
            }

            if (!this.binId) {
                // 首次同步，创建新 Bin
                await this.createBin(localData);
                // 注册到主控 Bin
                await this.registerToMasterBin();
                return { success: true, data: localData, synced: true, message: '已创建云端存储' };
            }

            // 读取云端数据
            const cloudData = await this.readData();

            // 简单合并策略：使用最新修改的数据
            const localTime = localData.lastModified || 0;
            const cloudTime = cloudData.lastModified || 0;

            if (localTime > cloudTime) {
                // 本地数据更新，上传到云端
                await this.updateData(localData);
                return { success: true, data: localData, synced: true, message: '已同步到云端' };
            } else if (cloudTime > localTime) {
                // 云端数据更新，下载到本地
                return { success: true, data: cloudData, synced: true, message: '已从云端同步' };
            } else {
                // 数据相同，无需同步
                return { success: true, data: localData, synced: true, message: '数据已是最新' };
            }
        } catch (error) {
            console.error('同步失败:', error);
            return { success: false, data: localData, synced: false, error: error.message };
        }
    },

    /**
     * 主控 Bin ID（用于存储所有用户的 Bin ID 列表）
     * Worker 会从这个 Bin 读取所有用户的 Bin ID
     */
    MASTER_BIN_ID: null, // 将在首次创建时设置

    /**
     * 注册当前用户的 Bin ID 到主控 Bin
     */
    async registerToMasterBin() {
        if (!this.apiKey || !this.binId) return;
        const apiKey = this.apiKey;
        const binId = this.binId;

        try {
            // 获取或创建主控 Bin ID
            const masterBinId = this.getProfileSetting('master_bin_id');

            if (!masterBinId) {
                // 尝试读取用户之前保存的主控 Bin ID
                // 如果没有，需要手动设置或首次创建
                console.log('提示: 如需启用邮件提醒，请在设置中配置主控 Bin ID');
                return;
            }

            // 读取主控 Bin 当前数据
            const response = await fetch(`${this.baseUrl}/b/${masterBinId}/latest`, {
                headers: { 'X-Master-Key': apiKey }
            });

            if (!response.ok) throw new Error(`读取主控 Bin 失败: ${response.status}`);
            const data = await response.json();
            const binIds = Array.isArray(data.record) ? data.record : data.record?.binIds;
            if (!Array.isArray(binIds) || binIds.some(id => typeof id !== 'string')) {
                throw new Error('主控 Bin 数据格式无效');
            }

            // 添加当前用户的 Bin ID（如果不存在）
            if (!binIds.includes(binId)) {
                binIds.push(binId);

                // 更新主控 Bin
                const update = await fetch(`${this.baseUrl}/b/${masterBinId}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Master-Key': apiKey
                    },
                    body: JSON.stringify({ binIds, lastUpdated: Date.now() })
                });
                if (!update.ok) throw new Error(`更新主控 Bin 失败: ${update.status}`);

                console.log('已注册到主控 Bin');
            }
        } catch (error) {
            console.error('注册到主控 Bin 失败:', error);
            // 不抛出错误，不影响正常上传
        }
    },

    /**
     * 创建主控 Bin（仅需执行一次）
     */
    async createMasterBin() {
        if (!this.apiKey) {
            throw new Error('未配置 API Key');
        }
        const storageKey = this.getProfileKey('master_bin_id');

        const response = await fetch(`${this.baseUrl}/b`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': this.apiKey,
                'X-Bin-Name': 'gantt-master-registry',
                'X-Bin-Private': 'true'
            },
            body: JSON.stringify({ binIds: [], createdAt: Date.now() })
        });

        if (!response.ok) {
            throw new Error('创建主控 Bin 失败');
        }

        const result = await response.json();
        const masterBinId = result.metadata.id;
        localStorage.setItem(storageKey, masterBinId);
        return masterBinId;
    }
};

// 初始化
CloudAPI.init();
