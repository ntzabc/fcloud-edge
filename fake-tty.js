/**
 * 给 wrangler 造一个假 TTY。
 *
 * ## 为什么需要
 *
 * 部署到 workers.dev 前，wrangler 会问：
 *   "Would you like to register a workers.dev subdomain now?"
 * 这个 confirm() 在**非交互环境**下直接用 fallbackValue（false）跳过，
 * 于是部署失败并提示「请去控制台注册子域名」。
 *
 * 而注册子域名这件事：
 *   - 用 OAuth token 调 API → 报 10405（该端点不支持 OAuth）
 *   - 用 API Token 调 API  → 可以，但 token 得用户在控制台手工创建
 *
 * 所以这里伪造 `process.stdin.isTTY = true`，
 * 让 wrangler 走进交互分支，然后往 stdin 喂一个 "y"。
 *
 * 用法：
 *   printf 'y\n' | node -r ./fake-tty.js node_modules/wrangler/bin/wrangler.js deploy
 */

try {
  Object.defineProperty(process.stdin, "isTTY", {
    value: true, configurable: true, writable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: true, configurable: true, writable: true,
  });
} catch (e) {
  console.error("[fake-tty] 改不了 isTTY：", e.message);
}
