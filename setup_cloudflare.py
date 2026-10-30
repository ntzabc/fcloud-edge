"""一键部署助手 —— 在用户的 Cloudflare 账号上把 Fcloud Edge 跑起来。

## 为什么写这个脚本

部署要 5 步（建 D1 / 建 R2 / 建 KV / 设 secret / 建表 / 部署），
每步都要复制 id 回 wrangler.jsonc —— 手工做容易漏、容易错。

这个脚本把整条流程串起来：
  1. 检查 wrangler 登录状态
  2. 创建 D1 / R2 / KV（已存在就跳过）
  3. 把返回的 id 自动写回 wrangler.jsonc
  4. 生成并设置 MASTER_SECRET
  5. 应用数据库迁移
  6. 部署，拿到网址

## 用法

    python setup_cloudflare.py          # 全自动
    python setup_cloudflare.py --dry    # 只看要做什么，不真的创建

前置：已经跑过 `wrangler login`（会开浏览器）。
"""

import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = r"C:\Users\kaixi\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
WRANGLER = os.path.join(HERE, "node_modules", "wrangler", "bin", "wrangler.js")
CONF = os.path.join(HERE, "wrangler.jsonc")


def run(args, timeout=600, check=True):
    """跑 wrangler。返回 (rc, 输出)。"""
    p = subprocess.run(
        [NODE, WRANGLER] + args, cwd=HERE,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout)
    out = (p.stdout or "") + (p.stderr or "")
    if check and p.returncode != 0:
        print("  ✗ 失败：", " ".join(args))
        print(out[-1200:])
        sys.exit(1)
    return p.returncode, out


def step(msg):
    print()
    print("▸ " + msg)


def whoami():
    rc, out = run(["whoami"], timeout=60, check=False)
    clean = re.sub(r"\x1b\[[0-9;]*m", "", out)
    # ⚠️ wrangler 未登录时**退出码还是 0**，只打印一句 "You are not authenticated"。
    # 所以不能只看返回码 —— 必须看输出内容。
    if rc != 0 or "not authenticated" in clean.lower():
        print("还没登录 Cloudflare。先跑：")
        print("  node node_modules/wrangler/bin/wrangler.js login")
        print("（会开浏览器，用 GitHub 账号授权最省事）")
        sys.exit(1)
    for line in clean.split("\n"):
        if "Account ID" in line or "Account Name" in line:
            print("  " + line.strip())
    return clean


def read_conf():
    """读 wrangler.jsonc。

    JSONC = JSON + 注释。这个文件里的注释都是整行的 `//`，
    所以逐行去掉再 json.loads 就够了 —— 不需要引完整的 JSONC 解析器。
    """
    lines = []
    for line in open(CONF, encoding="utf-8").read().split("\n"):
        st = line.strip()
        if st.startswith("//"):
            continue
        # 去行尾注释（只在 // 之前没有引号时才敢切，
        # 否则 URL 里的 // 会被误伤）
        idx = line.find("//")
        if idx >= 0 and '"' not in line[:idx]:
            line = line[:idx]
        lines.append(line)
    return json.loads("\n".join(lines))


def write_conf_ids(d1_id, r2_name, kv_id):
    """把真实的 id 写回 wrangler.jsonc（保留原格式，只改值）。"""
    txt = open(CONF, encoding="utf-8").read()
    txt = re.sub(r'("database_id"\s*:\s*)"[^"]*"', r'\1"%s"' % d1_id, txt)
    txt = re.sub(r'("bucket_name"\s*:\s*)"[^"]*"', r'\1"%s"' % r2_name, txt)
    txt = re.sub(r'("id"\s*:\s*)"[^"]*"', r'\1"%s"' % kv_id, txt)
    open(CONF, "w", encoding="utf-8", newline="").write(txt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="只看要做什么")
    args = ap.parse_args()
    dry = args.dry

    print("=" * 56)
    print("Fcloud Edge · Cloudflare 部署助手")
    print("=" * 56)

    step("检查登录状态")
    whoami()

    conf = read_conf()
    d1_name = conf["d1_databases"][0]["database_name"]
    r2_name = conf["r2_buckets"][0]["bucket_name"]
    kv_binding = conf["kv_namespaces"][0]["binding"]

    # ---- D1 ----
    step("D1 数据库")
    rc, out = run(["d1", "list"], timeout=120, check=False)
    d1_id = None
    for m in re.finditer(r'"database_id"\s*:\s*"([^"]+)"', out):
        d1_id = m.group(1)
        break
    if d1_id and d1_id != "00000000-0000-0000-0000-000000000000":
        print("  已存在，跳过")
    elif dry:
        print("  [会创建] %s" % d1_name)
    else:
        rc, out = run(["d1", "create", d1_name], timeout=180)
        m = re.search(r'"database_id"\s*:\s*"([^"]+)"', out)
        d1_id = m.group(1) if m else None
        print("  ✓ 创建完成 id=%s" % d1_id)

    # ---- R2 ----
    step("R2 存储桶")
    rc, out = run(["r2", "bucket", "list"], timeout=120, check=False)
    if r2_name in out:
        print("  已存在，跳过")
    elif dry:
        print("  [会创建] %s" % r2_name)
    else:
        run(["r2", "bucket", "create", r2_name], timeout=180)
        print("  ✓ 创建完成")

    # ---- KV ----
    step("KV 命名空间（限流用）")
    rc, out = run(["kv", "namespace", "list"], timeout=120, check=False)
    kv_id = None
    m = re.search(r'"id"\s*:\s*"([^"]+)"', out)
    if m and m.group(1) != "00000000-0000-0000-0000-000000000000":
        kv_id = m.group(1)
        print("  已存在，跳过")
    elif dry:
        print("  [会创建] binding=%s" % kv_binding)
    else:
        rc, out = run(["kv", "namespace", "create", kv_binding], timeout=180)
        m = re.search(r'"id"\s*:\s*"([^"]+)"', out)
        kv_id = m.group(1) if m else None
        print("  ✓ 创建完成 id=%s" % kv_id)

    # ---- 写回配置 ----
    step("更新 wrangler.jsonc")
    if dry:
        print("  [会写入] database_id / bucket_name / kv id")
    elif d1_id and kv_id:
        write_conf_ids(d1_id, r2_name, kv_id)
        print("  ✓ 已写回")
    else:
        print("  ⚠️ 没拿到 id，跳过（手动改 wrangler.jsonc）")

    # ---- MASTER_SECRET ----
    step("主密钥加密根 MASTER_SECRET")
    rc, out = run(["secret", "list"], timeout=120, check=False)
    if "MASTER_SECRET" in out:
        print("  已存在，跳过（不覆盖 —— 覆盖了等于所有加密文件永久报废）")
    elif dry:
        print("  [会创建] MASTER_SECRET")
    else:
        import secrets
        sec = secrets.token_urlsafe(48)
        print("  ✓ 已生成并设置（不会打印出来）")
        p = subprocess.run(
            [NODE, WRANGLER, "secret", "put", "MASTER_SECRET"],
            cwd=HERE, input=sec + "\n", capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=180)
        if p.returncode != 0:
            print("  ✗ 失败：", (p.stdout or "") + (p.stderr or "")[-600:])
            sys.exit(1)

    # ---- 迁移 ----
    step("数据库迁移")
    if dry:
        print("  [会执行] 0001_init.sql + 0002_security.sql")
    else:
        for mig in ("0001_init.sql", "0002_security.sql"):
            run(["d1", "execute", d1_name, "--file=./migrations/" + mig, "--remote"],
                timeout=300)
            print("  ✓ %s" % mig)

    # ---- 部署 ----
    step("部署")
    if dry:
        print("  [会执行] wrangler deploy")
    else:
        rc, out = run(["deploy"], timeout=600)
        url = ""
        m = re.search(r"(https://[a-z0-9.-]+\.workers\.dev)", out)
        if m:
            url = m.group(1)
        print("  ✓ 部署完成")
        if url:
            print()
            print("  网址： " + url)
            print()
            print("  下一步：")
            print("    1. 在浏览器打开上面的网址")
            print("    2. 建管理员账号（只有一次机会）")
            print("    3. iPad 的 Safari 打开 → 分享 → 添加到主屏幕")
            print()
            print("  ⚠️ MASTER_SECRET 请自己备份一份 —— 丢了所有加密文件永久无法解开")
            print("     wrangler secret list 可以确认它存在，但看不到内容")

    print()
    print("=" * 56)
    print("搞定")
    print("=" * 56)


if __name__ == "__main__":
    main()
