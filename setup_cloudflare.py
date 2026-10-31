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


def read_dev_vars(key):
    """从本地 .dev.vars 读一个值（用来拿用户自己的 OpenRouter key）。

    .dev.vars 是 wrangler dev 的本地 secret 文件，已经在 .gitignore 里。
    """
    p = os.path.join(HERE, ".dev.vars")
    if not os.path.isfile(p):
        return ""
    for line in open(p, encoding="utf-8").read().split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def parse_wrangler_json(out):
    """从 wrangler 输出里抽 JSON 数组。

    ⚠️ 两个坑（都踩过）：
    1. 前面有 `▲ [WARNING] The version of Wrangler ...` 的 `[`，
       不能用 out.find("[") 找开头。
    2. JSON 后面还跟着日志，且带 ANSI 颜色码 \\x1b[...，
       所以不能用 json.loads（它要求整串都是 JSON），要用 raw_decode。
    """
    import json
    clean = re.sub(r"\x1b\[[0-9;]*m", "", out)
    dec = json.JSONDecoder()
    pos = 0
    while True:
        i = clean.find("[", pos)
        if i < 0:
            return []
        try:
            data, _end = dec.raw_decode(clean[i:])
        except Exception:
            pos = i + 1
            continue
        if isinstance(data, list):
            return data
        pos = i + 1


def find_by_name(items, name, name_keys, id_keys):
    """在 wrangler 列出的资源里按名字找 id。

    ⚠️ 绝对不能取「列表里的第一个」——
    账号里要是还有别的项目建的同名类型资源，就会拿到错的 id，
    然后写进 wrangler.jsonc，部署到错误的数据库/桶。

    ⚠️ 不同命令的字段名不一样，而且 wrangler 升级也可能改：
      d1 list --json  → { database_name, database_id }
      kv namespace list → { title, value }
    所以这里用**候选字段名列表**，谁先命中用谁。
    """
    if isinstance(name_keys, str):
        name_keys = [name_keys]
    if isinstance(id_keys, str):
        id_keys = [id_keys]
    for it in items:
        if not isinstance(it, dict):
            continue
        for nk in name_keys:
            if it.get(nk) == name:
                for ik in id_keys:
                    v = it.get(ik)
                    if v:
                        return v
    return None


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
    # ⚠️ 优先读本地 wrangler.jsonc 里已经填好的 id ——
    # 用户手动改过配置的话，根本不需要去 list（省一次 API 调用，也少一个出错点）。
    cur_d1 = conf["d1_databases"][0].get("database_id", "")
    PLACEHOLDER = "00000000-0000-0000-0000-000000000000"
    if cur_d1 and cur_d1 != PLACEHOLDER:
        d1_id = cur_d1
        print("  配置里已有 id，跳过查询（%s）" % d1_id)
    else:
        rc, out = run(["d1", "list", "--json"], timeout=120, check=False)
        # 按**名字**找，不能取列表里的第一个
        d1_id = find_by_name(
            parse_wrangler_json(out), d1_name,
            ["database_name", "name"], ["database_id", "uuid", "id"])
        if d1_id:
            print("  已存在，跳过（%s）" % d1_id)
        elif dry:
            print("  [会创建] %s" % d1_name)
        else:
            rc, out = run(["d1", "create", d1_name], timeout=180)
            d1_id = find_by_name(
                parse_wrangler_json(out), d1_name,
                ["database_name", "name"], ["database_id", "uuid", "id"])
            if not d1_id:
                m = re.search(r'"database_id"\s*:\s*"([^"]+)"', out)
                d1_id = m.group(1) if m else None
            if not d1_id:
                print("  ✗ 创建失败：", out[-600:])
                sys.exit(1)
            print("  ✓ 创建完成 id=%s" % d1_id)

    # ---- R2 ----
    step("R2 存储桶")
    rc, out = run(["r2", "bucket", "list"], timeout=120, check=False)
    # 桶名是配置里写死的字符串，用「包含」判断安全
    # （不像 id 那样会拿错 —— 桶名唯一）
    if r2_name in re.sub(r"\x1b\[[0-9;]*m", "", out):
        print("  已存在，跳过")
    elif dry:
        print("  [会创建] %s" % r2_name)
    else:
        run(["r2", "bucket", "create", r2_name], timeout=180)
        print("  ✓ 创建完成")

    # ---- KV ----
    step("KV 命名空间（限流用）")
    cur_kv = conf["kv_namespaces"][0].get("id", "")
    if cur_kv and cur_kv != "0000000000000000000000000000000f":
        kv_id = cur_kv
        print("  配置里已有 id，跳过查询（%s）" % kv_id)
    else:
        rc, out = run(["kv", "namespace", "list"], timeout=120, check=False)
        kv_items = parse_wrangler_json(out)
        # KV 列表的字段是 title（= binding 名）+ value（= id）
        kv_id = find_by_name(kv_items, kv_binding, ["title", "name"], ["value", "id"])
        if not kv_id:
            # 老版本 wrangler 输出格式不一样，退而求其次找非占位符的
            for it in kv_items:
                if isinstance(it, dict):
                    v = it.get("value") or it.get("id")
                    if v and v != PLACEHOLDER and v != "0000000000000000000000000000000f":
                        kv_id = v
                        break
        if kv_id:
            print("  已存在，跳过（%s）" % kv_id)
        elif dry:
            print("  [会创建] binding=%s" % kv_binding)
        else:
            rc, out = run(["kv", "namespace", "create", kv_binding], timeout=180)
            kv_id = find_by_name(
                parse_wrangler_json(out), kv_binding,
                ["title", "name"], ["value", "id"])
            if not kv_id:
                m = re.search(r'"id"\s*:\s*"([^"]+)"', out)
                kv_id = m.group(1) if m else None
            if not kv_id:
                print("  ✗ 创建失败：", out[-600:])
                sys.exit(1)
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

    # ---- Secret ----
    # 用 `secret bulk` 而不是 `secret put` ——
    # put 要交互式读 stdin，在脚本里喂不一定稳；bulk 直接读 JSON 文件，稳。
    step("Secret（MASTER_SECRET / FCLOUD_AI_KEY）")
    rc, out = run(["secret", "list"], timeout=120, check=False)
    existing = out
    have_master = "MASTER_SECRET" in existing
    have_ai = "FCLOUD_AI_KEY" in existing

    if dry:
        print("  MASTER_SECRET：%s" % ("已存在" if have_master else "[会创建]"))
        print("  FCLOUD_AI_KEY ：%s" % ("已存在" if have_ai else "[会创建（如果 .dev.vars 里有]）"))
    else:
        bulk = {}
        if not have_master:
            import secrets
            bulk["MASTER_SECRET"] = secrets.token_urlsafe(48)
            print("  ✓ 生成 MASTER_SECRET（不会打印出来）")
        # OpenRouter 的 key：从本地 .dev.vars 拿（那里有用户自己的 key）
        if not have_ai:
            ai_key = read_dev_vars("FCLOUD_AI_KEY")
            if ai_key:
                bulk["FCLOUD_AI_KEY"] = ai_key
                print("  ✓ 从 .dev.vars 读入 FCLOUD_AI_KEY")
            else:
                print("  ⚠️ 没找到 FCLOUD_AI_KEY —— 小f 上线后不可用，")
                print("     可以在网页「设置」里填，或之后跑：")
                print("     wrangler secret put FCLOUD_AI_KEY")
        if bulk:
            tmp = os.path.join(HERE, "_secrets.json")
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(bulk, f)
                run(["secret", "bulk", tmp], timeout=300)
                print("  ✓ 已设置：%s" % "、".join(bulk.keys()))
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
        else:
            print("  已全部存在，跳过（不覆盖 —— 覆盖 MASTER_SECRET 等于加密文件永久报废）")

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
