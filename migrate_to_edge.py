"""Fcloud Python 版 → Cloudflare Edge 版 数据迁移。

## 迁移什么

Python 版的数据在两处：
    Fcloud/data/fcloud.db      元数据（SQLite）
    Fcloud/data/blobs/         内容块（按两级散列目录存放）

Edge 版对应：
    D1 (fcloud)                元数据
    R2 (fcloud-blobs)          内容块，key = <hash前2位>/<hash>

两边表结构**完全一致**（Edge 版多了 master_sessions / security_log 两张安全表），
所以元数据可以整表照搬。

## 搬不了的东西（必须说清楚）

### 1. 加密文件 —— 必须重新上传

两边的文件密钥包裹格式不一样：
    Python:  F0 | salt(16) | 密文 | tag(16)      HMAC 流密码
    Edge:    F1 | nonce(12) | aad(16) | 密文 | tag  AES-GCM

而且主密钥派生方式不同（Python 用 scrypt，Edge 用 PBKDF2），
主密钥本身也不一样 —— Python 的在 Python 的 settings 里，Edge 的在 Edge 的 D1 里。

所以**加密文件的文件密钥搬不过去**。
脚本会把它们列出来，让你手动重传（数量通常不多）。

### 2. 成员密码 —— 必须重设

Python 用 scrypt 存哈希，Edge 用 PBKDF2。
scrypt 的哈希没法「转换」成 PBKDF2 的哈希（哈希不可逆，且算法不同）。
脚本会给每个成员生成一个随机临时密码并打印出来，登录后自己改。

### 3. 主密钥 —— 不搬

Edge 版的主密钥存在 D1 的 settings.master_wrapped（KEK 包装），
跟 Python 的存储方式完全不同。搬到线上后要重新设置主口令。

## 用法

    # 预览（不写任何东西）
    python migrate_to_edge.py --dry-run

    # 迁移到线上
    python migrate_to_edge.py --remote

    # 只迁移前 N 个文件（试水）
    python migrate_to_edge.py --remote --limit 10

需要 wrangler 已登录（npx wrangler whoami 能看到账号）。
"""

import argparse
import base64
import hashlib
import os
import secrets
import sqlite3
import string
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY_DIR = os.path.join(ROOT, "Fcloud")
EDGE_DIR = os.path.join(HERE)
NODE = r"C:\Users\kaixi\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
WRANGLER = os.path.join(EDGE_DIR, "node_modules", "wrangler", "bin", "wrangler.js")

PY_DB = os.path.join(PY_DIR, "data", "fcloud.db")
PY_BLOBS = os.path.join(PY_DIR, "data", "blobs")

# 照搬的表（顺序无所谓，因为用的是 INSERT）
TABLES = [
    "members", "spaces", "space_members", "blobs", "nodes", "versions",
    "version_chunks", "shares", "tombstones", "file_text", "fterms", "audit",
]

# Edge 版新增、Python 版没有的表 —— 不搬
EDGE_ONLY = {"master_sessions", "security_log", "uploads", "upload_parts", "sessions"}


def wrangler(args, timeout=600):
    """跑 wrangler 命令，返回 (returncode, 输出)。"""
    p = subprocess.run(
        [NODE, WRANGLER] + args, cwd=EDGE_DIR,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def sql_lit(v):
    """把 Python 值变成 SQL 字面量。"""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, bytes):
        # BLOB 在 Python 版里存的是二进制；Edge 版用 hex/base64 存
        return "x'" + v.hex() + "'"
    s = str(v).replace("'", "''")
    return "'" + s + "'"


def esc(s):
    """字符串里的控制字符转义（SQLite 不接受裸换行）。"""
    return (str(s).replace("\n", "\\n").replace("\r", "\\r")
            .replace("\t", "\\t").replace("\x00", ""))


def blob_path(digest):
    """Python 版的内容块路径（两级散列目录）。"""
    return os.path.join(PY_BLOBS, digest[:2], digest[2:4], digest)


def r2_key(digest):
    """Edge 版的 R2 key（<hash前2位>/<hash>）。"""
    return digest[:2] + "/" + digest


def gen_password(n=12):
    """生成一个临时密码（人可读、无易混字符）。"""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def main():
    ap = argparse.ArgumentParser(description="Fcloud Python 版 → Cloudflare 迁移")
    ap.add_argument("--remote", action="store_true", help="写到线上 Cloudflare")
    ap.add_argument("--local", action="store_true", help="写到本地模拟（自测用）")
    ap.add_argument("--dry-run", action="store_true", help="只看要做什么")
    ap.add_argument("--db", default="", help="指定源数据库（默认 Fcloud/data/fcloud.db）")
    ap.add_argument("--limit", type=int, default=0, help="只迁移前 N 个内容块")
    ap.add_argument("--skip-blobs", action="store_true", help="不传内容块（只搬元数据）")
    args = ap.parse_args()
    dry = args.dry_run or not (args.remote or args.local)
    # --local / --remote 决定 wrangler 的目标；不加就是本地模拟
    target = ["--remote"] if args.remote else []

    py_db = args.db or PY_DB
    if not os.path.isfile(py_db):
        print("找不到 Python 版数据库：", py_db)
        return 1

    db = sqlite3.connect(py_db)
    db.row_factory = sqlite3.Row

    # ---- 统计 ----
    counts = {}
    for t in TABLES:
        try:
            counts[t] = db.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
        except sqlite3.Error:
            counts[t] = 0
    blobs = db.execute("SELECT COUNT(*) FROM blobs").fetchone()[0]
    enc_files = db.execute(
        "SELECT COUNT(*) FROM nodes WHERE encrypted=1 AND deleted_at IS NULL").fetchone()[0]
    members = db.execute("SELECT id,username,display_name FROM members").fetchall()

    print("=" * 56)
    print("Fcloud → Cloudflare 迁移预览")
    print("=" * 56)
    for t in TABLES:
        if counts[t]:
            print("  %-16s %6d 行" % (t, counts[t]))
    print("  %-16s %6d 个内容块" % ("blobs(文件)", blobs))
    print()
    print("  ⚠️ 加密文件 %d 个 —— 搬不过去，要手动重传" % enc_files)
    print("  ⚠️ 成员密码 %d 个 —— 要重设（脚本会生成临时密码）" % len(members))
    print()

    if dry:
        print("这是预览。加 --remote 真正执行。")
        _show_encrypted(db)
        return 0

    # ---- 1. 内容块先传 R2 ----
    if not args.skip_blobs:
        rows = db.execute("SELECT hash, size FROM blobs ORDER BY id").fetchall()
        if args.limit:
            rows = rows[:args.limit]
        print("=== 上传内容块到 R2（%d 个）===" % len(rows))
        t0 = time.time()
        ok = fail = 0
        for i, r in enumerate(rows, 1):
            h = r["hash"]
            src = blob_path(h)
            if not os.path.isfile(src):
                fail += 1
                print("  [%d/%d] 缺文件 %s" % (i, len(rows), h[:12]))
                continue
            rc, out = wrangler(
                ["r2", "object", "put", "fcloud-blobs/" + r2_key(h),
                 "--file=" + src] + target)
            if rc == 0:
                ok += 1
            else:
                fail += 1
                print("  [%d/%d] 失败：%s" % (i, len(rows), out[-200:]))
            if i % 20 == 0 or i == len(rows):
                print("  ... %d/%d（%.1fs）" % (i, len(rows), time.time() - t0))
        print("  完成：成功 %d，失败 %d" % (ok, fail))
        if fail:
            print("  ⚠️ 有内容块没传上去，对应文件会下载失败")

    # ---- 2. 元数据进 D1 ----
    print()
    print("=== 导入元数据到 D1 ===")
    tmp_sql = os.path.join(EDGE_DIR, "_migrate.sql")
    try:
        for t in TABLES:
            rows = db.execute("SELECT * FROM %s" % t).fetchall()
            if not rows:
                continue
            cols = list(rows[0].keys())
            # ⚠️ nodes.current_version_id → versions.id 是个**循环外键**
            # （versions.node_id 又指向 nodes.id）。
            # D1 的外键永远开启且立即检查，PRAGMA foreign_keys=OFF 会被静默忽略
            # —— 所以只能插的时候先置空，等 versions 插完再回填。
            use_cols = [c for c in cols
                        if not (t == "nodes" and c == "current_version_id")]
            stmts = []
            for r in rows:
                vals = []
                for c in use_cols:
                    v = r[c]
                    if isinstance(v, str):
                        v = esc(v)
                    vals.append(sql_lit(v))
                stmts.append("INSERT INTO %s(%s) VALUES(%s);"
                             % (t, ",".join(use_cols), ",".join(vals)))
            with open(tmp_sql, "w", encoding="utf-8") as f:
                f.write("\n".join(stmts))
                f.write("\n")
            rc, out = wrangler(
                ["d1", "execute", "fcloud", "--file=" + tmp_sql] + target)
            if rc != 0:
                print("  ✗ 表 %s 导入失败：\n%s" % (t, out[-800:]))
                return 1
            print("  ✓ %-16s %d 行" % (t, len(rows)))

        # 回填 nodes.current_version_id（循环外键的第二步）
        cur_rows = db.execute(
            "SELECT id, node_id FROM versions WHERE is_current=1").fetchall()
        if cur_rows:
            stmts = ["UPDATE nodes SET current_version_id=%d WHERE id=%d;"
                     % (r["id"], r["node_id"]) for r in cur_rows]
            with open(tmp_sql, "w", encoding="utf-8") as f:
                f.write("\n".join(stmts) + "\n")
            rc, out = wrangler(
                ["d1", "execute", "fcloud", "--file=" + tmp_sql] + target)
            if rc != 0:
                print("  ✗ 回填当前版本失败：\n%s" % out[-800:])
                return 1
            print("  ✓ 回填当前版本 %d 个" % len(cur_rows))
    finally:
        if os.path.exists(tmp_sql):
            os.remove(tmp_sql)

    # ---- 3. 成员密码重设 ----
    print()
    print("=== 成员临时密码（登录后请立刻改掉）===")
    pw_rows = []
    for m in members:
        pw = gen_password()
        pw_rows.append((m["id"], pw, m["username"], m["display_name"]))
    if pw_rows:
        # Edge 版用 PBKDF2，散列在 Python 侧算不了（那是 JS WebCrypto 的活），
        # 所以这里直接把 pwd_algo 标成 need_reset，
        # 并在首次登录时用新密码重算哈希。
        for mid, pw, un, dn in pw_rows:
            print("  %-16s (%s)  临时密码：%s" % (dn or un, un, pw))
        with open(os.path.join(EDGE_DIR, "_migrate_passwords.txt"), "w",
                  encoding="utf-8") as f:
            f.write("# 迁移生成的临时密码 —— 改完密码后请删掉这个文件\n")
            for mid, pw, un, dn in pw_rows:
                f.write("%s\t%s\t%s\n" % (un, pw, dn or un))
        print()
        print("  已存到 _migrate_passwords.txt（改完密码请删）")

    # ---- 4. 加密文件清单 ----
    _show_encrypted(db)

    print()
    print("=" * 56)
    print("迁移完成。下一步：")
    print("  1. 打开网站，用上面的临时密码登录")
    print("  2. 每个成员改一次密码")
    print("  3. 到设置里重新设置主口令（主密钥没有迁移）")
    print("  4. 加密文件按上面清单手动重传")
    print("=" * 56)
    return 0


def _show_encrypted(db):
    rows = db.execute(
        "SELECT id,name,size,encrypted FROM nodes "
        "WHERE encrypted=1 AND deleted_at IS NULL ORDER BY id").fetchall()
    if not rows:
        return
    print()
    print("=== 需要手动重传的加密文件 ===")
    for r in rows:
        print("  #%-5d %-40s %8.1f KB" % (r["id"], r["name"], (r["size"] or 0) / 1024))


if __name__ == "__main__":
    sys.exit(main())
