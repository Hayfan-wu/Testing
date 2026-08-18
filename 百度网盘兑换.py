#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# cron "30 0 * * *"
# new Env("百度网盘金币兑换")
"""
名称: 百度网盘金币自动兑换
功能: 查询百度网盘金币余额和积分商城商品列表，自动兑换指定商品
作者: TRAE
日期: 2026-08-18

============================== 环境变量 ==============================
BAIDU_COOKIE  百度网盘 Cookie，多账号用换行 \\n 分隔。
              每行格式: BDUSS=xxxxxx; STOKEN=xxxxxx;
              (必填，与每日任务脚本共用 Cookie)

BAIDU_DEVICE  (可选) 设备参数，多账号用换行分隔，每行格式:
              cuid,devuid,idfa,idfv
              留空则按账号自动生成稳定设备指纹。

BAIDU_NOTIFY   (可选) 通知开关，留空或 true 为开启，false 为关闭。

BAIDU_EXCHANGE_ITEMS (可选) 要兑换的商品关键词，多个用逗号分隔。
                 脚本会查询商品列表后，按关键词模糊匹配。
                 例如: 京东卡,SVIP,现金红包
                 留空则仅查询金币余额和商品列表，不执行兑换。
                 商品是否有货及所需金币以积分商城实际展示为准。

============================== 获取 Cookie ==============================
1. 浏览器登录百度网盘网页版 https://pan.baidu.com
2. F12 -> Application/应用 -> Cookies -> pan.baidu.com
3. 复制 BDUSS 和 STOKEN 两个值
4. 拼接为: BDUSS=你的值; STOKEN=你的值;
5. 填入青龙环境变量 BAIDU_COOKIE

============================== 接口说明 ==============================
金币兑换使用百度网盘「积分商城」(pan.baidu.com/shop/product/list)，
金币来源于每日任务获得的金币(coins/points/balance)，
与每日任务脚本使用相同的积分体系，域名均为 pan.baidu.com。

已验证可用接口:
  - GET /rest/2.0/membership/level?method=query   查询会员等级(登录校验)
  - GET /coins/points/balance                     查询金币余额
  - GET /shop/product/list                         获取积分商城商品列表
  - GET /shop/product/detail                       获取商品详情

兑换接口(受HTJ反作弊保护，脚本尽力尝试):
  - POST /pmall/points/exchange                   积分兑换(errno=373需验证)
  - POST /point/order/add                         创建兑换订单(errno=8001需验证)

注意: 兑换接口受HTJ反作弊限制，部分商品需手机验证后在App端兑换。
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
    """根据 BDUSS 生成稳定的设备指纹。"""
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
    """解析 BAIDU_DEVICE，多账号按换行分隔。"""
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
    """百度网盘金币商城自动兑换。

    使用与每日任务相同的 BDUSS/STOKEN 和设备参数进行认证。
    金币来源于每日任务获得的金币（积分商城金币）。
    """

    UA_IOS = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
              "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148;"
              "netdisk;13.29.6;iPhone14ProMax;ios-iphone;26.5;zh_CN;JSbridge4.4.2;jointBridge;1.1.0;")
    UA_WEB = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36")
    REFERER = ("https://pan.baidu.com/operation/activitys/points/shop"
               "?executerefresh=1&na_immerse_theme=1&pcentercome=1")

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
        """金币接口通用参数。"""
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

    def _coins_post(self, path, extra=None):
        url = "https://pan.baidu.com" + path
        headers = {
            "Referer": self.REFERER,
            "Cookie": self.cookie,
            "Content-Type": "application/x-www-form-urlencoded",
        }
        try:
            r = self.session.post(url, params=self._coins_params(extra), headers=headers, timeout=20)
            return r.json()
        except Exception as e:
            return {"errno": -1, "error": str(e)}

    def _membership_get(self, method):
        """会员等级接口(用于登录校验)。"""
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

    # ---------- 查询金币余额 ----------
    def query_balance(self):
        """查询金币余额。

        接口: GET /coins/points/balance
        参数: ptype=5
        返回: {"balance": 8100, "errno": 0, ...}
        """
        data = self._coins_get("/coins/points/balance", {"ptype": "5"})
        if data.get("errno") == 0:
            balance = data.get("balance", 0)
            today = data.get("today_points", 0)
            self.results.append(("金币余额", "信息", "当前金币 %s (今日获得 %s)" % (balance, today)))
            return int(balance)
        self.results.append(("金币余额", "查询失败", "errno=%s %s" %
                             (data.get("errno", -1), data.get("error", data.get("show_msg", "未知错误")))))
        return 0

    # ---------- 获取商品列表 ----------
    def list_goods(self):
        """获取积分商城商品列表。

        接口: GET /shop/product/list
        参数: business_type=2, unit=2, page=1, size=50
        返回商品列表，每项包含:
          - pid: 商品ID
          - name: 商品名称
          - selling_price: 所需金币
          - total_stock: 总库存
          - instock_status: 库存状态(1=有货)
          - push_token: 商品令牌(兑换时可能需要)
          - ptype: 商品类型
          - group_name: 商品分组
          - category_level1: 分类(直充/实物/券码/券链接)
          - exchange_limit_type: 兑换时间限制类型(1=限时)
          - exchange_limit_start/end: 兑换时间窗口
        """
        all_goods = []
        page = 1
        while True:
            data = self._coins_get("/shop/product/list", {
                "page": str(page),
                "size": "50",
                "business_type": "2",
                "unit": "2",
            })
            if data.get("errno") != 0:
                if page == 1:
                    self.results.append(("商品列表", "查询失败", "errno=%s %s" %
                                         (data.get("errno", -1), data.get("show_msg", data.get("error", "")))))
                break

            d = data.get("data", {})
            product_infos = d.get("product_infos") or []
            flash_sale_prod = d.get("flash_sale_prod") or []

            # 普通商品
            for p in product_infos:
                goods = self._parse_product(p)
                if goods:
                    all_goods.append(goods)

            # 秒杀商品
            for flash in flash_sale_prod:
                for p in flash.get("prod_infos", []):
                    goods = self._parse_product(p)
                    if goods:
                        goods["banner"] = flash.get("title", "") + " " + p.get("banner_text", "")
                        all_goods.append(goods)

            pages = d.get("pages", 1)
            if page >= pages or not product_infos:
                break
            page += 1
            time.sleep(0.5)

        if all_goods:
            # 按价格排序显示
            all_goods.sort(key=lambda x: x["price"])
            goods_info = "共%d个商品" % len(all_goods)
            for g in all_goods[:8]:
                stock_str = "有货" if g["stock"] > 0 else "无货"
                goods_info += "\n  %s - %s金币 [%s] %s" % (g["name"], g["price"], g["category"], stock_str)
            self.results.append(("商品列表", "信息", goods_info))
        else:
            self.results.append(("商品列表", "信息", "无可用商品"))

        return all_goods

    def _parse_product(self, p):
        """解析商品信息。"""
        if not isinstance(p, dict):
            return None
        return {
            "name": str(p.get("name", "?")),
            "pid": str(p.get("pid", "")),
            "price": int(p.get("selling_price", 0) or 0),
            "stock": int(p.get("total_stock", 0) or 0),
            "instock": int(p.get("instock_status", 0) or 0),
            "push_token": str(p.get("push_token", "")),
            "ptype": str(p.get("ptype", "")),
            "group": str(p.get("group_name", "")),
            "category": str(p.get("category_level1", "")),
            "exchange_limit_type": int(p.get("exchange_limit_type", 0) or 0),
            "exchange_limit_start": str(p.get("exchange_limit_start", "")),
            "exchange_limit_end": str(p.get("exchange_limit_end", "")),
        }

    # ---------- 获取商品详情 ----------
    def get_product_detail(self, pid):
        """获取商品详情。

        接口: GET /shop/product/detail
        参数: pid=xxx, business_type=2
        """
        data = self._coins_get("/shop/product/detail", {
            "pid": str(pid),
            "business_type": "2",
        })
        if data.get("errno") == 0:
            d = data.get("data", {})
            return {
                "pid": d.get("pid", pid),
                "name": d.get("name", ""),
                "price": int(d.get("selling_price", 0) or 0),
                "stock": int(d.get("total_stock", 0) or 0),
                "instock": int(d.get("instock_status", 0) or 0),
                "push_token": d.get("push_token", ""),
                "ptype": str(d.get("ptype", "")),
                "describe": d.get("product_describe", ""),
                "exchange_limit_type": int(d.get("exchange_limit_type", 0) or 0),
                "exchange_limit_start": d.get("exchange_limit_start", ""),
                "exchange_limit_end": d.get("exchange_limit_end", ""),
            }
        return None

    # ---------- 兑换商品 ----------
    def exchange_product(self, goods):
        """尝试兑换商品。

        兑换接口:
        1. POST /pmall/points/exchange (errno=373 需验证)
        2. POST /point/order/add (errno=8001 需验证)

        两个接口均受HTJ反作弊保护，脚本尽力尝试。
        """
        pid = goods["pid"]
        push_token = goods.get("push_token", "")
        ptype = goods.get("ptype", "5")

        self.results.append(("积分兑换", "尝试", "兑换 %s (pid:%s, %s金币)..." %
                             (goods["name"], pid, goods["price"])))

        # 尝试 /pmall/points/exchange
        exchange_data = self._coins_post("/pmall/points/exchange", {
            "pid": pid,
            "push_token": push_token,
            "ptype": ptype,
        })
        errno = exchange_data.get("errno", -1)
        if errno == 0:
            self.results.append(("积分兑换", "成功", "%s 兑换成功!" % goods["name"]))
            return True

        # 尝试 /point/order/add
        order_data = self._coins_post("/point/order/add", {
            "pid": pid,
            "business_type": "2",
            "push_token": push_token,
        })
        errno2 = order_data.get("errno", -1)
        if errno2 == 0:
            self.results.append(("积分兑换", "成功", "%s 兑换成功! %s" %
                                 (goods["name"], order_data.get("data", ""))))
            return True

        # 错误处理
        if errno == 373:
            self.results.append(("积分兑换", "受限", "%s 兑换需验证(errno=373)，请到App端兑换" %
                                 goods["name"]))
        elif errno == 8001 or errno2 == 8001:
            self.results.append(("积分兑换", "受限", "%s 被HTJ反作弊拦截(errno=8001)，请到App端兑换" %
                                 goods["name"]))
        else:
            self.results.append(("积分兑换", "失败", "%s errno=%s/%s %s" %
                                 (goods["name"], errno, errno2,
                                  exchange_data.get("error", exchange_data.get("show_msg", "")))))

        return False

    # ---------- 兑换流程 ----------
    def exchange_goods(self, keywords):
        """按关键词匹配并兑换商品。

        流程:
        1. 查询金币余额
        2. 获取商品列表
        3. 按关键词匹配目标商品
        4. 检查金币和库存
        5. 尝试兑换

        Args:
            keywords: 商品关键词列表，如 ["京东卡", "SVIP", "现金红包"]
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
            return

        # 按价格从低到高排序，优先兑换便宜的
        targets.sort(key=lambda x: x["price"])

        for t in targets:
            if t["price"] <= 0:
                self.results.append(("积分兑换", "跳过", "%s 价格异常(%s)" % (t["name"], t["price"])))
                continue
            if t["instock"] != 1:
                self.results.append(("积分兑换", "无货", "%s 已兑完" % t["name"]))
                continue
            if balance < t["price"]:
                self.results.append(("积分兑换", "金币不足",
                                     "%s 需要 %s 金币，当前仅 %s 金币" % (t["name"], t["price"], balance)))
                continue

            # 尝试兑换
            success = self.exchange_product(t)
            if success:
                balance -= t["price"]

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
        notify("百度网盘金币兑换", "\n\n".join(all_summary))
    print("\n全部账号执行完毕。")


if __name__ == "__main__":
    main()
