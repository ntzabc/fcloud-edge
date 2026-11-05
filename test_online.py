"""线上验证脚本 —— 测「只能在真实 Cloudflare 环境测」的那些东西。

## 为什么必须线上测

最关键的假设是：**PBKDF2 21 万轮能不能在 Workers/Pages 的 10ms CPU 限制下跑完**。

本地 miniflare 不限制 CPU，所以本地测「108ms 墙钟」根本没意义 ——
WebCrypto 的原生调用到底计不计入 CPU 配额，只有线上才知道。

另外这些也只有线上能验：
- Pages Functions 的路由约定对不对
- D1/KV binding 在 Pages 里能不能用
- CSRF 同源检查在 pages.dev 下正不正常
- 小f 的 SSE 流式在 Pages Functions 里能不能流
"""

import json
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://fcloud.pages.dev"

# Cloudflare 的浏览器完整性检查会拦「像爬虫」的请求（错误 1010）。
# 实测：Python-urllib 的默认 UA 被拦，但 Safari / Chrome / curl 全都正常通过。
# 所以这里必须带一个像浏览器的 UA —— 不是为了绕过防护，而是测试脚本
# 本来就不该伪装成爬虫（而且顺便验证了真实浏览器能访问）。
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Safari/605.1.15")

FAILS = []
NPASS = 0


def check(cond, label, detail=""):
    global NPASS
    if cond:
        NPASS += 1
        print("  ok   " + label)
    else:
        FAILS.append(label)
        print("  FAIL " + label + ("  → " + str(detail)[:300] if detail else ""))


def req(path, method="GET", body=None, cookie=None, timeout=60, raw=False):
    if body is None:
        data = None
    elif isinstance(body, (bytes, bytearray)):
        data = bytes(body)          # 二进制（上传分片）
    else:
        data = json.dumps(body).encode()
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("User-Agent", UA)
    if data and not isinstance(body, (bytes, bytearray)):
        r.add_header("Content-Type", "application/json")
    if cookie:
        r.add_header("Cookie", cookie)
    try:
        resp = urllib.request.urlopen(r, timeout=timeout)
        txt = resp.read().decode("utf-8", "replace")
        if raw:
            return resp.status, txt, resp.headers
        try:
            return resp.status, json.loads(txt), resp.headers
        except Exception:
            return resp.status, {"_raw": txt[:500]}, resp.headers
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        if raw:
            return e.code, txt, e.headers
        try:
            return e.code, json.loads(txt), e.headers
        except Exception:
            return e.code, {"_raw": txt[:500]}, e.headers
    except Exception as e:
        return 0, {"_error": str(e)}, {}


def main():
    print("=" * 56)
    print("线上验证：" + BASE)
    print("=" * 56)

    # ---------- 基础 ----------
    print("\n【基础】")
    t0 = time.time()
    st, data, _ = req("/api/health")
    ms = int((time.time() - t0) * 1000)
    check(st == 200 and data.get("ok"), "健康检查", (st, data))
    print("       响应耗时 %dms" % ms)

    st, data, _ = req("/api/bootstrap")
    check(st == 200, "bootstrap 可达", st)
    check("initialized" in data, "返回 initialized 字段", list(data.keys()))

    st, _, hdrs = req("/api/health")
    check(hdrs.get("X-Content-Type-Options") == "nosniff", "安全响应头 nosniff",
          hdrs.get("X-Content-Type-Options"))
    check(hdrs.get("X-Frame-Options") == "DENY", "X-Frame-Options",
          hdrs.get("X-Frame-Options"))
    check("Content-Security-Policy" in hdrs, "有 CSP",
          (hdrs.get("Content-Security-Policy") or "")[:60])

    # ---------- 建号 ----------
    print("\n【建号 + 登录】")
    # setup 是**一次性**的（初始化后 /api/setup 就关了），
    # 所以线上重复跑测试时要走「已初始化 → 直接登录」这条路。
    st, boot, _ = req("/api/bootstrap")
    if boot.get("initialized"):
        check(True, "空间已初始化（跳过建号）")
    else:
        st, data, _ = req("/api/setup", "POST", {
            "username": "admin1", "display_name": "爸爸",
            "password": "pw-long-2026", "space_name": "我们一家",
        })
        check(st == 200 and data.get("ok"), "建管理员账号", (st, data))

    st, data, hdrs = req("/api/login", "POST",
                         {"username": "admin1", "password": "pw-long-2026"})
    check(st == 200, "登录成功", (st, data))
    cookie = hdrs.get("Set-Cookie", "").split(";")[0]
    check(bool(cookie), "拿到会话 cookie", cookie[:20])
    sc = hdrs.get("Set-Cookie", "")
    check("HttpOnly" in sc, "HttpOnly", sc[:80])
    check("SameSite=Lax" in sc, "SameSite=Lax", sc[:80])
    check("Secure" in sc, "Secure（HTTPS 下必须有）", sc[:80])

    # ---------- ⭐ PBKDF2 CPU 假设 ----------
    print("\n【⭐ PBKDF2 21 万轮（10ms CPU 限制下能不能过）】")
    st, data, _ = req("/api/crypto/status", cookie=cookie)
    check(st == 200, "加密状态可达", st)
    # 线上重复跑时主口令可能已经配过了 —— 这时应该「已配置 + 已解锁」
    if data.get("configured"):
        check(data.get("unlocked") is True, "已配置则已解锁", data)
    else:
        check(True, "初始未配置主口令")

    t0 = time.time()
    st, data, _ = req("/api/crypto/setup", "POST",
                       {"passphrase": "my-master-pass-2026"}, cookie)
    setup_ms = int((time.time() - t0) * 1000)
    check(st == 200 and data.get("ok"),
          "设置主口令（PBKDF2 21 万轮跑完了）", (st, data))
    print("       耗时 %dms" % setup_ms)
    if st != 200:
        print("       ⚠️ 如果报 CPU 超限，说明 21 万轮太多，要降轮数或换方案")

    check(data.get("configured") is True, "已配置", data)
    check(data.get("unlocked") is True, "设置后自动解锁", data)

    # 错误口令
    st, data, _ = req("/api/crypto/unlock", "POST",
                       {"passphrase": "wrong-pass"}, cookie)
    check(st == 200 and data.get("ok") is False, "错误口令被拒", (st, data))

    # 正确口令（又一次 PBKDF2）
    t0 = time.time()
    st, data, _ = req("/api/crypto/unlock", "POST",
                       {"passphrase": "my-master-pass-2026"}, cookie)
    unlock_ms = int((time.time() - t0) * 1000)
    check(st == 200 and data.get("ok"), "正确口令解锁成功", (st, data))
    print("       耗时 %dms" % unlock_ms)

    # ---------- 文件树 / D1 ----------
    print("\n【D1 数据读写】")
    st, data, _ = req("/api/folder", "POST", {"name": "测试文件夹"}, cookie)
    check(st == 200 and data.get("ok"), "新建文件夹", (st, data))
    st, data, _ = req("/api/files", cookie=cookie)
    check(st == 200, "列目录", st)
    items = data.get("items") or data.get("children") or []
    check(len(items) >= 1, "目录里有东西", len(items))

    # ---------- CSRF 同源检查 ----------
    print("\n【CSRF 同源检查】")
    r = urllib.request.Request(BASE + "/api/folder", data=b'{"name":"x"}', method="POST")
    r.add_header("Content-Type", "application/json")
    r.add_header("Cookie", cookie)
    r.add_header("Origin", "https://evil.example.com")
    r.add_header("User-Agent", UA)
    try:
        resp = urllib.request.urlopen(r, timeout=30)
        check(False, "跨站 POST 被拒", resp.status)
    except urllib.error.HTTPError as e:
        check(e.code == 403, "跨站 POST 被拒 403", e.code)
    except Exception as e:
        check(False, "跨站 POST 被拒", e)

    # ---------- R2 状态（预期失败，因为还没订阅 R2） ----------
    print("\n【文件存储（R2 还没启用，预期失败但要有清晰提示）】")
    st, data, _ = req("/api/upload/init", "POST",
                       {"name": "t.txt", "total_size": 5,
                        "chunk_size": 4194304}, cookie)
    # init 只建上传会话，不碰存储 —— 所以这里应该是 200
    check(st == 200 and data.get("upload_id"), "上传会话建立", (st, data))
    uid = data.get("upload_id")
    # 真正写存储是传分片那一步 —— R2 没启用时应该给出清晰提示
    st2, data2, _ = req("/api/upload/%s/part/0" % uid, "PUT", b"hello",
                        cookie)
    check(st2 == 503 and "R2" in str(data2.get("error", "")),
          "R2 未启用时给出清晰提示（不是 500 崩溃）", (st2, data2))

    # ---------- 小f ----------
    print("\n【小f 助手（真实联网）】")
    st, data, _ = req("/api/ai/status", cookie=cookie)
    check(st == 200, "AI 状态可达", st)
    check(data.get("configured"), "API Key 已配置", data.get("key_source"))
    check(data.get("key_source") in ("secret", "settings"),
          "Key 来自 secret 或设置页（源码里没有硬编码）", data.get("key_source"))
    check(isinstance(data.get("tools"), list) and len(data["tools"]) >= 15,
          "工具表完整", len(data.get("tools") or []))

    print("       （下面会真的连 OpenRouter，可能要几秒）")
    t0 = time.time()
    st, body, _ = req("/api/ai/chat", "POST",
                       {"message": "用一句话说说这个空间里有什么",
                        "history": []}, cookie, timeout=120, raw=True)
    ai_ms = int((time.time() - t0) * 1000)
    check(st == 200, "AI 对话端点返回 200", st)
    events = parse_sse(body)
    kinds = [e[0] for e in events]
    check("error" not in kinds, "AI 对话没有报错",
          [d for e, d in events if e == "error"][:1])
    done = [d for e, d in events if e == "done"]
    check(bool(done), "收到 done 事件", kinds[-4:])
    if done:
        txt = str(done[0].get("text") or "")
        print("       小f 说：" + (txt[:200].replace("\n", " ") or "(空)"))
        check(len(txt) > 5, "回复有实际内容", len(txt))
    print("       耗时 %dms" % ai_ms)

    # ---------- 定时任务接口 ----------
    print("\n【其它】")
    st, data, _ = req("/api/stats", cookie=cookie)
    check(st == 200, "统计可达", st)

    print()
    print("=" * 56)
    print("通过 %d 项，失败 %d 项" % (NPASS, len(FAILS)))
    for f in FAILS:
        print("  FAIL " + f)
    print("=" * 56)
    return 1 if FAILS else 0


def parse_sse(text):
    out = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        ev, data = "", ""
        for line in block.split("\n"):
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data += line[5:].strip()
        if not ev:
            continue
        try:
            out.append((ev, json.loads(data) if data else {}))
        except Exception:
            out.append((ev, {"_raw": data}))
    return out


if __name__ == "__main__":
    sys.exit(main())
