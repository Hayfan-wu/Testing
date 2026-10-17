#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# cron "25 0 * * *"
# new Env("百度文库每日任务")
"""
名称: 百度文库每日任务
功能: 激励中心签到、一键领取、VIP任务、盲盒抽奖、签到记录、云空间
      推送统计: AI任务/会员任务/日常任务完成度 + 未完成明细 + 前后活跃积分
作者: TRAE
更新: 2026-10-17

============================== 环境变量 ==============================
BAIDU_COOKIE        (必填) 多账号换行分隔，每行: BDUSS=xxxxxx;
                    与百度网盘脚本共用同一个 BAIDU_COOKIE（同一百度账号）
BAIDU_NOTIFY        (可选) 通知开关，默认 true
WENKU_DRAW          (可选) 盲盒自动抽奖开关，默认 true
WENKU_TASK_CLAIM    (可选) VIP任务领奖尝试开关，默认 true
WENKU_APP_VER       (可选) App 版本号，默认 10.4.50
BAIDU_WK_DR_PAYLOAD (可选) banti/dr 指纹包，默认内置（一般无需修改）
BAIDU_WK_JSTOKEN    (可选) 抽奖 jstoken，默认自动生成（一般无需修改）
WENKU_TAROT         (可选) "测运势赢金钞"活动开关，默认 true

============================== 玉门关安全机制(已突破) ==============================
文库动作接口(签到/领取/抽奖)受"玉门关"防护，要求请求头携带 Htj 令牌。
该令牌由 banti.baidu.com/dr 签发：脚本内置一份加密指纹包，
每次运行重放该包即可换取全新 Htj 令牌(无需 Cookie、与账号无关)，实测长期有效。
若百度更换加密版本导致令牌签发失败，请重新抓包：
  抓任意一次 banti.baidu.com/dr 请求，复制其 POST body 原文，
  填入环境变量 BAIDU_WK_DR_PAYLOAD 即可。
已实测打通接口: 签到 / 一键领取 / 盲盒抽奖 / 任务列表 / 抽奖信息 / 签到记录。

============================== 任务体系说明(实测结论) ==============================
文库有三套任务体系，本脚本均已打通:
1. 激励中心签到/一键领取/盲盒抽奖 —— 全部自动化。
2. AI每日任务(activecenter/genFlow, 任务号101-106, 无会员门槛):
   流程 = genflow对话 → updategenflowtask上报 → genflowreward领活跃积分，
   每个任务约+8活跃积分。归因接口无需 jt 令牌(实测)。
3. 文库豆任务(naapi/task, 无会员门槛): 搜索2次文档(+10豆)、查看工具箱(+5豆)，
   归因接口 naapi/task/updatetask?taskId=N。
   实测边界: 阅读3篇文档——脚本访问 H5 文档页不计数，服务端仅认可 App 内真实
   阅读；桌面组件/分享为设备侧行为。以上均需 App 手动完成(推送中已附指引)。
4. VIP抽奖任务(viptasklist, 仅限会员):
   会员身份由 naapi/user/getinfo 的 vip.end_time 识别——
   会员账号自动归因并领奖:
     对话任务(AI对话/PPT/研报/画本): genflow对话即计数;
     拍图/作文任务(task8/11/15): photoToEssay链路
       (getimagebostoken→imagesubmit→createfiles→genflow对话,
        实测服务端不校验图片真实存在, 无需真实拍摄/上传);
   非会员: 自动跳过(实测非会员进度不计数，App内真实操作也不计数)。
   阅读6篇(task5)归因需App内真实阅读行为, 脚本docId上报不计数(实测)。
注: 服务端归因有延迟(实测约20秒~3分钟到账)，脚本内置轮询等待后领奖。

============================== 测运势赢金钞(开学季活动, 已打通) ==============================
入口在 pan.baidu.com(与文库同账号体系)，实测 wap 侧裸参数即可，无需 Htj:
  tarot/home    查状态(打卡记录/已测主题/任务列表/抽奖次数)
  tarot/start   开始测运势(传 theme 1-4 + identity)，返回 divination_id
  tarot/result  取完整解读，同时触发当日打卡(continue_days 自动+1)
  lotterycommit 金钞抽奖(次数由任务/打卡累积，无次数时自动跳过)
  活动任务归因  genflow/chat 的 extra 注入 actFrom=wenkuStar +
                actTaskId=<task_id_str> + sceneType=backToSchool，
                实测可归因(延迟约20秒)，自动完成 PPT/海报/对话/文档 类任务
每天自动补齐 4 个运势主题 + 全部未完成活动任务；活动结束后接口自动返回非 0，脚本会提示并跳过。
"""

import os
import time
import random
import string
import hashlib
import json
import requests

# 每次运行抽奖/领奖尝试上限(防刷)
MAX_CLAIM_ATTEMPTS = 5
MAX_DRAW_ATTEMPTS = 10

# ==================== banti/dr 加密指纹包(重放换取 Htj 令牌) ====================
DR_URL = "https://banti.baidu.com/dr?&_o=https%3A%2F%2Ftanbi.baidu.com"
DR_PAYLOAD = r"""{"d":"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","s":"3479952159","c":"lMtCehSZmtBwAMtCefY5lNdAAKZjZzhqeXSiUDE=","v":"2.0","m":"fuRMExiuzWnUKMES55Qj7Jc0HuYaGr1bwi7qTJ7/hB+A2z9fgcqem17HiknUpbvjUJbLHMsXUiWKLVFrf5k1Ul5Fidvfu6dHZRYv6++O12zgQxduxUmXvB0kQalLWK6lAwjSVX4kLAgvFKkwMQaC6g==_dec4f233"}"""


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
def gen_cuid(bduss):
    """根据 BDUSS 生成稳定的 40 位 cuid（文库 cuid 为 40 位 hex）。"""
    h = hashlib.md5(("wenku_" + bduss).encode()).hexdigest()
    h2 = hashlib.sha1(bduss.encode()).hexdigest()
    return (h + h2)[:40]


def parse_cookies(env_str):
    """解析 BAIDU_COOKIE，多账号按换行分隔，提取 BDUSS。"""
    if not env_str:
        return []
    lines = [l.strip() for l in env_str.replace("\\n", "\n").split("\n") if l.strip()]
    cookies = []
    for line in lines:
        bduss = ""
        for part in line.split(";"):
            part = part.strip()
            if part.upper().startswith("BDUSS="):
                bduss = part.split("=", 1)[1].strip()
        if bduss:
            cookies.append({"BDUSS": bduss})
    return cookies


def _env_bool(name, default):
    return os.getenv(name, "true" if default else "false").lower() != "false"


def _env_str(name, default):
    return os.getenv(name) or default


# ---------------------- 运行配置 ----------------------
class Config:
    """集中管理环境变量配置。"""

    def __init__(self):
        self.cookies = parse_cookies(os.getenv("BAIDU_COOKIE", ""))
        self.notify_on = _env_bool("BAIDU_NOTIFY", True)
        self.task_claim = _env_bool("WENKU_TASK_CLAIM", True)
        self.draw_on = _env_bool("WENKU_DRAW", True)
        self.app_ver = _env_str("WENKU_APP_VER", "10.4.50")
        self.dr_payload = _env_str("BAIDU_WK_DR_PAYLOAD", "") or DR_PAYLOAD
        self.jstoken = _env_str("BAIDU_WK_JSTOKEN", "")
        self.tarot_on = _env_bool("WENKU_TAROT", True)


# ---------------------- 结果收集 ----------------------
class Reporter:
    """收集单个账号各任务执行结果。"""

    def __init__(self):
        self.items = []  # [(任务名, 状态, 详情)]

    def add(self, name, status, detail):
        self.items.append((name, status, detail))

    def summary(self):
        ok = sum(1 for _, s, _ in self.items if s == "成功")
        skip = sum(1 for _, s, _ in self.items if s in ("已签", "信息", "完成", "提示", "跳过"))
        fail = sum(1 for _, s, _ in self.items if s == "失败")
        return "成功%d / 信息%d / 失败%d" % (ok, skip, fail)

    def render(self):
        return ["[%s] %s: %s" % (s, n, d) for n, s, d in self.items]


# ---------------------- Htj 令牌签发(banti/dr 重放) ----------------------
class TokenManager:
    """通过重放 banti/dr 指纹包换取 Htj 令牌，供多账号复用。"""

    def __init__(self, cfg):
        self.cfg = cfg
        self._token = None

    def get_token(self, refresh=False):
        """获取(或强制刷新) Htj 令牌。失败返回 None。"""
        if self._token and not refresh:
            return self._token
        for attempt in range(3):
            try:
                r = requests.post(
                    DR_URL,
                    data=self.cfg.dr_payload.encode("utf-8"),
                    headers={
                        "Content-Type": "text/plain;charset=UTF-8",
                        "User-Agent": ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
                                       "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"),
                    },
                    timeout=20,
                )
                data = r.json()
                t = (data.get("htj") or {}).get("data", {}).get("t")
                if t:
                    self._token = t
                    return t
            except Exception:
                pass
            time.sleep(1 + attempt)
        return None


# ---------------------- 百度文库客户端 ----------------------
class BaiduWenku:
    """百度文库任务自动化（App 原生通道 appwk.baidu.com + Htj 令牌过玉门关）。"""

    UA_NATIVE = "ktor-client"
    BASE = "https://appwk.baidu.com"
    CODE_YMG = 7350000          # 玉门关拦截
    CODE_NO_REWARD = 200002     # 暂无可领取奖励
    CODE_NO_DRAW = 110016       # 没有抽奖次数
    CODE_NOT_LOGIN = (200001, -6)

    # 激励中心 homepage 要求原生完整设备参数集(实测最小参数集返回 code=2)。
    # 以下为抓包设备级常量(与账号无关)；sessid/timestamp/ilts 运行时生成。
    HOMEPAGE_DEVICE = {
        "signCuid": "cc0ea3dc7fb5e609d05f3ed9d1e5dc91",
        "app_ua": "iPhone15,3", "wk_New_Behavior": "0", "wapRefer": "appstore",
        "fr": "2", "ua": "bd_2796_1290_iPhone15,3_10.4.50_27.0",
        "bundle_ver": "10.4.50.7",
        "baidu_cuid": "84DADECB55964BC4C2481DCF2B69EAEC19CCAE02AOSAJAGGARG",
        "Bdi_bear": "Reachable via WiFi", "sys_ver": "27.0", "nettype": "WIFI",
        "vendor": "iPhone", "device_score": "1.415",
        "openudid": "b9759008cda52412ae989da267f44e4742dd8b60",
        "uid": "bd_0", "operator_id": "",
        "idfv": "396E5088-2D92-4D15-A04C-229745D511AF",
        "from": "ios_", "model": "iPhone15,3", "pid": "1", "launchRefer": "",
        "device_level": "1", "launchSource": "", "screen": "1290_2796",
        "bid": "1", "sv": "27.0", "refer": "", "av": "10.4.50",
    }

    def __init__(self, bduss, cfg, token_mgr):
        self.bduss = bduss
        self.cfg = cfg
        self.token_mgr = token_mgr
        self.cuid = gen_cuid(bduss)
        self.cookie = "BDUSS=%s;" % bduss
        self.session = requests.Session()
        self.report = Reporter()
        self.stats = {"score_before": None, "score_after": None}

    # ==================== 活跃积分与推送统计 ====================
    def _homepage(self):
        """请求激励中心主页(完整原生参数集)。失败返回 None。"""
        extra = dict(self.HOMEPAGE_DEVICE)
        extra["sessid"] = str(int(time.time()))
        extra["timestamp"] = str(int(time.time() * 1000))
        extra["ilts"] = hashlib.md5(self.cuid.encode()).hexdigest()[:32]
        data = self._request("GET", "/appapi/activecenter/homepage", extra)
        return data if self._code(data) == 0 else None

    def _active_score(self):
        """当前活跃积分(homepage.pointReward.userPoints)。失败返回 None。"""
        data = self._homepage()
        if data is None:
            return None
        return ((data.get("data") or {}).get("pointReward") or {}).get("userPoints")

    # 未完成任务 → 手动操作指引(推送中展示)
    # (拍图/作文已走 photoToEssay 链路自动化, 不再需要手动)
    MANUAL_HINTS = [
        ("阅读", "App搜索打开任意3篇文档停留10秒"),
        ("组件", "点击桌面文库小组件进入"),
        ("桌面", "App内长按图标添加搜索小组件"),
        ("分享", "打开文档点右上角分享给好友"),
    ]

    def push_summary(self):
        """生成 wxpusher 推送统计块: 三类任务完成度 + 未完成明细 + 前后活跃积分。"""
        s = self.stats
        lines = []
        for key, label in (("ai", "库库AI任务"), ("vip", "会员专属任务"), ("daily", "日常任务"), ("tarot", "测运势活动")):
            st = s.get(key)
            if st is None:
                lines.append("%s：无数据" % label)
            elif "skip" in st:
                lines.append("%s：跳过(%s)" % (label, st["skip"]))
            else:
                lines.append("%s：%s/%s" % (label, st.get("done", 0), st.get("total", 0)))
        undone = []
        for key in ("ai", "vip", "daily", "tarot"):
            st = s.get(key)
            if st and st.get("undone"):
                undone.extend(st["undone"])
        if undone:
            lines.append("未完成项目明细：")
            for u in undone[:10]:
                hint = next((h for kw, h in self.MANUAL_HINTS if kw in u), "")
                lines.append("- " + u + (" → 手动: " + hint if hint else ""))
        before, after = s.get("score_before"), s.get("score_after")
        if before is not None and after is not None:
            diff = after - before
            sign = "+" if diff >= 0 else ""
            lines.append("活跃积分：%s → %s (%s%s)" % (before, after, sign, diff))
        return "\n".join(lines)

    # ==================== 通用请求层 ====================
    def _request(self, method, path, extra=None, json_body=None, form_body=None, with_token=True):
        """appapi 请求。with_token=True 时自动携带 Htj 令牌(被拦截自动换牌重试一次)。"""
        url = self.BASE + path

        def do(token):
            params = {
                "os": "ios",
                "na_uncheck": "1",
                "app_ver": self.cfg.app_ver,
                "cuid": self.cuid,
                "_t": str(int(time.time() * 1000)),
            }
            if extra:
                params.update(extra)
            headers = {"Cookie": self.cookie, "User-Agent": self.UA_NATIVE,
                       "Accept": "application/json"}
            if token:
                headers["Htj"] = token
                headers["Acs-Token"] = token
                headers["ztoken"] = ""
            if method.upper() == "POST":
                if form_body is not None:
                    headers["Content-Type"] = "application/x-www-form-urlencoded"
                    r = self.session.post(url, params=params, data=form_body,
                                          headers=headers, timeout=20)
                else:
                    headers["Content-Type"] = "application/json"
                    r = self.session.post(url, params=params, json=json_body,
                                          headers=headers, timeout=20)
            else:
                r = self.session.get(url, params=params, headers=headers, timeout=20)
            try:
                return r.json()
            except ValueError:
                return {"status": {"code": -1, "msg": "HTTP %s 非 JSON 响应" % r.status_code}}

        token = self.token_mgr.get_token() if with_token else None
        resp = do(token)
        # 玉门关拦截 → 换新令牌重试一次
        if with_token and self._code(resp) == self.CODE_YMG:
            token = self.token_mgr.get_token(refresh=True)
            if token:
                resp = do(token)
        return resp

    @staticmethod
    def _code(resp):
        return (resp.get("status") or {}).get("code", -1)

    @staticmethod
    def _msg(resp):
        return (resp.get("status") or {}).get("msg", "")

    def _describe(self, resp):
        """统一描述接口返回。"""
        code = self._code(resp)
        msg = self._msg(resp)
        if code == 0:
            return True, "成功"
        if code == self.CODE_YMG:
            return False, "被玉门关拦截(7350000)，令牌签发或校验失败"
        if code in self.CODE_NOT_LOGIN or "not login" in msg.lower():
            return False, "Cookie 失效(%s %s)，请更新 BDUSS" % (code, msg)
        return False, "code=%s %s" % (code, msg)

    # ==================== 0. 鉴权校验 ====================
    def check_login(self):
        """云空间接口兼作鉴权校验。"""
        data = self._request("GET", "/ghome/cloud/spaceinfo", with_token=False)
        if self._code(data) == 0:
            d = data.get("data", {})
            used = d.get("usedSizeCount", 0) / 1024 / 1024 / 1024
            total = d.get("maxSizeCount", 0) / 1024 / 1024 / 1024
            over = "，已超容" if d.get("isOverCapacity") else ""
            self.report.add("账号校验", "成功",
                            "BDUSS%s (云空间 %.2fGB/%.0fGB%s)"
                            % (self.bduss[:6], used, total, over))
            return True
        ok, desc = self._describe(data)
        self.report.add("账号校验", "失败", desc)
        return False

    # ==================== 1. 激励中心签到 ====================
    def activecenter_sign(self):
        """激励中心签到(带签到记录前后对比验证)。"""
        before = self._request("GET", "/appapi/activecenter/signrecord")
        days_before = (before.get("data") or {}).get("signin_days", "?")

        data = self._request("GET", "/appapi/activecenter/sign")
        code = self._code(data)
        if code == 0:
            d = data.get("data") or {}
            days = d.get("accumulatedSignInDays", "?")
            today = d.get("todaySignIn", 0)
            prize = ""
            prizes = d.get("prizes") or []
            if prizes:
                prize = " +%s文库积分" % prizes[0].get("unit", "?")
            if today == 1:
                self.report.add("激励中心签到", "成功", "今日已签，累计%s天%s" % (days, prize))
            else:
                self.report.add("激励中心签到", "已签", "今日此前已签，累计%s天" % days)
        else:
            ok, desc = self._describe(data)
            status = "失败" if code != self.CODE_YMG else "受限"
            self.report.add("激励中心签到", status, desc)

        # 签到记录(累计天数+今日状态)
        after = self._request("GET", "/appapi/activecenter/signrecord")
        if self._code(after) == 0:
            d = after.get("data") or {}
            days = d.get("signin_days", "?")
            signed_today = any((it or {}).get("signed") == 1 and self._is_today(it.get("date"))
                               for it in (d.get("signin_list") or []))
            change = "（%s→%s）" % (days_before, days) if days_before != days else ""
            self.report.add("签到记录", "信息",
                            "累计签到%s天%s，今日%s" % (days, change, "已签" if signed_today else "未签"))

    @staticmethod
    def _is_today(ms):
        try:
            return time.strftime("%Y-%m-%d", time.localtime(int(ms) / 1000)) == \
                time.strftime("%Y-%m-%d")
        except Exception:
            return False

    # ==================== 2. 一键领取 ====================
    def oneclick_receive(self):
        """激励中心一键领取待领奖励。"""
        data = self._request("GET", "/appapi/activecenter/oneclickreceive",
                             {"extra": json.dumps({"appVer": self.cfg.app_ver})})
        code = self._code(data)
        if code == 0:
            d = data.get("data", {}) or {}
            detail = json.dumps(d, ensure_ascii=False)[:100] if d else "领取成功"
            self.report.add("一键领取", "成功", detail)
        elif code == self.CODE_NO_REWARD:
            self.report.add("一键领取", "提示", "暂无可领取奖励")
        else:
            ok, desc = self._describe(data)
            self.report.add("一键领取", "提示", desc)

    # ==================== 2.5 会员状态识别 ====================
    def vip_status(self):
        """通过 naapi/user/getinfo 识别会员身份。返回是否会员(bool)。"""
        data = self._request("GET", "/naapi/user/getinfo", {"id": "wenku_na_new_user_vip"})
        if self._code(data) != 0:
            ok, desc = self._describe(data)
            self.report.add("会员识别", "提示", desc + "(按非会员处理)")
            return False
        vip = (data.get("data") or {}).get("vip") or {}
        end_time = int(vip.get("end_time") or 0)
        remain_day = int(vip.get("remain_day") or 0)
        is_vip = end_time > time.time() or remain_day > 0
        if is_vip:
            expire = time.strftime("%Y-%m-%d", time.localtime(end_time)) \
                if end_time > time.time() else "剩余%s天" % remain_day
            self.report.add("会员识别", "成功", "会员账号(到期: %s)，VIP任务已启用" % expire)
        else:
            self.report.add("会员识别", "信息", "非会员账号，会员专属任务自动跳过")
        return is_vip

    # ==================== 3. AI每日任务(genFlow, 无会员门槛) ====================
    GENFLOW_CHAT = "https://tanbi.baidu.com/wenchain/genflow/chat"
    GENFLOW_UPDATE = "https://tanbi.baidu.com/appapi/activecenter/updategenflowtask"
    GENFLOW_REWARD = "https://tanbi.baidu.com/appapi/activecenter/genflowreward"

    def _genflow_chat(self, content, act_task_id="", scene="", skill_id=""):
        """发起一次 genflow AI 对话(SSE 流式，读到开头即断开，服务端已登记)。
        act_task_id 非空时注入开学季活动归因(actFrom/actTaskId/sceneType)。"""
        extra = {"version": "9", "cuid": self.cuid, "fr": 2, "wanpanAuthStatus": 0,
                 "baiducuid": "", "app_ver": self.cfg.app_ver + ".7", "smallflow": "",
                 "hidePicture": False, "brandAct": 0, "pptMulParams": "",
                 "source": "genflowActivity", "skillExt": {},
                 "tools_black_list": "wenchain_wangpan_search,wenchain_knowledge_data_mount",
                 "knowledge_search_params": {"user_knowledge_infos": [],
                                             "collect_knowledge_infos": []},
                 "just_knowledgebase": 0, "gen_method": ""}
        if act_task_id:
            extra["actFrom"] = "wenkuStar"
            extra["actTaskId"] = str(act_task_id)
            extra["sceneType"] = "backToSchool"
        if scene:
            extra["scene"] = scene
        if skill_id:
            extra["skillId"] = skill_id
            extra["skillExt"] = {"skillId": skill_id, "pptConfig": {"pptMode": 3}}
            extra["pptConfig"] = {"pptMode": 3}
            extra["ppt_mode"] = "vision"
        body = {
            "channel": "wenku_na_genflow_v4",
            "messages": [{"role": "user", "content": str(content)}],
            "chat_id": "", "query_id": "",
            "extra": extra,
        }
        headers = {"Cookie": self.cookie, "User-Agent": self.UA_NATIVE,
                   "Content-Type": "application/json", "Accept": "text/event-stream"}
        try:
            r = self.session.post(self.GENFLOW_CHAT, json=body, headers=headers,
                                  stream=True, timeout=(10, 30))
            got = 0
            for chunk in r.iter_content(2048):
                got += len(chunk or b"")
                if got > 4096:
                    break
            r.close()
            return r.status_code == 200
        except Exception:
            return False

    def _genflow_headers(self, content_type):
        headers = {"Cookie": self.cookie, "User-Agent": self.UA_NATIVE,
                   "Content-Type": content_type, "Origin": "https://tanbi.baidu.com"}
        token = self.token_mgr.get_token()
        if token:
            headers["Htj"] = token
            headers["Acs-Token"] = token
            headers["ztoken"] = ""
        return headers

    def _update_genflow_task(self, task_id):
        """上报 AI 任务完成(实测无需 jt 令牌)。返回状态码。"""
        try:
            r = self.session.post(
                self.GENFLOW_UPDATE,
                params={"app_ver": self.cfg.app_ver, "cuid": self.cuid, "os": "ios",
                        "_t": str(int(time.time() * 1000))},
                data="os=ios&cuid=%s&taskId=%s" % (self.cuid, task_id),
                headers=self._genflow_headers("application/x-www-form-urlencoded"), timeout=15)
            return (r.json().get("status") or {}).get("code", -1)
        except Exception:
            return -1

    def _genflow_reward(self, task_id):
        """领取 AI 任务活跃积分。返回 (code, activeScore)。"""
        body = {"taskId": task_id, "os": "ios", "ztoken": self.cuid, "jstoken": "",
                "na_uncheck": 1, "app_ver": self.cfg.app_ver, "cuid": self.cuid, "fr": "2"}
        try:
            r = self.session.post(
                self.GENFLOW_REWARD,
                params={"app_ver": self.cfg.app_ver, "cuid": self.cuid, "os": "ios",
                        "_t": str(int(time.time() * 1000))},
                json=body, headers=self._genflow_headers("application/json"), timeout=15)
            j = r.json()
            return (j.get("status") or {}).get("code", -1), \
                int(((j.get("data") or {}).get("activeScore")) or 0)
        except Exception:
            return -1, 0

    # ==================== 拍图作文链路(photoToEssay) ====================
    GENFLOW_CREATEFILES = "https://tanbi.baidu.com/appapi/genflow/createfiles"

    def _photo_essay(self, times):
        """模拟"拍图写作文"(source=photoToEssay) N 次。
        链路: getimagebostoken(服务端直接下发上传路径) → imagesubmit →
              createfiles → genflow对话(source=photoToEssay)。
        实测: 服务端不校验图片真实存在(编造路径也返回成功)，无需实际上传；
        该链路可归因 VIP 拍图类任务(task8 体验拍图/task11 每周拍图/task15 AI作文)。
        返回成功次数。"""
        ok = 0
        for _ in range(max(0, int(times))):
            try:
                gt = self._request("POST", "/appapi/api/getimagebostoken",
                                   json_body={"imageList": [{"fileExt": "PNG",
                                                             "fileName": "1_photo"}]})
                key = ""
                if self._code(gt) == 0:
                    kl = (gt.get("data") or {}).get("keyList") or {}
                    key = next(iter(kl.values()), "")
                if not key:
                    key = "temp/0/%s.PNG" % hashlib.md5(
                        str(time.time()).encode()).hexdigest()
                rd = self._request("POST", "/appapi/api/imagesubmit",
                                   form_body={"object": key, "fileExt": "PNG",
                                              "sourceId": "photoToEssay",
                                              "fileName": "1_photo", "from": "aipic"})
                img_url = (rd.get("data") or {}).get("imgUrl") or ""
                if not img_url:
                    time.sleep(2)
                    continue
                cf = self.session.post(
                    self.GENFLOW_CREATEFILES,
                    params={"app_ver": self.cfg.app_ver, "cuid": self.cuid},
                    json={"channel": "wenku_na_genflow_v4",
                          "files": [{"url": img_url, "source": 1, "commitStatus": 2,
                                     "toolCallId": "", "class_type": ""}]},
                    headers=self._genflow_headers("application/json"), timeout=15)
                fids = ((cf.json().get("data") or {}).get("fileIds")) or []
                chat_body = {
                    "channel": "wenku_na_genflow_v4",
                    "messages": [{"role": "user",
                                  "content": "根据图片内容寓意，帮我写一篇作文。"}],
                    "extra": {"version": "9", "cuid": self.cuid, "fr": 2,
                              "wanpanAuthStatus": 0, "app_ver": self.cfg.app_ver,
                              "source": "photoToEssay",
                              "scene": "na_camera_file_retrival",
                              "hidePicture": False, "brandAct": 0,
                              "pptMulParams": "", "skillExt": {},
                              "tools_black_list": ""},
                }
                if fids:
                    chat_body["extra"]["files"] = fids
                headers = {"Cookie": self.cookie, "User-Agent": self.UA_NATIVE,
                           "Content-Type": "application/json",
                           "Accept": "text/event-stream"}
                r = self.session.post(self.GENFLOW_CHAT, json=chat_body,
                                      headers=headers, stream=True,
                                      timeout=(10, 30))
                got = 0
                for chunk in r.iter_content(2048):
                    got += len(chunk or b"")
                    if got > 4096:
                        break
                r.close()
                if r.status_code == 200:
                    ok += 1
            except Exception:
                pass
            time.sleep(3)
        return ok

    def genflow_daily(self):
        """激励中心每日 AI 任务(6个): 对话→上报→领活跃积分。返回完成任务号。"""
        data = self._homepage()
        if data is None:
            self.report.add("AI每日任务", "提示", "活动页获取失败")
            self.stats["ai"] = {"done": 0, "total": 0, "undone": []}
            return []
        glist = ((data.get("data") or {}).get("genFlowTaskList")) or []
        total = len(glist)
        if not glist:
            self.report.add("AI每日任务", "信息", "今日无待做 AI 任务")
            self.stats["ai"] = {"done": 0, "total": 0, "undone": []}
            return []
        done_ids, total_score = [], 0
        for t in glist:
            tid = t.get("taskId")
            name = t.get("taskBubbleName") or t.get("taskName") or str(tid)
            if t.get("taskStatus") == 3:
                continue
            query = t.get("taskQuery") or name
            if not self._genflow_chat(query):
                self.report.add("AI每日任务", "提示", "%s: 对话发起失败" % name)
                continue
            time.sleep(2)
            code = self._update_genflow_task(tid)
            if code in (0, 600005):
                rc, score = self._genflow_reward(tid)
                if rc == 0:
                    done_ids.append(str(tid))
                    total_score += score
                time.sleep(0.5)
        if done_ids:
            self.report.add("AI每日任务", "成功", "完成%s个(任务%s)，活跃积分+%s"
                            % (len(done_ids), "/".join(done_ids), total_score))
        else:
            self.report.add("AI每日任务", "信息", "今日任务均已完成或暂不可报")
        pre_done = sum(1 for t in glist if t.get("taskStatus") == 3)
        undone = [t.get("taskBubbleName") or t.get("taskName") or str(t.get("taskId"))
                  for t in glist
                  if t.get("taskStatus") != 3 and str(t.get("taskId")) not in done_ids]
        self.stats["ai"] = {"done": pre_done + len(done_ids), "total": total,
                            "undone": undone}
        return done_ids

    # ==================== 4. 文库豆任务(无会员门槛) ====================
    def bean_tasks(self):
        """naapi 每日任务: 搜索2次文档(+10豆)、查看工具箱(+5豆)。"""
        data = self._request("GET", "/naapi/task/tasklist",
                             {"src": "tasklist", "ztoken": "wenku"})
        if self._code(data) != 0:
            ok, desc = self._describe(data)
            self.report.add("文库豆任务", "提示", "任务列表获取失败(%s)" % desc)
            self.stats["daily"] = None
            return
        tasks = {t.get("taskId"): t
                 for t in ((data.get("data") or {}).get("taskList") or [])}
        acts, acted = [], set()
        # task9 搜索2次文档
        t9 = tasks.get(9) or {}
        if t9 and t9.get("taskStatus") != 3 \
                and not (t9.get("taskExtra") or {}).get("isFinishToday"):
            for w in ("人工智能", "考研英语"):
                self._request("GET", "/appapi/search/allsearch",
                              {"word": w, "searchFrom": "allSearch", "rn": "10", "pn": "0",
                               "sortType": "0", "fileType": "0", "ztoken": "wenku"})
                time.sleep(1)
            self._request("GET", "/naapi/task/updatetask",
                          {"taskId": "9", "ztoken": "wenku"})
            acts.append("搜索文档x2(+10豆)")
            acted.add(9)
        # task8 查看工具箱
        t8 = tasks.get(8) or {}
        if t8 and t8.get("taskStatus") != 3 \
                and not (t8.get("taskExtra") or {}).get("isFinishToday"):
            self._request("GET", "/appapi/tool/2026box")
            time.sleep(0.5)
            self._request("GET", "/naapi/task/updatetask",
                          {"taskId": "8", "ztoken": "wenku"})
            acts.append("查看工具箱(+5豆)")
            acted.add(8)
        # 可领取(状态2)的任务再触发一次归因入账
        got = 0
        for tid, t in tasks.items():
            if t.get("taskStatus") == 2:
                rd = self._request("GET", "/naapi/task/updatetask",
                                   {"taskId": str(tid), "ztoken": "wenku"})
                if self._code(rd) == 0:
                    got += int(t.get("rewardNum") or 0)
                time.sleep(0.3)
        if acts:
            extra = "，入账+%s豆" % got if got else ""
            self.report.add("文库豆任务", "成功", "完成: " + "、".join(acts) + extra)
        else:
            self.report.add("文库豆任务", "信息",
                            "今日任务均已完成" + ("，入账+%s豆" % got if got else ""))
        undone = []
        for tid, t in tasks.items():
            name = t.get("taskName") or str(tid)
            finished = t.get("taskStatus") == 3 \
                or (t.get("taskExtra") or {}).get("isFinishToday") \
                or tid in acted
            if not finished:
                undone.append("%s(%s/%s)" % (name, t.get("currentStep", 0),
                                             t.get("totalStep", 1)))
        self.stats["daily"] = {"done": len(tasks) - len(undone),
                               "total": len(tasks), "undone": undone}

    # ==================== 5. VIP 抽奖任务 ====================
    # 可通过 genflow 对话归因的任务 → 引导话术
    VIP_CHAT_QUERIES = {
        7: "写一个PPT，主题为：寒假弯道超车的秘诀",
        13: "写一个研究报告，主题为：新能源汽车行业现状与未来发展",
        14: "帮我生成一个AI画本，主题是：小猫钓鱼",
        10: "帮我写一份年终工作总结文档",
    }
    VIP_SMALL_TALK = ("什么是光合作用", "推荐三本经典科幻小说", "怎样养成早睡的习惯")
    # 仅能 App 内手动完成的任务 → 提示话术
    # (task8/11 拍图、task15 作文已可自动化, 不再列入手动)
    VIP_MANUAL = {}
    # 报告中完全不提示的任务
    VIP_SKIP = {12}                # 开通/续费会员: 需实际支付, 直接跳过

    def vip_tasks(self, is_vip, try_claim=None):
        """VIP 抽奖任务: 非会员自动跳过；会员做对话归因→轮询→领奖。"""
        if try_claim is None:
            try_claim = self.cfg.task_claim
        data = self._request("GET", "/appapi/task/viptasklist", {"taskaward": "draw"})
        if self._code(data) != 0:
            ok, desc = self._describe(data)
            self.report.add("VIP任务", "失败", desc)
            self.stats["vip"] = {"skip": "获取失败"}
            return

        tasks = data.get("data", []) or []
        if not tasks:
            self.report.add("VIP任务", "信息", "任务列表为空")
            self.stats["vip"] = {"done": 0, "total": 0, "undone": []}
            return

        # ---- 非会员: 自动跳过 ----
        if not is_vip:
            running = sum(1 for t in tasks if t.get("taskStatus") == 1)
            self.report.add("VIP任务", "跳过",
                            "会员专属任务共%d个(进行中%d个)，非会员进度不计数，已自动跳过"
                            % (len(tasks), running))
            self.stats["vip"] = {"skip": "非会员"}
            return

        # ---- 会员: 自动归因(对话 / 拍图作文链路) ----
        chat_n, photo_n = 0, 0
        for t in tasks:
            tid = t.get("taskId")
            if t.get("taskStatus") != 1 or t.get("currentStep", 0) >= t.get("totalStep", 1):
                continue
            if tid in (8, 11, 15):          # 拍图类: photoToEssay 链路
                need = int(t.get("totalStep", 1)) - int(t.get("currentStep", 0))
                photo_n += self._photo_essay(min(max(need, 1), 3))
                time.sleep(2)
                continue
            content = None
            if tid == 9:                    # 每日3次AI对话: 普通对话即计数
                content = self.VIP_SMALL_TALK[chat_n % len(self.VIP_SMALL_TALK)]
            elif tid in self.VIP_CHAT_QUERIES:
                content = self.VIP_CHAT_QUERIES[tid]
            if content:
                self._genflow_chat(content)
                chat_n += 1
                time.sleep(2)

        # ---- 轮询等待服务端归因(实测约20秒~3分钟到账)并逐个领奖 ----
        claimed = []
        for rnd in range(3):
            time.sleep(15 if rnd == 0 else 25)
            poll = self._request("GET", "/appapi/task/viptasklist", {"taskaward": "draw"})
            if self._code(poll) != 0:
                break
            ptasks = poll.get("data") or []
            if try_claim:
                for t in ptasks:
                    if t.get("taskStatus") == 2 and t.get("taskId") not in claimed:
                        rd = self._request("GET", "/appapi/task/updateviptask",
                                           {"taskId": t.get("taskId")})
                        if self._code(rd) == 0:
                            claimed.append(t.get("taskId"))
                        time.sleep(0.5)
            if all(t.get("taskStatus") != 1 for t in ptasks):
                break

        # ---- 汇总 ----
        final = self._request("GET", "/appapi/task/viptasklist", {"taskaward": "draw"})
        ftasks = (final.get("data") or tasks) if self._code(final) == 0 else tasks
        if claimed:
            self.report.add("VIP任务领奖", "成功", "领取 %s 个任务奖励" % len(claimed))
        doing = ["%s(%s/%s)" % (t.get("taskName"), t.get("currentStep", 0), t.get("totalStep", 0))
                 for t in ftasks
                 if t.get("taskStatus") == 1 and t.get("taskId") not in self.VIP_SKIP]
        done_n = sum(1 for t in ftasks if t.get("taskStatus") in (2, 3))
        detail = "共%d个：已完成/可领%d个，进行中%d个" % (len(ftasks), done_n, len(doing))
        if chat_n:
            detail += "；已发%d次归因对话" % chat_n
        if photo_n:
            detail += "；已跑%d次拍图作文归因" % photo_n
        if doing:
            detail += "；" + "、".join(doing[:4]) + ("等" if len(doing) > 4 else "")
        manual = [tip for tid, tip in self.VIP_MANUAL.items()
                  if any(t.get("taskId") == tid and t.get("taskStatus") == 1 for t in ftasks)]
        if manual:
            detail += "；需手动: " + "、".join(sorted(set(manual)))
        self.report.add("VIP任务", "信息", detail)
        vt = [t for t in ftasks if t.get("taskId") not in self.VIP_SKIP]
        self.stats["vip"] = {"done": sum(1 for t in vt if t.get("taskStatus") in (2, 3)),
                             "total": len(vt),
                             "undone": ["%s(%s/%s)" % (t.get("taskName"),
                                                       t.get("currentStep", 0),
                                                       t.get("totalStep", 1))
                                        for t in vt if t.get("taskStatus") == 1]}

    # ==================== 6. 盲盒抽奖 ====================
    def _gen_jstoken(self):
        """抽奖 jstoken。实测服务端仅校验非空(任意字符串均可)；
        此处模拟 App 真实形态 P1_时间戳_时间戳_随机串，可经 BAIDU_WK_JSTOKEN 覆盖。"""
        if self.cfg.jstoken:
            return self.cfg.jstoken
        rnd = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(40))
        return "P1_%d_%d_%s" % (int(time.time() * 1000) - 30000,
                                int(time.time() * 1000), rnd)

    def blind_box_draw(self, try_draw=True):
        """盲盒抽奖：查询可抽次数并自动抽奖。"""
        data = self._request("GET", "/appapi/center/drawinfo2024")
        if self._code(data) != 0:
            ok, desc = self._describe(data)
            self.report.add("盲盒抽奖", "失败", "查询失败: %s" % desc)
            return

        d = data.get("data", {}) or {}
        if d.get("isOpen") is False:
            self.report.add("盲盒抽奖", "提示", "活动未开放")
            return
        times = int(d.get("availDrawTimes", 0) or 0)

        if times <= 0:
            self.report.add("盲盒抽奖", "信息", "今日无可抽次数(做任务可获得抽奖机会)")
            return

        self.report.add("盲盒抽奖", "信息", "当前可抽 %s 次" % times)
        if not try_draw:
            self.report.add("盲盒抽奖", "跳过", "未开启自动抽奖(WENKU_DRAW)")
            return

        won, fail, fail_desc = [], 0, ""
        for _ in range(min(times, MAX_DRAW_ATTEMPTS)):
            rd = self._request("POST", "/appapi/center/draw2024",
                               json_body={"jt": "", "os": "ios", "ztoken": self.cuid,
                                          "jstoken": self._gen_jstoken(), "cuid": self.cuid})
            code = self._code(rd)
            if code == 0:
                dd = rd.get("data") or {}
                if dd.get("isDrawLimitTimes"):
                    break
                bag = dd.get("aiBag") or {}
                prize = (dd.get("prizeName") or (dd.get("prizeInfo") or {}).get("prizeName")
                         or bag.get("cate") or bag.get("name") or "未知奖品")
                won.append(str(prize)[:40])
            elif code in (self.CODE_NO_DRAW, 700011) or "上限" in self._msg(rd) or "次数" in self._msg(rd):
                break
            else:
                fail += 1
                fail_desc = "%s:%s" % (code, self._msg(rd)[:80])
            time.sleep(1)

        if won:
            shown = "; ".join(won[:5]) + ("等" if len(won) > 5 else "")
            self.report.add("盲盒抽奖", "成功", "抽中%s项: %s" % (len(won), shown))
        if fail:
            self.report.add("盲盒抽奖", "失败",
                            "%s 次失败(最后错误 %s)" % (fail, fail_desc or "未知"))

        # 复查剩余次数(验证真实消耗)
        time.sleep(1)
        d2 = (self._request("GET", "/appapi/center/drawinfo2024").get("data") or {})
        left = int(d2.get("availDrawTimes", 0) or 0)
        if left != times:
            self.report.add("盲盒抽奖", "信息", "剩余可抽 %s 次(原 %s 次)" % (left, times))
        elif not won and not fail:
            self.report.add("盲盒抽奖", "提示", "抽奖未生效，请到 App 激励中心检查")

    # ==================== 测运势赢金钞(开学季活动, pan.baidu.com) ====================
    PAN_BASE = "https://pan.baidu.com"
    TAROT_TID = "127391789631"        # 塔罗测运势活动 tid
    LOTTERY_TID = "348651789463"      # 金钞抽奖组件 tid
    UA_WAP = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
              "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1")

    def _pan(self, method, path, params=None, form=None):
        """pan.baidu.com 活动接口(实测 wap 侧无需 Htj/jsToken 签名)。"""
        url = self.PAN_BASE + path
        headers = {"Cookie": self.cookie, "User-Agent": self.UA_WAP,
                   "Accept": "application/json, text/plain, */*",
                   "X-Requested-With": "XMLHttpRequest",
                   "Referer": self.PAN_BASE + "/operation/activitys/backToSchool/home"}
        try:
            if method.upper() == "POST":
                headers["Content-Type"] = "application/x-www-form-urlencoded"
                r = self.session.post(url, params=params, data=form, headers=headers, timeout=20)
            else:
                r = self.session.get(url, params=params, headers=headers, timeout=20)
            return r.json()
        except Exception as e:
            return {"errno": -1, "show_msg": "请求异常: %s" % e}

    # 活动任务 scene/skill 按 task_type 映射(198=PPT, 197=海报)
    TAROT_TASK_SKILL = {
        "198": ("generate_ppt", "ai_ppt_gen"),
        "197": ("", "ai_poster"),
    }

    def _tarot_task_prompt(self, task):
        """解析 task_extra.task_type_sup 作为 prompt(与 App 点"去完成"行为一致)，
        按 task_type 映射 scene/skill。返回 (prompt, scene, skill_id)。
        实测: prompt 必须用官方 task_type_sup, 否则服务端判定内容不匹配不归因。"""
        desc = str(task.get("task_desc") or "")
        ttype = str(task.get("task_type") or "")
        prompt = ""
        try:
            prompt = str((json.loads(task.get("task_extra") or "{}")).get("task_type_sup") or "")
        except (ValueError, AttributeError):
            pass
        if not prompt:  # 兜底
            prompt = "你好，请简单介绍一下你自己。" if "对话" in desc else ("帮我" + desc)
        scene, skill = self.TAROT_TASK_SKILL.get(ttype, ("", ""))
        return prompt, scene, skill

    def tarot_activity(self):
        """测运势赢金钞: 每日打卡 + 全主题测运势 + 活动任务归因 + 金钞抽奖。
        实测: start/result 裸参数即成功, 每天可测齐 4 个主题;
        每日打卡随测运势流程自动完成;
        活动任务通过 genflow/chat 带 actTaskId 归因(实测有效, 延迟约20秒);
        抽奖次数由任务/打卡累积。"""
        home = self._pan("GET", "/act/v2/tarot/home", params={"tid": self.TAROT_TID})
        d = home.get("data") or {}
        if int(home.get("errno", -1) if home.get("errno") is not None else -1) != 0 or not d:
            msg = home.get("show_msg") or home.get("errmsg") or "活动未开放或已结束"
            self.report.add("测运势", "提示", msg)
            self.stats["tarot"] = {"skip": "活动不可用"}
            return

        nickname = d.get("nickname") or "我是运势王"
        div = d.get("divination") or {}
        record = div.get("divination_record") or []
        if isinstance(record, str):
            try:
                record = json.loads(record)
            except ValueError:
                record = []
        record = [int(x) for x in record if str(x).isdigit()]

        # 1) 补齐今日未测主题(共4个: 1学业 2人际 3职场 4成长)
        new_done = 0
        for theme in (1, 2, 3, 4):
            if theme in record:
                continue
            st = self._pan("POST", "/act/v2/tarot/start",
                           form={"tid": self.TAROT_TID, "nickname": nickname,
                                 "theme": theme, "identity": 5})
            did = st.get("divination_id") or (st.get("data") or {}).get("divination_id")
            if int(st.get("errno", 0) or 0) == 0 and did:
                self._pan("POST", "/act/v2/tarot/result",
                          form={"tid": self.TAROT_TID, "divination_id": did})
                new_done += 1
            time.sleep(1.5)
        total_done = len(record) + new_done

        # 2) 活动日常任务: 未完成的逐个带 actTaskId 调 genflow 归因
        pending = [t for t in (d.get("task_list") or [])
                   if int(t.get("task_status") or 0) == 0]
        sent = []  # [(task_id_str, desc)]
        for t in pending:
            tid_str = str(t.get("task_id_str") or "")
            desc = str(t.get("task_desc") or "任务")
            if not tid_str:
                continue
            prompt, scene, skill = self._tarot_task_prompt(t)
            if self._genflow_chat(prompt, act_task_id=tid_str, scene=scene, skill_id=skill):
                sent.append((tid_str, desc))
            time.sleep(2)

        # 3) 归因延迟后统一刷新(测运势打卡 + 任务状态)
        if new_done or sent:
            time.sleep(25)
        after = self._pan("GET", "/act/v2/tarot/home", params={"tid": self.TAROT_TID})
        ad = after.get("data") or {}
        days = int(ad.get("continue_days") or 0)
        today_ck = next((c for c in (ad.get("checkin_list") or [])
                         if c.get("today") in (1, True, "1")), {})
        ck_ok = today_ck.get("status") in (1, True, "1") or days > 0
        ck = "已打卡(连续%s天)" % days if ck_ok else "打卡状态待确认"

        task_ok = {str(t.get("task_id_str")) for t in (ad.get("task_list") or [])
                   if int(t.get("task_status") or 0) != 0}
        done_desc = [desc for ids, desc in sent if ids in task_ok]
        fail_desc = [desc for ids, desc in sent if ids not in task_ok]
        # 未完成明细: 发送但未归因的 + 压根没发送成功的
        unsent = [str(t.get("task_desc") or "任务") for t in (ad.get("task_list") or [])
                  if int(t.get("task_status") or 0) == 0
                  and str(t.get("task_id_str")) not in {i for i, _ in sent}]
        act_undone = fail_desc + unsent

        detail = "%s；运势主题 %s/4" % (ck, total_done)
        if new_done:
            detail += "(本次新测%s个)" % new_done
        if done_desc:
            detail += "；活动任务归因%s个" % len(done_desc)
        self.report.add("测运势", "成功", detail)

        # 4) 金钞抽奖
        lh = self._pan("GET", "/act/v2/component/lottery/homeinfo",
                       params={"channel": "backToSchool", "comp_ver": "2",
                               "action": "lottery_cnt", "tid": self.LOTTERY_TID})
        cnt = int(((lh.get("data") or {}).get("lottery_cnt")) or 0)
        won, failed = [], False
        for _ in range(min(cnt, MAX_DRAW_ATTEMPTS)):
            rd = self._pan("POST", "/act/v2/component/lottery/lotterycommit",
                           form={"tid": self.LOTTERY_TID, "cnt": 1,
                                 "channel": "backToSchool", "version": "1.0.0"})
            if int(rd.get("errno", -1) if rd.get("errno") is not None else -1) != 0:
                failed = True
                break
            dd = rd.get("data") or {}
            name = (dd.get("prize_name") or dd.get("goods_name")
                    or (dd.get("prize") or {}).get("name") or dd.get("name") or "奖励")
            won.append(str(name)[:30])
            time.sleep(1)
        if won:
            self.report.add("金钞抽奖", "成功",
                            "抽中%s项: %s" % (len(won), "、".join(won[:5])))
        elif failed:
            self.report.add("金钞抽奖", "失败", "有%s次机会但抽奖请求被拒" % cnt)
        else:
            self.report.add("金钞抽奖", "信息", "当前无抽奖次数(做任务/连续打卡可获得)")

        self.stats["tarot"] = {"done": total_done, "total": 4,
                               "undone": act_undone}

    # ==================== 主流程 ====================
    def run(self):
        if not self.check_login():
            return self.report

        # 会员识别: 会员账号才启用 VIP 专属任务，非会员自动跳过
        is_vip = self.vip_status()
        self.stats["score_before"] = self._active_score()

        self.activecenter_sign()
        self.oneclick_receive()
        self.genflow_daily()        # AI每日任务(无会员门槛)
        self.vip_tasks(is_vip)      # VIP抽奖任务(会员自动做/非会员跳过)
        self.bean_tasks()           # 文库豆任务(无会员门槛)
        self.blind_box_draw(try_draw=self.cfg.draw_on)
        if self.cfg.tarot_on:
            self.tarot_activity()

        time.sleep(2)
        self.stats["score_after"] = self._active_score()

        self.report.add("执行汇总", "信息", self.report.summary())
        return self.report


# ---------------------- 主入口 ----------------------
def main():
    cfg = Config()
    if not cfg.cookies:
        print("未检测到 BAIDU_COOKIE 环境变量，请在青龙中配置。")
        print("格式: BDUSS=xxxxxx;  多账号换行分隔 (与百度网盘脚本共用)")
        return

    # 预检令牌签发(全部账号共用)
    token_mgr = TokenManager(cfg)
    token = token_mgr.get_token()
    if not token:
        print("警告: Htj 令牌签发失败，动作接口将被玉门关拦截。")
        print("请按脚本头部说明更新 BAIDU_WK_DR_PAYLOAD 指纹包。")

    all_summary = []
    for idx, ck in enumerate(cfg.cookies):
        banner = "===== 账号 %s =====" % (idx + 1)
        print("\n" + banner)
        wk = BaiduWenku(ck["BDUSS"], cfg, token_mgr)
        report = wk.run()

        lines = report.render()
        for line in lines:
            print(line)
        push = wk.push_summary()
        print("\n---------- 任务统计 ----------")
        print(push)
        all_summary.append(banner + "\n" + push)
        if idx < len(cfg.cookies) - 1:
            time.sleep(random.randint(3, 8))

    if cfg.notify_on:
        notify("百度文库每日任务", "\n\n".join(all_summary))
    print("\n全部账号执行完毕。")


if __name__ == "__main__":
    main()
