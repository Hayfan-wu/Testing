#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
名称: 百度网盘每日任务
功能: 自动完成百度网盘会员签到、每日答题、积分任务上报、宝箱领取及状态查询
作者: TRAE
日期: 2026-07-31

cron: 15 0 * * *   # 00:15 完成任务
cron2: 0 8 * * *   # 08:00 兑换物品
new Env('百度网盘每日任务');

============================== 环境变量 ==============================
BAIDU_COOKIE  百度网盘 Cookie，多账号用换行 \n 分隔。
              每行格式: BDUSS=xxxxxx; STOKEN=xxxxxx;
              (必填)

BAIDU_DEVICE  (可选) 设备参数，多账号用换行分隔，每行格式:
              cuid,devuid,idfa,idfv
              留空则按账号自动生成稳定设备指纹(读取接口已验证可用任意值)。

BAIDU_NOTIFY   (可选) 通知开关，留空或 true 为开启，false 为关闭。

BAIDU_BOX_ROUNDS (可选) 宝箱领取轮数，默认 0(跳过)，范围 0-10。
                  宝箱是任务中心右侧悬浮礼物盒，等倒计时结束领5积分。
                  每轮需驱动倒计时(约1-8分钟)，非常耗时。
                  如需领取建议设 1-3，设 0 跳过。

BAIDU_TASK_SAVE (可选) 任务上报与领奖开关，默认 true。
                 通过 tasksave 上报任务完成状态(标记为"已上报")，
                 再尝试 antisave(clienttype=0) 领取积分奖励。
                 注意: antisave 受HTJ反作弊保护，脚本尽力尝试，
                 部分任务可成功领取，其余需在App端手动完成。

BAIDU_EXCHANGE_ENABLED (可选) 积分自动兑换开关，默认 false。
                 开启后会在每日任务完成后，自动查询积分商城商品列表，
                 并根据 BAIDU_EXCHANGE_ITEMS 匹配商品进行兑换。
                 兑换使用百度网盘积分(任务中心积分)，与Comate平台积分独立。

BAIDU_EXCHANGE_ITEMS (可选) 要兑换的商品关键词，多个用逗号分隔。
                 脚本会匹配商品名称中包含的关键词进行兑换。
                 例如: "小度,京东E卡,30元,话费"
                 注意: 实际可兑换商品以积分商城显示为准。

BAIDU_MODE (可选) 运行模式，默认 task。
                 task: 完成任务模式(00:15执行)
                 exchange: 兑换物品模式(08:00执行，极速模式，跳过所有任务步骤)
                 也可通过命令行参数指定: task baidu_netdisk_task.py exchange

============================== 获取 Cookie ==============================
1. 浏览器登录百度网盘网页版 https://pan.baidu.com
2. F12 -> Application/应用 -> Cookies -> pan.baidu.com
3. 复制 BDUSS 和 STOKEN 两个值
4. 拼接为: BDUSS=你的值; STOKEN=你的值;
5. 填入青龙环境变量 BAIDU_COOKIE

============================== 已验证接口情况 ==============================
【确认可用 - 积分/成长值奖励】
  - GET /rest/2.0/membership/level?method=signin   会员成长值签到(每日+1成长值)
  - GET /rest/2.0/membership/level?method=query    查询会员等级/成长值
  - GET /coins/taskcenter/home                     查询积分余额
  - GET /coins/taskcenter/signinlist               查询签到状态
  - GET /coins/taskcenter/tasklist                 查询任务列表
  - GET /coins/center/boxinfo                      查询宝箱状态(需 ptype=5)
  - GET /coins/center/boxreport                    推进宝箱倒计时(模拟App心跳)
  - GET /coins/center/boxaward                     领取宝箱(需 ptype=5，实测+5积分)
  - GET /act/v2/membergrowv2/getdailyquestion      获取每日答题
  - GET /act/v2/membergrowv2/answerquestion        提交每日答题(答对+3成长值)
  - GET /api/loginstatus                           获取用户UK(用于tasksave)
  - GET /api/taskscore/tasksave                    上报任务完成(token=MD5(id_uk_rand_time_secret))
    覆盖所有非SVIP任务，将任务标记为"已上报"(status=6)，等待领取积分。

【尽力而为 - antisave 任务领奖】
  - GET /api/taskscore/antisave                    任务奖励领取
    使用 clienttype=0(Web) 绕过HTJ检查。
    注意: 大部分任务受HTJ反作弊保护，Python脚本无法完全绕过。
    已上报任务的积分需在App端「任务中心」手动领取。

【尽力而为 - 积分签到】
  - GET /coins/taskcenter/signin                   积分任务中心签到
    (接口返回 param error 原因待查，已签状态以 signinlist 为准)

=====================================================================
"""

import os
import sys
import time
import random
import hashlib
import requests

# tasksave token 密钥(从JS逆向获取)
_TASKSAVE_SECRET = "ae82c240578eb391de93c2f4c3dfc3ba"

# ---------------------- 通知模块（兼容青龙） ----------------------
try:
    from notify import send as _ql_notify
    def notify(title, content):
        try:
            _ql_notify(title, content)
        except Exception:
            pass
except Exception:
    def notify(title, content):
        pass


# ---------------------- 工具函数 ----------------------
def rand_hex(n=40):
    return "".join(random.choices("0123456789abcdef", k=n))


def gen_device(bduss):
    """根据 BDUSS 生成稳定的设备指纹(读取接口已验证可用任意值)。"""
    h = hashlib.md5(bduss.encode()).hexdigest()
    cuid = h[:24].upper() + "FFSAGLFNHPQ"
    devuid = hashlib.sha1(bduss.encode()).hexdigest()
    idfa = "%s-%s-%s-%s-%s" % (h[0:8], h[8:12], h[12:16], h[16:20], h[20:32].upper())
    idfv = "%s-%s-%s-%s-%s" % (h[2:10], h[10:14], h[14:18], h[18:22], h[22:34].upper())
    return cuid, devuid, idfa, idfv


def parse_cookies(env_str):
    """解析 BAIDU_COOKIE，多账号按换行分隔。"""
    if not env_str:
        return []
    lines = [l.strip() for l in env_str.replace("\\n", "\n").split("\n") if l.strip()]
    cookies = []
    for line in lines:
        bduss = ""
        stoken = ""
        for part in line.split(";"):
            part = part.strip()
            if part.upper().startswith("BDUSS="):
                bduss = part.split("=", 1)[1].strip()
            elif part.upper().startswith("STOKEN="):
                stoken = part.split("=", 1)[1].strip()
        if bduss:
            cookies.append({"BDUSS": bduss, "STOKEN": stoken})
    return cookies


def parse_devices(env_str, count):
    """解析 BAIDU_DEVICE，多账号按换行分隔，每行 cuid,devuid,idfa,idfv。"""
    devs = []
    if env_str:
        lines = [l.strip() for l in env_str.replace("\\n", "\n").split("\n") if l.strip()]
        for line in lines:
            parts = [p.strip() for p in line.split(",")]
            while len(parts) < 4:
                parts.append("")
            devs.append({"cuid": parts[0], "devuid": parts[1], "idfa": parts[2], "idfv": parts[3]})
    while len(devs) < count:
        devs.append(None)
    return devs


class BaiduNetdisk:
    """百度网盘任务自动化。"""

    UA_IOS = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
              "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148;"
              "netdisk;13.29.6;iPhone14ProMax;ios-iphone;26.5;zh_CN;JSbridge4.4.2;jointBridge;1.1.0;")
    UA_WEB = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36")
    REFERER = "https://pan.baidu.com/operation/activitys/taskSystem/main?executerefresh=1&na_immerse_theme=1&from=myrightcard"

    def __init__(self, bduss, stoken, device=None):
        self.bduss = bduss
        self.stoken = stoken
        self.cookie = "BDUSS=%s; STOKEN=%s;" % (bduss, stoken)
        if device and device.get("cuid"):
            self.cuid = device["cuid"]
            self.devuid = device["devuid"]
            self.idfa = device["idfa"]
            self.idfv = device["idfv"]
        else:
            c, d, i, v = gen_device(bduss)
            self.cuid, self.devuid, self.idfa, self.idfv = c, d, i, v
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": self.UA_IOS})
        self.nickname = "账号%s" % bduss[:6]
        self.uk = ""  # 用户UK，从 /api/loginstatus 获取
        self.results = []  # [(任务名, 状态, 详情)]

    # ---------- 通用请求 ----------
    def _coins_params(self, extra=None):
        """积分任务中心接口通用参数(已验证: 无需 z 签名, 需 cuid/devuid/clienttype/time/rand)。"""
        p = {
            "version": "13.29.6",
            "channel": "iPhone_26.5_iPhone14ProMax_chunlei_1099a_3g",
            "app": "ios",
            "clienttype": "1",
            "caller": "4012",
            "aid": "1002",
            "lang": "zh-CN",
            "themeinfo": "0",
            "cuid": self.cuid,
            "devuid": self.devuid,
            "idfa": self.idfa,
            "idfv": self.idfv,
            "rand": rand_hex(),
            "rand2": rand_hex(),
            "time": str(int(time.time())),
        }
        if extra:
            p.update(extra)
        return p

    def _coins_get(self, path, extra=None):
        url = "https://pan.baidu.com" + path
        headers = {"Referer": self.REFERER, "Cookie": self.cookie}
        try:
            r = self.session.get(url, params=self._coins_params(extra), headers=headers, timeout=20)
            return r.json()
        except Exception as e:
            return {"errno": -1, "error": str(e)}

    def _membership_get(self, method):
        """会员成长值接口(已验证: 仅需 Cookie, 无需设备参数/z)。"""
        url = "https://pan.baidu.com/rest/2.0/membership/level"
        params = {"app_id": "250528", "web": "5", "method": method}
        headers = {"User-Agent": self.UA_WEB, "Referer": "https://pan.baidu.com/", "Cookie": self.cookie}
        try:
            r = self.session.get(url, params=params, headers=headers, timeout=20)
            return r.json()
        except Exception as e:
            return {"error_code": -1, "error_msg": str(e)}

    def _get_uk(self):
        """从 /api/loginstatus 获取用户UK(用于 tasksave token 计算)。"""
        data = self._coins_get("/api/loginstatus")
        if data.get("errno") == 0:
            info = data.get("login_info", {})
            self.uk = str(info.get("uk", ""))
            self.nickname = info.get("username", self.nickname)
            return self.uk
        return ""

    @staticmethod
    def _compute_token(task_id, uk, rand_val, time_val):
        """计算 tasksave 接口的 token (MD5(task_id_uk_rand_time_secret))。"""
        raw = "%s_%s_%s_%s_%s" % (task_id, uk, rand_val, time_val, _TASKSAVE_SECRET)
        return hashlib.md5(raw.encode()).hexdigest()

    def _tasksave(self, task):
        """上报单个任务完成状态(tasksave 接口)。

        返回 (errno, addScore, msg) 元组。
        注意: tasksave 仅标记任务为"已上报"，不直接发放积分。
        积分领取需通过 antisave 接口(受HTJ反作弊保护，脚本无法绕过)。
        """
        task_id = task.get("task_id_str", "")
        task_from = task.get("task_from", "")
        if not task_id or not self.uk:
            return -1, 0, "缺少 task_id 或 uk"
        rand_val = rand_hex()
        time_val = str(int(time.time()))
        token = self._compute_token(task_id, self.uk, rand_val, time_val)
        params = self._coins_params({
            "task_id": task_id,
            "task_from": task_from,
            "uk": self.uk,
            "rand": rand_val,
            "time": time_val,
            "token": token,
        })
        url = "https://pan.baidu.com/api/taskscore/tasksave"
        headers = {"Referer": self.REFERER, "Cookie": self.cookie}
        try:
            r = self.session.get(url, params=params, headers=headers, timeout=20)
            resp = r.json()
            result = resp.get("result", {}) or {}
            return resp.get("errno", -1), result.get("addScore", 0), resp.get("show_msg", "")
        except Exception as e:
            return -1, 0, str(e)

    def _antisave(self, task, clienttype="0"):
        """尝试领取任务奖励(antisave 接口)。

        支持指定 clienttype 参数:
        - "0": Web 客户端(绕过HTJ检查)
        - "1": iOS 客户端(原生App方式)
        返回 (errno, addScore, msg) 元组。
        注意: 受HTJ反作弊保护，大部分任务需App端手动领取。
        """
        task_id = task.get("task_id_str", "")
        task_from = task.get("task_from", "")
        if not task_id or not self.uk:
            return -1, 0, "缺少 task_id 或 uk"
        rand_val = rand_hex()
        time_val = str(int(time.time()))
        token = self._compute_token(task_id, self.uk, rand_val, time_val)
        params = self._coins_params({
            "task_id": task_id,
            "task_from": task_from,
            "uk": self.uk,
            "rand": rand_val,
            "time": time_val,
            "token": token,
        })
        params["clienttype"] = clienttype
        url = "https://pan.baidu.com/api/taskscore/antisave"
        ua = self.UA_WEB if clienttype == "0" else self.UA_IOS
        headers = {"Referer": self.REFERER, "Cookie": self.cookie,
                   "User-Agent": ua}
        try:
            r = self.session.get(url, params=params, headers=headers, timeout=20)
            resp = r.json()
            result = resp.get("result", {}) or {}
            return resp.get("errno", -1), result.get("addScore", 0), resp.get("show_msg", "")
        except Exception as e:
            return -1, 0, str(e)

    # ---------- 鉴权校验 ----------
    def check_login(self):
        data = self._membership_get("query")
        if data.get("error_code") == 0:
            d = data.get("data", {})
            self.nickname = "Lv%s会员" % d.get("current_level", "?")
            # 同时获取 UK
            self._get_uk()
            return True
        return False

    # ---------- 1. 会员成长值签到(确认可用) ----------
    def membership_signin(self):
        data = self._membership_get("signin")
        code = data.get("error_code", -1)
        msg = data.get("error_msg", "")
        if code == 0:
            self.results.append(("会员成长值签到", "成功", "签到成功，成长值+1"))
        elif code == 421003 or "not allow" in str(msg).lower():
            self.results.append(("会员成长值签到", "已签", "今日已签到"))
        elif code == -6 or "bduss" in str(msg).lower():
            self.results.append(("会员成长值签到", "失败", "Cookie 失效(errorno -6)，请更新 BDUSS/STOKEN"))
        else:
            self.results.append(("会员成长值签到", "失败", "code=%s msg=%s" % (code, msg)))
        # 查询签到后成长值
        q = self._membership_get("query")
        if q.get("error_code") == 0:
            d = q.get("data", {})
            self.results.append(("会员等级查询", "信息", "等级 Lv%s 成长值 %s" % (d.get("current_level"), d.get("current_value"))))

    # ---------- 2. 每日答题(确认可用, +3成长值) ----------
    def daily_question(self):
        """获取并回答每日答题(API直接返回正确答案)。"""
        # 获取题目
        qdata = self._coins_get("/act/v2/membergrowv2/getdailyquestion")
        if qdata.get("errno") != 0:
            self.results.append(("每日答题", "失败", "获取题目失败: %s" % qdata.get("show_msg", "未知错误")))
            return
        q = qdata.get("data", {})
        ask_id = q.get("ask_id")
        answer = q.get("answer")
        status = q.get("answer_status", -1)
        score = q.get("score", 0)
        question = q.get("question", "")
        if status == 1:
            self.results.append(("每日答题", "已答", "今日已答题(+%s成长值)" % score))
            return
        if not ask_id or answer is None:
            self.results.append(("每日答题", "跳过", "无可用题目"))
            return
        # 提交答案
        adata = self._coins_get("/act/v2/membergrowv2/answerquestion", {
            "ask_id": str(ask_id), "answer": str(answer)})
        if adata.get("errno") == 0:
            a_status = adata.get("data", {}).get("answer_status", 0)
            if a_status == 1:
                self.results.append(("每日答题", "成功", "答对「%s」(+%s成长值)" % (question[:15], score)))
            else:
                self.results.append(("每日答题", "成功", "已提交答案(status=%s)" % a_status))
        else:
            self.results.append(("每日答题", "失败", "errno=%s %s" % (adata.get("errno"), adata.get("show_msg", ""))))

    # ---------- 3. 积分任务中心签到 ----------
    def coins_signin(self):
        """积分任务中心签到。

        接口返回 param error 有两种可能:
        1. 今日已签到 (signed_today=1 时正常现象)
        2. 参数确实有误 (未签到时返回 param error)
        因此先查签到状态，已签则直接返回，未签再尝试签到。
        """
        # 先查签到状态
        sdata = self._coins_get("/coins/taskcenter/signinlist")
        if sdata.get("errno") == 0:
            d = sdata.get("data", {})
            signed = d.get("signed_today", 0)
            days = d.get("signin_days", 0)
            self.results.append(("签到状态查询", "信息", "已连签 %s 天，今日%s" % (days, "已签" if signed else "未签")))
            if signed:
                self.results.append(("积分任务中心签到", "已签", "今日已签到"))
                # 尝试领取签到奖励(如果有的话)
                self._try_signin_award(d)
                return
        else:
            self.results.append(("签到状态查询", "失败", sdata.get("error", "未知错误")))

        # 未签到，尝试签到
        rdata = self._coins_get("/coins/taskcenter/signin",
                                {"task_from": "task_sys_daily", "ptype": "5"})
        code = rdata.get("errno", -1)
        err = rdata.get("error", "")
        if code == 0:
            self.results.append(("积分任务中心签到", "成功", "签到成功"))
        elif code == 2:
            # param error 可能是接口参数不对，也可能是已签
            self.results.append(("积分任务中心签到", "待核实", "返回 param error(请在App端确认签到状态)"))
        else:
            self.results.append(("积分任务中心签到", "失败", "errno=%s error=%s" % (code, err)))

    def _try_signin_award(self, signin_data):
        """尝试领取签到奖励(连签奖励等)。"""
        reward_list = signin_data.get("reward_list", [])
        if not reward_list:
            return
        # 检查有没有可领取的奖励
        claimable = 0
        for r in reward_list:
            if r.get("received") == 0 and r.get("signed") == 1:
                claimable += 1
        if claimable > 0:
            # 尝试领取(参数可能不对，尽力而为)
            adata = self._coins_get("/coins/taskcenter/signinaward", {"ptype": "5"})
            if adata.get("errno") == 0:
                self.results.append(("签到奖励领取", "成功", "领取成功"))
            # 失败就不提示了，避免噪音

    # ---------- 4. 积分余额与任务列表(确认可用) ----------
    def coins_status(self):
        # 积分余额
        hdata = self._coins_get("/coins/taskcenter/home", {"go_home": "1", "ptype": "5"})
        if hdata.get("errno") == 0:
            pts = hdata.get("data", {}).get("points_balance", "?")
            self.results.append(("积分余额查询", "信息", "当前积分 %s" % pts))

    # ---------- 5. 任务上报与领奖(tasksave + antisave) ----------
    def coins_tasks(self):
        """通过 tasksave 上报任务，再尝试 antisave 领取积分奖励。

        流程:
        1. 获取任务列表(带重试)
        2. 统计任务状态，识别多次完成任务的进度
        3. tasksave 上报所有未完成任务(支持多次完成任务的循环上报)
        4. 重新获取任务列表获取最新状态
        5. antisave 尝试领取积分(多种clienttype)
        6. 查询领奖后积分余额
        """
        # ---------- 1. 获取任务列表(带重试) ----------
        tdata = None
        for attempt in range(3):
            tdata = self._coins_get("/coins/taskcenter/tasklist", {
                "task_from": "task_sys_beginner task_sys_daily task_sys_space task_sys_ai task_sys_function task_sys_growth"})
            if tdata.get("errno") == 0:
                if attempt > 0:
                    self.results.append(("任务列表查询", "成功", "重试后获取成功"))
                break
            if attempt < 2:
                delay = (attempt + 1) * 3
                self.results.append(("任务列表查询", "重试", "第%s次失败(%s)，%s秒后重试" %
                                     (attempt + 1, tdata.get("error", "未知错误"), delay)))
                time.sleep(delay)

        errno = tdata.get("errno", -1) if tdata else -1
        if errno != 0:
            self.results.append(("任务列表查询", "失败", "重试3次均失败: %s" %
                                 (tdata.get("error", "无响应") if tdata else "无法连接")))
            return

        tasks = tdata.get("result", {}).get("list", [])
        if not tasks:
            self.results.append(("任务列表查询", "信息", "无任务"))
            return

        # ---------- 2. 统计任务状态 ----------
        done = 0          # status==1 (已完成)
        reported = 0      # status==6 (已上报待领奖)
        not_started = 0   # status==0 (未开始)
        svip_skip = 0     # SVIP任务跳过
        total_score_done = 0
        total_score_reported = 0
        partial_tasks = []   # 部分完成的任务(finish_count < count_max)
        video_task_info = None
        multi_need_tasks = []  # 需要多次完成的任务

        for t in tasks:
            status = t.get("task_status", 0)
            ttype = t.get("task_type", "")
            score = t.get("task_score", 0) or 0
            finish_count = t.get("task_finish_count", 0)
            count_max = t.get("task_count_max", 1)

            # 视频任务特殊处理
            if ttype == "70":
                video_task_info = (finish_count, count_max, score)

            if status == 1:
                done += 1
                total_score_done += score
            elif status == 6:
                reported += 1
                total_score_reported += score
                if finish_count < count_max:
                    partial_tasks.append(t)  # 已上报但未完成全部次数
            elif status == 0:
                if ttype == "114":
                    svip_skip += 1
                else:
                    not_started += 1
                    if count_max > 1:
                        multi_need_tasks.append(t)  # 多次完成但还未开始
            else:
                done += 1
                total_score_done += score

        # 输出统计信息
        info_parts = ["共%s个" % len(tasks)]
        if done > 0:
            info_parts.append("已完成%s(+%s分)" % (done, total_score_done))
        if reported > 0:
            info_parts.append("已上报%s(待领+%s分)" % (reported, total_score_reported))
        if not_started > 0:
            info_parts.append("未开始%s" % not_started)
        if svip_skip > 0:
            info_parts.append("SVIP跳过%s" % svip_skip)
        if partial_tasks:
            info_parts.append("部分完成%s" % len(partial_tasks))
        self.results.append(("任务列表查询", "信息", " ".join(info_parts)))

        # 视频任务提示
        if video_task_info:
            fc, cm, sc = video_task_info
            if fc < cm:
                self.results.append(("观看广告视频", "需手动", "已完成%s/%s次，需在App端看广告(每次+%s积分，剩余%s积分)" %
                                     (fc, cm, sc, (cm - fc) * sc)))

        # ---------- 3. 对所有未完成的任务调用 tasksave 上报 ----------
        # 修复: 不再只处理 status==0 的任务，而是检查 finish_count < count_max
        # 支持多次完成任务(如"去玩游戏合成3次")的循环上报
        saved = 0
        saved_score = 0
        failed = 0
        already_reported = 0
        partial_done = 0
        partial_remaining = 0

        for t in tasks:
            ttype = t.get("task_type", "")
            if ttype in ("114", "70"):
                continue

            finish_count = t.get("task_finish_count", 0)
            count_max = t.get("task_count_max", 1)

            if finish_count >= count_max:
                continue  # 已完成全部次数，跳过

            # 计算还需上报的次数
            needed = count_max - finish_count
            # 单次最多尝试3次，避免死循环(如视频任务需15次)
            needed = min(needed, 3)

            for i in range(needed):
                errno, add_score, msg = self._tasksave(t)
                if errno == 0:
                    saved += 1
                    saved_score += t.get("task_score", 0) or 0
                elif errno == 40003:
                    already_reported += 1
                    # 已上报过，说明此次调用未增加计数，继续尝试
                    time.sleep(0.5)
                    continue
                else:
                    failed += 1
                time.sleep(0.5)

            if needed > 0 and saved > 0:
                partial_done += 1
            elif needed > 0:
                partial_remaining += 1

        if saved > 0:
            self.results.append(("任务上报", "成功", "上报 %s 次(约+%s积分待领取)" % (saved, saved_score)))
        if already_reported > 0 and saved == 0:
            self.results.append(("任务上报", "信息", "%s 个任务已上报过，等待下次运行" % already_reported))
        if failed > 0:
            self.results.append(("任务上报", "失败", "%s 次上报失败" % failed))

        # 多次完成任务的进度提示
        if partial_tasks or multi_need_tasks:
            total_remaining = sum(
                t.get("task_count_max", 1) - t.get("task_finish_count", 0)
                for t in (partial_tasks + multi_need_tasks)
            )
            self.results.append(("任务进度", "提示", "%s 个任务需多次完成(共还需%s次)，请每天运行脚本，逐次推进" %
                                 (len(partial_tasks) + len(multi_need_tasks), total_remaining)))

        # ---------- 4. 重新获取任务列表(获取上报后的最新状态) ----------
        time.sleep(1)
        tdata2 = self._coins_get("/coins/taskcenter/tasklist", {
            "task_from": "task_sys_beginner task_sys_daily task_sys_space task_sys_ai task_sys_function task_sys_growth"})
        if tdata2.get("errno") == 0:
            tasks2 = tdata2.get("result", {}).get("list", [])
            if tasks2:
                tasks = tasks2  # 使用更新后的任务列表

        # ---------- 5. 对已上报(status=6)的任务尝试 antisave 领取积分 ----------
        claimed = 0
        total_score = 0
        already = 0
        htj_blocked = 0
        for t in tasks:
            status = t.get("task_status", 0)
            ttype = t.get("task_type", "")
            if ttype == "114":
                continue
            if status != 6:
                continue

            claimed_ok = False
            # 方式1: clienttype=0 (Web) 绕过HTJ
            errno, add_score, msg = self._antisave(t, clienttype="0")
            if errno == 0:
                if add_score > 0:
                    claimed += 1
                    total_score += add_score
                    claimed_ok = True
                else:
                    already += 1
                    claimed_ok = True
            elif errno in (8001, 8002):
                # HTJ拦截，尝试方式2: clienttype=1 (iOS原生)
                errno2, add_score2, msg2 = self._antisave(t, clienttype="1")
                if errno2 == 0 and add_score2 > 0:
                    claimed += 1
                    total_score += add_score2
                    claimed_ok = True
                elif errno2 in (8001, 8002):
                    htj_blocked += 1
                else:
                    already += 1
                    claimed_ok = True
            elif errno in (40003, 40004):
                already += 1
                claimed_ok = True
            else:
                # 其他错误，尝试clienttype=1
                errno2, add_score2, msg2 = self._antisave(t, clienttype="1")
                if errno2 == 0 and add_score2 > 0:
                    claimed += 1
                    total_score += add_score2
                else:
                    htj_blocked += 1
            time.sleep(0.5)

        if claimed > 0:
            self.results.append(("任务领奖", "尽力",
                                 "尝试领取 %s 个任务(接口返回+%s积分，但受HTJ反作弊限制，实际可能未到账)" %
                                 (claimed, total_score)))
        if already > 0:
            self.results.append(("任务领奖", "已领", "%s 个任务已领取过" % already))
        if htj_blocked > 0:
            self.results.append(("任务领奖", "受限", "%s 个任务需App端领取(HTJ反作弊)" % htj_blocked))
        if saved == 0 and claimed == 0 and failed == 0 and reported > 0:
            self.results.append(("任务领奖", "提示", "%s 个已上报任务待领取积分，请在App端「任务中心」手动领取" % reported))
        if saved == 0 and reported == 0 and not_started == 0:
            self.results.append(("任务处理", "信息", "今日所有可完成任务已处理完毕"))

        # ---------- 6. 领奖后查询积分余额 ----------
        hdata2 = self._coins_get("/coins/taskcenter/home", {"go_home": "1", "ptype": "5"})
        if hdata2.get("errno") == 0:
            pts2 = hdata2.get("data", {}).get("points_balance", "?")
            self.results.append(("领奖后积分", "信息", "当前积分 %s" % pts2))

    # ---------- 6. 宝箱领取(已验证可用) ----------
    # 机制: 宝箱倒计时需 App 主动发 boxreport 才会推进; 归零后 status=1 即可用
    #       boxaward(需 ptype=5) 领取, 每轮奖励积分(默认5)。共 total_box_round 轮。
    def _box_info(self):
        return self._coins_get("/coins/center/boxinfo", {"ptype": "5"})

    def _box_claim(self):
        # 领取宝箱(已验证: 必须带 ptype=5)
        return self._coins_get("/coins/center/boxaward", {"app": "ios", "ptype": "5"})

    def _box_tick(self):
        # 推进倒计时(模拟 App 心跳)
        return self._coins_get("/coins/center/boxreport",
                               {"app": "ios", "ptype": "5", "task_center_report": "0", "newbie_countdown": "0"})

    def coins_box(self, max_rounds=3):
        """宝箱领取。

        机制: 宝箱倒计时需主动调用 boxreport 才会推进；归零后 status=1 即可用。
              boxaward(需 ptype=5) 领取，每轮奖励积分(默认5)。
              共 total_box_round 轮，默认最多领3轮(避免脚本运行过久)。
        """
        bdata = self._box_info()
        if bdata.get("errno") != 0:
            self.results.append(("宝箱状态查询", "失败", bdata.get("error", "未知错误")))
            return
        d = bdata.get("data", {})
        total = d.get("total_box_round", 10)
        # 限制本轮领取次数(每轮倒计时较长，避免脚本运行过久)
        max_rounds = min(max_rounds, total)
        if max_rounds <= 0:
            return

        claimed = 0
        # 先看有没有已经就绪的宝箱(status=1)，直接领
        for attempt in range(max_rounds):
            d = self._box_info().get("data", {})
            status = d.get("box_reward_status", 0)
            remain = d.get("remain_time", 0)
            rnd = d.get("cur_box_round", 0)
            unit = d.get("reward_info", {}).get("unit", "?")

            if rnd > total or rnd <= 0:
                if claimed == 0:
                    self.results.append(("宝箱领取", "完成", "今日 %s 轮宝箱已全部领完" % total))
                break

            if status == 1:
                # 就绪，立即领取
                adata = self._box_claim()
                if adata.get("errno") == 0:
                    claimed += 1
                    self.results.append(("宝箱领取", "成功", "第 %s/%s 轮领取成功，+ %s 积分" % (rnd, total, unit)))
                else:
                    self.results.append(("宝箱领取", "失败", "第 %s 轮 errno=%s %s" % (rnd, adata.get("errno"), adata.get("error", ""))))
                    break
                time.sleep(1)
                continue

            # 未就绪，驱动倒计时
            if remain > 60 and attempt + 1 > max_rounds:
                # 剩余时间太长且已达最大轮数，跳过
                break

            self.results.append(("宝箱倒计时", "进行中", "第 %s/%s 轮剩余 %s 秒，开始驱动倒计时" % (rnd, total, remain)))
            tick_count = 0
            max_ticks = remain + 30  # 固定上限，避免死循环
            while status == 0 and remain > 0 and tick_count < max_ticks:
                self._box_tick()
                tick_count += 1
                if tick_count % 10 == 0:
                    info = self._box_info().get("data", {})
                    status = info.get("box_reward_status", 0)
                    remain = info.get("remain_time", 0)
                time.sleep(1.0)

            # 倒计时结束，再次确认状态并领取
            info = self._box_info().get("data", {})
            status = info.get("box_reward_status", 0)
            rnd = info.get("cur_box_round", 0)
            if status == 1:
                adata = self._box_claim()
                if adata.get("errno") == 0:
                    claimed += 1
                    self.results.append(("宝箱领取", "成功", "第 %s/%s 轮领取成功，+ %s 积分" % (rnd, total, unit)))
                else:
                    self.results.append(("宝箱领取", "失败", "第 %s 轮 errno=%s %s" % (rnd, adata.get("errno"), adata.get("error", ""))))
                    break
            else:
                self.results.append(("宝箱领取", "跳过", "第 %s 轮倒计时未归零(status=%s)，跳过" % (rnd, status)))
                break
            time.sleep(1)

        if claimed > 0:
            self.results.append(("宝箱汇总", "信息", "本轮共领取 %s 个宝箱，获得约 %s 积分" % (claimed, claimed * 5)))

    # ---------- 7. 积分兑换商城(金币兑换) ----------
    def coins_exchange_list(self):
        """获取可兑换商品列表。
        
        接口: GET /act/v2/component/getgoodslist
        返回: [(goods_name, score_required, exchange_id, stock), ...]
        注意: 返回的是百度网盘积分商城(金币兑换)的商品，
        与百度Comate积分商城是独立的积分体系。
        """
        gdata = self._coins_get("/act/v2/component/getgoodslist")
        if gdata.get("errno") != 0:
            self.results.append(("兑换商品列表", "失败", "errno=%s %s" %
                                 (gdata.get("errno"), gdata.get("show_msg", gdata.get("error", "未知错误")))))
            return []
        
        goods = gdata.get("data", [])
        if not goods or not isinstance(goods, list):
            # 可能是嵌套结构
            if isinstance(goods, dict):
                goods = goods.get("list", goods.get("items", []))
            if not goods:
                self.results.append(("兑换商品列表", "信息", "当前无可用商品"))
                return []
        
        result = []
        for g in goods:
            name = g.get("goods_name", g.get("name", g.get("title", "?")))
            score = int(g.get("goods_score", g.get("score", g.get("price", 0))))
            exchange_id = g.get("exchange_id", g.get("id", g.get("goods_id", "")))
            stock = g.get("stock", g.get("inventory", g.get("remain", 1)))
            result.append((name, score, str(exchange_id), stock))
        
        if result:
            info = "共%s个商品: " % len(result)
            for r in result[:5]:
                info += "「%s」%s分 " % (r[0][:8], r[1])
            if len(result) > 5:
                info += "等%s个" % len(result)
            self.results.append(("兑换商品列表", "信息", info))
        else:
            self.results.append(("兑换商品列表", "信息", "无可兑换商品"))
        
        return result

    def coins_exchange_reward(self, exchange_id, goods_name, score):
        """兑换指定商品。
        
        接口: GET /coins/taskcenter/reward
        需要参数: exchange_id (商品ID)
        注意: 该接口受HTJ反作弊保护，可能兑换失败。
        """
        if not exchange_id:
            return False, "缺少exchange_id"
        
        self.results.append(("积分兑换", "尝试", "兑换「%s」(消耗%s积分)..." % (goods_name, score)))
        
        rdata = self._coins_get("/coins/taskcenter/reward", {
            "exchange_id": str(exchange_id),
        })
        
        errno = rdata.get("errno", -1)
        if errno == 0:
            data = rdata.get("data", {})
            if isinstance(data, dict):
                msg = data.get("msg", data.get("message", "兑换成功"))
            else:
                msg = "兑换成功"
            self.results.append(("积分兑换", "成功", "兑换「%s」成功! %s" % (goods_name, msg)))
            return True, msg
        elif errno == -6:
            self.results.append(("积分兑换", "失败", "Cookie失效，请重新登录"))
            return False, "Cookie失效"
        elif errno == 8001 or errno == 8002:
            self.results.append(("积分兑换", "受限", "「%s」被HTJ反作弊拦截，需在App端兑换" % goods_name))
            return False, "HTJ拦截"
        elif errno == 2:
            self.results.append(("积分兑换", "失败", "「%s」参数错误，请核实" % goods_name))
            return False, "参数错误"
        elif errno == 40033:
            self.results.append(("积分兑换", "失败", "「%s」积分不足(需%s分)" % (goods_name, score)))
            return False, "积分不足"
        elif errno == 40034:
            self.results.append(("积分兑换", "失败", "「%s」库存不足" % goods_name))
            return False, "库存不足"
        elif errno == 40035:
            self.results.append(("积分兑换", "已兑", "「%s」今日已兑换过" % goods_name))
            return False, "今日已兑"
        elif errno == 40044:
            self.results.append(("积分兑换", "失败", "「%s」已达兑换上限" % goods_name))
            return False, "已达上限"
        else:
            self.results.append(("积分兑换", "失败", "「%s」errno=%s %s" %
                                 (goods_name, errno, rdata.get("show_msg", ""))))
            return False, "errno=%s" % errno

    def coins_exchange_auto(self, target_keywords=None, fast_mode=False):
        """自动兑换指定商品。
        
        Args:
            target_keywords: 要兑换的商品关键词列表，如 ["小度", "京东E卡", "30元"]
                             匹配优先级: 商品名包含任一关键词即匹配。
                             为 None 时仅查询商品列表，不执行兑换。
            fast_mode: 极速模式，跳过所有 time.sleep 延迟(用于8:00抢兑)。
        """
        # 先获取可用积分
        hdata = self._coins_get("/coins/taskcenter/home", {"go_home": "1", "ptype": "5"})
        balance = 0
        if hdata.get("errno") == 0:
            balance = int(hdata.get("data", {}).get("points_balance", 0))
            self.results.append(("积分余额", "信息", "当前积分 %s" % balance))
        else:
            self.results.append(("积分余额", "失败", "查询失败"))
            return
        
        # 获取商品列表
        goods = self.coins_exchange_list()
        if not goods:
            return
        
        if not target_keywords:
            self.results.append(("积分兑换", "提示", "未设置兑换目标，仅查询商品列表"))
            return
        
        # 匹配目标商品
        targets = []
        for name, score, eid, stock in goods:
            for kw in target_keywords:
                if kw.lower() in name.lower():
                    targets.append((name, score, eid, stock))
                    break
        
        if not targets:
            self.results.append(("积分兑换", "提示", "未找到匹配「%s」的商品" % " / ".join(target_keywords)))
            return
        
        # 按积分从低到高排序(优先兑换便宜的)
        targets.sort(key=lambda x: x[1])
        
        for name, score, eid, stock in targets:
            if stock is not None and isinstance(stock, int) and stock <= 0:
                self.results.append(("积分兑换", "无货", "「%s」已兑完" % name))
                continue
            if balance < score:
                self.results.append(("积分兑换", "积分不足", "「%s」需%s分，当前仅%s分" % (name, score, balance)))
                continue
            
            ok, msg = self.coins_exchange_reward(eid, name, score)
            if ok:
                balance -= score
                if not fast_mode:
                    time.sleep(2)  # 常规模式兑换后等待
            else:
                # 如果是HTJ拦截或已达上限，不再继续尝试同类商品
                if "HTJ" in msg or "上限" in msg or "今日已兑" in msg:
                    break
                if not fast_mode:
                    time.sleep(1)

    def exchange_only(self, target_keywords):
        """极速兑换模式 — 仅做登录校验和积分兑换，跳过所有任务步骤。
        
        用于 8:00 定时兑换，最少 API 调用、零延迟，最大化抢兑成功率。
        """
        # 快速登录校验: 一次 /home 请求同时完成登录验证和积分查询
        data = self._coins_get("/coins/taskcenter/home", {"go_home": "1", "ptype": "5"})
        if data.get("errno") != 0:
            self.results.append(("账号校验", "失败", "Cookie 失效或网络异常"))
            return self.results
        balance = int(data.get("data", {}).get("points_balance", 0))
        self.results.append(("账号校验", "成功", "积分余额 %s" % balance))
        
        # 极速兑换(无延迟)
        self.coins_exchange_auto(target_keywords=target_keywords, fast_mode=True)
        return self.results

    # ---------- 主流程 ----------
    def run(self, box_rounds=0, task_save=True, exchange_keywords=None):
        if not self.check_login():
            self.results.append(("账号校验", "失败", "Cookie 失效或网络异常，请检查 BDUSS/STOKEN"))
            return self.results
        uk_info = " (UK:%s)" % self.uk if self.uk else ""
        self.results.append(("账号校验", "成功", self.nickname + uk_info))
        self.membership_signin()
        self.daily_question()
        self.coins_signin()
        self.coins_status()
        if task_save:
            self.coins_tasks()
        self.coins_box(max_rounds=box_rounds)
        # 积分自动兑换
        if exchange_keywords:
            self.coins_exchange_auto(target_keywords=exchange_keywords)
        return self.results


# ---------------------- 主入口 ----------------------
def main(mode="task"):
    cookies = parse_cookies(os.getenv("BAIDU_COOKIE", ""))
    if not cookies:
        print("未检测到 BAIDU_COOKIE 环境变量，请在青龙中配置。")
        print("格式: BDUSS=xxxxxx; STOKEN=xxxxxx;  多账号换行分隔")
        return

    devices = parse_devices(os.getenv("BAIDU_DEVICE", ""), len(cookies))
    notify_on = os.getenv("BAIDU_NOTIFY", "true").lower() != "false"
    # 宝箱领取轮数(每轮需驱动倒计时1-8分钟，非常耗时; 默认0跳过，最大10)
    box_rounds = int(os.getenv("BAIDU_BOX_ROUNDS", "0") or "0")
    box_rounds = max(0, min(box_rounds, 10))
    # 任务上报开关
    task_save = os.getenv("BAIDU_TASK_SAVE", "true").lower() != "false"
    # 要兑换的商品关键词(逗号分隔)
    exchange_items_str = os.getenv("BAIDU_EXCHANGE_ITEMS", "")
    exchange_keywords = [kw.strip() for kw in exchange_items_str.split(",") if kw.strip()] if exchange_items_str else None

    all_summary = []
    for idx, ck in enumerate(cookies):
        banner = "===== 账号 %s =====" % (idx + 1)
        print("\n" + banner)
        bd = BaiduNetdisk(ck["BDUSS"], ck["STOKEN"], devices[idx])

        if mode == "exchange":
            # 极速兑换模式(8:00): 跳过所有任务, 仅兑换
            results = bd.exchange_only(target_keywords=exchange_keywords)
        else:
            # 默认完成任务模式(0:15): 签到+答题+任务上报+兑换
            results = bd.run(box_rounds=box_rounds, task_save=task_save, exchange_keywords=exchange_keywords)

        lines = []
        for name, status, detail in results:
            line = "[%s] %s: %s" % (status, name, detail)
            print(line)
            lines.append(line)
        all_summary.append(banner + "\n" + "\n".join(lines))
        if idx < len(cookies) - 1:
            time.sleep(random.randint(3, 8))  # 账号间随机延时

    # 汇总通知
    title = "百度网盘" + ("积分兑换" if mode == "exchange" else "每日任务")
    if notify_on:
        notify(title, "\n\n".join(all_summary))
    print("\n全部账号执行完毕。")


if __name__ == "__main__":
    # 支持命令行参数: task baidu_netdisk_task.py exchange
    mode = sys.argv[1] if len(sys.argv) > 1 else os.getenv("BAIDU_MODE", "task")
    if mode not in ("task", "exchange"):
        print("不支持的模式: %s，请使用 task 或 exchange" % mode)
        sys.exit(1)
    main(mode=mode)
