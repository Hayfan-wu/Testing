#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# cron "30 0 * * *"
# new Env("百度网盘积分兑换")
"""
名称: 百度网盘积分自动兑换
功能: 使用百度网盘每日任务获得的积分（金币），在移动端积分商城自动兑换商品
作者: TRAE
日期: 2026-08-18

============================== 环境变量 ==============================
BAIDU_COOKIE  百度网盘 Cookie，多账号用换行 \n 分隔。
              每行格式: BDUSS=xxxxxx; STOKEN=xxxxxx;
              (必填，与每日任务脚本共用 Cookie)

BAIDU_DEVICE  (可选) 设备参数，多账号用换行分隔，每行格式:
              cuid,devuid,idfa,idfv
              留空则按账号自动生成稳定设备指纹。

BAIDU_NOTIFY   (可选) 通知开关，留空或 true 为开启，false 为关闭。

BAIDU_EXCHANGE_ITEMS (可选) 要兑换的商品关键词，多个用逗号分隔。
                 脚本会查询商品列表后，按关键词模糊匹配。
                 例如: 小度,京东E卡,30元
                 留空则仅查询积分余额和商品列表，不执行兑换。
                 商品是否有货及所需积分以积分商城实际展示为准。

============================== 获取 Cookie ==============================
1. 浏览器登录百度网盘网页版 https://pan.baidu.com
2. F12 -> Application/应用 -> Cookies -> pan.baidu.com
3. 复制 BDUSS 和 STOKEN 两个值
4. 拼接为: BDUSS=你的值; STOKEN=你的值;
5. 填入青龙环境变量 BAIDU_COOKIE

============================== 接口说明 ==============================
积分兑换使用百度网盘任务中心积分（每日任务获得的金币），
与每日任务脚本使用相同的积分体系，域名均为 pan.baidu.com。

  - GET /rest/2.0/membership/level?method=query   查询会员等级(用于登录校验)
  - GET /coins/taskcenter/home                     查询积分余额
  - GET /act/v2/component/getgoodslist             获取可兑换商品列表
  - GET /coins/taskcenter/reward                   兑换指定商品(需 exchange_id)

注意: 兑换接口可能受HTJ反作弊限制，部分商品需在App端手动兑换。
=====================================================================
"""

import os
import time
import random
import hashlib
import requests

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


class BaiduNetdiskExchange:
    """百度网盘积分商城自动兑换。

    使用与每日任务相同的 BDUSS/STOKEN 和设备参数进行认证。
    积分来源于每日任务获得的金币（任务中心积分）。
    """

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
        self.results = []  # [(任务名, 状态, 详情)]

    # ---------- 通用请求 ----------
    def _coins_params(self, extra=None):
        """积分任务中心接口通用参数(与每日任务脚本一致)。"""
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
        """会员成长值接口(用于登录校验)。"""
        url = "https://pan.baidu.com/rest/2.0/membership/level"
        params = {"app_id": "250528", "web": "5", "method": method}
        headers = {"User-Agent": self.UA_WEB, "Referer": "https://pan.baidu.com/", "Cookie": self.cookie}
        try:
            r = self.session.get(url, params=params, headers=headers, timeout=20)
            return r.json()
        except Exception as e:
            return {"error_code": -1, "error_msg": str(e)}

    # ---------- 登录校验 ----------
    def check_login(self):
        """校验 Cookie 是否有效。"""
        data = self._membership_get("query")
        if data.get("error_code") == 0:
            d = data.get("data", {})
            self.nickname = "Lv%s会员" % d.get("current_level", "?")
            return True
        return False

    # ---------- 查询积分余额 ----------
    def query_balance(self):
        """查询网盘积分余额。"""
        data = self._coins_get("/coins/taskcenter/home", {"go_home": "1", "ptype": "5"})
        if data.get("errno") == 0:
            balance = data.get("data", {}).get("points_balance", 0)
            self.results.append(("积分余额", "信息", "当前积分 %s" % balance))
            return int(balance)
        self.results.append(("积分余额", "查询失败", data.get("error", "未知错误")))
        return 0

    # ---------- 获取可兑换商品列表 ----------
    def list_goods(self):
        """获取可兑换商品列表。

        接口: /act/v2/component/getgoodslist
        返回商品列表，每项包含: name(名称), exchange_id(兑换ID), price(所需积分), stock(库存) 等。
        """
        goods = []
        # 尝试不同的参数组合，因为不同版本接口参数可能不同
        for params in [
            {"component_id": "exchange"},
            {"component_id": "exchange", "ptype": "5"},
            {"ptype": "5"},
            {},
        ]:
            data = self._coins_get("/act/v2/component/getgoodslist", params)
            if data.get("errno") == 0:
                break
            # 如果返回非0，尝试下一组参数
            time.sleep(0.5)

        if data.get("errno") != 0:
            self.results.append(("商品列表", "查询失败", "errno=%s %s" %
                                 (data.get("errno", -1), data.get("error", data.get("show_msg", "未知错误")))))
            return goods

        # 解析商品列表(兼容多种返回格式)
        raw_list = []
        result = data.get("result", {})
        if isinstance(result, dict):
            raw_list = result.get("list", result.get("goods", result.get("items", [])))
        elif isinstance(result, list):
            raw_list = result
        elif isinstance(data.get("data"), list):
            raw_list = data.get("data", [])
        elif isinstance(data.get("data"), dict):
            d = data.get("data", {})
            raw_list = d.get("list", d.get("goods", d.get("items", [])))

        for g in raw_list:
            if not isinstance(g, dict):
                continue
            name = g.get("name", g.get("title", g.get("goods_name", "?")))
            exchange_id = g.get("exchange_id", g.get("id", g.get("goods_id", "")))
            price = g.get("price", g.get("score", g.get("points", g.get("exchange_score", 0))))
            stock = g.get("stock", g.get("inventory", g.get("remain", 1)))
            status = g.get("status", g.get("goods_status", 1))
            desc = g.get("desc", g.get("description", ""))

            goods.append({
                "name": str(name),
                "exchange_id": str(exchange_id),
                "price": int(price) if price else 0,
                "stock": int(stock) if stock is not None else 1,
                "status": status,
                "desc": str(desc),
            })

        if goods:
            goods_info = "共%s个商品" % len(goods)
            for g in goods[:5]:
                goods_info += " | %s(%s积分)" % (g["name"], g["price"])
            self.results.append(("商品列表", "信息", goods_info))
        else:
            self.results.append(("商品列表", "信息", "无可用商品"))

        return goods

    # ---------- 兑换商品 ----------
    def exchange_goods(self, keywords):
        """按关键词匹配并兑换商品。

        流程:
        1. 查询积分余额
        2. 获取商品列表
        3. 按关键词匹配目标商品
        4. 检查积分和库存
        5. 调用兑换接口

        Args:
            keywords: 商品关键词列表，如 ["小度", "京东E卡", "30元"]
                      留空则仅查询信息不兑换
        """
        balance = self.query_balance()
        goods = self.list_goods()

        if not goods:
            return

        if not keywords:
            # 无关键词，仅查询信息
            return

        # 按关键词匹配商品
        targets = []
        for kw in keywords:
            kw = kw.strip()
            if not kw:
                continue
            for g in goods:
                # 模糊匹配: 商品名包含关键词
                if kw in g["name"] or kw.lower() in g["name"].lower():
                    if g not in targets:
                        targets.append(g)

        if not targets:
            self.results.append(("积分兑换", "信息", "未找到匹配「%s」的商品" % ",".join(keywords)))
            # 输出可用商品列表供参考
            for g in goods[:10]:
                self.results.append(("可用商品", "信息", "%s (ID:%s, %s积分, 库存:%s)" %
                                     (g["name"], g["exchange_id"], g["price"], g["stock"])))
            return

        # 按积分从低到高排序，优先兑换便宜的
        targets.sort(key=lambda x: x["price"])

        for t in targets:
            if t["price"] <= 0:
                self.results.append(("积分兑换", "跳过", "%s 价格异常(%s)" % (t["name"], t["price"])))
                continue
            if t["stock"] is not None and t["stock"] <= 0:
                self.results.append(("积分兑换", "无货", "%s 已兑完" % t["name"]))
                continue
            if balance < t["price"]:
                self.results.append(("积分兑换", "积分不足",
                                     "%s 需要 %s 积分，当前仅 %s 积分" % (t["name"], t["price"], balance)))
                continue

            # 尝试兑换
            self.results.append(("积分兑换", "尝试", "兑换 %s (ID:%s, %s积分)..." %
                                 (t["name"], t["exchange_id"], t["price"])))
            exchange_data = self._coins_get("/coins/taskcenter/reward", {
                "exchange_id": t["exchange_id"],
                "ptype": "5",
            })

            errno = exchange_data.get("errno", -1)
            msg = exchange_data.get("show_msg", exchange_data.get("error", ""))

            if errno == 0:
                self.results.append(("积分兑换", "成功", "%s 兑换成功! %s" % (t["name"], msg)))
                balance -= t["price"]
            elif errno in (8001, 8002):
                self.results.append(("积分兑换", "受限", "%s 被HTJ反作弊拦截(需App端兑换)" % t["name"]))
            elif errno == 40003 or errno == 40004:
                self.results.append(("积分兑换", "已兑", "%s 今日已兑换过" % t["name"]))
            else:
                self.results.append(("积分兑换", "失败", "%s errno=%s %s" % (t["name"], errno, msg)))

            time.sleep(1)

    # ---------- 主流程 ----------
    def run(self, keywords=None):
        """执行兑换流程。"""
        if not self.check_login():
            self.results.append(("账号校验", "失败", "Cookie 失效或网络异常，请检查 BDUSS/STOKEN"))
            return self.results
        self.results.append(("账号校验", "成功", self.nickname))
        self.exchange_goods(keywords or [])
        return self.results


# ---------------------- 主入口 ----------------------
def main():
    cookies = parse_cookies(os.getenv("BAIDU_COOKIE", ""))
    if not cookies:
        print("未检测到 BAIDU_COOKIE 环境变量，请在青龙中配置。")
        print("格式: BDUSS=xxxxxx; STOKEN=xxxxxx;  多账号换行分隔")
        return

    devices = parse_devices(os.getenv("BAIDU_DEVICE", ""), len(cookies))
    notify_on = os.getenv("BAIDU_NOTIFY", "true").lower() != "false"
    # 兑换商品关键词(逗号分隔)
    exchange_items_str = os.getenv("BAIDU_EXCHANGE_ITEMS", "")
    keywords = [kw.strip() for kw in exchange_items_str.split(",") if kw.strip()]

    all_summary = []
    for idx, ck in enumerate(cookies):
        banner = "===== 账号 %s =====" % (idx + 1)
        print("\n" + banner)
        exchange = BaiduNetdiskExchange(ck["BDUSS"], ck["STOKEN"], devices[idx])
        results = exchange.run(keywords=keywords)

        lines = []
        for name, status, detail in results:
            line = "[%s] %s: %s" % (status, name, detail)
            print(line)
            lines.append(line)
        all_summary.append(banner + "\n" + "\n".join(lines))
        if idx < len(cookies) - 1:
            time.sleep(random.randint(3, 8))  # 账号间随机延时

    # 汇总通知
    if notify_on:
        notify("百度网盘积分兑换", "\n\n".join(all_summary))
    print("\n全部账号执行完毕。")


if __name__ == "__main__":
    main()