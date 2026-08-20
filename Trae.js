/*
 * # cron: 30 8 * * *
 *
 * Trae AI 每日自动签到脚本 v6（适配青龙面板 2.10+ / Node.js）
 * 依赖：仅 Node 原生内置模块（https / crypto / fs / path），零第三方依赖
 *
 * 保活核心：用 refreshToken → ExchangeToken 自动续签，14 天免维护
 *
 * 环境变量（二选一，推荐 refreshToken）：
 *   TRAE_REFRESH_TOKEN  每行一个 refreshToken（自动续签 + 持久化保活）
 *   TRAE_COOKIE         兼容旧版，每行一个 Cookie，兜底换 JWT（时效短）
 *
 * 辅助命令：
 *   node trae_signin.js --login                生成本机登录链接
 *   node trae_signin.js --parse "<回调URL>"     从回调链接提取 refreshToken
 */

'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ================= 可调配置 ================= */
const OAUTH_HOST      = 'api.trae.com.cn';
const EXCHANGE_PATH   = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const CLIENT_ID       = 'en1oxy7wnw8j9n';
const CLIENT_SECRET   = '-';
const UGS             = ['api.trae.cn', 'api.trae.com.cn'];
const STATUS_PATH     = '/trae/api/v2/ug/checkin_credits/status';
const CLAIM_PATH      = '/trae/api/v2/ug/checkin_credits/claim';
const GET_TOKEN_PATH  = '/cloudide/api/v3/common/GetUserToken';
const STATE_FILE      = path.join(__dirname, 'trae_state.json');
const REQUEST_TIMEOUT = 15000;
const DELAY_MIN       = 3;
const DELAY_MAX       = 8;
const USER_AGENT      = 'Trae/0.1.43';
const DEBUG           = true;
const CLAIM_MAX_RETRY = 3;                              // 签到失败最大重试次数
const CLAIM_RETRY_WAIT = [8, 12, 20];                   // 每次重试等待秒数（递增退避）
/* ================= 可调配置结束 ================= */

/* ---------- 通用工具 ---------- */
function postJson(host, pathname, headers, body) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: host, path: pathname, method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        headers
      ),
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (buf.length < 1024 * 1024) buf += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.setTimeout(REQUEST_TIMEOUT, () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => resolve({ status: 0, body: '', error: e }));
    req.write(body === undefined ? '{}' : body);
    req.end();
  });
}

const parseJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const isJwt = (s) => /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);

function jwtName(token) {
  try {
    const part = token.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return obj.nickname || obj.name || obj.user_name || obj.account_name || '';
  } catch (e) { return ''; }
}

function pseudoDeviceId(cred) {
  const h = crypto.createHash('md5').update(cred).digest('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) +
         '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
}

/* ---------- refreshToken 持久化 ---------- */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { accounts: [] }; }
}

function saveState(state) {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.log(`[警告] 状态保存失败：${e.message}`);
  }
}

async function exchangeByRefresh(refreshToken) {
  const body = JSON.stringify({ ClientID: CLIENT_ID, RefreshToken: refreshToken, ClientSecret: CLIENT_SECRET, UserID: '' });
  const r = await postJson(OAUTH_HOST, EXCHANGE_PATH, { 'User-Agent': USER_AGENT }, body);
  if (r.status === 0) return { ok: false, error: `网络异常：${r.error ? r.error.message : '未知错误'}` };
  if (DEBUG) console.log(`[DEBUG] ExchangeToken 响应（HTTP ${r.status}）：${String(r.body).slice(0, 400)}`);
  const j = parseJson(r.body);
  const res = j && j.Result;
  if (res && res.Token) {
    let exp = res.TokenExpireAt || 0;
    if (exp > 1e12) exp = Math.floor(exp / 1000);
    if (!exp && res.TokenExpireDuration) exp = Math.floor(Date.now() / 1000) + res.TokenExpireDuration;
    return { ok: true, accessToken: res.Token, newRefresh: res.RefreshToken || refreshToken, expiresAt: exp };
  }
  return { ok: false, error: (j && (j.message || j.msg)) || `HTTP ${r.status} ${String(r.body).slice(0, 200)}` };
}

/* ---------- 凭证解析（v5.1 修复：refreshToken 含 = 不再误判为 Cookie） ---------- */
function parseCredential(line) {
  const s = (line || '').trim();
  if (!s) return null;
  // 整段回调 URL：从中提取 refreshToken 参数
  if (/^https?:\/\//i.test(s)) {
    const m = /[?&]refreshToken=([^&]+)/.exec(s);
    if (m) {
      let rt;
      try { rt = decodeURIComponent(m[1]); } catch (e) { rt = m[1]; }
      return { type: 'refresh', raw: rt };
    }
    return null;
  }
  if (/^cloud-ide-jwt\s+/i.test(s)) return { type: 'jwt', raw: s, token: s.replace(/^cloud-ide-jwt\s+/i, '') };
  if (/^bearer\s+/i.test(s)) return { type: 'jwt', raw: s, token: s.replace(/^bearer\s+/i, '') };
  if (isJwt(s)) return { type: 'jwt', raw: s, token: s };
  // Cookie 必须是分号分隔的多键值对（含 ";"），refreshToken 虽含 "=" 但无分号
  if (s.indexOf('=') !== -1 && s.indexOf(';') !== -1) return { type: 'cookie', raw: s };
  return { type: 'refresh', raw: s };
}

/* ---------- 签到请求头 ---------- */
function buildHeaders(token, host) {
  const site = host && host.indexOf('trae.com.cn') !== -1 ? 'https://www.trae.com.cn' : 'https://www.trae.cn';
  return {
    'User-Agent': USER_AGENT,
    'Authorization': 'Cloud-IDE-JWT ' + token,
    'X-User-Region': 'CN',
    'X-Device-Id': pseudoDeviceId(token),
    'Origin': site,
    'Referer': site + '/',
  };
}

/* cookie 换 JWT（兜底） */
async function exchangeByCookie(cookie) {
  for (const host of UGS) {
    const headers = { 'User-Agent': USER_AGENT, 'Cookie': cookie, 'Origin': 'https://www.trae.cn', 'Referer': 'https://www.trae.cn/' };
    const r = await postJson(host, GET_TOKEN_PATH, headers, '{}');
    if (DEBUG) console.log(`[DEBUG] GetUserToken 尝试 ${host}（HTTP ${r.status}）：${String(r.body).slice(0, 300)}`);
    if (r.status === 0) continue;
    const j = parseJson(r.body);
    const token = j && j.data && j.data.Result && j.data.Result.Token;
    if (token) return { ok: true, accessToken: token, host: host };
  }
  return { ok: false, error: 'Cookie 换 JWT 失败，请重新登录抓取' };
}

function isSessionDead(status, body) {
  if (status === 401 || status === 403) return true;
  const j = parseJson(body);
  if (j && typeof j.code === 'number' && j.code === 1001) return true;
  const b = (body || '').toLowerCase();
  return /login|unauthorized|invalid token|token 失效|token.*expired|session.*(invalid|expired)|not login|未登录|请先登录|authenticate/.test(b);
}

function isAlreadyChecked(obj) {
  if (!obj) return false;
  if (obj.checked_in === true) return true;
  const b = JSON.stringify(obj).toLowerCase();
  return b.indexOf('已签到') !== -1 || /already\s+check/.test(b);
}

function isSuccessPayload(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.code === 0 || obj.code === '0' || obj.code === 200) return true;
  if (typeof obj.status === 'string' && /^(ok|success)$/i.test(obj.status)) return true;
  if (obj.success === true) return true;
  return false;
}

/* v6 新增：限流识别（不是反作弊，是高并发节流） */
function isRateLimited(obj, status) {
  if (status === 429 || status === 503) return true;
  if (!obj || typeof obj !== 'object') return false;
  const c = obj.code;
  // 已知限流业务码：9074 用户太多、1005 积分上限、429 频率、5000+ 服务端临时
  if (c === 9074 || c === 1005 || c === 429) return true;
  if (typeof c === 'number' && c >= 5000 && c < 6000) return true;
  const m = (obj.message || '').toLowerCase();
  return /用户太多|参与用户|频率|限流|rate.?limit|too many|try again|稍后|reach limit/.test(m);
}

/* ---------- 单账号签到 ---------- */
async function signOne(cred, index, total) {
  try {
    let token = '';
    let host = UGS[0];
    let label = `账号${index}`;

    if (cred.type === 'refresh') {
      const state = loadState();
      const saved = (state.accounts && state.accounts[index - 1]) || {};
      let rt = saved.rt || cred.raw;
      console.log(`[账号 ${index}/${total}] [诊断] 凭证类型 = refreshToken，执行续签...`);
      const ex = await exchangeByRefresh(rt);
      if (!ex.ok) {
        if (saved.rt && saved.rt !== cred.raw) {
          console.log(`[账号 ${index}/${total}] 状态文件中的 refreshToken 失效，回退环境变量原始值重试...`);
          const ex2 = await exchangeByRefresh(cred.raw);
          if (!ex2.ok) {
            console.log(`[账号 ${index}/${total}] 【cookie失效/登录过期】refreshToken 已失效：${ex2.error}，请用 --login 重新获取`);
            return;
          }
          token = ex2.accessToken;
          const st2 = loadState();
          while ((st2.accounts || []).length < index) st2.accounts.push({});
          st2.accounts[index - 1] = { rt: ex2.newRefresh, exp: ex2.expiresAt, ts: Date.now() };
          saveState(st2);
        } else {
          console.log(`[账号 ${index}/${total}] 【cookie失效/登录过期】refreshToken 已失效：${ex.error}，请用 --login 重新获取`);
          return;
        }
      } else {
        token = ex.accessToken;
        const st = loadState();
        while ((st.accounts || []).length < index) st.accounts.push({});
        st.accounts[index - 1] = { rt: ex.newRefresh, exp: ex.expiresAt, ts: Date.now() };
        saveState(st);
        console.log(`[账号 ${index}/${total}] [诊断] 续签成功，新 accessToken 有效期至 ${ex.expiresAt ? new Date(ex.expiresAt * 1000).toLocaleString() : '未知'}`);
      }
      label = jwtName(token) || label;
    } else if (cred.type === 'jwt') {
      token = cred.token;
      console.log(`[账号 ${index}/${total}] [诊断] 凭证类型 = JWT（token 前 12 位：${token.slice(0, 12)}...）`);
      label = jwtName(token) || label;
    } else {
      console.log(`[账号 ${index}/${total}] [诊断] 凭证类型 = Cookie（时效短，建议改用 refreshToken 保活）`);
      const ex = await exchangeByCookie(cred.raw);
      if (!ex.ok) {
        console.log(`[账号 ${index}/${total}] 【cookie失效/登录过期】${ex.error}`);
        return;
      }
      token = ex.accessToken;
      host = ex.host;
      label = jwtName(token) || label;
    }

    console.log(`[账号 ${index}/${total}] ${label} 开始签到...`);

    // 第一步：查询签到状态
    const st = await postJson(host, STATUS_PATH, buildHeaders(token, host), '{}');
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
    if (isAlreadyChecked(sj)) {
      console.log(`[账号 ${index}/${total}] 【今日已签到】无需重复签到`);
      return;
    }

    // 第二步：执行签到（带限流重试）
    let cl = null, cj = null;
    for (let attempt = 0; attempt < CLAIM_MAX_RETRY; attempt++) {
      cl = await postJson(host, CLAIM_PATH, buildHeaders(token, host), '{}');
      if (cl.status === 0) {
        console.log(`[账号 ${index}/${total}] 【网络异常】执行签到失败：${cl.error ? cl.error.message : '未知错误'}`);
        return;
      }
      if (DEBUG) console.log(`[账号 ${index}/${total}] [DEBUG] 签到接口响应（HTTP ${cl.status}，第 ${attempt + 1}/${CLAIM_MAX_RETRY} 次）：${String(cl.body).slice(0, 600)}`);
      if (isSessionDead(cl.status, cl.body)) {
        console.log(`[账号 ${index}/${total}] 【cookie失效/登录过期】凭证无效，请重新抓取`);
        return;
      }
      cj = parseJson(cl.body);
      if (isRateLimited(cj, cl.status)) {
        if (attempt < CLAIM_MAX_RETRY - 1) {
          const wait = CLAIM_RETRY_WAIT[attempt] || 15;
          console.log(`[账号 ${index}/${total}] 【限流】code=${cj && cj.code}（${cj && (cj.message || '')}），${wait}s 后重试 (${attempt + 1}/${CLAIM_MAX_RETRY})...`);
          await sleep(wait * 1000);
          continue;
        }
        console.log(`[账号 ${index}/${total}] 【限流放弃】已重试 ${CLAIM_MAX_RETRY} 次仍被节流，建议避开高峰期（早 6 点前或晚 10 点后）再试`);
        return;
      }
      break; // 不是限流，跳出循环
    }

    // 处理签到结果
    if (isAlreadyChecked(cj)) {
      console.log(`[账号 ${index}/${total}] 【今日已签到】无需重复签到`);
      return;
    }
    if (cl && cl.status === 200 && cj && (isSuccessPayload(cj) || cj.checked_in === true)) {
      const extra = typeof cj.credits === 'number' ? `，今日积分 +${cj.credits}` : '';
      console.log(`[账号 ${index}/${total}] 【签到成功】${extra}`);
    } else {
      const msg = (cj && (cj.message || cj.msg || cj.error)) || `HTTP ${cl && cl.status}：${cl && String(cl.body).slice(0, 200)}`;
      console.log(`[账号 ${index}/${total}] 【签到失败】${msg}`);
    }
  } catch (e) {
    console.log(`[账号 ${index}/${total}] 【异常】${e.message}`);
  }
}

/* ---------- 主流程 ---------- */
async function main() {
  const args = process.argv.slice(2);

  // 辅助模式：生成登录链接
  if (args.indexOf('--login') !== -1) {
    const hex = (n) => crypto.randomBytes(n).toString('hex');
    const machineId = hex(16);
    const deviceId = hex(16);
    const params = {
      login_version: '1', auth_from: 'solo', login_channel: 'native_ide',
      plugin_version: '2.3.62834', auth_type: 'local', client_id: CLIENT_ID,
      redirect: '0', login_trace_id: hex(8),
      auth_callback_url: 'http://127.0.0.1:18080/authorize',
      machine_id: machineId, device_id: deviceId,
      x_device_id: deviceId, x_machine_id: machineId,
      x_device_brand: 'PC', x_device_type: 'PC',
      x_os_version: '1.0', x_app_version: '0.1.43', x_app_type: 'stable',
    };
    const qs = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
    console.log('============================================================');
    console.log('  TRAE 保活登录链接生成');
    console.log('============================================================');
    console.log('步骤：');
    console.log('  1. 浏览器打开下面的链接，用手机号/验证码登录');
    console.log('  2. 登录成功后浏览器会跳到打不开的 127.0.0.1 地址');
    console.log('  3. 复制地址栏完整链接，执行：node trae_signin.js --parse "<链接>"');
    console.log('');
    console.log('登录链接：');
    console.log('  https://www.trae.cn/authorization?' + qs);
    console.log('');
    return;
  }

  // 辅助模式：解析回调链接
  const pi = args.indexOf('--parse');
  if (pi !== -1) {
    const url = args[pi + 1];
    if (!url) { console.log('用法：node trae_signin.js --parse "<登录回调链接>"'); return; }
    const q = url.split('?')[1] || '';
    const get = (k) => { const m = new RegExp('[?&]' + k + '=([^&]*)').exec('?' + q); return m ? decodeURIComponent(m[1]) : ''; };
    const refreshToken = get('refreshToken');
    if (refreshToken) {
      console.log('============================================================');
      console.log('  提取成功！请把下面这行填入青龙环境变量 TRAE_REFRESH_TOKEN');
      console.log('============================================================');
      console.log(refreshToken);
      console.log('');
      console.log('有效期约 14 天，脚本每次运行会自动续签并持久化，实现免维护保活。');
    } else {
      console.log('未在回调链接中找到 refreshToken 参数，请确认链接完整（应含 refreshToken=...）');
    }
    return;
  }

  // 正常签到流程
  const refreshRaw = process.env.TRAE_REFRESH_TOKEN || '';
  const cookieRaw = process.env.TRAE_COOKIE || '';
  const raw = refreshRaw || cookieRaw;
  if (!raw.trim()) {
    console.log('【配置缺失】未检测到 TRAE_REFRESH_TOKEN / TRAE_COOKIE 环境变量');
    console.log('提示：推荐使用 TRAE_REFRESH_TOKEN（14 天保活），获取方式：node trae_signin.js --login');
    return;
  }
  const list = raw.split(/\r?\n|\\n/).map((s) => s.trim()).filter(Boolean);
  console.log(`检测到 ${list.length} 个账号，开始批量签到...`);
  for (let i = 0; i < list.length; i++) {
    await signOne(parseCredential(list[i]), i + 1, list.length);
    if (i < list.length - 1) {
      const d = randInt(DELAY_MIN, DELAY_MAX);
      console.log(`随机延时 ${d} 秒后继续下一个账号...`);
      await sleep(d * 1000);
    }
  }
  console.log('===== 全部账号处理完毕 =====');
}

main().catch((e) => console.log('【脚本异常】' + e.message));