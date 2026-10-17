#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# cron "25 0 * * *"
# new Env("百度文库每日任务")
"""
名称: 百度文库每日任务
功能: 激励中心签到、一键领取、VIP任务列表/领奖、盲盒抽奖(查询+尝试)、云空间信息
作者: TRAE
更新: 2026-10-17

============================== 环境变量 ==============================
WENKU_COOKIE      (必填) 多账号换行分隔，每行: BDUSS=xxxxxx;
                  BDUSS 与百度网盘通用(同一百度账号)，可直接复用网盘的 BDUSS
WENKU_NOTIFY      (可选) 通知开关，默认 true
WENKU_SIGN        (可选) 激励中心签到尝试开关，默认 true
WENKU_TASK_CLAIM  (可选) VIP任务领奖尝试开关，默认 true
WENKU_DRAW        (可选) 盲盒抽奖尝试开关，默认 true
WENKU_APP_VER     (可选) App 版本号，默认 10.4.50

============================== 接口与安全限制 ==============================
数据来源: 文库 App 抓包 + tanbi.baidu.com H5 JS 逆向。
App 内 H5 通过原生通道(ktor → appwk.baidu.com/appapi/*)请求，
仅需 BDUSS 鉴权，无需 STOKEN。

1. 可直接调用的查询接口(已实测通过):
   - /ghome/cloud/spaceinfo        云空间用量(兼作鉴权校验, code=200001 表示 Cookie 失效)
   - /appapi/task/viptasklist      VIP 抽奖任务列表(taskaward=draw)
   - /appapi/center/drawinfo2024   盲盒抽奖信息(availDrawTimes 可抽次数)
2. 带反爬校验的动作接口(签到/一键领取/任务领奖/抽奖):
   正常流程需 Acs-Token + Htj(由 banti/百青藤风控 JS 在浏览器内签发)，
   服务端另有"玉门关"校验(未携带令牌返回 code=7350000)。
   纯脚本无法伪造该令牌链，脚本会照常尝试并以接口真实返回为准如实上报；
   被 7350000 拦截时请到 App「我的-福利中心/激励中心」手动完成签到与抽奖。
   (若百度后续放宽校验，接口会自动开始生效，无需改脚本)
"""

import os
import time
import random
import hashlib
import json
import requests

# 任务状态(由 taskStatus 字段观察推测: 1=进行中/未完成)
TASK_STATUS_RUNNING = 1

# 每次运行领奖/抽奖尝试上限(防刷)
MAX_CLAIM_ATTEMPTS = 5
MAX_DRAW_ATTEMPTS = 10


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
    """解析 WENKU_COOKIE，多账号按换行分隔，提取 BDUSS。"""
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
        self.cookies = parse_cookies(os.getenv("WENKU_COOKIE", ""))
        self.notify_on = _env_bool("WENKU_NOTIFY", True)
        self.sign_on = _env_bool("WENKU_SIGN", True)
        self.task_claim = _env_bool("WENKU_TASK_CLAIM", True)
        self.draw_on = _env_bool("WENKU_DRAW", True)
        self.app_ver = _env_str("WENKU_APP_VER", "10.4.50")


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


# ---------------------- 百度文库客户端 ----------------------
class BaiduWenku:
    """百度文库任务自动化。"""

    # App 原生通道 UA(实测 ktor-client 可直连 appwk.baidu.com)
    UA_NATIVE = "ktor-client"
    # H5 通道 UA(备用回退)
    UA_H5 = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
             "-HadesCore- 932_430_10.4.50_27.0_iPhone15,3_com.baidu.Wenku_1.0.1")
    BASE_NATIVE = "https://appwk.baidu.com"
    BASE_H5 = "https://tanbi.baidu.com"
    REFERER = "https://tanbi.baidu.com/h5-business-v3/browse/motivationalcenter"

    # 玉门关安全防护拦截码
    CODE_YMG = 7350000
    # 未登录
    CODE_NOT_LOGIN = (200001, -6)

    def __init__(self, bduss, cfg):
        self.bduss = bduss
        self.cfg = cfg
        self.cuid = gen_cuid(bduss)
        self.cookie = "BDUSS=%s;" % bduss
        self.session = requests.Session()
        self.nickname = "账号%s" % bduss[:6]
        self.report = Reporter()

    # ==================== 通用请求层 ====================
    def _common_params(self, extra=None):
        """appapi 接口通用参数(对照 App 原生请求)。"""
        p = {
            "os": "ios",
            "na_uncheck": "1",
            "app_ver": self.cfg.app_ver,
            "cuid": self.cuid,
            "_t": str(int(time.time() * 1000)),
        }
        if extra:
            p.update(extra)
        return p

    def _request(self, method, path, extra=None, json_body=None):
        """appapi 请求：优先 App 原生通道，失败回退 H5 通道。返回响应 dict。"""
        channels = [
            (self.BASE_NATIVE, self.UA_NATIVE, None),
            (self.BASE_H5, self.UA_H5, self.REFERER),
        ]
        last_err = ""
        for base, ua, referer in channels:
            url = base + path
            headers = {"User-Agent": ua, "Cookie": self.cookie, "Accept": "application/json"}
            if referer:
                headers["Referer"] = referer
                headers["Origin"] = self.BASE_H5
            try:
                if method.upper() == "POST":
                    r = self.session.post(url, params=self._common_params(extra),
                                          json=json_body, headers=headers, timeout=20)
                else:
                    r = self.session.get(url, params=self._common_params(extra),
                                         headers=headers, timeout=20)
                try:
                    return r.json()
                except ValueError:
                    last_err = "HTTP %s 非 JSON 响应" % r.status_code
            except Exception as e:
                last_err = str(e)
            time.sleep(0.3)
        return {"status": {"code": -1, "msg": last_err or "无响应"}}

    @staticmethod
    def _code(resp):
        return (resp.get("status") or {}).get("code", -1)

    @staticmethod
    def _msg(resp):
        return (resp.get("status") or {}).get("msg", "")

    def _describe(self, resp):
        """统一描述接口返回，识别常见拦截码。"""
        code = self._code(resp)
        msg = self._msg(resp)
        if code == 0:
            return True, "成功"
        if code == self.CODE_YMG:
            return False, "被玉门关安全防护拦截(7350000)，需 App 端手动操作"
        if code in self.CODE_NOT_LOGIN or "not login" in msg.lower():
            return False, "Cookie 失效(%s %s)，请更新 BDUSS" % (code, msg)
        return False, "code=%s %s" % (code, msg)

    # ==================== 0. 鉴权校验 ====================
    def check_login(self):
        """云空间接口兼作鉴权校验。"""
        data = self._request("GET", "/ghome/cloud/spaceinfo")
        if self._code(data) == 0:
            d = data.get("data", {})
            used = d.get("usedSizeCount", 0) / 1024 / 1024 / 1024
            total = d.get("maxSizeCount", 0) / 1024 / 1024 / 1024
            over = "，已超容" if d.get("isOverCapacity") else ""
            self.report.add("账号校验", "成功",
                            "%s (云空间 %.2fGB/%.0fGB%s)" % (self.nickname, used, total, over))
            return True
        ok, desc = self._describe(data)
        self.report.add("账号校验", "失败", desc)
        return False

    # ==================== 1. 激励中心签到 ====================
    def activecenter_sign(self):
        """激励中心签到(动作接口，带玉门关校验，被拦截时如实上报)。"""
        data = self._request("GET", "/appapi/activecenter/sign",
                             {"ztoken": "", "jstoken": ""})
        ok, desc = self._describe(data)
        if ok:
            d = data.get("data", {}) or {}
            self.report.add("激励中心签到", "成功",
                            json.dumps(d, ensure_ascii=False)[:80] if d else "签到成功")
        elif self._code(data) == self.CODE_YMG:
            self.report.add("激励中心签到", "受限", desc)
        else:
            self.report.add("激励中心签到", "失败", desc)

    # ==================== 2. 一键领取 ====================
    def oneclick_receive(self):
        """激励中心一键领取待领奖励。"""
        data = self._request("GET", "/appapi/activecenter/oneclickreceive",
                             {"ztoken": "", "jstoken": "",
                              "extra": json.dumps({"appVer": self.cfg.app_ver})})
        ok, desc = self._describe(data)
        if ok:
            d = data.get("data", {}) or {}
            self.report.add("一键领取", "成功",
                            json.dumps(d, ensure_ascii=False)[:80] if d else "领取成功")
        elif self._code(data) == self.CODE_YMG:
            self.report.add("一键领取", "受限", desc)
        else:
            # 无可领奖励等业务性失败，降级为提示
            self.report.add("一键领取", "提示", desc)

    # ==================== 3. VIP 抽奖任务 ====================
    def vip_tasks(self, try_claim=True):
        """VIP 抽奖任务列表查询 + 领奖尝试。"""
        data = self._request("GET", "/appapi/task/viptasklist",
                             {"taskaward": "draw"})
        if self._code(data) != 0:
            ok, desc = self._describe(data)
            self.report.add("VIP任务", "失败", desc)
            return

        tasks = data.get("data", []) or []
        if not tasks:
            self.report.add("VIP任务", "信息", "任务列表为空")
            return

        done = running = 0
        claimable = []
        total_draw = 0
        for t in tasks:
            status = t.get("taskStatus")
            reward = t.get("taskReward") or {}
            num = reward.get("rewardNum", 0) or 0
            if status == TASK_STATUS_RUNNING:
                running += 1
            else:
                done += 1
                total_draw += num
                claimable.append(t)
        self.report.add("VIP任务", "信息",
                        "共%s个：进行中%s / 可领%s(约+%s次抽奖)"
                        % (len(tasks), running, done, total_draw))

        # 领奖尝试(动作接口)
        if try_claim and claimable:
            ok_n = blocked = fail = 0
            for t in claimable[:MAX_CLAIM_ATTEMPTS]:
                rd = self._request("GET", "/appapi/task/updateviptask",
                                   {"taskId": t.get("taskId"), "ztoken": "", "jstoken": ""})
                code = self._code(rd)
                if code == 0:
                    ok_n += 1
                elif code == self.CODE_YMG:
                    blocked += 1
                else:
                    fail += 1
                time.sleep(0.5)
            if ok_n:
                self.report.add("VIP任务领奖", "成功", "领取 %s 个任务奖励" % ok_n)
            if blocked:
                self.report.add("VIP任务领奖", "受限",
                                "%s 个被玉门关拦截，请在 App 激励中心手动领取" % blocked)
            if fail:
                self.report.add("VIP任务领奖", "失败", "%s 个领取失败" % fail)
        elif claimable:
            self.report.add("VIP任务领奖", "跳过", "未开启领奖尝试(WENKU_TASK_CLAIM)")

    # ==================== 4. 盲盒抽奖 ====================
    def blind_box_draw(self, try_draw=True):
        """盲盒抽奖：查询可抽次数，尝试抽奖。"""
        data = self._request("GET", "/appapi/center/drawinfo2024")
        if self._code(data) != 0:
            ok, desc = self._describe(data)
            self.report.add("盲盒抽奖", "失败", "查询失败: %s" % desc)
            return

        d = data.get("data", {}) or {}
        times = int(d.get("availDrawTimes", 0) or 0)
        if not d.get("isOpen", True):
            self.report.add("盲盒抽奖", "提示", "活动未开放")
            return

        if times > 0:
            self.report.add("盲盒抽奖", "信息", "当前可抽 %s 次" % times)
            if not try_draw:
                self.report.add("盲盒抽奖", "跳过", "未开启自动抽奖(WENKU_DRAW)")
                return

            # 抽奖尝试(动作接口)
            won = []
            blocked = fail = 0
            for _ in range(min(times, MAX_DRAW_ATTEMPTS)):
                rd = self._request("POST", "/appapi/center/draw2024",
                                   json_body={"jt": "", "os": "ios", "ztoken": "",
                                              "jstoken": "", "cuid": self.cuid})
                code = self._code(rd)
                if code == 0:
                    prize = (rd.get("data") or {}).get("prize") or (rd.get("data") or {})
                    won.append(json.dumps(prize, ensure_ascii=False)[:60])
                elif code == self.CODE_YMG:
                    blocked += 1
                elif code == 700011 or "上限" in self._msg(rd):
                    self.report.add("盲盒抽奖", "提示", "今日次数已达上限")
                    break
                else:
                    fail += 1
                time.sleep(1)

            if won:
                self.report.add("盲盒抽奖", "成功", "抽中: " + "; ".join(won))
            if blocked:
                self.report.add("盲盒抽奖", "受限",
                                "%s 次被玉门关拦截，请在 App 激励中心手动抽奖" % blocked)
            if fail:
                self.report.add("盲盒抽奖", "失败", "%s 次抽奖失败" % fail)

            # 复查剩余次数(验证真实消耗)
            time.sleep(1)
            d2 = (self._request("GET", "/appapi/center/drawinfo2024").get("data") or {})
            left = int(d2.get("availDrawTimes", 0) or 0)
            if left != times:
                self.report.add("盲盒抽奖", "信息", "剩余可抽 %s 次(原 %s 次)" % (left, times))
        else:
            self.report.add("盲盒抽奖", "信息", "今日无可抽次数(做任务可获得抽奖机会)")

    # ==================== 主流程 ====================
    def run(self):
        if not self.check_login():
            return self.report

        if self.cfg.sign_on:
            self.activecenter_sign()
        self.oneclick_receive()
        self.vip_tasks(try_claim=self.cfg.task_claim)
        self.blind_box_draw(try_draw=self.cfg.draw_on)

        self.report.add("安全提示", "提示",
                        "签到/领奖/抽奖接口有玉门关反爬校验，被拦截请到 App 激励中心手动操作")
        self.report.add("执行汇总", "信息", self.report.summary())
        return self.report


# ---------------------- 主入口 ----------------------
def main():
    cfg = Config()
    if not cfg.cookies:
        print("未检测到 WENKU_COOKIE 环境变量，请在青龙中配置。")
        print("格式: BDUSS=xxxxxx;  多账号换行分隔 (与百度网盘的 BDUSS 通用)")
        return

    all_summary = []
    for idx, ck in enumerate(cfg.cookies):
        banner = "===== 账号 %s =====" % (idx + 1)
        print("\n" + banner)
        wk = BaiduWenku(ck["BDUSS"], cfg)
        report = wk.run()

        lines = report.render()
        for line in lines:
            print(line)
        all_summary.append(banner + "\n" + "\n".join(lines))
        if idx < len(cfg.cookies) - 1:
            time.sleep(random.randint(3, 8))

    if cfg.notify_on:
        notify("百度文库每日任务", "\n\n".join(all_summary))
    print("\n全部账号执行完毕。")


if __name__ == "__main__":
    main()
