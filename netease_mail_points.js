/**
 * 网易邮箱大师 - 邮积分自动任务脚本 (青龙面板)
 * 
 * 逆向分析自: mail.apk (Mail Master v7.25.19, com.netease.mail)
 * 
 * 功能:
 *   1. 每日签到 (clockIn) - 获取邮积分
 *   2. 集赞任务领奖 (collectLike) - 浏览/点赞小红书笔记获取积分
 *   3. 查询积分余额 (getScore)
 *   4. 查询积分记录 (getScoreRecord)
 *   5. 查询任务列表 (getTaskList)
 *   6. 签到提醒通知 (enableNotify)
 *   7. 礼物兑换 (exchangeGift) - 可选
 *   8. 补签 (signLate) - 可选
 * 
 * 环境变量:
 *   NETEASE_MAIL_SESSIONS - 多账号 mastersess&masterfp 配置
 *     格式: mastersess1#masterfp1&mastersess2#masterfp2
 *     多账号用 & 分隔, session和fp用 # 分隔
 *     
 *   或者单账号:
 *   NETEASE_MAIL_MASTERSESS - master session token
 *   NETEASE_MAIL_MASTERFP - master fingerprint
 *   
 *   NETEASE_MAIL_DEVICEID - (可选) 设备ID, 用于礼物兑换
 *   NETEASE_MAIL_SIGN_NOTIFY - (可选) 是否开启签到提醒, 默认 true
 *   NETEASE_MAIL_EXCHANGE_GIFT - (可选) 是否自动兑换礼物, 默认 false
 *   NETEASE_MAIL_SIGN_LATE - (可选) 补签日期 (YYYY-MM-DD), 不填则不补签
 * 
 * 获取 mastersess 和 masterfp 的方法:
 *   1. 使用抓包工具 (Charles/Fiddler/Reqable) 抓取邮箱大师App的网络请求
 *   2. 找到请求 dashi.163.com 的请求头
 *   3. 复制 mastersess 和 masterfp 的值
 * 
 * cron: 30 7 * * *
 * new Env('网易邮箱大师邮积分');
 */

const axios = require('axios');
const crypto = require('crypto');

// ============ 配置 ============
const TASK_CENTER_BASE = 'https://dashi.163.com/task-center-api/fapi';
const MAIL_SCORE_BASE = 'https://dashi.163.com/mailsrv-score/fapi';

const SCRIPT_VERSION = '1.0.0';
const SCRIPT_NAME = '网易邮箱大师邮积分';

// ============ 通知 ============
let notify;
try {
  notify = require('./sendNotify');
} catch (e) {
  notify = { sendNotify: async () => {} };
}

// ============ 工具函数 ============
function log(msg) {
  console.log(`[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${msg}`);
}

function maskStr(str, start = 6, end = 4) {
  if (!str || str.length < start + end) return '****';
  return str.substring(0, start) + '****' + str.substring(str.length - end);
}

// ============ API 客户端 ============
class MailPointsClient {
  constructor(mastersess, masterfp, deviceId = '') {
    this.mastersess = mastersess;
    this.masterfp = masterfp;
    this.deviceId = deviceId || crypto.randomUUID();

    // 任务中心 API 客户端
    this.taskCenter = axios.create({
      baseURL: TASK_CENTER_BASE,
      timeout: 30000,
      withCredentials: true,
      headers: {
        'Content-Type': 'application/json',
        'mastersess': mastersess,
        'masterfp': masterfp,
        'User-Agent': 'MailMaster/7.25.19 (Android 14; Scale/3.0)',
        'Accept': 'application/json',
      },
    });

    // 积分服务 API 客户端
    this.mailScore = axios.create({
      baseURL: MAIL_SCORE_BASE,
      timeout: 30000,
      withCredentials: true,
      headers: {
        'Content-Type': 'application/json',
        'mastersess': mastersess,
        'masterfp': masterfp,
        'User-Agent': 'MailMaster/7.25.19 (Android 14; Scale/3.0)',
        'Accept': 'application/json',
      },
    });

    // 响应拦截器 - 统一处理返回格式 {code, desc, result}
    const responseInterceptor = (response) => {
      const data = response.data;
      if (data.code !== 200) {
        throw new Error(`API错误[${data.code}]: ${data.desc || '未知错误'}`);
      }
      return data.result;
    };

    const errorInterceptor = (error) => {
      if (error.response) {
        const data = error.response.data;
        if (data && data.desc) {
          throw new Error(`API错误[${data.code || error.response.status}]: ${data.desc}`);
        }
        throw new Error(`HTTP错误[${error.response.status}]: ${error.response.statusText}`);
      }
      throw error;
    };

    this.taskCenter.interceptors.response.use(responseInterceptor, errorInterceptor);
    this.mailScore.interceptors.response.use(responseInterceptor, errorInterceptor);
  }

  // ============ 任务中心 API ============

  /**
   * 获取任务列表
   * POST /task/list
   * @param {Object} params - { entrySource, env, includeViewTypes }
   */
  async getTaskList(entrySource = 'pointsCenter', includeViewTypes = []) {
    const data = {
      entrySource,
      env: {},
      includeViewTypes,
    };
    return await this.taskCenter.post('/task/list', data);
  }

  /**
   * 获取任务详情
   * GET /task/detail
   * @param {string} taskType - "SIGN_IN" | "COLLECT_LIKE"
   */
  async getTaskDetail(taskType) {
    return await this.taskCenter.get('/task/detail', { params: { taskType } });
  }

  /**
   * 完成任务 (签到)
   * POST /task/complete
   * @param {string} taskSpeType - 任务特殊类型
   */
  async completeTask(taskSpeType) {
    return await this.taskCenter.post('/task/complete', { taskSpeType });
  }

  /**
   * 领取任务奖励 (集赞)
   * POST /task/reward
   * @param {string} taskType - "COLLECT_LIKE"
   */
  async claimReward(taskType) {
    return await this.taskCenter.post('/task/reward', { taskType });
  }

  /**
   * 设置签到通知
   * POST /sign-in/notification
   * @param {boolean} enable - 是否开启
   */
  async setSignInNotification(enable) {
    return await this.taskCenter.post('/sign-in/notification', { enable });
  }

  /**
   * 补签
   * POST /sign-in/late
   * @param {string} date - 日期 YYYY-MM-DD
   */
  async signInLate(date) {
    return await this.taskCenter.post('/sign-in/late', { date });
  }

  // ============ 积分服务 API ============

  /**
   * 获取积分信息
   * GET /score
   */
  async getScore() {
    return await this.mailScore.get('/score');
  }

  /**
   * 获取积分记录
   * GET /score/record/list
   * @param {number} limit - 每页数量, 默认20
   * @param {string} offset - 分页游标
   */
  async getScoreRecordList(limit = 20, offset = '') {
    return await this.mailScore.get('/score/record/list', { params: { limit, offset } });
  }

  /**
   * 获取礼物列表
   * GET /gift/list
   * @param {number} limit - 每页数量
   * @param {string} offset - 分页游标
   */
  async getGiftList(limit = 20, offset = '') {
    return await this.mailScore.get('/gift/list', { params: { limit, offset } });
  }

  /**
   * 获取礼物详情
   * GET /gift/detail
   * @param {string} giftId - 礼物ID
   */
  async getGiftDetail(giftId) {
    return await this.mailScore.get('/gift/detail', { params: { giftId } });
  }

  /**
   * 兑换礼物
   * POST /gift/exchange
   * @param {Object} giftInfo - 礼物信息 { giftId, name, ... }
   */
  async exchangeGift(giftInfo) {
    const data = { ...giftInfo, deviceId: this.deviceId };
    return await this.mailScore.post('/gift/exchange', data);
  }

  /**
   * 使用礼物
   * POST /gift/use
   * @param {Object} params - 使用参数
   * @param {string} mixmailtokens - 混合邮件token
   */
  async useGift(params, mixmailtokens = '') {
    const { mixmailtokens: _, ...rest } = params;
    return await this.mailScore.post('/gift/use', rest, {
      headers: { mixmailtokens },
    });
  }

  /**
   * 获取兑换记录
   * GET /gift/record/list
   * @param {number} limit - 每页数量
   * @param {string} offset - 分页游标
   */
  async getGiftRecordList(limit = 20, offset = '') {
    return await this.mailScore.get('/gift/record/list', { params: { limit, offset } });
  }
}

// ============ 任务执行器 ============
class PointsTaskExecutor {
  constructor(client, accountName = '默认账号') {
    this.client = client;
    this.accountName = accountName;
    this.results = [];
    this.scoreBefore = 0;
    this.scoreAfter = 0;
  }

  record(task, success, detail = '') {
    const status = success ? '✅' : '❌';
    this.results.push({ task, success, detail });
    log(`${status} [${this.accountName}] ${task}: ${detail}`);
  }

  async run() {
    log(`\n${'='.repeat(60)}`);
    log(`🚀 开始执行 [${this.accountName}] 邮积分任务`);
    log(`Session: ${maskStr(this.client.mastersess)}`);
    log(`Fingerprint: ${maskStr(this.client.masterfp)}`);
    log(`${'='.repeat(60)}\n`);

    // 1. 查询当前积分
    await this.getScoreInfo();

    // 2. 每日签到
    await this.doSignIn();

    // 3. 集赞任务
    await this.doCollectLike();

    // 4. 查询任务列表
    await this.doGetTaskList();

    // 5. 签到提醒
    await this.doEnableNotify();

    // 6. 补签 (如果配置了)
    await this.doSignLate();

    // 7. 自动兑换礼物 (如果开启)
    await this.doExchangeGift();

    // 8. 查询最终积分
    await this.getScoreInfo(true);

    // 9. 查询积分记录
    await this.doGetScoreRecord();

    return this.generateReport();
  }

  async getScoreInfo(isAfter = false) {
    try {
      const result = await this.client.getScore();
      const score = result?.score ?? result?.totalScore ?? 0;
      if (!isAfter) {
        this.scoreBefore = score;
        log(`💰 当前积分: ${score}`);
      } else {
        this.scoreAfter = score;
        const diff = score - this.scoreBefore;
        log(`💰 最终积分: ${score} (本次${diff >= 0 ? '获取' : '消耗'} ${Math.abs(diff)})`);
      }
      this.record('查询积分', true, `积分: ${score}`);
    } catch (e) {
      this.record('查询积分', false, e.message);
    }
  }

  async doSignIn() {
    try {
      // 获取签到详情
      const detail = await this.client.getTaskDetail('SIGN_IN');
      const clockStatus = detail?.clockStatus ?? detail?.status;
      const isSigned = clockStatus === 'SIGNED';

      if (isSigned) {
        this.record('每日签到', true, '今日已签到, 无需重复');
        return;
      }

      // 获取 taskSpeType
      const taskSpeType = detail?.taskSpeType ?? detail?.taskType ?? 'SIGN_IN';

      // 执行签到
      const result = await this.client.completeTask(taskSpeType);
      const reward = result?.reward ?? result?.score ?? 0;
      this.record('每日签到', true, `签到成功! 获得 ${reward} 积分`);
    } catch (e) {
      // 如果错误是"已签到", 也算成功
      if (e.message.includes('已签') || e.message.includes('already') || e.message.includes('SIGNED')) {
        this.record('每日签到', true, '今日已签到');
      } else {
        this.record('每日签到', false, e.message);
      }
    }
  }

  async doCollectLike() {
    try {
      // 获取集赞任务详情
      const detail = await this.client.getTaskDetail('COLLECT_LIKE');
      const canReward = detail?.canReward ?? detail?.canClaim ?? false;

      if (!canReward) {
        this.record('集赞任务', true, '暂无可领取的集赞奖励');
        return;
      }

      // 领取集赞奖励
      const result = await this.client.claimReward('COLLECT_LIKE');
      const reward = result?.reward ?? result?.score ?? 0;
      this.record('集赞任务', true, `领取成功! 获得 ${reward} 积分`);
    } catch (e) {
      if (e.message.includes('不可领取') || e.message.includes('cannot') || e.message.includes('已领')) {
        this.record('集赞任务', true, '暂无可领取的集赞奖励');
      } else {
        this.record('集赞任务', false, e.message);
      }
    }
  }

  async doGetTaskList() {
    try {
      const result = await this.client.getTaskList('pointsCenter', []);
      const tasks = result?.list ?? result?.tasks ?? [];
      const pendingTasks = tasks.filter(t => t.status === 'PENDING' || t.status === 'UNFINISHED');

      let detail = `共${tasks.length}个任务, ${pendingTasks.length}个待完成`;
      if (tasks.length > 0) {
        const taskNames = tasks.slice(0, 5).map(t => `${t.name || t.title || t.id}(${t.status})`).join(', ');
        detail += ` | 任务: ${taskNames}${tasks.length > 5 ? '...' : ''}`;
      }
      this.record('任务列表', true, detail);
    } catch (e) {
      this.record('任务列表', false, e.message);
    }
  }

  async doEnableNotify() {
    const enable = process.env.NETEASE_MAIL_SIGN_NOTIFY !== 'false';
    try {
      await this.client.setSignInNotification(enable);
      this.record('签到提醒', true, enable ? '已开启' : '已关闭');
    } catch (e) {
      this.record('签到提醒', false, e.message);
    }
  }

  async doSignLate() {
    const date = process.env.NETEASE_MAIL_SIGN_LATE;
    if (!date) return;

    try {
      const result = await this.client.signInLate(date);
      this.record('补签', true, `补签日期 ${date} 成功`);
    } catch (e) {
      this.record('补签', false, `补签日期 ${date} 失败: ${e.message}`);
    }
  }

  async doExchangeGift() {
    const shouldExchange = process.env.NETEASE_MAIL_EXCHANGE_GIFT === 'true';
    if (!shouldExchange) return;

    try {
      const result = await this.client.getGiftList(20, '');
      const gifts = result?.list ?? [];
      if (gifts.length === 0) {
        this.record('兑换礼物', true, '暂无可兑换的礼物');
        return;
      }

      // 找到积分足够兑换的礼物
      const affordable = gifts.filter(g => (g.score ?? g.price ?? 999999) <= this.scoreBefore);
      if (affordable.length === 0) {
        this.record('兑换礼物', true, '积分不足, 无法兑换任何礼物');
        return;
      }

      // 兑换第一个可兑换的礼物
      const gift = affordable[0];
      const exchangeResult = await this.client.exchangeGift({
        giftId: gift.giftId ?? gift.id,
        name: gift.name,
      });
      this.record('兑换礼物', true, `兑换 ${gift.name} 成功`);
    } catch (e) {
      this.record('兑换礼物', false, e.message);
    }
  }

  async doGetScoreRecord() {
    try {
      const result = await this.client.getScoreRecordList(10, '');
      const records = result?.list ?? [];
      if (records.length === 0) {
        this.record('积分记录', true, '暂无积分记录');
        return;
      }

      const recent = records.slice(0, 5).map(r => 
        `${r.desc ?? r.title ?? '未知'}: ${r.score ?? r.points ?? 0}`
      ).join(', ');
      this.record('积分记录', true, `最近${records.length}条: ${recent}`);
    } catch (e) {
      this.record('积分记录', false, e.message);
    }
  }

  generateReport() {
    const successCount = this.results.filter(r => r.success).length;
    const totalCount = this.results.length;
    const scoreDiff = this.scoreAfter - this.scoreBefore;

    let report = `\n${'='.repeat(60)}\n`;
    report += `📊 [${this.accountName}] 执行报告\n`;
    report += `${'='.repeat(60)}\n`;
    report += `执行时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
    report += `积分变化: ${this.scoreBefore} → ${this.scoreAfter} (${scoreDiff >= 0 ? '+' : ''}${scoreDiff})\n`;
    report += `任务统计: ${successCount}/${totalCount} 成功\n`;
    report += `${'-'.repeat(60)}\n`;

    for (const r of this.results) {
      report += `${r.success ? '✅' : '❌'} ${r.task}: ${r.detail}\n`;
    }

    report += `${'='.repeat(60)}\n`;
    return report;
  }
}

// ============ 多账号管理 ============
function getAccounts() {
  const accounts = [];

  // 优先从 NETEASE_MAIL_SESSIONS 读取多账号
  const sessionsStr = process.env.NETEASE_MAIL_SESSIONS;
  if (sessionsStr) {
    const sessions = sessionsStr.split('&');
    for (let i = 0; i < sessions.length; i++) {
      const parts = sessions[i].split('#');
      if (parts.length >= 2 && parts[0] && parts[1]) {
        accounts.push({
          mastersess: parts[0].trim(),
          masterfp: parts[1].trim(),
          name: `账号${i + 1}`,
        });
      }
    }
  }

  // 如果没有多账号配置, 尝试读取单账号
  if (accounts.length === 0) {
    const mastersess = process.env.NETEASE_MAIL_MASTERSESS;
    const masterfp = process.env.NETEASE_MAIL_MASTERFP;
    if (mastersess && masterfp) {
      accounts.push({
        mastersess: mastersess.trim(),
        masterfp: masterfp.trim(),
        name: '默认账号',
      });
    }
  }

  return accounts;
}

// ============ 主函数 ============
async function main() {
  log(`\n📧 ${SCRIPT_NAME} v${SCRIPT_VERSION}`);
  log(`📝 逆向自: Mail Master v7.25.19 (com.netease.mail)\n`);

  const accounts = getAccounts();

  if (accounts.length === 0) {
    log('❌ 未找到账号配置!');
    log('');
    log('请配置环境变量:');
    log('  方式1 (多账号): NETEASE_MAIL_SESSIONS="sess1#fp1&sess2#fp2"');
    log('  方式2 (单账号): NETEASE_MAIL_MASTERSESS="xxx" + NETEASE_MAIL_MASTERFP="xxx"');
    log('');
    log('获取方法:');
    log('  1. 使用抓包工具(Charles/Fiddler/Reqable)抓取邮箱大师App请求');
    log('  2. 找到请求 dashi.163.com 的请求头');
    log('  3. 复制 mastersess 和 masterfp 的值');
    return;
  }

  log(`📋 找到 ${accounts.length} 个账号\n`);

  let allReports = [];

  for (const account of accounts) {
    try {
      const deviceId = process.env.NETEASE_MAIL_DEVICEID || '';
      const client = new MailPointsClient(
        account.mastersess,
        account.masterfp,
        deviceId,
      );
      const executor = new PointsTaskExecutor(client, account.name);
      const report = await executor.run();
      allReports.push(report);
    } catch (e) {
      log(`❌ [${account.name}] 初始化失败: ${e.message}`);
      allReports.push(`\n❌ [${account.name}] 执行失败: ${e.message}\n`);
    }

    // 账号间延迟, 避免请求过快
    if (accounts.length > 1) {
      log('\n⏳ 等待 5 秒后处理下一个账号...\n');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // 汇总报告
  const summary = allReports.join('\n');
  log(summary);

  // 发送通知
  try {
    await notify.sendNotify(SCRIPT_NAME, summary);
  } catch (e) {
    // 通知发送失败不影响主流程
  }
}

// ============ 启动 ============
if (require.main === module) {
  main().catch(e => {
    log(`❌ 程序异常: ${e.message}`);
    console.error(e);
  });
}

module.exports = { MailPointsClient, PointsTaskExecutor, main };
