#!/usr/bin/env node
/**
 * 宿主端会话路径路由（lib/session-path.js）单元探针。
 *
 * 覆盖：注册路径、参数校验、同源/回环防护、stat+locate 解析、sessions 内存回退、
 *       未知会话 404、后端异常 500、HEAD 空响应体。
 *
 * 用法：node probe-host-route.mjs
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";

// 直接加载已安装插件里的宿主端路由模块（避免复制漂移）
const HOST_MODULE = join(
  process.env.DSH_ARCHIVE_MANAGER_DIR ??
    join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager"),
  "lib",
  "session-path.js"
);
const { registerSessionPathRoute, SESSION_PATH_ROUTE } = await import(pathToFileURL(HOST_MODULE).href);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: ok === true, detail });
}

function fakeResponse() {
  return {
    statusCode: void 0,
    rawBody: void 0,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
    },
    end(body) {
      this.ended = true;
      this.rawBody = body;
    }
  };
}
function fakeRequest({ method = "GET", url = SESSION_PATH_ROUTE + "?sessionId=abc", remoteAddress = "127.0.0.1", site = "same-origin" } = {}) {
  const headers = {};
  if (site !== void 0) headers["sec-fetch-site"] = site;
  return { method, url, socket: { remoteAddress }, headers };
}

function makeCtx({ persistence, sessions } = {}) {
  const registered = [];
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: {
      register(options) {
        registered.push(options);
        return () => {};
      }
    },
    get(name) {
      if (name === "sessionPersistence") return persistence;
      if (name === "sessions") return sessions;
      return void 0;
    }
  };
  return { ctx, registered };
}

const HEADER = { id: "sess-1", cwd: "C:\\example\\project" };
const okPersistence = {
  stat: async (id) => (id === "sess-1" ? { header: HEADER, revision: "r1" } : void 0),
  locate: (meta) => ({ kind: "jsonl", path: "C:\\dsh\\projects\\proj\\" + meta.id + ".jsonl" })
};

// 1. 注册
{
  const { ctx, registered } = makeCtx({ persistence: okPersistence });
  registerSessionPathRoute(ctx);
  check("注册一次 webServer 路由", registered.length === 1, String(registered.length));
  check("路由类型 exact", registered[0]?.kind === "exact", String(registered[0]?.kind));
  check("路由路径一致", registered[0]?.path === SESSION_PATH_ROUTE, String(registered[0]?.path));
  check("路由路径与 client 常量一致", SESSION_PATH_ROUTE === "/api/michengai/dsh-archive-manager/session-path", SESSION_PATH_ROUTE);
}

// 2. 正常解析
{
  const { ctx, registered } = makeCtx({ persistence: okPersistence });
  registerSessionPathRoute(ctx);
  const handler = registered[0].handler;
  const response = fakeResponse();
  await handler(fakeRequest({ url: SESSION_PATH_ROUTE + "?sessionId=sess-1" }), response);
  const payload = JSON.parse(response.rawBody);
  check("状态码 200", response.statusCode === 200, String(response.statusCode));
  check("返回文件路径", payload.path === "C:\\dsh\\projects\\proj\\sess-1.jsonl", String(payload.path));
  check("返回 cwd", payload.cwd === "C:\\example\\project", String(payload.cwd));
  check("返回工件类型", payload.kind === "jsonl", String(payload.kind));
  check("返回 sessionId", payload.sessionId === "sess-1", String(payload.sessionId));
}

// 3. 未知会话 → 404
{
  const { ctx, registered } = makeCtx({ persistence: okPersistence });
  registerSessionPathRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ url: SESSION_PATH_ROUTE + "?sessionId=missing" }), response);
  check("未知会话返回 404", response.statusCode === 404, String(response.statusCode));
}

// 4. 缺少 sessionId → 400
{
  const { ctx, registered } = makeCtx({ persistence: okPersistence });
  registerSessionPathRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ url: SESSION_PATH_ROUTE }), response);
  check("缺少 sessionId 返回 400", response.statusCode === 400, String(response.statusCode));
}

// 5. 方法限制 → 405
{
  const { ctx, registered } = makeCtx({ persistence: okPersistence });
  registerSessionPathRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ method: "POST" }), response);
  check("POST 返回 405", response.statusCode === 405, String(response.statusCode));
  check("405 带 allow 头", response.rawBody === void 0);
}

// 6. 非回环来源 → 403
{
  const { ctx, registered } = makeCtx({ persistence: okPersistence });
  registerSessionPathRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ remoteAddress: "203.0.113.20" }), response);
  check("非回环来源返回 403", response.statusCode === 403, String(response.statusCode));
}
{
  const { ctx, registered } = makeCtx({ persistence: okPersistence });
  registerSessionPathRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ site: "cross-site" }), response);
  check("跨站来源返回 403", response.statusCode === 403, String(response.statusCode));
}
{
  const { ctx, registered } = makeCtx({ persistence: okPersistence });
  registerSessionPathRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ remoteAddress: "::1", site: void 0, url: SESSION_PATH_ROUTE + "?sessionId=sess-1" }), response);
  check("IPv6 回环且无 sec-fetch-site 放行", response.statusCode === 200, String(response.statusCode));
}

// 7. 无 sessionPersistence 时回退运行中会话
{
  const sessions = { list: () => [{ id: "live-1", header: { id: "live-1", cwd: "C:\\w" } }] };
  const { ctx, registered } = makeCtx({ persistence: void 0, sessions });
  registerSessionPathRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ url: SESSION_PATH_ROUTE + "?sessionId=live-1" }), response);
  const payload = JSON.parse(response.rawBody);
  check("无 persistence 时回退内存会话", response.statusCode === 200, String(response.statusCode));
  check("回退时 path 为 null 但 cwd 可用", payload.path === null && payload.cwd === "C:\\w", JSON.stringify(payload));
}
{
  const sessions = { list: () => [{ id: "live-1", header: { id: "live-1", cwd: "C:\\w" } }] };
  const persistence = {
    stat: async () => void 0,
    locate: (meta) => ({ kind: "jsonl", path: "C:\\p\\" + meta.id + ".jsonl" })
  };
  const { ctx, registered } = makeCtx({ persistence, sessions });
  registerSessionPathRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ url: SESSION_PATH_ROUTE + "?sessionId=live-1" }), response);
  const payload = JSON.parse(response.rawBody);
  check("stat 未命中时回退内存会话并 locate", payload.path === "C:\\p\\live-1.jsonl", JSON.stringify(payload));
}

// 8. 后端异常 → 500
{
  const persistence = { stat: async () => { throw new Error("boom"); }, locate: () => ({}) };
  const { ctx, registered } = makeCtx({ persistence });
  registerSessionPathRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest(), response);
  check("后端异常返回 500", response.statusCode === 500, String(response.statusCode));
}

// 9. HEAD → 200 且无 body
{
  const { ctx, registered } = makeCtx({ persistence: okPersistence });
  registerSessionPathRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ method: "HEAD", url: SESSION_PATH_ROUTE + "?sessionId=sess-1" }), response);
  check("HEAD 返回 200", response.statusCode === 200, String(response.statusCode));
  check("HEAD 无响应体", response.rawBody === void 0, String(response.rawBody));
}

let failed = 0;
const lines = results.map((item) => {
  if (item.ok !== true) failed += 1;
  return `  ${item.ok === true ? "PASS" : "FAIL"}  ${item.name}${item.detail === "" ? "" : `  → ${item.detail}`}`;
});
console.log("\n[宿主端会话路径路由]\n" + lines.join("\n"));
console.log(`\n合计：${results.length} 项断言，失败 ${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
