#Trae自动签到
/*
 * # cron: 30 8 * * *
 *
 * Trae AI 每日自动签到脚本（适配青龙面板 2.10+ / Node.js）
 * 依赖：仅 Node 原生内置模块（https / crypto），零第三方 npm 包
 *
 * 环境变量：TRAE_COOKIE
 *   多账号之间用换行符分隔，每行支持 4 种凭证格式（任选其一）：
 *     1) Cloud-IDE-JWT eyJ...    —— IDE 抓包拿到的完整 Authorization 头
 *     2) Bearer eyJ...           —— 网页端抓包拿到的 Authorization 头
 *     3) eyJ...                  —— 裸 JWT token（脚本自动补全前缀）
 *     4) a=1; b=2; ...           —— 完整 Cookie 字符串（自动解析）
 */

'use strict';

const https = require('https');
const crypto = require('crypto');

/* ================= 可调配置 ================= */
const API_HOST      = 'api.trae.cn';                                        // 签到接口域名（Trae CN 国服）
const STATUS_PATH   = '/trae/api/v2/ug/checkin_credits/status';             // 查询今日签到状态
const CLAIM_PATH    = '/trae/api/v2/ug/checkin_credits/claim';              // 执行签到
const REQUEST_TIMEOUT = 15000;                                              // 单次请求超时（毫秒）
const DELAY_MIN     = 3;                                                    // 账号之间最小随机延时（秒）
const DELAY_MAX     = 8;                                                    // 账号之间最大随机延时（秒）
const USER_AGENT    = 'Trae/0.1.43';                                        // 客户端 UA，模拟真实请求
const DEBUG         = true;                                                 // 调试开关：true 时打印接口原始响应
/* ================= 可调配置结束 ================= */

/* 发送 POST JSON 请求。永不 reject，统一返回 { status, body, error } */
function postJson(host, path, headers) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: host,
      path: path,
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        headers
      ),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        // 限制响应体大小，防止异常响应撑爆内存
        if (body.length < 1024 * 1024) body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: body }));
    });
    // 超时处理：超时直接销毁连接，触发 error 分支
    req.setTimeout(REQUEST_TIMEOUT, () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => resolve({ status: 0, body: '', error: e }));
    req.write('{}');
    req.end();
  });
}

/* 解析响应 JSON，失败返回 null */
function parseJson(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

/* 睡眠 */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 区间随机整数 */
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/* 判断是否为 JWT（eyJ 开头的三段式 token） */
function isJwt(s) {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);
}

/* 从 JWT payload 解出昵称（手写 base64url 解码，兼容旧版 Node） */
function jwtName(token) {
  try {
    const part = token.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return obj.nickname || obj.name || obj.user_name || obj.account_name || '';
  } catch (e) { return ''; }
}

/* 由凭证派生一个稳定的伪设备 ID（同一账号每次一致，模拟客户端设备） */
function pseudoDeviceId(cred) {
  const h = crypto.createHash('md5').update(cred).digest('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) +
         '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
}

/* 解析单行账号凭证 -> 完整请求头；无法识别返回 null */
function buildHeaders(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  // 基础请求头：完整携带，模拟网页端/客户端请求
  const h = {
    'User-Agent': USER_AGENT,
    'X-User-Region': 'CN',
    'X-Device-Id': pseudoDeviceId(s),
    'Origin': 'https://www.trae.cn',
    'Referer': 'https://www.trae.cn/',
  };
  if (/^cloud-ide-jwt\s+/i.test(s)) {
    // 格式 1：完整 Cloud-IDE-JWT 头
    h['Authorization'] = s;
  } else if (/^bearer\s+/i.test(s)) {
    // 格式 2：网页端 Bearer 头
    h['Authorization'] = s;
  } else if (isJwt(s)) {
    // 格式 3：裸 JWT，自动补全前缀
    h['Authorization'] = 'Cloud-IDE-JWT ' + s;
  } else if (s.indexOf('=') !== -1) {
    // 格式 4：完整 Cookie 字符串
    h['Cookie'] = s;
  } else {
    return null;
  }
  return h;
}

/* 判断响应是否表示登录过期 / cookie 失效 */
function isSessionDead(status, body) {
  if (status === 401 || status === 403) return true;
  const b = (body || '').toLowerCase();
  return /login|unauthorized|invalid token|token 失效|token.*expired|session.*(invalid|expired)|not login|未登录|请先登录/.test(b);
}

/* 判断响应是否表示"今日已签到" */
function isAlreadyChecked(body) {
  const b = (body || '').toLowerCase();
  return b.indexOf('已签到') !== -1 || /already\s+check/.test(b);
}

/* 宽松提取"已签到"布尔字段：兼容多种命名（接口实际字段名未公开，需兼容反推） */
function pickChecked(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj.checked_in !== undefined) return obj.checked_in;
  if (obj.is_checked !== undefined) return obj.is_checked;
  if (obj.already_signed !== undefined) return obj.already_signed;
  if (obj.has_checked_in !== undefined) return obj.has_checked_in;
  if (obj.has_signed !== undefined) return obj.has_signed;
  // 嵌套 data 包裹
  if (obj.data && typeof obj.data === 'object') return pickChecked(obj.data);
  return undefined;
}

/* 宽松提取签到获得的积分 */
function pickCredits(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  if (typeof obj.credits === 'number') return obj.credits;
  if (typeof obj.total_credits === 'number') return obj.total_credits;
  if (typeof obj.checked_in_credits === 'number') return obj.checked_in_credits;
  if (typeof obj.awarded_credits === 'number') return obj.awarded_credits;
  if (obj.data && typeof obj.data === 'object') return pickCredits(obj.data);
  return 0;
}

/* 通用业务成功码判断：兼容 { code: 0 } / { status: "ok" } / { success: true } */
function isSuccessPayload(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.code === 0 || obj.code === '0' || obj.code === 200) return true;
  if (typeof obj.status === 'string' && /^(ok|success)$/i.test(obj.status)) return true;
  if (obj.success === true) return true;
  return false;
}

/* 单个账号签到流程（整体 try-catch，单账号异常不影响后续账号） */
async function signOne(raw, index, total) {
  try {
    const headers = buildHeaders(raw);
    if (!headers) {
      console.log(`[账号 ${index}/${total}] 凭证无法识别（既不是 JWT 也不是 Cookie），已跳过`);
      return;
    }
    const label = jwtName(raw) || `账号${index}`;
    console.log(`[账号 ${index}/${total}] ${label} 开始签到...`);

    // 第一步：查询今日签到状态（仅用于判断"今日已签到"，不再凭 enable 拦截）
    const st = await postJson(API_HOST, STATUS_PATH, headers);
    if (st.status === 0) {
      console.log(`[账号 ${index}/${total}] 【网络异常】查询状态失败：${st.error ? st.error.message : '未知错误'}`);
      return;
    }
    if (isSessionDead(st.status, st.body)) {
      console.log(`[账号 ${index}/${total}] 【cookie失效/登录过期】请重新抓取 token 后更新环境变量`);
      return;
    }
    if (DEBUG) console.log(`[账号 ${index}/${total}] [DEBUG] 状态接口响应（HTTP ${st.status}）：${String(st.body).slice(0, 600)}`);
    const sj = parseJson(st.body);
    if (st.status !== 200 || !sj) {
      console.log(`[账号 ${index}/${total}] 【请求失败】状态查询 HTTP ${st.status}：${String(st.body).slice(0, 200)}`);
      return;
    }

    // 今日已签到：直接结束（多种字段名都尝试）
    if (pickChecked(sj) === true) {
      console.log(`[账号 ${index}/${total}] 【今日已签到】无需重复签到`);
      return;
    }

    // 第二步：直接执行签到（不依赖 enable 字段，交给 claim 自身判定）
    const cl = await postJson(API_HOST, CLAIM_PATH, headers);
    if (cl.status === 0) {
      console.log(`[账号 ${index}/${total}] 【网络异常】执行签到失败：${cl.error ? cl.error.message : '未知错误'}`);
      return;
    }
    if (DEBUG) console.log(`[账号 ${index}/${total}] [DEBUG] 签到接口响应（HTTP ${cl.status}）：${String(cl.body).slice(0, 600)}`);
    if (isSessionDead(cl.status, cl.body)) {
      console.log(`[账号 ${index}/${total}] 【cookie失效/登录过期】请重新抓取 token 后更新环境变量`);
      return;
    }
    if (isAlreadyChecked(cl.body)) {
      console.log(`[账号 ${index}/${total}] 【今日已签到】无需重复签到`);
      return;
    }

    const cj = parseJson(cl.body);
    if (cl.status === 200 && cj) {
      // 业务成功：HTTP 200 + 业务成功码，或响应里出现 checked_in=true
      if (isSuccessPayload(cj) || pickChecked(cj) === true) {
        const extra = pickCredits(cj) ? `，今日积分 +${pickCredits(cj)}` : '';
        console.log(`[账号 ${index}/${total}] 【签到成功】${extra}`);
      } else {
        // 业务失败：提取错误信息
        const msg = cj.message || cj.msg || cj.error || cj.error_msg || JSON.stringify(cj).slice(0, 200);
        console.log(`[账号 ${index}/${total}] 【签到失败】${msg}`);
      }
    } else {
      console.log(`[账号 ${index}/${total}] 【请求失败】签到 HTTP ${cl.status}：${String(cl.body).slice(0, 200)}`);
    }
  } catch (e) {
    // 兜底：任何未捕获异常只影响当前账号，脚本继续运行
    console.log(`[账号 ${index}/${total}] 【异常】${e.message}`);
  }
}

/* 主流程 */
async function main() {
  const raw = process.env.TRAE_COOKIE || '';
  if (!raw.trim()) {
    console.log('【配置缺失】未检测到 TRAE_COOKIE 环境变量，请先在青龙面板添加后重试');
    return;
  }
  // 兼容真实换行与字面量 \n 两种分隔方式
  const list = raw.split(/\r?\n|\\n/).map((s) => s.trim()).filter(Boolean);
  console.log(`检测到 ${list.length} 个账号，开始批量签到...`);
  for (let i = 0; i < list.length; i++) {
    await signOne(list[i], i + 1, list.length);
    // 账号之间随机延时，防止触发风控
    if (i < list.length - 1) {
      const d = randInt(DELAY_MIN, DELAY_MAX);
      console.log(`随机延时 ${d} 秒后继续下一个账号...`);
      await sleep(d * 1000);
    }
  }
  console.log('===== 全部账号处理完毕 =====');
}

main().catch((e) => console.log('【脚本异常】' + e.message));
