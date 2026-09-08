#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WPS 会员中心 自动签到 & 任务完成 & 抽奖 & 推送脚本
===================================================
功能：
  1. 每日签到（RSA + AES 加密，已验证可用）
  2. 自适应任务完成引擎 — 按任务类型自动选择策略，不硬编码任务ID
     - click / share / scan  → task_center.finish + reward（直接完成）
     - browse                → start → task_info → 等待 → task_finish → reward
     - exchange_traffic      → start → 访问jump_url+token → finish → reward
     - toReceive(待领奖)      → 直接 reward
     - 其余类型(trade/auth/invite/subscribe等) → 跳过并提示
     - 未知类型               → 多策略降级尝试（finish→browse→traffic）
  3. 多轮循环检测新任务 — 处理完一轮后重新拉取任务列表，自动发现新解锁的任务
     - 已处理任务ID去重，避免重复执行
     - 最大轮次保护（默认5轮），防止无限循环
     - 每轮间隔等待服务端状态更新
  4. 自动抽奖 — 消耗所有可用抽奖次数，自动执行九宫格抽奖
  5. WXPusher 推送 — 配置 WXPUSHER_APP_TOKEN + WXPUSHER_UIDS 两个环境变量即可
     - HTML 精美卡片格式
     - 失败自动重试（3次，指数退避）
     - 多账号自动汇总为一条推送
     - 登录失效即时告警
  6. 任务变更后仍能自适应处理（按 task_event + task_status 分发 + 多轮检测）

依赖：
  pip install requests pycryptodome

用法：
  方式一（环境变量，推荐，适配青龙面板）：
    export WPS_COOKIE="账号1的Cookie"
    多账号用换行或 & 分隔：
    export WPS_COOKIE="账号1cookie
账号2cookie"
  方式二（直接编辑脚本）：将下方 DEFAULT_COOKIE 改为你自己的 Cookie
  然后运行：python3 wps_auto.py

获取 Cookie 方法：
  浏览器登录 WPS 个人中心（account.wps.cn），F12 -> Network ->
  随便找一个请求，复制 Request Headers 中的 Cookie 值。
"""

import requests
import json
import time
import random
import string
import base64
import re
import sys
import os
from datetime import datetime

from Crypto.PublicKey import RSA
from Crypto.Cipher import PKCS1_v1_5, AES
from Crypto.Util.Padding import pad


def load_project_env(env_path=None):
    """读取项目自身 .env，并写入当前进程环境变量。

    已存在的系统环境变量优先，.env 只补充缺省值，避免覆盖青龙或手动导出的变量。
    """
    if env_path is None:
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")

    values = {}
    if not os.path.exists(env_path):
        return values

    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            values[key] = value
            os.environ.setdefault(key, value)
    return values


load_project_env()

# ======================== 配置区 ========================
# 优先从环境变量 WPS_COOKIE 读取（适配青龙面板，多账号用换行或 & 分隔）
DEFAULT_COOKIE = ""
COOKIE = os.getenv("WPS_COOKIE", DEFAULT_COOKIE)

# 活动地址（一般无需修改）
ACTIVITY_NUMBER = "HD2025031821201822"
PAGE_NUMBER = "YM2025040908558269"
# 任务中心组件标识（来自 page_info，一般无需修改）
COMPONENT_NUMBER = "ZJ2025040709458367"
COMPONENT_NODE_ID = "FN1744160180RthG"
COMPONENT_TYPE = 35
# 抽奖组件标识（来自 page_info，一般无需修改）
LOTTERY_NUMBER = "ZJ2025092916516585"
LOTTERY_NODE_ID = "FN1762345949vdR1"
LOTTERY_TYPE = 45
FILTER_PARAMS = {"position": "ad_rwzx_invite_test", "token": "61b3f3ab86984a191927bfe7748b85a5"}

# 浏览任务等待冗余秒数
BROWSE_EXTRA_WAIT = 3
# 请求间隔（秒）
REQUEST_INTERVAL = 1.5
# finish 后等待秒数（前端默认3秒后刷新状态）
FINISH_DELAY = 3
# 抽奖每次间隔（秒）
LOTTERY_INTERVAL = 2
# 是否执行签到
DO_SIGN_IN = True
# 是否执行自动抽奖
DO_LOTTERY = True
# 任务检测最大轮次（防止无限循环，每轮重新拉取任务列表）
MAX_TASK_ROUNDS = 5
# 未知任务是否启用多策略降级尝试
UNKNOWN_TASK_FALLBACK = True

# ====== WXPusher 推送配置 ======
# 只需配置两个环境变量即可（适配青龙面板）：
#   WXPUSHER_APP_TOKEN = AT_xxx  （应用Token）
#   WXPUSHER_UIDS      = UID_xxx  （用户UID，多个用逗号分隔）
# 两个都配置了才会推送，留空则仅控制台输出
WXPUSHER_APP_TOKEN = os.getenv("WXPUSHER_APP_TOKEN", "").strip()
WXPUSHER_UIDS = os.getenv("WXPUSHER_UIDS", os.getenv("WXPUSHER_UID", "")).strip()
# 推送开关（自动判断，无需手动修改）
DO_PUSH = bool(WXPUSHER_APP_TOKEN and WXPUSHER_UIDS)
# ======================== 配置区结束 ========================

# 任务状态枚举
TASK_UNDONE = 0       # 未完成
TASK_TO_RECEIVE = 1   # 待领奖
TASK_DONE = 2         # 已完成

# 可直接 finish 完成的任务类型
FINISH_TYPES = {"click", "share", "scan"}
# 浏览类任务
BROWSE_TYPES = {"browse"}
# 三方换量任务
TRAFFIC_TYPES = {"exchange_traffic"}
# 无法自动完成的任务类型
MANUAL_TYPES = {"trade", "auth", "invite", "subscribe", "improve",
                "promotional", "accrue", "visit_current", "reservation",
                "desktop_install", "desktop_visit"}


# ----------------------- 日志 -----------------------
class Log:
    @staticmethod
    def _ts():
        return datetime.now().strftime("%H:%M:%S")

    @staticmethod
    def info(msg):
        print(f"[{Log._ts()}] [*] {msg}")

    @staticmethod
    def ok(msg):
        print(f"[{Log._ts()}] [+] {msg}")

    @staticmethod
    def warn(msg):
        print(f"[{Log._ts()}] [!] {msg}")

    @staticmethod
    def fail(msg):
        print(f"[{Log._ts()}] [-] {msg}")

    @staticmethod
    def step(msg):
        print(f"\n{'='*52}\n[{Log._ts()}] >>> {msg}\n{'='*52}")


# ----------------------- WXPusher 推送 -----------------------
class WxPusher:
    """WXPusher 消息推送（https://wxpusher.zjiecode.com/）
    只需 appToken + uids 两个参数即可使用，HTML 格式，自动重试
    """
    API_URL = "https://wxpusher.zjiecode.com/api/send/message"

    def __init__(self, app_token, uids):
        """
        app_token: 应用token (AT_xxx)
        uids: 用户UID，多个用英文逗号分隔 (UID_xxx,UID_yyy)
        """
        self.app_token = app_token.strip()
        # 解析 UID 列表（兼容中英文逗号）
        self.uids = [u.strip() for u in uids.replace("，", ",").split(",") if u.strip()]
        self.enabled = bool(self.app_token and self.uids)
        self._retry = 3  # 失败重试次数

    def _build_body(self, content, summary=""):
        """构造请求体（HTML格式）"""
        body = {
            "appToken": self.app_token,
            "content": content,
            "contentType": 2,  # 2=HTML，渲染效果最好
            "uids": self.uids,
        }
        if summary:
            body["summary"] = summary[:100]
        return body

    def send(self, content, summary="WPS任务通知"):
        """发送消息，失败自动重试
        返回 True/False
        """
        if not self.enabled:
            return False
        body = self._build_body(content, summary)
        last_error = ""
        for attempt in range(1, self._retry + 1):
            try:
                r = requests.post(self.API_URL, json=body, timeout=20)
                d = r.json()
                if d.get("code") == 1000:
                    Log.ok(f"WXPusher 推送成功")
                    return True
                last_error = f"code={d.get('code')} msg={d.get('msg', '未知错误')}"
                Log.warn(f"WXPusher 推送失败（第{attempt}/{self._retry}次）：{last_error}")
            except Exception as e:
                last_error = str(e)
                Log.warn(f"WXPusher 推送异常（第{attempt}/{self._retry}次）：{e}")
            if attempt < self._retry:
                time.sleep(2 * attempt)  # 指数退避
        Log.fail(f"WXPusher 推送最终失败：{last_error}")
        return False

    def send_report(self, title, sections):
        """发送 HTML 格式报告
        sections: list of (heading, items) 或 list of str（兼容旧接口）
        """
        if not self.enabled:
            Log.info("未配置 WXPusher，跳过推送")
            return False

        # 兼容旧接口：如果 sections 是字符串列表，转成单 section 格式
        if sections and isinstance(sections[0], str):
            sections = [("任务报告", sections)]

        html = ['<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;padding:10px;">']
        html.append(f'<h2 style="color:#2c7be5;margin-top:0;margin-bottom:12px;">{title}</h2>')
        for heading, items in sections:
            html.append(f'<h3 style="color:#333;margin:14px 0 8px;border-left:4px solid #2c7be5;padding-left:10px;font-size:16px;">{heading}</h3>')
            html.append('<div style="line-height:2;color:#444;font-size:14px;">')
            for item in items:
                html.append(f'<div>{item}</div>')
            html.append('</div>')
        html.append(f'<div style="margin-top:18px;color:#999;font-size:12px;border-top:1px solid #eee;padding-top:10px;text-align:right;">')
        html.append(f'WPS Auto · {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
        html.append('</div></div>')

        return self.send("\n".join(html), summary=title)


# ----------------------- 加密工具 -----------------------
def gen_aes_key():
    rnd = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(22))
    ts = str(int(time.time()))
    return rnd + ts


def rsa_encrypt(plain, pem):
    key = RSA.import_key(pem)
    cipher = PKCS1_v1_5.new(key)
    return base64.b64encode(cipher.encrypt(plain.encode())).decode()


def aes_encrypt(payload_str, aes_key):
    key = aes_key.encode()
    iv = aes_key[:16].encode()
    cipher = AES.new(key, AES.MODE_CBC, iv)
    ct = cipher.encrypt(pad(payload_str.encode(), AES.block_size))
    return base64.b64encode(ct).decode()


# ----------------------- 主类 -----------------------
class WpsAuto:
    SIGN_BASE = "https://personal-bus.wps.cn/sign_in/v1"
    ACT_BASE = "https://personal-act.wps.cn/activity-rubik"

    def __init__(self, cookie):
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
            "Referer": f"https://personal-act.wps.cn/rubik2/portal/{ACTIVITY_NUMBER}/{PAGE_NUMBER}",
            "Origin": "https://personal-act.wps.cn",
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
        })
        for item in cookie.split(";"):
            item = item.strip()
            if "=" in item:
                k, v = item.split("=", 1)
                self.s.cookies.set(k, v, domain=".wps.cn")
        self.user_id = self._extract_uid(cookie)
        self.csrf = self.s.cookies.get("csrf", "")
        self.stats = {"ok": 0, "skip": 0, "fail": 0, "new_found": 0}
        self.lottery_rewards = []
        self.nickname = ""
        self.pusher = WxPusher(WXPUSHER_APP_TOKEN, WXPUSHER_UIDS)
        # 积分追踪
        self.integral_start = 0  # 执行前积分
        self.integral_end = 0    # 执行后积分
        # 已处理过的任务ID集合（用于循环检测时跳过已处理的）
        self._processed_task_ids = set()
        # 记录每轮发现的新任务数量
        self._round_new_count = 0

    @staticmethod
    def _extract_uid(cookie):
        m = re.search(r'uid=(\d+)', cookie)
        return int(m.group(1)) if m else 0

    def _sleep(self, t=None):
        time.sleep(t if t else REQUEST_INTERVAL)

    def _act_csrf(self):
        return self.s.cookies.get("act_csrf_token", "")

    # ---------- 鉴权 ----------
    def check_login(self):
        r = self.s.post("https://account.wps.cn/p/auth/check",
                        headers={"X-CSRFToken": self.csrf}, json={}, timeout=15)
        d = r.json()
        if d.get("result") == "ok":
            self.nickname = d.get("nickname", "") or "未设置"
            Log.ok(f"账号登录有效，用户：{self.nickname}（uid={d.get('userid', self.user_id)}）")
            return True
        Log.fail(f"账号登录失效：{d.get('result', '')} {d.get('msg', '')}")
        return False

    # ---------- 签到 ----------
    def get_sign_stat(self):
        r = self.s.get(f"{self.SIGN_BASE}/user_stat", params={"channel": ""}, timeout=20)
        d = r.json().get("data", {}) or {}
        Log.info(f"签到状态：今日已签={d.get('has_signed')} 本月连续={d.get('month_continuous_days')}天 "
                 f"累计={d.get('total_cumulative_days')}天")
        return d

    def _build_encrypt_payload(self):
        r = self.s.get(f"{self.SIGN_BASE}/encrypt/key", timeout=20)
        pem = base64.b64decode(r.json()["data"]).decode()
        aes_key = gen_aes_key()
        token = rsa_encrypt(aes_key, pem)
        payload = json.dumps({"user_id": self.user_id, "platform": 8})
        extra = aes_encrypt(payload, aes_key)
        return token, extra

    def sign_in(self):
        Log.step("开始每日签到")
        stat = self.get_sign_stat()
        if stat.get("has_signed"):
            Log.ok("今日已签到，跳过")
            return True
        try:
            token, extra = self._build_encrypt_payload()
        except Exception as e:
            Log.fail(f"加密参数构造失败：{e}")
            return False
        body = {"encrypt": True, "extra": extra, "pay_origin": "ad_ucs_rwzx sign", "channel": ""}
        r = self.s.post(f"{self.SIGN_BASE}/sign_in", headers={"token": token}, json=body, timeout=20)
        d = r.json()
        if d.get("result") == "ok":
            data = d.get("data", {}) or {}
            rewards = data.get("reward_list") or []
            rwd = "、".join([x.get("title", "") for x in rewards]) or "积分奖励"
            Log.ok(f"签到成功！获得：{rwd}")
            return True
        Log.fail(f"签到失败：{d.get('msg', r.text[:120])}")
        return False

    # ---------- 任务中心 ----------
    def get_tasks(self):
        r = self.s.get(f"{self.ACT_BASE}/activity/page_info",
                       params={"activity_number": ACTIVITY_NUMBER, "page_number": PAGE_NUMBER,
                               "filter_params": json.dumps(FILTER_PARAMS)}, timeout=20)
        data = r.json().get("data", []) or []
        for c in data:
            tc = c.get("task_center") or {}
            if tc.get("task_list"):
                return tc["task_list"]
        return []

    def _comp_action(self, bus_info):
        body = {
            "component_uniq_number": {
                "activity_number": ACTIVITY_NUMBER,
                "page_number": PAGE_NUMBER,
                "component_number": COMPONENT_NUMBER,
                "component_node_id": COMPONENT_NODE_ID,
                "filter_params": FILTER_PARAMS,
            },
            "component_type": COMPONENT_TYPE,
            **bus_info,
        }
        r = self.s.post(f"{self.ACT_BASE}/activity/component_action",
                        headers={"X-Act-Csrf-Token": self._act_csrf()}, json=body, timeout=20)
        d = r.json()
        tc = (d.get("data") or {}).get("task_center") or {}
        return d, tc

    def _do_reward(self, task_id, title=""):
        d, tc = self._comp_action({"component_action": "task_center.reward",
                                   "task_center": {"task_id": task_id}})
        if tc.get("success"):
            Log.ok(f"[{title}] 奖励领取成功")
            self.stats["ok"] += 1
            return True
        Log.warn(f"[{title}] 领奖 success={tc.get('success')} status={tc.get('status')}")
        self.stats["fail"] += 1
        return False

    def _do_finish_and_reward(self, task):
        """click/share/scan 类任务：finish → reward"""
        tid = task["task_id"]
        title = task.get("title", "")
        d, tc = self._comp_action({"component_action": "task_center.finish",
                                   "task_center": {"task_id": tid}})
        if not tc.get("success"):
            Log.fail(f"[{title}] finish 失败 status={tc.get('status')} reason={tc.get('reason','')}")
            self.stats["fail"] += 1
            return False
        Log.info(f"[{title}] finish 成功，等待 {FINISH_DELAY}s 后领奖")
        time.sleep(FINISH_DELAY)
        return self._do_reward(tid, title)

    def _do_browse_task(self, task):
        """browse 类任务：start → task_info → 等待 → task_finish → reward"""
        tid = task["task_id"]
        title = task.get("title", "")
        d, tc = self._comp_action({"component_action": "task_center.start",
                                   "task_center": {"task_id": tid}})
        token = tc.get("token", "")
        if not token:
            Log.fail(f"[{title}] start 失败：{d.get('msg', '')} {tc.get('reason', '')}")
            self.stats["fail"] += 1
            return False
        batch_tag = int(time.time() * 1000)
        r = self.s.get(f"{self.ACT_BASE}/user/task_center/task_info",
                       params={"batch_tag": batch_tag, "token": token}, timeout=20)
        info = r.json().get("data", {}) or {}
        browse_second = info.get("browse_second", 10)
        start_at = info.get("start_at", 0)
        Log.info(f"[{title}] 浏览中，需等待 {browse_second} 秒")
        time.sleep(browse_second + BROWSE_EXTRA_WAIT)
        r = self.s.post(f"{self.ACT_BASE}/user/task_center/task_finish",
                        headers={"X-Act-Csrf-Token": self._act_csrf()},
                        json={"batch_tag": batch_tag + start_at, "token": token}, timeout=20)
        state = (r.json().get("data") or {}).get("state")
        if state != 1:
            Log.fail(f"[{title}] task_finish 未完成 state={state}")
            self.stats["fail"] += 1
            return False
        self._sleep()
        return self._do_reward(tid, title)

    def _do_traffic_task(self, task):
        """exchange_traffic 类任务：start → 访问jump_url+token → finish → reward"""
        tid = task["task_id"]
        title = task.get("title", "")
        d, tc = self._comp_action({"component_action": "task_center.start",
                                   "task_center": {"task_id": tid}})
        token = tc.get("token", "")
        jump_url = task.get("jump_url", "")
        if token and jump_url:
            full_url = f"{jump_url}{token}"
            Log.info(f"[{title}] 访问换量页面: {jump_url[:60]}...")
            try:
                self.s.get(full_url, timeout=15, allow_redirects=True)
            except Exception:
                pass
            time.sleep(2)
        self._sleep()
        d, tc = self._comp_action({"component_action": "task_center.finish",
                                   "task_center": {"task_id": tid}})
        if tc.get("success"):
            Log.info(f"[{title}] finish 成功，等待领奖")
            time.sleep(FINISH_DELAY)
            return self._do_reward(tid, title)
        Log.warn(f"[{title}] finish 未成功 status={tc.get('status')}（可能需在目标App内操作）")
        self.stats["fail"] += 1
        return False

    def _try_fallback_strategies(self, task):
        """未知类型任务的多策略降级尝试：finish → browse → traffic
        只要有一种策略成功（领奖成功）就算成功
        """
        tid = task["task_id"]
        title = task.get("title", "")

        # 策略1：尝试直接 finish + reward
        Log.info(f"[{title}] 策略1/3：尝试直接 finish")
        result = self._do_finish_and_reward(task)
        if result:
            Log.ok(f"[{title}] 策略1 成功")
            return True
        self._sleep()

        # 策略2：尝试 browse 流程（start → 等待 → finish → reward）
        Log.info(f"[{title}] 策略2/3：尝试 browse 流程")
        result = self._do_browse_task(task)
        if result:
            Log.ok(f"[{title}] 策略2 成功（browse方式）")
            return True
        self._sleep()

        # 策略3：尝试 exchange_traffic 流程
        Log.info(f"[{title}] 策略3/3：尝试 traffic 流程")
        result = self._do_traffic_task(task)
        if result:
            Log.ok(f"[{title}] 策略3 成功（traffic方式）")
            return True

        Log.warn(f"[{title}] 所有降级策略均失败，标记为无法自动完成")
        return False

    def _dispatch_task(self, task):
        """自适应任务分发：按 task_event + task_status 选择策略"""
        tid = task["task_id"]
        title = task.get("title", "")
        event = task.get("task_event", "")
        status = task.get("task_status", 0)

        # 已完成
        if status == TASK_DONE:
            self.stats["skip"] += 1
            return
        # 待领奖 → 直接领
        if status == TASK_TO_RECEIVE:
            Log.info(f"[{title}] 待领奖，直接领取")
            self._do_reward(tid, title)
            self._sleep()
            return
        # 未完成 → 按类型分发
        if event in FINISH_TYPES:
            Log.info(f"[{title}] click/share类，直接finish")
            self._do_finish_and_reward(task)
            self._sleep()
        elif event in BROWSE_TYPES:
            self._do_browse_task(task)
            self._sleep()
        elif event in TRAFFIC_TYPES:
            self._do_traffic_task(task)
            self._sleep()
        elif event in MANUAL_TYPES:
            Log.warn(f"[{title}] 类型={event}，需手动完成（{task.get('rewards', '')}）")
            self.stats["skip"] += 1
        else:
            # 未知类型
            if UNKNOWN_TASK_FALLBACK:
                Log.info(f"[{title}] 未知类型={event}，启用多策略降级尝试")
                success = self._try_fallback_strategies(task)
                if not success:
                    self.stats["fail"] += 1
            else:
                Log.info(f"[{title}] 未知类型={event}，尝试finish")
                self._do_finish_and_reward(task)
                self._sleep()

    def _get_undone_tasks(self, tasks):
        """从任务列表中筛选出未完成且未处理过的任务"""
        undone = []
        for t in tasks:
            tid = t.get("task_id")
            status = t.get("task_status", 0)
            # 只处理未完成或待领奖，且之前没处理过的任务
            if status in (TASK_UNDONE, TASK_TO_RECEIVE) and tid not in self._processed_task_ids:
                undone.append(t)
        return undone

    def show_tasks(self, tasks):
        status_map = {0: "未完成", 1: "待领奖", 2: "已完成", 3: "无库存", 4: "过期", 7: "未完成"}
        Log.step("任务清单")
        print(f"{'ID':>4} {'状态':<6} {'类型':<16} 标题")
        print("-" * 60)
        for t in tasks:
            st = status_map.get(t.get("task_status", 0), str(t.get("task_status")))
            print(f"{t['task_id']:>4} {st:<6} {t.get('task_event',''):<16} {t.get('title','')}")

    def _verify_task_status(self, task_id):
        """验证单个任务的最新状态（用于确认处理结果）"""
        try:
            tasks = self.get_tasks()
            for t in tasks:
                if t.get("task_id") == task_id:
                    return t.get("task_status", -1)
        except Exception:
            pass
        return -1

    def run_tasks(self):
        """自适应任务处理引擎：
        1. 多轮循环检测新任务（处理完一轮后重新拉取列表）
        2. 每轮只处理新发现的未完成任务
        3. 有最大轮次保护，防止无限循环
        """
        Log.step("开始处理任务（自适应多轮检测模式）")
        self._processed_task_ids = set()
        round_num = 0
        total_new_found = 0

        while round_num < MAX_TASK_ROUNDS:
            round_num += 1
            # 拉取最新任务列表
            try:
                tasks = self.get_tasks()
            except Exception as e:
                Log.fail(f"第 {round_num} 轮获取任务列表失败：{e}")
                break

            if not tasks:
                Log.warn("未获取到任务列表，结束任务处理")
                break

            # 筛选出本轮新增的未完成任务
            new_undone = self._get_undone_tasks(tasks)
            new_count = len(new_undone)

            if round_num == 1:
                # 第一轮展示完整任务清单
                self.show_tasks(tasks)
                Log.info(f"第 {round_num}/{MAX_TASK_ROUNDS} 轮：待处理 {new_count} 个（共 {len(tasks)} 个任务）")
            else:
                if new_count == 0:
                    Log.info(f"第 {round_num}/{MAX_TASK_ROUNDS} 轮：未发现新任务，结束循环")
                    break
                Log.info(f"第 {round_num}/{MAX_TASK_ROUNDS} 轮：发现 {new_count} 个新出现的任务，开始处理")
                # 展示新任务
                print(f"  {'ID':>4} {'状态':<6} {'类型':<16} 标题")
                print("  " + "-" * 56)
                for t in new_undone:
                    st_map = {0: "未完成", 1: "待领奖", 2: "已完成"}
                    st = st_map.get(t.get("task_status", 0), str(t.get("task_status")))
                    print(f"  {t['task_id']:>4} {st:<6} {t.get('task_event',''):<16} {t.get('title','')}")

            total_new_found += new_count

            if new_count == 0:
                # 第一轮就没有待处理的
                if round_num == 1:
                    Log.ok("所有任务均已完成")
                break

            # 处理本轮的新任务
            for t in new_undone:
                tid = t.get("task_id")
                # 标记为已处理（即使失败也不再重试，避免死循环）
                self._processed_task_ids.add(tid)
                self._dispatch_task(t)

            # 每轮结束后稍作等待，让服务端状态更新
            if round_num < MAX_TASK_ROUNDS:
                Log.info(f"第 {round_num} 轮处理完毕，等待 {FINISH_DELAY + 1}s 后检测是否有新任务...")
                time.sleep(FINISH_DELAY + 1)

        self.stats["new_found"] = total_new_found

        # 最终汇总
        Log.step(f"任务完成汇总：成功 {self.stats['ok']} / 跳过 {self.stats['skip']} / "
                 f"失败 {self.stats['fail']} / 共发现 {total_new_found} 个待处理任务")
        if round_num >= MAX_TASK_ROUNDS:
            Log.warn(f"已达到最大轮次限制（{MAX_TASK_ROUNDS}轮），停止检测")

    # ---------- 抽奖 ----------
    def get_lottery_info(self):
        """从 page_info 获取抽奖组件信息"""
        r = self.s.get(f"{self.ACT_BASE}/activity/page_info",
                       params={"activity_number": ACTIVITY_NUMBER, "page_number": PAGE_NUMBER,
                               "filter_params": json.dumps(FILTER_PARAMS)}, timeout=20)
        data = r.json().get("data", []) or []
        for c in data:
            lv2 = c.get("lottery_v2")
            if lv2:
                return lv2
        return None

    def get_integral(self):
        """获取当前积分（从抽奖组件读取）"""
        try:
            info = self.get_lottery_info()
            if info:
                return int(info.get("integral", 0))
        except Exception:
            pass
        return 0

    def _do_lottery_draw(self, session_id):
        """执行一次抽奖"""
        body = {
            "component_uniq_number": {
                "activity_number": ACTIVITY_NUMBER,
                "page_number": PAGE_NUMBER,
                "component_number": LOTTERY_NUMBER,
                "component_node_id": LOTTERY_NODE_ID,
                "filter_params": FILTER_PARAMS,
            },
            "component_type": LOTTERY_TYPE,
            "component_action": "lottery_v2.exec",
            "lottery_v2": {"session_id": session_id},
        }
        r = self.s.post(f"{self.ACT_BASE}/activity/component_action",
                        headers={"X-Act-Csrf-Token": self._act_csrf()}, json=body, timeout=20)
        d = r.json()
        lv2 = (d.get("data") or {}).get("lottery_v2") or {}
        return d, lv2

    def run_lottery(self):
        """自动执行抽奖，消耗所有可用次数"""
        if not DO_LOTTERY:
            return
        Log.step("开始自动抽奖")
        info = self.get_lottery_info()
        if not info:
            Log.warn("未获取到抽奖组件信息")
            return
        integral = info.get("integral", 0)
        Log.info(f"当前积分：{integral}")
        sessions = info.get("lottery_list", []) or []
        active = [s for s in sessions if s.get("session_status") == "IN_PROGRESS" and s.get("times", 0) > 0]
        if not active:
            Log.ok("无可用抽奖次数")
            return
        for s in active:
            sid = s["session_id"]
            times = s.get("times", 0)
            stype = s.get("lottery_type", 0)
            Log.info(f"场次 {sid}：剩余 {times} 次，类型={'积分' if stype else '次数'}抽奖")
            for i in range(times):
                d, lv2 = self._do_lottery_draw(sid)
                success = lv2.get("success")
                reward = lv2.get("reward_name", "")
                rtype = lv2.get("reward_type", "")
                err = lv2.get("error_code", 0)
                if success:
                    Log.ok(f"第 {i+1}/{times} 次抽奖：中奖 {reward}（{rtype}）")
                    self.lottery_rewards.append(reward)
                else:
                    Log.fail(f"第 {i+1}/{times} 次抽奖失败：err={err} msg={d.get('msg','')}")
                    if err in (10005, 10007):  # 次数用完/达到最大中奖数
                        break
                time.sleep(LOTTERY_INTERVAL)
        if self.lottery_rewards:
            summary = "、".join(self.lottery_rewards)
            Log.ok(f"抽奖完毕，共中奖 {len(self.lottery_rewards)} 次：{summary}")
        else:
            Log.info("本次未中奖")

    def _build_report_dict(self):
        """构建结构化报告数据（用于汇总推送）"""
        report = {
            "nickname": self.nickname,
            "user_id": self.user_id,
            "sign_ok": False,
            "sign_days": {"continuous": 0, "total": 0},
            "tasks": dict(self.stats),
            "lottery_rewards": list(self.lottery_rewards),
            "login_ok": bool(self.nickname),
            "error": "",
        }
        try:
            stat = self.get_sign_stat()
            report["sign_ok"] = bool(stat.get("has_signed"))
            report["sign_days"]["continuous"] = stat.get("month_continuous_days", 0)
            report["sign_days"]["total"] = stat.get("total_cumulative_days", 0)
        except Exception:
            pass
        return report

    def _build_report(self):
        """构建推送报告内容（纯文本行列表）"""
        items = [f"**用户**：{self.nickname}（uid={self.user_id}）"]
        try:
            stat = self.get_sign_stat()
            items.append(f"**签到**：{'已签到' if stat.get('has_signed') else '未签到'} "
                         f"连续{stat.get('month_continuous_days',0)}天 "
                         f"累计{stat.get('total_cumulative_days',0)}天")
        except Exception:
            pass
        items.append(f"**任务**：成功 {self.stats['ok']} / 跳过 {self.stats['skip']} / 失败 {self.stats['fail']} "
                     f"（共处理 {self.stats.get('new_found', 0)} 个待处理任务）")
        if self.lottery_rewards:
            items.append(f"**抽奖**：共中奖 {len(self.lottery_rewards)} 次")
            from collections import Counter
            cnt = Counter(self.lottery_rewards)
            for name, num in cnt.items():
                items.append(f"  - {name} x{num}")
        else:
            items.append("**抽奖**：无可用次数或未中奖")
        # 积分信息
        today_gain = max(0, self.integral_end - self.integral_start)
        items.append(f"**积分**：总积分：{self.integral_end} / 今日获得{today_gain}")
        items.append(f"\n*执行时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*")
        return items

    def run(self, push_now=None):
        """执行全部流程
        push_now: True=立即推送, False=不推送, None=自动判断
        返回报告字典
        """
        Log.step("WPS 自动签到 & 任务")
        report = {"nickname": "", "user_id": self.user_id, "login_ok": False,
                  "sign_ok": False, "sign_days": {"continuous": 0, "total": 0},
                  "tasks": {"ok": 0, "skip": 0, "fail": 0, "new_found": 0},
                  "lottery_rewards": [], "integral_start": 0, "integral_end": 0,
                  "error": ""}

        if not self.check_login():
            report["error"] = "登录失效"
            # 登录失败立即推送告警
            if DO_PUSH:
                try:
                    self.pusher.send(
                        f"⚠️ WPS账号登录失效\n\n用户ID：{self.user_id}\n时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
                        summary="WPS登录失败"
                    )
                except Exception as e:
                    Log.fail(f"推送异常：{e}")
            return report

        report["login_ok"] = True
        report["nickname"] = self.nickname

        # 记录执行前积分
        self.integral_start = self.get_integral()
        report["integral_start"] = self.integral_start

        try:
            if DO_SIGN_IN:
                self.sign_in()
        except Exception as e:
            Log.fail(f"签到异常：{e}")
            report["error"] += f"签到异常:{e}; "
        try:
            self.run_tasks()
        except Exception as e:
            Log.fail(f"任务异常：{e}")
            report["error"] += f"任务异常:{e}; "
        try:
            self.run_lottery()
        except Exception as e:
            Log.fail(f"抽奖异常：{e}")
            report["error"] += f"抽奖异常:{e}; "
        try:
            Log.step("执行完毕，最终签到状态")
            stat = self.get_sign_stat()
            report["sign_ok"] = bool(stat.get("has_signed"))
            report["sign_days"]["continuous"] = stat.get("month_continuous_days", 0)
            report["sign_days"]["total"] = stat.get("total_cumulative_days", 0)
        except Exception:
            pass

        # 记录执行后积分
        self.integral_end = self.get_integral()
        report["integral_end"] = self.integral_end

        # 填充报告数据
        report["tasks"] = dict(self.stats)
        report["lottery_rewards"] = list(self.lottery_rewards)

        # 判断是否立即推送
        # push_now=True 强制推送, push_now=False 不推送, None=自动判断
        if push_now is None:
            should_push = True
        else:
            should_push = push_now
        if DO_PUSH and should_push:
            try:
                self.pusher.send_report("WPS", self._build_report())
            except Exception as e:
                Log.fail(f"推送异常：{e}")

        Log.ok("全部流程结束")
        return report


def parse_cookies(raw):
    if not raw:
        return []
    parts = re.split(r'[\n&]+', raw)
    return [p.strip() for p in parts if p.strip()]


def push_summary_report(all_reports):
    """多账号汇总推送 — 把所有账号的结果汇总到一条消息里推送"""
    if not DO_PUSH or not all_reports:
        return
    pusher = WxPusher(WXPUSHER_APP_TOKEN, WXPUSHER_UIDS)
    if not pusher.enabled:
        return

    total_accounts = len(all_reports)
    login_ok = sum(1 for r in all_reports if r["login_ok"])
    total_ok = sum(r["tasks"].get("ok", 0) for r in all_reports)
    total_fail = sum(r["tasks"].get("fail", 0) for r in all_reports)
    total_skip = sum(r["tasks"].get("skip", 0) for r in all_reports)
    total_new = sum(r["tasks"].get("new_found", 0) for r in all_reports)
    total_lottery = sum(len(r.get("lottery_rewards", [])) for r in all_reports)
    total_integral = sum(r.get("integral_end", 0) for r in all_reports)
    total_gain = sum(max(0, r.get("integral_end", 0) - r.get("integral_start", 0)) for r in all_reports)

    # 概览 section
    overview = [
        f"📊 账号总数：<b>{total_accounts}</b> 个（登录成功 {login_ok} 个）",
        f"✅ 任务成功：<b style='color:#28a745;'>{total_ok}</b> 次",
        f"❌ 任务失败：<b style='color:#dc3545;'>{total_fail}</b> 次",
        f"⏭️ 任务跳过：{total_skip} 次",
        f"🔍 发现任务：{total_new} 个",
        f"🎰 抽奖中奖：{total_lottery} 次",
        f"💰 总积分：{total_integral} / 今日获得：{total_gain}",
    ]

    # 每个账号明细
    sections = [("📈 执行概览", overview)]

    from collections import Counter
    for idx, rpt in enumerate(all_reports, 1):
        name = rpt.get("nickname") or f"账号{idx}"
        uid = rpt.get("user_id", 0)
        detail_lines = []

        if not rpt.get("login_ok"):
            detail_lines.append(f"<span style='color:#dc3545;'>❌ 登录失效</span>（uid={uid}）")
            if rpt.get("error"):
                detail_lines.append(f"错误：{rpt['error']}")
            sections.append((f"账号 {idx}：{name}", detail_lines))
            continue

        sd = rpt.get("sign_days", {})
        sign_status = "✅ 已签到" if rpt.get("sign_ok") else "❌ 未签到"
        detail_lines.append(f"{sign_status} · 连续{sd.get('continuous',0)}天 · 累计{sd.get('total',0)}天")

        t = rpt.get("tasks", {})
        detail_lines.append(
            f"任务：成功{t.get('ok',0)} / 跳过{t.get('skip',0)} / 失败{t.get('fail',0)} "
            f"（共处理{t.get('new_found',0)}个）"
        )

        rewards = rpt.get("lottery_rewards", [])
        if rewards:
            cnt = Counter(rewards)
            reward_str = "、".join(f"{n}x{num}" for n, num in cnt.items())
            detail_lines.append(f"🎰 抽奖中奖 {len(rewards)} 次：{reward_str}")
        else:
            detail_lines.append("🎰 抽奖：无可用次数或未中奖")

        # 积分信息
        int_end = rpt.get("integral_end", 0)
        int_gain = max(0, int_end - rpt.get("integral_start", 0))
        detail_lines.append(f"💰 积分：总{int_end} / 今日+{int_gain}")

        if rpt.get("error"):
            detail_lines.append(f"<span style='color:#ffc107;'>⚠️ 异常：{rpt['error']}</span>")

        sections.append((f"账号 {idx}：{name}（uid={uid}）", detail_lines))

    Log.step("推送多账号汇总报告")
    pusher.send_report("WPS", sections)


if __name__ == "__main__":
    cookies = parse_cookies(COOKIE)
    if not cookies:
        Log.fail("未配置 Cookie，请设置环境变量 WPS_COOKIE 或编辑脚本 DEFAULT_COOKIE")
        sys.exit(1)
    Log.info(f"共 {len(cookies)} 个账号待执行")

    all_reports = []
    for idx, ck in enumerate(cookies, 1):
        if len(cookies) > 1:
            Log.step(f"账号 {idx}/{len(cookies)}")
        try:
            # 多账号时不单独推送，最后汇总推送
            push_now = False if len(cookies) > 1 else None
            report = WpsAuto(ck).run(push_now=push_now)
            all_reports.append(report)
        except Exception as e:
            Log.fail(f"账号 {idx} 执行异常：{e}")
            all_reports.append({
                "nickname": f"账号{idx}", "user_id": 0, "login_ok": False,
                "sign_ok": False, "sign_days": {"continuous": 0, "total": 0},
                "tasks": {"ok": 0, "skip": 0, "fail": 0, "new_found": 0},
                "lottery_rewards": [], "error": str(e)
            })
        if idx < len(cookies):
            time.sleep(3)

    # 多账号时汇总推送（一条消息包含全部账号结果）
    if DO_PUSH and len(cookies) > 1 and all_reports:
        try:
            push_summary_report(all_reports)
        except Exception as e:
            Log.fail(f"汇总推送异常：{e}")
