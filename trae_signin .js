/*
 * # cron: 30 8 * * *
 *
 * Trae AI 每日自动签到脚本（适配青龙面板 2.10+ / Node.js）
 * 依赖：仅 Node 原生内置模块（https / crypto），零第三方 npm 包
 *
 * 环境变量：TRAE_COOKIE
 *   多账号之间用换行符分隔，每行支持两种凭证（任选其一）：
 *     1) JWT token —— 直接填，推荐
 *        · 网页版 F12 → Network → 找 checkin_credits/status 请求
 *        · 复制请求头 Authorization 的值，去掉前缀后的 eyJ... 部分
 *     2) 完整 Cookie 字符串 —— 脚本会先调 GetUserToken 接口自动换 token
 *        · 网页版 F12 → Network → 找任意 api.trae.cn 请求
 *        · 复制请求头 Cookie 的完整值
 */

'use strict';

const https = require('https');
const crypto = require('crypto');

/* ================= 可调配置 ================= */
const API_HOST       = 'api.trae.cn';                                        // 签到接口域名（Trae CN 国服）
const STATUS_PATH    = '/trae/api/v2/ug/checkin_credits/status';             // 查询今日签到状态
const CLAIM_PATH     = '/trae/api/v2/ug/checkin_credits/claim';              // 执行签到
const GET_TOKEN_PATH = '/cloudide/api/v3/common/GetUserToken';               // 用 Cookie 换取 JWT（网页端同款）
const REQUEST_TIMEOUT = 15000;                                               // 单次请求超时（毫秒）
const DELAY_MIN      = 3;                                                    // 账号之间最小随机延时（秒）
const DELAY_MAX      = 8;                                                    // 账号之间最大随机延时（秒）
const USER_AGENT     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEBUG          = true;                                                 // 调试开关：true 时打印接口原始响应
/* ================= 可调配置结束 ================= */

/* 发送 POST JSON 请求。永不 reject，统一返回 { status, body, error } */
function postJson(host, path, headers, body) {
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
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (buf.length < 1024 * 1024) buf += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.setTimeout(REQUEST_TIMEOUT, () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => resolve({ status: 0, body: '', error: e }));
    req.write(body === undefined ? '{}' : body);
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

/* 解析单行凭证：返回 { type: 'jwt'|'cookie', token, cookie }；无法识别返回 null */
function parseCredential(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  // 完整 Authorization 头
  if (/^cloud-ide-jwt\s+/i.test(s)) {
    return { type: 'jwt', token: s.replace(/^cloud-ide-jwt\s+/i, '').trim() };
  }
  if (/^bearer\s+/i.test(s)) {
    return { type: 'jwt', token: s.replace(/^bearer\s+/i, '').trim() };
  }
  // 裸 JWT
  if (isJwt(s)) {
    return { type: 'jwt', token: s };
  }
  // 完整 Cookie
  if (s.indexOf('=') !== -1) {
    return { type: 'cookie', cookie: s };
  }
  return null;
}

/* 用 Cookie 换取 JWT（复刻网页端 GetUserToken 接口逻辑） */
async function exchangeToken(cookie) {
  const headers = {
    'User-Agent': USER_AGENT,
    'Cookie': cookie,
    'Origin': 'https://www.trae.cn',
    'Referer': 'https://www.trae.cn/',
  };
  const r = await postJson(API_HOST, GET_TOKEN_PATH, headers, '{}');
  if (r.status === 0) return { ok: false, error: r.error ? r.error.message : '网络异常' };
  if (DEBUG) console.log(`[DEBUG] GetUserToken 接口响应（HTTP ${r.status}）：${String(r.body).slice(0, 400)}`);
  const j = parseJson(r.body);
  const token = j && j.data && j.data.Result && j.data.Result.Token;
  if (token) return { ok: true, token: token };
  return { ok: false, error: `换取失败 HTTP ${r.status}：${String(r.body).slice(0, 200)}` };
}

/* 构建签到请求头：需要 Cloud-IDE-JWT 认证 */
function buildHeaders(token) {
  return {
    'User-Agent': USER_AGENT,
    'Authorization': 'Cloud-IDE-JWT ' + token,
    'X-User-Region': 'CN',
    'X-Device-Id': pseudoDeviceId(token),
    'Origin': 'https://www.trae.cn',
    'Referer': 'https://www.trae.cn/',
  };
}

/* 判断响应是否表示登录过期 / 凭证失效 */
function isSessionDead(status, body) {
  if (status === 401 || status === 403) return true;
  const j = parseJson(body);
  if (j && typeof j.code === 'number' && j.code === 1001) return true; // 1001 = 无法认证
  const b = (body || '').toLowerCase();
  return /login|unauthorized|invalid token|token 失效|token.*expired|session.*(invalid|expired)|not login|未登录|请先登录|authenticate/.test(b);
}

/* 判断响应是否表示"今日已签到" */
function isAlreadyChecked(obj) {
  if (!obj) return false;
  // 业务码 0 且 checked_in=true，或响应文字含"已签到"
  if (obj.checked_in === true) return true;
  const b = JSON.stringify(obj).toLowerCase();
  return b.indexOf('已签到') !== -1 || /already\s+check/.test(b);
}

/* 业务成功判断：code===0 / status ok / success true */
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
    const cred = parseCredential(raw);
    if (!cred) {
      console.log(`[账号 ${index}/${total}] 凭证无法识别（既不是 JWT 也不是 Cookie），已跳过`);
      return;
    }

    // 统一拿到 JWT：填 Cookie 时先自动换取
    let token = cred.type === 'jwt' ? cred.token : '';
    if (cred.type === 'cookie') {
      console.log(`[账号 ${index}/${total}] 检测到 Cookie 凭证，正在换取 JWT...`);
      const ex = await exchangeToken(cred.cookie);
      if (!ex.ok) {
        console.log(`[账号 ${index}/${total}] 【cookie失效/登录过期】${ex.error}，请重新登录后抓取最新 Cookie 或直接填 JWT`);
        return;
      }
      token = ex.token;
    }

    const label = jwtName(token) || `账号${index}`;
    console.log(`[账号 ${index}/${total}] ${label} 开始签到...`);

    // 第一步：查询今日签到状态
    const st = await postJson(API_HOST, STATUS_PATH, buildHeaders(token), '{}');
    if (st.status === 0) {
      console.log(`[账号 ${index}/${total}] 【网络异常】查询状态失败：${st.error ? st.error.message : '未知错误'}`);
      return;
    }
    if (DEBUG) console.log(`[账号 ${index}/${total}] [DEBUG] 状态接口响应（HTTP ${st.status}）：${String(st.body).slice(0, 600)}`);
    if (isSessionDead(st.status, st.body)) {
      console.log(`[账号 ${index}/${total}] 【cookie失效/登录过期】凭证无效，请重新抓取`);
      return;
    }
    const sj = parseJson(st.body);
    if (!sj) {
      console.log(`[账号 ${index}/${total}] 【请求失败】状态查询响应无法解析：${String(st.body).slice(0, 200)}`);
      return;
    }
    // 今日已签到：直接结束
    if (isAlreadyChecked(sj)) {
      console.log(`[账号 ${index}/${total}] 【今日已签到】无需重复签到`);
      return;
    }

    // 第二步：执行签到
    const cl = await postJson(API_HOST, CLAIM_PATH, buildHeaders(token), '{}');
    if (cl.status === 0) {
      console.log(`[账号 ${index}/${total}] 【网络异常】执行签到失败：${cl.error ? cl.error.message : '未知错误'}`);
      return;
    }
    if (DEBUG) console.log(`[账号 ${index}/${total}] [DEBUG] 签到接口响应（HTTP ${cl.status}）：${String(cl.body).slice(0, 600)}`);
    if (isSessionDead(cl.status, cl.body)) {
      console.log(`[账号 ${index}/${total}] 【cookie失效/登录过期】凭证无效，请重新抓取`);
      return;
    }
    const cj = parseJson(cl.body);
    if (isAlreadyChecked(cj)) {
      console.log(`[账号 ${index}/${total}] 【今日已签到】无需重复签到`);
      return;
    }
    if (cl.status === 200 && cj && (isSuccessPayload(cj) || cj.checked_in === true)) {
      const extra = typeof cj.credits === 'number' ? `，今日积分 +${cj.credits}` : '';
      console.log(`[账号 ${index}/${total}] 【签到成功】${extra}`);
    } else {
      const msg = (cj && (cj.message || cj.msg || cj.error)) || `HTTP ${cl.status}：${String(cl.body).slice(0, 200)}`;
      console.log(`[账号 ${index}/${total}] 【签到失败】${msg}`);
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
  const list = raw.split(/\r?\n|\\n/).map((s) => s.trim()).filter(Boolean);
  console.log(`检测到 ${list.length} 个账号，开始批量签到...`);
  for (let i = 0; i < list.length; i++) {
    await signOne(list[i], i + 1, list.length);
    if (i < list.length - 1) {
      const d = randInt(DELAY_MIN, DELAY_MAX);
      console.log(`随机延时 ${d} 秒后继续下一个账号...`);
      await sleep(d * 1000);
    }
  }
  console.log('===== 全部账号处理完毕 =====');
}

main().catch((e) => console.log('【脚本异常】' + e.message));
