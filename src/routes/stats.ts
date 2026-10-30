/**
 * 统计路由：GET /api/stats、GET /api/home
 */

import { json } from "../index";
import { need } from "../http";
import { byCategory, byMember, recent, starred, trashList } from "../files";
import { canRead, logStats, sharedWithMe } from "../sharing";
import { indexStats } from "../search";
import { space } from "../members";
import { storageStats } from "../storage";
import { myUploads } from "../transfer";
import { cryptoStatus } from "./cryptoroute";
import type { Ctx } from "../http";

const SPACE_ID = 1;

export async function stats(ctx: Ctx): Promise<Response> {
  await need(ctx);
  const sp = Number(ctx.url.searchParams.get("space") || SPACE_ID);
  return json({
    storage: await storageStats(ctx.env),
    index: await indexStats(ctx.env),
    by_category: await byCategory(ctx.env, sp),
    by_member: await byMember(ctx.env, sp),
    space: await space(ctx.env.DB, sp),
    recent: await recent(ctx.env, sp, 10),
    starred: await starred(ctx.env, sp),
    audit: await logStats(ctx.env, sp, 7),
    crypto: await cryptoStatus(ctx),
  });
}

export async function home(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  const sp = Number(ctx.url.searchParams.get("space") || SPACE_ID);
  const st = await storageStats(ctx.env);

  const recentList = [];
  for (const n of await recent(ctx.env, sp, 8)) {
    if (await canRead(ctx.env, n, m)) recentList.push(n);
  }

  return json({
    space: await space(ctx.env.DB, sp),
    recent: recentList,
    by_category: await byCategory(ctx.env, sp),
    storage: {
      logical_bytes: st.logical_bytes ?? 0,
      physical_bytes: st.physical_bytes ?? 0,
      dedup_saved: st.dedup_saved ?? 0,
      dedup_ratio: st.dedup_ratio ?? 1,
      files: st.files ?? 0,
      trash_files: st.trash_files ?? 0,
    },
    trash: (await trashList(ctx.env, sp, 999)).length,
    shared_for_me: (await sharedWithMe(ctx.env, m, sp)).length,
    uploads: await myUploads(ctx.env, m),
  });
}
