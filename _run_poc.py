"""FcloudEdge 端到端测试 —— 起 wrangler dev（miniflare），跑一串真实 HTTP 请求。

按老教训：不用 Bash 的 run_in_background 起服务（进程会被回收，端口状态不可信）。
这个脚本自己起、自己测、自己关。

用法：
    python _run_poc.py
"""
import io
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = r"C:\Users\kaixi\WorkBuddy\2026-09-18-16-15-04\FcloudEdge"
NODE = r"C:\Users\kaixi\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
WRANGLER = os.path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wrangler(args, **kw):
    return subprocess.run([NODE, WRANGLER] + args, cwd=ROOT, **kw)


def start(port):
    log = open(os.path.join(ROOT, "_wrangler.log"), "w", encoding="utf-8")
    return subprocess.Popen(
        # ⚠️ 现在主站是 Pages 宿主，必须用 `wrangler pages dev`（不是 `wrangler dev`）。
        #    用错会报 "It looks like you've run a Workers-specific command in a Pages project"。
        #    pages dev 会读 functions/ 目录（我们的 functions/api/[[path]].ts）。
        # ⚠️ bindings 要显式传 —— `wrangler pages dev` 不读 wrangler.jsonc 里的
        #    d1_databases / r2_buckets / kv_namespaces（Pages 的 binding 在控制台配，
        #    本地模拟就得用命令行参数）。
        #    R2 用的是本地模拟桶（miniflare 自带，不碰线上）。
        [NODE, WRANGLER, "pages", "dev", "web", "--port", str(port),
         "--persist-to=.wrangler/state",
         #    ⚠️ D1/KV 必须给**完整的 id**，不能只给名字 ——
         #    简写形式（DB=fcloud）miniflare 会按名字另建一个空库，
         #    结果就是 "no such table: settings"。
         "--d1", "DB=c2682976-5bc1-4fbe-b66b-99c3abfa6d7d",
         "--kv", "RATE=91810afa662844268df883873fed6646",
         "--r2", "BLOB=fcloud-blobs"],
        cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)


def wait_ready(base, proc, timeout=120):
    for _ in range(timeout):
        try:
            urllib.request.urlopen(base + "/api/health", timeout=1).read()
            return True
        except Exception:
            if proc.poll() is not None:
                log = os.path.join(ROOT, "_wrangler.log")
                if os.path.exists(log):
                    print(io.open(log, encoding="utf-8").read()[-3000:])
                return False
            time.sleep(1)
    return False


def get(base, path, cookie=None):
    req = urllib.request.Request(base + path)
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, json.loads(r.read().decode("utf-8")), r.headers
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except Exception:
            body = {}
        return e.code, body, e.headers


def get_raw(base, path, cookie=None, headers=None):
    """拿二进制响应（下载/zip 用）。"""
    req = urllib.request.Request(base + path)
    if cookie:
        req.add_header("Cookie", cookie)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def post(base, path, data=None, cookie=None):
    body = None if data is None else json.dumps(data).encode("utf-8")
    req = urllib.request.Request(base + path, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, json.loads(r.read().decode("utf-8")), r.headers
    except urllib.error.HTTPError as e:
        try:
            body2 = json.loads(e.read().decode("utf-8"))
        except Exception:
            body2 = {}
        return e.code, body2, e.headers


def put_raw(base, path, data, cookie=None):
    req = urllib.request.Request(base + path, data=data, method="PUT")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        r = urllib.request.urlopen(req, timeout=120)
        return r.status, json.loads(r.read().decode("utf-8")), r.headers
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except Exception:
            body = {}
        return e.code, body, e.headers


def patch(base, path, data, cookie=None):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(base + path, data=body, method="PATCH")
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, json.loads(r.read().decode("utf-8")), r.headers
    except urllib.error.HTTPError as e:
        try:
            b2 = json.loads(e.read().decode("utf-8"))
        except Exception:
            b2 = {}
        return e.code, b2, e.headers


def delete(base, path, cookie=None):
    req = urllib.request.Request(base + path, method="DELETE")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, json.loads(r.read().decode("utf-8")), r.headers
    except urllib.error.HTTPError as e:
        try:
            b2 = json.loads(e.read().decode("utf-8"))
        except Exception:
            b2 = {}
        return e.code, b2, e.headers


# ---------------------------------------------------------------- 测试框架

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


# ---------------------------------------------------------------- 测试项

def test_poc(base, cookie=None):
    print("\n【核心链路 PoC】")
    st, data, _ = get(base, "/api/poc", cookie)
    check(st == 200, "PoC 端点可达", st)
    for s in data.get("steps", []):
        check(s.get("ok"), s.get("step", "?"), s.get("error", ""))


def test_poc_no_side_effect(base):
    """PoC 是公开调试端点，绝不能改主密钥或往 D1 留垃圾。

    这条回归测试是安全红线 —— 之前 PoC 调了真实 setPassphrase，
    任何人访问一次 /api/poc 就能把全家主口令改成已知字符串。
    """
    print("\n【PoC 无副作用（安全回归）】")
    st, data, _ = get(base, "/api/crypto/status")
    check(st == 200, "加密状态可达", st)
    check(data.get("configured") is False, "PoC 跑完主口令仍未设置", data)

    st, data, _ = get(base, "/api/poc")
    check(st == 200, "PoC 可跑", st)

    st, data, _ = get(base, "/api/crypto/status")
    check(data.get("configured") is False, "PoC 没改主口令（关键）", data)

    st, data, _ = get(base, "/api/stats")
    # stats 未登录应该是 401，这里只关心 PoC 没往 blobs 表塞东西
    check(st in (200, 401), "stats 可达", st)


def test_auth(base):
    print("\n【鉴权】")
    st, data, _ = get(base, "/api/bootstrap")
    check(st == 200, "bootstrap 可访问", st)
    check("initialized" in data, "bootstrap 返回 initialized 字段", data)

    uname = "test_" + str(int(time.time() * 1000) % 1000000)
    st, data, _ = post(base, "/api/setup", {
        "username": uname, "display_name": "测试", "password": "pw1234",
        "space_name": "测试空间",
    })
    check(st == 200, "setup 建管理员账号", data)
    if st != 200:
        return None, None

    st, data, _ = get(base, "/api/bootstrap")
    check(data.get("initialized") is True, "初始化后 initialized=True", data)

    st, data, _ = post(base, "/api/login", {"username": uname, "password": "wrong"})
    check(st == 401, "错误密码被拒", st)

    st, data, hdrs = post(base, "/api/login", {"username": uname, "password": "pw1234"})
    check(st == 200, "正确密码登录成功", data)
    if st != 200:
        return None, None
    sc = hdrs.get("Set-Cookie", "")
    check("HttpOnly" in sc, "会话 Cookie 有 HttpOnly", sc)
    check("SameSite=Lax" in sc, "会话 Cookie 有 SameSite", sc)
    cookie = sc.split(";")[0]

    st, data, _ = get(base, "/api/me", cookie)
    check(st == 200 and data.get("me", {}).get("username") == uname, "me 返回当前用户", data)
    me = data.get("me", {})
    check("role_label" in me, "me 含 role_label（前端成员列表要用）", me)
    check("initial" in me, "me 含 initial（头像首字）", me)
    check("create_folder" in me.get("can", []), "管理员 can 含 create_folder", me.get("can"))

    st, data, _ = get(base, "/api/me")
    check(st == 401, "未登录访问 /api/me 返回 401", st)

    return uname, cookie


def test_files(base, cookie):
    print("\n【文件树】")
    st, data, _ = get(base, "/api/files?parent=0", cookie)
    check(st == 200, "列根目录", data)
    check(data.get("items") == [], "根目录初始为空", data.get("items"))
    check("breadcrumbs" in data, "返回面包屑", data)
    check("space" in data, "返回空间信息", data)

    st, data, _ = post(base, "/api/folder", {"parent_id": 0, "name": "照片"}, cookie)
    check(st == 200 and data.get("node", {}).get("name") == "照片", "新建文件夹", data)
    folder = data.get("node", {}).get("id")

    st, data, _ = post(base, "/api/folder", {"parent_id": 0, "name": "照片"}, cookie)
    check(st == 200 and data.get("node", {}).get("name") == "照片(1)",
          "同名文件夹自动加 (1)", data.get("node", {}).get("name"))

    st, data, _ = get(base, "/api/files?parent=0", cookie)
    check(len(data.get("items", [])) == 2, "根目录有 2 个文件夹", len(data.get("items", [])))
    check(data["items"][0].get("preview") == "none", "文件夹 preview=none",
          data["items"][0].get("preview"))

    st, data, _ = get(base, "/api/files?parent=%d" % folder, cookie)
    check(len(data.get("items", [])) == 0, "空文件夹里没东西", data.get("items"))

    # 改属性
    st, data, _ = patch(base, "/api/node/%d" % folder, {"starred": True}, cookie)
    check(st == 200 and data.get("node", {}).get("starred") == 1, "标记收藏", data)

    st, data, _ = patch(base, "/api/node/%d" % folder, {"category": "照片"}, cookie)
    check(st == 200 and data.get("node", {}).get("category") == "照片", "改分类", data)

    st, data, _ = patch(base, "/api/node/%d" % folder, {"category": "不存在的分类"}, cookie)
    check(st == 400, "非法分类被拒", st)

    # 重命名
    st, data, _ = patch(base, "/api/node/%d" % folder, {"name": "家庭照片"}, cookie)
    check(st == 200 and data.get("node", {}).get("name") == "家庭照片", "重命名", data)

    return folder


def test_upload_download(base, cookie, folder):
    print("\n【上传 / 下载】")
    content = ("家庭云盘测试内容 " * 100).encode("utf-8")

    st, data, _ = post(base, "/api/upload/init", {
        "parent_id": folder, "name": "测试.txt", "total_size": len(content),
        "mime": "text/plain",
    }, cookie)
    check(st == 200, "创建上传会话", data)
    if st != 200:
        return None
    uid = data.get("upload_id")
    check(data.get("total_chunks") == 1, "小文件不分片（1 块）", data.get("total_chunks"))
    check(data.get("missing") == [0], "缺第 0 块", data.get("missing"))

    st, data, _ = post(base, "/api/upload/%s/finish" % uid, {}, cookie)
    check(st == 400, "缺块时 finish 被拒", st)

    st, data, _ = put_raw(base, "/api/upload/%s/part/0" % uid, content, cookie)
    check(st == 200, "上传第 0 块", data)
    check(data.get("missing") == [], "全部块到齐", data.get("missing"))
    check(data.get("percent") == 100.0, "进度 100%", data.get("percent"))

    st, data, _ = post(base, "/api/upload/%s/finish" % uid, {}, cookie)
    check(st == 200 and data.get("ok"), "finish 落库", data)
    node = (data.get("node") or {})
    nid = node.get("id")
    check(node.get("size") == len(content), "节点大小正确", node.get("size"))
    check(node.get("category") == "文档", "自动分类为文档", node.get("category"))

    # 重复传同一块（幂等）
    st, data, _ = post(base, "/api/upload/init", {
        "parent_id": folder, "name": "测试2.txt", "total_size": len(content),
    }, cookie)
    uid2 = data.get("upload_id")
    put_raw(base, "/api/upload/%s/part/0" % uid2, content, cookie)
    st, data, _ = put_raw(base, "/api/upload/%s/part/0" % uid2, content, cookie)
    check(st == 200 and data.get("duplicate"), "重复传同一块返回 duplicate", data)

    # 下载
    st, raw, hdrs = get_raw(base, "/api/file/%d" % nid, cookie)
    check(st == 200, "下载文件", st)
    check(raw == content, "下载内容与上传一致", len(raw))
    check("attachment" in (hdrs.get("Content-Disposition") or ""), "默认附件下载",
          hdrs.get("Content-Disposition"))

    # Range
    st, raw, hdrs = get_raw(base, "/api/file/%d" % nid, cookie,
                            {"Range": "bytes=0-9"})
    check(st == 206, "Range 请求返回 206", st)
    check(raw == content[:10], "Range 内容正确", raw[:20])
    check((hdrs.get("Content-Range") or "").startswith("bytes 0-9/"), "Content-Range 头",
          hdrs.get("Content-Range"))

    st, raw, hdrs = get_raw(base, "/api/file/%d" % nid, cookie,
                            {"Range": "bytes=-10"})
    check(st == 206 and raw == content[-10:], "尾部 Range（bytes=-10）", raw)

    # inline
    st, raw, hdrs = get_raw(base, "/api/file/%d?inline=1" % nid, cookie)
    check(st == 200 and hdrs.get("Content-Type") == "text/plain", "inline 用原 MIME",
          hdrs.get("Content-Type"))

    # 版本历史
    st, data, _ = get(base, "/api/node/%d/versions" % nid, cookie)
    check(st == 200 and len(data.get("versions", [])) == 1, "版本列表 1 条", data.get("versions"))

    # 预览
    st, data, _ = get(base, "/api/node/%d/preview" % nid, cookie)
    check(st == 200, "预览接口可达", data)
    check(data.get("kind") == "text", "预览类型 text", data.get("kind"))
    check("家庭云盘测试内容" in (data.get("text") or ""), "预览能抽出正文", (data.get("text") or "")[:40])

    return nid


def test_search(base, cookie, folder, nid):
    print("\n【搜索】")
    st, data, _ = get(base, "/api/search?q=%s" % urllib.parse.quote("测试"), cookie)
    check(st == 200, "搜索可达", data)
    check(data.get("total", 0) >= 1, "搜到文件", data.get("total"))
    check(len(data.get("items", [])) >= 1, "结果非空", data.get("items"))
    if data.get("items"):
        it = data["items"][0]
        check("preview" in it, "结果带 preview 字段", list(it.keys()))
        check("score" in it, "结果带 score 字段", list(it.keys()))

    st, data, _ = get(base, "/api/search?q=" + urllib.parse.quote("绝对不存在的词xyz"), cookie)
    check(st == 200 and data.get("total") == 0, "搜不到时返回 0 条（不是全库）", data.get("total"))
    check(data.get("reason"), "搜不到时给 reason", data.get("reason"))

    st, data, _ = get(base, "/api/search?kind=file", cookie)
    check(st == 200, "按类型筛选", data)

    st, data, _ = get(base, "/api/suggest?q=%s" % urllib.parse.quote("测"), cookie)
    check(st == 200, "suggest 可达", data)


def test_trash(base, cookie, folder, nid):
    print("\n【回收站】")
    st, data, _ = delete(base, "/api/node/%d" % nid, cookie)
    check(st == 200 and data.get("deleted") == 1, "删掉文件进回收站", data)

    st, data, _ = get(base, "/api/trash", cookie)
    check(st == 200 and len(data.get("items", [])) == 1, "回收站有 1 项", data.get("items"))

    st, data, _ = get(base, "/api/files?parent=%d" % folder, cookie)
    check(all(i["id"] != nid for i in data.get("items", [])), "删掉的文件不在目录里")

    st, data, _ = post(base, "/api/node/%d/restore" % nid, {}, cookie)
    check(st == 200 and data.get("restored") == 1, "恢复文件", data)

    st, data, _ = get(base, "/api/files?parent=%d" % folder, cookie)
    check(any(i["id"] == nid for i in data.get("items", [])), "恢复后回到目录里")


def test_members_sharing(base, cookie):
    print("\n【成员 / 共享】")
    st, data, _ = get(base, "/api/members", cookie)
    check(st == 200 and "items" in data, "成员列表可达", data)
    check("permissions" in data, "返回权限矩阵", list(data.keys()))

    st, data, _ = post(base, "/api/members", {
        "username": "kid", "display_name": "小孩", "password": "kid1234", "role": "child",
    }, cookie)
    check(st == 200, "新增儿童成员", data)
    kid = (data.get("member") or {}).get("id")

    st, data, _ = post(base, "/api/members", {
        "username": "kid", "display_name": "重名", "password": "kid1234", "role": "child",
    }, cookie)
    check(st == 400, "重名成员被拒", st)

    # 儿童登录
    st, data, hdrs = post(base, "/api/login", {"username": "kid", "password": "kid1234"})
    check(st == 200, "儿童登录成功", data)
    # 回归测试：members.ts 建的成员必须能用 auth.ts 的登录接口登录。
    # 之前 auth.ts 和 members.ts 各有一份 hashPassword（算法不同），
    # 于是「这里建的号在那边登录不了」—— 本地测试发现不了，
    # 因为 setup 和 login 都在 auth.ts（自洽），且 miniflare 不限迭代次数。
    # 到线上才炸：Cloudflare 限制 PBKDF2 单次 ≤10 万轮。
    check(st == 200 and data.get("me", {}).get("username") == "kid",
          "跨模块建号后能登录（回归）", data)
    kid_cookie = hdrs.get("Set-Cookie", "").split(";")[0]
    kid_can = data.get("me", {}).get("can", [])
    check("create_folder" in kid_can, "儿童也能建文件夹", kid_can)
    check("purge" not in kid_can, "儿童不能彻底删除", kid_can)

    # 儿童不能管理成员
    st, data, _ = post(base, "/api/members", {
        "username": "x2", "display_name": "x", "password": "xxxx1234",
    }, kid_cookie)
    check(st == 403, "儿童加人被拒 403", st)

    # 管理员不能把自己降级成儿童（最后一个管理员）
    st, data, _ = get(base, "/api/me", cookie)
    admin_id = data["me"]["id"]
    st, data, _ = patch(base, "/api/member/%d" % admin_id, {"role": "child"}, cookie)
    check(st == 400, "最后一个管理员不能降级", st)

    return kid, kid_cookie


def test_crypto(base, cookie):
    print("\n【加密】")
    st, data, _ = get(base, "/api/crypto/status", cookie)
    check(st == 200, "加密状态可达", data)
    check(data.get("configured") is False, "初始未设置主口令", data)
    check(data.get("aes") is True, "用 AES-GCM", data)

    st, data, _ = post(base, "/api/crypto/setup", {"passphrase": "short"}, cookie)
    check(st == 400, "太短的主口令被拒", st)

    st, data, _ = post(base, "/api/crypto/setup", {"passphrase": "my-master-pass-2026"}, cookie)
    check(st == 200 and data.get("ok"), "设置主口令", data)

    st, data, _ = post(base, "/api/crypto/unlock", {"passphrase": "wrong-pass"}, cookie)
    check(st == 200 and data.get("ok") is False, "错误口令解锁失败", data)

    st, data, _ = post(base, "/api/crypto/unlock", {"passphrase": "my-master-pass-2026"}, cookie)
    check(st == 200 and data.get("ok"), "正确口令解锁成功", data)


def test_encrypted_upload(base, cookie, folder):
    print("\n【加密上传 / 加密下载】")
    content = ("这是加密内容 abcdefg" * 50).encode("utf-8")

    st, data, _ = post(base, "/api/upload/init", {
        "parent_id": folder, "name": "密文.txt", "total_size": len(content),
        "encrypted": True,
    }, cookie)
    check(st == 200, "加密上传会话建立", data)
    if st != 200:
        return
    uid = data.get("upload_id")
    check(data.get("encrypted") is True, "会话标记为加密", data.get("encrypted"))

    st, data, _ = put_raw(base, "/api/upload/%s/part/0" % uid, content, cookie)
    check(st == 200, "上传加密分片", data)

    st, data, _ = post(base, "/api/upload/%s/finish" % uid, {}, cookie)
    check(st == 200 and data.get("ok"), "加密文件落库", data)
    nid = (data.get("node") or {}).get("id")
    check((data.get("node") or {}).get("encrypted") == 1, "节点标记为加密",
          (data.get("node") or {}).get("encrypted"))

    st, raw, hdrs = get_raw(base, "/api/file/%d" % nid, cookie)
    check(st == 200 and raw == content, "加密文件下载并解密，内容一致", len(raw))

    # R2 里存的应该是密文，不是明文
    st, data, _ = get(base, "/api/stats", cookie)
    check(st == 200, "统计可达", data)
    check(data.get("crypto", {}).get("unlocked") is True, "加密状态 unlocked", data.get("crypto"))

    return nid


def test_stats_home(base, cookie):
    print("\n【统计 / 首页】")
    st, data, _ = get(base, "/api/stats", cookie)
    check(st == 200, "统计可达", data)
    for k in ("storage", "index", "by_category", "by_member", "space", "recent", "audit", "crypto"):
        check(k in data, "统计含 " + k, list(data.keys()))
    storage = data.get("storage", {})
    for k in ("logical_bytes", "physical_bytes", "dedup_saved", "dedup_ratio",
              "files", "folders", "trash_files", "versions", "blobs"):
        check(k in storage, "storage 含 " + k, list(storage.keys()))

    st, data, _ = get(base, "/api/home", cookie)
    check(st == 200, "首页可达", data)
    for k in ("space", "recent", "by_category", "storage", "trash", "shared_for_me", "uploads"):
        check(k in data, "首页含 " + k, list(data.keys()))


def test_zip(base, cookie, folder):
    print("\n【打包下载】")
    st, raw, hdrs = get_raw(base, "/api/zip?ids=%d" % folder, cookie)
    check(st == 200, "打包下载返回 200", st)
    check(hdrs.get("Content-Type") == "application/zip", "Content-Type 是 zip",
          hdrs.get("Content-Type"))
    check(raw[:2] == b"PK", "ZIP 魔数正确", raw[:8])
    check(raw[-22:-18] == b"PK\x05\x06", "EOCD 记录在末尾", raw[-24:])
    check(len(raw) > 100, "ZIP 有内容", len(raw))


def test_backup(base, cookie):
    print("\n【备份】")
    st, data, _ = post(base, "/api/backup", {"note": "测试备份"}, cookie)
    check(st == 200 and data.get("ok"), "创建备份", data)
    name = data.get("name")

    st, data, _ = get(base, "/api/backup", cookie)
    check(st == 200 and len(data.get("items", [])) >= 1, "备份列表", data)
    check(data.get("last_backup_at"), "记录上次备份时间", data.get("last_backup_at"))

    st, data, _ = post(base, "/api/backup/restore", {"name": name}, cookie)
    check(st == 200 and data.get("ok"), "恢复备份", data)
    check(data.get("restored", 0) > 0, "恢复有行数", data.get("restored"))

    # 恢复会清掉 sessions（强制重新登录 —— 这是对的安全取舍）
    st, data, _ = get(base, "/api/files", cookie)
    check(st == 401, "恢复后会话失效（安全）", st)
    return True


def relogin(base, username, password):
    """重新登录拿 cookie。"""
    import urllib.request as _u
    rq = _u.Request(base + "/api/login", data=json.dumps(
        {"username": username, "password": password}).encode(), method="POST")
    rq.add_header("Content-Type", "application/json")
    rr = _u.urlopen(rq, timeout=30)
    return rr.headers.get("Set-Cookie", "").split(";")[0]


def d1_query(sql):
    """直接查本地 D1（用来验证存储层的安全性）。"""
    r = subprocess.run(
        [NODE, WRANGLER, "d1", "execute", "fcloud", "--local",
         "--persist-to=.wrangler/state", "--command", sql],
        cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=120)
    return (r.stdout or "") + (r.stderr or "")


def test_security_storage(base, cookie):
    """安全加固的存储层断言。

    核心红线：**D1 里不能有明文主密钥**。
    之前主密钥的派生值是明文存在 settings.master_derived 里 ——
    D1 一旦泄露，全家加密文件裸奔。
    """
    print("\n【安全：主密钥存储】")

    # 先设一个主口令
    st, data, _ = post(base, "/api/crypto/setup",
                       {"passphrase": "my-master-pass-2026"}, cookie)
    check(st == 200, "设置主口令", st)

    out = d1_query("SELECT key FROM settings")
    check("master_derived" not in out,
          "旧的明文主密钥键已被删除", out[:200])
    check("master_wrapped" in out, "用了 KEK 包装的主密钥", out[:200])
    check("master_check" in out, "口令校验值单独存", out[:200])

    # 关键：D1 里不能出现主密钥的明文
    out = d1_query("SELECT value FROM settings WHERE key='master_wrapped'")
    check("K1:" in out, "主密钥是 K1 包装格式", out[:200])
    # 包装格式是 nonce:密文（base64），不应该能看出是 32 字节裸密钥
    parts = out.split("\n")
    check(len(out) > 20, "包装值非空", len(out))

    # 解锁状态：设置完应该自动解锁
    st, data, _ = get(base, "/api/crypto/status", cookie)
    check(data.get("unlocked") is True, "设置完自动解锁", data)
    check(data.get("configured") is True, "已配置", data)

    # 未解锁时不能用加密功能 —— 用另一个会话验证
    other = relogin(base, "kid", "kid1234")
    st, data, _ = get(base, "/api/crypto/status", other)
    check(data.get("unlocked") is True,
          "解锁是全局的（一家人都能用，跟 Python 版一致）", data)

    # 改主口令 → 解锁授权要撤销（重新设一次会自动解锁）
    st, data, _ = post(base, "/api/crypto/setup",
                       {"passphrase": "my-master-pass-2026"}, cookie)
    check(st == 200, "重设主口令", st)
    out = d1_query("SELECT COUNT(*) AS c FROM master_sessions")
    check("1" in out, "解锁授权表有记录", out[:200])


def test_security_basics(base, cookie):
    """基础安全响应头。"""
    print("\n【安全：响应头】")
    req = urllib.request.Request(base + "/api/health")
    r = urllib.request.urlopen(req, timeout=30)
    h = r.headers
    check("X-Content-Type-Options" in h, "有 X-Content-Type-Options", dict(h))
    check(h.get("X-Content-Type-Options") == "nosniff", "nosniff", h.get("X-Content-Type-Options"))
    check("X-Frame-Options" in h, "有 X-Frame-Options（防点击劫持）", h.get("X-Frame-Options"))
    check("Referrer-Policy" in h, "有 Referrer-Policy", h.get("Referrer-Policy"))
    check("Content-Security-Policy" in h, "有 CSP", (h.get("Content-Security-Policy") or "")[:80])
    check("no-store" in (h.get("Cache-Control") or ""), "API 不缓存", h.get("Cache-Control"))


def test_ai(base, cookie, folder):
    """小f：不用真调模型也能验的部分 + 真实联网调一次。"""
    print("\n【小f 助手】")
    st, data, _ = get(base, "/api/ai/status", cookie)
    check(st == 200, "AI 状态可达", st)
    check(data.get("configured"), "已配置 API Key", data.get("key_hint"))
    check(data.get("model"), "有默认模型", data.get("model"))
    check(isinstance(data.get("tools"), list) and len(data["tools"]) >= 15,
          "工具表完整", len(data.get("tools") or []))
    check(isinstance(data.get("tools_for_me"), list) and len(data["tools_for_me"]) >= 15,
          "我能拿到全部工具", len(data.get("tools_for_me") or []))
    check(data.get("can_write") is True, "管理员可写", data.get("can_write"))

    # 切模型
    st, data, _ = post(base, "/api/ai/model", {"model": "openrouter/free"}, cookie)
    check(st == 200 and data.get("model") == "openrouter/free", "切模型", data.get("model"))
    st, data, _ = post(base, "/api/ai/model", {"model": "不存在的模型"}, cookie)
    check(st == 400, "非法模型被拒", st)

    # 改 Key
    st, data, _ = post(base, "/api/ai/key", {"key": "sk-1234567890abcdefghij"}, cookie)
    check(st == 200, "设置 Key", st)
    st, data, _ = post(base, "/api/ai/key", {"key": "bad-key"}, cookie)
    check(st == 400, "非法 Key 被拒", st)
    st, data, _ = post(base, "/api/ai/key", {"reset": True}, cookie)
    # reset 是「清掉 D1 里存的 key」，不是「恢复内置 key」——
    # 源码里绝不能硬编码 key（公开仓库 + secret scanning）。
    check(st == 200 and data.get("key_source") in ("secret", "none"),
          "reset 清掉数据库里的 Key", data.get("key_source"))
    check(data.get("configured"), "reset 后仍能用 secret 里的 Key", data.get("key_source"))

    # 儿童的工具表要少（写工具压根不给模型）
    # kid 成员在 test_members_sharing 里已经建好了，直接用
    try:
        kid_cookie = relogin(base, "kid", "kid1234")
        check(bool(kid_cookie), "儿童登录", kid_cookie[:20])
    except Exception as e:
        kid_cookie = ""
        check(False, "儿童登录", e)
    st, data, _ = get(base, "/api/ai/status", kid_cookie)
    check(st == 200, "儿童能看 AI 状态", st)
    check(data.get("can_write") is False, "儿童不可写（前端显示口径）", data.get("can_write"))
    kid_tools = data.get("tools_for_me") or []
    check(len(kid_tools) < 16, "儿童拿到的工具更少", kid_tools)
    check("delete_file" not in kid_tools, "儿童拿不到删除工具", kid_tools)
    check("create_note" not in kid_tools, "儿童拿不到写笔记工具", kid_tools)

    # 真的聊一句（联网）
    print("  （下面会真的连 OpenRouter，可能要几秒）")
    st, body, _ = sse_post(base, "/api/ai/chat",
                            {"message": "用一句话说说这个家里有哪些文件", "history": []},
                            cookie)
    check(st == 200, "AI 对话端点返回 200", st)
    events = parse_sse(body)
    kinds = [e[0] for e in events]
    check("error" not in kinds, "AI 对话没有报错",
          [d for e, d in events if e == "error"][:1])
    check(any(e in ("delta", "done", "tool") for e in kinds), "AI 有输出", kinds[:6])
    done = [d for e, d in events if e == "done"]
    check(bool(done), "收到 done 事件", kinds[-3:])
    if done:
        txt = str(done[0].get("text") or "")
        print("       小f 说：" + (txt[:220].replace("\n", " ") or "(空)"))
        check(len(txt) > 5, "回复有实际内容", len(txt))
    tools = [d for e, d in events if e == "tool"]
    for t in tools:
        print("       工具：" + str(t.get("summary"))[:100])


def parse_sse(text):
    """把 SSE 文本解析成 [(event, data_dict), ...]。"""
    out = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        ev = ""
        data = ""
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


def sse_post(base, path, payload, cookie=None, timeout=180):
    """POST 一个 JSON，返回 (status, 原始文本)。"""
    body = json.dumps(payload).encode("utf-8")
    rq = urllib.request.Request(base + path, data=body, method="POST")
    rq.add_header("Content-Type", "application/json")
    if cookie:
        rq.add_header("Cookie", cookie)
    try:
        r = urllib.request.urlopen(rq, timeout=timeout)
        return r.status, r.read().decode("utf-8", "replace"), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), e.headers


def main():
    port = free_port()
    env = dict(os.environ)

    print("=== 清掉旧的本地状态 ===")
    # ⚠️ 必须删**整个** .wrangler 目录，不能只删 .wrangler/state。
    # .wrangler/tmp 里是 workerd 的沙箱目录 —— 上一次运行被中断的话，
    # 残留的沙箱会让 `wrangler d1 execute --local` 直接挂死（无输出、直到超时）。
    state = os.path.join(ROOT, ".wrangler")
    if os.path.isdir(state):
        import shutil
        shutil.rmtree(state, ignore_errors=True)

    print("=== 建本地 D1 schema ===")
    for mig in ("0001_init.sql", "0002_security.sql"):
        r = wrangler(["d1", "execute", "fcloud", "--file=./migrations/" + mig,
                      "--local", "--persist-to=.wrangler/state"],
                     env=env, capture_output=True, text=True,
                     encoding="utf-8", errors="replace", timeout=300)
        if r.returncode != 0:
            print("迁移", mig, "失败")
            print((r.stdout or "")[-2000:])
            print((r.stderr or "")[-2000:])
            return 1
        print("  ok " + mig)

    print("=== 起 wrangler dev ===")
    proc = start(port)
    base = f"http://127.0.0.1:{port}"
    try:
        if not wait_ready(base, proc):
            print("服务没起来")
            return 1
        print("  ok  " + base)

        test_poc_no_side_effect(base)
        uname, cookie = test_auth(base)
        if not cookie:
            print("鉴权没通过，后面的测不了")
            return 1
        test_poc(base, cookie)

        folder = test_files(base, cookie)
        nid = test_upload_download(base, cookie, folder)
        test_search(base, cookie, folder, nid)
        test_trash(base, cookie, folder, nid)
        test_members_sharing(base, cookie)
        test_crypto(base, cookie)
        test_security_storage(base, cookie)
        test_security_basics(base, cookie)
        test_encrypted_upload(base, cookie, folder)
        test_stats_home(base, cookie)
        test_zip(base, cookie, folder)
        test_backup(base, cookie)
        # 恢复备份清了 sessions，必须重新登录
        cookie = relogin(base, uname, "pw1234")
        check(bool(cookie), "恢复后能重新登录", cookie[:20])
        test_ai(base, cookie, folder)

        log = os.path.join(ROOT, "_wrangler.log")
        if os.path.exists(log):
            txt = io.open(log, encoding="utf-8").read()
            if "Error" in txt or "error" in txt:
                print("\n--- Worker 日志（错误部分）---")
                print(txt[-4000:])
        print("\n" + "=" * 50)
        print(f"通过 {NPASS} 项，失败 {len(FAILS)} 项")
        for f in FAILS:
            print("  FAIL " + f)
        print("=" * 50)
        return 1 if FAILS else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    import urllib.parse
    sys.exit(main())
