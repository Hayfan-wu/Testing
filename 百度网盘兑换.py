#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# cron "30 0 * * *"
# new Env("百度网盘积分兑换")
"""
名称: 百度网盘积分自动兑换
功能: 在百度Comate积分商城自动兑换京东E卡、小度音响等物品
作者: TRAE
日期: 2026-08-18

============================== 环境变量 ==============================
BAIDU_COOKIE  百度网盘 Cookie，多账号用换行 \n 分隔。
              每行格式: BDUSS=xxxxxx; STOKEN=xxxxxx;
              (必填，与每日任务脚本共用 Cookie)

BAIDU_NOTIFY   (可选) 通知开关，留空或 true 为开启，false 为关闭。

BAIDU_EXCHANGE_ITEMS (可选) 要兑换的商品代码，多个用逗号分隔。
                 可选值: JD_30(京东E卡30元), JD_50(京东E卡50元),
                 JD_100(京东E卡100元), XIAODU(小度音响),
                 SVIP_7(超级会员7天), SVIP_30(超级会员30天)
                 默认: JD_30
                 商品是否有货及所需积分以积分商城实际展示为准。

============================== 获取 Cookie ==============================
1. 浏览器登录百度网盘网页版 https://pan.baidu.com
2. F12 -> Application/应用 -> Cookies -> pan.baidu.com
3. 复制 BDUSS 和 STOKEN 两个值
4. 拼接为: BDUSS=你的值; STOKEN=你的值;
5. 填入青龙环境变量 BAIDU_COOKIE

============================== Comate 接口说明 ==============================
积分商城使用与百度网盘相同的 BDUSS 进行认证，积分体系相互独立。

  - GET /api/user                   查询用户信息
  - GET /api/user/score/balance     查询积分余额
  - GET /api/goods/list             获取可兑换商品列表
  - GET /api/mall/meta              获取商城元数据/兑换规则
  - GET /api/mall/limit/rules?code  查询商品兑换限额
  - GET /api/mall/order/list        查询历史兑换订单
  - POST /api/mall/order/create     创建兑换订单(需携带商品code)

注意: Comate 积分与百度网盘积分不同，是百度Comate平台的独立积分体系。
=====================================================================
"""

import os
import time
import random
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


# ---------------------- 工具函数（内联，无需依赖 task 脚本） ----------------------
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


# ====================== 百度Comate积分自动兑换 ======================
_EXCHANGE_DOMAIN = "https://comate.baidu.com"
# 商品代码映射(商品名 -> code)
_EXCHANGE_ITEM_CODES = {
    "JD_30": "JD_30",       # 京东E卡30元
    "JD_50": "JD_50",       # 京东E卡50元
    "JD_100": "JD_100",     # 京东E卡100元
    "XIAODU": "XIAODU",     # 小度音响
    "SVIP_7": "SVIP_7",     # 超级会员7天
    "SVIP_30": "SVIP_30",   # 超级会员30天
}


class ComateExchange:
    """百度Comate积分商城自动兑换。

    使用百度网盘相同的 BDUSS/STOKEN 进行认证。
    注意: 积分体系与百度网盘相互独立，需在Comate平台获取。
    """

    UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

    def __init__(self, bduss, stoken):
        self.bduss = bduss
        self.stoken = stoken
        self.cookie = "BDUSS=%s; STOKEN=%s;" % (bduss, stoken)
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": self.UA,
            "Referer": "https://comate.baidu.com/zh/shopping",
        })
        self.results = []  # [(任务名, 状态, 详情)]

    def _api_get(self, path, params=None):
        """调用 Comate API(GET)。"""
        url = _EXCHANGE_DOMAIN + path
        headers = {
            "Cookie": self.cookie,
            "Referer": "https://comate.baidu.com/zh/shopping",
            "Origin": "https://comate.baidu.com",
        }
        try:
            r = self.session.get(url, params=params, headers=headers, timeout=20)
            if r.status_code == 200:
                return r.json()
            return {"status": "ERROR", "message": "HTTP %s" % r.status_code}
        except Exception as e:
            return {"status": "ERROR", "message": str(e)}

    def _api_post(self, path, data=None):
        """调用 Comate API(POST)。"""
        url = _EXCHANGE_DOMAIN + path
        headers = {
            "Cookie": self.cookie,
            "Referer": "https://comate.baidu.com/zh/shopping",
            "Origin": "https://comate.baidu.com",
            "Content-Type": "application/json",
        }
        try:
            r = self.session.post(url, json=data, headers=headers, timeout=20)
            if r.status_code == 200:
                return r.json()
            return {"status": "ERROR", "message": "HTTP %s" % r.status_code}
        except Exception as e:
            return {"status": "ERROR", "message": str(e)}

    def check_auth(self):
        """检查Comate平台的认证状态。"""
        data = self._api_get("/api/user")
        if data.get("status") == "UNAUTHORIZED":
            self.results.append(("Comate认证", "失败", "BDUSS未授权，请重新登录"))
            return False
        if data.get("status") == "SUCCESS" or data.get("data"):
            nickname = data.get("data", {}).get("nickname", "") or data.get("data", {}).get("username", "")
            self.results.append(("Comate认证", "成功", "用户: %s" % (nickname or "未知")))
            return True
        self.results.append(("Comate认证", "未知", str(data)[:100]))
        return False

    def query_balance(self):
        """查询Comate平台积分余额。"""
        data = self._api_get("/api/user/score/balance")
        if data.get("status") == "SUCCESS" or data.get("data") is not None:
            balance = data.get("data", 0)
            if isinstance(balance, dict):
                balance = balance.get("balance", balance.get("score", 0))
            self.results.append(("Comate积分余额", "信息", "当前积分 %s" % balance))
            return int(balance)
        self.results.append(("Comate积分余额", "查询失败", str(data)[:100]))
        return 0

    def list_goods(self):
        """获取可兑换商品列表，返回 (商品列表, 当前积分)。"""
        goods = []
        balance = self.query_balance()

        data = self._api_get("/api/goods/list")
        if data.get("status") == "SUCCESS" and data.get("data"):
            goods_list = data.get("data", [])
            if isinstance(goods_list, list):
                goods = goods_list
            elif isinstance(goods_list, dict):
                goods = goods_list.get("list", goods_list.get("items", []))
        else:
            self.results.append(("Comate商品列表", "查询失败", str(data)[:100]))
            return goods, balance

        # 筛选可兑换且有库存的商品
        avail = []
        for g in goods:
            name = g.get("name", g.get("title", g.get("goodsName", "?")))
            code = g.get("code", g.get("goodsCode", g.get("id", "")))
            price = int(g.get("price", g.get("score", g.get("points", 0))))
            stock = g.get("stock", g.get("inventory", 1))
            # 查询该商品的兑换限额
            limit_data = self._api_get("/api/mall/limit/rules", {"code": code})
            if limit_data.get("status") == "SUCCESS" and limit_data.get("data"):
                pass  # 限额信息保留备用

            avail.append({
                "name": name,
                "code": str(code),
                "price": price,
                "stock": stock,
            })

        if avail:
            goods_info = "共%s个商品" % len(avail)
            for g in avail[:5]:  # 最多显示5个
                goods_info += " | %s(%s积分)" % (g["name"], g["price"])
            self.results.append(("Comate商品列表", "信息", goods_info))
        else:
            self.results.append(("Comate商品列表", "信息", "无可用商品或查询失败"))

        return avail, balance

    def exchange_goods(self, target_codes):
        """尝试兑换指定商品。

        Args:
            target_codes: 要兑换的商品代码列表，如 ["JD_30", "JD_50"]
        """
        goods, balance = self.list_goods()
        if not goods:
            return

        # 匹配目标商品
        targets = []
        for code in target_codes:
            matched = [g for g in goods if g["code"] == code or g["name"].find(code.replace("_", "")) >= 0]
            targets.extend(matched)

        if not targets:
            self.results.append(("Comate兑换", "信息", "未找到匹配的目标商品(代码: %s)" % ",".join(target_codes)))
            return

        for t in targets:
            if t["price"] <= 0:
                self.results.append(("Comate兑换", "跳过", "%s 价格异常(%s)" % (t["name"], t["price"])))
                continue
            if t["stock"] is not None and t["stock"] <= 0:
                self.results.append(("Comate兑换", "无货", "%s 已兑完" % t["name"]))
                continue
            if balance < t["price"]:
                self.results.append(("Comate兑换", "积分不足", "%s 需要 %s 积分，当前仅 %s 积分" %
                                     (t["name"], t["price"], balance)))
                continue

            # 尝试创建兑换订单
            self.results.append(("Comate兑换", "尝试", "兑换 %s (%s积分)..." % (t["name"], t["price"])))
            order_data = self._api_post("/api/mall/order/create", {
                "goodsCode": t["code"],
                "goodsName": t["name"],
                "quantity": 1,
            })

            status = order_data.get("status", "")
            msg = order_data.get("message", "")
            if status == "SUCCESS" or order_data.get("data"):
                order_id = ""
                if isinstance(order_data.get("data"), dict):
                    order_id = order_data["data"].get("orderId", order_data["data"].get("id", ""))
                self.results.append(("Comate兑换", "成功", "兑换 %s 成功! 订单号: %s" % (t["name"], order_id or "未知")))
                balance -= t["price"]
            elif status == "UNAUTHORIZED":
                self.results.append(("Comate兑换", "失败", "认证失败，请重新登录"))
                break
            else:
                self.results.append(("Comate兑换", "失败", "%s: %s" % (t["name"], msg or str(order_data)[:80])))

            time.sleep(1)

    def run(self, target_codes=None):
        """执行兑换流程。

        Args:
            target_codes: 要兑换的商品代码列表
        """
        if not self.check_auth():
            return self.results
        if target_codes:
            self.exchange_goods(target_codes)
        else:
            # 无目标商品时，仅查询信息
            self.query_balance()
            self.list_goods()
        return self.results


# ---------------------- 主入口 ----------------------
def main():
    cookies = parse_cookies(os.getenv("BAIDU_COOKIE", ""))
    if not cookies:
        print("未检测到 BAIDU_COOKIE 环境变量，请在青龙中配置。")
        print("格式: BDUSS=xxxxxx; STOKEN=xxxxxx;  多账号换行分隔")
        return

    notify_on = os.getenv("BAIDU_NOTIFY", "true").lower() != "false"
    # 要兑换的商品代码(逗号分隔)
    exchange_items_str = os.getenv("BAIDU_EXCHANGE_ITEMS", "JD_30")
    exchange_items = [item.strip() for item in exchange_items_str.split(",") if item.strip()]

    all_summary = []
    for idx, ck in enumerate(cookies):
        banner = "===== 账号 %s =====" % (idx + 1)
        print("\n" + banner)
        exchange = ComateExchange(ck["BDUSS"], ck["STOKEN"])
        results = exchange.run(target_codes=exchange_items)

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