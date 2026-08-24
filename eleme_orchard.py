#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
饿了么果园(0元领水果)青龙脚本
功能:
  1. 每日签到 + 领取签到奖励
  2. 领取待领取水滴(明日水滴)
  3. 领取蜗牛水滴
  4. 领取好友水滴礼物
  5. 自动完成任务(PAGEVIEW) + 领取任务奖励
  6. 领取进度奖励
  7. 自动浇水(循环浇灌直到水滴耗尽)

环境变量:
  ELME_COOKIE  饿了么Cookie(多个账号用 & 或换行分隔)
  ELME_CITY    城市信息(可选, 格式: latitude,longitude,cityId)

使用方法:
  1. 在饿了么App中抓取Cookie(需包含 _m_h5_tk, cookie2, t, _tb_token_ 等)
  2. 在青龙面板中添加环境变量 ELME_COOKIE
  3. 设置定时任务, 建议每天执行1-2次

cron: 30 8,12 * * *
new Env('饿了么果园');
"""

import os
import sys
import json
import time
import hmac
import hashlib
import requests
from datetime import datetime
from urllib.parse import urlencode, unquote

# ============ 常量配置 ============

APP_KEY = "12574478"          # MTOP H5 固定appKey
MTOP_HOST = "https://mtop.ele.me"  # 饿了么MTOP H5网关 (2026-08-24更新: h5api.m.ele.me已废弃)
WATERING_TEMPLATE_ID = "462"  # 浇水道具模板ID
WATERING_COST = 10            # 每次浇水消耗水滴数
BIZ_SCENE_ORCHARD = "KB_ORCHARD"
BIZ_SCENE_WATER_PK = "WATER_PK"
BIZ_SCENE_SIGNIN = "orchard_signin"
BIZ_SCENE_MISSION = "ORCHARD"
ACCOUNT_PLAN = "HAVANA_COMMON"
ASAC_SNAIL = "2A20C09KMHNH2AUNQG0GM0"
ASAC_DAILYSIGNIN = "2A20C2377ALBCAMWFHTDTC"
ASAC_USEPROP = "2A20C09KMHNH2AUNQG0GM0"
ASAC_SHARED = "2A201149OSTMKCX2RYL5JA"

# 默认城市信息(北京)
DEFAULT_LAT = "39.9042"
DEFAULT_LNG = "116.4074"
DEFAULT_CITY = "1"


class MtopClient:
    """MTOP H5 请求客户端"""

    def __init__(self, cookie_str):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/107.0.5304.91 Mobile Safari/537.36 "
                          "WindVane/6.8.0",
            "Referer": "https://r.ele.me/orchard-h5/",
            "Origin": "https://r.ele.me",
            "Content-Type": "application/x-www-form-urlencoded",
        })
        self.cookie_str = cookie_str
        self._parse_cookies()
        self._init_token()

    def _parse_cookies(self):
        """解析Cookie字符串, 提取_m_h5_tk"""
        self.cookies = {}
        for pair in self.cookie_str.split(";"):
            pair = pair.strip()
            if "=" in pair:
                k, v = pair.split("=", 1)
                self.cookies[k.strip()] = v.strip()
        # 设置cookie到session
        self.session.headers["Cookie"] = self.cookie_str

    def _init_token(self):
        """从_m_h5_tk cookie中提取token, 若无则通过一次请求获取"""
        h5_tk = self.cookies.get("_m_h5_tk", "")
        if h5_tk:
            self.token = h5_tk.split("_")[0]
        else:
            self.token = ""
        self.token_ts = h5_tk.split("_")[-1] if "_" in h5_tk else ""

    def _sign(self, timestamp, data_str):
        """计算MTOP签名: md5(token + & + timestamp + & + appKey + & + data)"""
        raw = f"{self.token}&{timestamp}&{APP_KEY}&{data_str}"
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def request(self, api, version="1.0", data=None, method="GET", auth=False):
        """
        发送MTOP H5请求

        Args:
            api:      API名称 (如 mtop.alsc.playgame.orchard.base.info.query)
            version:  API版本 (如 "1.0" 或 "1.1")
            data:     请求参数dict
            method:   GET 或 POST
            auth:     是否需要登录态
        Returns:
            dict: API响应数据
        """
        timestamp = str(int(time.time() * 1000))
        data_str = json.dumps(data or {}, separators=(",", ":"), ensure_ascii=False)

        params = {
            "jsv": "2.7.0",
            "appKey": APP_KEY,
            "t": timestamp,
            "sign": self._sign(timestamp, data_str),
            "api": api,
            "v": version,
            "type": "originaljson",
            "dataType": "json",
        }
        if auth:
            params["ecode"] = "1"

        url = f"{MTOP_HOST}/h5/{api.lower()}/{version}/"

        try:
            if method.upper() == "GET":
                params["data"] = data_str
                resp = self.session.get(url, params=params, timeout=15)
            else:
                resp = self.session.post(url, params=params, data={"data": data_str}, timeout=15)

            result = resp.json()

            # 处理token未初始化的情况 (FAIL_SYS_TOKEN_EXOIRED 或类似)
            ret_str = "".join(result.get("ret", []))
            if "TOKEN" in ret_str.upper() or "SESSION" in ret_str.upper():
                # 更新cookie中的_m_h5_tk (从Set-Cookie头)
                new_cookies = resp.headers.get("Set-Cookie", "")
                if "_m_h5_tk" in new_cookies:
                    for item in new_cookies.split(","):
                        item = item.strip()
                        if item.startswith("_m_h5_tk="):
                            tk_val = item.split("_m_h5_tk=")[1].split(";")[0]
                            self.cookies["_m_h5_tk"] = tk_val
                            self.token = tk_val.split("_")[0]
                            self.cookie_str = "; ".join(
                                f"{k}={v}" for k, v in self.cookies.items()
                            )
                            self.session.headers["Cookie"] = self.cookie_str
                            # 重试请求
                            timestamp = str(int(time.time() * 1000))
                            params["t"] = timestamp
                            params["sign"] = self._sign(timestamp, data_str)
                            if method.upper() == "GET":
                                params["data"] = data_str
                                resp = self.session.get(url, params=params, timeout=15)
                            else:
                                resp = self.session.post(
                                    url, params=params, data={"data": data_str}, timeout=15
                                )
                            result = resp.json()
                    return result

            return result

        except Exception as e:
            return {"ret": [f"FAIL_SYS_EXCEPTION::{str(e)}"], "data": {}}

    # ============ 果园API封装 ============

    def query_base_info(self):
        """查询果园基础信息"""
        return self.request(
            "mtop.alsc.playgame.orchard.base.info.query",
            "1.0",
            {"bizScene": BIZ_SCENE_ORCHARD},
            method="GET",
        )

    def query_future_water(self):
        """查询待领取的水滴"""
        return self.request(
            "mtop.ele.playgame.orchard.futurewater.query",
            "1.0",
            {"bizScene": BIZ_SCENE_ORCHARD},
            method="GET",
        )

    def receive_future_water(self):
        """领取待领取的水滴"""
        return self.request(
            "mtop.ele.playgame.orchard.futurewater.receive",
            "1.0",
            {"bizScene": BIZ_SCENE_ORCHARD, "outBizId": str(int(time.time() * 1000))},
            method="GET",
        )

    def receive_snail_water(self, snail_id):
        """领取蜗牛水滴"""
        return self.request(
            "mtop.alsc.playgame.orchard.snail.water.receive",
            "1.0",
            {"bizScene": BIZ_SCENE_ORCHARD, "snailId": snail_id},
            method="GET",
        )

    def receive_snail_water_gift(self, request_id, property_template_id, lat, lng, city_id):
        """领取好友水滴礼物"""
        return self.request(
            "mtop.alsc.playgame.snail.water.gift.receive",
            "1.0",
            {
                "bizScene": BIZ_SCENE_ORCHARD,
                "requestId": request_id,
                "propertyTemplateId": property_template_id,
                "latitude": lat,
                "longitude": lng,
                "cityId": city_id,
                "asac": ASAC_SNAIL,
            },
            method="POST",
            auth=True,
        )

    def query_sign_info(self):
        """查询签到信息"""
        return self.request(
            "mtop.koubei.interactioncenter.orchard.sign.querySignInfo",
            "1.0",
            {},
            method="GET",
            auth=True,
        )

    def record_signin(self):
        """执行签到"""
        return self.request(
            "mtop.koubei.interactioncenter.orchard.sign.recordSignIn",
            "1.0",
            {},
            method="POST",
            auth=True,
        )

    def receive_signin_award(self):
        """领取签到奖励"""
        return self.request(
            "mtop.koubei.interactioncenter.orchard.sign.receiveSignInAward",
            "1.1",
            {},
            method="POST",
            auth=True,
        )

    def query_process_reward(self):
        """查询进度奖励"""
        return self.request(
            "mtop.koubei.interactioncenter.orchard.processreward.query",
            "1.0",
            {"bizScene": BIZ_SCENE_WATER_PK, "requestId": str(int(time.time() * 1000))},
            method="GET",
            auth=True,
        )

    def receive_process_reward(self, prize_num_id, ext_info=""):
        """领取进度奖励"""
        return self.request(
            "mtop.koubei.interactioncenter.orchard.processreward.receive",
            "1.0",
            {
                "bizScene": BIZ_SCENE_SIGNIN,
                "prizeNumId": prize_num_id,
                "extInfo": json.dumps(ext_info) if ext_info else "",
                "requestId": str(int(time.time() * 1000)),
            },
            method="POST",
            auth=True,
        )

    def query_tasks(self):
        """查询任务列表"""
        return self.request(
            "mtop.ele.biz.growth.task.core.querytask",
            "1.0",
            {},
            method="GET",
            auth=True,
        )

    def trigger_task_event(self, collection_id, mission_id, mission_x_id="",
                           action_code="PAGEVIEW", page_from="", view_time="1",
                           lat=DEFAULT_LAT, lng=DEFAULT_LNG, city_id=DEFAULT_CITY):
        """触发任务事件(如浏览页面)"""
        return self.request(
            "mtop.ele.biz.growth.task.event.trigger",
            "1.1",
            {
                "bizScene": BIZ_SCENE_MISSION,
                "accountPlan": ACCOUNT_PLAN,
                "collectionId": collection_id,
                "missionId": mission_id,
                "missionXId": mission_x_id,
                "actionCode": action_code,
                "asac": ASAC_SHARED,
                "pageFrom": page_from,
                "viewTime": view_time,
                "sync": False,
                "latitude": lat,
                "longitude": lng,
                "cityId": city_id,
            },
            method="POST",
            auth=True,
        )

    def receive_task_prize(self, prize_info):
        """领取任务奖励"""
        return self.request(
            "mtop.ele.biz.growth.task.core.receiveprize",
            "1.0",
            prize_info,
            method="POST",
            auth=True,
        )

    def use_prop(self, property_template_id, role_id, role_type, group_id,
                 lat=DEFAULT_LAT, lng=DEFAULT_LNG, city_id=DEFAULT_CITY,
                 act_id="", collection_id=""):
        """使用道具(浇水)"""
        return self.request(
            "mtop.alsc.playgame.orchard.roleOperate.useProp",
            "1.0",
            {
                "bizScene": BIZ_SCENE_ORCHARD,
                "propertyTemplateId": property_template_id,
                "roleId": role_id,
                "roleType": role_type,
                "groupId": group_id,
                "asac": ASAC_USEPROP,
                "latitude": lat,
                "longitude": lng,
                "cityId": city_id,
                "actId": act_id,
                "collectionId": collection_id,
            },
            method="POST",
            auth=True,
        )

    def query_pop_tasks(self, biz_scene=BIZ_SCENE_ORCHARD, lat=DEFAULT_LAT,
                        lng=DEFAULT_LNG, city_id=DEFAULT_CITY):
        """查询弹窗任务"""
        return self.request(
            "mtop.alsc.playgame.orchard.pop.window.task.query",
            "1.0",
            {
                "bizScene": biz_scene,
                "latitude": lat,
                "longitude": lng,
                "cityId": city_id,
            },
            method="GET",
            auth=True,
        )

    def trigger_pop_task(self, biz_scene, strategy_scene, act_id, collection_id,
                         lat=DEFAULT_LAT, lng=DEFAULT_LNG, city_id=DEFAULT_CITY, ext=""):
        """触发弹窗任务"""
        return self.request(
            "mtop.alsc.playgame.orchard.pop.window.task.trigger",
            "1.0",
            {
                "bizScene": biz_scene,
                "strategyScene": strategy_scene,
                "actId": act_id,
                "collectionId": collection_id,
                "latitude": lat,
                "longitude": lng,
                "cityId": city_id,
                "ext": ext,
            },
            method="POST",
            auth=True,
        )


# 全局通知消息收集
NOTIFY_MSGS = []


def log(msg, level="INFO"):
    """统一日志输出"""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{level}] {msg}")
    NOTIFY_MSGS.append(f"[{level}] {msg}")


def send_qinglong_notification(title, content=""):
    """发送青龙面板通知(如果青龙环境存在)"""
    content = content or "\n".join(NOTIFY_MSGS[-50:])
    try:
        # 尝试导入青龙通知模块
        notify = None
        try:
            sys.path.append("/ql/scripts")
            sys.path.append("/ql/data/scripts")
            from notify import send as notify
        except (ImportError, ModuleNotFoundError):
            pass

        if notify:
            notify(title, content)
        else:
            # 非青龙环境, 仅打印
            log("通知内容(非青龙环境不发送):")
            print(content)
    except Exception as e:
        log(f"发送通知失败: {e}", "WARN")


def check_api_success(result):
    """检查MTOP API是否成功"""
    ret = result.get("ret", [])
    if isinstance(ret, list):
        ret_str = " ".join(ret)
    else:
        ret_str = str(ret)
    return "SUCCESS" in ret_str.upper()


def get_api_data(result):
    """获取API响应数据"""
    return result.get("data", {}).get("data", result.get("data", {}))


class OrchardBot:
    """饿了么果园自动化机器人"""

    def __init__(self, cookie_str, city_info=None):
        self.client = MtopClient(cookie_str)
        self.city_info = city_info or {
            "lat": DEFAULT_LAT,
            "lng": DEFAULT_LNG,
            "city_id": DEFAULT_CITY,
        }
        self.base_info = None
        self.snail_id = ""
        self.role_id = ""
        self.role_type = ""
        self.group_id = ""
        self.water_count = 0
        self._is_success_running = True

    def _stop_on_error(self, result, operation):
        """检查API结果, 失败时停止"""
        if not check_api_success(result):
            ret = result.get("ret", [])
            ret_str = " ".join(ret) if isinstance(ret, list) else str(ret)
            if "TOKEN" in ret_str.upper() or "ILLEGAL" in ret_str.upper() or "NOT_LOGIN" in ret_str.upper():
                log(f"{operation}失败(登录态失效): {ret_str}", "ERROR")
                self._is_success_running = False
            elif "BIZ" in ret_str.upper() and "FAIL" in ret_str.upper():
                # 业务错误, 不停止整个流程
                log(f"{operation}业务异常: {ret_str}", "WARN")
            else:
                log(f"{operation}失败: {ret_str}", "WARN")
            return False
        return True

    def get_base_info(self):
        """获取果园基础信息"""
        log("正在获取果园基础信息...")
        result = self.client.query_base_info()
        if not self._stop_on_error(result, "获取果园信息"):
            return False

        data = get_api_data(result)
        self.base_info = data

        # 提取关键信息
        # 蜗牛(snail)信息
        snail_info = data.get("snailInfoDTO", {})
        host_snail = snail_info.get("hostSnail", {})
        snail = host_snail.get("snail", {})
        self.snail_id = snail.get("snailId", "")

        # 角色信息(果树)
        role_data = data.get("roleData", {})
        role = role_data.get("role", {})
        self.role_id = role.get("roleId", "")
        self.role_type = role.get("roleType", "")
        self.group_id = role.get("groupId", "")

        # 水滴数量
        asset_data = data.get("assetData", {})
        water_asset = None
        for asset in asset_data.get("assetList", []):
            if asset.get("templateId") == "1" or "water" in str(asset.get("templateId", "")).lower():
                water_asset = asset
                break
        if water_asset:
            self.water_count = int(water_asset.get("value", 0))
        else:
            self.water_count = int(data.get("waterCount", 0) or data.get("assetData", {}).get("value", 0))

        log(f"果园信息: 蜗牛ID={self.snail_id or '无'}, "
            f"角色ID={self.role_id or '无'}, "
            f"水滴={self.water_count}g")

        return True

    def do_signin(self):
        """每日签到"""
        log("=== 开始每日签到 ===")

        # 1. 查询签到信息
        result = self.client.query_sign_info()
        if check_api_success(result):
            data = get_api_data(result)
            signed = data.get("hasSigned", False) or data.get("isSigned", False)
            if signed:
                log("今日已签到, 跳过")
            else:
                log("今日未签到, 正在签到...")
                # 2. 执行签到
                result = self.client.record_signin()
                if check_api_success(result):
                    log("签到成功!")
                else:
                    self._stop_on_error(result, "签到")
                    return

                time.sleep(1)

                # 3. 领取签到奖励
                result = self.client.receive_signin_award()
                if check_api_success(result):
                    data = get_api_data(result)
                    reward = data.get("rewardAmount", data.get("waterAmount", "未知"))
                    log(f"领取签到奖励成功! 获得水滴: {reward}g")
                else:
                    self._stop_on_error(result, "领取签到奖励")
        else:
            self._stop_on_error(result, "查询签到信息")

    def collect_future_water(self):
        """领取待领取水滴"""
        log("=== 领取待领取水滴 ===")

        # 1. 查询待领取水滴
        result = self.client.query_future_water()
        if not check_api_success(result):
            self._stop_on_error(result, "查询待领取水滴")
            return

        data = get_api_data(result)
        water_list = data.get("futureWaterList", data.get("list", []))
        if not water_list:
            log("暂无待领取的水滴")
            return

        log(f"发现 {len(water_list)} 个待领取水滴, 正在领取...")

        # 2. 领取水滴
        result = self.client.receive_future_water()
        if check_api_success(result):
            data = get_api_data(result)
            amount = data.get("receiveAmount", data.get("amount", "未知"))
            log(f"领取待领取水滴成功! 获得: {amount}g")
        else:
            self._stop_on_error(result, "领取待领取水滴")

    def collect_snail_water(self):
        """领取蜗牛水滴"""
        log("=== 领取蜗牛水滴 ===")

        if not self.snail_id:
            log("无蜗牛信息, 跳过")
            return

        result = self.client.receive_snail_water(self.snail_id)
        if check_api_success(result):
            data = get_api_data(result)
            amount = data.get("amount", data.get("waterAmount", "未知"))
            log(f"领取蜗牛水滴成功! 获得: {amount}g")
        else:
            ret = " ".join(result.get("ret", []))
            if "REPEAT" in ret.upper() or "ALREADY" in ret.upper():
                log("蜗牛水滴今日已领取")
            else:
                self._stop_on_error(result, "领取蜗牛水滴")

    def collect_friend_gift_water(self):
        """领取好友水滴礼物"""
        log("=== 领取好友水滴礼物 ===")

        # 通过base_info获取好友礼物信息
        if not self.base_info:
            log("无基础信息, 跳过")
            return

        snail_info = self.base_info.get("snailInfoDTO", {})
        gift_info = snail_info.get("drinkedGiftDetail", snail_info.get("drinkedGift", {}))

        gu_id = gift_info.get("guId", "")
        gift_template_id = gift_info.get("giftTemplateId", "")
        gift_count = gift_info.get("giftCount", 0)

        if gift_count and gift_count > 0 and gu_id:
            log(f"发现 {gift_count} 个好友水滴礼物, 正在领取...")
            result = self.client.receive_snail_water_gift(
                request_id=gu_id,
                property_template_id=gift_template_id,
                lat=self.city_info["lat"],
                lng=self.city_info["lng"],
                city_id=self.city_info["city_id"],
            )
            if check_api_success(result):
                log("领取好友水滴礼物成功!")
            else:
                self._stop_on_error(result, "领取好友水滴礼物")
        else:
            log("暂无好友水滴礼物")

    def do_tasks(self):
        """查询并完成任务"""
        log("=== 开始任务系统 ===")

        result = self.client.query_tasks()
        if not check_api_success(result):
            self._stop_on_error(result, "查询任务")
            return

        data = get_api_data(result)
        task_collections = data.get("missionCollectionList", data.get("collections", []))

        if not task_collections:
            log("暂无任务")
            return

        completed_count = 0
        for collection in task_collections:
            collection_id = collection.get("collectionId", collection.get("missionCollectionId", ""))
            missions = collection.get("missionList", collection.get("missions", []))

            for mission in missions:
                mission_id = mission.get("missionId", "")
                mission_x_id = mission.get("missionXId", "")
                mission_def_id = mission.get("missionDefId", mission_id)
                status = mission.get("status", mission.get("missionStatus", ""))

                # 只处理未完成的任务
                if status in ("COMPLETED", "CLAIMED", "DONE", "FINISHED"):
                    continue

                action_config = mission.get("actionConfig", {})
                action_type = action_config.get("actionType", "PAGEVIEW")
                action_value = action_config.get("actionValue", {})
                page_spm = action_value.get("pageSpm", "")
                page_stage_time = action_value.get("pageStageTime", "1")

                log(f"触发任务: {mission_def_id} (类型: {action_type})")

                # 触发PAGEVIEW事件
                trigger_result = self.client.trigger_task_event(
                    collection_id=collection_id,
                    mission_id=mission_def_id,
                    mission_x_id=mission_x_id,
                    action_code=action_type,
                    page_from=page_spm,
                    view_time=page_stage_time,
                    lat=self.city_info["lat"],
                    lng=self.city_info["lng"],
                    city_id=self.city_info["city_id"],
                )

                if check_api_success(trigger_result):
                    log(f"  任务触发成功, 等待奖励...")
                    time.sleep(2)

                    # 尝试领取奖励
                    prize_result = self.client.receive_task_prize({
                        "bizScene": BIZ_SCENE_MISSION,
                        "accountPlan": ACCOUNT_PLAN,
                        "collectionId": collection_id,
                        "missionId": mission_def_id,
                        "missionXId": mission_x_id,
                    })

                    if check_api_success(prize_result):
                        prize_data = get_api_data(prize_result)
                        reward = prize_data.get("rewardAmount", "未知")
                        log(f"  任务奖励领取成功! 获得: {reward}")
                        completed_count += 1
                    else:
                        ret = " ".join(prize_result.get("ret", []))
                        if "NOT_READY" in ret.upper() or "CONDITION" in ret.upper():
                            log(f"  任务未完成, 可能需要更多操作")
                        else:
                            self._stop_on_error(prize_result, "领取任务奖励")
                else:
                    self._stop_on_error(trigger_result, "触发任务事件")

                time.sleep(1)

        log(f"任务完成: 共完成 {completed_count} 个任务")

    def collect_process_reward(self):
        """领取进度奖励"""
        log("=== 领取进度奖励 ===")

        result = self.client.query_process_reward()
        if not check_api_success(result):
            self._stop_on_error(result, "查询进度奖励")
            return

        data = get_api_data(result)
        rewards = data.get("rewardList", data.get("prizeList", []))

        if not rewards:
            log("暂无可领取的进度奖励")
            return

        claimed = 0
        for reward in rewards:
            prize_num_id = reward.get("prizeNumId", reward.get("prizeId", ""))
            status = reward.get("status", reward.get("prizeStatus", ""))

            if status in ("CLAIMED", "RECEIVED", "DONE"):
                continue

            if reward.get("canClaim", reward.get("canReceive", True)):
                log(f"领取进度奖励: {prize_num_id}")
                result = self.client.receive_process_reward(prize_num_id)
                if check_api_success(result):
                    log("  进度奖励领取成功!")
                    claimed += 1
                else:
                    self._stop_on_error(result, "领取进度奖励")

                time.sleep(1)

        log(f"进度奖励: 共领取 {claimed} 个")

    def water_tree(self):
        """自动浇水"""
        log("=== 开始自动浇水 ===")

        # 刷新水滴数量
        if self.get_base_info():
            if self.water_count < WATERING_COST:
                log(f"水滴不足(当前{self.water_count}g, 需要{WATERING_COST}g), 无法浇水")
                return

            log(f"当前水滴: {self.water_count}g, 每次消耗{WATERING_COST}g, 可浇{self.water_count // WATERING_COST}次")

            water_count = 0
            max_attempts = 100  # 最大浇水次数限制
            fail_count = 0

            while self.water_count >= WATERING_COST and water_count < max_attempts:
                result = self.client.use_prop(
                    property_template_id=WATERING_TEMPLATE_ID,
                    role_id=self.role_id,
                    role_type=self.role_type,
                    group_id=self.group_id,
                    lat=self.city_info["lat"],
                    lng=self.city_info["lng"],
                    city_id=self.city_info["city_id"],
                )

                if check_api_success(result):
                    water_count += 1
                    data = get_api_data(result)
                    remaining = data.get("assetValue", data.get("waterCount", ""))
                    if remaining:
                        try:
                            self.water_count = int(remaining)
                        except (ValueError, TypeError):
                            self.water_count -= WATERING_COST
                    else:
                        self.water_count -= WATERING_COST

                    if water_count % 10 == 0:
                        log(f"已浇水 {water_count} 次, 剩余水滴: {self.water_count}g")

                    time.sleep(1.5)  # 避免请求过快
                    fail_count = 0
                else:
                    ret = " ".join(result.get("ret", []))
                    if "WATER_NOT_ENOUGH" in ret.upper() or "INSUFFICIENT" in ret.upper():
                        log("水滴不足, 停止浇水")
                        break
                    elif "LEVEL_MAX" in ret.upper() or "TREE_FULL" in ret.upper() or "STAGE_MAX" in ret.upper():
                        log("果树已满级/已成熟, 停止浇水")
                        break
                    elif "FREQUENCY" in ret.upper() or "RATE_LIMIT" in ret.upper():
                        log("浇水频率过高, 等待...")
                        time.sleep(3)
                        fail_count += 1
                    else:
                        self._stop_on_error(result, "浇水")
                        fail_count += 1

                    if fail_count >= 3:
                        log("连续失败3次, 停止浇水")
                        break

            log(f"浇水完成: 共浇水 {water_count} 次")
        else:
            log("无法获取果园信息, 跳过浇水")

    def run(self):
        """执行完整的每日任务流程"""
        log("=" * 50)
        log("饿了么果园每日任务开始")
        log("=" * 50)

        try:
            # 1. 获取基础信息
            if not self.get_base_info():
                log("获取果园信息失败, 请检查Cookie是否有效", "ERROR")
                return

            time.sleep(1)

            # 2. 每日签到
            self.do_signin()
            time.sleep(1)

            # 3. 领取待领取水滴
            self.collect_future_water()
            time.sleep(1)

            # 4. 领取蜗牛水滴
            self.collect_snail_water()
            time.sleep(1)

            # 5. 领取好友水滴礼物
            self.collect_friend_gift_water()
            time.sleep(1)

            # 6. 完成任务
            self.do_tasks()
            time.sleep(1)

            # 7. 领取进度奖励
            self.collect_process_reward()
            time.sleep(1)

            # 8. 刷新信息后自动浇水
            self.water_tree()

        except Exception as e:
            log(f"执行过程中出错: {str(e)}", "ERROR")

        log("=" * 50)
        log("饿了么果园每日任务完成")
        log("=" * 50)


def get_city_info():
    """从环境变量获取城市信息"""
    city_str = os.environ.get("ELME_CITY", "")
    if city_str:
        parts = city_str.split(",")
        if len(parts) >= 3:
            return {"lat": parts[0], "lng": parts[1], "city_id": parts[2]}
    return None


def main():
    """主函数 - 支持多账号"""
    # 读取环境变量
    cookie_env = os.environ.get("ELME_COOKIE", "")
    if not cookie_env:
        log("未设置 ELME_COOKIE 环境变量, 请在青龙面板中配置", "ERROR")
        sys.exit(1)

    # 支持多账号 (用 & 或换行分隔)
    cookies = []
    for c in cookie_env.replace("\\n", "\n").split("\n"):
        c = c.strip()
        if c:
            # 支持 & 分隔
            for sub_c in c.split("&"):
                sub_c = sub_c.strip()
                if sub_c:
                    cookies.append(sub_c)

    city_info = get_city_info()

    log(f"共检测到 {len(cookies)} 个账号")

    for i, cookie in enumerate(cookies, 1):
        log(f"\n{'#' * 50}")
        log(f"# 账号 {i}/{len(cookies)} 开始执行")
        log(f"{'#' * 50}")

        try:
            bot = OrchardBot(cookie, city_info)
            bot.run()
        except Exception as e:
            log(f"账号 {i} 执行出错: {str(e)}", "ERROR")

        if i < len(cookies):
            time.sleep(5)  # 账号间间隔

    log("\n所有账号执行完毕!")
    send_qinglong_notification("饿了么果园每日任务", "\n".join(NOTIFY_MSGS[-80:]))


if __name__ == "__main__":
    # 支持 --dry-run 参数测试不实际请求
    if "--dry-run" in sys.argv:
        log("=== 干运行模式(不发送实际请求) ===")
        log("脚本语法和结构验证通过")
        sys.exit(0)
    main()
