/**
 * 流式 ZIP 打包 —— 纯手写，零依赖。
 *
 * Worker 里没有 zipfile，也装不了第三方库（3MB 脚本限制 + 无 node_modules）。
 * 所以这里手写 ZIP 格式。
 *
 * ## 为什么用 STORE 而不是 DEFLATE
 *   DEFLATE 要压缩算法（pako 之类的库几十 KB，而且压缩是纯 JS，
 *   在 10ms CPU 限制下必然超时）。
 *   STORE 不压缩，只是把文件原样塞进去 —— 但对家庭云盘完全够用：
 *   用户要的是「一个文件下载下来」，不是「体积最小」。
 *
 * ## 为什么用数据描述符（flag bit 3）
 *   标准 ZIP 的 local header 里带着 CRC32 和文件大小。
 *   但流式输出时，CRC 只有把整个文件读完才知道。
 *   flag bit 3 就是解决这个的：local header 里先不写 CRC 和大小，
 *   在文件数据后面补一个「数据描述符」。
 *   所有主流解压器（Windows 资源管理器、macOS 归档工具、7-Zip）都认。
 *
 * ## 内存
 *   全程流式，任何时刻内存里只有一个块（4MB）+ 少量缓冲。
 *   10GB 的文件夹也不会把内存撑爆。
 */

import { ApiError, type Env, type MasterLike } from "./types";
import { plainStream } from "./blobstore";
import { children, requireNode } from "./files";
import { canRead } from "./sharing";
import type { Member } from "./types";

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC32（增量）。 */
export class Crc32 {
  private crc = 0xFFFFFFFF;
  update(data: Uint8Array): void {
    let c = this.crc;
    for (let i = 0; i < data.length; i++) {
      c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    }
    this.crc = c;
  }
  value(): number {
    return (this.crc ^ 0xFFFFFFFF) >>> 0;
  }
}

// ---------------------------------------------------------------- 字节工具

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([
    n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF,
  ]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** UTF-8 文件名。ZIP 的通用标记位 0x800 表示文件名是 UTF-8。 */
const FLAG_UTF8 = 0x0800;
/** bit 3 = 数据描述符在文件数据后面。 */
const FLAG_DESCRIPTOR = 0x0008;

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5)
    | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5)
    | (d.getDate() & 31);
  return { time, date };
}

// ---------------------------------------------------------------- 打包计划

export interface ZipEntry {
  /** 压缩包内路径。 */
  arc: string;
  /** 节点 id（文件夹没有版本）。 */
  nodeId: number;
  /** 版本 id（文件才有）。 */
  versionId: number | null;
  isFolder: boolean;
  /** 未压缩大小。 */
  size: number;
  mtime: number;
}

/**
 * 收集要打包的节点（文件夹会递归展开）。
 *
 * 注意 can_read 过滤 —— 不能把用户看不到的文件偷偷塞进压缩包。
 */
export async function planZip(
  env: Env, nodeIds: number[], member: Member,
): Promise<ZipEntry[]> {
  const plan: ZipEntry[] = [];
  const collect = async (nodeId: number, prefix: string): Promise<void> => {
    const node = await requireNode(env, nodeId);
    if (!(await canRead(env, node, member))) return;
    plan.push({
      arc: prefix,
      nodeId: node.id,
      versionId: node.current_version_id,
      isFolder: node.kind === "folder",
      size: node.size,
      mtime: node.modified_at,
    });
    if (node.kind === "folder") {
      for (const c of await children(env, node.space_id, node.id)) {
        await collect(c.id, `${prefix}/${c.name}`);
      }
    }
  };
  for (const nid of nodeIds) {
    const node = await requireNode(env, nid);
    if (node.kind === "folder") {
      await collect(nid, node.name);
    } else {
      if (!(await canRead(env, node, member))) continue;
      plan.push({
        arc: node.name,
        nodeId: node.id,
        versionId: node.current_version_id,
        isFolder: false,
        size: node.size,
        mtime: node.modified_at,
      });
    }
  }
  return plan;
}

/** 压缩包文件名。 */
export function zipFilename(nodeIds: number[], names: string[]): string {
  if (nodeIds.length === 1 && names[0]) {
    const base = names[0];
    return base.endsWith(".zip") ? base : base + ".zip";
  }
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `Fcloud-${stamp}.zip`;
}

/**
 * 生成 ZIP 字节流。
 *
 * 返回 ReadableStream —— 直接当 HTTP 响应体，不在内存里拼整个包。
 */
export async function zipStream(
  env: Env, master: MasterLike, plan: ZipEntry[],
): Promise<ReadableStream<Uint8Array>> {
  // 中央目录的条目要先知道，所以要一边写一边收集
  const central: {
    name: Uint8Array; crc: number; size: number; offset: number;
    time: number; date: number;
  }[] = [];
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // 本次 pull 逐条产出，直到没有更多条目
      while (true) {
        if (plan.length === 0) {
          // 写中央目录 + EOCD
          const cdStart = offset;
          const cdChunks: Uint8Array[] = [];
          for (const e of central) {
            const head = concat(
              u32(0x02014B50), u16(20), u16(20), u16(FLAG_UTF8 | FLAG_DESCRIPTOR),
              u16(0), u16(e.time), u16(e.date), u32(e.crc), u32(e.size), u32(e.size),
              u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset),
            );
            cdChunks.push(head, e.name);
          }
          let cdSize = 0;
          for (const c of cdChunks) cdSize += c.length;
          const eocd = concat(
            u32(0x06054B50), u16(0), u16(0), u16(central.length), u16(central.length),
            u32(cdSize), u32(cdStart), u16(0),
          );
          controller.enqueue(concat(...cdChunks));
          controller.enqueue(eocd);
          controller.close();
          return;
        }

        const e = plan.shift()!;
        const nameBytes = new TextEncoder().encode(e.arc);
        const { time, date } = dosDateTime(new Date(e.mtime * 1000));

        if (e.isFolder || e.versionId === null) {
          // 目录条目：方法 0，内容为空
          const head = concat(
            u32(0x04034B50), u16(20), u16(FLAG_UTF8), u16(0), u16(time), u16(date),
            u32(0), u32(0), u32(0), u16(nameBytes.length), u16(0), nameBytes,
          );
          offset += head.length;
          central.push({
            name: nameBytes, crc: 0, size: 0, offset, time, date,
          });
          controller.enqueue(head);
          continue;
        }

        // 文件条目
        const head = concat(
          u32(0x04034B50), u16(20), u16(FLAG_UTF8 | FLAG_DESCRIPTOR), u16(0),
          u16(time), u16(date), u32(0), u32(0), u32(0),
          u16(nameBytes.length), u16(0), nameBytes,
        );
        offset += head.length;
        const entryOffset = offset;

        const crc = new Crc32();
        let size = 0;
        const stream = await plainStream(env, master, e.versionId);
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          crc.update(value);
          size += value.length;
          offset += value.length;
          controller.enqueue(value);
        }
        // 数据描述符：没有签名的那版（4 字节 CRC + 4 字节压缩大小 + 4 字节原始大小）
        const desc = concat(u32(crc.value()), u32(size), u32(size));
        offset += desc.length;
        controller.enqueue(desc);
        central.push({ name: nameBytes, crc: crc.value(), size, offset: entryOffset, time, date });
      }
    },
  });
}

/** 校验用的空实现占位（避免未使用告警）。 */
export function assertZipOk(plan: ZipEntry[]): void {
  if (!plan.length) throw new ApiError("没有可打包的内容");
}
