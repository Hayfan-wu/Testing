/**
 * ============================================================
 *  中国移动云盘 (mCloud) — 云朵任务自动脚本  (青龙面板版)
 * ============================================================
 *
 *  逆向来源:  mCloud_13.1.1 (com.chinamobile.mcloud)
 *  活动平台:  yunClound H5 营销中台  (https://m.mcloud.139.com/portal/yunClound/)
 *  接口前缀:  /ycloud/...
 *
 *  ┌─ 环境变量 (青龙 → 环境变量) ───────────────────────────────┐
 *  │ MCLOUD_TOKEN        必填。ssoToken(推荐) 或 jwtToken       │
 *  │ MCLOUD_TOKEN_TYPE   token 类型: sso(默认, 自动换发) / jwt   │
 *  │ MCLOUD_MARKET       活动名称, 默认 National_Activity        │
 *  │ MCLOUD_PHONE        手机号(可选, 用于广告点击上报)          │
 *  │ MCLOUD_DEVICE_ID    设备ID(可选, 随机生成也可)              │
 *  │ MCLOUD_SOURCE_ID    来源ID(可选, 默认 001005)               │
 *  │ MCLOUD_NOTIFY       是否推送通知, 默认 true                 │
 *  └────────────────────────────────────────────────────────────┘
 *
 *  多账号:  用换行或 & 分隔多个 token
 *
 *  cron:  30 8 * * *
 *  ============================================================
 */

const https = require('https');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

// ==================== 全局配置 ====================

const BASE_HOST = 'm.mcloud.139.com';
const BASE_URL = `https://${BASE_HOST}`;
const SIGN_SECRET = 'sekaMdYYLIZfbCfm';   // 逆向自 H5: String.fromCodePoint([...])
const APP_VERSION = '13.1.1.0';           // UA 中 mcloudapp/13.1.1 → 归一化为 4 段
const UA = `Mozilla/5.0 (Linux; Android 13; PGKM10 Build/TKQ1.220829.002; wv) `
         + `AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.0.0 `
         + `Mobile Safari/537.36 mcloudapp/13.1.1 139PE_WebView_Android_1.0.3`;

// ==================== jwtToken 缓存 (ssoToken 换发结果) ====================
// 青龙面板无持久存储, 使用同进程内缓存 + 青龙环境变量回写 (若支持)
// 缓存结构: { [ssoTokenHash]: { jwtToken, expireAt, userDomainId } }
const JWT_CACHE = {};
const JWT_TTL_MS = 6 * 60 * 60 * 1000;   // 预估 jwtToken 有效期 6 小时, 到期前提前换发
const JWT_REFRESH_AHEAD_MS = 30 * 60 * 1000;  // 提前 30 分钟换发, 避免边界失效

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function getCachedJwt(ssoToken) {
    const key = hashToken(ssoToken);
    const entry = JWT_CACHE[key];
    if (!entry) return null;
    if (Date.now() >= entry.expireAt - JWT_REFRESH_AHEAD_MS) {
        log(`jwtToken 缓存即将过期, 重新换发`);
        return null;
    }
    return entry;
}

function setCachedJwt(ssoToken, jwtToken, userDomainId) {
    const key = hashToken(ssoToken);
    JWT_CACHE[key] = {
        jwtToken,
        expireAt: Date.now() + JWT_TTL_MS,
        userDomainId,
        createdAt: Date.now(),
    };
    return JWT_CACHE[key];
}

// ==================== 环境变量读取 ====================

const ENV = process.env || {};
const RAW_TOKENS = ENV.MCLOUD_TOKEN || ENV.mcloud_token || '';
const TOKEN_TYPE = (ENV.MCLOUD_TOKEN_TYPE || ENV.mcloud_token_type || 'sso').toLowerCase();
const MARKET_NAME = ENV.MCLOUD_MARKET || ENV.mcloud_market || 'National_Activity';
const PHONE = ENV.MCLOUD_PHONE || ENV.mcloud_phone || '';
const DEVICE_ID = ENV.MCLOUD_DEVICE_ID || ENV.mcloud_device_id || randomDeviceId();
const SOURCE_ID = ENV.MCLOUD_SOURCE_ID || ENV.mcloud_source_id || '001005';
const NOTIFY = (ENV.MCLOUD_NOTIFY || 'true') !== 'false';

// ==================== 工具函数 ====================

function randomDeviceId() {
    return crypto.randomBytes(8).toString('hex') + crypto.randomBytes(8).toString('hex');
}

function uuid() {
    return crypto.randomUUID();
}

function nowMs() {
    return Date.now();
}

function md5(str) {
    return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
    const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log(`[${ts}] ${msg}`);
}

// ==================== HTTP 请求封装 ====================

/**
 * 发送 HTTPS 请求
 * @param {string} method  GET / POST
 * @param {string} path    接口路径 (以 / 开头)
 * @param {object} opts    { params, body, headers, sign }
 *   opts.sign: 签名配置 { payload } — 对需要签名的接口传入待签名字符串
 */
function request(method, path, opts = {}) {
    return new Promise((resolve, reject) => {
        let fullPath = path;
        // query params
        if (opts.params && Object.keys(opts.params).length) {
            const sp = new URLSearchParams();
            for (const [k, v] of Object.entries(opts.params)) {
                if (v !== undefined && v !== null) sp.append(k, String(v));
            }
            fullPath += (path.includes('?') ? '&' : '?') + sp.toString();
        }

        // 默认请求头
        const headers = {
            'User-Agent': UA,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Referer': `${BASE_URL}/portal/yunClound/index.html?path=${encodeURIComponent(MARKET_NAME)}`,
            'Origin': BASE_URL,
            ...opts.headers,
        };

        // body
        let bodyData = null;
        if (opts.body !== undefined && opts.body !== null) {
            bodyData = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
            if (headers['Content-Type'] && headers['Content-Type'].includes('json')) {
                headers['Content-Length'] = Buffer.byteLength(bodyData);
            }
        }

        const reqOpts = {
            hostname: BASE_HOST,
            port: 443,
            path: fullPath,
            method,
            headers,
        };

        const req = https.request(reqOpts, (res) => {
            let chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let data;
                try {
                    data = JSON.parse(raw);
                } catch {
                    data = raw;
                }
                resolve({ status: res.statusCode, headers: res.headers, data });
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(new Error('请求超时')); });
        if (bodyData) req.write(bodyData);
        req.end();
    });
}

// ==================== 签名生成 ====================

/**
 * 生成 ycloud 签名头 (用于 tyrzLogin / querySpecToken 等敏感接口)
 *
 * 签名算法 (逆向自 H5 shared chunk):
 *   signature = MD5( secret + requestId + timestamp + nonce + payload + secret )
 *
 * @param {string} payload  参与签名的负载字符串 (GET=queryString, POST 部分接口为空串)
 */
function signedHeaders(payload = '') {
    const requestId = uuid();
    const timestamp = String(nowMs());
    const nonce = uuid();
    const signStr = SIGN_SECRET + requestId + timestamp + nonce + payload + SIGN_SECRET;
    const signature = md5(signStr);
    return {
        'x-request-id': requestId,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': signature,
    };
}

// ==================== API 接口定义 ====================

const Api = {
    // ---- 登录 / 鉴权 ----

    /**
     * SSO Token 登录 → 获取 jwtToken
     * POST /ycloud/auth-service/auth/tyrzLogin  (签名接口, payload 为空串)
     * 返回 result.token 即后续使用的 jwtToken
     */
    async tyrzLogin(ssoToken, marketName) {
        const body = {
            token: ssoToken,
            openAccount: false,
            channelSrc: 'app',
            marketName: marketName,
            sourceId: SOURCE_ID,
        };
        // 逆向确认: tyrzLogin2 签名时 y="" (body 不参与签名)
        const sign = signedHeaders('');
        const res = await request('POST', '/ycloud/auth-service/auth/tyrzLogin', {
            body: JSON.stringify(body),
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                type: 'signupPlatform',
                showLoading: true,
                ...sign,
            },
        });
        return res;
    },

    /**
     * 查询指定 Token (签名接口)
     * GET /ycloud/api/cloud/userdomain/v2/querySpecToken
     */
    async querySpecToken(params) {
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) sp.append(k, String(v));
        }
        const qs = sp.toString();
        // querySpecToken 签名时 payload 为空 (逆向确认)
        const sign = signedHeaders('');
        const res = await request('GET', '/ycloud/api/cloud/userdomain/v2/querySpecToken', {
            params,
            headers: { 'Content-Type': 'application/json', ...sign },
        });
        return res;
    },

    // ---- 活动配置 ----

    /** 获取活动配置 (含广告位、规则等) */
    getMarketConfig(marketName) {
        return request('GET', '/ycloud/manager/commonMarketconfig/getByMarketName', {
            params: { marketName },
        });
    },

    /** 获取活动规则信息 */
    getActivityConfig(marketName) {
        return request('GET', '/ycloud/manager/commonMarketconfig/getActivityConfig', {
            params: { marketName },
        });
    },

    /** 活动校验 (是否在有效期) */
    validate(marketName) {
        return request('GET', '/ycloud/manager/commonMarketconfig/validate', {
            params: { marketName, mustLogin: 'true' },
        });
    },

    /** 白名单校验 */
    validateWhitePhone(marketName) {
        return request('GET', '/ycloud/manager/commonMarketconfig/v2/validateWhitePhone', {
            params: { marketName },
        });
    },

    /** 获取活动规则 */
    getRuleInfo(marketName, flag = 1) {
        return request('GET', '/ycloud/manager/commonMarketconfig/getRuleInfo', {
            params: { marketName, flag },
        });
    },

    // ---- 广告 / 任务 ----

    /**
     * 获取广告/任务信息
     * POST /ycloud/advert/getAdInfo
     * @param {object} body  { client, adPosIdList }
     */
    getAdInfo(body) {
        return request('POST', '/ycloud/advert/getAdInfo', {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        });
    },

    /** 获取广告位信息 (旧) */
    getAdvertInfo(body) {
        return request('POST', '/ycloud/advert/getAdvertInfo', {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        });
    },

    /** 广告展示上报 */
    showReport(body) {
        return request('POST', '/ycloud/advert/show/report', {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        });
    },

    /** 广告点击上报 */
    clickReport(body) {
        return request('POST', '/ycloud/advert/click/report', {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        });
    },

    // ---- 浏览 / 收集任务 (核心赚云朵) ----

    /** 浏览广告 — 完成浏览任务赚云朵 */
    view(advertId) {
        return request('GET', '/ycloud/api/activity/view', {
            params: { advertId },
        });
    },

    /** 删除浏览记录 */
    deleteView(advertId) {
        return request('GET', '/ycloud/api/activity/view/delete', {
            params: { advertId },
            headers: { 'Content-Type': 'application/json' },
        });
    },

    /** 收藏广告 */
    collect(advertId) {
        return request('GET', '/ycloud/api/activity/collect', {
            params: { advertId },
            headers: { 'Content-Type': 'application/json' },
        });
    },

    /** 取消收藏 */
    uncollect(advertId) {
        return request('GET', '/ycloud/api/activity/uncollect', {
            params: { advertId },
            headers: { 'Content-Type': 'application/json' },
        });
    },

    /** 获取收藏列表 */
    getCollectList() {
        return request('GET', '/ycloud/api/activity/collect/list', {
            headers: { 'Content-Type': 'application/json' },
        });
    },

    /** 获取浏览历史 */
    getViewList() {
        return request('GET', '/ycloud/api/activity/history', {
            headers: { 'Content-Type': 'application/json' },
        });
    },

    /** 获取标签列表 */
    getLabelList() {
        return request('GET', '/ycloud/api/activity/labels');
    },

    /** 是否新用户 */
    isNewUser() {
        return request('GET', '/ycloud/api/activity/isNewUser');
    },

    // ---- 云朵记录 / 奖品 ----

    /** 查询云朵记录 (云朵余额/获取记录) */
    listCloudRecord() {
        return request('GET', '/ycloud/mcloudday/blindbox/listCloudRecord');
    },

    /** 奖品池列表 */
    getPrizeList(params = {}) {
        return request('GET', '/ycloud/prize/prizepool/list', { params });
    },

    /** 我的奖品记录 */
    getMyPrizeList(params = {}) {
        return request('GET', '/ycloud/prizeApi/checkPrize/getUserPrizeLogPageV2', { params });
    },

    /** 奖品详情 */
    getPrizeDetail(params) {
        return request('GET', '/ycloud/prizeApi/checkPrize/receivePrizeDetailsV2', { params });
    },

    /** 奖品配置 */
    getPrizeConfig(id) {
        return request('GET', `/ycloud/prize/prizeconfigure/${id}`);
    },

    // ---- 其他 ----

    /** 埋点日志 */
    logPoint(body) {
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) sp.append(k, String(v));
        return request('POST', '/ycloud/visitlog/journaling', { body: sp.toString() });
    },

    /** 手机号查询 */
    mobileQuery(params) {
        return request('GET', '/ycloud/user-service/mobile/query', { params });
    },

    /** 获取公告 */
    getNotice(marketName) {
        return request('GET', '/ycloud/manager/util/notice', { params: { marketName } });
    },

    /** 是否维护中 */
    isMaintain(params) {
        return request('GET', '/ycloud/manager/commonMaintain/isMaintain', { params });
    },
};

// ==================== 账号执行器 ====================

class McloudAccount {
    constructor(token, type, marketName) {
        this.token = token.trim();
        this.type = type;
        this.marketName = marketName;
        this.jwtToken = '';
        this.deviceId = DEVICE_ID;
        this.phone = PHONE;
        this.results = { login: false, tasks: 0, cloudDrops: 0, prizes: [] };
    }

    /** 构建通用请求头 (携带 jwtToken / 活动ID / 设备ID / 版本) */
    commonHeaders(extra = {}) {
        return {
            jwtToken: this.jwtToken,
            activityId: this.marketName,
            deviceId: this.deviceId,
            appVersion: APP_VERSION,
            ...extra,
        };
    }

    /**
     * 带自动恢复的请求包装: 检测到 90001(未登录) 时自动重新换发 jwtToken 并重试一次
     * @param {function} fn  返回 Promise 的 API 调用, 如 () => Api.view(id)
     * @returns 请求结果
     */
    async withAuthRetry(fn) {
        let res;
        try {
            res = await fn();
        } catch (e) {
            // 网络异常不触发换发, 直接抛出
            throw e;
        }
        // 检测 jwtToken 失效 (90001)
        if (res && res.data && res.data.code === 90001) {
            log('请求返回 90001(jwtToken失效), 尝试自动恢复 ...');
            const ok = await this.refreshOnExpire();
            if (ok) {
                log('jwtToken 已自动恢复, 重试请求 ...');
                try {
                    res = await fn();
                } catch (e) {
                    log(`重试请求异常: ${e.message}`);
                }
            } else {
                log('jwtToken 自动恢复失败, 后续请求可能继续失败');
            }
        }
        return res;
    }

    /** 登录: ssoToken 模式自动换发 jwtToken (带缓存 + 失效重试) */
    async login() {
        if (this.type === 'sso') {
            return await this.loginBySso();
        }
        // jwt 模式直接使用
        this.jwtToken = this.token;
        log('使用 jwtToken 模式');
        return await this.verifyJwt();
    }

    /** ssoToken → jwtToken 自动换发 (优先用缓存) */
    async loginBySso() {
        // 1. 尝试命中缓存
        const cached = getCachedJwt(this.token);
        if (cached) {
            this.jwtToken = cached.jwtToken;
            const remainMin = Math.round((cached.expireAt - Date.now()) / 60000);
            log(`命中 jwtToken 缓存, 剩余有效期约 ${remainMin} 分钟`);
            // 验证缓存的 jwtToken 是否仍有效
            const valid = await this.verifyJwt(true);
            if (valid) return true;
            log('缓存的 jwtToken 已失效, 重新换发 ...');
        }

        // 2. 缓存未命中或已失效 → 调 tyrzLogin 换发
        return await this.exchangeJwt();
    }

    /** 调用 tyrzLogin 签名接口换发 jwtToken (含重试) */
    async exchangeJwt(retryCount = 0) {
        log(`使用 ssoToken 换发 jwtToken${retryCount > 0 ? ` (第${retryCount + 1}次尝试)` : ''} ...`);
        let res;
        try {
            res = await Api.tyrzLogin(this.token, this.marketName);
        } catch (e) {
            log(`tyrzLogin 请求异常: ${e.message}`);
            if (retryCount < 1) {
                log('等待 3 秒后重试 ...');
                await sleep(3000);
                return await this.exchangeJwt(retryCount + 1);
            }
            return false;
        }

        const data = res.data;
        if (data && data.code === 0 && data.result && data.result.token) {
            this.jwtToken = data.result.token;
            const udId = data.result.userDomainId || '';
            setCachedJwt(this.token, this.jwtToken, udId);
            log(`jwtToken 换发成功${udId ? `, userDomainId=${udId}` : ''}, 缓存 ${JWT_TTL_MS / 3600000} 小时`);
            this.results.login = true;
            return true;
        }

        // 换发失败诊断
        const code = data && data.code;
        const msg = (data && data.message) || (data && data.msg) || '';
        if (code === 90001 || /sso|token|expir|invalid|失效|过期/i.test(msg)) {
            log('✗ ssoToken 已失效或无效, 请重新抓取!');
            log('  抓取方法: 云盘APP打开云朵活动页 → 抓包 URL 中 token= 参数值');
        } else if (code === 609004) {
            log('✗ 账号已关闭 (609004)');
        } else {
            log(`✗ 换发失败: code=${code} ${msg}  ${JSON.stringify(data).slice(0, 150)}`);
            // 未知错误重试一次
            if (retryCount < 1) {
                log('等待 3 秒后重试 ...');
                await sleep(3000);
                return await this.exchangeJwt(retryCount + 1);
            }
        }
        return false;
    }

    /** 验证当前 jwtToken 是否有效 (调 isNewUser 探测) */
    async verifyJwt(silent = false) {
        try {
            const check = await Api.isNewUser();
            if (check.data && check.data.code === 0) {
                if (!silent) log('jwtToken 有效');
                this.results.login = true;
                return true;
            }
            if (check.data && check.data.code === 90001) {
                if (!silent) log('jwtToken 已失效 (90001), 请重新抓取');
            } else {
                if (!silent) log(`jwtToken 校验异常: ${JSON.stringify(check.data).slice(0, 200)}`);
            }
        } catch (e) {
            if (!silent) log(`jwtToken 校验异常: ${e.message}`);
        }
        return false;
    }

    /** jwtToken 失效 (90001) 时的自动恢复: sso 模式重新换发, jwt 模式提示 */
    async refreshOnExpire() {
        if (this.type === 'sso') {
            log('检测到 jwtToken 失效, 使用 ssoToken 自动重新换发 ...');
            // 清除缓存
            const key = hashToken(this.token);
            delete JWT_CACHE[key];
            return await this.exchangeJwt();
        }
        log('jwtToken 模式无法自动恢复, 请重新抓取 jwtToken');
        return false;
    }

    /** 获取活动配置与广告位列表 */
    async loadActivityConfig() {
        log(`加载活动配置: ${this.marketName}`);
        const res = await this.withAuthRetry(() => Api.getMarketConfig(this.marketName));
        if (res.data && res.data.code === 0 && res.data.result) {
            const cfg = res.data.result;
            log(`活动: ${cfg.pageTitle || this.marketName}  时间: ${cfg.starttime || '?'} ~ ${cfg.endtime || '?'}`);
            // 从 webConfig 中提取广告位 ID 列表
            let adPosIdList = [];
            if (cfg.webConfig) {
                try {
                    const wc = typeof cfg.webConfig === 'string' ? JSON.parse(cfg.webConfig) : cfg.webConfig;
                    // 广告位通常在 webConfig.adPosIdList 或各模块配置中
                    if (Array.isArray(wc.adPosIdList)) adPosIdList = wc.adPosIdList;
                    if (Array.isArray(wc.adPosId)) adPosIdList = adPosIdList.concat(wc.adPosId);
                    // 遍历模块配置收集 adPosId
                    for (const key of Object.keys(wc)) {
                        const v = wc[key];
                        if (v && typeof v === 'object') {
                            if (Array.isArray(v.adPosIdList)) adPosIdList = adPosIdList.concat(v.adPosIdList);
                            if (v.adPosId) adPosIdList.push(v.adPosId);
                            if (v.adpostid) adPosIdList.push(v.adpostid);
                        }
                    }
                } catch (e) {
                    log(`webConfig 解析异常: ${e.message}`);
                }
            }
            // 去重
            adPosIdList = [...new Set(adPosIdList.map(String))];
            log(`发现 ${adPosIdList.length} 个广告位: ${adPosIdList.join(', ') || '(无)'}`);
            return { config: cfg, adPosIdList };
        }
        log(`活动配置获取失败: ${JSON.stringify(res.data).slice(0, 200)}`);
        return { config: null, adPosIdList: [] };
    }

    /** 拉取广告/任务列表 */
    async loadAdTasks(adPosIdList) {
        if (!adPosIdList.length) {
            log('无广告位, 跳过任务拉取');
            return [];
        }
        log('拉取广告任务列表 ...');
        const res = await this.withAuthRetry(() => Api.getAdInfo({
            client: 'android',
            adPosIdList: adPosIdList,
        }));
        if (res.data && res.data.code === 0 && res.data.result) {
            const list = Array.isArray(res.data.result) ? res.data.result : [];
            list.sort((a, b) => (a.sort || 0) - (b.sort || 0));
            log(`获取到 ${list.length} 个广告/任务`);
            return list;
        }
        log(`广告列表获取失败: ${JSON.stringify(res.data).slice(0, 200)}`);
        return [];
    }

    /** 执行单个浏览任务 (展示上报 + 点击上报 + 浏览) → 赚云朵 */
    async doViewTask(ad) {
        const advertId = ad.id || ad.advertId || ad.adInfoId;
        if (!advertId) {
            log('  跳过: 无 advertId');
            return false;
        }
        const tag = ad.tag || '001';
        const adPosId = ad.adPosId || ad.adpostid || '';

        // 1. 展示上报
        try {
            await Api.showReport({
                adPosId: adPosId,
                adInfoId: advertId,
                phone: this.phone,
                tag,
            });
        } catch (e) { /* 忽略上报失败 */ }

        await sleep(500 + Math.random() * 1000);

        // 2. 点击上报
        try {
            await Api.clickReport({
                adPosId: adPosId,
                adInfoId: advertId,
                phone: this.phone,
                tag,
            });
        } catch (e) { /* 忽略上报失败 */ }

        await sleep(800 + Math.random() * 1200);

        // 3. 浏览 (核心赚云朵)
        try {
            const res = await this.withAuthRetry(() => Api.view(advertId));
            if (res.data && res.data.code === 0) {
                log(`  ✓ 浏览任务完成: ${ad.name || ad.adName || advertId}`);
                this.results.tasks++;
                return true;
            }
            log(`  浏览任务结果: ${JSON.stringify(res.data).slice(0, 150)}`);
        } catch (e) {
            log(`  浏览任务异常: ${e.message}`);
        }
        return false;
    }

    /** 查询云朵记录 */
    async checkCloudRecord() {
        log('查询云朵记录 ...');
        const res = await this.withAuthRetry(() => Api.listCloudRecord());
        if (res.data && res.data.code === 0) {
            const result = res.data.result;
            log(`云朵记录: ${JSON.stringify(result).slice(0, 300)}`);
            // 尝试提取云朵数量
            if (result) {
                if (typeof result.cloudNum !== 'undefined') this.results.cloudDrops = result.cloudNum;
                else if (typeof result.cloudCount !== 'undefined') this.results.cloudDrops = result.cloudCount;
                else if (typeof result.total !== 'undefined') this.results.cloudDrops = result.total;
                else if (Array.isArray(result)) this.results.cloudDrops = result.length;
            }
            return result;
        }
        log(`云朵记录查询失败: ${JSON.stringify(res.data).slice(0, 200)}`);
        return null;
    }

    /** 查询奖品 */
    async checkPrizes() {
        log('查询我的奖品 ...');
        const res = await this.withAuthRetry(() => Api.getMyPrizeList({ pageNum: 1, pageSize: 20 }));
        if (res.data && res.data.code === 0 && res.data.result) {
            const list = res.data.result.list || res.data.result.records || res.data.result || [];
            if (Array.isArray(list)) {
                this.results.prizes = list;
                log(`我的奖品: ${list.length} 条`);
                for (const p of list) {
                    log(`  - ${p.prizeName || p.name || '未知奖品'}  状态: ${p.status || p.prizeStatus || '?'}`);
                }
            }
            return list;
        }
        log(`奖品查询: ${JSON.stringify(res.data).slice(0, 150)}`);
        return [];
    }

    /** 执行全部任务流程 */
    async run() {
        log(`========== 开始执行 [${this.marketName}] ==========`);

        // 1. 登录
        if (!await this.login()) {
            return { success: false, message: '登录失败' };
        }

        // 2. 新用户检查
        try {
            const nu = await Api.isNewUser();
            if (nu.data && nu.data.code === 0) {
                log(`新用户状态: ${nu.data.result ? '新用户' : '老用户'}`);
            }
        } catch (e) { /* 忽略 */ }

        // 3. 活动校验
        try {
            const val = await Api.validate(this.marketName);
            if (val.data && val.data.code !== 0) {
                log(`活动校验未通过: ${JSON.stringify(val.data).slice(0, 150)}`);
            }
        } catch (e) { /* 忽略 */ }

        // 4. 加载活动配置
        const { config, adPosIdList } = await this.loadActivityConfig();

        // 5. 拉取广告任务
        const adList = await this.loadAdTasks(adPosIdList);

        // 6. 逐个执行浏览任务 (赚云朵)
        if (adList.length) {
            log(`开始执行 ${adList.length} 个浏览任务 ...`);
            for (let i = 0; i < adList.length; i++) {
                log(`[${i + 1}/${adList.length}] 处理中 ...`);
                await this.doViewTask(adList[i]);
                await sleep(1500 + Math.random() * 2000);  // 间隔, 模拟人工
            }
        }

        // 7. 查询云朵记录
        await this.checkCloudRecord();

        // 8. 查询奖品
        await this.checkPrizes();

        log(`========== 执行完成 ==========`);

        return {
            success: true,
            marketName: this.marketName,
            tasks: this.results.tasks,
            cloudDrops: this.results.cloudDrops,
            prizes: this.results.prizes.length,
        };
    }
}

// ==================== 通知 ====================

let notify;
try {
    notify = require('./sendNotify');
} catch {
    notify = { send: () => {} };
}

async function sendNotify(title, content) {
    if (!NOTIFY) return;
    try {
        await notify.send(title, content);
    } catch (e) {
        log(`通知发送异常: ${e.message}`);
    }
}

// ==================== 主入口 ====================

async function main() {
    log('中国移动云盘 · 云朵任务脚本启动');
    log(`活动: ${MARKET_NAME}  |  Token类型: ${TOKEN_TYPE}  |  设备ID: ${DEVICE_ID}`);

    // 解析多账号
    const tokens = RAW_TOKENS.split(/[\n&]/).map(t => t.trim()).filter(Boolean);
    if (!tokens.length) {
        log('⚠ 未检测到 MCLOUD_TOKEN 环境变量, 请在青龙面板配置');
        log('  说明 (默认 ssoToken 模式, 自动换发 jwtToken):');
        log('  1. 抓包云盘 APP 打开云朵活动页面时的 URL');
        log('  2. 从 URL 中提取 token= 参数值 (ssoToken)');
        log('  3. 将 ssoToken 填入环境变量 MCLOUD_TOKEN');
        log('  4. 默认即为 sso 模式, 无需额外设置 MCLOUD_TOKEN_TYPE');
        log('  5. 若直接使用 jwtToken, 需设置 MCLOUD_TOKEN_TYPE=jwt');
        return;
    }

    const allResults = [];

    for (let i = 0; i < tokens.length; i++) {
        log(`\n>>>>>>>>>> 账号 ${i + 1}/${tokens.length} <<<<<<<<<<`);
        const account = new McloudAccount(tokens[i], TOKEN_TYPE, MARKET_NAME);
        try {
            const result = await account.run();
            allResults.push(result);
        } catch (e) {
            log(`账号 ${i + 1} 执行异常: ${e.message}`);
            allResults.push({ success: false, message: e.message });
        }
        if (i < tokens.length - 1) await sleep(3000);
    }

    // 汇总通知
    let summary = '中国移动云盘 · 云朵任务\n';
    summary += `${'─'.repeat(30)}\n`;
    summary += `活动: ${MARKET_NAME}\n`;
    for (let i = 0; i < allResults.length; i++) {
        const r = allResults[i];
        summary += `账号${i + 1}: `;
        if (r.success) {
            summary += `✓ 浏览${r.tasks}个 | 云朵${r.cloudDrops} | 奖品${r.prizes}\n`;
        } else {
            summary += `✗ ${r.message || '失败'}\n`;
        }
    }
    log('\n' + summary);
    await sendNotify('云盘云朵任务', summary);
}

main().catch(e => {
    log(`脚本异常: ${e.message}`);
    console.error(e);
});
