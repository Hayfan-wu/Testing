/**
 * 网易邮箱大师 - 邮积分自动任务脚本 (青龙面板) v6.0
 * 
 * 逆向分析自: mail.apk (Mail Master v7.25.19, com.netease.mail)
 * 
 * v6.0 更新:
 *   - 深度逆向前端JS (task-center/index.9b0d5fca.js) 和 dex (classes.dex)
 *   - 发现集赞任务使用 taskType:"COLLECT_LIKE" (非taskSpeType)
 *   - 发现 /task/claim 端点 (返回DONE但不推进集赞进度)
 *   - 发现 /task/overview 端点 (返回needSignIn/hasUnclaimedPoints)
 *   - 确认集赞进度推进机制: 原生桥 OPERATE_POINTS_CENTER_TASK
 *     前端JS仅4个HTTP API: complete, detail, list, reward
 *     集赞进度由原生桥打开小红书后服务端内部推进, 无HTTP API可替代
 *   - 修复集赞领奖: 使用 collectLikeReward() → POST /task/reward {taskType:"COLLECT_LIKE"}
 * 
 * v5.0 更新:
 *   - 新增: 自动完成interaction类型任务(点赞/集赞子任务)
 *   - 新增: 视频广告状态轮询检测
 *   - 新增: 集赞任务进度展示
 * 
 * v4.0 核心突破:
 *   - 发现任务完成的关键: 必须带 token 参数!
 *   - 完整流程: /task/complete {taskSpeType, token} → Todo变Award
 *              /task/reward  {taskSpeType, token} → Award变Done + 发放积分
 *   - 实测积分从83涨到308 (+225分), 成功领取16个任务奖励!
 * 
 * 任务完成机制:
 *   ✅ simpleJudge=true 任务: /task/complete + /task/reward (带token)
 *   ✅ interaction任务(点赞子任务): 同上, 完成后标记Done并发放积分
 *   ✅ 签到: /task/complete (无需token)
 *   ⚠️ 视频广告: simpleJudge=false, 需穿山甲SDK S2S回调, needAutoReward=true自动发奖
 *   ❌ 开通会员: 需付费
 *   ❌ 集赞进度推进: 需原生桥OPERATE_POINTS_CENTER_TASK (打开小红书APP)
 *      HTTP API无法推进集赞进度, 仅能查询进度和领取满额奖励
 *   ✅ 集赞满额领奖: POST /task/reward {taskType:"COLLECT_LIKE"} (前端逆向)
 * 
 * 环境变量:
 *   NETEASE_MAIL_SESSIONS - 多账号, 格式: mastersess1#masterfp1&mastersess2#masterfp2
 *   或单账号:
 *   NETEASE_MAIL_MASTERSESS - master session token
 *   NETEASE_MAIL_MASTERFP - master fingerprint
 *   
 *   NETEASE_MAIL_SIGN_NOTIFY - (可选) 签到提醒, 默认 true
 *   NETEASE_MAIL_SIGN_LATE - (可选) 补签日期 YYYY-MM-DD
 * 
 * cron: 30 7 * * *
 * new Env('网易邮箱大师邮积分');
 */

const axios = require('axios');
const crypto = require('crypto');

// ============ 配置 ============
const TASK_CENTER_BASE = 'https://dashi.163.com/task-center-api/fapi';
const MAIL_SCORE_BASE = 'https://dashi.163.com/mailsrv-score/fapi';
const SCRIPT_VERSION = '6.0.0';
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

function getLocalizedText(textObj) {
  if (!textObj) return '';
  if (typeof textObj === 'string') return textObj;
  return textObj.cn || textObj.en || JSON.stringify(textObj);
}

// ============ API 客户端 ============
class MailPointsClient {
  constructor(mastersess, masterfp, deviceId = '') {
    this.mastersess = mastersess;
    this.masterfp = masterfp;
    this.deviceId = deviceId || crypto.randomUUID();

    const commonHeaders = {
      'Content-Type': 'application/json',
      'mastersess': mastersess,
      'masterfp': masterfp,
      'User-Agent': 'MailMaster/7.25.19 (Android 14; Scale/3.0)',
      'Accept': 'application/json',
    };

    this.taskCenter = axios.create({
      baseURL: TASK_CENTER_BASE, timeout: 30000, withCredentials: true, headers: commonHeaders,
    });

    this.mailScore = axios.create({
      baseURL: MAIL_SCORE_BASE, timeout: 30000, withCredentials: true, headers: commonHeaders,
    });

    const responseInterceptor = (response) => {
      const data = response.data;
      if (data.code !== 200) {
        const err = new Error(`API错误[${data.code}]: ${data.desc || '未知错误'}`);
        err.apiCode = data.code;
        err.apiDesc = data.desc;
        throw err;
      }
      return data.result;
    };

    const errorInterceptor = (error) => {
      if (error.response) {
        const data = error.response.data;
        if (data && data.desc) {
          const err = new Error(`API错误[${data.code || error.response.status}]: ${data.desc}`);
          err.apiCode = data.code || error.response.status;
          err.apiDesc = data.desc;
          throw err;
        }
        throw new Error(`HTTP错误[${error.response.status}]`);
      }
      throw error;
    };

    this.taskCenter.interceptors.response.use(responseInterceptor, errorInterceptor);
    this.mailScore.interceptors.response.use(responseInterceptor, errorInterceptor);
  }

  // ============ 任务中心 API ============

  /**
   * 获取任务列表 (每个任务包含 token 字段, 用于完成和领奖)
   * POST /task/list { entry, entrySource, env, excludeViewTypes }
   * 
   * @param {string} entry - 入口, 默认 "ScoreCenter"
   * @param {object} opts - 选项
   *   - includeViewTypes: 包含的视图类型 (如 ["interaction"] 获取集赞子任务)
   *   - excludeViewTypes: 排除的视图类型
   */
  async getTaskList(entry = 'ScoreCenter', opts = {}) {
    const data = {
      entry, entrySource: '', env: { emailList: [] },
    };
    if (opts.includeViewTypes) {
      data.includeViewTypes = opts.includeViewTypes;
    } else {
      data.excludeViewTypes = opts.excludeViewTypes || ['interaction'];
    }
    return await this.taskCenter.post('/task/list', data);
  }

  /**
   * 获取任务详情 (签到/集赞)
   * GET /task/detail?taskType=SIGN_IN
   * 返回: { brief: { taskSpeType, status, ... }, detail: { ... } }
   */
  async getTaskDetail(taskType) {
    return await this.taskCenter.get('/task/detail', { params: { taskType } });
  }

  /**
   * 完成任务 (带token!)
   * POST /task/complete { taskSpeType, token }
   * 
   * 对于 simpleJudge=true 的任务:
   *   状态 Todo → Award (标记为已完成, 可领奖)
   * 对于签到:
   *   直接完成并获得积分
   */
  async completeTask(taskSpeType, token = '') {
    const data = { taskSpeType };
    if (token) data.token = token;
    return await this.taskCenter.post('/task/complete', data);
  }

  /**
   * 领取任务奖励 (带token!)
   * POST /task/reward { taskSpeType, token }
   * 状态 Award → Done + 发放积分
   * 
   * 集赞任务特殊: 前端使用 taskType:"COLLECT_LIKE" (非taskSpeType)
   * 即 collectLikeReward() 方法
   */
  async rewardTask(taskSpeType, token) {
    return await this.taskCenter.post('/task/reward', { taskSpeType, token });
  }

  /**
   * 领取集赞墙奖励 (前端逆向: collectLike action)
   * POST /task/reward { taskType: "COLLECT_LIKE" }
   * 
   * 前端代码: jh = Sp("likeCollect/collectLike", ...)
   * 仅当集赞进度达到 total 时才能领取
   */
  async collectLikeReward() {
    return await this.taskCenter.post('/task/reward', { taskType: 'COLLECT_LIKE' });
  }

  /**
   * 认领任务 (dex逆向发现)
   * POST /task/claim { taskSpeType, token }
   * 返回 200 DONE (但集赞进度未推进, 需原生桥OPERATE_POINTS_CENTER_TASK)
   */
  async claimTask(taskSpeType, token) {
    return await this.taskCenter.post('/task/claim', { taskSpeType, token });
  }

  /**
   * 确认任务 (带token)
   * POST /task/confirm { taskSpeType, token }
   * 状态 NeedConfirm → Done + 发放积分
   */
  async confirmTask(taskSpeType, token) {
    return await this.taskCenter.post('/task/confirm', { taskSpeType, token });
  }

  /**
   * 设置签到通知
   * POST /sign-in/notification { enable }
   */
  async setSignInNotification(enable) {
    return await this.taskCenter.post('/sign-in/notification', { enable });
  }

  /**
   * 补签
   * POST /sign-in/late { date }
   */
  async signInLate(date) {
    return await this.taskCenter.post('/sign-in/late', { date });
  }

  /**
   * 查询视频广告任务状态
   * GET /task/reward-ad/status?token=xxx
   * 返回: { status, taskInfo: { token, taskSpeType, needAutoReward } }
   * 
   * needAutoReward=true: 广告完成后服务器自动发奖, 无需手动领取
   * status: Todo(未完成) → Award/Done(已完成, 自动发奖)
   */
  async getRewardAdStatus(token) {
    return await this.taskCenter.get('/task/reward-ad/status', { params: { token } });
  }

  // ============ 积分服务 API ============

  async getScore() {
    return await this.mailScore.get('/score');
  }

  async getScoreRecordList(limit = 20, offset = '') {
    const params = { limit };
    if (offset) params.offset = offset;
    return await this.mailScore.get('/score/record/list', { params });
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
    this.totalReward = 0;
  }

  record(task, success, detail = '') {
    this.results.push({ task, success, detail });
    log(`${success ? '✅' : '❌'} [${this.accountName}] ${task}: ${detail}`);
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

    // 3. 获取任务列表并自动完成+领奖
    await this.doCompleteAndRewardTasks();

    // 4. 自动完成interaction任务(点赞/集赞子任务)
    await this.doInteractionTasks();

    // 5. 视频广告状态检测
    await this.doVideoAdCheck();

    // 6. 集赞任务进度
    await this.doCollectLikeProgress();

    // 7. 签到提醒
    await this.doEnableNotify();

    // 8. 补签 (如果配置了)
    await this.doSignLate();

    // 9. 查询最终积分
    await this.getScoreInfo(true);

    // 10. 查询积分记录
    await this.doGetScoreRecord();

    return this.generateReport();
  }

  async getScoreInfo(isAfter = false) {
    try {
      const result = await this.client.getScore();
      const score = result?.score ?? 0;
      if (!isAfter) {
        this.scoreBefore = score;
        log(`💰 当前积分: ${score}`);
      } else {
        this.scoreAfter = score;
        const diff = score - this.scoreBefore;
        log(`💰 最终积分: ${score} (本次获取 ${diff} 积分)`);
      }
      this.record('查询积分', true, `积分: ${score}`);
    } catch (e) {
      this.record('查询积分', false, e.message);
    }
  }

  async doSignIn() {
    try {
      const detail = await this.client.getTaskDetail('SIGN_IN');
      const brief = detail?.brief;
      if (!brief) {
        this.record('每日签到', false, '获取签到详情失败');
        return;
      }

      if (brief.status === 'Done') {
        this.record('每日签到', true, '今日已签到');
        return;
      }

      // 签到不需要token
      const taskSpeType = brief.taskSpeType;
      const result = await this.client.completeTask(taskSpeType);
      const rewardValue = result?.rewarded?.value ?? result?.reward?.value ?? '?';
      const rewardDesc = getLocalizedText(result?.rewarded?.desc?.tips) || `${rewardValue} 积分`;
      this.record('每日签到', true, `签到成功! 获得 ${rewardDesc}`);
      this.totalReward += parseInt(rewardValue) || 0;
    } catch (e) {
      if (e.apiDesc && (e.apiDesc.includes('已签') || e.apiDesc.includes('DONE'))) {
        this.record('每日签到', true, '今日已签到');
      } else {
        this.record('每日签到', false, e.message);
      }
    }
  }

  async doCompleteAndRewardTasks() {
    try {
      const result = await this.client.getTaskList('ScoreCenter');
      const tasks = result?.list ?? [];
      
      if (tasks.length === 0) {
        this.record('任务列表', true, '暂无任务');
        return;
      }

      const done = tasks.filter(t => t.status === 'Done');
      const pending = tasks.filter(t => t.status !== 'Done');
      
      log(`📋 共${tasks.length}个任务, 已完成${done.length}个, 待处理${pending.length}个`);

      let completedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (const task of pending) {
        const title = getLocalizedText(task.title);
        const taskSpeType = task.taskSpeType;
        const token = task.token;
        const reward = task.reward?.value || '?';
        const status = task.status;

        if (!token) {
          log(`  ⏭️ 跳过 [${title}]: 无token`);
          skippedCount++;
          continue;
        }

        try {
          let currentStatus = status;

          // 步骤1: 如果是 Todo/Init 状态, 先 complete
          if (currentStatus === 'Todo' || currentStatus === 'Init') {
            try {
              const completeResult = await this.client.completeTask(taskSpeType, token);
              currentStatus = completeResult?.status || 'Award';
              log(`  📝 [${title}] complete → ${currentStatus}`);
            } catch (e) {
              if (e.apiDesc === 'ACCESS_DENIED') {
                // 该任务无法通过API完成 (如观看视频广告、开通会员)
                log(`  ⏭️ [${title}] 无法通过API完成 (${e.apiDesc})`);
                skippedCount++;
                continue;
              }
              throw e;
            }
            await new Promise(r => setTimeout(r, 500));
          }

          // 步骤2: 如果是 Award 状态, 领取奖励
          if (currentStatus === 'Award') {
            const rewardResult = await this.client.rewardTask(taskSpeType, token);
            const points = rewardResult?.rewarded?.value || 0;
            const tips = getLocalizedText(rewardResult?.rewarded?.desc?.tips) || `${points} 积分`;
            log(`  🎁 [${title}] 领取成功! +${tips}`);
            this.totalReward += parseInt(points) || 0;
            completedCount++;
          }
          // 步骤3: 如果是 NeedConfirm 状态, 确认领奖
          else if (currentStatus === 'NeedConfirm') {
            const confirmResult = await this.client.confirmTask(taskSpeType, token);
            const points = confirmResult?.rewarded?.value || 0;
            const tips = getLocalizedText(confirmResult?.rewarded?.desc?.tips) || `${points} 积分`;
            log(`  🎁 [${title}] 确认成功! +${tips}`);
            this.totalReward += parseInt(points) || 0;
            completedCount++;
          }
          else if (currentStatus === 'Done') {
            log(`  ✅ [${title}] 已完成`);
          }
        } catch (e) {
          log(`  ❌ [${title}] 失败: ${e.message}`);
          failedCount++;
        }

        await new Promise(r => setTimeout(r, 500));
      }

      this.record('自动任务', true, 
        `完成${completedCount}个, 失败${failedCount}个, 跳过${skippedCount}个, 获取${this.totalReward}积分`);
    } catch (e) {
      this.record('自动任务', false, e.message);
    }
  }

  async doInteractionTasks() {
    try {
      // 获取interaction类型任务(点赞/集赞子任务)
      const result = await this.client.getTaskList('ScoreCenter', {
        includeViewTypes: ['interaction'],
      });
      const tasks = result?.list ?? [];

      if (tasks.length === 0) {
        this.record('点赞任务', true, '暂无点赞任务');
        return;
      }

      let completedCount = 0;
      let pendingCount = 0;

      for (const task of tasks) {
        const title = getLocalizedText(task.title);
        const taskSpeType = task.taskSpeType;
        const token = task.token;
        const reward = task.reward?.value || '?';

        if (task.status === 'Done') {
          log(`  ✅ [${title}] 已完成`);
          continue;
        }

        if (!task.simpleJudge || !token) {
          log(`  ⏭️ [${title}] 无法自动完成 (simpleJudge=${task.simpleJudge})`);
          pendingCount++;
          continue;
        }

        try {
          // iOS端只需点击返回即完成任务
          // API层直接 complete + reward 即可
          const completeResult = await this.client.completeTask(taskSpeType, token);
          const currentStatus = completeResult?.status || 'Award';

          if (currentStatus === 'Award') {
            const rewardResult = await this.client.rewardTask(taskSpeType, token);
            const points = rewardResult?.rewarded?.value || 0;
            const tips = getLocalizedText(rewardResult?.rewarded?.desc?.tips) || `${points} 积分`;
            log(`  🎁 [${title}] 领取成功! +${tips}`);
            this.totalReward += parseInt(points) || 0;
            completedCount++;
          }
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          log(`  ❌ [${title}] 失败: ${e.message}`);
          pendingCount++;
        }
      }

      this.record('点赞任务', true,
        `共${tasks.length}个, 完成${completedCount}个${pendingCount > 0 ? `, 待处理${pendingCount}个` : ''}`);
    } catch (e) {
      this.record('点赞任务', false, e.message);
    }
  }

  async doVideoAdCheck() {
    try {
      // 获取普通任务列表中的视频广告任务
      const result = await this.client.getTaskList('ScoreCenter');
      const tasks = result?.list ?? [];
      const videoTask = tasks.find(t => t.taskSpeType === 'reward_ad#1');

      if (!videoTask) {
        this.record('视频广告', true, '无视频广告任务');
        return;
      }

      if (videoTask.status === 'Done') {
        this.record('视频广告', true, '已完成');
        return;
      }

      // 查询广告状态
      const token = videoTask.token;
      const adStatus = await this.client.getRewardAdStatus(token);
      const status = adStatus?.status;
      const needAutoReward = adStatus?.taskInfo?.needAutoReward;
      const subtitle = getLocalizedText(videoTask.subtitle) || '';

      if (status === 'Todo') {
        // 广告未完成, 需要在App内观看
        this.record('视频广告', true,
          `待完成 (需App内观看广告, ${subtitle}) needAutoReward=${needAutoReward}`);
      } else if (status === 'Award' || status === 'Done') {
        // 广告已完成, needAutoReward=true 时服务器自动发奖
        this.record('视频广告', true,
          `广告已完成! 状态:${status} ${needAutoReward ? '(积分已自动发放)' : '(需手动领取)'}`);
      } else {
        this.record('视频广告', true, `状态: ${status}`);
      }
    } catch (e) {
      this.record('视频广告', false, e.message);
    }
  }

  async doCollectLikeProgress() {
    try {
      // 前端逆向: GET /task/detail?taskType=COLLECT_LIKE
      const detail = await this.client.getTaskDetail('COLLECT_LIKE');
      const brief = detail?.brief;
      const likeDetail = detail?.detail;

      if (!brief) {
        this.record('集赞任务', true, '暂无集赞任务');
        return;
      }

      const complete = likeDetail?.complete ?? 0;
      const total = likeDetail?.total ?? 0;
      const reward = brief.reward?.value || '?';
      const status = brief.status;

      if (status === 'Done') {
        this.record('集赞任务', true, `已完成 (${complete}/${total}, 奖励${reward}积分)`);
        return;
      }

      // 尝试领取奖励(如果进度已满)
      if (complete >= total) {
        try {
          // 前端逆向: POST /task/reward { taskType: "COLLECT_LIKE" }
          const rewardResult = await this.client.collectLikeReward();
          const points = rewardResult?.rewarded?.value || 0;
          this.record('集赞任务', true,
            `进度已满 ${complete}/${total}! 领取成功 +${points}积分`);
          this.totalReward += parseInt(points) || 0;
          return;
        } catch (e) {
          log(`  ⚠️ 集赞奖励领取失败: ${e.message}`);
        }
      }

      // 集赞进度未满 - 尝试通过 /task/claim 推进
      // 注意: 经深度逆向分析, 集赞进度的推进机制如下:
      // 1. 前端调用 operateTask → 原生桥 OPERATE_POINTS_CENTER_TASK
      // 2. 原生桥打开小红书(REDnote) app
      // 3. 用户返回后原生桥触发 OPERATE_POINTS_CENTER_TASK_COMPLETION
      // 4. 服务端在原生桥完成时内部推进集赞进度
      // 5. 前端JS仅包含4个HTTP API: /task/complete, /task/detail, /task/list, /task/reward
      // 6. 无任何HTTP API可直接推进集赞进度
      // 7. /task/claim 端点存在但返回DONE不推进进度
      // 结论: 集赞进度推进必须通过原生桥, HTTP API无法替代
      if (complete < total) {
        // 尝试 /task/claim (虽然逆向分析表明不会推进进度)
        try {
          await this.client.claimTask(brief.taskSpeType, brief.token);
        } catch (e) {
          // 忽略错误
        }

        // 再次检查进度是否有变化
        const detailAfter = await this.client.getTaskDetail('COLLECT_LIKE');
        const completeAfter = detailAfter?.detail?.complete ?? 0;
        const remaining = total - completeAfter;

        if (completeAfter > complete) {
          this.record('集赞任务', true,
            `进度推进: ${completeAfter}/${total} (还需${remaining}个赞, 奖励${reward}积分)`);
        } else {
          this.record('集赞任务', true,
            `进度: ${completeAfter}/${total} (还需${remaining}个赞, 奖励${reward}积分)`);
          log(`  ℹ️ 集赞进度需通过APP内完成点赞任务推进(原生桥), API无法直接推进`);
        }
      }
    } catch (e) {
      this.record('集赞任务', false, e.message);
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
      await this.client.signInLate(date);
      this.record('补签', true, `补签日期 ${date} 成功`);
    } catch (e) {
      this.record('补签', false, `补签日期 ${date} 失败: ${e.message}`);
    }
  }

  async doGetScoreRecord() {
    try {
      const result = await this.client.getScoreRecordList(10);
      const records = result?.list ?? [];
      if (records.length === 0) {
        this.record('积分记录', true, '暂无积分记录');
        return;
      }

      const recent = records.slice(0, 5).map(r => {
        const title = getLocalizedText(r.title) || getLocalizedText(r.name) || 
                       r.desc || r.reason || '未知';
        const score = r.score ?? r.value ?? r.amount ?? 0;
        return `${title}: ${score}`;
      }).join(', ');
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
    report += `积分变化: ${this.scoreBefore} → ${this.scoreAfter} (+${scoreDiff}积分)\n`;
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

    if (accounts.length > 1) {
      log('\n⏳ 等待 5 秒后处理下一个账号...\n');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  const summary = allReports.join('\n');
  log(summary);

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
