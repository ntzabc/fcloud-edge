/**
 * 小f 的 HTTP 层。
 *
 * ## 为什么用 SSE 而不是普通 JSON
 *
 * 一次「模型 → 工具 → 模型」要几十秒，不流式的话前端只能对着转圈。
 *
 * ## ⚠️ 一个必须记住的坑
 *
 * **EventSource 只能 GET，不能带 body。**
 * 而小f 的请求体里有历史消息和图片 id —— 必须 POST。
 * 所以前端不能用 EventSource，得用 fetch + ReadableStream 自己读 SSE 帧。
 * （WebSocket 也没必要 —— 只有服务端→前端单向。）
 */

import { json } from "../index";
import { jsonBody, need } from "../http";
import { require } from "../members";
import { log } from "../sharing";
import { ApiError } from "../types";
import * as assistant from "../assistant";
import type { Ctx } from "../http";

/** AI 状态。 */
export async function aiStatus(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  const st = await assistant.status(ctx.env);
  // can_write 必须和 toolsFor(m) 的实际裁剪结果一致，不能另算一套。
  // 之前写成 m.can("upload")，但儿童在成员表里是有 upload 权限的，
  // 于是前端显示「可读可改」，实际一个写工具都拿不到 —— 前后端各说各话。
  const specs = assistant.toolsFor(m);
  const names = specs.map((s: any) => s.function.name);
  const st2 = st as Record<string, unknown>;
  st2["tools_for_me"] = names;
  st2["can_write"] = names.some((n: string) =>
    (assistant.TOOLS[n] as any)?.write);
  st2["role"] = m.role;
  return json(st2);
}

/** 改 API Key（reset=true 表示恢复内置 Key）。 */
export async function aiSetKey(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  require(m, "manage_space");
  const d = await jsonBody<{ key?: string; reset?: boolean }>(ctx.req);
  const st = d.reset
    ? await assistant.resetKey(ctx.env)
    : await assistant.setKey(ctx.env, d.key || "");
  await log(ctx.env, m, "space_edit", {
    detail: { ai_key: d.reset ? "reset" : "set" }, ip: ctx.ip,
  });
  return json(st);
}

/** 切模型。 */
export async function aiSetModel(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  const d = await jsonBody<{ model?: string }>(ctx.req);
  const st = await assistant.setModel(ctx.env, d.model || "");
  await log(ctx.env, m, "space_edit", {
    detail: { ai_model: (st as Record<string, unknown>)["model"] }, ip: ctx.ip,
  });
  return json(st);
}

/** 小f 对话（SSE）。 */
export async function aiChat(ctx: Ctx): Promise<Response> {
  const m = await need(ctx);
  const d = await jsonBody<{
    message?: string; history?: unknown; images?: unknown; model?: string;
  }>(ctx.req);

  const message = String(d.message || "").trim();
  let history: assistant.ChatMessage[] = [];
  if (Array.isArray(d.history)) {
    history = d.history
      .filter((x): x is Record<string, unknown> =>
        !!x && typeof x === "object" && !Array.isArray(x))
      .map((x) => ({ role: String(x["role"] || "user"), content: x["content"] }))
      .slice(-40);
  }
  const imgs: number[] = [];
  if (Array.isArray(d.images)) {
    for (const v of d.images.slice(0, 3)) {
      const n = Number(v);
      if (Number.isFinite(n)) imgs.push(n);
    }
  }
  // 光发图不说话是合法的（前端就是这么做的），只要有内容就别拦。
  if (!message && !imgs.length) throw new ApiError("说点什么，或者附一张图");

  const encoder = new TextEncoder();
  const toolCtx = { env: ctx.env, master: ctx.master, member: m };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: string, data: unknown) => {
        const payload = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };
      try {
        for await (const e of assistant.chatStream(
          toolCtx, history, message, imgs, d.model,
        )) {
          send(e.event, e.data);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[小f] 出错：", e);
        try {
          send("error", { error: `小f 出了点问题：${msg}` });
        } catch { /* 客户端已断开 */ }
      } finally {
        try {
          await log(ctx.env, m, "ai_chat", {
            detail: { chars: message.length, images: imgs.length }, ip: ctx.ip,
          });
        } catch { /* ignore */ }
        try { controller.close(); } catch { /* ignore */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
