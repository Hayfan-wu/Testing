#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
网易云音乐 云朵(云贝)任务自动化脚本 - 青龙面板版
逆向自网易云音乐 Android APK v9.4.90

环境变量:
  NETEASE_MUSIC_U - 网易云 MUSIC_U cookie (多账号用 & 分隔)

cron: 30 8 * * *
new Env('网易云云朵任务');
"""

import os, sys, json, time, random, hashlib, binascii, requests
from datetime import datetime

# === EAPI 加密 (逆向自 j52/a.java, b52/a.java) ===
EAPI_KEY = b"0CoJUm6Qyw8W8jud"
EAPI_IV  = b"0102030405060708"
BASE_URL = "https://interface3.music.163.com"

try:
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad, unpad
except ImportError:
    os.system(f"{sys.executable} -m pip install pycryptodome -q")
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad, unpad


def aes_encrypt(data: str) -> str:
    """AES-128-CBC 加密 (逆向自 com.netease.cloudmusic.utils.c)"""
    cipher = AES.new(EAPI_KEY, AES.MODE_CBC, EAPI_IV)
    ct = cipher.encrypt(pad(data.encode(), AES.block_size))
    return binascii.hexlify(ct).decode()


def aes_decrypt(hex_data: str) -> str:
    """AES-128-CBC 解密"""
    cipher = AES.new(EAPI_KEY, AES.MODE_CBC, EAPI_IV)
    pt = cipher.decrypt(binascii.unhexlify(hex_data))
    return unpad(pt, AES.block_size).decode()


def eapi_encrypt_params(params: dict) -> str:
    """EAPI 请求体加密"""
    if isinstance(params, dict):
        query = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    else:
        query = str(params)
    return aes_encrypt(query)


class NeteaseCloudMusic:
    """网易云音乐 API 客户端"""

    def __init__(self, music_u: str):
        self.music_u = music_u
        self.s = requests.Session()
        self.s.verify = False
        self.s.headers.update({
            "User-Agent": "NeteaseMusic/9.4.90.240411134925(9.4.90);Dalvik/2.1.0(Linux;U;Android 13)",
            "Content-Type": "application/x-www-form-urlencoded",
            "MUSIC_U": music_u,
            "os": "android",
            "appver": "9.4.90",
            "versioncode": "240",
        })
        self.s.cookies.set("MUSIC_U", music_u, domain=".music.163.com")
        self.s.cookies.set("os", "android", domain=".music.163.com")
        self.nickname = ""

    def _eapi(self, endpoint: str, params: dict = None) -> dict:
        """EAPI 加密请求 (逆向自 k42.e.b() -> j52.a, URL: /eapi/<endpoint>)"""
        url = f"{BASE_URL}/eapi/{endpoint}"
        p = params or {}
        p.setdefault("header", json.dumps({"os":"android","appver":"9.4.90","versioncode":"240"}))
        enc = eapi_encrypt_params(p)
        try:
            r = self.s.post(url, data={"params": enc}, timeout=15)
            try:
                return json.loads(aes_decrypt(r.text))
            except Exception:
                return r.json()
        except Exception as e:
            print(f"  [!] EAPI {endpoint}: {e}")
            return {}

    def _api(self, endpoint: str, params: dict = None, method="POST") -> dict:
        """标准 API 请求 (逆向自 NeteaseMusicApiImpl.java, URL: /api/<endpoint>)"""
        url = f"{BASE_URL}/api/{endpoint}"
        try:
            if method == "POST":
                r = self.s.post(url, data=params or {}, timeout=15)
            else:
                r = self.s.get(url, params=params or {}, timeout=15)
            return r.json()
        except Exception as e:
            print(f"  [!] API {endpoint}: {e}")
            return {}

    # === 云贝 API (逆向自 dz0/h.java - YunbeiRequestApi) ===

    def get_account_entrance(self) -> dict:
        """获取云贝账户入口 (/eapi/yunbei/account/entrance/get)"""
        return self._eapi("yunbei/account/entrance/get", {"historyIds": "[]"})

    def get_rcmd_song(self, song_id, scene="yunbei_rcmd", rcmd_uid=0) -> dict:
        """获取云贝推荐歌曲 (/eapi/yunbei/rcmd/song/get)
        逆向: NeteaseMusicApiImpl line:9900"""
        return self._eapi("yunbei/rcmd/song/get", {
            "songIds": json.dumps([str(song_id)]),
            "scene": scene, "rcmdUserId": str(rcmd_uid)
        })

    def get_song_stats(self, song_id) -> dict:
        """获取歌曲推荐统计 (/eapi/yunbei/rcmd/song/statistics/get)
        逆向: dz0/h.java Companion.d()"""
        return self._eapi("yunbei/rcmd/song/statistics/get", {"songId": str(song_id)})

    def like_rcmd_song(self, song_id, rcmd_uid, cancel=False) -> dict:
        """喜欢推荐歌曲领取云贝 (/eapi/yunbei/rcmd/song/like)
        逆向: dz0/h.java Companion.i()"""
        return self._eapi("yunbei/rcmd/song/like", {
            "cancel": str(cancel).lower(),
            "songId": str(song_id), "rcmdUserId": str(rcmd_uid)
        })

    def get_reward_layer(self, res_type, res_id, ext="") -> dict:
        """获取云贝打赏层 (/eapi/reward/yunbei/layer/get)
        逆向: dz0/h.java Companion.h()"""
        return self._eapi("reward/yunbei/layer/get", {
            "resourceType": str(res_type),
            "resourceId": str(res_id), "extInfo": ext or ""
        })

    def add_reward(self, res_type, res_id, ext="", token="") -> dict:
        """领取云贝打赏 (/eapi/reward/yunbei/add)
        逆向: dz0/h.java Companion.k()"""
        if not token:
            token = hashlib.md5(f"{res_id}{int(time.time())}".encode()).hexdigest()
        return self._eapi("reward/yunbei/add", {
            "resourceType": str(res_type),
            "resourceId": str(res_id), "extInfo": ext or "",
            "checkToken": token
        })

    def get_reward_info(self, res_type, res_id, ext="") -> dict:
        """获取打赏资源信息 (/eapi/reward/yunbei/resource/info/get)
        逆向: dz0/h.java Companion.f()"""
        return self._eapi("reward/yunbei/resource/info/get", {
            "resourceType": str(res_type),
            "resourceId": str(res_id), "extInfo": ext or ""
        })

    # === 直播云贝任务 (逆向自 xy3/a.java, u04/i.java) ===

    def finish_live_task(self, params: dict) -> dict:
        """完成直播云贝任务 (POST /api/livestream/yunbeitask/finish)
        逆向: xy3/a.java a()"""
        return self._api("livestream/yunbeitask/finish", params)

    def get_live_recommend(self, params: dict) -> dict:
        """获取直播推荐 (POST /api/livestream/yunbeitask/live/recommend)
        逆向: xy3/a.java b()"""
        return self._api("livestream/yunbeitask/live/recommend", params)

    def get_live_task_config(self) -> dict:
        """获取直播任务配置 (GET /api/livestream/behavior/yunbei/task/config)
        逆向: u04/i.java b()"""
        return self._api("livestream/behavior/yunbei/task/config", method="GET")

    def complete_live_task(self, params: dict) -> dict:
        """完成直播任务 (POST /api/livestream/behavior/yunbei/task/complete)
        逆向: u04/i.java a()"""
        return self._api("livestream/behavior/yunbei/task/complete", params)

    # === 听歌曝光 (逆向自 classes5 AdPlayerTopBubbleExposedDSLView) ===

    def upload_exposure(self, stage=1) -> dict:
        """上传听歌曝光 (/eapi/new/yunbei/listen/task/exposure/upload)
        逆向: k42.e.c("new/yunbei/listen/task/exposure/upload")"""
        return self._eapi("new/yunbei/listen/task/exposure/upload", {
            "exposureStage": str(stage)
        })

    # === 积分/签到 (逆向自 NeteaseMusicApiImpl.java) ===

    def daily_signin(self) -> dict:
        """每日签到 (/eapi/point/dailySignIn)"""
        return self._eapi("point/dailySignIn", {"type": "0"})

    def retrieve_point(self) -> dict:
        """获取积分 (/api/point/retrieve)"""
        return self._api("point/retrieve")

    def get_user_info(self) -> dict:
        """获取用户信息 (/eapi/v1/user/info)"""
        return self._eapi("v1/user/info")

    def get_personal_fm(self) -> dict:
        """获取私人FM推荐歌曲"""
        return self._eapi("personalfm", {})

    def get_recent_songs(self) -> dict:
        """获取最近播放歌曲"""
        return self._eapi("song/enhance/player/recent/songs", {"limit": "10"})

    # === 任务执行主逻辑 ===

    def run(self) -> str:
        results = []
        results.append("=" * 50)
        results.append(f"网易云云朵任务 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        results.append("=" * 50)

        # 1. 用户信息
        print("[1/7] 获取用户信息...")
        info = self.get_user_info()
        if info.get("code") == 200:
            p = info.get("profile", info.get("data", {}).get("profile", {}))
            if p:
                self.nickname = p.get("nickname", "")
                results.append(f"账号: {self.nickname} (ID:{p.get('userId','?')})")
            else:
                results.append("[!] 未获取到用户信息,请检查 MUSIC_U")
                return "\n".join(results)
        else:
            results.append(f"[!] 获取用户信息失败 code={info.get('code')}")
            return "\n".join(results)

        # 2. 每日签到
        print("[2/7] 每日签到...")
        si = self.daily_signin()
        if si.get("code") == 200:
            pt = si.get("point", si.get("data", {}).get("point", 0))
            results.append(f"签到成功! 积分+{pt}")
        else:
            results.append(f"签到: {si.get('msg','可能已签到')}")

        # 3. 云贝账户入口
        print("[3/7] 云贝账户入口...")
        ent = self.get_account_entrance()
        if ent.get("code") == 200:
            d = ent.get("data", {})
            bal = d.get("balance", d.get("yunbeiBalance", "?"))
            results.append(f"云贝余额: {bal}")
        else:
            results.append(f"云贝入口: code={ent.get('code')}")

        # 4. 积分查询
        print("[4/7] 积分查询...")
        pt = self.retrieve_point()
        if pt.get("code") == 200:
            d = pt.get("data", {})
            results.append(f"积分余额: {d.get('point', d.get('total','?'))}")
        else:
            results.append(f"积分查询: code={pt.get('code')}")

        # 5. 听歌曝光上报
        print("[5/7] 听歌曝光上报...")
        for stage in range(1, 4):
            ex = self.upload_exposure(stage)
            ok = "成功" if ex.get("code") == 200 else f"code={ex.get('code')}"
            results.append(f"曝光(stage={stage}): {ok}")
            time.sleep(random.uniform(2, 4))

        # 6. 云贝推荐歌曲领取
        print("[6/7] 云贝推荐歌曲领取...")
        fm = self.get_personal_fm()
        songs = []
        if fm.get("code") == 200:
            songs = fm.get("data", {}).get("data", [])
        if songs:
            for song in songs[:5]:
                sid = song.get("id", song.get("songId", ""))
                if not sid: continue
                sname = song.get("name", song.get("songName", f"ID:{sid}"))
                # 获取统计
                st = self.get_song_stats(sid)
                rc = st.get("data", {}).get("rcmdCount", 0)
                # 领取
                ruid = song.get("rcmdUserId", 0)
                lk = self.like_rcmd_song(sid, ruid)
                if lk.get("code") == 200:
                    results.append(f"推荐领取: {sname} (rcmd={rc}) -> 成功")
                else:
                    results.append(f"推荐领取: {sname} -> {lk.get('msg','失败')}")
                time.sleep(random.uniform(3, 6))
        else:
            results.append("未获取到推荐歌曲")

        # 7. 云贝打赏领取
        print("[7/7] 云贝打赏领取...")
        recent = self.get_recent_songs()
        r_songs = []
        if recent.get("code") == 200:
            d = recent.get("data", {})
            r_songs = d.get("list", d.get("data", []))
        if r_songs:
            for song in r_songs[:5]:
                sid = str(song.get("id", song.get("songId", "")))
                if not sid or sid == "0": continue
                ri = self.get_reward_info(1, sid)
                cnt = ri.get("data", {}).get("count", 0)
                if cnt and cnt > 0:
                    cl = self.add_reward(1, sid)
                    if cl.get("code") == 200:
                        cd = cl.get("data", {})
                        results.append(f"打赏领取({sid}): {cd.get('hintText','')} result={cd.get('result',False)}")
                    else:
                        results.append(f"打赏领取({sid}): code={cl.get('code')}")
                time.sleep(random.uniform(2, 4))
        else:
            results.append("未获取到最近播放歌曲")

        results.append("=" * 50)
        results.append("任务完成")
        return "\n".join(results)


def send_notify(msg: str):
    """发送通知 (青龙面板)"""
    try:
        from send_notify import send
        send("网易云云朵任务", msg)
    except ImportError:
        pass


def main():
    import urllib3
    urllib3.disable_warnings()

    music_u_str = os.environ.get("NETEASE_MUSIC_U", "")
    if not music_u_str:
        print("=" * 50)
        print("错误: 未设置 NETEASE_MUSIC_U 环境变量")
        print("请在青龙面板 -> 环境变量 添加:")
        print("  名称: NETEASE_MUSIC_U")
        print("  值: 网易云 MUSIC_U cookie (多账号用 & 分隔)")
        print("=" * 50)
        return

    accounts = [a.strip() for a in music_u_str.split("&") if a.strip()]
    all_results = []

    for i, mu in enumerate(accounts, 1):
        print(f"\n{'='*50}\n账号 {i}/{len(accounts)}\n{'='*50}")
        try:
            client = NeteaseCloudMusic(mu)
            result = client.run()
            all_results.append(result)
            print(result)
        except Exception as e:
            err = f"账号{i}失败: {e}"
            all_results.append(err)
            print(err)
        if i < len(accounts):
            time.sleep(random.uniform(5, 10))

    send_notify("\n\n".join(all_results))


if __name__ == "__main__":
    main()
