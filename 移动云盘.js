/*
 * 中国移动云盘 - 云朵中心自动任务脚本（青龙面板）
 *
 * 功能：每日签到 + 自动完成任务 + 弹窗奖励 + 多账号
 *
 * ====================== 唯一环境变量 ======================
 *  MCLOUD_TOKEN  — 完整 Cookie 字符串，多账号用 & 或换行分隔
 *
 * ====================== 抓包获取方式 ======================
 *  1. iOS 装 Stream / Android 装 HttpCanary
 *  2. 打开移动云盘 APP → 我的 → 云朵中心
 *  3. 找到 m.mcloud.139.com 的任意请求
 *  4. 复制请求头中 Cookie 字段的完整值
 *  5. 粘贴到青龙面板环境变量 MCLOUD_TOKEN
 *
 * 定时规则：0 8 * * *（每天 8:00）
 */

const axios = require("axios");
const crypto = require("crypto");

// ======================== 自包含 Env 类 ========================

class Env {
    constructor(name) {
        this.name = name;
        this.startTime = Date.now();
        console.log(`\n## 开始执行... ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
        console.log(`## 脚本: ${name}`);
    }

    log(msg) {
        console.log(msg);
    }

    logErr(msg) {
        console.error(`[ERROR] ${msg}`);
    }

    notify(title, subtitle, content) {
        // 青龙面板会自动从 console.log 提取通知内容
        console.log(`\n📢 ${title} - ${subtitle}`);
        console.log(content);
    }

    done() {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        console.log(`\n## 执行完成，耗时 ${elapsed} 秒`);
    }
}

const $ = new Env("中国移动云盘云朵中心");

// ======================== 配置解析 ========================

function parseCookieValue(cookieStr, key) {
    const regex = new RegExp(`(?:^|;\\s*)${key}=([^;]*)`);
    const match = cookieStr.match(regex);
    return match ? decodeURIComponent(match[1]) : "";
}

/**
 * 基于账号生成稳定设备指纹（MD5）
 */
function generateDeviceFingerprint(accountId) {
    return crypto.createHash("md5").update(accountId + "mcloud_device_2024").digest("hex");
}

/**
 * 清洗 Cookie：去除尾部非 Cookie 内容（如 "Connection: keep-alive"）
 */
function cleanCookie(raw) {
    // 去掉末尾换行后不属于 Cookie 的行
    return raw
        .replace(/[\n\r]+Connection:.*$/i, "")
        .replace(/[\n\r]+$/, "")
        .trim();
}

/**
 * 从单条 Cookie 字符串解析出所有配置
 */
function parseAccount(cookieStr) {
    const cleaned = cleanCookie(cookieStr);
    const jwtToken = parseCookieValue(cleaned, "jwtToken");
    const userDomainId = parseCookieValue(cleaned, "userDomainId");
    const cookieToken = parseCookieValue(cleaned, "cookieToken");
    const cookieTokenKey = parseCookieValue(cleaned, "cookieTokenKey");

    const accountId = userDomainId;
    const deviceFingerprint = accountId
        ? generateDeviceFingerprint(accountId)
        : crypto.createHash("md5").update(jwtToken).digest("hex");

    return {
        cookie: cleaned,
        jwtToken: jwtToken,
        userDomainId: userDomainId,
        cookieToken: cookieToken,
        cookieTokenKey: cookieTokenKey,
        deviceFingerprint: deviceFingerprint,
    };
}

/**
 * 分割多账号字符串（支持 & 或换行分隔）
 */
function splitAccounts(raw) {
    if (!raw) return [];
    return raw
        .split(/[\n\r]+/)
        .flatMap(line => line.split("&"))
        .map(s => s.trim())
        .filter(s => s.length > 10);
}

// ======================== 全局配置 ========================

const ACTIVITY_ID = "sign_in_3";
const APP_VERSION = "13.1.0.0";
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) MCloudApp/13.1.0 iPhone AppLanguage/zh-CN";
const BASE_URL = "https://m.mcloud.139.com";
const SKIP_TASK_IDS = (process.env.MCLOUD_SKIP_TASK_IDS || "")
    .split(",").map(id => parseInt(id.trim())).filter(Boolean);

// ======================== 工具函数 ========================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min = 800, max = 2000) {
    return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

function buildHeaders(account) {
    return {
        "Host": "m.mcloud.139.com",
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh-Hans;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Origin": "https://m.mcloud.139.com",
        "Referer": "https://m.mcloud.139.com/portal/mobilecloud/index.html?path=newsignin&sourceid=1097",
        "jwtToken": account.jwtToken,
        "deviceId": account.deviceFingerprint,
        "activityId": ACTIVITY_ID,
        "appVersion": APP_VERSION,
        "User-Agent": USER_AGENT,
        "Cookie": account.cookie,
        "Connection": "keep-alive",
    };
}

async function apiGet(account, path, queryParams = {}) {
    const headers = buildHeaders(account);
    try {
        const resp = await axios.get(BASE_URL + path, {
            headers, params: queryParams, timeout: 30000,
        });
        return resp.data;
    } catch (e) {
        if (e.response) return e.response.data;
        $.logErr(`[GET] ${path}: ${e.message}`);
        return null;
    }
}

async function apiPost(account, path, body = null, queryParams = {}) {
    const headers = buildHeaders(account);
    try {
        const resp = await axios.post(BASE_URL + path, body || undefined, {
            headers, params: queryParams, timeout: 30000,
        });
        return resp.data;
    } catch (e) {
        if (e.response) return e.response.data;
        $.logErr(`[POST] ${path}: ${e.message}`);
        return null;
    }
}

// ======================== API 接口 ========================

async function getPageInfo(account) {
    const result = await apiPost(account, "/ycloud/signin/page/infoV3", null, { client: "app" });
    if (result && result.code === 0) return result;
    $.log(`❌ 获取页面信息失败: ${JSON.stringify(result)}`);
    return null;
}

async function doSignIn(account) {
    const result = await apiPost(account, "/ycloud/signin/page/startSignIn", null, { client: "app" });
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

async function getTaskList(account) {
    const result = await apiPost(account, "/ycloud/signin/task/taskListV3");
    if (result && result.code === 0) return result.result || [];
    $.log(`❌ 获取任务列表失败: ${JSON.stringify(result)}`);
    return [];
}

async function clickTask(account, taskId) {
    const result = await apiGet(account, "/ycloud/signin/task/click", {
        key: "task", id: String(taskId)
    });
    if (result && result.code === 0) return true;
    $.log(`⚠️ 任务${taskId} 点击返回: ${JSON.stringify(result)}`);
    return false;
}

async function doTaskPost(account) {
    const result = await apiPost(account, "/ycloud/signin/page/doTaskPost", {
        client: "app",
        deviceId: account.deviceFingerprint,
    });
    if (result && result.code === 0) return true;
    $.log(`⚠️ 任务提交返回: ${JSON.stringify(result)}`);
    return false;
}

// ======================== 任务处理 ========================

function getTaskName(task) {
    return task.name ? task.name.replace(/<[^>]+>/g, "") : `任务${task.id}`;
}

function canAutoComplete(task) {
    if (task.state !== "WAIT") return false;
    if (!task.stepTypeSet || !task.stepTypeSet.includes("click")) return false;
    if (SKIP_TASK_IDS.includes(task.id)) {
        $.log(`⏭️ 任务${task.id} 在跳过列表中`);
        return false;
    }
    return true;
}

async function processTasks(account) {
    const tasks = await getTaskList(account);
    if (!tasks.length) {
        $.log("⚠️ 无任务");
        return { success: 0, failed: 0, skipped: 0 };
    }

    let sc = 0, fc = 0, sk = 0;

    const groups = {};
    tasks.forEach(t => {
        const g = t.groupid || "other";
        groups[g] = (groups[g] || 0) + 1;
    });
    $.log(`📊 任务分布: ${JSON.stringify(groups)}`);

    for (const task of tasks) {
        const name = getTaskName(task);

        if (task.state === "FINISH") {
            $.log(`✅ ${task.id}(${name}) 已完成`);
            sk++; continue;
        }
        if (!canAutoComplete(task)) {
            $.log(`⏭️ ${task.id}(${name}) 跳过 [${task.state}]`);
            sk++; continue;
        }

        $.log(`🎯 ${task.id}(${name}) [${task.limitType}] ${task.content_display2 || ""}`);

        if (await clickTask(account, task.id)) {
            await randomDelay();
            if (await doTaskPost(account)) {
                $.log(`🎉 ${task.id}(${name}) 完成`);
                sc++;
            } else {
                fc++;
            }
        } else {
            fc++;
        }
        await randomDelay();
    }

    return { success: sc, failed: fc, skipped: sk };
}

// ======================== 单账号执行 ========================

async function runForAccount(account, index) {
    const label = account.userDomainId
        ? `账号[${account.userDomainId.slice(-6)}]`
        : `账号#${index + 1}`;

    $.log(`\n${"=".repeat(40)}`);
    $.log(`🔹 ${label} 开始`);
    $.log(`   指纹: ${account.deviceFingerprint.slice(0, 16)}...`);
    $.log(`${"=".repeat(40)}`);

    let summary = `${label}: `;

    try {
        $.log("【1/4】检查签到状态");
        const pageInfo = await getPageInfo(account);
        await randomDelay();

        if (pageInfo && pageInfo.result) {
            $.log(`   今日: ${pageInfo.result.todaySignIn ? "✅已签" : "⚠️未签"}`);
        }

        $.log("【2/4】执行签到");
        const signResult = await doSignIn(account);
        await randomDelay();

        if (signResult && signResult.code === 0) {
            const d = signResult.result;
            summary += `签到:${d.signCount || 0}天/+${d.signInPoints || 0}云朵 | `;
        } else {
            summary += "签到:失败 | ";
        }

        $.log("【3/4】处理任务");
        const tr = await processTasks(account);
        summary += `任务:✅${tr.success}/❌${tr.failed}/⏭${tr.skipped}`;

        $.log("【4/4】弹窗奖励");
        await apiPost(account, "/ycloud/signin/page/popup");
        await randomDelay();
        await apiPost(account, "/ycloud/signin/public/getPopInfo");

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
        $.log("");
        $.log("❌ 未配置 MCLOUD_TOKEN 环境变量");
        $.log("");
        $.log("💡 获取方法：");
        $.log("  ① iOS 装 Stream / Android 装 HttpCanary");
        $.log("  ② 打开移动云盘 APP → 我的 → 云朵中心");
        $.log("  ③ 找到 m.mcloud.139.com 的请求");
        $.log("  ④ 复制 Cookie 完整值");
        $.log("  ⑤ 粘贴到青龙面板环境变量 MCLOUD_TOKEN");
        $.log("");
        $.log("📌 多账号：用 & 或换行分隔");
        $.notify("中国移动云盘", "❌ 未配置", "MCLOUD_TOKEN 为空");
        return;
    }

    const cookieList = splitAccounts(rawToken);
    $.log(`📋 检测到 ${cookieList.length} 个账号`);
    $.log("");

    const accounts = [];
    for (const cookieStr of cookieList) {
        const acc = parseAccount(cookieStr);
        if (!acc.jwtToken) {
            $.log(`⚠️ 跳过无效 Cookie (缺少 jwtToken): ${cookieStr.slice(0, 50)}...`);
            continue;
        }
        accounts.push(acc);
        $.log(`✅ 解析: domainId=${acc.userDomainId.slice(-8)} 指纹=${acc.deviceFingerprint.slice(0, 12)}...`);
    }

    if (accounts.length === 0) {
        $.log("❌ 没有解析到有效账号");
        $.notify("中国移动云盘", "❌ 解析失败", "Cookie 格式无效");
        return;
    }

    $.log("");

    const allResults = [];
    for (let i = 0; i < accounts.length; i++) {
        const result = await runForAccount(accounts[i], i);
        allResults.push(result);
        if (i < accounts.length - 1) await sleep(2000);
    }

    const finalSummary = allResults.join("\n");
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
}).finally(() => {
    $.done();
});