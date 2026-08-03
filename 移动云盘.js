/*
 * 中国移动云盘 - 云朵中心自动任务脚本（青龙面板）
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

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ======================== 工具函数 ========================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min = 800, max = 2000) { return sleep(Math.floor(Math.random() * (max - min + 1)) + min); }

// ======================== 账号解析 ========================
function splitAccounts(raw) {
    if (!raw) return [];
    return raw.split(/&|\n/).map(s => s.trim()).filter(s => s.length > 10);
}

function parseAccount(tokenStr) {
    // 格式: Authorization值#手机号
    const parts = tokenStr.split("#");
    if (parts.length < 2) {
        $.logErr(`格式错误，需要 Authorization值#手机号`);
        return null;
    }
    let auth = parts[0].trim();
    const phone = parts[1].trim();
    if (!auth || !phone) {
        $.logErr(`Authorization 或 手机号为空`);
        return null;
    }
    // 自动补全 Basic 前缀
    if (!auth.startsWith("Basic ")) {
        auth = "Basic " + auth;
    }
    return { authorization: auth, phone };
}

// ======================== 认证流程 ========================

// 检查 Authorization token 有效期
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
                if (daysLeft <= 3) {
                    $.log(`⚠️ Authorization 即将过期，请及时更新!`);
                }
                return true;
            }
        }
    } catch (e) {
        $.log(`⚠️ 无法解析 Authorization 有效期`);
    }
    return true;
}

// Step 1: Authorization → ssoToken
async function getSsoToken(account) {
    const url = "https://orches.yun.139.com/orchestration/auth-rebuild/token/v1.0/querySpecToken";
    try {
        const resp = await axios({
            method: "POST",
            url: url,
            headers: {
                "Authorization": account.authorization,
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            data: {
                account: account.phone,
                toSourceId: "001005",
            },
            timeout: 15000,
            validateStatus: () => true,
            httpsAgent,
        });
        if (resp.data && resp.data.success && resp.data.data && resp.data.data.token) {
            return resp.data.data.token;
        }
        $.logErr(`ssoToken 获取失败: ${JSON.stringify(resp.data).slice(0, 200)}`);
        return null;
    } catch (e) {
        $.logErr(`ssoToken 请求异常: ${e.message}`);
        return null;
    }
}

// Step 2: ssoToken → jwtToken
async function getJwtToken(ssoToken) {
    const url = `https://caiyun.feixin.10086.cn:7071/portal/auth/tyrzLogin.action?ssoToken=${ssoToken}`;
    try {
        const resp = await axios({
            method: "POST",
            url: url,
            headers: {
                "User-Agent": USER_AGENT,
                "Accept": "*/*",
            },
            timeout: 15000,
            validateStatus: () => true,
            httpsAgent,
        });
        if (resp.data && resp.data.code === 0 && resp.data.result && resp.data.result.token) {
            return resp.data.result.token;
        }
        $.logErr(`jwtToken 获取失败: ${JSON.stringify(resp.data).slice(0, 200)}`);
        return null;
    } catch (e) {
        $.logErr(`jwtToken 请求异常: ${e.message}`);
        return null;
    }
}

// 完整认证: Authorization → ssoToken → jwtToken
async function authenticate(account) {
    checkAuthExpiry(account.authorization);

    $.log("【认证】获取 ssoToken...");
    const ssoToken = await getSsoToken(account);
    if (!ssoToken) return null;

    $.log("【认证】获取 jwtToken...");
    const jwtToken = await getJwtToken(ssoToken);
    if (!jwtToken) return null;

    $.log("✅ 认证成功");
    return jwtToken;
}

// ======================== HTTP 请求 ========================
function buildHeaders(jwtToken, isPost = false) {
    const headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh-Hans;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "jwtToken": jwtToken,
        "activityId": ACTIVITY_ID,
        "appVersion": APP_VERSION,
        "showLoading": "true",
        "Cache-Control": "no-cache",
        "User-Agent": USER_AGENT,
        "Cookie": `jwtToken=${jwtToken}`,
        "Connection": "keep-alive",
    };
    if (isPost) {
        headers["Content-Type"] = "application/json;charset=UTF-8";
        headers["Origin"] = BASE_URL;
    }
    return headers;
}

async function httpRequest(method, jwtToken, path, body, queryParams) {
    const url = BASE_URL + path;
    const isPost = method === "POST";
    const headers = buildHeaders(jwtToken, isPost);

    const config = {
        method,
        url,
        headers,
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: () => true,
        decompress: true,
        httpsAgent,
    };

    if (queryParams && Object.keys(queryParams).length > 0) {
        config.params = queryParams;
    }
    if (isPost) {
        config.data = body || {};
    }

    try {
        const resp = await axios(config);
        const status = resp.status;
        let data = resp.data;

        if (typeof data === "string") {
            if (data.includes("<html") || data.includes("nginx") || data.includes("<!DOCTYPE")) {
                $.logErr(`  HTTP ${status} - 返回HTML(非JSON) path=${path}`);
                return { success: false, data: null, status };
            }
            try { data = JSON.parse(data); } catch (e) { /* 保持字符串 */ }
        }
        return { success: status >= 200 && status < 300, data, status };
    } catch (e) {
        $.logErr(`  网络异常: ${e.message} path=${path}`);
        return { success: false, data: null, status: 0 };
    }
}

async function apiGet(jwtToken, path, queryParams) {
    const r = await httpRequest("GET", jwtToken, path, null, queryParams);
    if (!r.success && r.status !== 0) {
        $.logErr(`[GET] ${path} → HTTP ${r.status}`);
    }
    return r.data;
}

async function apiPost(jwtToken, path, body, queryParams) {
    const r = await httpRequest("POST", jwtToken, path, body, queryParams);
    if (!r.success && r.status !== 0) {
        $.logErr(`[POST] ${path} → HTTP ${r.status}`);
    }
    return r.data;
}

// ======================== API 接口 ========================

// 签到状态
async function getPageInfo(jwtToken) {
    const result = await apiGet(jwtToken, "/ycloud/signin/page/infoV3", { client: "app" });
    if (result && result.code === 0) return result;
    $.log(`❌ 页面信息失败: ${JSON.stringify(result).slice(0, 200)}`);
    return null;
}

// 签到
async function doSignIn(jwtToken) {
    const result = await apiGet(jwtToken, "/ycloud/signin/page/startSignIn", { client: "app" });
    if (result && result.code === 0) {
        const d = result.result;
        $.log(`✅ 签到成功 | 连续${d.signCount || 0}天 | +${d.signInPoints || 0}云朵`);
        return result;
    }
    if (result && (result.code === 1001 || result.code === 1099)) {
        $.log("⚠️ 今日已签到");
        return { code: 0, result: { todaySignIn: true, signCount: 0, signInPoints: 0 } };
    }
    $.log(`❌ 签到失败: ${JSON.stringify(result).slice(0, 200)}`);
    return null;
}

// 任务列表
async function getTaskList(jwtToken) {
    const result = await apiPost(jwtToken, "/ycloud/signin/task/taskListV3", {
        marketname: ACTIVITY_ID,
        clientVersion: CLIENT_VERSION,
    });
    if (result && result.code === 0) return result.result || [];
    $.log(`❌ 任务列表失败: ${JSON.stringify(result).slice(0, 200)}`);
    return [];
}

// 点击任务
async function clickTask(jwtToken, taskId) {
    const result = await apiGet(jwtToken, "/ycloud/signin/task/click", { key: "task", id: String(taskId) });
    if (result && result.code === 0) return true;
    $.log(`⚠️ 任务${taskId} 点击: ${JSON.stringify(result).slice(0, 150)}`);
    return false;
}

// 完成任务
async function doTaskPost(jwtToken) {
    const result = await apiPost(jwtToken, "/ycloud/signin/page/doTaskPost", { client: "app" });
    if (result && result.code === 0) return true;
    $.log(`⚠️ 任务提交: ${JSON.stringify(result).slice(0, 150)}`);
    return false;
}

// 弹窗奖励
async function getPopup(jwtToken) {
    return await apiGet(jwtToken, "/ycloud/signin/page/popup");
}

// ======================== 任务处理 ========================
function getTaskName(t) { return t.name ? t.name.replace(/<[^>]+>/g, "") : `任务${t.id}`; }

function canAutoComplete(t) {
    if (t.state !== "WAIT") return false;
    if (!t.stepTypeSet || !t.stepTypeSet.includes("click")) return false;
    if (SKIP_TASK_IDS.includes(t.id)) return false;
    return true;
}

async function processTasks(jwtToken) {
    const tasks = await getTaskList(jwtToken);
    if (!tasks.length) { $.log("⚠️ 无任务"); return { s: 0, f: 0, k: 0 }; }
    let s = 0, f = 0, k = 0;
    $.log(`📊 共 ${tasks.length} 个任务`);
    for (const t of tasks) {
        const n = getTaskName(t);
        if (t.state === "FINISH") { $.log(`✅ ${t.id}(${n}) 已完成`); k++; continue; }
        if (!canAutoComplete(t)) { $.log(`⏭️ ${t.id}(${n}) 跳过`); k++; continue; }
        $.log(`🎯 ${t.id}(${n}) [${t.limitType || "N/A"}]`);
        if (await clickTask(jwtToken, t.id)) {
            await randomDelay();
            if (await doTaskPost(jwtToken)) { $.log(`🎉 ${t.id}(${n}) 完成`); s++; }
            else f++;
        } else f++;
        await randomDelay();
    }
    return { s, f, k };
}

// ======================== 单账号执行 ========================
async function runForAccount(account, index) {
    const label = `账号[${account.phone.slice(-4)}]`;
    $.log(`\n${"=".repeat(40)}`);
    $.log(`🔹 ${label}`);
    $.log(`   手机号: ${account.phone}`);
    $.log(`${"=".repeat(40)}`);
    let summary = `${label}: `;

    // 1. 认证
    const jwtToken = await authenticate(account);
    if (!jwtToken) {
        $.logErr(`❌ ${label} 认证失败`);
        return `${label}: 认证失败`;
    }

    try {
        // 2. 签到状态
        $.log("【1/4】检查签到状态");
        const pageInfo = await getPageInfo(jwtToken);
        await randomDelay();
        if (pageInfo && pageInfo.result) {
            const r = pageInfo.result;
            $.log(`   连续签到: ${r.signCount || 0}天 | 云朵: ${r.total || 0}`);
        }

        // 3. 签到
        $.log("【2/4】执行签到");
        const signResult = await doSignIn(jwtToken);
        await randomDelay();
        if (signResult && signResult.code === 0) {
            const d = signResult.result;
            summary += `签到:${d.signCount || 0}天/+${d.signInPoints || 0}云朵 | `;
        } else {
            summary += "签到:失败 | ";
        }

        // 4. 任务
        $.log("【3/4】处理任务");
        const tr = await processTasks(jwtToken);
        summary += `任务:✅${tr.s}/❌${tr.f}/⏭${tr.k}`;

        // 5. 弹窗奖励
        $.log("【4/4】弹窗奖励");
        await getPopup(jwtToken);

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
