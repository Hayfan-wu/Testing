/**
 * 大潮APP每日任务脚本 v3.1
 * 
 * 项目说明：海宁大潮APP自动签到、任务、抽奖脚本
 * 平台：海宁市传媒中心 - 大潮APP
 * 技术提供商：厚建软件(hoge.cn) + 天目云(tmuyun.com)
 * 包名：com.hoge.android.app.dachao
 * 
 * ===== 抓包确认（HttpCanary + ADB自动化，2026-09-02）=====
 * 主域名: https://m.aihoge.com
 * 模块命名规则: {module}hy 后缀
 *   - signhy    = 签到模块
 *   - lotteryhy = 抽奖模块
 *   - newshy    = 新闻模块
 *   - memberhy  = 会员/用户模块
 *   - h5hy      = H5页面模块
 * 
 * 已确认API路径：
 *   签到: /api/signhy/client/actSign/{action}
 *         - rank               签到排行
 *         - getSupplementTask  补签任务
 *         - getCalendar        签到日历
 *         - detail             签到详情
 *         - getSignList        签到列表
 *         - getRelationCiList  关联词列表
 *   抽奖: /api/lotteryhy/designh5/client/activity/{activityId}  活动配置
 *         /api/lotteryhy/api/client/cj/awd/drw/{activityId}     抽奖接口
 *         /api/lotteryhy/api/client/cj/my/prize/info/{...}      我的奖品
 *   新闻: /api/newshy/api/client/...
 *   会员: /api/memberhy/tm/...
 *   H5:   /api/h5hy/api/v0/client/...
 * 
 * ===== 认证机制（重要！）=====
 * API采用签名认证机制，直接请求返回: {"error_code":"EXPIRE_SIGNATURE","error_message":"请求头异常"}
 * 
 * 请求需要携带签名相关的请求头（需从APP中逆向获取）：
 * - 可能的header: signature / sign / token / timestamp / nonce / appkey
 * - 签名算法通常为: MD5(timestamp + path + secretKey) 或类似组合
 * 
 * ⚠️ 当前状态：API路径已确认，但签名算法需逆向APP获取
 *     建议使用方法：
 *     1. 用HttpCanary抓包获取请求头中的签名字段
 *     2. 逆向APP的so文件或Java代码获取签名算法
 *     3. 或者直接使用Auto.js/按键精灵模拟APP操作
 * 
 * 青龙面板环境变量配置：
 * 名称: DaChao
 * 值: 手机号&密码
 * 多账号用空格分隔: 手机号1&密码1 手机号2&密码2
 * 
 * Token/Cookie模式（自动识别，推荐）：
 * 值: cookie1 cookie2
 * 
 * 识别规则：包含 & 符号按账号密码处理，否则按Token/Cookie处理
 * 
 * Cron建议: 30 9 * * *  (早上9:30执行)
 *          18 18 * * *  (18:18幸运抽奖)
 * 
 * ⚠️ 本脚本基于HttpCanary实际抓包数据编写
 *     签名算法待逆向，需配合抓包获取完整请求头
 */

const $ = new Env('大潮');
const notify = $.isNode() ? require('../sendNotify') : '';

// ========== 配置区 ==========

// API基础域名（HttpCanary抓包确认）
const BASE_URL = 'https://m.aihoge.com';

// 签到活动ID（从抓包URL参数中获取，可能需要根据实际活动更新）
const SIGN_ACTIVITY_ID = '5d0346cd550e4c8d9c0a7b2f1e3d6a4c';

// 抽奖活动ID（待确认，从活动配置接口获取）
let LOTTERY_ACTIVITY_ID = '';

// 用户代理
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 9; LDPlayer Build/PI) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Mobile Safari/537.36  (compatible; m2osmartcity; DaChao/7.0.0)';

/**
 * API 接口路径配置（基于HttpCanary抓包确认）
 * ✅ = 已确认路径
 * ⚠️ = 路径模式已确认，具体子路径需进一步验证
 */
const API = {
  // ===== 签到模块 (signhy) ✅=====
  sign: {
    rank: '/api/signhy/client/actSign/rank',                    // ✅ 签到排行
    getSupplementTask: '/api/signhy/client/actSign/getSupplementTask', // ✅ 补签任务
    getCalendar: '/api/signhy/client/actSign/getCalendar',       // ✅ 签到日历
    detail: '/api/signhy/client/actSign/detail',                 // ✅ 签到详情
    getSignList: '/api/signhy/client/actSign/getSignList',       // ✅ 签到列表
    getRelationCiList: '/api/signhy/client/actSign/getRelationCiList', // ✅ 关联词列表
    signIn: '/api/signhy/client/actSign/sign',                   // ⚠️ 签到（推测）
  },

  // ===== 抽奖模块 (lotteryhy) ✅=====
  lottery: {
    activityConfig: '/api/lotteryhy/designh5/client/activity',   // ✅ 抽奖活动配置
    draw: '/api/lotteryhy/api/client/cj/awd/drw',                 // ✅ 抽奖
    myPrize: '/api/lotteryhy/api/client/cj/my/prize/info',        // ✅ 我的奖品
  },

  // ===== 新闻模块 (newshy) ✅=====
  news: {
    list: '/api/newshy/api/client/list',                          // ⚠️ 新闻列表（推测）
    detail: '/api/newshy/api/client/detail',                      // ⚠️ 新闻详情（推测）
  },

  // ===== 会员模块 (memberhy) ✅=====
  member: {
    userInfo: '/api/memberhy/tm/user/info',                       // ⚠️ 用户信息（推测）
    login: '/api/memberhy/tm/user/login',                         // ⚠️ 登录（推测）
  },

  // ===== H5模块 (h5hy) ✅=====
  h5: {
    config: '/api/h5hy/api/v0/client/config',                     // ⚠️ H5配置（推测）
  },
};

// ========== 全局变量 ==========

let accounts = [];
let totalResult = [];
let debugMode = false;

// ========== 工具函数 ==========

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function debug(msg) {
  if (debugMode) {
    console.log(`[DEBUG] ${msg}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== 签名机制 ==========

/**
 * 生成API请求签名
 * ⚠️ 待逆向：厚建平台签名算法
 * 
 * 从API返回 EXPIRE_SIGNATURE 错误可知，请求需要签名头
 * 常见的厚建/天目云平台签名模式:
 * - 请求头包含: timestamp, nonce, signature, token 等
 * - 签名算法可能是: MD5(timestamp + path + body + secretKey)
 * 
 * 需要从APP抓包获取完整请求头后，逆向分析算法
 * 或者使用 HttpCanary 的"请求注入"功能绕过签名
 */
function generateSignature(method, path, body) {
  // TODO: 逆向APP获取签名算法
  // 以下为占位，实际使用时需要替换
  const timestamp = Date.now().toString();
  const nonce = Math.random().toString(36).substring(2, 15);
  
  return {
    timestamp: timestamp,
    nonce: nonce,
    signature: '', // 待实现
    // 可能还需要: token, appkey, deviceId 等
  };
}

/**
 * 发送HTTP请求
 */
function request(options) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', url, body, headers = {} } = options;
    
    // 生成签名
    const sig = generateSignature(method, url, body);
    
    const defaultHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Origin': BASE_URL,
      'Referer': BASE_URL + '/',
      // 签名相关头（待确认具体字段名）
      // 'timestamp': sig.timestamp,
      // 'nonce': sig.nonce,
      // 'signature': sig.signature,
      ...headers,
    };

    const fullUrl = url.startsWith('http') ? url : BASE_URL + url;
    debug(`${method} ${fullUrl}`);
    debug(`Headers: ${JSON.stringify(defaultHeaders)}`);
    if (body) debug(`Body: ${JSON.stringify(body)}`);

    $.ajax({
      url: fullUrl,
      method: method,
      headers: defaultHeaders,
      body: body ? JSON.stringify(body) : undefined,
      json: true,
      timeout: 15000,
      success: (resp, data) => {
        debug(`Response: ${JSON.stringify(data).substring(0, 500)}`);
        resolve(data);
      },
      error: (err) => {
        debug(`Error: ${err}`);
        reject(err);
      }
    });
  });
}

// ========== 账号管理 ==========

/**
 * 解析环境变量中的账号配置
 * 自动识别模式：包含 & 为账号密码模式，否则为 Token/Cookie 模式
 */
function parseAccounts() {
  accounts = [];
  
  const env = $.getenv('DaChao');
  if (!env) {
    log('⚠️ 未配置 DaChao 环境变量');
    return;
  }
  
  const items = env.split(' ').filter(p => p.trim());
  items.forEach((item, index) => {
    // 自动识别：包含 & 为账号密码模式
    if (item.includes('&')) {
      const [phone, password] = item.split('&');
      if (phone && password) {
        accounts.push({
          index: index + 1,
          type: 'password',
          phone: phone,
          password: password,
          nickname: `账号${index + 1}(${phone})`,
          token: '',
          cookie: '',
        });
      }
    } else {
      // Token/Cookie 模式
      accounts.push({
        index: index + 1,
        type: 'token',
        token: item,
        cookie: item,
        nickname: `账号${index + 1}`,
      });
    }
  });
  
  const tokenCount = accounts.filter(a => a.type === 'token').length;
  const pwdCount = accounts.filter(a => a.type === 'password').length;
  log(`已加载 ${accounts.length} 个账号（密码:${pwdCount} Token:${tokenCount}）`);
}

// ========== 登录模块 ==========

/**
 * 登录（密码登录）
 * TODO: 需要抓包确认完整登录流程
 */
async function login(account) {
  log(`🔐 ${account.nickname} - 开始登录...`);
  
  try {
    // 注意：实际登录接口需要进一步抓包确认
    // 目前建议使用 Cookie/Token 模式（DaChao 环境变量直接配置cookie）
    if (account.type === 'token') {
      log(`✅ ${account.nickname} - 使用Token模式，跳过登录`);
      return true;
    }
    
    // ⚠️ 以下为推测的登录流程，需抓包验证
    const resp = await request({
      method: 'POST',
      url: API.member.login,
      body: {
        phone: account.phone,
        password: account.password,
        tenantId: '94',
      },
    });
    
    if (resp && resp.code === 200 && resp.data) {
      account.token = resp.data.token || resp.data.accessToken || '';
      account.cookie = resp.data.cookie || '';
      log(`✅ ${account.nickname} - 登录成功`);
      return true;
    } else {
      log(`❌ ${account.nickname} - 登录失败: ${resp?.message || '未知错误'}`);
      return false;
    }
  } catch (e) {
    log(`❌ ${account.nickname} - 登录异常: ${e.message || e}`);
    return false;
  }
}

/**
 * 获取请求头（带认证信息）
 */
function getAuthHeaders(account) {
  const headers = {};
  if (account.cookie) {
    headers['Cookie'] = account.cookie;
  }
  if (account.token) {
    headers['Authorization'] = `Bearer ${account.token}`;
    headers['token'] = account.token;
  }
  return headers;
}

// ========== 签到模块 ==========

/**
 * 获取签到日历
 */
async function getSignCalendar(account) {
  log(`📅 ${account.nickname} - 获取签到日历...`);
  
  try {
    const resp = await request({
      url: `${API.sign.getCalendar}?activity_id=${SIGN_ACTIVITY_ID}`,
      headers: getAuthHeaders(account),
    });
    
    if (resp && resp.code === 200) {
      const data = resp.data || {};
      log(`📅 ${account.nickname} - 已签到${data.signDays || 0}天`);
      return data;
    } else {
      log(`⚠️ ${account.nickname} - 获取签到日历失败: ${resp?.message || '未知'}`);
      return null;
    }
  } catch (e) {
    log(`❌ ${account.nickname} - 获取签到日历异常: ${e.message || e}`);
    return null;
  }
}

/**
 * 获取签到详情（今日签到状态）
 */
async function getSignDetail(account) {
  log(`📋 ${account.nickname} - 获取签到详情...`);
  
  try {
    const resp = await request({
      url: `${API.sign.detail}?activity_id=${SIGN_ACTIVITY_ID}`,
      headers: getAuthHeaders(account),
    });
    
    if (resp && resp.code === 200) {
      return resp.data;
    }
    return null;
  } catch (e) {
    debug(`获取签到详情异常: ${e.message || e}`);
    return null;
  }
}

/**
 * 执行签到
 * TODO: 需要抓包确认签到接口的完整参数
 */
async function doSignIn(account) {
  log(`✍️ ${account.nickname} - 执行签到...`);
  
  try {
    const resp = await request({
      method: 'POST',
      url: API.sign.signIn,
      headers: getAuthHeaders(account),
      body: {
        activity_id: SIGN_ACTIVITY_ID,
      },
    });
    
    if (resp && resp.code === 200) {
      log(`✅ ${account.nickname} - 签到成功！获得${resp.data?.point || 0}积分`);
      return { success: true, data: resp.data };
    } else if (resp && resp.message && resp.message.includes('已签到')) {
      log(`ℹ️ ${account.nickname} - 今日已签到`);
      return { success: true, alreadySigned: true };
    } else {
      log(`❌ ${account.nickname} - 签到失败: ${resp?.message || '未知错误'}`);
      return { success: false, msg: resp?.message };
    }
  } catch (e) {
    log(`❌ ${account.nickname} - 签到异常: ${e.message || e}`);
    return { success: false, msg: e.message || e };
  }
}

/**
 * 获取补签任务
 */
async function getSupplementTask(account) {
  try {
    const resp = await request({
      url: `${API.sign.getSupplementTask}?activity_id=${SIGN_ACTIVITY_ID}`,
      headers: getAuthHeaders(account),
    });
    return resp?.data || null;
  } catch (e) {
    return null;
  }
}

// ========== 抽奖模块 ==========

/**
 * 获取抽奖活动配置
 */
async function getLotteryConfig(account, activityId) {
  log(`🎰 ${account.nickname} - 获取抽奖活动配置...`);
  
  try {
    const id = activityId || LOTTERY_ACTIVITY_ID;
    if (!id) {
      log(`⚠️ ${account.nickname} - 缺少抽奖活动ID`);
      return null;
    }
    
    const resp = await request({
      url: `${API.lottery.activityConfig}/${id}`,
      headers: getAuthHeaders(account),
    });
    
    if (resp && resp.code === 200) {
      log(`🎰 ${account.nickname} - 活动: ${resp.data?.title || '未知'}`);
      return resp.data;
    }
    return null;
  } catch (e) {
    log(`❌ ${account.nickname} - 获取抽奖配置异常: ${e.message || e}`);
    return null;
  }
}

/**
 * 执行抽奖
 * TODO: 需要抓包确认抽奖接口的完整参数
 */
async function doLotteryDraw(account, activityId) {
  log(`🎰 ${account.nickname} - 开始抽奖...`);
  
  try {
    const id = activityId || LOTTERY_ACTIVITY_ID;
    if (!id) {
      log(`⚠️ ${account.nickname} - 缺少抽奖活动ID`);
      return { success: false };
    }
    
    const resp = await request({
      method: 'POST',
      url: `${API.lottery.draw}/${id}`,
      headers: getAuthHeaders(account),
      body: {},
    });
    
    if (resp && resp.code === 200) {
      const prize = resp.data?.prizeName || resp.data?.name || '谢谢参与';
      log(`🎉 ${account.nickname} - 抽奖结果: ${prize}`);
      return { success: true, prize: prize, data: resp.data };
    } else {
      log(`❌ ${account.nickname} - 抽奖失败: ${resp?.message || '未知错误'}`);
      return { success: false, msg: resp?.message };
    }
  } catch (e) {
    log(`❌ ${account.nickname} - 抽奖异常: ${e.message || e}`);
    return { success: false, msg: e.message || e };
  }
}

// ========== 新闻/阅读任务 ==========

/**
 * 获取新闻列表
 */
async function getNewsList(account, page = 1, pageSize = 10) {
  try {
    const resp = await request({
      url: `${API.news.list}?page=${page}&pageSize=${pageSize}`,
      headers: getAuthHeaders(account),
    });
    return resp?.data?.list || resp?.data || [];
  } catch (e) {
    debug(`获取新闻列表异常: ${e.message || e}`);
    return [];
  }
}

/**
 * 阅读新闻（模拟阅读时长后上报）
 * TODO: 需要抓包确认阅读上报接口
 */
async function readNews(account, newsId, duration = 5000) {
  try {
    // 先获取新闻详情
    await request({
      url: `${API.news.detail}/${newsId}`,
      headers: getAuthHeaders(account),
    });
    
    // 模拟阅读时间
    await sleep(duration);
    
    // TODO: 阅读完成上报接口
    log(`📖 ${account.nickname} - 阅读新闻 ${newsId} 完成`);
    return true;
  } catch (e) {
    return false;
  }
}

// ========== 主流程 ==========

/**
 * 执行单个账号的所有任务
 */
async function runAccount(account) {
  const result = {
    account: account.nickname,
    signIn: '未执行',
    lottery: '未执行',
    readNews: '未执行',
    point: 0,
  };
  
  log(`\n========== ${account.nickname} ==========`);
  
  // 1. 登录/验证
  const loginOk = await login(account);
  if (!loginOk && account.type === 'password') {
    result.signIn = '登录失败';
    result.lottery = '登录失败';
    totalResult.push(result);
    return;
  }
  
  // 2. 签到
  try {
    const signDetail = await getSignDetail(account);
    if (signDetail && signDetail.todaySigned) {
      result.signIn = '今日已签';
      log(`ℹ️ ${account.nickname} - 今日已签到`);
    } else {
      const signResult = await doSignIn(account);
      result.signIn = signResult.success ? '签到成功' : '签到失败';
    }
    
    // 获取签到日历信息
    const calendar = await getSignCalendar(account);
    if (calendar) {
      result.signDays = calendar.signDays || 0;
    }
  } catch (e) {
    result.signIn = `异常: ${e.message}`;
  }
  
  // 3. 抽奖（如果有活动ID）
  if (LOTTERY_ACTIVITY_ID) {
    try {
      const lotteryResult = await doLotteryDraw(account);
      result.lottery = lotteryResult.success ? 
        (lotteryResult.prize || '抽奖完成') : 
        (lotteryResult.msg || '抽奖失败');
    } catch (e) {
      result.lottery = `异常: ${e.message}`;
    }
  }
  
  // 4. 阅读任务（可选）
  // TODO: 确认阅读任务接口后启用
  
  totalResult.push(result);
  log(`\n📊 ${account.nickname} 任务完成`);
  log(`   签到: ${result.signIn}`);
  log(`   抽奖: ${result.lottery}`);
}

/**
 * 生成结果消息
 */
function generateMessage() {
  let msg = '【大潮APP任务报告】\n\n';
  
  totalResult.forEach((r, i) => {
    msg += `📱 账号${i + 1}: ${r.account}\n`;
    msg += `   签到: ${r.signIn}\n`;
    msg += `   抽奖: ${r.lottery}\n`;
    if (r.signDays) msg += `   连续签到: ${r.signDays}天\n`;
    msg += '\n';
  });
  
  return msg;
}

// ========== 入口 ==========

async function main() {
  log('🚀 大潮APP每日任务脚本 v3.0 启动');
  log(`📍 API域名: ${BASE_URL}`);
  log(`📝 基于HttpCanary实际抓包数据编写`);
  
  // 解析账号
  parseAccounts();
  if (accounts.length === 0) {
    log('❌ 没有可用的账号配置');
    return;
  }
  
  // 检查调试模式
  if ($.getenv('DaChaoDebug') === '1') {
    debugMode = true;
    log('🔧 调试模式已开启');
  }
  
  // 逐个执行账号任务
  for (let i = 0; i < accounts.length; i++) {
    await runAccount(accounts[i]);
    if (i < accounts.length - 1) {
      await sleep(2000); // 账号间间隔
    }
  }
  
  // 输出结果
  log('\n========== 任务汇总 ==========');
  const message = generateMessage();
  log(message);
  
  // 发送通知
  if (notify && $.getenv('DaChaoNotify') !== '0') {
    await notify.sendNotify('大潮APP任务报告', message);
  }
  
  log('✅ 所有任务执行完毕');
}

// 执行
main().catch(e => {
  console.error('❌ 脚本执行出错:', e);
}).finally(() => {
  $.done();
});
