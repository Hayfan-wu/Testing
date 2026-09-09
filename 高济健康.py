#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
高济健康 - 签到及任务自动完成脚本


功能:
1. 每日签到获取高G金
2. 自动完成浏览任务（逛积分商城、查看省钱卡等）
3. 查询积分余额
4. 查询会员等级

配置方式（环境变量）:
  TOKEN: 必填，bearer token / access_token
  GJ_BUSINESSID: 商家ID，默认 466606
  GJ_STOREID: 门店ID，默认 3225031566606
  GJ_USERID: 用户ID，默认 6070827797166606
  GJ_PLATFORMUSERID: 平台用户ID，默认 5282553618412798
  
TOKEN 获取方法：
  打开微信小程序「高济健康」
  使用抓包工具（如 Charles、Fiddler、Stream）
  过滤 api.gaojihealth.cn 的请求
  查看任意请求头中的 Authorization: bearer <token> 或 Cookie: access_token=<token>
  兼容青龙面板，支持多用户 (使用 & 分隔)
"""

import os
import re
import sys
import json
import time
import requests

BASE_URL = "https://api.gaojihealth.cn"

DEFAULT_CONFIG = {
    "businessId": "466606",
    "storeId": "3225031566606",
    "userId": "6070827797166606",
    "platformUserId": "5282553618412798",
}


# ============================================================
# Token 无效异常
# ============================================================

class TokenInvalidError(Exception):
    """Token 无效或已过期"""
    pass


def log(msg, level="INFO"):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [{level}] {msg}")


def log_error(msg):
    log(msg, "ERROR")


def log_success(msg):
    log(msg, "SUCCESS")


def log_info(msg):
    log(msg, "INFO")


class GaoJiClient:

    def __init__(self, token, config=None):
        self.token = token.strip()
        self.config = {**DEFAULT_CONFIG, **(config or {})}
        self.session = requests.Session()
        self.session.headers.update({
            "Host": "api.gaojihealth.cn",
            "Content-Type": "application/json;charset=utf-8",
            "Authorization": f"bearer {token}",
            "Cookie": f"access_token={token}",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) "
                          "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
                          "MicroMessenger/8.0.75(0x18004b42) NetType/4G Language/zh_CN",
            "Referer": "https://servicewechat.com/wx73ec617ea0a6c8e8/1344/page-frame.html",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
        })

    def _check_token_invalid(self, resp_status, resp_data):
        """检查响应是否为 token 无效"""
        if resp_status == 401 and isinstance(resp_data, dict):
            if resp_data.get("error") == "invalid_token":
                return True
        return False

    def _get(self, path, params=None, skip_token_check=False):
        url = f"{BASE_URL}{path}"
        try:
            resp = self.session.get(url, params=params, timeout=30)
            data = resp.json() if resp.text else {}
            if not skip_token_check and self._check_token_invalid(resp.status_code, data):
                desc = data.get("error_description", "")
                raise TokenInvalidError(desc)
            return data
        except TokenInvalidError:
            raise
        except Exception as e:
            log_error(f"GET {path} 异常: {e}")
            return None

    def _post(self, path, data=None, skip_token_check=False):
        url = f"{BASE_URL}{path}"
        try:
            resp = self.session.post(url, json=data or {}, timeout=30)
            data = resp.json() if resp.text else {}
            if not skip_token_check and self._check_token_invalid(resp.status_code, data):
                desc = data.get("error_description", "")
                raise TokenInvalidError(desc)
            return data
        except TokenInvalidError:
            raise
        except Exception as e:
            log_error(f"POST {path} 异常: {e}")
            return None

    def validate_token(self):
        """验证 token 是否有效
        通过调用一个需要鉴权的接口来验证
        返回 True 表示有效，False 表示无效
        """
        path = "/gulosity/api/dkUserAchievement/getUserAchievement"
        payload = {
            "businessId": self.config["businessId"],
            "userId": self.config["userId"],
            "platformUserId": self.config["platformUserId"],
            "queryUserLevelNewVersion": True,
            "version": "3.0",
            "storeId": int(self.config["storeId"]),
        }
        try:
            result = self._post(path, payload)
            if result and (result.get("id") or result.get("levelName")):
                return True
            return False
        except TokenInvalidError as e:
            log_error(f"TOKEN 无效或已过期: {e}")
            log_error("")
            log_error("请按以下步骤重新获取 TOKEN:")
            log_error("  1. 打开微信小程序「高济健康」")
            log_error("  2. 使用抓包工具（Charles / Stream / HttpCanary 等）")
            log_error("  3. 找到任意一个 POST 请求（如 everyDaySign / getUserAchievement）")
            log_error("  4. 复制请求头 Authorization: bearer 后面的完整 token")
            log_error("  5. 更新环境变量 TOKEN 或 GJ_TOKEN")
            log_error("")
            log_error("注意：不要从 noauth 开头的接口里复制 token，那些接口不校验 token")
            return False

    def get_sign_page(self):
        # noauth 接口不需要鉴权，跳过 token 检查
        path = "/fund/api/noauth/appCoupon/findDkSignActivityPage"
        params = {
            "businessId": self.config["businessId"],
            "userId": self.config["userId"],
            "version": "1.4",
        }
        result = self._get(path, params, skip_token_check=True)
        if result and result.get("runFlag"):
            sign_module = result.get("signModule", {})
            base_info = result.get("baseInfoModule", {})
            integral = result.get("integralResponse", {})
            log_info(f"当前高G金: {integral.get('currentFund', '未知')}")
            log_info(f"签到任务ID: {sign_module.get('taskId')}")
            log_info(f"签到可得: {base_info.get('fundVal', 0)} 高G金/天")
            for day in sign_module.get("dayList", []):
                if day.get("todayFlag"):
                    if day.get("signFlag"):
                        log_info("今日已签到")
                        return {"signed": True, "data": result, "task_id": sign_module.get("taskId", 372)}
                    else:
                        log_info("今日尚未签到，准备签到...")
                        return {"signed": False, "data": result, "task_id": sign_module.get("taskId", 372)}
            return {"signed": True, "data": result, "task_id": sign_module.get("taskId", 372)}
        else:
            log_error(f"获取签到页面失败")
            return None

    def do_sign(self, task_id=372):
        """执行签到"""
        path = "/gulosity/api/dkUserEvent/everyDaySign"
        body = {
            "businessId": int(self.config["businessId"]),
            "storeId": int(self.config["storeId"]),
            "userId": self.config["userId"],
            "taskId": task_id,
        }
        result = self._post(path, body)
        if result and result.get("opCode") == 200:
            prize = result.get("prizeInfo", "?")
            log_success(f"签到成功! 获得 {prize} 高G金")
            return True
        else:
            if result:
                msg = result.get("opMsg") or result.get("message") or result.get("msg") or str(result)[:100]
                code = result.get("opCode") or result.get("code") or "?"
                log_error(f"签到失败 [{code}]: {msg}")
            else:
                log_error("签到失败: 无响应")
            return False

    def get_user_achievement(self):
        path = "/gulosity/api/dkUserAchievement/getUserAchievement"
        payload = {
            "businessId": self.config["businessId"],
            "userId": self.config["userId"],
            "platformUserId": self.config["platformUserId"],
            "queryUserLevelNewVersion": True,
            "version": "3.0",
            "storeId": int(self.config["storeId"]),
        }
        result = self._post(path, payload)
        if result and (result.get("id") or result.get("levelName")):
            log_info(f"会员等级: {result.get('levelName', '未知')} "
                     f"(Lv.{result.get('userLevel', 0)}, 积分: {result.get('score', 0)})")
            return result
        return None

    def get_user_fund(self):
        """获取用户高G金余额"""
        path = "/fund/api/fundAccounts/getCurrentFundV2"
        params = {"businessId": self.config["businessId"], "storeId": self.config["storeId"]}
        result = self._get(path, params)
        if result is not None:
            if isinstance(result, dict):
                fund = result.get("fund", result.get("currentFund", result.get("balance", "未知")))
            elif isinstance(result, (int, float)):
                fund = result
            else:
                fund = "未知"
            log_info(f"高G金余额: {fund}")
            return result
        return None

    def get_user_info(self):
        path = "/uaa/api/userbaseinfo/userDetail"
        params = {"storeId": self.config["storeId"], "maskingFlag": "false"}
        result = self._get(path, params)
        if result and isinstance(result, dict):
            name = result.get("name") or result.get("nickName") or result.get("username") or "未知"
            phone = result.get("phone") or result.get("mobile") or result.get("telephone") or ""
            log_info(f"用户信息: {name} ({phone})")
            return result
        return None

    def get_tasks(self):
        result = self.get_sign_page()
        if result and result.get("data"):
            tasks = result["data"].get("taskModule", {}).get("integralTaskList", [])
            if tasks:
                log_info(f"获取到 {len(tasks)} 个可完成任务:")
                for task in tasks:
                    log_info(f"  - {task.get('name', '未知')} "
                             f"(奖励: {task.get('prizeInfo', '?')} 积分, "
                             f"状态: {'已完成' if task.get('status') == 1 else '未完成'}, "
                             f"剩余: {task.get('leftTimes', 0)}次)")
            return tasks
        return []

    def complete_browse_task(self, task):
        """完成浏览任务"""
        task_id = task.get("taskId")
        task_name = task.get("name", "未知任务")
        browse_page_id = task.get("browsePageId", "") or ""
        browse_page_url = task.get("browsePageUrl", "") or ""
        log_info(f"开始完成任务: {task_name} (taskId={task_id})")

        path = "/gulosity/api/dkUserEvent/browsePageCompleteTaskEvent"
        body = {
            "browsePageId": browse_page_id,
            "browsePageUrl": browse_page_url,
            "taskId": task_id,
        }
        result = self._post(path, body)

        if result is True:
            log_success(f"任务 [{task_name}] 完成!")
            return True

        if isinstance(result, dict):
            if result.get("success") or result.get("opCode") == 200 or result.get("code") == 200:
                log_success(f"任务 [{task_name}] 完成!")
                return True
            msg = result.get("opMsg") or result.get("message") or result.get("msg") or str(result)[:100]
            code = result.get("opCode") or result.get("code") or "?"
            log_error(f"任务 [{task_name}] 失败 [{code}]: {msg}")
            return False

        if result is False:
            log_error(f"任务 [{task_name}] 完成失败 (返回 false)")
            return False

        log_error(f"任务 [{task_name}] 完成失败 (无有效响应)")
        return False

    def complete_all_tasks(self):
        tasks = self.get_tasks()
        if not tasks:
            log_info("没有需要完成的任务")
            return
        completed = 0
        for task in tasks:
            if task.get("status") == 1:
                log_info(f"任务 [{task.get('name', '未知')}] 已完成，跳过")
                continue
            if task.get("leftTimes", 0) <= 0:
                log_info(f"任务 [{task.get('name', '未知')}] 无剩余次数，跳过")
                continue
            if self.complete_browse_task(task):
                completed += 1
            time.sleep(2)
        log_success(f"完成 {completed}/{len(tasks)} 个任务")

    def run(self):
        log_info("=" * 40)
        log_info("高济健康 - 签到任务自动执行")
        log_info("=" * 40)

        # 先验证 token 是否有效
        log_info("正在验证 TOKEN...")
        if not self.validate_token():
            log_error("TOKEN 验证失败，停止执行")
            return
        log_success("TOKEN 验证通过")
        log_info("")

        # token 有效，继续执行
        self.get_user_info()
        self.get_user_fund()
        self.get_user_achievement()
        log_info("")
        log_info("=" * 40)
        log_info("执行签到...")
        log_info("=" * 40)
        sign_result = self.get_sign_page()
        if sign_result and not sign_result.get("signed"):
            task_id = sign_result.get("task_id", 372)
            self.do_sign(task_id)
        elif sign_result and sign_result.get("signed"):
            log_info("今日已签到，跳过")
        log_info("")
        log_info("=" * 40)
        log_info("执行任务...")
        log_info("=" * 40)
        self.complete_all_tasks()
        log_info("")
        log_info("=" * 40)
        log_info("执行结果汇总")
        log_info("=" * 40)
        self.get_user_fund()
        log_success("所有任务执行完毕!")


def parse_tokens(token_str):
    if not token_str:
        return []
    tokens = re.split(r'[&\n]', token_str)
    return [t.strip() for t in tokens if t.strip()]


def run_user(token, config_override=None):
    client = GaoJiClient(token, config_override)
    try:
        client.run()
    except TokenInvalidError:
        log_error("TOKEN 无效，跳过当前用户")
    except Exception as e:
        log_error(f"用户执行异常: {e}")
        import traceback
        traceback.print_exc()


def main():
    token_str = os.environ.get("TOKEN") or os.environ.get("GJ_TOKEN") or ""
    if not token_str:
        log_error("未设置 TOKEN 环境变量！")
        log_info("请设置 TOKEN 环境变量为你的 bearer token")
        log_info("多用户请用 & 分隔")
        sys.exit(1)
    config_override = {}
    for key in ["businessId", "storeId", "userId", "platformUserId"]:
        env_key = f"GJ_{key.upper()}"
        if env_key in os.environ:
            config_override[key] = os.environ[env_key]
    tokens = parse_tokens(token_str)
    log_info(f"检测到 {len(tokens)} 个用户")
    for i, token in enumerate(tokens):
        log_info("")
        log_info("#" * 50)
        log_info(f"用户 {i + 1}/{len(tokens)}")
        log_info("#" * 50)
        run_user(token, config_override)
    log_success(f"全部 {len(tokens)} 个用户执行完毕!")


if __name__ == "__main__":
    main()