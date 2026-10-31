"""部署助手的自测 —— 专测「资源 id 查找」这块。

## 为什么单独测这块

这段逻辑错了的后果很严重：**拿错 D1 的 id → 部署到别人的数据库**
（或者自己账号里另一个项目的库），数据全写错地方，而且不报错。

而且它平时根本不会跑 —— 只有真部署时才走一遍。
所以必须先造假数据把各种输出格式都试一遍。

## 测什么

1. wrangler 各命令的输出格式（字段名不一样！）
2. 账号里有多个同类资源时，要按**名字**取对的那个
3. JSON 前后有日志和 ANSI 颜色码时也能解析
4. 字段名变了（wrangler 升级）时的回退
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sc", os.path.join(HERE, "setup_cloudflare.py"))
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)

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


# --------------------------------------------------------------- 假输出样本

D1_JSON = """Proxy environment variables detected. We'll use your proxy for fetch requests.

 \u26a1\ufe0f  wrangler 3.114.17 (update available 4.156.0)
------------------------------------------------

\u25b2 [WARNING] The version of Wrangler you are using is now out-of-date.

[
  {
    "database_name": "other-project-db",
    "database_id": "aaaa1111-2222-3333-4444-555566667777",
    "created_at": "2026-01-01T00:00:00Z"
  },
  {
    "database_name": "fcloud",
    "database_id": "bbbb2222-3333-4444-5555-666677778888",
    "created_at": "2026-10-30T00:00:00Z"
  }
]
[wrangler:inf] Done
"""

# 新版 wrangler 可能换字段名
D1_JSON_ALT = """[
  {
    "name": "fcloud",
    "uuid": "cccc3333-4444-5555-6666-777788889999"
  }
]
"""

KV_JSON = """[
  {
    "title": "other-RATE",
    "value": "dddd4444-5555-6666-7777-888899990000"
  },
  {
    "title": "RATE",
    "value": "eeee5555-6666-7777-8888-999900001111"
  }
]
"""

# 完全不是 JSON（wrangler 升级后换了格式）
GARBAGE = "some totally unexpected output\nno json here at all\n"


def main():
    print("=== 资源 id 查找 ===")

    items = sc.parse_wrangler_json(D1_JSON)
    check(len(items) == 2, "从带日志的输出里解析出 2 个 D1", len(items))

    got = sc.find_by_name(items, "fcloud", ["database_name", "name"],
                          ["database_id", "uuid", "id"])
    check(got == "bbbb2222-3333-4444-5555-666677778888",
          "按名字取到正确的 D1 id（不是列表第一个）", got)

    got = sc.find_by_name(items, "nope", ["database_name", "name"],
                          ["database_id", "uuid", "id"])
    check(got is None, "找不到时返回 None", got)

    # 字段名变了也要能取到
    items2 = sc.parse_wrangler_json(D1_JSON_ALT)
    got = sc.find_by_name(items2, "fcloud", ["database_name", "name"],
                          ["database_id", "uuid", "id"])
    check(got == "cccc3333-4444-5555-6666-777788889999",
          "字段名变了也能取到（uuid 回退）", got)

    # KV 的字段是 title + value
    kitems = sc.parse_wrangler_json(KV_JSON)
    got = sc.find_by_name(kitems, "RATE", ["title", "name"], ["value", "id"])
    check(got == "eeee5555-6666-7777-8888-999900001111",
          "KV 按 title 取到正确的 id", got)

    # 不是 JSON 也不能崩
    got = sc.parse_wrangler_json(GARBAGE)
    check(got == [], "非 JSON 输出返回空列表而不是崩溃", got)

    # ANSI 颜色码
    ansi = "\u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m\n" + D1_JSON
    items3 = sc.parse_wrangler_json(ansi)
    check(len(items3) == 2, "带 ANSI 颜色码也能解析", len(items3))

    print()
    print("=== 配置读取 ===")
    conf = sc.read_conf()
    check(conf["d1_databases"][0]["database_name"] == "fcloud", "读出 D1 名字")
    check(conf["r2_buckets"][0]["bucket_name"] == "fcloud-blobs", "读出 R2 名字")
    check(conf["kv_namespaces"][0]["binding"] == "RATE", "读出 KV binding")

    print()
    print("=== 本地 secret 读取 ===")
    k = sc.read_dev_vars("FCLOUD_AI_KEY")
    check(bool(k), "读出 .dev.vars 里的 FCLOUD_AI_KEY")
    check(k.startswith("sk-"), "key 格式对")
    check(sc.read_dev_vars("NOT_EXIST_KEY") == "", "不存在的 key 返回空串")

    print()
    print("=== 写回 id 的正则 ===")
    import re
    txt = open(sc.CONF, encoding="utf-8").read()
    fixed = re.sub(r'("database_id"\s*:\s*)"[^"]*"', r'\1"TEST-D1-ID"', txt)
    fixed = re.sub(r'("id"\s*:\s*)"[^"]*"', r'\1"TEST-KV-ID"', fixed)
    check('"database_id": "TEST-D1-ID"' in fixed, "database_id 能替换")
    check('"id": "TEST-KV-ID"' in fixed, "KV id 能替换")
    check('"bucket_name": "fcloud-blobs"' in fixed, "bucket_name 没被误伤")

    print()
    print("=" * 50)
    print("通过 %d 项，失败 %d 项" % (NPASS, len(FAILS)))
    for f in FAILS:
        print("  FAIL " + f)
    print("=" * 50)
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
