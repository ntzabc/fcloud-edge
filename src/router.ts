/**
 * 路由表。
 *
 * 路由契约跟 Python 版**完全一致** —— 前端 web/ 一个字都不用改。
 * 这是这次移植最重要的一条：前端是原生 JS 无构建，接口契约不变就零改动。
 */

import { json } from "./index";
import { Ctx, whoami, clientIp, checkSameOrigin } from "./http";
import { MasterKey } from "./crypto";
import { poc } from "./poc";
import { hit, type LimitKind } from "./ratelimit";
import type { Env } from "./types";

type Handler = (ctx: Ctx) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  /** 限流类别（不填 = 不限）。 */
  limit?: LimitKind;
}

const routes: Route[] = [];

function add(
  method: string, pattern: string, handler: Handler,
  limit?: LimitKind,
): void {
  // /api/node/<nid> → /api/node/([^/]+)
  // 注意：JS 正则的命名组是 (?<nid>...)，不是 Python 的 (?P<nid>...)。
  // 写成 Python 语法会抛 "Invalid regular expression: Invalid group"，
  // 而且是 Worker 启动时才炸 —— 表现为「服务起不来」，看不到具体哪条路由。
  const rx = new RegExp("^" + pattern.replace(/<(\w+)>/g, "(?<$1>[^/]+)") + "$");
  routes.push({ method, pattern: rx, handler, limit });
}

// ---- 健康检查 & 引导 ----
add("GET", "/api/health", async (c) => {
  return json({
    ok: true,
    app: c.env.APP_NAME,
    edge: true,
    time: Date.now() / 1000,
  });
});

add("GET", "/api/bootstrap", async (c) => {
  const { bootstrap } = await import("./routes/auth");
  return await bootstrap(c);
});

add("POST", "/api/setup", async (c) => {
  const { setup } = await import("./routes/auth");
  return await setup(c);
});

add("POST", "/api/login", async (c) => {
  const { login } = await import("./routes/auth");
  return await login(c);
});

add("POST", "/api/logout", async (c) => {
  const { logout } = await import("./routes/auth");
  return await logout(c);
});

add("GET", "/api/me", async (c) => {
  const { me } = await import("./routes/auth");
  return await me(c);
});

// ---- PoC（验证方案 B 的三个关键假设用）----
//
// ⚠️ 生产环境**默认关闭** —— 只有显式设了 ALLOW_POC 才开。
// 原因：PoC 会往 R2/D1 写测试数据、跑 PBKDF2、暴露内部结构，
// 是个可以被用来消耗配额和 CPU 的公开端点。
// 本地开发在 .dev.vars 里设 ALLOW_POC=1。
add("GET", "/api/poc", async (c) => {
  if (c.env.ALLOW_POC !== "1") {
    return json({ error: "这个接口没有开放" }, 404);
  }
  return await poc(c.req, c.env);
});

// ---- 文件 ----
add("GET", "/api/files", async (c) => {
  const { listFiles } = await import("./routes/files");
  return await listFiles(c);
});
add("POST", "/api/folder", async (c) => {
  const { createFolder } = await import("./routes/files");
  return await createFolder(c);
});
add("PATCH", "/api/node/<nid>", async (c) => {
  const { patchNode } = await import("./routes/files");
  return await patchNode(c, Number(c.params.nid));
});
add("DELETE", "/api/node/<nid>", async (c) => {
  const { deleteNode } = await import("./routes/files");
  return await deleteNode(c, Number(c.params.nid));
});
add("POST", "/api/node/<nid>/restore", async (c) => {
  const { restoreNode } = await import("./routes/files");
  return await restoreNode(c, Number(c.params.nid));
});
add("GET", "/api/node/<nid>/versions", async (c) => {
  const { versions } = await import("./routes/files");
  return await versions(c, Number(c.params.nid));
});
add("POST", "/api/node/<nid>/rollback", async (c) => {
  const { rollback } = await import("./routes/files");
  return await rollback(c, Number(c.params.nid));
});
add("GET", "/api/node/<nid>/preview", async (c) => {
  const { preview } = await import("./routes/files");
  return await preview(c, Number(c.params.nid));
});

// ---- 回收站 ----
add("GET", "/api/trash", async (c) => {
  const { trashList } = await import("./routes/files");
  return await trashList(c);
});
add("POST", "/api/trash/empty", async (c) => {
  const { emptyTrashRoute } = await import("./routes/files");
  return await emptyTrashRoute(c);
});

// ---- 上传 ----
add("POST", "/api/upload/init", async (c) => {
  const { uploadInit } = await import("./routes/upload");
  return await uploadInit(c);
}, "upload");
add("GET", "/api/upload/<uid>", async (c) => {
  const { uploadStatus } = await import("./routes/upload");
  return await uploadStatus(c, c.params.uid);
});
add("PUT", "/api/upload/<uid>/part/<seq>", async (c) => {
  const { uploadPart } = await import("./routes/upload");
  return await uploadPart(c, c.params.uid, Number(c.params.seq));
});
add("POST", "/api/upload/<uid>/finish", async (c) => {
  const { uploadFinish } = await import("./routes/upload");
  return await uploadFinish(c, c.params.uid);
});
add("DELETE", "/api/upload/<uid>", async (c) => {
  const { uploadAbort } = await import("./routes/upload");
  return await uploadAbort(c, c.params.uid);
});
add("GET", "/api/uploads", async (c) => {
  const { myUploadsRoute } = await import("./routes/upload");
  return await myUploadsRoute(c);
});

// ---- 下载 ----
add("GET", "/api/file/<nid>", async (c) => {
  const { download } = await import("./routes/download");
  return await download(c, Number(c.params.nid));
});

// ---- 打包下载 / 空间设置 ----
add("GET", "/api/zip", async (c) => {
  const { zip } = await import("./routes/zip");
  return await zip(c);
}, "zip");
add("POST", "/api/space", async (c) => {
  const { spaceSettings } = await import("./routes/zip");
  return await spaceSettings(c);
});

// ---- 搜索 ----
add("GET", "/api/search", async (c) => {
  const { search } = await import("./routes/search");
  return await search(c);
}, "search");
add("GET", "/api/suggest", async (c) => {
  const { suggest } = await import("./routes/search");
  return await suggest(c);
}, "search");

// ---- 回收站 / 统计 / 首页 ----
add("GET", "/api/stats", async (c) => {
  const { stats } = await import("./routes/stats");
  return await stats(c);
});
add("GET", "/api/home", async (c) => {
  const { home } = await import("./routes/stats");
  return await home(c);
});

// ---- 成员 ----
add("GET", "/api/members", async (c) => {
  const { members } = await import("./routes/members");
  return await members(c);
});
add("POST", "/api/members", async (c) => {
  const { addMember } = await import("./routes/members");
  return await addMember(c);
});
add("PATCH", "/api/member/<mid>", async (c) => {
  const { patchMember } = await import("./routes/members");
  return await patchMember(c, Number(c.params.mid));
});
add("DELETE", "/api/member/<mid>", async (c) => {
  const { deleteMemberRoute } = await import("./routes/members");
  return await deleteMemberRoute(c, Number(c.params.mid));
});

// ---- 共享 ----
add("GET", "/api/node/<nid>/shares", async (c) => {
  const { nodeShares } = await import("./routes/sharing");
  return await nodeShares(c, Number(c.params.nid));
});
add("POST", "/api/node/<nid>/share", async (c) => {
  const { shareNode } = await import("./routes/sharing");
  return await shareNode(c, Number(c.params.nid));
});
add("DELETE", "/api/node/<nid>/share/<gid>", async (c) => {
  const { unshareNode } = await import("./routes/sharing");
  return await unshareNode(c, Number(c.params.nid), Number(c.params.gid));
});
add("GET", "/api/shared", async (c) => {
  const { sharedWithMeRoute } = await import("./routes/sharing");
  return await sharedWithMeRoute(c);
});

// ---- 审计 ----
add("GET", "/api/audit", async (c) => {
  const { auditLog } = await import("./routes/sharing");
  return await auditLog(c);
});

// ---- 加密 ----
add("POST", "/api/crypto/setup", async (c) => {
  const { cryptoSetup } = await import("./routes/cryptoroute");
  return await cryptoSetup(c);
});
add("POST", "/api/crypto/unlock", async (c) => {
  const { cryptoUnlock } = await import("./routes/cryptoroute");
  return await cryptoUnlock(c);
});
add("GET", "/api/crypto/status", async (c) => {
  const { cryptoStatusRoute } = await import("./routes/cryptoroute");
  return await cryptoStatusRoute(c);
});

// ---- 备份 ----
add("POST", "/api/backup", async (c) => {
  const { backupNow } = await import("./routes/backup");
  return await backupNow(c);
});
add("GET", "/api/backup", async (c) => {
  const { backupList } = await import("./routes/backup");
  return await backupList(c);
});
add("POST", "/api/backup/restore", async (c) => {
  const { backupRestore } = await import("./routes/backup");
  return await backupRestore(c);
});

// ---- GC ----
add("POST", "/api/gc", async (c) => {
  const { runGc } = await import("./routes/maintenance");
  return await runGc(c);
});

// ---- 小f ----
add("GET", "/api/ai/status", async (c) => {
  const { aiStatus } = await import("./routes/ai");
  return await aiStatus(c);
});
add("POST", "/api/ai/key", async (c) => {
  const { aiSetKey } = await import("./routes/ai");
  return await aiSetKey(c);
});
add("POST", "/api/ai/model", async (c) => {
  const { aiSetModel } = await import("./routes/ai");
  return await aiSetModel(c);
});
add("POST", "/api/ai/chat", async (c) => {
  const { aiChat } = await import("./routes/ai");
  return await aiChat(c);
}, "ai");

// ---- 分发 ----
export async function route(
  req: Request, env: Env, _ctx: ExecutionContext, url: URL,
): Promise<Response> {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    // CSRF：写操作必须同源
    checkSameOrigin(req, url);
    const c: Ctx = {
      env, req, url,
      ip: clientIp(req),
      member: await whoami(env, req),
      master: new MasterKey(env),
      params: (m.groups ?? {}) as Record<string, string>,
    };
    // 限流：按「成员优先、没登录就按 IP」计
    if (r.limit) {
      const who = c.member ? `m${c.member.id}` : `ip${c.ip}`;
      if (!(await hit(env, r.limit, who))) {
        return json({ error: "操作太频繁了，歇一会儿再试" }, 429);
      }
    }
    return await r.handler(c);
  }
  return json({ error: "接口不存在" }, 404);
}
