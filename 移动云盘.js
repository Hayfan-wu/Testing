/*
 * 中国移动云盘 - 云朵中心自动任务脚本（青龙面板）
 *
 * 唯一环境变量: MCLOUD_TOKEN (完整 Cookie, 多账号用 & 或换行分隔)
 * 定时规则: 0 8 * * *
 */

const axios = require("axios");
const crypto = require("crypto");
const https = require("https");
const dns = require("dns");

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
const BASE_URL = "https://m.mcloud.139.com";
const ACTIVITY_ID = "sign_in_3";
const APP_VERSION = "13.1.0.0";
const CLIENT_VERSION = "13.1.0";
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) MCloudApp/13.1.0 iPhone AppLanguage/zh-CN";
const SKIP_TASK_IDS = (process.env.MCLOUD_SKIP_TASK_IDS || "").split(",").map(i => parseInt(i.trim())).filter(Boolean);

// 强制 IPv4 的 DNS lookup
const ipv4Lookup = (hostname, options, callback) => {
    dns.lookup(hostname, { family: 4 }, (err, address) => {
        if (err) return callback(err);
        callback(null, address, 4);
    });
};

// ======================== Cookie 解析 ========================
function parseCookieValue(cookieStr, key) {
    const m = cookieStr.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : "";
}

// 从 Cookie 中提取 .thumbcache_* 的值作为 deviceId
function extractDeviceIdFromCookie(cookieStr) {
    const m = cookieStr.match(/\.thumbcache_[\w]+=\s*([^;]+)/);
    if (m) {
        return decodeURIComponent(m[1]);
    }
    return "";
}

function generateDeviceFingerprint(accountId) {
    return crypto.createHash("md5").update(accountId + "mcloud_device_2024").digest("hex");
}

function cleanRawToken(raw) {
    if (!raw) return "";
    return raw
        .replace(/Connection:\s*[\w-]+/gi, "")
        .replace(/Host:\s*[\w.-]+/gi, "")
        .replace(/Content-Type:\s*[\w/-]+/gi, "")
        .replace(/Accept[\w-]*:\s*[^\n\r]*/gi, "")
        .replace(/User-Agent:\s*[^\n\r]*/gi, "")
        .replace(/\r\n/g, "\n").trim();
}

function splitAccounts(raw) {
    if (!raw) return [];
    return cleanRawToken(raw).split("&").map(s => s.replace(/[\n\r]+/g, " ").trim()).filter(s => s.length > 20);
}

function parseAccount(cookieStr) {
    const jwtToken = parseCookieValue(cookieStr, "jwtToken");
    const userDomainId = parseCookieValue(cookieStr, "userDomainId");
    const cookieToken = parseCookieValue(cookieStr, "cookieToken");
    const cookieTokenKey = parseCookieValue(cookieStr, "cookieTokenKey");
    const accountId = userDomainId || jwtToken;

    // 优先从 Cookie 的 .thumbcache_* 提取真实 deviceId
    let deviceId = extractDeviceIdFromCookie(cookieStr);
    if (!deviceId) {
        deviceId = generateDeviceFingerprint(accountId);
        $.log(`⚠️ 未找到 .thumbcache_* Cookie, 使用 MD5 降级 deviceId`);
    }

    return {
        cookie: cookieStr,
        jwtToken, userDomainId, cookieToken, cookieTokenKey,
        deviceFingerprint: deviceId,
    };
}

// ======================== HTTP ========================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min = 800, max = 2000) { return sleep(Math.floor(Math.random() * (max - min + 1)) + min); }

function buildHeaders(account, isPost = false) {
    const headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh-Hans;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "jwtToken": account.jwtToken || "",
        "deviceId": account.deviceFingerprint,
        "activityId": ACTIVITY_ID,
        "appVersion": APP_VERSION,
        "showLoading": "true",
        "Cache-Control": "no-cache",
        "User-Agent": USER_AGENT,
        "Referer": `https://m.mcloud.139.com/portal/mobilecloud/index.html?path=newsignin&sourceid=1097&enableShare=1&token=${account.cookieToken || ""}&targetSourceId=001005`,
        "Cookie": account.cookie,
        "Connection": "keep-alive",
    };

    // POST 请求需要 Content-Type 和 Origin
    if (isPost) {
        headers["Content-Type"] = "application/json;charset=UTF-8";
        headers["Origin"] = "https://m.mcloud.139.com";
    }

    return headers;
}

// 通用请求 — 返回 {success, data, status}
async function httpRequest(method, account, path, body, queryParams) {
    const url = BASE_URL + path;
    const isPost = method === "POST";
    const headers = buildHeaders(account, isPost);

    const config = {
        method: method,
        url: url,
        headers: headers,
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: "json",
        decompress: true,
        httpsAgent: new https.Agent({
            rejectUnauthorized: false,
            lookup: ipv4Lookup,
        }),
    };

    if (queryParams && Object.keys(queryParams).length > 0) {
        config.params = queryParams;
    }

    if (isPost) {
        // POST 必须有 body
        config.data = body || {};
    }

    try {
        const resp = await axios(config);
        const status = resp.status;
        let data = resp.data;

        // 如果返回的是字符串（HTML 错误页），转成统一格式
        if (typeof data === "string") {
            if (data.includes("<html") || data.includes("nginx") || data.includes("<!DOCTYPE")) {
                $.logErr(`  HTTP ${status} - 服务器返回 HTML (非 JSON)`);
                $.logErr(`  响应前200字符: ${data.slice(0, 200)}`);
                return { success: false, data: null, status };
            }
            try { data = JSON.parse(data); } catch (e) { /* 保持字符串 */ }
        }

        return { success: status >= 200 && status < 300, data, status };
    } catch (e) {
        $.logErr(`  网络异常: ${e.message} (code: ${e.code || "N/A"})`);
        return { success: false, data: null, status: 0 };
    }
}

async function apiPost(account, path, body, queryParams) {
    const r = await httpRequest("POST", account, path, body, queryParams);
    if (!r.success && r.status !== 0) {
        $.logErr(`[POST] ${path} → HTTP ${r.status} ${r.data ? JSON.stringify(r.data).slice(0, 200) : ""}`);
    }
    return r.data;
}

async function apiGet(account, path, queryParams) {
    const r = await httpRequest("GET", account, path, null, queryParams);
    if (!r.success && r.status !== 0) {
        $.logErr(`[GET] ${path} → HTTP ${r.status} ${r.data ? JSON.stringify(r.data).slice(0, 200) : ""}`);
    }
    return r.data;
}

// ======================== API ========================

async function refreshSsoToken(account) {
    $.log("🔄 刷新 ssoToken...");
    const result = await apiGet(account, "/ycloud/api/cloud/userdomain/v2/querySpecToken", {
        targetSourceId: "001005"
    });
    if (result && result.code === 0 && result.result) {
        const newToken = result.result;
        $.log(`✅ ssoToken 刷新成功`);
        if (account.cookie.includes("cookieToken=")) {
            account.cookie = account.cookie.replace(/cookieToken=[^;]*/, `cookieToken=${newToken}`);
        } else {
            account.cookie += `; cookieToken=${newToken}`;
        }
        account.cookieToken = newToken;
        return true;
    }
    $.log(`⚠️ ssoToken 刷新失败: ${JSON.stringify(result)}`);
    return false;
}

// GET /ycloud/signin/page/infoV3?client=app
async function getPageInfo(account) {
    const result = await apiGet(account, "/ycloud/signin/page/infoV3", { client: "app" });
    if (result && result.code === 0) return result;
    $.log(`❌ 页面信息失败: ${JSON.stringify(result)}`);
    return null;
}

// GET /ycloud/signin/page/startSignIn?client=app
async function doSignIn(account) {
    const result = await apiGet(account, "/ycloud/signin/page/startSignIn", { client: "app" });
    if (result && result.code === 0) {
        const d = result.result;
        $.log(`✅ 签到成功 | 连续${d.signCount || 0}天 | +${d.signInPoints || 0}云朵`);
        return result;
    }
    if (result && (result.code === 1001 || result.code === 1099)) {
        $.log("⚠️ 今日已签到");
        return { code: 0, result: { todaySignIn: true, signCount: 0, signInPoints: 0 } };
    }
    $.log(`❌ 签到失败: ${JSON.stringify(result)}`);
    return null;
}

// POST /ycloud/signin/task/taskListV3
// Body: {"marketname":"sign_in_3","clientVersion":"13.1.0"}
async function getTaskList(account) {
    const result = await apiPost(account, "/ycloud/signin/task/taskListV3", {
        marketname: ACTIVITY_ID,
        clientVersion: CLIENT_VERSION,
    });
    if (result && result.code === 0) return result.result || [];
    $.log(`❌ 任务列表失败: ${JSON.stringify(result)}`);
    return [];
}

// GET /ycloud/signin/task/click?key=task&id=<id>
async function clickTask(account, taskId) {
    const result = await apiGet(account, "/ycloud/signin/task/click", { key: "task", id: String(taskId) });
    if (result && result.code === 0) return true;
    $.log(`⚠️ 任务${taskId} 点击: ${JSON.stringify(result)}`);
    return false;
}

// POST /ycloud/signin/page/doTaskPost
// Body: {"client":"app","deviceId":"<deviceId>"}
async function doTaskPost(account) {
    const result = await apiPost(account, "/ycloud/signin/page/doTaskPost", {
        client: "app",
        deviceId: account.deviceFingerprint,
    });
    if (result && result.code === 0) return true;
    $.log(`⚠️ 任务提交: ${JSON.stringify(result)}`);
    return false;
}

// GET /ycloud/signin/page/popup
async function getPopup(account) {
    return await apiGet(account, "/ycloud/signin/page/popup");
}

// POST /ycloud/signin/public/getPopInfo
// Body: {"clientType":"iphone","version":"13.1.0"}
async function getPopInfo(account) {
    return await apiPost(account, "/ycloud/signin/public/getPopInfo", {
        clientType: "iphone",
        version: CLIENT_VERSION,
    });
}

// ======================== 任务处理 ========================
function getTaskName(t) { return t.name ? t.name.replace(/<[^>]+>/g, "") : `任务${t.id}`; }

function canAutoComplete(t) {
    if (t.state !== "WAIT") return false;
    if (!t.stepTypeSet || !t.stepTypeSet.includes("click")) return false;
    if (SKIP_TASK_IDS.includes(t.id)) return false;
    return true;
}

async function processTasks(account) {
    const tasks = await getTaskList(account);
    if (!tasks.length) { $.log("⚠️ 无任务"); return { s: 0, f: 0, k: 0 }; }
    let s = 0, f = 0, k = 0;
    $.log(`📊 共 ${tasks.length} 个任务`);
    for (const t of tasks) {
        const n = getTaskName(t);
        if (t.state === "FINISH") { $.log(`✅ ${t.id}(${n}) 已完成`); k++; continue; }
        if (!canAutoComplete(t)) { $.log(`⏭️ ${t.id}(${n}) 跳过`); k++; continue; }
        $.log(`🎯 ${t.id}(${n}) [${t.limitType}] ${t.content_display2 || ""}`);
        if (await clickTask(account, t.id)) {
            await randomDelay();
            if (await doTaskPost(account)) { $.log(`🎉 ${t.id}(${n}) 完成`); s++; }
            else f++;
        } else f++;
        await randomDelay();
    }
    return { s, f, k };
}

// ======================== 单账号 ========================
async function runForAccount(account, index) {
    const label = account.userDomainId ? `账号[${account.userDomainId.slice(-6)}]` : `账号#${index + 1}`;
    $.log(`\n${"=".repeat(40)}`);
    $.log(`🔹 ${label}`);
    $.log(`   Cookie长度: ${account.cookie.length}`);
    $.log(`   jwtToken长度: ${account.jwtToken.length}`);
    $.log(`   deviceId: ${account.deviceFingerprint.slice(0, 30)}...`);
    $.log(`${"=".repeat(40)}`);
    let summary = `${label}: `;

    try {
        // 0. 刷新 Token
        $.log("【0/4】刷新 Token");
        await refreshSsoToken(account);
        await randomDelay(500, 1000);

        // 1. 页面信息
        $.log("【1/4】检查签到状态");
        const pageInfo = await getPageInfo(account);
        await randomDelay();
        if (pageInfo && pageInfo.result) {
            $.log(`   今日: ${pageInfo.result.todaySignIn ? "✅已签" : "⚠️未签"}`);
        }

        // 2. 签到
        $.log("【2/4】执行签到");
        const signResult = await doSignIn(account);
        await randomDelay();
        if (signResult && signResult.code === 0) {
            const d = signResult.result;
            summary += `签到:${d.signCount || 0}天/+${d.signInPoints || 0}云朵 | `;
        } else {
            summary += "签到:失败 | ";
        }

        // 3. 任务
        $.log("【3/4】处理任务");
        const tr = await processTasks(account);
        summary += `任务:✅${tr.s}/❌${tr.f}/⏭${tr.k}`;

        // 4. 弹窗
        $.log("【4/4】弹窗奖励");
        await getPopup(account);
        await randomDelay();
        await getPopInfo(account);

        $.log(`\n📊 ${label} 结果: ${summary}`);
        return summary;
    } catch (e) {
        $.logErr(`❌ ${label} 异常: ${e.message}`);
        return `${label}: 异常(${e.message})`;
    }
}

// ======================== 主流程 ========================
async function main() {
    $.log("=".repeat(50));
    $.log("🚀 中国移动云盘 · 云朵中心");
    $.log("=".repeat(50));

    const rawToken = process.env.MCLOUD_TOKEN || "";
    if (!rawToken || rawToken.length < 10) {
        $.log("❌ 未配置 MCLOUD_TOKEN");
        $.log("💡 获取: 抓包 m.mcloud.139.com 请求的 Cookie → 粘贴到 MCLOUD_TOKEN");
        $.notify("中国移动云盘", "❌ 未配置", "MCLOUD_TOKEN 为空");
        return;
    }

    const cookieList = splitAccounts(rawToken);
    $.log(`📋 检测到 ${cookieList.length} 个账号`);
    cookieList.forEach((c, i) => $.log(`   [#${i + 1}] 长度=${c.length} 开头: ${c.slice(0, 50)}...`));
    $.log("");

    const accounts = [];
    for (const cs of cookieList) {
        const acc = parseAccount(cs);
        if (!acc.jwtToken && !acc.cookieTokenKey) { $.log("⚠️ 跳过无效 Cookie"); continue; }
        accounts.push(acc);
        $.log(`✅ 解析: domainId=${acc.userDomainId.slice(-8)} deviceId=${acc.deviceFingerprint.slice(0, 20)}...`);
    }
    if (!accounts.length) {
        $.log("❌ 无有效账号");
        $.notify("中国移动云盘", "❌ 解析失败", "Cookie 无效");
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
