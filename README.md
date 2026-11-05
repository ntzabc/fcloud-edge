# Fcloud Edge —— Family Cloud 的云端版

把家庭云盘搬到 Cloudflare Workers + D1 + R2，**零成本、零信用卡、笔记本不用开机**。

- 代码仓库：和主项目一起放在 GitHub（推代码即部署）
- 运行时：Cloudflare Workers（边缘，全球 300+ 城市）
- 数据库：D1（SQLite 兼容）
- 文件：R2（对象存储，出口流量免费）
- 前端：**零改动**，直接复用 Python 版的 `web/`

---

## 为什么不是 GitHub Pages

GitHub Pages 只能托管静态文件。Fcloud 需要：
- 能写的数据库（SQLite）
- 能存文件块的对象存储
- 服务端运算（加密、索引、模型调用）

这三样 GitHub 都给不了。所以**GitHub 当代码仓库和部署触发器**，运行时在 Cloudflare。

---

## 三条路线当时怎么选的

| 路线 | 结论 |
|---|---|
| GitHub Pages | ✗ 只能静态 |
| **Cloudflare Workers + D1 + R2** | ✓ **选定**。免费额度够，不要信用卡，GitHub 可直连部署 |
| Oracle Cloud Always Free | ✓ 也能跑，但要信用卡验证、A1 容量难抢、国内延迟 80–200ms |

---

## 关键限制（决定了架构）

### Workers 免费版

| 限制 | 值 | 影响 |
|---|---|---|
| 请求数 | 10 万/天 | 家庭自用绰绰有余 |
| **CPU 时间** | **10ms/请求** | ⚠️ 最大的约束，见下 |
| 内存 | 128MB | 不能把大文件读进内存 |
| 子请求 | 50/请求 | R2 读写算子请求 |
| 脚本大小 | 3MB（压缩后） | 依赖不能多 |
| 静态资源 | 20,000 文件 | 走 ASSETS binding **不计请求配额** |

**CPU 10ms 意味着什么**：等待 D1/R2/网络不算 CPU（I/O 等待不计时），
但纯 JS 的计算要算。所以：

- `scrypt`（Python 版用的主密钥派生）→ **纯 JS 实现必然超时**，
  已换成 WebCrypto 原生的 **PBKDF2-SHA256（21 万轮）**
- `hashlib.sha256` → `crypto.subtle.digest`
- `hmac` → `crypto.subtle.sign(HMAC)`
- AES-GCM → `crypto.subtle`（原生）

WebCrypto 是原生调用，**理论上不计入这 10ms** —— 但这是**待线上实测确认**的关键假设。

### D1 免费版

| 限制 | 值 | 影响 |
|---|---|---|
| 单库容量 | **500MB** | Python 版的库是无限配额，上云后要盯着 |
| 账户总量 | 5GB | 够用 |
| 读取 | 500 万行/天 | 按**扫描行数**算，不是返回行数 → 索引是配额保护 |
| 写入 | 10 万行/天 | 约 10 写/秒（单线程写入） |
| 事务 | **不支持 BEGIN/COMMIT** | 用 `db.batch()` 代替 |
| 绑定参数 | 100/查询 | 批量操作要拆批 |

### R2 免费版

- 10GB 存储
- 100 万次写操作/月、1000 万次读操作/月
- **出口流量免费** ← 家庭云盘下载全是出口流量，这条很关键

---

## 目录

```
FcloudEdge/
├── src/
│   ├── index.ts        Worker 入口（路由分发 + 定时任务）
│   ├── router.ts       路由表（契约跟 Python 版完全一致）
│   ├── types.ts        类型定义
│   ├── crypto.ts       WebCrypto 密码学层
│   ├── db.ts           D1 数据访问层
│   ├── storage.ts      R2 内容寻址存储
│   ├── http.ts         请求/响应/鉴权 helper + 中文分词
│   ├── poc.ts          核心链路 PoC
│   └── routes/         各业务模块
├── migrations/
│   └── 0001_init.sql   D1 schema
├── web/                前端（从 Fcloud/web 复制，零改动）
├── test/               测试
├── wrangler.jsonc      Cloudflare 配置
└── _run_poc.py         端到端测试脚本
```

---

## 本地开发

```bash
npm install

# 建本地 D1 表（两个迁移都要跑）
node node_modules/wrangler/bin/wrangler.js d1 execute fcloud \
  --file=./migrations/0001_init.sql --local --persist-to=.wrangler/state
node node_modules/wrangler/bin/wrangler.js d1 execute fcloud \
  --file=./migrations/0002_security.sql --local --persist-to=.wrangler/state

# 起本地服务（miniflare 模拟 D1/R2/KV）
node node_modules/wrangler/bin/wrangler.js dev --local --persist-to=.wrangler/state

# 跑端到端测试（179 项）
python _run_poc.py

# 跑迁移脚本自测（20 项）
python test_migrate.py
```

> Windows 上 `npx` 是 `.cmd`，Python 的 `subprocess` 找不到它 ——
> 直接用 `node node_modules/wrangler/bin/wrangler.js` 更稳。

### ⚠️ 本地 secret

`.dev.vars` 里放的是**本地假 secret**（已在 .gitignore 里）。
线上要用真的：

```bash
node node_modules/wrangler/bin/wrangler.js secret put MASTER_SECRET
```

`MASTER_SECRET` 是主密钥的加密根，**丢了就等于所有加密文件永久无法解开**。
备份好，别只存在一台机器上。

---

## 部署

### 一、一次性准备

**最省事的做法 —— 跑这个脚本，全自动：**

```bash
node node_modules/wrangler/bin/wrangler.js login   # 先登录（会开浏览器）
python setup_cloudflare.py                          # 建资源 + 设 secret + 建表 + 部署
python setup_cloudflare.py --dry                    # 先看它要做什么
```

脚本会：建 D1 / R2 / KV → 把 id 写回 `wrangler.jsonc` → 生成并设置
`MASTER_SECRET` → 应用两个迁移 → 建 Pages 项目 → 部署 → 打印网址。

**手动做的话**：

```bash
# 1. 登录（会开浏览器，用 GitHub 账号授权最省事）
node node_modules/wrangler/bin/wrangler.js login

# 2. 创建资源，把返回的 id 填回 wrangler.jsonc
node node_modules/wrangler/bin/wrangler.js d1 create fcloud
node node_modules/wrangler/bin/wrangler.js r2 bucket create fcloud-blobs
node node_modules/wrangler/bin/wrangler.js kv namespace create RATE

# 3. 设主密钥的加密根（⚠️ 必做，丢了所有加密文件永久无法解开）
node node_modules/wrangler/bin/wrangler.js secret put MASTER_SECRET
#    输一串随机字符即可。生成：python -c "import secrets;print(secrets.token_urlsafe(48))"

# 4. 建表（两个迁移都要跑）
node node_modules/wrangler/bin/wrangler.js d1 execute fcloud \
  --file=./migrations/0001_init.sql --remote
node node_modules/wrangler/bin/wrangler.js d1 execute fcloud \
  --file=./migrations/0002_security.sql --remote

# 5. 部署
node node_modules/wrangler/bin/wrangler.js deploy
```

部署后拿到 **https://fcloud.pages.dev**。

> ⚠️ **为什么不用 workers.dev？**
> `*.workers.dev` 在国内被 **DNS 污染** —— 会解析到 Facebook 的 IP（31.13.x.x），
> 根本连不上。实测同一个网络下：
>
> | 域名 | 解析结果 | 可达 |
> |---|---|---|
> | `fcloud.fcloud-kaixin.workers.dev` | 31.13.86.21（Facebook） | ❌ |
> | `fcloud.pages.dev` | 104.18.21.135（Cloudflare） | ✅ |
>
> 所以主站跑在 **Pages** 上。想更快更稳的话，绑一个自己的域名（Pages 项目里绑）。

### 二、GitHub 自动部署

`.github/workflows/deploy.yml` 已经写好了。推 main 分支即自动部署。

要在仓库里配两个 Secret（Settings → Secrets and variables → Actions）：

| Secret | 说明 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |
| `CLOUDFLARE_API_TOKEN` | API Token |

API Token 的权限（Cloudflare 控制台 → My Profile → API Tokens → Create Token）：
- Account → Workers Scripts → **Edit**
- Account → D1 → **Edit**
- Account → Workers R2 Storage → **Edit**
- Account → Workers KV Storage → **Edit**

**不要**把 `MASTER_SECRET` 放进 GitHub Secret —— 它用 `wrangler secret put` 存在
Cloudflare 侧，不进仓库、不进 CI 日志。

**OpenRouter 的 API Key 也不在源码里**（公开仓库 + GitHub secret scanning 会拦）。
两个来源：设置界面里填（存 D1），或 `wrangler secret put FCLOUD_AI_KEY`。

> 另一条路：Cloudflare 控制台 → Workers → fcloud → Settings → Builds →
> Connect repository。效果一样，二选一即可。

### 三、首次使用

1. 打开 `https://fcloud.xxx.workers.dev`
2. 建管理员账号（这一步只有一次机会，初始化后 `/api/setup` 就关了）
3. 在 iPad 的 Safari 里打开 → 分享 → **添加到主屏幕** → 全屏 App

### R2 需要手动启用（一步）

Cloudflare 的 R2 **必须在控制台点一次启用**，API 调不了：

1. 打开 https://dash.cloudflare.com → 左侧 **Workers & Pages** → **R2**
2. 点「Enable R2」或「Purchase R2」
3. 按提示添加支付方式（信用卡或 PayPal）—— **免费额度内不会扣费**
   （10GB 存储 + 出口流量免费）
4. 启用后把 `wrangler.jsonc` 里 `r2_buckets` 那段取消注释，重新部署

没启用时：站点照常能用（管理、账号、加密、小f 都正常），
只是**上传/下载文件会返回 503** 并提示「文件存储还没启用」。

---

## 与 Python 版的关系

| | Python 版（Fcloud/） | Edge 版（FcloudEdge/） |
|---|---|---|
| 前端 | `web/` | **同一份代码，零改动** |
| 接口契约 | `/api/*` | **完全一致** |
| 数据库 | 本地 SQLite 文件 | D1 |
| 文件 | 本地磁盘 | R2 |
| 密码学 | `hashlib.scrypt` + `cryptography` | WebCrypto（PBKDF2 + AES-GCM） |
| 主密钥 | 进程内缓存 | **KEK 包装后存 D1**，KEK 来自 Cloudflare Secret |
| 解锁状态 | 进程内全局标志 | D1 的 master_sessions 表（带 TTL） |
| 小f | `assistant.py`（732 行） | `assistant.ts` + `routes/ai.ts`（16 个工具） |

### 数据迁移

`migrate_to_edge.py` 把 Python 版的 `data/`（SQLite + 文件块）导入 D1 + R2。

```bash
python migrate_to_edge.py --dry-run    # 先看要搬什么
python migrate_to_edge.py --remote     # 真搬
```

**搬不过去的（脚本会列清单）**：
- **加密文件** —— 两边的文件密钥包裹格式不同（Python 是 F0 + HMAC 流密码，
  Edge 是 F1 + AES-GCM），主密钥派生方式也不同。要手动重传。
- **成员密码** —— scrypt 哈希没法转成 PBKDF2 哈希（哈希不可逆）。
  脚本生成临时密码，登录后自己改。

迁移脚本本身有自测（`test_migrate.py`，20 项），造假数据跑一遍再核对 ——
迁移脚本是最容易在关键时刻出事的东西。

---

## 安全设计（2026-10-27 加固）

| 风险 | 处理 |
|---|---|
| **D1 泄露 = 全家加密文件裸奔** | 主密钥用 `MASTER_SECRET` 派生的 KEK 加密后才存 D1 |
| **PoC 端点被公开调用** | 生产默认关闭（要显式设 `ALLOW_POC=1` 才开） |
| **暴力破解** | 登录失败限流（KV 计数）+ AI/搜索/上传/打包各自限流 |
| **CSRF** | 写操作强制同源检查（Origin → Referer 回退） |
| **点击劫持 / XSS** | CSP + X-Frame-Options + nosniff + Permissions-Policy |
| **HTTPS 降级** | HSTS（只在 HTTPS 下发） |
| **撞库无痕迹** | security_log 表记登录失败、主口令解锁失败 |
| **口令验证被时序攻击** | 恒定时间比较（`equalBytes`） |

### 剩下的风险（必须诚实说）

**攻陷 Cloudflare 账号本身 = 拿到所有密钥。**
`MASTER_SECRET` 解密后明文注入 env，所以这层挡不住。
要真正挡住得做「客户端持钥」（浏览器里派生密钥，服务端只见密文），
那是另一个量级的改造。

现在能做的是把威胁模型从「D1 泄露就全完」变成
「要同时拿到 Cloudflare 账号 + D1 才全完」。

---

## 已验证 / 待验证

### 已验证（本地 miniflare，端到端 179 项 + 迁移自测 20 项，全过）

- SHA-256 / HMAC-SHA256 / AES-GCM 加解密往返、PBKDF2 21 万轮派生
- R2 存取 + D1 记账 + 内容寻址去重 + 引用计数
- 分片上传 / 断点续传 / Range 下载 / 中文文件名下载
- 端到端加密：加密 → 传 R2 → 读回 → 解密，内容一致
- 文件树 / 回收站 / 版本历史 / 回滚 / 成员权限 / 共享 / 操作记录
- **中文倒排索引**：中文子串能搜到（自建 bigram 索引，FTS5 的 trigram 不行）
- **手写流式 ZIP**：CRC32 + 数据描述符，EOCD 结构正确
- **小f 助手**：16 个工具、角色裁剪、SSE 流式、**真实联网调 OpenRouter 成功**
- **安全加固**：D1 里没有明文主密钥、安全响应头、CSRF 同源检查、限流
- **迁移脚本**：造假数据 → 迁移 → 逐项核对（含中文索引、含单引号的备注）

### 待验证（必须上线实测）

- ⚠️ **PBKDF2 21 万轮在 10ms CPU 限制下是否真的能过**（本地是 108ms 墙钟，
  但 WebCrypto 原生调用理论上不计入 CPU 配额）
- ⚠️ 大文件下载的子请求数（50/请求上限）
- ⚠️ 中文倒排索引的查询性能 vs D1 的按行计费
- ⚠️ 小f 助手的工具调用循环会不会超 CPU 限制
- ⚠️ Workers 免费版每天 10 万请求够不够一家人用

---

## 踩过的坑

### 架构 / 语言

1. **JS 正则不支持 Python 命名组**：`(?P<nid>...)` 会让整个 Worker 启动失败，
   报 `Invalid regular expression: Invalid group`。JS 是 `(?<nid>...)`。
   症状隐蔽 —— 表现为「服务起不来」，看不出是哪条路由。
2. **属性名和方法名不能同名**：`private key` 和 `key()` 同时存在，
   TS 会报 `Duplicate identifier`，而且 `this.key` 会被局部变量遮蔽。
3. **类型用 `type Env` 导入**：`Env` 是接口不是值，要 `import { type Env }`。
4. **Python 直译到 TS 的隐形错误**（编译能过，逻辑全错）：
   - `x in list` —— TS 里是「检查对象属性」，不是数组包含。
     `member.role in t.roles` 永远 false → 管理员只拿到 7 个只读工具。
     必须写 `t.roles.includes(member.role)`。
   - `x not in list` —— 语法直接报错（这个至少能发现）。
5. **flaky 断言**：逐字节比较随机盐（`s0.every((b,i) => b !== s1[i])`）
   要求每个字节都不同，1/256 概率误报。应该写「整体不相等」。

### D1

6. **外键永远开启且立即检查**，`PRAGMA foreign_keys=OFF` 会被**静默忽略**。
7. **循环外键**：`nodes.current_version_id → versions.id` 而
   `versions.node_id → nodes.id`。插的时候先置 NULL，插完再回填。
8. **`INSERT OR REPLACE` = 先删后插**，会触发 `ON DELETE CASCADE` 把别的表搞坏。
9. **单条语句绑定参数上限 100** —— 一行 N 列就是 N 个参数。
10. **没有 `lastrowid`** —— 用 `run().meta.last_row_id`。
11. **不支持 BEGIN/COMMIT** —— 用 `db.batch()`。

### Worker

12. **每个请求都是新 isolate**，进程内缓存不存在。「已解锁」这种状态必须落库。
13. **SSE 的 chunk 边界**：一个 chunk 可能含半行、也可能含十几行；
    且必须用 `TextDecoder(..., {stream:true})`，否则跨 chunk 的 UTF-8 边界会乱码。
14. **EventSource 只能 GET 带不了 body** —— 小f 的历史和图片在 body 里，
    只能用 fetch + ReadableStream 读 SSE 帧。

### 工具链

15. **`.wrangler/tmp` 残留会让 `d1 execute --local` 挂死**（无输出直到超时）。
    清理要删**整个** `.wrangler` 目录，不能只删 `.wrangler/state`。
16. **wrangler 输出解析**：前面有 `▲ [WARNING]` 的 `[`，
    JSON 后面还跟日志且带 ANSI 颜色码 → 必须用 `raw_decode` 而不是 `loads`。
17. **wrangler 3 → 4 提醒**：当前用 3.114.17，功能够用。
