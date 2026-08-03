/*
 * 中国移动云盘 - 云朵中心自动任务脚本（青龙面板）
 * 参照 ydyp v5.0.10 Python 脚本优化
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
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

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

// 算力大作战配置
const TOKENPK_MARKET_NAME = "National_TokenPK";
const TOKENPK_SOURCE_ID = "1030";
const TOKENPK_PRIZE_PAGE_URL = "https://m.mcloud.139.com/portal/cloudItem/index.html?path=getPrize&sourceid=1102";
const TOKENPK_INVITE_CODE = "eb11f7338ef147c48b39d92ec14e75bd2008";

// 红包派对配置
const RED_PACKET_BASE = "https://cpactiv.buy.139.com/cloudphone-market";
const RED_PACKET_PAGE_URL = "https://cpactiv.buy.139.com/#/redEnvelopeParty/home?channelSrc=red-cmccapp";
const RED_PACKET_APP_ID = "12345681";
const RED_PACKET_SIGN_KEY = "e10adc3949ba59abbe56e057f20f883e";
const RED_PACKET_CHANNEL_SRC = "red-cmccapp";
const RED_PACKET_VERSION = "SYS_CONFIG_Y";
const RED_PACKET_SOURCE_ID = "001216";
const RED_PACKET_BROWSE_TASKS = new Set(["NOVICE_2", "NOVICE_3", "MONTHLY_1"]);
const RED_PACKET_DIRECT_TASKS = new Set(["MONTHLY_4", "MONTHLY_5"]);
const RED_PACKET_KNOWN_ANSWERS = {
    "\u5982\u4f55\u67e5\u770b\u5e76\u66f4\u65b0\u79fb\u52a8\u4e91\u624b\u673a\u5ba2\u6237\u7aef\u6700\u65b0\u7248\u672c\uff1f": `\u8fdb\u5165\u201c\u6211\u7684\u201d-\u70b9\u51fb\u201c\u5173\u4e8e\u4e91\u624b\u673a\u201d-\u70b9\u51fb\u201c\u68c0\u67e5\u65b0\u7248\u672c\u201d`,
    "\u79fb\u52a8\u4e91\u624b\u673a\u53ef\u9886\u53d6\u5b9a\u5411\u6d41\u91cf\uff0c\u6bcf\u6708\u8d60\u9001\u7684\u5b9a\u5411\u6d41\u91cf\u662f\uff08  \uff09\u3002": "30GB",
    "\u79fb\u52a8\u4e91\u624b\u673a\u7aef\u5185\u8ba2\u8d2d\u7684\u4e13\u4e1a\u7248\u5206\u8fa8\u7387\u5df2\u5347\u7ea7\u52301080P\uff0c\u8be5\u8bf4\u6cd5\u662f\u5426\u6b63\u786e\uff1f": "\u6b63\u786e",
    "\u79fb\u52a8\u4e91\u624b\u673a\u652f\u6301\u89c6\u9891\u5f55\u5236\uff0c\u8be5\u8bf4\u6cd5\u662f\u5426\u6b63\u786e\uff1f": "\u6b63\u786e",
    "\u4e91\u624b\u673a\u652f\u6301\u901a\u8fc7\u624b\u673a\u3001\u5e73\u677f\u3001\u7535\u8111\u7b49\u591a\u79cd\u7ec8\u7aef\u8bbe\u5907\u767b\u5f55\u4f7f\u7528\uff0c\u8be5\u8bf4\u6cd5\u662f\u5426\u6b63\u786e\uff1f": "\u6b63\u786e",
    "\u4f7f\u7528\u4e2d\u56fd\u79fb\u52a8\u53f7\u7801\u767b\u5f55\u79fb\u52a8\u4e91\u624b\u673a\uff0c\u662f\u5426\u652f\u6301\u624b\u673a\u53f7\u4e00\u952e\u767b\u5f55\uff1f": "\u652f\u6301",
    "\u53ea\u6709\u4e2d\u56fd\u79fb\u52a8\u8fd0\u8425\u5546\u53f7\u7801\u80fd\u4f7f\u7528\u79fb\u52a8\u4e91\u624b\u673a\uff1f": "\u4e0d\u6b63\u786e",
    "\u79fb\u52a8\u4e91\u624b\u673a\u662f\u5426\u9700\u8981\u5145\u7535\u4f7f\u7528\uff1f": "\u4e0d\u9700\u8981",
    "\u79fb\u52a8\u4e91\u624b\u673a\u652f\u6301\u622a\u56fe\uff0c\u8be5\u8bf4\u6cd5\u662f\u5426\u6b63\u786e\uff1f": "\u6b63\u786e",
    "\u79fb\u52a8\u4e91\u624b\u673aAI\u7075\u7280\u52a9\u624b\u5df2\u63a5\u5165DeepSeek\uff0c\u662f\u5426\u6b63\u786e\uff1f": "\u6b63\u786e",
    "\u79fb\u52a8\u4e91\u624b\u673a\u5185\u652f\u6301\u753b\u9762\u6e05\u6670\u5ea6\u5207\u6362\uff0c\u8be5\u8bf4\u6cd5\u662f\u5426\u6b63\u786e\uff1f": "\u6b63\u786e",
    "\u79fb\u52a8\u4e91\u624b\u673a\u652f\u6301\u8fde\u63a5\u84dd\u7259\u4f7f\u7528\u5417\uff1f": "\u4e0d\u652f\u6301",
    "\u5728\u4e91\u624b\u673a\u5185\u5b89\u88c5\u6e38\u620f\u5e94\u7528\u662f\u5426\u5360\u672c\u5730\u624b\u673a\u5b58\u50a8\u7a7a\u95f4\uff1f": "\u5426\uff0c\u4e0d\u5360\u672c\u5730\u7a7a\u95f4",
    "\u5982\u4f55\u66f4\u6362\u4e91\u673a\u5185\u7684\u684c\u9762\u4e3b\u9898\u6216\u58c1\u7eb8\uff1f": `\u4e91\u673a\u5185-\u3010\u8bbe\u7f6e\u3011-\u58c1\u7eb8/\u4e2a\u6027\u4e3b\u9898`,
    "\u5982\u4f55\u5c06\u4e91\u624b\u673a\u91cc\u7684\u5e94\u7528\u6dfb\u52a0\u81f3\u672c\u5730\u624b\u673a\u684c\u9762\uff1f": `\u4e91\u624b\u673a\u684c\u9762-\u957f\u6309\u5e94\u7528-\u53d1\u9001\u56fe\u6807\u5230\u672c\u5730`,
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ======================== 存储路径 ========================
function getStorageDir() {
    const custom = process.env.ydyp_storage_dir || process.env.YDYP_STORAGE_DIR || "";
    if (custom) {
        try { fs.mkdirSync(custom, { recursive: true }); } catch (e) {}
        return custom;
    }
    // 青龙面板脚本目录 或 当前目录
    const scriptDir = path.dirname(process.argv[1] || __dirname || ".");
    return scriptDir;
}

function getStorageFilePath(filename) {
    return path.join(getStorageDir(), filename);
}

const DEVICE_ID_STORAGE_FILE = "ydyp_device_ids.json";

function loadDeviceIdStorage() {
    try {
        const filePath = getStorageFilePath(DEVICE_ID_STORAGE_FILE);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, "utf-8"));
        }
    } catch (e) {}
    return {};
}

function saveDeviceIdStorage(data) {
    try {
        const filePath = getStorageFilePath(DEVICE_ID_STORAGE_FILE);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
        $.logErr(`保存存储失败: ${e.message}`);
    }
}

function getStoredDeviceId(phone) {
    const data = loadDeviceIdStorage();
    return (data[phone] || {}).deviceId || "";
}

function saveDeviceId(phone, deviceId) {
    const data = loadDeviceIdStorage();
    if (!data[phone]) data[phone] = {};
    data[phone].deviceId = deviceId;
    saveDeviceIdStorage(data);
}

function getTokenpkAssistState(phone) {
    const data = loadDeviceIdStorage();
    return {
        code: (data[phone] || {}).tokenpkAssistCode || "",
        month: (data[phone] || {}).tokenpkAssistMonth || "",
    };
}

function saveTokenpkAssistState(phone, code, month) {
    const data = loadDeviceIdStorage();
    if (!data[phone]) data[phone] = {};
    data[phone].tokenpkAssistCode = code;
    data[phone].tokenpkAssistMonth = month;
    saveDeviceIdStorage(data);
}

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

// ======================== 设备指纹 ========================
const DEVICE_PROFILE_URL = "https://slw.h5cmpassport.com:9090/deviceprofile/v4";
const DEVICE_PROFILE_PAYLOAD = {
    "appId": "default",
    "organization": "FXlyfmWg2AzwbrxDKSv5",
    "ep": "WydTnuOv+Rtg/Qj8Q4vnhSXJN4UHQPF2jjs+LVJkD3u8HXglndPAndOgrlmg2Q8q0FUQRZpN0N7e61ebhjw/Gba22ydgOMbBRfbSmKSnNWaACA+MzAX5Q4dd980zPqelMxGVzB3jkr1wGE6cVQkwWFq/xbdnkK/Sh6xrPDjYvho=",
    "data": "5b5f2054405d6155102ed35a134758f768e60b7c1ac7af66acb16871d78a099cbcbabb3fb5ebeefe6cbae063407fca585a343ce5bef4f4e4588df42ca8ae8a6504b3646066fd7dc46465a83d510fbb477ba72f7375db7cbcba9b712ec88d85fc8d410536b96ca644c8ca3afbca00e0084ad9709b93b86923bf1fadef48be3e888b52dd2775c180b5b8e7bae139fadf2944f73010be9704daa6f4cf596b4adccff7b5de84e45698b781d963b69fa8ec28e43083512ab5749ea05c4efce14945d647c9f33d6296750ff2ba59bff5b7fcf698ffa146b7fe7e5c405b13100818b53fd034d05edea63c8365d9113bc7d4c0652892fcae75cdb491ae0215fbd822b1877b209fc8c68710badc6915080b7b994fa4b86a8f7b37e929cecbd1c590ad7382beb3ae8b9cc56ed84e927cbe41d8b4b15bbeecc69f5463d402cc2732fe5b76ec201632afbc16228531a65c1810482e4eb48157bc8b23cd363c6809a3fd629e3520514c06a720616e1788fe10203f9ebfa1de24c66213e334e3a3b3ff8a8866b7aefd9b4f2c88d216f45b551d693433940569092f0c7aca25019dc2003e8eab1967ac1dc32b0912701b0abc17e0509bada0cf0fcbe3c5fb64f0d5c6f02303b1540829a301673da89f7460d00190bda07c9b82c263277066f8e7e91c4916f247f9d9fe295a46d16cd087cee865d9e50edeb8e88842c560b09f853b5f89d2d0c4ed160f5bc293f7c69ece9e2d64d7217857fd2d64d57bea1ccea1b52896bb9aaf2ec3baa2421bce8d011813a1b26f0acb3a3cf594298bd7258f8da17717b965f85e46a52c758ed1e95218e06f7e96a9f13e4855a0bb4bcf8b5f571887ec58c7438e99f06562414bcb274038fe6ffc1b8991021e35866cef5010184e3fbbd49c19d6020315731e9e57b7cd6a1e8b33c97746a782f9b4a26696966f40324f1ff76d3d1d24bf544230438dc32ab26d6dc107adf9feac34ffbbaa8814cec674e9469de54a714273a47f4fd06561e611f6741a4f0362a3b8821b0c69a3a04ced876fbf1b5fdc58097b1d7087aa2c0df556f8a06288db8c306cda4525d91c0452a0d2747982bd70b31c6905d4e483e8519d4d605af776be2a81224e3a6cc0b6ec49ad2cdb434bd85b5079ff86f68bf5ebb41336f30ec84fe19fabbd10a4422a274a3749d70c6b39cf7cdc1eb0cb228abee2475d16c57635a332628727b76a1fac0b26bf7bbdf4c5b956261919e7d2bd67733656855503670d48fe3680d04b65aac48d99bd47aedb6091c0a6df53be5bd662c1130feb6b469578cb146e1ae004471641fbc028cc06b80cfcdc50f8231e58b4126ab750b1d02eb8ac417b53a5ae50846db9aeadf4f1c98e33228db5143cb3d928217b769eaf32d181320a0bee4805334c28a03995d925b52fda358d19c52e3838c243b8c7d3256337943705c1311526c290fad975b7d7ade4bbc9292dbd7b9c0314715ef3c785a720e674dc23538af333cc6ff541aea70086287a8b4407c66ce673c9a47268de014c876a3a6a577d501285f6f489e2519f51bf4feafe307333a9e077f613527bbe1ce632127df654588410f713bb4a61e050cae618e98cc9adbb77d9df95733449c06e62094f3cdaf2ba39f94223ed7ca63ea4dec37d7283bdd0d2015511e7e57212073a540b308b10d7f85de73865fc2ffbf05a85ae25a7b52f0292236ee75f738add8144c7b2767a2100451363a47c12dfb674bd3ee000fa41565e9fbc60440a629160a2d2a99ec23dccc6815f644a2dd1eb059ab8593d9b04b1b81f5e427570cfc06eba8456b68159e6886843bcf4374b02de2e5be8d900882f78a71c2f3819d2e9c45e64b5d006c7a5914d1482f01ed5c0cfb44c3543656e96b5d91b39cd667af4dc60f44752da28eda57d2453d26a099529a2a38c9b9b2f0a73a69445030321b0a87287f6469f4d585739cded2e79c66df9c949eb7b2b8a8ff78e80a88ca494f3410195e021ec5009f8cd29781f09d58e6f866102072f1cee202c6ce21d72795b47a0ab8464fa54836c36a28ff73828e7a39dd1203d5a051ac4cd22b4f8c9f1e4e9c42f0c85b101b1eb495c0a767697dccab920489fae867ff38c5f917aec269d0ac9a1d6005407db762349d77e990581e19b1912fc975a9cdd2",
    "os": "web",
    "encode": 5,
    "compress": 2,
};

async function fetchDeviceId() {
    try {
        const resp = await axios({
            method: "POST",
            url: DEVICE_PROFILE_URL,
            headers: {
                "Content-Type": "application/json;charset=utf-8",
                "Origin": "https://m.mcloud.139.com",
                "Referer": "https://m.mcloud.139.com/",
            },
            data: DEVICE_PROFILE_PAYLOAD,
            timeout: 15000,
            validateStatus: () => true,
            httpsAgent,
        });
        const rawId = resp.data?.detail?.deviceId || "";
        if (rawId) return "B" + rawId;
    } catch (e) {
        $.log(`  ⚠️ 获取设备指纹失败: ${e.message}`);
    }
    return "";
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
async function buildMarketContext(jwtToken, ssoToken, account) {
    const userDomainId = extractUserDomainId(jwtToken);

    // deviceId 获取顺序: 设备指纹接口 → 环境变量 → 本地缓存 → 自动生成
    let deviceId = "";
    const envDeviceId = process.env.ydyp_device_id || process.env.YDYP_DEVICE_ID || "";
    const storedDeviceId = getStoredDeviceId(account.phone);

    // 优先从设备指纹接口获取
    deviceId = await fetchDeviceId();
    if (deviceId) {
        $.log(`🔧 deviceId: 设备指纹接口获取成功`);
        saveDeviceId(account.phone, deviceId);
    } else if (envDeviceId) {
        deviceId = envDeviceId;
        $.log(`🔧 deviceId: 环境变量`);
    } else if (storedDeviceId) {
        deviceId = storedDeviceId;
        $.log(`🔧 deviceId: 本地缓存`);
    } else {
        deviceId = generateDeviceId();
        $.log(`🔧 deviceId: 自动生成`);
        saveDeviceId(account.phone, deviceId);
    }

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
    await axios({
        method: "GET",
        url: ctx.pageUrl,
        headers: ctx.marketHeaders,
        timeout: 10000, validateStatus: () => true, httpsAgent,
    }).catch(() => {});
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
                   (name.endsWith(".jpg") && name.startsWith("auto_tokenpk_photo_"));
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
    const cleanDeviceId = deviceId.replace(/^B/, "");
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
        headers["x-yun-client-info"] = `4||1|${CLIENT_VERSION}|Apple|iPhone 16 Pro|${cleanDeviceId}|iOS 18.7|||||`;
        headers["x-yun-app-channel"] = "101";
    } else {
        headers.Accept = "*/*";
        headers["x-DeviceInfo"] = `||36|${CLIENT_VERSION}|Apple|iPhone 16 Pro|${cleanDeviceId}|iOS 18.7|||||`;
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

// ======================== AI相机样图 (PNG 256x256) ========================
function getAiCameraSampleBase64() {
    const width = 256, height = 256;
    const pixels = [];
    for (let y = 0; y < height; y++) {
        pixels.push(0); // filter byte
        for (let x = 0; x < width; x++) {
            const dx = x - 198, dy = y - 58;
            if (dx * dx + dy * dy < 28 * 28) {
                pixels.push(245, 166, 35); // orange circle
            } else if (y < 166) {
                pixels.push(82, 151, 210); // blue sky
            } else {
                pixels.push(67, 132, 78); // green ground
            }
        }
    }
    const rawPixels = Buffer.from(pixels);
    const compressed = zlib.deflateSync(rawPixels);

    function pngChunk(type, data) {
        const typeBuf = Buffer.from(type, "ascii");
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(data.length, 0);
        const crcData = Buffer.concat([typeBuf, data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(crcData) >>> 0, 0);
        return Buffer.concat([lenBuf, typeBuf, data, crc]);
    }

    function crc32(buf) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            crc ^= buf[i];
            for (let j = 0; j < 8; j++) {
                crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
            }
        }
        return crc;
    }

    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 2;  // color type (RGB)
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const png = Buffer.concat([
        signature,
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", compressed),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
    return `data:image/png;base64,${png.toString("base64")}`;
}

// ======================== AI相机任务 (585) ========================
async function completeAiCameraTask(ctx, account) {
    if (!ctx.userDomainId) {
        $.log("  ❌ AI相机: 缺少用户信息");
        return false;
    }
    $.log("  📸 AI相机: 发送识图请求...");
    const imageData = getAiCameraSampleBase64();
    const recognizePayload = JSON.stringify({
        channelId: "101", userId: ctx.userDomainId, recognizeType: "1",
        base64: imageData, sendType: "2", imageExt: "png",
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
        const fileName = taskId.match(/^\d+$/) ? `${parseInt(taskId) + 1}.png` : `${taskId}.png`;
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

    // 无click keys的任务：尝试强制点击（适用于cloudEmail等联动任务）
    if (group === "cloudEmail" || group === "time") {
        $.log(`  🎯 尝试点击: ${taskName}`);
        const clickData = await clickTask(ctx, taskId);
        if (clickData?.code === 0) {
            $.log(`  ✅ 已登记任务: ${taskName}`);
            return;
        }
        const caiyunClick = await caiyunGet(jwtToken, "/market/signin/task/click", { key: "task", id: String(taskId) });
        if (caiyunClick.data?.code === 0) {
            $.log(`  ✅ 已登记任务(caiyun): ${taskName}`);
            return;
        }
    }

    $.log(`  ⏳ 需手动完成: ${taskName}${getTaskProgress(task)}`);
}

// 获取所有任务分组 (v5.0.10: 移除 beiyong1 过期活动)
function getCloudTaskGroups() {
    return [
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
    await cleanupUploadedFiles(account);
}

// ======================== 算力大作战 (TokenPK) ========================
function buildTokenpkHeaders(ctx) {
    return {
        "Cache-Control": "no-cache",
        "User-Agent": MARKET_UA,
        "Accept": "*/*",
        "jwtToken": ctx.marketHeaders.jwtToken,
        "X-Requested-With": "com.chinamobile.mcloud",
        "Referer": `${MARKET_BASE}/portal/yunClound/index.html?path=${TOKENPK_MARKET_NAME}&sourceid=${TOKENPK_SOURCE_ID}&enableShare=1`,
        "deviceId": ctx.deviceId,
        "x-DeviceInfo": ctx.xDeviceInfo,
    };
}

async function requestTokenpkJson(ctx, pathUrl, data, method = "GET", extraHeaders) {
    const url = pathUrl.startsWith("http") ? pathUrl : MARKET_BASE + pathUrl;
    try {
        const headers = buildTokenpkHeaders(ctx);
        if (extraHeaders) Object.assign(headers, extraHeaders);
        const config = {
            method,
            url,
            headers,
            timeout: 15000,
            validateStatus: () => true,
            httpsAgent,
            decompress: true,
        };
        if (method === "GET") {
            config.params = data || {};
        } else {
            const contentType = headers["Content-Type"] || "application/json;charset=UTF-8";
            if (contentType.includes("x-www-form-urlencoded")) {
                config.data = data;
            } else {
                config.data = data || {};
                headers["Content-Type"] = "application/json;charset=UTF-8";
            }
        }
        const resp = await axios(config);
        let responseData = resp.data;
        if (typeof responseData === "string") {
            try { responseData = JSON.parse(responseData); } catch (e) {}
        }
        return responseData;
    } catch (e) {
        $.logErr(`  TokenPK 请求异常: ${e.message}`);
        return null;
    }
}

function buildTokenpkTaskPayload(task) {
    const appButton = (task.button || {}).app || {};
    return {
        marketName: TOKENPK_MARKET_NAME,
        taskId: task.id,
        key: appButton.ext || "",
        source: "app",
    };
}

function getTokenpkTaskName(task) {
    return (task.name || task.description || String(task.id || "")).replace(/<[^>]+>/g, "");
}

async function getTokenpkTaskList(ctx, logError = true) {
    const data = await requestTokenpkJson(ctx, "/ycloud/tokenpk/task/list", {
        marketName: TOKENPK_MARKET_NAME,
        platform: "ios",
        sortState: "true",
    });
    if (!data) {
        if (logError) $.log("  ⚠️ 获取算力大作战任务失败: 接口无响应");
        return null;
    }
    if (data.code !== 0) {
        if (logError) $.log(`  ⚠️ 获取算力大作战任务失败: ${data.msg || "未知错误"}`);
        return null;
    }
    return data.result || [];
}

async function getTokenpkTask(ctx, taskId) {
    const tasks = await getTokenpkTaskList(ctx, false);
    if (!tasks) return null;
    return tasks.find(t => t.id === taskId) || null;
}

function logTokenpkPrizes(prizes, defaultMessage) {
    const successful = (prizes || []).filter(p => p.success).map(p => p.prizeName || "");
    if (successful.length) {
        $.log(`  🎁 ${defaultMessage}: ${successful.join(" + ")}`);
        return true;
    }
    const errors = (prizes || []).filter(p => p.errorMsg).map(p => p.errorMsg);
    $.log(`  ${defaultMessage}: ${errors[0] || "成功"}`);
    return !errors.length;
}

async function receiveTokenpkTaskPrize(ctx, task) {
    const taskName = getTokenpkTaskName(task);
    const data = await requestTokenpkJson(ctx, "/ycloud/tokenpk/task/step/receivePrize", {
        marketName: TOKENPK_MARKET_NAME,
        taskId: task.id,
        source: "app",
    }, "POST");
    if (!data || data.code !== 0) {
        const msg = data?.msg || "接口无响应";
        $.log(`  ❌ 领取任务奖励失败: ${taskName} ${msg}`);
        return false;
    }
    logTokenpkPrizes((data.result || {}).prizes, `已领取: ${taskName}`);
    return true;
}

async function completeTokenpkUploadPhoto(account) {
    const uploadInfo = await createCloudFile(account, "auto_tokenpk_photo_", "jpg");
    if (!uploadInfo) {
        $.log("  ❌ 上传照片失败: 接口无响应");
        return false;
    }
    $.log(`  ✅ 已上传照片: ${uploadInfo.fileName}`);
    await cleanupUploadedFiles(account, uploadInfo);
    return true;
}

async function completeTokenpkAction(ctx, account, task) {
    const ext = buildTokenpkTaskPayload(task).key;
    if (ext === "uploadPhoto") return await completeTokenpkUploadPhoto(account);
    if (ext === "aiCamera") return await completeAiCameraTask(ctx, account);
    if (ext === "createNote") { await completeNoteTask(account); return true; }
    if (ext === "shareFile") return await completeShareFileTask(account, { id: 434 }) ? true : false;
    if (ext === "inviteFriend") {
        const inviteData = await requestTokenpkJson(ctx, "/ycloud/tokenpk/invite/generateInviteCode") || {};
        if (inviteData.code === 0 && inviteData.result) return true;
        $.log(`  ❌ 生成活动邀请码失败: ${inviteData.msg || "接口无响应"}`);
        return false;
    }
    if (ext === "openUrl" || ext === "xhsLike") return true;
    if (ext === "backup") { $.log("  ⏳ 需手动完成: 成功备份一次文件"); return false; }
    if (ext === "loginPc") { $.log("  ⏳ 需手动完成: 登录PC客户端上传文件"); return false; }
    $.log(`  ⏳ 暂不支持自动完成: ${getTokenpkTaskName(task)}`);
    return false;
}

async function reserveTokenpkTask(ctx, task) {
    const taskName = getTokenpkTaskName(task);
    const data = await requestTokenpkJson(ctx, "/ycloud/tokenpk/task/step/reserve", buildTokenpkTaskPayload(task), "POST");
    if (!data || data.code !== 0) {
        const msg = data?.msg || "接口无响应";
        $.log(`  ❌ 预约失败: ${taskName} ${msg}`);
        return false;
    }
    const prizes = (data.result || {}).prizes || [];
    if (prizes.length) {
        logTokenpkPrizes(prizes, `已领取预约奖励: ${taskName}`);
    } else {
        $.log(`  ✅ 预约成功: ${taskName}`);
    }
    return true;
}

async function handleTokenpkTask(ctx, account, task) {
    const taskName = getTokenpkTaskName(task);
    const state = task.state;

    if (state === "FINISH") {
        $.log(`  ✅ 已完成: ${taskName}`);
        return;
    }
    if (state === "SUCCESS") {
        if (task.taskType === "RESERVE") {
            $.log(`  ✅ 已预约: ${taskName}`);
        } else {
            await receiveTokenpkTaskPrize(ctx, task);
        }
        return;
    }
    if (state !== "WAIT") {
        $.log(`  ⚠️ 任务状态未知: ${taskName} (${state})`);
        return;
    }
    if (task.taskType === "RESERVE") {
        await reserveTokenpkTask(ctx, task);
        return;
    }

    $.log(`  🎯 去完成: ${taskName}`);
    const clickData = await requestTokenpkJson(ctx, "/ycloud/tokenpk/task/step/click", buildTokenpkTaskPayload(task), "POST");
    if (!clickData || clickData.code !== 0) {
        const msg = clickData?.msg || "接口无响应";
        $.log(`  ❌ 任务登记失败: ${taskName} ${msg}`);
        return;
    }

    const actionCompleted = await completeTokenpkAction(ctx, account, task);
    await sleep(1000);
    const refreshedTask = await getTokenpkTask(ctx, task.id) || task;
    const refreshedState = refreshedTask.state;
    if (refreshedState === "SUCCESS") {
        await receiveTokenpkTaskPrize(ctx, refreshedTask);
    } else if (refreshedState === "FINISH") {
        $.log(`  ✅ 已完成: ${taskName}`);
    } else if (actionCompleted) {
        $.log(`  ⏳ 已执行任务动作，等待状态更新: ${taskName}`);
    }
}

async function receivePendingTokenpkPrizes(ctx) {
    const tasks = await getTokenpkTaskList(ctx, false) || [];
    for (const task of tasks) {
        if (task.state === "SUCCESS" && task.taskType !== "RESERVE") {
            await receiveTokenpkTaskPrize(ctx, task);
        } else if (task.state === "WAIT" && buildTokenpkTaskPayload(task).key === "shareFile") {
            $.log("  ⚠️ 分享接口已执行但活动未记账，需在APP内分享一次文件");
        }
    }
}

async function assistTokenpkTarget(ctx, account) {
    if (!TOKENPK_INVITE_CODE) return false;
    const now = new Date();
    const beijing = new Date(now.getTime() + 8 * 3600000);
    const currentMonth = `${beijing.getFullYear()}${String(beijing.getMonth() + 1).padStart(2, "0")}`;
    const state = getTokenpkAssistState(account.phone);
    if (state.code === TOKENPK_INVITE_CODE && state.month === currentMonth) {
        $.log("  ✅ 本月已完成目标好友助力");
        return false;
    }

    const ownCodeData = await requestTokenpkJson(ctx, "/ycloud/tokenpk/invite/generateInviteCode") || {};
    if (ownCodeData.code !== 0 || !ownCodeData.result) {
        $.log(`  ⚠️ 跳过好友助力: 无法确认本号邀请码 (${ownCodeData.msg || "接口无响应"})`);
        return false;
    }
    const ownCode = String(ownCodeData.result);
    if (ownCode === TOKENPK_INVITE_CODE) {
        $.log("  ⚠️ 目标邀请码属于本号，跳过自助力");
        return false;
    }

    const assistData = await requestTokenpkJson(ctx, "/ycloud/tokenpk/invite/acceptInvite",
        `code=${TOKENPK_INVITE_CODE}`, "POST",
        { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" });
    if (assistData && assistData.code === 0) {
        saveTokenpkAssistState(account.phone, TOKENPK_INVITE_CODE, currentMonth);
        $.log("  ✅ 好友助力成功");
        return true;
    }
    const msg = assistData?.msg || "接口无响应";
    $.log(`  ❌ 好友助力未成功: ${msg}`);
    return false;
}

async function receiveTokenpkProgressRewards(ctx) {
    const homeData = await requestTokenpkJson(ctx, "/ycloud/tokenpk/toplist/progress/queryHome");
    if (!homeData || homeData.code !== 0) {
        const msg = homeData?.msg || "接口无响应";
        $.log(`  ⚠️ 查询Token消耗进度失败: ${msg}`);
        return;
    }
    const result = homeData.result || {};
    $.log(`  📊 本月已消耗Token: ${result.usedToken || 0}`);
    for (const stage of (result.rewardStages || [])) {
        if (stage.status !== 1) continue;
        const rewardData = await requestTokenpkJson(ctx, "/ycloud/tokenpk/toplist/progress/receiveReward", {
            phaseNo: stage.phaseNo,
        }, "POST");
        if (rewardData && rewardData.code === 0) {
            $.log(`  🎁 已领取Token阶段奖励: ${stage.rewardName || stage.phaseNo}`);
        } else {
            const msg = rewardData?.msg || "接口无响应";
            $.log(`  ❌ Token阶段奖励领取失败: ${stage.phaseNo} ${msg}`);
        }
    }
}

async function drawTokenpkLottery(ctx) {
    const chanceData = await requestTokenpkJson(ctx, "/ycloud/tokenpk/toplist/progress/queryRemainChance");
    if (!chanceData || chanceData.code !== 0) {
        const msg = chanceData?.msg || "接口无响应";
        $.log(`  ⚠️ 查询算力抽奖机会失败: ${msg}`);
        return;
    }
    let chances = 0;
    try { chances = Math.max(0, parseInt(chanceData.result || 0)); } catch (e) {}
    $.log(`  🎰 当前算力抽奖机会: ${chances}`);
    for (let i = 0; i < chances; i++) {
        const drawData = await requestTokenpkJson(ctx, "/ycloud/tokenpk/toplist/progress/lottery", {}, "POST");
        if (!drawData || drawData.code !== 0) {
            const msg = drawData?.msg || "接口无响应";
            $.log(`  ❌ 算力抽奖失败: ${msg}`);
            break;
        }
        const result = drawData.result || {};
        if (result.win) {
            $.log(`  🎁 算力抽奖获得: ${result.prizeName || "奖品"}`);
        } else {
            $.log("  算力抽奖: 未中奖");
        }
        await sleep(1000);
    }
}

async function logTokenpkPrizeStatus(ctx) {
    const data = await requestTokenpkJson(ctx, "/ycloud/prizeApi/checkPrize/getUserPrizeLogPageV2", {
        marketName: TOKENPK_MARKET_NAME,
        currPage: 1,
        pageSize: 1000,
    });
    if (!data || data.code !== 0) {
        const msg = data?.msg || "接口无响应";
        $.log(`  ⚠️ 查询算力大作战奖品失败: ${msg}`);
        return;
    }
    const records = ((data.result || {}).result) || [];
    const pending = records.filter(r => r.flag === 1);
    if (pending.length) {
        $.log("\n🎁 算力大作战奖品");
        const expiryTimes = [];
        for (const record of pending) {
            const expiry = String(record.expireTime || "").replace("T", " ").split(".")[0];
            if (expiry) {
                expiryTimes.push(expiry);
                $.log(`  待领取: ${record.prizeName || "奖品"} (${expiry} 到期)`);
            } else {
                $.log(`  待领取: ${record.prizeName || "奖品"}`);
            }
        }
        if (expiryTimes.length) {
            $.log(`  APP领奖 (最早 ${Math.min(...expiryTimes)} 到期): ${TOKENPK_PRIZE_PAGE_URL}`);
        } else {
            $.log(`  APP领奖: ${TOKENPK_PRIZE_PAGE_URL}`);
        }
        return;
    }
    const claimed = records.filter(r => r.flag === 2);
    if (claimed.length) {
        $.log("\n🎁 算力大作战奖品");
        for (const record of claimed.slice(0, 5)) {
            $.log(`  已领取: ${record.prizeName || "奖品"}`);
        }
    }
}

async function nationalTokenPk(ctx, account) {
    $.log("\n⚡ 算力大作战");
    const tasks = await getTokenpkTaskList(ctx);
    if (tasks === null) return;

    for (const task of tasks) {
        await handleTokenpkTask(ctx, account, task);
        await randomDelay(800, 1500);
    }

    await sleep(2000);
    await receivePendingTokenpkPrizes(ctx);
    await assistTokenpkTarget(ctx, account);
    await receiveTokenpkProgressRewards(ctx);
    await drawTokenpkLottery(ctx);
    await logTokenpkPrizeStatus(ctx);
}

// ======================== 139邮箱任务 ========================
async function processEmailTasks(jwtToken) {
    try {
        const resp = await caiyunGet(jwtToken, "/market/signin/task/taskList", { marketname: "newsign_139mail" });
        if (!resp.data || resp.data.code !== 0) {
            $.log("⚠️ 139邮箱任务列表获取失败");
            return;
        }
        const taskList = resp.data.result || {};
        for (const [taskType, tasks] of Object.entries(taskList)) {
            if (["new", "hidden", "hiddenabc"].includes(taskType)) continue;
            if (!Array.isArray(tasks) || tasks.length === 0) continue;
            $.log(`\n📮 139邮箱 [${taskType}] ${tasks.length}个任务:`);
            for (const task of tasks) {
                const taskId = task.id;
                const taskName = stripTaskName(task);
                const taskStatus = task.state || "";
                if (taskStatus === "FINISH") {
                    $.log(`  ✅ 已完成: ${taskName}`);
                    continue;
                }
                if ([1004, 1005, 1015, 1020].includes(taskId)) {
                    $.log(`  ⏭️ 跳过: ${taskName}`);
                    continue;
                }
                $.log(`  🎯 去完成: ${taskName}`);
                const clickResp = await caiyunGet(jwtToken, "/market/signin/task/click", { key: "task", id: String(taskId) });
                if (clickResp.data?.code === 0) {
                    $.log(`  ✅ 已登记: ${taskName}`);
                } else {
                    $.log(`  ❌ 失败: ${taskName} ${clickResp.data?.msg || ""}`);
                }
                await sleep(1500);
            }
        }
    } catch (e) {
        $.log(`⚠️ 139邮箱任务异常: ${e.message}`);
    }
}

// ======================== 红包派对任务 ========================
function buildRedPacketHeaders(token) {
    const requestId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}${currentMillis()}${randomString(8)}`;
    const timestamp = currentMillis();
    const headers = { requestId, appId: RED_PACKET_APP_ID, token: token || "" };
    const raw = requestId + RED_PACKET_APP_ID + (token || "");
    headers.sign = crypto.createHash("md5").update(raw + RED_PACKET_SIGN_KEY + timestamp).digest("hex");
    headers.timestamp = String(timestamp);
    headers["User-Agent"] = USER_AGENT;
    headers["Accept"] = "application/json, text/plain, */*";
    headers["Content-Type"] = "application/json;charset=UTF-8";
    headers["Origin"] = "https://cpactiv.buy.139.com";
    headers["Referer"] = RED_PACKET_PAGE_URL;
    headers["x-origin"] = RED_PACKET_PAGE_URL;
    headers["x-channelSrc"] = RED_PACKET_CHANNEL_SRC;
    headers["x-DeviceInfo"] = `wifi|h5|1.0.0|v1.0.0||${USER_AGENT}|${currentMillis()}${randomString(10)}|||390X844|zh||`;
    return headers;
}

async function redPacketRequest(path, data, token) {
    try {
        const resp = await axios({
            method: "POST",
            url: RED_PACKET_BASE + path,
            headers: buildRedPacketHeaders(token),
            data: data || {},
            timeout: 15000, validateStatus: () => true, httpsAgent,
        });
        return resp.data;
    } catch (e) {
        $.log(`  ⚠️ 红包请求异常: ${e.message}`);
        return null;
    }
}

function isRedPacketOk(data) {
    return data && String((data.header || {}).status) === "200";
}

function redPacketData(data) {
    return (data || {}).data || {};
}

function redPacketError(data, defaultMsg = "未知错误") {
    const header = (data || {}).header || {};
    const result = redPacketData(data);
    return result.errorMsg || header.errMsg || header.respMsg || defaultMsg;
}

async function loginRedPacket(account) {
    try {
        const ssoResp = await axios({
            method: "POST",
            url: "https://orches.yun.139.com/orchestration/auth-rebuild/token/v1.0/querySpecToken",
            headers: { "Authorization": account.authorization, "Content-Type": "application/json", "User-Agent": USER_AGENT, "Accept": "*/*" },
            data: { account: account.phone, toSourceId: RED_PACKET_SOURCE_ID },
            timeout: 15000, validateStatus: () => true, httpsAgent,
        });
        if (!ssoResp.data?.success || !ssoResp.data?.data?.token) {
            $.log("  ❌ 红包派对: SSO token获取失败");
            return null;
        }
        const ssoToken = ssoResp.data.data.token;
        const loginData = await redPacketRequest("/user/tokenValidate", {
            version: "1.0", pintype: 13, token: ssoToken, deviceId: "", loginConfig: "",
        }, "");
        if (!loginData) {
            $.log("  ❌ 红包派对: 登录无响应");
            return null;
        }
        const header = loginData.header || {};
        const result = loginData.data || {};
        if (String(header.status) === "200" && result.token) {
            return result.token;
        }
        $.log(`  ❌ 红包派对: ${header.errMsg || header.respMsg || "登录失败"}`);
        return null;
    } catch (e) {
        $.log(`  ❌ 红包派对登录异常: ${e.message}`);
        return null;
    }
}

async function logRedPacketReward(token, taskCode, defaultName = "") {
    const data = await redPacketRequest("/redpacket/userToastInfo", {
        version: RED_PACKET_VERSION,
        ...(taskCode ? { configTaskCode: taskCode } : {}),
    }, token);
    if (!data || String((data.header || {}).status) !== "200") return;
    const prize = (data.data || {}).lastUserPrize || {};
    const amount = prize.prizeAmount;
    if (amount) {
        try {
            $.log(`  🧧 红包奖励: ${prize.prizeName || defaultName} +${(parseFloat(amount) / 100).toFixed(2)}元`);
        } catch (e) {
            $.log(`  🧧 红包奖励: ${prize.prizeName || defaultName} +${amount}`);
        }
    }
}

async function logRedPacketBalance(token) {
    const data = await redPacketRequest("/redpacket/userAccountInfo", {
        version: RED_PACKET_VERSION,
        platformType: 1,
    }, token);
    if (!data || String((data.header || {}).status) !== "200") {
        $.log("  ⚠️ 红包派对余额查询失败");
        return;
    }
    const info = (data.data || {}).info || {};
    try {
        const canAmount = parseFloat(info.canAmount || 0) / 100;
        const totalAmount = parseFloat(info.totalAmount || 0) / 100;
        $.log(`  💰 红包派对余额: 可用${canAmount.toFixed(2)}元，累计${totalAmount.toFixed(2)}元`);
    } catch (e) {
        $.log("  ⚠️ 红包派对余额查询失败: 响应异常");
    }
}

async function refreshRedPacketTask(token, taskCode) {
    const data = await redPacketRequest("/redpacket/configTaskLoginList", { version: RED_PACKET_VERSION }, token);
    if (!isRedPacketOk(data)) return null;
    const taskList = redPacketData(data);
    for (const group of ["configTaskNoviceList", "configTaskDailyList", "configTaskMonthlyList"]) {
        for (const task of (taskList[group] || [])) {
            if (task.taskCode === taskCode) return task;
        }
    }
    return null;
}

async function finishRedPacketTask(token, task, browse = false) {
    const taskName = task.taskName || "";
    const taskCode = task.taskCode || "";
    const completeData = await redPacketRequest("/redpacket/userCompleteTask", {
        version: RED_PACKET_VERSION, platformType: 1, taskId: task.id,
    }, token);
    if (!completeData) {
        $.log(`  ❌ 红包派对任务失败: ${taskName} 接口无响应`);
        return false;
    }
    const result = completeData.data || {};
    if (result.status !== undefined && result.status !== null && result.status !== 1) {
        $.log(`  ❌ 红包派对任务失败: ${taskName} ${result.errorMsg || "未知错误"}`);
        return false;
    }
    if (browse) {
        await sleep(15000);
        const browseData = await redPacketRequest("/redpacket/userBrowse", {
            taskCode, version: RED_PACKET_VERSION,
        }, token);
        if (!browseData || String((browseData.header || {}).status) !== "200") {
            const msg = ((browseData || {}).data || {}).errorMsg || "浏览确认失败";
            $.log(`  ❌ 红包派对任务失败: ${taskName} ${msg}`);
            return false;
        }
    }
    const refreshed = await refreshRedPacketTask(token, taskCode) || {};
    const status = refreshed.userStatus || task.userStatus;
    if (status === 1) {
        $.log(`  ✅ 已完成: ${taskName}`);
        await logRedPacketReward(token, taskCode, taskName);
        return true;
    }
    const statusText = { 0: "未完成", 1: "已完成", 3: "奖品已兑完", 4: "明天再来" }[status] || String(status);
    $.log(`  ✅ 已登记: ${taskName} (${statusText})`);
    return true;
}

async function answerRedPacketTopic(token, task) {
    const taskName = task.taskName || "";
    // 先完成登记
    const completeData = await redPacketRequest("/redpacket/userCompleteTask", {
        version: RED_PACKET_VERSION, platformType: 1, taskId: task.id,
    }, token);
    if (!completeData || !isRedPacketOk(completeData)) {
        $.log(`  ❌ 红包派对任务失败: ${taskName} ${redPacketError(completeData)}`);
        return false;
    }
    let question = "";
    let topic = null;
    let options = [];
    for (let attempt = 0; attempt < 15; attempt++) {
        const topicData = await redPacketRequest("/redpacket/configTopicList", {}, token);
        const topics = (redPacketData(topicData).list) || [];
        if (!topics.length) {
            $.log(`  ❌ 红包派对任务失败: ${taskName} 题库为空`);
            return false;
        }
        topic = topics[0];
        question = topic.topicContent || "";
        const answerText = RED_PACKET_KNOWN_ANSWERS[question];
        try { options = JSON.parse(topic.topicOption || "[]"); } catch (e) { options = []; }
        if (answerText && options.includes(answerText)) break;
        await sleep(200);
    }
    const answerText = RED_PACKET_KNOWN_ANSWERS[question];
    if (!answerText || !options.includes(answerText)) {
        $.log(`  ⏳ 需手动完成: ${taskName} (未知题目: ${question})`);
        return false;
    }
    const answer = "ABCD"[options.indexOf(answerText)];
    const answerData = await redPacketRequest("/redpacket/userTopicAnswer", {
        taskId: parseInt(task.id), topicId: parseInt(topic.id), answer,
        version: RED_PACKET_VERSION, platformType: 1,
    }, token);
    const result = redPacketData(answerData);
    if (isRedPacketOk(answerData) && result.status === 1) {
        $.log(`  ✅ 已完成: ${taskName}`);
        await logRedPacketReward(token, task.taskCode, taskName);
        return true;
    }
    $.log(`  ❌ 红包派对任务失败: ${taskName} ${redPacketError(answerData)}`);
    return false;
}

async function handleRedPacketTask(token, task) {
    const taskName = task.taskName || "";
    const taskCode = task.taskCode || "";
    const status = parseInt(task.userStatus || 0);
    const amount = task.prizeAmount != null ? task.prizeAmount : task.taskAmount;
    let suffix = "";
    try { if (amount != null) suffix = ` (${(parseFloat(amount) / 100).toFixed(2)}元)`; } catch (e) {}

    if (status === 1) { $.log(`  ✅ 已完成: ${taskName}${suffix}`); return; }
    if (status === 3 || status === 4) {
        const statusText = { 3: "奖品已兑完", 4: "明天再来" }[status] || String(status);
        $.log(`  ⏭️ 暂不可做: ${taskName} (${statusText})`);
        return;
    }

    if (RED_PACKET_BROWSE_TASKS.has(taskCode)) {
        $.log(`  🎯 去完成: ${taskName}${suffix}`);
        await finishRedPacketTask(token, task, true);
        return;
    }
    if (RED_PACKET_DIRECT_TASKS.has(taskCode)) {
        $.log(`  🎯 去完成: ${taskName}${suffix}`);
        await finishRedPacketTask(token, task);
        return;
    }
    if (taskCode === "DAILY_1") {
        $.log(`  🎯 去完成: ${taskName}${suffix}`);
        // 云机使用任务
        await redPacketRequest("/redpacket/userCompleteTask", {
            version: RED_PACKET_VERSION, platformType: 1, taskId: task.id,
        }, token);
        const refreshed = await refreshRedPacketTask(token, taskCode) || {};
        if (refreshed.userStatus === 1) {
            $.log(`  ✅ 已完成: ${taskName}`);
            await logRedPacketReward(token, taskCode, taskName);
        } else {
            $.log(`  ⏳ 需手动完成: ${taskName} (需云机内实际使用)`);
        }
        return;
    }
    if (taskCode === "MONTHLY_3") {
        $.log(`  🎯 去完成: ${taskName}${suffix}`);
        await answerRedPacketTopic(token, task);
        return;
    }
    $.log(`  ⏳ 需手动完成: ${taskName}${suffix} (${taskCode})`);
}

async function redEnvelopeParty(account) {
    $.log("\n🧧 红包派对任务");
    const token = await loginRedPacket(account);
    if (!token) return;

    const data = await redPacketRequest("/redpacket/configTaskLoginList", { version: RED_PACKET_VERSION }, token);
    if (!data) {
        $.log("  ❌ 红包派对: 获取任务列表失败");
        return;
    }
    const header = data.header || {};
    if (String(header.status) !== "200") {
        $.log(`  ❌ 红包派对: ${header.errMsg || header.respMsg || "获取任务失败"}`);
        return;
    }

    // 余额查询
    await logRedPacketBalance(token);

    const taskList = data.data || {};

    // 签到
    const signList = taskList.configTaskSignList || [];
    for (const sign of signList) {
        if (sign.isToday === 1 && parseInt(sign.status || 0) === 0) {
            const signData = await redPacketRequest("/redpacket/userSign", { version: RED_PACKET_VERSION, platformType: 1 }, token);
            if (isRedPacketOk(signData) && (redPacketData(signData)).status === 1) {
                $.log("  ✅ 红包派对签到成功");
                await logRedPacketReward(token, "SIGN_1", "每日签到");
            } else {
                $.log(`  ❌ 红包派对签到失败: ${redPacketError(signData)}`);
            }
        } else if (sign.isToday === 1 && parseInt(sign.status || 0) === 1) {
            const amount = sign.signAmount;
            let suffix = "";
            try { if (amount) suffix = ` (${(parseFloat(amount) / 100).toFixed(2)}元)`; } catch (e) {}
            $.log(`  ✅ 已完成: 每日签到${suffix}`);
        }
    }

    // 处理任务组
    const groups = [
        ["configTaskNoviceList", "新手任务"],
        ["configTaskDailyList", "每日任务"],
        ["configTaskMonthlyList", "每月任务"],
    ];
    for (const [groupKey, groupTitle] of groups) {
        const tasks = taskList[groupKey] || [];
        if (!tasks.length) continue;
        $.log(`\n  🧧 [${groupTitle}]`);
        for (const task of tasks) {
            await handleRedPacketTask(token, task);
            await randomDelay(500, 1000);
        }
    }

    // 余额查询
    await logRedPacketBalance(token);
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
        return { received: 0, total: 0 };
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

    // 2. 构建 market context (含设备指纹获取)
    const ctx = await buildMarketContext(jwtToken, ssoToken, account);
    $.log(`🔧 userDomainId: ${ctx.userDomainId || "无"}`);

    try {
        // 3. 会话准备
        $.log("\n【1/9】会话准备");
        await prepareSigninCenterSession(ctx);
        await randomDelay(500, 1000);

        // 4. 签到
        $.log("\n【2/9】签到");
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
        $.log("\n【3/9】戳一戳");
        const click319Result = await click319(ctx);
        await randomDelay(500, 1000);

        // 6. 任务列表
        $.log("\n【4/9】处理任务");
        await processAllTasks(ctx, jwtToken, account);
        await randomDelay(500, 1000);

        // 7. 算力大作战
        $.log("\n【5/9】算力大作战");
        await nationalTokenPk(ctx, account);
        await randomDelay(500, 1000);

        // 8. 备份奖励
        $.log("\n【6/9】备份奖励");
        await backupCloud(jwtToken);
        await randomDelay(500, 1000);

        // 9. 139邮箱任务
        $.log("\n【7/9】139邮箱任务");
        await processEmailTasks(jwtToken);
        await randomDelay(500, 1000);

        // 10. 领取云朵
        $.log("\n【8/9】领取云朵");
        const cloudInfo = await receiveCloud(ctx, jwtToken);
        await randomDelay(500, 1000);

        // 11. 红包派对
        $.log("\n【9/9】红包派对");
        await redEnvelopeParty(account);
        await randomDelay(500, 1000);

        // 最终状态检查
        $.log("\n【检查】最终任务状态");
        const finalStatus = await recheckTasks(ctx);

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
    $.log("🚀 中国移动云盘 · 云朵中心 v3.0 (参照ydyp v5.0.10)");
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
    $.log(`🔧 deviceId获取顺序: 设备指纹接口 → 环境变量 → 本地缓存 → 自动生成`);

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
