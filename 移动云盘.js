/*
 * 中国移动云盘 - 云朵中心自动任务脚本（青龙面板）
 * 参照 ydyp v5.0.7 Python 脚本完整重写
 *
 * 环境变量: MCLOUD_TOKEN
 *   格式: Authorization值#手机号
 *   多账号用 & 或换行分隔
 *   Authorization值可含或不含 "Basic " 前缀
 *
 * 获取方式:
 *   抓包 orches.yun.139.com 请求头中的 Authorization 值
 *   配合手机号用 # 分隔
 *
 * 定时规则: 0 8 * * *
 */

const axios = require("axios");
const https = require("https");
const crypto = require("crypto");

// ======================== Env 类 ========================
class Env {
    constructor(name) {
        this.name = name;
        this.startTime = Date.now();
        console.log(`\n## 开始执行... ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
        console.log(`## 脚本: ${name}`);
    }
    log(m) { console.log(m); }
    logErr(m) { console.error(`[ERROR] ${m}`); }
    notify(t, s, c) { console.log(`\n📢 ${t} - ${s}`); if (c) console.log(c); }
    done() { console.log(`\n## 执行完成，耗时 ${((Date.now() - this.startTime) / 1000).toFixed(1)} 秒`); }
}
const $ = new Env("中国移动云盘云朵中心");

// ======================== 配置 ========================
const MARKET_BASE = "https://m.mcloud.139.com";
const CAIYUN_BASE = "https://caiyun.feixin.10086.cn";
const CAIYUN_PORT = "https://caiyun.feixin.10086.cn:7071";
const CLOUD_FILE_BASE = "https://personal-kd-njs.yun.139.com";
const SHARE_BASE = "https://yun.139.com";
const AI_BASE = "https://ai.yun.139.com";
const ACTIVITY_ID = "sign_in_3";
const CLIENT_VERSION = "12.5.4";
const MARKET_SOURCE_ID = "1097";
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) MCloudApp/12.5.4 iPhone AppLanguage/zh-CN";
const MARKET_UA = "";

// 虚拟文件内容
const DUMMY_CONTENT = Buffer.from("0");
const DUMMY_HASH = crypto.createHash("sha256").update(DUMMY_CONTENT).digest("hex");

// 最小 JPEG 样图 (1x1 白色像素)
const AI_CAMERA_SAMPLE = "data:image/jpg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJY//9k=";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ======================== 工具函数 ========================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min = 800, max = 2000) { return sleep(Math.floor(Math.random() * (max - min + 1)) + min); }
function currentMillis() { return Date.now(); }

function randomString(length) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < length; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

function generateUUID() {
    return [
        randomString(8), "-", randomString(4), "-4", randomString(3), "-",
        "89ab"[Math.floor(Math.random() * 4)], randomString(3), "-", randomString(12)
    ].join("");
}

function generateDeviceId() {
    const info = {
        deviceId: crypto.randomBytes(16).toString("hex").toUpperCase(),
        brand: "Apple",
        model: "iPhone 16 Pro",
        system: "iOS 18.7",
        timestamp: currentMillis(),
    };
    return Buffer.from(JSON.stringify(info)).toString("base64");
}

function buildXDeviceInfo(deviceId) {
    return `wifi||8|${CLIENT_VERSION}|Apple|iPhone 16 Pro|${deviceId}||ios 18.7|||||`;
}

function extractUserDomainId(jwtToken) {
    try {
        const payload = jwtToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
        let sub = decoded.sub;
        if (typeof sub === "string") sub = JSON.parse(sub);
        return sub?.userDomainId || "";
    } catch (e) {
        return "";
    }
}

function extractRawToken(auth) {
    let token = auth.replace("Basic ", "");
    try {
        const decoded = Buffer.from(token, "base64").toString("utf-8");
        const parts = decoded.split(":");
        if (parts.length >= 3) return parts[2];
    } catch (e) {}
    return token;
}

// ======================== 账号解析 ========================
function splitAccounts(raw) {
    if (!raw) return [];
    return raw.split(/&|\n/).map(s => s.trim()).filter(s => s.length > 10);
}

function parseAccount(tokenStr) {
    const parts = tokenStr.split("#");
    if (parts.length < 2) {
        $.logErr("格式错误，需要 Authorization值#手机号");
        return null;
    }
    let auth = parts[0].trim();
    const phone = parts[1].trim();
    if (!auth || !phone) {
        $.logErr("Authorization 或 手机号为空");
        return null;
    }
    if (!auth.startsWith("Basic ")) auth = "Basic " + auth;
    return { authorization: auth, phone };
}

// ======================== 认证流程 ========================
function checkAuthExpiry(auth) {
    try {
        const raw = auth.replace("Basic ", "");
        const decoded = Buffer.from(raw, "base64").toString("utf-8");
        const parts = decoded.split("|");
        if (parts.length > 3) {
            const expireAt = parseInt(parts[3]);
            if (expireAt > 0) {
                const now = Date.now();
                if (now > expireAt) {
                    $.logErr(`❌ Authorization 已过期! 过期时间: ${new Date(expireAt).toLocaleString("zh-CN")}`);
                    return false;
                }
                const daysLeft = Math.floor((expireAt - now) / 86400000);
                $.log(`📅 Authorization 剩余 ${daysLeft} 天`);
                if (daysLeft <= 3) $.log(`⚠️ Authorization 即将过期，请及时更新!`);
                return true;
            }
        }
    } catch (e) {
        $.log("⚠️ 无法解析 Authorization 有效期");
    }
    return true;
}

async function getSsoToken(account) {
    try {
        const resp = await axios({
            method: "POST",
            url: "https://orches.yun.139.com/orchestration/auth-rebuild/token/v1.0/querySpecToken",
            headers: { "Authorization": account.authorization, "Content-Type": "application/json", "User-Agent": USER_AGENT, "Accept": "*/*" },
            data: { account: account.phone, toSourceId: "001005" },
            timeout: 15000, validateStatus: () => true, httpsAgent,
        });
        if (resp.data?.success && resp.data?.data?.token) return resp.data.data.token;
        $.logErr(`ssoToken 获取失败: ${JSON.stringify(resp.data).slice(0, 200)}`);
        return null;
    } catch (e) {
        $.logErr(`ssoToken 请求异常: ${e.message}`);
        return null;
    }
}

async function getJwtToken(ssoToken) {
    try {
        const resp = await axios({
            method: "POST",
            url: `${CAIYUN_PORT}/portal/auth/tyrzLogin.action?ssoToken=${ssoToken}`,
            headers: { "User-Agent": USER_AGENT, "Accept": "*/*", "Host": "caiyun.feixin.10086.cn:7071" },
            timeout: 15000, validateStatus: () => true, httpsAgent,
        });
        if (resp.data?.code === 0 && resp.data?.result?.token) return resp.data.result.token;
        $.logErr(`jwtToken 获取失败: ${JSON.stringify(resp.data).slice(0, 200)}`);
        return null;
    } catch (e) {
        $.logErr(`jwtToken 请求异常: ${e.message}`);
        return null;
    }
}

// ======================== Market Context ========================
function buildMarketContext(jwtToken, ssoToken, account) {
    const userDomainId = extractUserDomainId(jwtToken);
    const deviceId = generateDeviceId();
    const xDeviceInfo = buildXDeviceInfo(deviceId);
    const pageUrl = `${MARKET_BASE}/portal/mobilecloud/index.html?path=newsignin&sourceid=${MARKET_SOURCE_ID}&enableShare=1&token=${ssoToken || ""}&targetSourceId=001005`;

    const marketHeaders = {
        "User-Agent": MARKET_UA,
        "Accept": "*/*",
        "jwtToken": jwtToken,
        "X-Requested-With": "com.chinamobile.mcloud",
        "Referer": pageUrl,
        "deviceId": deviceId,
        "x-DeviceInfo": xDeviceInfo,
    };
    const marketCookies = { jwtToken };
    if (userDomainId) marketCookies.userDomainId = userDomainId;

    return { userDomainId, deviceId, xDeviceInfo, pageUrl, marketHeaders, marketCookies };
}

// ======================== HTTP 请求 ========================
async function marketGet(ctx, path, params) {
    try {
        const resp = await axios({
            method: "GET",
            url: MARKET_BASE + path,
            headers: ctx.marketHeaders,
            params: params || {},
            timeout: 15000, validateStatus: () => true, decompress: true, httpsAgent,
        });
        let data = resp.data;
        if (typeof data === "string") {
            if (data.includes("<html") || data.includes("<!DOCTYPE")) return { success: false, data: null, status: resp.status };
            try { data = JSON.parse(data); } catch (e) {}
        }
        return { success: resp.status >= 200 && resp.status < 300, data, status: resp.status };
    } catch (e) {
        $.logErr(`  market GET ${path} 异常: ${e.message}`);
        return { success: false, data: null, status: 0 };
    }
}

async function marketPost(ctx, path, body, extraHeaders) {
    try {
        const headers = { ...ctx.marketHeaders, "Content-Type": "application/json;charset=UTF-8", "Origin": MARKET_BASE };
        if (extraHeaders) Object.assign(headers, extraHeaders);
        const resp = await axios({
            method: "POST",
            url: MARKET_BASE + path,
            headers,
            data: body || {},
            timeout: 15000, validateStatus: () => true, decompress: true, httpsAgent,
        });
        let data = resp.data;
        if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
        return { success: resp.status >= 200 && resp.status < 300, data, status: resp.status };
    } catch (e) {
        $.logErr(`  market POST ${path} 异常: ${e.message}`);
        return { success: false, data: null, status: 0 };
    }
}

async function marketPostForm(ctx, path, formData, extraHeaders) {
    try {
        const headers = { ...ctx.marketHeaders, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };
        if (extraHeaders) Object.assign(headers, extraHeaders);
        const resp = await axios({
            method: "POST",
            url: MARKET_BASE + path,
            headers,
            data: formData,
            timeout: 15000, validateStatus: () => true, decompress: true, httpsAgent,
        });
        let data = resp.data;
        if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
        return { success: resp.status >= 200 && resp.status < 300, data, status: resp.status };
    } catch (e) {
        $.logErr(`  market POST(form) ${path} 异常: ${e.message}`);
        return { success: false, data: null, status: 0 };
    }
}

async function caiyunGet(jwtToken, path, params) {
    try {
        const resp = await axios({
            method: "GET",
            url: CAIYUN_BASE + path,
            headers: { "User-Agent": USER_AGENT, "Accept": "*/*", "jwtToken": jwtToken, "Cookie": `jwtToken=${jwtToken}` },
            params: params || {},
            timeout: 15000, validateStatus: () => true, decompress: true, httpsAgent,
        });
        let data = resp.data;
        if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
        return { success: resp.status >= 200 && resp.status < 300, data, status: resp.status };
    } catch (e) {
        $.logErr(`  caiyun GET ${path} 异常: ${e.message}`);
        return { success: false, data: null, status: 0 };
    }
}

async function caiyunPost(jwtToken, path, body) {
    try {
        const resp = await axios({
            method: "POST",
            url: CAIYUN_BASE + path,
            headers: { "User-Agent": USER_AGENT, "Accept": "*/*", "Content-Type": "application/json;charset=UTF-8", "jwtToken": jwtToken, "Cookie": `jwtToken=${jwtToken}` },
            data: body || {},
            timeout: 15000, validateStatus: () => true, decompress: true, httpsAgent,
        });
        let data = resp.data;
        if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
        return { success: resp.status >= 200 && resp.status < 300, data, status: resp.status };
    } catch (e) {
        $.logErr(`  caiyun POST ${path} 异常: ${e.message}`);
        return { success: false, data: null, status: 0 };
    }
}

// ======================== 会话准备 ========================
async function prepareSigninCenterSession(ctx) {
    // 访问签到页面
    await axios({
        method: "GET",
        url: ctx.pageUrl,
        headers: ctx.marketHeaders,
        timeout: 10000, validateStatus: () => true, httpsAgent,
    }).catch(() => {});
    // 发送访问日志
    for (const keyword of [
        "newsignin_index_pv", "newsignin_index_client", "newsignin_index_app_client",
        "newsignin_index_cookie_login", "newsignin_index_cookie",
        "newsignin_index_app_cookie_login",
    ]) {
        const formData = `module=uservisit&optkeyword=${keyword}&sourceid=${MARKET_SOURCE_ID}&marketName=${ACTIVITY_ID}`;
        await marketPostForm(ctx, "/ycloud/visitlog/journaling", formData).catch(() => {});
    }
}

// ======================== 签到 ========================
async function getPageInfo(ctx) {
    const r = await marketGet(ctx, "/market/signin/page/infoV3", { client: "app" });
    if (r.data?.code === 0) return r.data;
    $.log(`❌ 页面信息失败: ${JSON.stringify(r.data).slice(0, 200)}`);
    return null;
}

async function doSignIn(ctx) {
    const r = await marketGet(ctx, "/market/signin/page/startSignIn", { client: "app" });
    if (r.data?.code === 0) {
        const d = r.data.result;
        const signCount = d.signCount || 0;
        const points = d.signInPoints || 0;
        $.log(`✅ 签到成功 | 连续${signCount}天 | +${points}云朵`);
        return r.data;
    }
    // 检查是否已签到
    const info = await getPageInfo(ctx);
    if (info?.result?.todaySignIn || (info?.result?.cal || []).some(d => d.t && d.s)) {
        $.log("⚠️ 今日已签到");
        return { code: 0, result: { todaySignIn: true, signCount: 0, signInPoints: 0 } };
    }
    $.log(`❌ 签到失败: ${JSON.stringify(r.data).slice(0, 200)}`);
    return null;
}

// ======================== 任务列表 V2 ========================
async function getTaskListV2(ctx, group) {
    const r = await marketPost(ctx, "/market/signin/task/taskListV2", {
        marketname: ACTIVITY_ID,
        clientVersion: CLIENT_VERSION,
        group: group,
    });
    if (r.data?.code === 0 && r.data?.result) {
        return r.data.result[group] || [];
    }
    return [];
}

async function queryCloudTask(ctx, taskId, group = "time") {
    const tasks = await getTaskListV2(ctx, group);
    return tasks.find(t => t.id === taskId) || null;
}

// ======================== 任务点击 ========================
async function clickTask(ctx, taskId, key = "task") {
    const r = await marketGet(ctx, "/market/signin/task/click", { key, id: String(taskId) });
    return r.data;
}

function getTaskClickKeys(task) {
    const taskId = task.id;
    const currstep = task.currstep || 0;
    const stepTypes = new Set(task.stepTypeSet || []);
    if (taskId === 409) {
        return currstep > 0 ? ["task2"] : ["task", "task2"];
    }
    if (stepTypes.has("click") && currstep === 0) {
        return ["task"];
    }
    return [];
}

function stripTaskName(task) {
    return (task.name || `任务${task.id}`).replace(/<[^>]+>/g, "");
}

function getTaskProgress(task) {
    const parts = [];
    if (task.currstep) parts.push(`阶段${task.currstep}`);
    if (task.process) parts.push(`进度${task.process}`);
    return parts.length ? ` (${parts.join("，")})` : "";
}

// ======================== 云盘文件操作 ========================
function buildCloudFileHeaders(account) {
    return {
        "x-yun-op-type": "1",
        "x-yun-sub-op-type": "100",
        "x-yun-api-version": "v1",
        "x-yun-client-info": "6|127.0.0.1|1|12.1.0|realme|RMX5060|BCFF2BBA6881DD8E4971803C63DDB5E4|02-00-00-00-00-00|android 15|1264X2592|zh||||032|0|",
        "x-yun-app-channel": "10000023",
        "Authorization": account.authorization,
        "Content-Type": "application/json; charset=UTF-8",
        "User-Agent": "okhttp/4.12.0",
        "Host": "personal-kd-njs.yun.139.com",
        "Connection": "Keep-Alive",
    };
}

function buildShareHeaders(account) {
    return {
        "Authorization": account.authorization,
        "x-yun-api-version": "v1",
        "x-yun-app-channel": "10000023",
        "x-yun-client-info": `||9|${CLIENT_VERSION}|Chrome|143.0.7499.146|codextestshare||Windows 10||zh-CN|||Q2hyb21l||`,
        "x-yun-module-type": "100",
        "x-yun-svc-type": "1",
        "x-SvcType": "1",
        "x-yun-channel-source": "10000023",
        "x-huawei-channelSrc": "10000023",
        "Content-Type": "application/json;charset=UTF-8",
        "CMS-DEVICE": "default",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        "Referer": "https://yun.139.com/shareweb/",
        "Origin": "https://yun.139.com",
    };
}

async function createCloudFile(account, prefix, extension = "txt") {
    const now = new Date();
    const beijingTime = new Date(now.getTime() + 8 * 3600000);
    const fileName = `${prefix}${beijingTime.toISOString().slice(0, 10).replace(/-/g, "")}_${beijingTime.toISOString().slice(11, 19).replace(/:/g, "")}.${extension}`;
    const fileSize = DUMMY_CONTENT.length;
    const payload = {
        contentHash: DUMMY_HASH,
        contentHashAlgorithm: "SHA256",
        contentType: "application/oct-stream",
        fileRenameMode: "force_rename",
        localCreatedAt: beijingTime.toISOString().slice(0, 23) + "+08:00",
        name: fileName,
        parallelUpload: true,
        parentFileId: "/",
        partInfos: [{ end: fileSize, partNumber: 1, partSize: fileSize, start: 0 }],
        size: fileSize,
        type: "file",
    };
    try {
        const resp = await axios({
            method: "POST",
            url: `${CLOUD_FILE_BASE}/hcy/file/create`,
            headers: buildCloudFileHeaders(account),
            data: payload,
            timeout: 20000, validateStatus: () => true, httpsAgent,
        });
        if (resp.status === 200 && resp.data?.success) {
            return { fileId: resp.data.data?.fileId, fileName: resp.data.data?.fileName || fileName };
        }
        $.log(`  ⚠️ 创建文件失败: ${JSON.stringify(resp.data).slice(0, 150)}`);
    } catch (e) {
        $.log(`  ⚠️ 创建文件异常: ${e.message}`);
    }
    return null;
}

async function listCloudRootFiles(account) {
    const items = [];
    let pageCursor = "";
    while (true) {
        try {
            const resp = await axios({
                method: "POST",
                url: `${CLOUD_FILE_BASE}/hcy/file/list`,
                headers: buildCloudFileHeaders(account),
                data: {
                    imageThumbnailStyleList: ["Small", "Large"],
                    orderBy: "updated_at",
                    orderDirection: "DESC",
                    pageInfo: { pageCursor, pageSize: 100 },
                    parentFileId: "/",
                },
                timeout: 15000, validateStatus: () => true, httpsAgent,
            });
            if (!resp.data?.success) break;
            const data = resp.data.data || {};
            items.push(...(data.items || []));
            pageCursor = data.nextPageCursor || "";
            if (!pageCursor) break;
        } catch (e) { break; }
    }
    return items;
}

async function trashCloudFiles(account, fileIds) {
    if (!fileIds || fileIds.length === 0) return true;
    try {
        const resp = await axios({
            method: "POST",
            url: `${CLOUD_FILE_BASE}/hcy/recyclebin/batchTrash`,
            headers: buildCloudFileHeaders(account),
            data: { fileIds },
            timeout: 15000, validateStatus: () => true, httpsAgent,
        });
        return resp.data?.success || false;
    } catch (e) {
        $.log(`  ⚠️ 清理文件异常: ${e.message}`);
        return false;
    }
}

function isCleanupFile(item) {
    if (item.type !== "file" || item.parentFileId !== "/") return false;
    const name = item.name || "";
    const isAuto = (name.endsWith(".txt") && (name.startsWith("auto_upload_") || name.startsWith("auto_share_"))) ||
                   (name.endsWith(".jpg") && name.startsWith("auto_mayday_"));
    if (!isAuto) return false;
    return item.size === 0 || item.size === 1 || item.contentHash === DUMMY_HASH;
}

async function cleanupUploadedFiles(account, currentFile) {
    const fileIds = [];
    if (currentFile?.fileId) fileIds.push(currentFile.fileId);
    const items = await listCloudRootFiles(account);
    for (const item of items) {
        if (isCleanupFile(item)) fileIds.push(item.fileId);
    }
    const unique = [...new Set(fileIds)];
    if (unique.length > 0) {
        await trashCloudFiles(account, unique);
        $.log(`  🗑️ 清理${unique.length}个临时文件`);
    }
}

// ======================== 分享文件 (任务434) ========================
async function completeShareFileTask(account, task) {
    const shareFile = await createCloudFile(account, "auto_share_");
    if (!shareFile) {
        $.log("  ❌ 分享失败: 创建临时文件失败");
        return null;
    }
    try {
        const resp = await axios({
            method: "POST",
            url: `${SHARE_BASE}/orchestration/personalCloud-rebuild/outlink/v1.0/getOutLink`,
            headers: buildShareHeaders(account),
            data: {
                getOutLinkReq: {
                    subLinkType: 0, encrypt: 1, coIDLst: [shareFile.fileId], caIDLst: [],
                    pubType: 1, dedicatedName: shareFile.fileName, period: 1, periodUnit: 1,
                    viewerLst: [], extInfo: { isWatermark: 0, shareChannel: "3001" },
                    commonAccountInfo: { account: account.phone, accountType: 1 },
                },
            },
            timeout: 15000, validateStatus: () => true, httpsAgent,
        });
        const data = resp.data || {};
        const result = data.data?.result || data.data?.getOutLinkRes || {};
        const outlinks = result.getOutLinkResSet || [];
        const success = (data.success && result.resultCode === "0") || (String(data.code) === "0" && outlinks.length > 0);
        if (!success) {
            $.log(`  ❌ 分享失败: ${result.resultDesc || data.message || data.msg || "未知错误"}`);
            return null;
        }
        $.log("  ✅ 分享文件成功");
        return shareFile;
    } catch (e) {
        $.log(`  ❌ 分享异常: ${e.message}`);
        return null;
    } finally {
        if (shareFile?.fileId) await trashCloudFiles(account, [shareFile.fileId]);
    }
}

// ======================== AI 任务头 ========================
function buildAiHeaders(ctx, account, useClientInfo = false) {
    const deviceId = ctx.deviceId || generateDeviceId();
    const headers = {
        "Connection": "keep-alive",
        "sec-ch-ua-platform": '"iOS"',
        "Authorization": account.authorization,
        "x-yun-api-version": "v1",
        "x-yun-tid": generateUUID(),
        "sec-ch-ua": '"Not A(Brand";v="8", "Chromium";v="130", "Mobile Safari";v="130"',
        "sec-ch-ua-mobile": "?1",
        "X-Requested-With": "com.chinamobile.mcloud",
        "Origin": "https://frontend.mcloud.139.com",
        "Referer": "https://frontend.mcloud.139.com/",
        "User-Agent": MARKET_UA,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "zh,zh-CN;q=0.9,en-US;q=0.8,en;q=0.7",
    };
    if (useClientInfo) {
        headers.Accept = "text/event-stream";
        headers["x-yun-client-info"] = `4||1|${CLIENT_VERSION}|Apple|iPhone 16 Pro|${deviceId.replace(/^B/, "")}|iOS 18.7|||||`;
        headers["x-yun-app-channel"] = "101";
    } else {
        headers.Accept = "*/*";
        headers["x-DeviceInfo"] = `||36|${CLIENT_VERSION}|Apple|iPhone 16 Pro|${deviceId.replace(/^B/, "")}|iOS 18.7|||||`;
    }
    return headers;
}

function isAiChatSuccess(text) {
    if (!text) return false;
    const lines = text.split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
                const data = JSON.parse(payload);
                if (data.success || data.code === "0000") return true;
            } catch (e) {}
        }
    }
    if (text.trim()) {
        try {
            const data = JSON.parse(text.trim());
            if (data.success || data.code === "0000") return true;
        } catch (e) {}
    }
    return false;
}

// ======================== AI相机任务 (585) ========================
async function completeAiCameraTask(ctx, account) {
    if (!ctx.userDomainId) {
        $.log("  ❌ AI相机: 缺少用户信息");
        return false;
    }
    $.log("  📸 AI相机: 发送识图请求...");
    const recognizePayload = JSON.stringify({
        channelId: "101", userId: ctx.userDomainId, recognizeType: "1",
        base64: AI_CAMERA_SAMPLE, sendType: "2", imageExt: "jpg",
        uploadToCloud: true, timeout: 30000,
    });
    try {
        const resp = await axios({
            method: "POST",
            url: `${AI_BASE}/api/image/aiRecognize`,
            headers: buildAiHeaders(ctx, account),
            data: recognizePayload,
            timeout: 30000, validateStatus: () => true, httpsAgent,
        });
        if (!resp.data?.success) {
            $.log(`  ❌ AI相机识图失败: ${resp.data?.message || "未知错误"}`);
            return false;
        }
        const fileId = resp.data.data?.fileId;
        if (!fileId) {
            $.log("  ❌ AI相机: 缺少文件ID");
            return false;
        }
        const taskId = String(resp.data.data?.taskId || currentMillis());
        const fileName = taskId.match(/^\d+$/) ? `${parseInt(taskId) + 1}.jpeg` : `${taskId}.jpeg`;
        $.log("  📸 AI相机: 发送对话请求...");
        const inputTime = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 23) + "+08:00";
        const chatPayload = JSON.stringify({
            userId: ctx.userDomainId, sessionId: "", applicationType: "chat", applicationId: "",
            sourceChannel: "101",
            dialogueInput: {
                dialogue: "？", prompt: "", inputTime,
                enableForceLlm: false, enableForceNetworkSearch: true, enableModelThinking: false,
                enableAllNetworkSearch: false, enableKnowledgeAndNetworkSearch: false, enableRegenerate: false,
                versionInfo: { h5Version: "2.7.6" }, extInfo: "{}", sortInfo: {},
                toolSetting: { imageToolSetting: { enableLlmDescribe: true } },
                attachment: { attachmentTypeList: [3], fileList: [{ fileId, name: fileName }] },
            },
        });
        const chatResp = await axios({
            method: "POST",
            url: `${AI_BASE}/api/outer/assistant/chat/v2/add`,
            headers: buildAiHeaders(ctx, account, true),
            data: chatPayload,
            timeout: 60000, validateStatus: () => true, httpsAgent,
            responseType: "text",
        });
        const chatText = typeof chatResp.data === "string" ? chatResp.data : JSON.stringify(chatResp.data);
        if (isAiChatSuccess(chatText)) {
            $.log("  ✅ AI相机任务完成");
            return true;
        }
        if (chatResp.status === 200 && !chatText.trim()) {
            $.log("  ✅ AI相机任务完成(空响应)");
            return true;
        }
        $.log(`  ❌ AI相机对话失败: ${chatText.slice(0, 150)}`);
        return false;
    } catch (e) {
        $.log(`  ❌ AI相机异常: ${e.message}`);
        return false;
    }
}

// ======================== 出行攻略AI任务 (588) ========================
async function completeTravelGuideAiTask(ctx, account) {
    if (!ctx.userDomainId) {
        $.log("  ❌ 出行攻略: 缺少用户信息");
        return false;
    }
    $.log("  🗺️ 出行攻略: 发送对话请求...");
    const inputTime = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 23) + "+08:00";
    const chatPayload = JSON.stringify({
        userId: ctx.userDomainId, sessionId: "", applicationType: "chat", applicationId: "",
        sourceChannel: "101",
        dialogueInput: {
            dialogue: "给我一份五一出行攻略", prompt: "", inputTime,
            enableForceLlm: false, enableForceNetworkSearch: true, enableModelThinking: false,
            enableAllNetworkSearch: false, enableKnowledgeAndNetworkSearch: false, enableRegenerate: false,
            versionInfo: { h5Version: "2.7.6" }, extInfo: "{}", sortInfo: {},
            toolSetting: { imageToolSetting: { enableLlmDescribe: true } }, attachment: {},
        },
    });
    try {
        const resp = await axios({
            method: "POST",
            url: `${AI_BASE}/api/outer/assistant/chat/v2/add`,
            headers: buildAiHeaders(ctx, account, true),
            data: chatPayload,
            timeout: 60000, validateStatus: () => true, httpsAgent,
            responseType: "text",
        });
        const text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
        if (isAiChatSuccess(text) || (resp.status === 200 && !text.trim())) {
            $.log("  ✅ 出行攻略任务完成");
            return true;
        }
        $.log(`  ❌ 出行攻略失败: ${text.slice(0, 150)}`);
        return false;
    } catch (e) {
        $.log(`  ❌ 出行攻略异常: ${e.message}`);
        return false;
    }
}

// ======================== 假期九宫格任务 (589) ========================
async function completeHolidayNineGridTask(ctx, account) {
    $.log("  🖼️ 九宫格: 获取模板...");
    const adHeaders = {
        "Authorization": account.authorization,
        "User-Agent": MARKET_UA,
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": "https://yun.139.com",
        "Referer": "https://yun.139.com/aiTools/",
        "x-yun-tid": generateUUID(),
    };
    try {
        const resp = await axios({
            method: "POST",
            url: "https://ad.mcloud.139.com/advertapi/adv-config/adv-config/AdInfoFilter/getAdInfos",
            headers: adHeaders,
            data: { account: "", adpostid: "66340", channel: "10000023", version: "10.5.0", client: "iphone" },
            timeout: 15000, validateStatus: () => true, httpsAgent,
        });
        if (String(resp.data?.returnCode) !== "0") {
            $.log(`  ❌ 九宫格: ${resp.data?.returnMsg || "未知错误"}`);
            return false;
        }
        const clickData = await clickTask(ctx, 589);
        if (clickData?.code === 0) {
            $.log("  ✅ 九宫格任务完成");
            return true;
        }
        $.log(`  ❌ 九宫格: ${clickData?.msg || "点击失败"}`);
        return false;
    } catch (e) {
        $.log(`  ❌ 九宫格异常: ${e.message}`);
        return false;
    }
}

// ======================== 月上传任务 (522) ========================
async function completeMonthlyUploadTask(ctx, account, task) {
    const target = 100;
    let current = parseInt(task.process || 0);
    for (let attempt = 0; attempt < 3; attempt++) {
        const remaining = Math.max(0, target - current);
        if (remaining === 0) return true;
        $.log(`  📤 月上传: ${current}/${target}，还需${remaining}次`);
        let success = 0;
        for (let i = 0; i < remaining; i++) {
            if (await createCloudFile(account, "auto_upload_")) success++;
            if (i % 10 === 9) await sleep(500);
        }
        if (success) $.log(`  📤 月上传: 批量上传${success}个`);
        const refreshed = await queryCloudTask(ctx, task.id || 522, "time");
        if (!refreshed) return false;
        const newProcess = parseInt(refreshed.process || 0);
        if (refreshed.state === "FINISH" || newProcess >= target) return true;
        if (newProcess <= current) {
            $.log(`  ⚠️ 月上传进度未更新: ${newProcess}/${target}`);
            return false;
        }
        current = newProcess;
    }
    return false;
}

// ======================== 五一回忆任务 (587) ========================
async function completeMaydayMemoryTask(ctx, account, task) {
    const target = 10;
    const current = parseInt(task.process || 0);
    const remaining = Math.max(0, target - current);
    if (remaining === 0) return true;
    $.log(`  📸 五一回忆: ${current}/${target}，还需${remaining}张`);
    let success = 0;
    for (let i = 0; i < remaining; i++) {
        if (await createCloudFile(account, "auto_mayday_", "jpg")) success++;
    }
    if (success) {
        $.log(`  📸 五一回忆: 上传${success}张`);
        await clickTask(ctx, task.id || 587);
    }
    const refreshed = await queryCloudTask(ctx, task.id || 587, "beiyong1");
    if (!refreshed) return false;
    return refreshed.state === "FINISH" || parseInt(refreshed.process || 0) >= target;
}

// ======================== 通知任务 (406) ========================
async function completeNoticeTask(jwtToken, taskName) {
    try {
        const statusResp = await caiyunGet(jwtToken, "/market/msgPushOn/task/status");
        if (statusResp.data?.code !== 0) {
            $.log(`  ⚠️ ${taskName}: 获取状态失败`);
            return;
        }
        const status = statusResp.data.result || {};
        const pushOn = parseInt(status.pushOn || 0);
        const firstStatus = parseInt(status.firstTaskStatus || 0);
        const secondStatus = parseInt(status.secondTaskStatus || 0);
        const onDuration = parseInt(status.onDuaration || 0);
        const total = parseInt(status.total || 31);
        if (pushOn !== 1) {
            $.log(`  ⚠️ ${taskName}: 通知未开启`);
            return;
        }
        if (firstStatus !== 3) {
            const r = await caiyunPost(jwtToken, "/market/msgPushOn/task/obtain", { type: 1 });
            if (r.data?.code === 0) $.log(`  ✅ ${taskName}: 领取首日奖励`);
        }
        if (secondStatus === 2) {
            const r = await caiyunPost(jwtToken, "/market/msgPushOn/task/obtain", { type: 2 });
            if (r.data?.code === 0) $.log(`  ✅ ${taskName}: 领取连续奖励(${onDuration}/${total}天)`);
        } else if (secondStatus === 3) {
            $.log(`  ✅ ${taskName}: 已完成`);
        } else {
            $.log(`  ⏳ ${taskName}: 进行中(${onDuration}/${total}天)`);
        }
    } catch (e) {
        $.log(`  ❌ ${taskName}异常: ${e.message}`);
    }
}

// ======================== 笔记任务 (107) ========================
async function completeNoteTask(account) {
    $.log("  📝 笔记: 刷新token...");
    const authToken = extractRawToken(account.authorization);
    const noteHeaders = {
        "Charset": "UTF-8", "Connection": "Keep-Alive", "User-Agent": "mobile",
        "APP_CP": "ios", "CP_VERSION": "3.2.0", "x-huawei-channelsrc": "10001400",
        "Host": "mnote.caiyun.feixin.10086.cn", "Content-Type": "application/json; charset=UTF-8",
        "Accept-Encoding": "gzip", "Accept": "*/*",
    };
    try {
        // 1. 刷新笔记token
        const refreshResp = await axios({
            method: "POST",
            url: "http://mnote.caiyun.feixin.10086.cn/noteServer/api/authTokenRefresh.do",
            headers: noteHeaders,
            data: { authToken, userPhone: account.phone },
            timeout: 15000, validateStatus: () => true,
        });
        const noteToken = refreshResp.headers?.note_token;
        const noteAuth = refreshResp.headers?.app_auth;
        if (!noteToken || !noteAuth) {
            $.log("  ❌ 笔记: 刷新token失败");
            return;
        }
        // 2. 获取默认笔记本ID
        $.log("  📝 笔记: 获取笔记本...");
        const syncHeaders = { ...noteHeaders, APP_NUMBER: account.phone, APP_AUTH: noteAuth, NOTE_TOKEN: noteToken };
        const syncResp = await axios({
            method: "POST",
            url: "http://mnote.caiyun.feixin.10086.cn/noteServer/api/syncNotebookV3.do",
            headers: syncHeaders,
            data: { addNotebooks: [], delNotebooks: [], notebookRefs: [], updateNotebooks: [] },
            timeout: 15000, validateStatus: () => true,
        });
        const notebookId = syncResp.data?.notebooks?.[0]?.notebookId;
        if (!notebookId) {
            $.log("  ❌ 笔记: 获取笔记本失败");
            return;
        }
        // 3. 创建笔记
        $.log("  📝 笔记: 创建笔记...");
        const noteId = randomString(32);
        const createTime = String(currentMillis());
        await sleep(2000);
        const updateTime = String(currentMillis());
        const createResp = await axios({
            method: "POST",
            url: "http://mnote.caiyun.feixin.10086.cn/noteServer/api/createNote.do",
            headers: syncHeaders,
            data: {
                archived: 0, attachmentdir: noteId, attachmentdirid: "", attachments: [],
                audioInfo: { audioDuration: 0, audioSize: 0, audioStatus: 0 },
                contentid: "", contents: [{ contentid: 0, data: '<font size="3">000000</font>', noteId, sortOrder: 0, type: "RICHTEXT" }],
                cp: "", createtime: createTime, description: "ios", expands: { noteType: 0 },
                latlng: "", location: "", noteid: noteId, notestatus: 0, remindtime: "", remindtype: 1,
                revision: "1", sharecount: "0", sharestatus: "0", system: "mobile",
                tags: [{ id: notebookId, orderIndex: "0", text: "默认笔记本" }],
                title: "00000", topmost: "0", updatetime: updateTime, userphone: account.phone,
                version: "1.00", visitTime: "",
            },
            timeout: 15000, validateStatus: () => true,
        });
        if (createResp.status === 200) $.log("  ✅ 笔记创建成功");
        else $.log("  ❌ 笔记创建失败");
    } catch (e) {
        $.log(`  ❌ 笔记异常: ${e.message}`);
    }
}

// ======================== 任务处理 ========================
async function handleCloudV2Task(ctx, jwtToken, account, group, task) {
    const taskId = task.id;
    const taskName = stripTaskName(task);
    const taskStatus = task.state || "";

    if (taskStatus === "FINISH") {
        $.log(`  ✅ 已完成: ${taskName}`);
        return;
    }

    // 任务106: 上传文件
    if (group === "day" && taskId === 106) {
        $.log(`  🎯 去完成: ${taskName}`);
        await clickTask(ctx, taskId);
        await sleep(1000);
        const file = await createCloudFile(account, "auto_upload_");
        if (file) {
            $.log(`  ✅ 上传文件成功: ${file.fileName}`);
            await cleanupUploadedFiles(account, file);
        }
        return;
    }

    // 任务107: 创建笔记
    if (group === "day" && taskId === 107) {
        $.log(`  🎯 去完成: ${taskName}`);
        await clickTask(ctx, taskId);
        await sleep(1000);
        await completeNoteTask(account);
        return;
    }

    // 任务522: 月上传100个文件
    if (taskId === 522) {
        $.log(`  🎯 去完成: ${taskName}`);
        if (await completeMonthlyUploadTask(ctx, account, task)) {
            $.log(`  ✅ 已完成: ${taskName}`);
        } else {
            const refreshed = await queryCloudTask(ctx, taskId, "time") || task;
            $.log(`  ⏳ 需手动完成: ${taskName}${getTaskProgress(refreshed)}`);
        }
        return;
    }

    // 任务434: 分享文件
    if (taskId === 434) {
        $.log(`  🎯 去完成: ${taskName}`);
        const result = await completeShareFileTask(account, task);
        const refreshed = await queryCloudTask(ctx, taskId, "month") || task;
        if (refreshed.state === "FINISH") $.log(`  ✅ 已完成: ${stripTaskName(refreshed)}`);
        else if (result) $.log(`  ✅ 分享成功: ${stripTaskName(refreshed)}${getTaskProgress(refreshed)}`);
        else $.log(`  ⏳ 需手动完成: ${taskName}${getTaskProgress(refreshed)}`);
        return;
    }

    // 任务585: AI相机
    if (taskId === 585) {
        $.log(`  🎯 去完成: ${taskName}`);
        const stepTypes = new Set(task.stepTypeSet || []);
        if (stepTypes.has("click") && parseInt(task.currstep || 0) === 0) {
            const clickData = await clickTask(ctx, taskId);
            if (clickData?.code !== 0) {
                $.log(`  ❌ 任务登记失败: ${taskName} ${clickData?.msg || "未知错误"}`);
                return;
            }
        }
        if (await completeAiCameraTask(ctx, account)) {
            const refreshed = await queryCloudTask(ctx, taskId, group) || task;
            if (refreshed.state === "FINISH") $.log(`  ✅ 已完成: ${stripTaskName(refreshed)}`);
            else $.log(`  ✅ AI相机已体验: ${stripTaskName(refreshed)}${getTaskProgress(refreshed)}`);
        } else {
            const refreshed = await queryCloudTask(ctx, taskId, group) || task;
            $.log(`  ⏳ 需手动完成: ${taskName}${getTaskProgress(refreshed)}`);
        }
        return;
    }

    // 任务587: 五一回忆
    if (taskId === 587) {
        $.log(`  🎯 去完成: ${taskName}`);
        const stepTypes = new Set(task.stepTypeSet || []);
        if (stepTypes.has("click") && parseInt(task.currstep || 0) === 0) {
            const clickData = await clickTask(ctx, taskId);
            if (clickData?.code !== 0) {
                $.log(`  ❌ 任务登记失败: ${taskName} ${clickData?.msg || "未知错误"}`);
                return;
            }
        }
        if (await completeMaydayMemoryTask(ctx, account, task)) {
            const refreshed = await queryCloudTask(ctx, taskId, "beiyong1") || task;
            if (refreshed.state === "FINISH") $.log(`  ✅ 已完成: ${stripTaskName(refreshed)}`);
            else $.log(`  ✅ 五一回忆已上传: ${stripTaskName(refreshed)}${getTaskProgress(refreshed)}`);
        } else {
            const refreshed = await queryCloudTask(ctx, taskId, "beiyong1") || task;
            $.log(`  ⏳ 需手动完成: ${taskName}${getTaskProgress(refreshed)}`);
        }
        return;
    }

    // 任务588: 出行攻略AI
    if (taskId === 588) {
        $.log(`  🎯 去完成: ${taskName}`);
        const stepTypes = new Set(task.stepTypeSet || []);
        if (stepTypes.has("click") && parseInt(task.currstep || 0) === 0) {
            const clickData = await clickTask(ctx, taskId);
            if (clickData?.code !== 0) {
                $.log(`  ❌ 任务登记失败: ${taskName} ${clickData?.msg || "未知错误"}`);
                return;
            }
        }
        if (await completeTravelGuideAiTask(ctx, account)) {
            const refreshed = await queryCloudTask(ctx, taskId, group) || task;
            if (refreshed.state === "FINISH") $.log(`  ✅ 已完成: ${stripTaskName(refreshed)}`);
            else $.log(`  ✅ 出行攻略已生成: ${stripTaskName(refreshed)}${getTaskProgress(refreshed)}`);
        } else {
            const refreshed = await queryCloudTask(ctx, taskId, group) || task;
            $.log(`  ⏳ 需手动完成: ${taskName}${getTaskProgress(refreshed)}`);
        }
        return;
    }

    // 任务589: 假期九宫格
    if (taskId === 589) {
        $.log(`  🎯 去完成: ${taskName}`);
        const stepTypes = new Set(task.stepTypeSet || []);
        if (stepTypes.has("click") && parseInt(task.currstep || 0) === 0) {
            const clickData = await clickTask(ctx, taskId);
            if (clickData?.code !== 0) {
                $.log(`  ❌ 任务登记失败: ${taskName} ${clickData?.msg || "未知错误"}`);
                return;
            }
        }
        if (await completeHolidayNineGridTask(ctx, account)) {
            const refreshed = await queryCloudTask(ctx, taskId, group) || task;
            if (refreshed.state === "FINISH") $.log(`  ✅ 已完成: ${stripTaskName(refreshed)}`);
            else $.log(`  ✅ 九宫格已生成: ${stripTaskName(refreshed)}${getTaskProgress(refreshed)}`);
        } else {
            const refreshed = await queryCloudTask(ctx, taskId, group) || task;
            $.log(`  ⏳ 需手动完成: ${taskName}${getTaskProgress(refreshed)}`);
        }
        return;
    }

    // beiyong1 组的其他任务需要手动完成
    if (group === "beiyong1") {
        $.log(`  ⏳ 需手动完成: ${taskName}${getTaskProgress(task)}`);
        return;
    }

    // 任务406: 通知任务
    if (taskId === 406) {
        $.log(`  🎯 去完成: ${taskName}`);
        await completeNoticeTask(jwtToken, taskName);
        return;
    }

    // 通用点击任务
    const clickKeys = getTaskClickKeys(task);
    if (clickKeys.length > 0) {
        $.log(`  🎯 去完成: ${taskName}`);
        for (const key of clickKeys) {
            const clickData = await clickTask(ctx, taskId, key);
            if (clickData?.code !== 0) {
                $.log(`  ❌ 任务登记失败: ${taskName} ${clickData?.msg || "未知错误"}`);
                return;
            }
        }
        $.log(`  ✅ 已登记任务: ${taskName}`);
        return;
    }

    $.log(`  ⏳ 需手动完成: ${taskName}${getTaskProgress(task)}`);
}

// 获取所有任务分组
function getCloudTaskGroups() {
    return [
        ["beiyong1", "🎁 五一福利任务"],
        ["cloudEmail", "📮 联动任务"],
        ["time", "✨ 新版热门任务"],
        ["day", "📆 云盘每日任务"],
        ["month", "📆 云盘每月任务"],
    ];
}

// 处理所有任务
async function processAllTasks(ctx, jwtToken, account) {
    for (const [group, title] of getCloudTaskGroups()) {
        const tasks = await getTaskListV2(ctx, group);
        if (!tasks || tasks.length === 0) continue;
        $.log(`\n${title}`);
        for (const task of tasks) {
            await handleCloudV2Task(ctx, jwtToken, account, group, task);
            await randomDelay(500, 1000);
        }
    }
    // 清理临时文件
    await cleanupUploadedFiles(account);
}

// ======================== 戳一戳 (319) ========================
async function click319(ctx) {
    $.log("🎯 戳一戳: 开始(15次)...");
    let success = 0;
    for (let i = 0; i < 15; i++) {
        const data = await clickTask(ctx, 319);
        if (data?.code === 0 && data.result) {
            $.log(`  [${i + 1}] ✅ ${data.result}`);
            success++;
        }
        await sleep(200);
    }
    $.log(`📊 戳一戳: ${success}/15次获得云朵`);
    return success;
}

// ======================== 摇一摇 ========================
async function shake(jwtToken) {
    let success = 0;
    $.log("🎲 摇一摇: 开始(15次)...");
    for (let i = 0; i < 15; i++) {
        try {
            const resp = await axios({
                method: "POST",
                url: `${CAIYUN_PORT}/market/shake-server/shake/shakeIt?flag=1`,
                headers: { "User-Agent": USER_AGENT, "Accept": "*/*", "jwtToken": jwtToken, "Cookie": `jwtToken=${jwtToken}` },
                timeout: 10000, validateStatus: () => true, decompress: true, httpsAgent,
            });
            let data = resp.data;
            if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
            if (data?.code === 0 && data?.result?.shakePrizeconfig) {
                $.log(`  [${i + 1}] 🎉 获得: ${data.result.shakePrizeconfig.name}`);
                success++;
            }
        } catch (e) {}
        await sleep(200);
    }
    if (success === 0) $.log(`❌ 摇一摇: 未摇中 x15`);
    else $.log(`📊 摇一摇: ${success}/15次成功`);
}

// ======================== 抽奖 ========================
async function drawLottery(jwtToken) {
    try {
        const infoResp = await caiyunGet(jwtToken, "/market/playoffic/drawInfo");
        if (infoResp.data?.msg !== "success") {
            $.log(`⚠️ 抽奖查询失败: ${infoResp.data?.msg || ""}`);
            return;
        }
        const remain = infoResp.data.result?.surplusNumber || 0;
        $.log(`🎰 剩余抽奖次数: ${remain}`);
        if (remain <= 49) return;
        for (let i = 0; i < 1; i++) {
            const r = await caiyunGet(jwtToken, "/market/playoffic/draw");
            if (r.data?.code === 0) {
                $.log(`✅ 抽奖成功: ${r.data.result?.prizeName || ""}`);
            } else {
                $.log("❌ 抽奖失败");
            }
            await sleep(1000);
        }
    } catch (e) {
        $.log(`⚠️ 抽奖异常: ${e.message}`);
    }
}

// ======================== 公众号签到 ========================
async function wxsign(jwtToken) {
    try {
        const r = await caiyunGet(jwtToken, "/market/playoffic/followSignInfo", { isWx: "true" });
        if (r.data?.msg !== "success") {
            $.log(`⚠️ 公众号: ${r.data?.msg || "失败"}`);
            return;
        }
        if (!r.data.result?.todaySignIn) {
            $.log("❌ 公众号签到失败, 可能未绑定");
            return;
        }
        $.log("✅ 公众号签到成功");
    } catch (e) {
        $.log(`⚠️ 公众号异常: ${e.message}`);
    }
}

// ======================== 备份奖励 ========================
async function backupCloud(jwtToken) {
    try {
        const infoResp = await caiyunGet(jwtToken, "/market/backupgift/info");
        const state = infoResp.data?.result?.state;
        if (state === -1) {
            $.log("📦 本月未备份, 暂无连续备份奖励");
        } else if (state === 0) {
            $.log("📦 领取本月连续备份奖励...");
            const r = await caiyunGet(jwtToken, "/market/backupgift/receive");
            $.log(`  获得: ${r.data?.result?.result || 0}云朵`);
        } else if (state === 1) {
            $.log("📦 已领取本月连续备份奖励");
        }
        // 膨胀云朵
        const expendResp = await caiyunGet(jwtToken, "/market/signin/page/taskExpansion");
        const expResult = expendResp.data?.result || {};
        if (expResult.curMonthBackup) {
            $.log(`📦 本月已备份, 下月可领取膨胀云朵: ${expResult.nextMonthTaskRecordCount || 0}`);
        } else {
            $.log("📦 本月还未备份, 下月暂无膨胀云朵");
        }
        if (expResult.preMonthBackup && !expResult.curMonthBackupTaskAccept) {
            const r = await caiyunGet(jwtToken, "/market/signin/page/receiveTaskExpansion", { acceptDate: expResult.acceptDate || "" });
            if (r.data?.code === 0) {
                $.log(`✅ 膨胀云朵领取成功: ${r.data.result?.cloudCount || 0}朵`);
            } else {
                $.log(`❌ 膨胀云朵领取失败: ${r.data?.msg || ""}`);
            }
        }
    } catch (e) {
        $.log(`⚠️ 备份奖励异常: ${e.message}`);
    }
}

// ======================== 领取云朵 ========================
async function receiveCloud(ctx, jwtToken) {
    await prepareSigninCenterSession(ctx);
    const info = await getPageInfo(ctx);
    if (!info?.result) {
        $.log("⚠️ 查询云朵失败");
        return;
    }
    const pending = info.result.toReceive || 0;
    const total = info.result.total || 0;
    if (pending > 0) {
        $.log(`☁️ 待领取: ${pending}云朵, 领取中...`);
        const receiveHeaders = { ...ctx.marketHeaders, showLoading: "true", appVersion: `${CLIENT_VERSION}.0`, activityId: ACTIVITY_ID };
        try {
            const resp = await axios({
                method: "GET",
                url: `${MARKET_BASE}/market/signin/page/receiveV2`,
                headers: receiveHeaders,
                params: { client: "app" },
                timeout: 15000, validateStatus: () => true, decompress: true, httpsAgent,
            });
            let data = resp.data;
            if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
            if (data?.code === 0) {
                const received = data.result?.receive || pending;
                const newTotal = data.result?.total || total;
                $.log(`✅ 领取云朵: ${received}云朵, 总计: ${newTotal}云朵`);
                return { received, total: newTotal };
            }
            // 检查最新状态
            const latestInfo = await getPageInfo(ctx);
            if (latestInfo?.result) {
                const latestTotal = latestInfo.result.total || total;
                const latestPending = latestInfo.result.toReceive || 0;
                if (latestPending === 0 || latestTotal > total) {
                    $.log(`✅ 领取云朵成功, 总计: ${latestTotal}云朵`);
                    return { received: pending, total: latestTotal };
                }
            }
            $.log(`⚠️ 领取失败: ${data?.msg || "未知错误"}, 待领取: ${pending}云朵`);
        } catch (e) {
            $.log(`⚠️ 领取异常: ${e.message}`);
        }
    } else {
        $.log(`☁️ 当前待领取: 0云朵, 总计: ${total}云朵`);
    }
    return { received: 0, total };
}

// ======================== 最终状态检查 ========================
async function recheckTasks(ctx) {
    let finished = 0, waiting = 0;
    const waitingTasks = [];
    for (const [group, title] of getCloudTaskGroups()) {
        const tasks = await getTaskListV2(ctx, group);
        for (const t of tasks) {
            if (t.state === "FINISH") finished++;
            else { waiting++; waitingTasks.push(`${t.id}(${stripTaskName(t)})`); }
        }
    }
    $.log(`\n📊 任务最终状态: ✅${finished}已完成 / ⏳${waiting}未完成`);
    if (waitingTasks.length > 0) $.log(`   未完成: ${waitingTasks.join(", ")}`);
    return { finished, waiting };
}

// ======================== 单账号执行 ========================
async function runForAccount(account, index) {
    const label = `账号[${account.phone.slice(-4)}]`;
    $.log(`\n${"=".repeat(50)}`);
    $.log(`🔹 ${label}`);
    $.log(`   手机号: ${account.phone}`);
    $.log(`${"=".repeat(50)}`);
    let summary = `${label}: `;

    // 1. 认证
    checkAuthExpiry(account.authorization);
    $.log("【认证】获取 ssoToken...");
    const ssoToken = await getSsoToken(account);
    if (!ssoToken) {
        $.logErr(`❌ ${label} 认证失败`);
        return `${label}: 认证失败`;
    }
    $.log("【认证】获取 jwtToken...");
    const jwtToken = await getJwtToken(ssoToken);
    if (!jwtToken) {
        $.logErr(`❌ ${label} 认证失败`);
        return `${label}: 认证失败`;
    }
    $.log("✅ 认证成功");

    // 2. 构建 market context
    const ctx = buildMarketContext(jwtToken, ssoToken, account);
    $.log(`🔧 userDomainId: ${ctx.userDomainId || "无"}`);

    try {
        // 3. 会话准备
        $.log("\n【1/8】会话准备");
        await prepareSigninCenterSession(ctx);
        await randomDelay(500, 1000);

        // 4. 签到
        $.log("\n【2/8】签到");
        const pageInfo = await getPageInfo(ctx);
        if (pageInfo?.result) {
            $.log(`   连续签到: ${pageInfo.result.signCount || 0}天 | 云朵: ${pageInfo.result.total || 0}`);
        }
        await randomDelay(500, 1000);
        const signResult = await doSignIn(ctx);
        if (signResult?.code === 0) {
            summary += `签到${signResult.result.signCount || 0}天/+${signResult.result.signInPoints || 0}云朵 | `;
        } else {
            summary += "签到失败 | ";
        }
        await randomDelay(500, 1000);

        // 5. 戳一戳
        $.log("\n【3/8】戳一戳");
        const click319Result = await click319(ctx);
        await randomDelay(500, 1000);

        // 6. 任务列表
        $.log("\n【4/8】处理任务");
        await processAllTasks(ctx, jwtToken, account);
        await randomDelay(500, 1000);

        // 7. 公众号签到
        $.log("\n【5/8】公众号签到");
        await wxsign(jwtToken);
        await randomDelay(500, 1000);

        // 8. 摇一摇
        $.log("\n【6/8】摇一摇");
        await shake(jwtToken);
        await randomDelay(500, 1000);

        // 9. 抽奖
        $.log("\n【7/8】抽奖");
        await drawLottery(jwtToken);
        await randomDelay(500, 1000);

        // 10. 备份奖励
        $.log("\n【8/8】备份奖励");
        await backupCloud(jwtToken);
        await randomDelay(500, 1000);

        // 11. 最终状态检查
        $.log("\n【检查】最终任务状态");
        const finalStatus = await recheckTasks(ctx);

        // 12. 领取云朵
        $.log("\n【领取】领取云朵");
        const cloudInfo = await receiveCloud(ctx, jwtToken);

        summary += `任务:✅${finalStatus.finished}/⏳${finalStatus.waiting} | 戳:${click319Result}次`;
        if (cloudInfo) summary += ` | 云朵:${cloudInfo.total}`;

        $.log(`\n📊 ${label} 结果: ${summary}`);
        return summary;
    } catch (e) {
        $.logErr(`❌ ${label} 异常: ${e.message}`);
        $.logErr(e.stack);
        return `${label}: 异常(${e.message})`;
    }
}

// ======================== 主流程 ========================
async function main() {
    $.log("=".repeat(50));
    $.log("🚀 中国移动云盘 · 云朵中心 v2.0");
    $.log("=".repeat(50));

    const rawToken = process.env.MCLOUD_TOKEN || "";
    if (!rawToken || rawToken.length < 10) {
        $.log("❌ 未配置 MCLOUD_TOKEN");
        $.log("💡 格式: Authorization值#手机号");
        $.log("💡 获取: 抓包 orches.yun.139.com 请求头 Authorization");
        $.log("💡 多账号用 & 或换行分隔");
        $.notify("中国移动云盘", "❌ 未配置", "MCLOUD_TOKEN 为空");
        return;
    }

    const tokenList = splitAccounts(rawToken);
    $.log(`📋 检测到 ${tokenList.length} 个账号`);

    const accounts = [];
    for (const ts of tokenList) {
        const acc = parseAccount(ts);
        if (!acc) continue;
        accounts.push(acc);
        $.log(`✅ 解析: 手机号=${acc.phone}`);
    }
    if (!accounts.length) {
        $.log("❌ 无有效账号");
        $.notify("中国移动云盘", "❌ 解析失败", "请检查 MCLOUD_TOKEN 格式");
        return;
    }
    $.log("");

    const results = [];
    for (let i = 0; i < accounts.length; i++) {
        results.push(await runForAccount(accounts[i], i));
        if (i < accounts.length - 1) await sleep(2000);
    }

    const finalSummary = results.join("\n");
    $.log("\n" + "=".repeat(50));
    $.log("📊 全部执行完毕");
    $.log("=".repeat(50));
    $.log(finalSummary);
    $.log("=".repeat(50));
    $.notify("中国移动云盘", `✅ ${accounts.length}个账号执行完毕`, finalSummary);
}

main().catch(e => {
    $.logErr(`脚本异常: ${e.message}`);
    $.logErr(e.stack);
}).finally(() => $.done());
