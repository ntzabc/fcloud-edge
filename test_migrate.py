"""迁移脚本的自测。

## 为什么要有这个

「迁移脚本」是最容易在关键时刻出事的东西 ——
用户攒了几个月的家庭照片，一次跑错就全没了。
而且它**平时根本不会跑**，到跑的那天才发现 bug 已经太晚。

所以：**造一份假数据，完整跑一遍迁移，然后逐项核对结果。**
这跟之前给「静态检查器」做自检、给「smoke test」补假数据是同一个道理。

## 跑法

    python test_migrate.py
"""

import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NODE = r"C:\Users\kaixi\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
WRANGLER = os.path.join(HERE, "node_modules", "wrangler", "bin", "wrangler.js")

FAILS = []
NPASS = 0


def check(cond, label, detail=""):
    global NPASS
    if cond:
        NPASS += 1
        print("  ok   " + label)
    else:
        FAILS.append(label)
        print("  FAIL " + label + ("  → " + str(detail)[:200] if detail else ""))


def wrangler(args, timeout=300):
    p = subprocess.run(
        [NODE, WRANGLER] + args, cwd=HERE,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def d1(sql, extra=None):
    """查本地 D1。"""
    args = ["d1", "execute", "fcloud", "--local", "--persist-to=.wrangler/state",
            "--command", sql]
    if extra:
        args += extra
    rc, out = wrangler(args)
    return out


def d1_rows(sql):
    """从 wrangler 的输出里抽 rows。

    ⚠️ 两个坑叠在一起：
    1. wrangler 前面会打 `▲ [WARNING] The version of Wrangler ...`，
       那个 `[` 不能当成 JSON 开头。
    2. JSON 后面还跟着日志（而且带 ANSI 颜色码 \\x1b[...），
       所以不能用 json.loads（它要求整串都是 JSON），
       要用 raw_decode —— 只解一个 JSON 值，剩下的忽略。
    """
    import json
    out = d1(sql)
    dec = json.JSONDecoder()
    pos = 0
    while True:
        i = out.find("[", pos)
        if i < 0:
            return []
        try:
            data, _end = dec.raw_decode(out[i:])
        except Exception:
            pos = i + 1
            continue
        if isinstance(data, list):
            rows = []
            for item in data:
                if isinstance(item, dict) and item.get("results") is not None:
                    rows.extend(item["results"])
            return rows
        pos = i + 1


def build_fake_python_db(path, blobdir):
    """造一份跟 Python 版结构一致的假数据。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.makedirs(blobdir, exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript("""
    CREATE TABLE members (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'child',
      pwd_hash TEXT, pwd_salt TEXT, pwd_algo TEXT,
      color TEXT NOT NULL DEFAULT '#5B9BFF', disabled INTEGER NOT NULL DEFAULT 0,
      created_at REAL NOT NULL, last_login_at REAL);
    CREATE TABLE spaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES members(id),
      quota_bytes INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL);
    CREATE TABLE space_members (space_id INTEGER NOT NULL, member_id INTEGER NOT NULL,
      role TEXT NOT NULL, PRIMARY KEY (space_id, member_id));
    CREATE TABLE blobs (id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL, refcount INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL);
    CREATE TABLE nodes (id INTEGER PRIMARY KEY, space_id INTEGER NOT NULL,
      parent_id INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'file', current_version_id INTEGER,
      owner_id INTEGER NOT NULL, uploader_id INTEGER, category TEXT NOT NULL DEFAULT '其他',
      tags TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
      starred INTEGER NOT NULL DEFAULT 0, encrypted INTEGER NOT NULL DEFAULT 0,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL,
      modified_at REAL NOT NULL, deleted_at REAL, deleted_by INTEGER,
      trash_parent_id INTEGER, download_count INTEGER NOT NULL DEFAULT 0, last_access_at REAL);
    CREATE TABLE versions (id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL,
      seq INTEGER NOT NULL, size INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0, mime TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL, created_by INTEGER, note TEXT NOT NULL DEFAULT '',
      is_current INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE version_chunks (version_id INTEGER NOT NULL, seq INTEGER NOT NULL,
      blob_id INTEGER NOT NULL, offset INTEGER NOT NULL, size INTEGER NOT NULL,
      PRIMARY KEY (version_id, seq));
    CREATE TABLE version_crypto (version_id INTEGER PRIMARY KEY, algo TEXT NOT NULL,
      salt_seed TEXT NOT NULL, wrapped_key TEXT NOT NULL, check_salt TEXT NOT NULL,
      check_ct TEXT NOT NULL, check_tag TEXT NOT NULL, created_at REAL NOT NULL);
    CREATE TABLE shares (id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL,
      grantee_id INTEGER NOT NULL, granted_by INTEGER NOT NULL,
      permission TEXT NOT NULL DEFAULT 'read', created_at REAL NOT NULL, note TEXT NOT NULL DEFAULT '');
    CREATE TABLE audit (id INTEGER PRIMARY KEY, space_id INTEGER, actor_id INTEGER,
      actor_name TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT '', target_id INTEGER,
      target_name TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, member_id INTEGER NOT NULL,
      created_at REAL NOT NULL, expires_at REAL NOT NULL, ua TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '');
    CREATE TABLE tombstones (id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL,
      name TEXT NOT NULL, parent_id INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      version_id INTEGER, deleted_at REAL NOT NULL, deleted_by INTEGER, purged_at REAL,
      purged_by INTEGER, grace_until REAL NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL);
    CREATE TABLE file_text (node_id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', indexed_at REAL NOT NULL);
    CREATE TABLE fterms (term TEXT NOT NULL, node_id INTEGER NOT NULL,
      tf REAL NOT NULL DEFAULT 1, PRIMARY KEY (term, node_id));
    CREATE TABLE uploads (id TEXT PRIMARY KEY, space_id INTEGER NOT NULL, member_id INTEGER NOT NULL,
      node_id INTEGER, parent_id INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL,
      total_size INTEGER NOT NULL, chunk_size INTEGER NOT NULL, total_chunks INTEGER NOT NULL,
      mime TEXT NOT NULL DEFAULT '', encrypted INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT '其他', note TEXT NOT NULL DEFAULT '',
      temp_dir TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open',
      wrapped_key TEXT, salt_seed TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL);
    CREATE TABLE upload_parts (upload_id TEXT NOT NULL, seq INTEGER NOT NULL,
      hash TEXT NOT NULL, size INTEGER NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (upload_id, seq));
    """)

    now = 1700000000.0
    # 成员
    db.execute("INSERT INTO members VALUES(1,'baba','爸爸','admin','h','s','scrypt','#5B9BFF',0,?,NULL)", (now,))
    db.execute("INSERT INTO members VALUES(2,'mama','妈妈','adult','h','s','scrypt','#FF8A5B',0,?,NULL)", (now,))
    db.execute("INSERT INTO members VALUES(3,'kid','小孩','child','h','s','scrypt','#7ED957',0,?,NULL)", (now,))
    # 空间
    db.execute("INSERT INTO spaces VALUES(1,'我们一家',1,0,?)", (now,))
    for mid, role in ((1, 'admin'), (2, 'adult'), (3, 'child')):
        db.execute("INSERT INTO space_members VALUES(1,?,?)", (mid, role))
    # 内容块
    contents = {
        1: b"hello world from migration test",
        2: "中文内容测试 —— 迁移要保证编码不坏".encode("utf-8"),
        3: b"x" * 5000,
    }
    for bid, data in contents.items():
        h = hashlib.sha256(data).hexdigest()
        db.execute("INSERT INTO blobs VALUES(?,?,?,1,?)", (bid, h, len(data), now))
        p = os.path.join(blobdir, h[:2], h[2:4])
        os.makedirs(p, exist_ok=True)
        with open(os.path.join(p, h), "wb") as f:
            f.write(data)
    # 文件树
    db.execute("INSERT INTO nodes VALUES(1,1,0,'照片','folder',NULL,1,1,'照片','','',0,0,'application/octet-stream',0,0,?,?,NULL,NULL,NULL,0,NULL)", (now, now))
    # note 里故意带单引号 —— 这是 SQL 注入面，必须用参数化插入
    db.execute("INSERT INTO nodes VALUES(2,1,0,?,?,1,1,1,?,'',?,1,0,'text/plain',29,1,?,?,NULL,NULL,NULL,0,NULL)",
               ("测试文件.txt", "file", "文档", "备注里有单引号' and stuff", now, now))
    db.execute("INSERT INTO nodes VALUES(3,1,1,'家族照片.jpg','file',2,2,2,'照片','','',0,0,'image/jpeg',21,1,?,?,NULL,NULL,NULL,0,NULL)", (now, now))
    # 版本
    db.execute("INSERT INTO versions VALUES(1,2,1,29,1,0,'text/plain',?,1,'初次上传',1)", (now,))
    db.execute("INSERT INTO versions VALUES(2,3,1,21,1,0,'image/jpeg',?,2,'',1)", (now,))
    db.execute("INSERT INTO version_chunks VALUES(1,0,1,0,29)")
    db.execute("INSERT INTO version_chunks VALUES(2,0,2,0,21)")
    # 共享
    db.execute("INSERT INTO shares VALUES(1,3,3,1,'read',?,'')", (now,))
    # 审计
    db.execute("INSERT INTO audit VALUES(1,1,1,'爸爸','upload','file',2,'家族照片.jpg','','127.0.0.1',?)", (now,))
    # 设置
    db.execute("INSERT INTO settings VALUES('space_name','我们一家',?)", (now,))
    db.execute("INSERT INTO settings VALUES('master_derived','scrypt:abc:def:ghi',?)", (now,))
    # 索引
    db.execute("INSERT INTO file_text VALUES(2,1,'测试文件.txt','hello world from migration test',?)", (now,))
    db.execute("INSERT INTO fterms VALUES('hello',2,1)")
    db.execute("INSERT INTO fterms VALUES('测试',2,1)")
    db.commit()
    db.close()
    return contents


def main():
    print("=== 准备：造假数据 ===")
    tmp = tempfile.mkdtemp(prefix="fcloud-mig-test-")
    fake_db = os.path.join(tmp, "fcloud.db")
    fake_blobs = os.path.join(tmp, "blobs")
    contents = build_fake_python_db(fake_db, fake_blobs)
    check(os.path.isfile(fake_db), "造出源数据库")
    check(len(contents) == 3, "造出 3 个内容块", len(contents))

    # 清本地 D1 状态，先建 schema
    print()
    print("=== 准备：建本地 D1 ===")
    state = os.path.join(HERE, ".wrangler")
    if os.path.isdir(state):
        shutil.rmtree(state, ignore_errors=True)
    for mig in ("0001_init.sql", "0002_security.sql"):
        rc, out = wrangler(["d1", "execute", "fcloud", "--local",
                            "--persist-to=.wrangler/state",
                            "--file=./migrations/" + mig])
        check(rc == 0, "迁移 schema " + mig, out[-300:])

    # 跑迁移
    print()
    print("=== 跑迁移（--local）===")
    p = subprocess.run(
        [sys.executable, os.path.join(HERE, "migrate_to_edge.py"),
         "--local", "--db", fake_db, "--skip-blobs"],
        cwd=HERE, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=600)
    out = p.stdout or ""
    check(p.returncode == 0, "迁移脚本退出码 0", (p.stderr or "")[-400:])
    print("   " + "\n   ".join(out.strip().split("\n")[-8:]))

    # 核对
    print()
    print("=== 核对迁移结果 ===")
    rows = d1_rows("SELECT COUNT(*) AS c FROM members")
    check(rows and rows[0]["c"] == 3, "成员搬过来 3 个", rows)
    rows = d1_rows("SELECT COUNT(*) AS c FROM nodes")
    check(rows and rows[0]["c"] == 3, "节点搬过来 3 个", rows)
    rows = d1_rows("SELECT COUNT(*) AS c FROM blobs")
    check(rows and rows[0]["c"] == 3, "内容块记账搬过来 3 个", rows)
    rows = d1_rows("SELECT COUNT(*) AS c FROM version_chunks")
    check(rows and rows[0]["c"] == 2, "版本分片搬过来 2 个", rows)
    rows = d1_rows("SELECT COUNT(*) AS c FROM fterms")
    check(rows and rows[0]["c"] == 2, "倒排索引搬过来 2 个", rows)

    rows = d1_rows("SELECT name,note,starred,category FROM nodes WHERE id=2")
    check(rows and rows[0]["name"] == "测试文件.txt", "文件名正确", rows)
    check(rows and "单引号" in (rows[0]["note"] or ""),
          "含单引号的备注没被 SQL 截断", rows)
    check(rows and rows[0]["starred"] == 1, "收藏状态正确", rows)
    check(rows and rows[0]["category"] == "文档", "分类正确", rows)

    rows = d1_rows("SELECT body FROM file_text WHERE node_id=2")
    check(rows and rows[0]["body"] == "hello world from migration test",
          "正文索引内容正确", rows)

    rows = d1_rows("SELECT term FROM fterms ORDER BY term")
    got = sorted(r["term"] for r in rows) if rows else []
    check(got == ["hello", "测试"], "中文索引词正确（没乱码）", got)

    # 主密钥不该被搬
    rows = d1_rows("SELECT key FROM settings WHERE key LIKE 'master%'")
    keys = [r["key"] for r in rows] if rows else []
    check("master_derived" not in keys,
          "旧的主密钥没被搬过来（会跟新格式冲突）", keys)
    check("master_wrapped" not in keys,
          "新格式的主密钥没被搬（要重新设主口令）", keys)

    # 临时密码文件
    pwf = os.path.join(HERE, "_migrate_passwords.txt")
    check(os.path.isfile(pwf), "生成了临时密码文件")
    if os.path.isfile(pwf):
        txt = io_read(pwf)
        check(txt.count("\t") >= 3, "临时密码有 3 条", txt.count("\t"))
        os.remove(pwf)

    shutil.rmtree(tmp, ignore_errors=True)

    print()
    print("=" * 50)
    print("通过 %d 项，失败 %d 项" % (NPASS, len(FAILS)))
    for f in FAILS:
        print("  FAIL " + f)
    print("=" * 50)
    return 1 if FAILS else 0


def io_read(p):
    import io
    return io.open(p, encoding="utf-8").read()


if __name__ == "__main__":
    sys.exit(main())
