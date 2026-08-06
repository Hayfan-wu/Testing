// cron: 50 0 * * *
/*
 * Trae AI 每日自动签到 - 青龙面板脚本（适配青龙 2.10+）
 * 语言：JavaScript (Node.js)
 * 依赖：仅使用 Node.js 原生内置模块（https / url），不引入任何第三方 npm 包
 * 配置：通过青龙环境变量 TRAE_COOKIE 配置，多账号用换行符分隔
 */

'use strict';

const https = require('https');
const { URL } = require('url');

// ===================== 配置区 =====================
// 签到接口地址（如官方调整路径，修改此处常量即可）
const CHECKIN_URL = 'https://api.trae.com.cn/api/points/check-in';
// 单次请求超时时间（毫秒）
const REQUEST_TIMEOUT = 10000;
// 账号之间的随机延时范围（毫秒），用于降低风控概率
const DELAY_MIN = 2000;
const DELAY_MAX = 6000;
// =================== 配置区结束 ===================

/**
 * 随机延时函数
 * @param {number} ms 延时毫秒
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 生成账号间的随机延时
 */
function randomDelay() {
  return Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1)) + DELAY_MIN;
}

/**
 * 发起 HTTPS 请求（Promise 化，仅用原生模块）
 * @param {string} rawUrl 完整请求地址
 * @param {object} options 额外选项（method）
 * @param {string} postData 请求体（已序列化的字符串）
 * @param {string} cookie 该账号的 Cookie
 * @returns {Promise<{statusCode:number, body:string, headers:object}>}
 */
function doRequest(rawUrl, options, postData, cookie) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (e) {
      return reject(new Error('签到地址解析失败: ' + e.message));
    }

    // 模拟网页端完整请求头
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/json',
      'Origin': 'https://www.trae.com.cn',
      'Referer': 'https://www.trae.com.cn/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Cookie': cookie || '',
    };

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: (options && options.method) || 'POST',
      headers: headers,
      timeout: REQUEST_TIMEOUT,
    };

    const req = https.request(reqOptions, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { chunks += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: chunks, headers: res.headers });
      });
    });

    // 超时处理：主动断开并抛出错误
    req.on('timeout', () => {
      req.destroy(new Error('请求超时（' + REQUEST_TIMEOUT + 'ms）'));
    });

    // 网络异常捕获
    req.on('error', (err) => {
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/**
 * 单个账号签到逻辑，包含完整状态分支与异常捕获
 * @param {string} cookie 当前账号 Cookie
 * @param {number} index 账号序号（从 1 开始，仅用于日志展示）
 */
async function checkInOneAccount(cookie, index) {
  try {
    const res = await doRequest(CHECKIN_URL, { method: 'POST' }, '{}', cookie);

    // 1) cookie 失效 / 登录过期：服务端返回未授权状态码
    if (res.statusCode === 401 || res.statusCode === 403) {
      console.log(`【账号${index}】❌ cookie失效/登录过期（HTTP ${res.statusCode}）`);
      return;
    }

    // 解析返回体（容错：非 JSON 也不崩溃）
    let data = {};
    try {
      data = JSON.parse(res.body);
    } catch (e) {
      console.log(`【账号${index}】⚠️ 返回非 JSON，原始内容: ${res.body.slice(0, 200)}`);
      return;
    }

    // 2) 按接口返回判断签到状态（判断字段请按你抓包到的实际结构微调）
    const code = data.code;
    const msg = String(data.msg || data.message || data.tip || '').toLowerCase();

    if (code === 0 || code === 200 || msg.includes('success') || msg.includes('成功')) {
      console.log(`【账号${index}】✅ 签到成功`);
    } else if (msg.includes('已签到') || msg.includes('今天已') || msg.includes('already')) {
      console.log(`【账号${index}】ℹ️ 今日已签到`);
    } else if (
      msg.includes('登录') || msg.includes('未登录') ||
      msg.includes('过期') || msg.includes('expired') || msg.includes('login')
    ) {
      console.log(`【账号${index}】❌ cookie失效/登录过期`);
    } else {
      console.log(`【账号${index}】⚠️ 未知返回: code=${code}, msg=${data.msg || data.message}`);
    }
  } catch (err) {
    // 3) 网络异常（超时、DNS、连接拒绝等）
    console.log(`【账号${index}】🔥 网络异常: ${err.message}`);
  }
}

/**
 * 主流程：读取环境变量 -> 逐账号签到 -> 账号间随机延时
 */
async function main() {
  const env = process.env.TRAE_COOKIE || '';
  const cookies = env
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (cookies.length === 0) {
    console.log('⚠️ 未检测到环境变量 TRAE_COOKIE，请在青龙中添加后重试。');
    return;
  }

  console.log(`🔔 检测到 ${cookies.length} 个账号，开始签到...`);

  for (let i = 0; i < cookies.length; i++) {
    await checkInOneAccount(cookies[i], i + 1);

    // 非最后一个账号时，增加随机延时防止风控
    if (i < cookies.length - 1) {
      const delay = randomDelay();
      console.log(`⏳ 等待 ${delay}ms 后处理下一账号...`);
      await sleep(delay);
    }
  }

  console.log('🏁 全部账号处理完毕。');
}

// 入口：顶层异常兜底，避免单点崩溃
main().catch((e) => {
  console.error('脚本致命异常:', e);
  process.exit(1);
});
