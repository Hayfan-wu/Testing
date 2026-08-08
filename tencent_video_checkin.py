#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
腾讯视频 VIP 自动签到 + V力值任务 青龙面板脚本

== 青龙面板环境变量 ==
变量名: txsp_data
多账号用换行符 \n 分隔

每行格式:
txspCookie={完整Cookie字符串}&txspRefreshCookie={刷新用Cookie字符串}&txspRefreshBody={刷新请求体JSON}

== 获取方式 ==
1. txspCookie: 手机腾讯视频App进入会员中心/签到页面，抓包获取请求Cookie
   关键字段: vqq_access_token, vqq_vuserid, vqq_vusession, vqq_appid, vqq_openid, main_login
2. txspRefreshCookie: 浏览器访问 v.qq.com 登录后，抓包 NewRefresh 请求的Cookie
3. txspRefreshBody: 浏览器访问 v.qq.com 登录后，抓包 NewRefresh 请求的Body (JSON格式)

== API接口来源 (APK逆向分析) ==
签到接口: trpc.growth_raptor.component_action.SignService/DoSign (App端protobuf)
          trpc.new_task_system.task_system.TaskSystem/CheckIn (H5端JSON, 脚本使用)
V力值任务: trpc.growth_raptor.access.AccessApi/QueryProgress (查询进度)
          trpc.growth_raptor.access.AccessApi/ReceiveReward (领取奖励)
          trpc.growth_raptor.browse_component.BrowseService/Exec (浏览任务)
认证刷新: trpc.video_account_login.web_login_trpc.WebLoginTrpc/NewRefresh

== APK版本 ==
TencentVideo V9.04.20.32088

cron: 5 8 * * *
new Env('腾讯视频VIP签到');
"""

import os
import sys
import json
import time
import re
import urllib.parse
import requests
from datetime import datetime

# ==================== 配置 ====================

# API 基础URL
BASE_URL = "https://vip.video.qq.com"
PBACCESS_URL = "https://pbaccess.video.qq.com"

# 请求头模板
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 15; Build/AQ3A.240627.003; wv) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 "
                  "Chrome/130.0.6723.86 Mobile Safari/537.36 "
                  "QQLiveBrowser/9.04.20.32088",
    "Referer": "https://v.qq.com/",
    "Origin": "https://v.qq.com",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "Connection": "keep-alive",
}

# 请求超时(秒)
TIMEOUT = 30

# 重试次数
MAX_RETRY = 3

# ==================== 通知推送 ====================

def send_notify(title, content):
    """发送通知消息 (支持多种推送渠道)"""
    # PushPlus
    pushplus_token = os.environ.get("PUSHPLUS_TOKEN", "")
    if pushplus_token:
        try:
            requests.post(
                "http://www.pushplus.plus/send",
                json={"token": pushplus_token, "title": title, "content": content},
                timeout=10
            )
        except Exception:
            pass

    # ServerChan (Server酱)
    serverchan_key = os.environ.get("PUSH_KEY", os.environ.get("SC_KEY", ""))
    if serverchan_key:
        try:
            requests.get(
                f"https://sctapi.ftqq.com/{serverchan_key}.send",
                params={"title": title, "desp": content},
                timeout=10
            )
        except Exception:
            pass

    # 企业微信机器人
    qywx_bot = os.environ.get("QYWX_BOT", "")
    if qywx_bot:
        try:
            requests.post(
                qywx_bot,
                json={
                    "msgtype": "text",
                    "text": {"content": f"{title}\n\n{content}"}
                },
                timeout=10
            )
        except Exception:
            pass

    # Telegram Bot
    tg_bot_token = os.environ.get("TG_BOT_TOKEN", "")
    tg_user_id = os.environ.get("TG_USER_ID", "")
    if tg_bot_token and tg_user_id:
        try:
            requests.post(
                f"https://api.telegram.org/bot{tg_bot_token}/sendMessage",
                json={"chat_id": tg_user_id, "text": f"{title}\n\n{content}", "parse_mode": "HTML"},
                timeout=10
            )
        except Exception:
            pass


# ==================== 工具函数 ====================

def log(msg):
    """打印带时间戳的日志"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] {msg}")


def parse_cookie_string(cookie_str):
    """从Cookie字符串中提取指定字段"""
    cookies = {}
    if not cookie_str:
        return cookies
    # 标准化: 去除 "Cookie:" 前缀
    cookie_str = cookie_str.strip()
    if cookie_str.lower().startswith("cookie:"):
        cookie_str = cookie_str[7:].strip()
    for item in cookie_str.split(";"):
        item = item.strip()
        if "=" in item:
            key, val = item.split("=", 1)
            cookies[key.strip()] = val.strip()
    return cookies


def update_cookie_field(cookie_str, field, value):
    """更新Cookie字符串中的指定字段"""
    cookies = parse_cookie_string(cookie_str)
    cookies[field] = value
    return "; ".join(f"{k}={v}" for k, v in cookies.items())


def retry_request(func, max_retry=MAX_RETRY, delay=2):
    """带重试的请求"""
    for i in range(max_retry):
        try:
            result = func()
            if result is not None:
                return result
        except Exception as e:
            log(f"  请求失败({i+1}/{max_retry}): {e}")
        if i < max_retry - 1:
            time.sleep(delay * (i + 1))
    return None


# ==================== 核心API类 ====================

class TencentVideoAPI:
    """腾讯视频VIP API封装"""

    def __init__(self, txsp_cookie, refresh_cookie, refresh_body):
        self.txsp_cookie = txsp_cookie
        self.refresh_cookie = refresh_cookie
        self.refresh_body = refresh_body
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        self.messages = []  # 收集运行消息

    def msg(self, text):
        """添加消息"""
        self.messages.append(text)
        log(text)

    def _make_headers(self, cookie=None):
        """构建请求头"""
        headers = dict(DEFAULT_HEADERS)
        headers["Cookie"] = cookie or self.txsp_cookie
        return headers

    # ==================== 会话刷新 ====================

    def refresh_session(self):
        """刷新vqq_vusession (关键步骤)
        
        API: POST https://pbaccess.video.qq.com/trpc.video_account_login.web_login_trpc.WebLoginTrpc/NewRefresh
        逆向来源: APK中 Lcom/tencent/qqlive/ona/protocol/jce/NewRefreshTokenRequest
        """
        log(">>> 刷新会话 (NewRefresh)...")

        try:
            body = self.refresh_body
            # 如果body不是JSON字符串, 尝试转为JSON
            if isinstance(body, str):
                try:
                    json.loads(body)
                except json.JSONDecodeError:
                    # 可能是其他格式, 直接使用
                    pass

            headers = self._make_headers(self.refresh_cookie)
            headers["Content-Type"] = "application/json"

            resp = self.session.post(
                f"{PBACCESS_URL}/trpc.video_account_login.web_login_trpc.WebLoginTrpc/NewRefresh",
                headers=headers,
                data=body if isinstance(body, str) else json.dumps(body),
                timeout=TIMEOUT
            )

            data = resp.json()

            if data.get("ret") == 0 or data.get("ret") == "0":
                inner = data.get("data", {})

                # 提取刷新后的字段
                vusession = inner.get("vusession", "")
                access_token = inner.get("access_token", "")
                vuserid = inner.get("vuserid", "")

                if vusession:
                    # 更新txsp_cookie中的vqq_vusession
                    self.txsp_cookie = update_cookie_field(self.txsp_cookie, "vqq_vusession", vusession)
                    self.msg("  会话刷新成功")

                if access_token:
                    self.txsp_cookie = update_cookie_field(self.txsp_cookie, "vqq_access_token", access_token)

                if vuserid:
                    self.txsp_cookie = update_cookie_field(self.txsp_cookie, "vqq_vuserid", vuserid)

                return True
            else:
                err_msg = data.get("msg", "未知错误")
                self.msg(f"  会话刷新失败: {err_msg}")
                # 即使刷新失败也尝试继续
                return False

        except Exception as e:
            self.msg(f"  会话刷新异常: {e}")
            return False

    # ==================== 每日签到 ====================

    def daily_checkin(self):
        """每日签到
        
        API: GET https://vip.video.qq.com/rpc/trpc.new_task_system.task_system.TaskSystem/CheckIn?rpc_data=%7B%7D
        逆向来源: APK中 trpc.growth_raptor.component_action.SignService/DoSign (App端protobuf)
                  H5端使用 trpc.new_task_system.task_system.TaskSystem/CheckIn (JSON)
        MissionCenterDoSignRequest字段: sub_task_id (String)
        MissionCenterDoSignResponse字段: result.today_signed, result.continuous_days, result.reward.display_text
        """
        log(">>> 每日签到 (CheckIn)...")

        try:
            url = f"{BASE_URL}/rpc/trpc.new_task_system.task_system.TaskSystem/CheckIn?rpc_data=%7B%7D"
            headers = self._make_headers()

            resp = self.session.get(url, headers=headers, timeout=TIMEOUT)
            data = resp.json()

            if data.get("ret") == 0 or data.get("ret") == "0":
                inner = data.get("data", {})
                # 签到结果
                check_in_result = inner.get("check_in_result", {})
                continuous_days = check_in_result.get("continuous_days", 0)
                reward = check_in_result.get("reward", {})
                reward_text = reward.get("display_text", "") if isinstance(reward, dict) else str(reward)

                self.msg(f"  签到成功! 连续签到: {continuous_days}天")
                if reward_text:
                    self.msg(f"  奖励: {reward_text}")
                return True
            else:
                err_msg = data.get("msg", "未知错误")
                # 检查是否已签到
                if "已签到" in err_msg or "already" in err_msg.lower():
                    self.msg("  今日已签到")
                    return True
                self.msg(f"  签到失败: {err_msg}")
                return False

        except Exception as e:
            self.msg(f"  签到异常: {e}")
            return False

    # ==================== 读取任务列表 ====================

    def read_task_list(self, area_id=1):
        """读取任务列表
        
        API: POST https://vip.video.qq.com/rpc/trpc.new_task_system.task_system.TaskSystem/ReadTaskList
        Body: {"areaCode": 1, "areaId": N, "isMain": true}
        
        areaId=1: 腾讯视频VIP签到
        areaId=2: 腾讯体育签到
        areaId=3: 每月球票领取
        areaId=4: 抽奖
        """
        area_names = {1: "腾讯视频VIP", 2: "腾讯体育", 3: "每月球票", 4: "抽奖"}
        area_name = area_names.get(area_id, f"区域{area_id}")
        log(f">>> 读取任务列表 ({area_name})...")

        try:
            url = f"{BASE_URL}/rpc/trpc.new_task_system.task_system.TaskSystem/ReadTaskList"
            headers = self._make_headers()
            headers["Content-Type"] = "application/json"

            body = json.dumps({"areaCode": 1, "areaId": area_id, "isMain": True})

            resp = self.session.post(url, headers=headers, data=body, timeout=TIMEOUT)
            data = resp.json()

            if data.get("ret") == 0 or data.get("ret") == "0":
                inner = data.get("data", {})
                task_list = inner.get("task_list", [])

                self.msg(f"  任务列表获取成功, 共{len(task_list)}个任务")

                # 解析任务详情
                for task in task_list:
                    task_id = task.get("task_id", "")
                    task_name = task.get("task_name", "未知任务")
                    task_status = task.get("task_status", 0)
                    reward = task.get("reward_desc", "")

                    # 任务状态: 0=未完成, 1=已完成未领取, 2=已领取
                    status_text = {0: "未完成", 1: "可领取", 2: "已领取"}.get(task_status, str(task_status))

                    self.msg(f"  [{task_id}] {task_name} - 状态: {status_text} - 奖励: {reward}")

                return task_list
            else:
                err_msg = data.get("msg", "未知错误")
                self.msg(f"  任务列表获取失败: {err_msg}")
                return []

        except Exception as e:
            self.msg(f"  任务列表获取异常: {e}")
            return []

    # ==================== 领取奖励 ====================

    def provide_award(self, task_id):
        """领取任务奖励
        
        API: GET https://vip.video.qq.com/rpc/trpc.new_task_system.task_system.TaskSystem/ProvideAward?rpc_data={"task_id":N}
        
        task_id=1: 每日观看60分钟奖励
        task_id=12: 赠送奖励
        """
        log(f">>> 领取奖励 (task_id={task_id})...")

        try:
            rpc_data = json.dumps({"task_id": task_id})
            encoded_data = urllib.parse.quote(rpc_data)
            url = f"{BASE_URL}/rpc/trpc.new_task_system.task_system.TaskSystem/ProvideAward?rpc_data={encoded_data}"
            headers = self._make_headers()

            resp = self.session.get(url, headers=headers, timeout=TIMEOUT)
            data = resp.json()

            if data.get("ret") == 0 or data.get("ret") == "0":
                inner = data.get("data", {})
                award_name = inner.get("award_name", "")
                self.msg(f"  奖励领取成功! {award_name}")
                return True
            else:
                err_msg = data.get("msg", "未知错误")
                if "已领取" in err_msg or "already" in err_msg.lower():
                    self.msg(f"  奖励已领取过")
                    return True
                self.msg(f"  奖励领取失败: {err_msg}")
                return False

        except Exception as e:
            self.msg(f"  奖励领取异常: {e}")
            return False

    # ==================== 获取VIP信息 ====================

    def get_vip_info(self):
        """获取VIP会员信息
        
        API: POST https://vip.video.qq.com/rpc/trpc.query_vipinfo.vipinfo.QueryVipInfo/GetVipUserInfoH5
        Body: {"geticon": 1, "viptype": "svip|sports|qquvip", "platform": 7}
        """
        log(">>> 获取VIP会员信息...")

        try:
            url = f"{BASE_URL}/rpc/trpc.query_vipinfo.vipinfo.QueryVipInfo/GetVipUserInfoH5"
            headers = self._make_headers()
            headers["Content-Type"] = "application/json"

            body = json.dumps({
                "geticon": 1,
                "viptype": "svip|sports|qquvip",
                "platform": 7
            })

            resp = self.session.post(url, headers=headers, data=body, timeout=TIMEOUT)
            data = resp.json()

            if data.get("ret") == 0 or data.get("ret") == "0":
                inner = data.get("data", {})

                # 提取VIP信息
                nickname = inner.get("nickname", inner.get("nick", "未知"))
                svip_info = inner.get("svip", {})
                if isinstance(svip_info, dict):
                    svip_expire = svip_info.get("expire_time", "未知")
                    svip_status = svip_info.get("is_vip", 0)
                else:
                    svip_expire = "未知"
                    svip_status = 0

                # 积分/V力值
                score = inner.get("score", inner.get("vscore", "未知"))

                self.msg(f"  昵称: {nickname}")
                self.msg(f"  SVIP状态: {'有效' if svip_status else '无效'}")
                self.msg(f"  SVIP到期: {svip_expire}")
                self.msg(f"  V力值/积分: {score}")

                return inner
            else:
                err_msg = data.get("msg", "未知错误")
                self.msg(f"  VIP信息获取失败: {err_msg}")
                return None

        except Exception as e:
            self.msg(f"  VIP信息获取异常: {e}")
            return None

    # ==================== V力值任务系统 ====================

    def query_growth_progress(self):
        """查询V力值/成长任务进度
        
        逆向来源: APK中 trpc.growth_raptor.access.AccessApi/QueryProgress
        域名: pbaccess.video.qq.com
        协议: trpc over HTTP (protobuf)
        
        注意: 此接口为App端protobuf协议, H5端可能使用JSON格式
        """
        log(">>> 查询V力值任务进度...")

        try:
            # 尝试通过H5网关访问
            url = f"{BASE_URL}/rpc/trpc.growth_raptor.access.AccessApi/QueryProgress"
            headers = self._make_headers()
            headers["Content-Type"] = "application/json"

            # 空请求体或基本参数
            body = json.dumps({})

            resp = self.session.post(url, headers=headers, data=body, timeout=TIMEOUT)
            
            try:
                data = resp.json()
                if data.get("ret") == 0 or data.get("ret") == "0":
                    inner = data.get("data", {})
                    activities = inner.get("activities", inner.get("task_list", []))
                    self.msg(f"  V力值任务进度获取成功, 共{len(activities)}个活动")
                    
                    for act in activities if isinstance(activities, list) else []:
                        act_name = act.get("name", act.get("title", "未知"))
                        progress = act.get("progress", act.get("current_progress", 0))
                        target = act.get("target", act.get("target_progress", 0))
                        self.msg(f"  [{act_name}] 进度: {progress}/{target}")
                    
                    return inner
                else:
                    err_msg = data.get("msg", "未知错误")
                    self.msg(f"  V力值任务进度获取失败: {err_msg}")
                    return None
            except json.JSONDecodeError:
                self.msg(f"  V力值任务进度返回非JSON (可能需要protobuf协议)")
                return None

        except Exception as e:
            self.msg(f"  V力值任务进度查询异常: {e}")
            return None

    def receive_growth_reward(self, task_id=None, activity_id=None):
        """领取V力值任务奖励
        
        逆向来源: APK中 trpc.growth_raptor.access.AccessApi/ReceiveReward
        """
        log(f">>> 领取V力值任务奖励 (task_id={task_id}, activity_id={activity_id})...")

        try:
            url = f"{BASE_URL}/rpc/trpc.growth_raptor.access.AccessApi/ReceiveReward"
            headers = self._make_headers()
            headers["Content-Type"] = "application/json"

            params = {}
            if task_id:
                params["task_id"] = task_id
            if activity_id:
                params["activity_id"] = activity_id

            body = json.dumps(params)
            resp = self.session.post(url, headers=headers, data=body, timeout=TIMEOUT)

            try:
                data = resp.json()
                if data.get("ret") == 0 or data.get("ret") == "0":
                    self.msg(f"  V力值奖励领取成功!")
                    return True
                else:
                    err_msg = data.get("msg", "未知错误")
                    self.msg(f"  V力值奖励领取失败: {err_msg}")
                    return False
            except json.JSONDecodeError:
                self.msg(f"  V力值奖励领取返回非JSON")
                return False

        except Exception as e:
            self.msg(f"  V力值奖励领取异常: {e}")
            return False

    # ==================== 腾讯体育签到 ====================

    def sports_checkin(self):
        """腾讯体育签到 (areaId=2)"""
        log(">>> 腾讯体育签到...")
        return self._area_checkin(area_id=2, name="腾讯体育")

    def monthly_ticket(self):
        """每月球票领取 (areaId=3)"""
        log(">>> 每月球票领取...")
        return self._area_checkin(area_id=3, name="每月球票")

    def _area_checkin(self, area_id, name):
        """通用区域签到"""
        try:
            url = f"{BASE_URL}/rpc/trpc.new_task_system.task_system.TaskSystem/ReadTaskList"
            headers = self._make_headers()
            headers["Content-Type"] = "application/json"

            body = json.dumps({"areaCode": 1, "areaId": area_id, "isMain": True})
            resp = self.session.post(url, headers=headers, data=body, timeout=TIMEOUT)
            data = resp.json()

            if data.get("ret") == 0 or data.get("ret") == "0":
                inner = data.get("data", {})
                self.msg(f"  {name}任务列表获取成功")
                return True
            else:
                err_msg = data.get("msg", "未知错误")
                self.msg(f"  {name}操作失败: {err_msg}")
                return False
        except Exception as e:
            self.msg(f"  {name}操作异常: {e}")
            return False

    # ==================== 主流程 ====================

    def run(self):
        """执行所有任务"""
        log("=" * 50)
        log("腾讯视频VIP 自动签到任务开始")
        log("=" * 50)

        # Step 1: 刷新会话
        self.refresh_session()
        log("")

        # Step 2: 每日签到
        self.daily_checkin()
        log("")

        # Step 3: 读取任务列表 (腾讯视频VIP)
        task_list = self.read_task_list(area_id=1)
        log("")

        # Step 4: 领取可用奖励
        # task_id=1: 每日观看60分钟奖励
        # task_id=12: 赠送奖励
        for tid in [1, 12]:
            self.provide_award(task_id=tid)
        log("")

        # Step 5: 读取任务列表并尝试领取已完成任务的奖励
        if task_list:
            for task in task_list:
                task_id = task.get("task_id")
                task_status = task.get("task_status", 0)
                task_name = task.get("task_name", "")
                # 状态为1(已完成未领取)时尝试领取
                if task_status == 1 and task_id:
                    log(f"  发现可领取任务: [{task_id}] {task_name}")
                    self.provide_award(task_id=task_id)
            log("")

        # Step 6: V力值任务进度查询
        self.query_growth_progress()
        log("")

        # Step 7: 腾讯体育签到
        self.sports_checkin()
        log("")

        # Step 8: 每月球票
        self.monthly_ticket()
        log("")

        # Step 9: 获取VIP信息
        self.get_vip_info()
        log("")

        log("=" * 50)
        log("腾讯视频VIP 自动签到任务完成")
        log("=" * 50)

        return "\n".join(self.messages)


# ==================== 环境变量解析 ====================

def parse_env_data():
    """解析青龙面板环境变量 txsp_data
    
    支持格式:
    1. txspCookie={xxx}&txspRefreshCookie={xxx}&txspRefreshBody={xxx}
    2. 多账号用换行符分隔
    """
    accounts = []
    
    # 优先读取 txsp_data 变量
    raw_data = os.environ.get("txsp_data", "").strip()
    
    if not raw_data:
        # 尝试读取单独的变量
        txsp_cookie = os.environ.get("txspCookie", "").strip()
        refresh_cookie = os.environ.get("txspRefreshCookie", "").strip()
        refresh_body = os.environ.get("txspRefreshBody", "").strip()
        
        if txsp_cookie:
            accounts.append({
                "txspCookie": txsp_cookie,
                "txspRefreshCookie": refresh_cookie,
                "txspRefreshBody": refresh_body,
            })
    else:
        # 解析多账号
        for line in raw_data.split("\n"):
            line = line.strip()
            if not line:
                continue

            account = {
                "txspCookie": "",
                "txspRefreshCookie": "",
                "txspRefreshBody": "",
            }

            # 解析 key=value&key=value 格式
            # 注意: txspRefreshBody 的值可能包含特殊字符, 需要特殊处理
            # 方案: 按 &txsp 分割
            parts = re.split(r'&(?=(?:txspCookie|txspRefreshCookie|txspRefreshBody)=)', line)
            
            for part in parts:
                part = part.strip()
                if "=" in part:
                    key, val = part.split("=", 1)
                    key = key.strip()
                    val = val.strip()
                    if key in account:
                        account[key] = val

            if account["txspCookie"]:
                accounts.append(account)

    return accounts


def mask_cookie(cookie_str):
    """脱敏Cookie字符串用于显示"""
    if not cookie_str:
        return "(空)"
    cookies = parse_cookie_string(cookie_str)
    vuserid = cookies.get("vqq_vuserid", "")
    if vuserid:
        return f"用户ID: {vuserid}"
    return cookie_str[:30] + "..."


# ==================== 主函数 ====================

def main():
    log("腾讯视频VIP自动签到脚本启动")
    log(f"APK逆向版本: TencentVideo V9.04.20.32088")
    log("")

    # 解析环境变量
    accounts = parse_env_data()

    if not accounts:
        log("未找到账号配置!")
        log("")
        log("请在青龙面板设置环境变量 txsp_data")
        log("格式: txspCookie={Cookie}&txspRefreshCookie={刷新Cookie}&txspRefreshBody={刷新Body}")
        log("多账号用换行分隔")
        log("")
        log("获取方式:")
        log("1. 手机腾讯视频App进入会员中心, 抓包获取Cookie -> txspCookie")
        log("2. 浏览器访问v.qq.com登录, 抓包NewRefresh请求的Cookie -> txspRefreshCookie")
        log("3. 浏览器访问v.qq.com登录, 抓包NewRefresh请求的Body -> txspRefreshBody")
        return

    log(f"共找到 {len(accounts)} 个账号")
    log("")

    all_results = []

    for idx, account in enumerate(accounts, 1):
        log(f"========== 账号 {idx}/{len(accounts)} ==========")
        log(f"  {mask_cookie(account['txspCookie'])}")
        log("")

        api = TencentVideoAPI(
            txsp_cookie=account["txspCookie"],
            refresh_cookie=account["txspRefreshCookie"],
            refresh_body=account["txspRefreshBody"],
        )

        try:
            result = api.run()
            all_results.append(f"【账号{idx}】\n{result}")
        except Exception as e:
            log(f"账号{idx}执行异常: {e}")
            all_results.append(f"【账号{idx}】执行异常: {e}")

        log("")

        # 账号间延迟
        if idx < len(accounts):
            time.sleep(3)

    # 发送通知
    if all_results:
        notify_title = "腾讯视频VIP签到报告"
        notify_content = "\n\n".join(all_results)
        send_notify(notify_title, notify_content)
        log("通知已发送")


if __name__ == "__main__":
    main()
