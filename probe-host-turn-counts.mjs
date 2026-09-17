#!/usr/bin/env node
/**
 * 宿主端第二轮增强探针：
 *   1. lib/index.js 可加载且导出 apply/inject（含 plugin-updater / session-path / turn-counts 三条 import 链）；
 *   2. lib/turn-counts.js 的轮次统计口径（与官方 sessionStats 一致）与路由行为。
 *
 * 用法：node probe-host-turn-counts.mjs
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// 隔离磁盘缓存：避免上一次探针运行写入的缓存污染「是否重新读日志」的断言
const probeCacheDir = join(tmpdir(), `dsh-archive-digest-probe-${Date.now()}`);
process.env.DSH_ARCHIVE_MANAGER_CACHE_DIR = probeCacheDir;

const PLUGIN_DIR = process.env.DSH_ARCHIVE_MANAGER_DIR ??
  join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager");
const load = (file) => import(pathToFileURL(join(PLUGIN_DIR, "lib", file)).href);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: ok === true, detail });
}
function section(title) {
  results.push({ section: title });
}

// ---------- 1. 插件入口可加载 ----------
section("插件入口加载");
let index;
let indexError;
try {
  index = await load("index.js");
} catch (error) {
  indexError = error;
}
check("lib/index.js 加载无异常", indexError === void 0, indexError === void 0 ? "" : String(indexError));
check("导出 apply", typeof index?.apply === "function");
check("导出 inject", Array.isArray(index?.inject) && index.inject.includes("webServer"), JSON.stringify(index?.inject));

// ---------- 2. 轮次口径 ----------
const { countTurns, summarizeTodos, analyzeEvents, registerTurnCountRoute, TURN_COUNTS_ROUTE, SESSION_DIGEST_ROUTE, CACHE_FILE } = await load("turn-counts.js");
section("轮次统计口径（对齐 sessionStats）");
check("空日志 = 0 轮", countTurns([]) === 0, String(countTurns([])));
check("undefined 容错", countTurns(void 0) === 0, String(countTurns(void 0)));
check(
  "同一 turn 的多个 step/end 只算一轮",
  countTurns([
    { type: "step/start", data: { turn: 0, step: 0 } },
    { type: "step/end", data: { turn: 0, step: 0 } },
    { type: "step/end", data: { turn: 0, step: 1 } },
    { type: "step/end", data: { turn: 1, step: 0 } }
  ]) === 2,
  String(countTurns([
    { type: "step/end", data: { turn: 0, step: 0 } },
    { type: "step/end", data: { turn: 0, step: 1 } },
    { type: "step/end", data: { turn: 1, step: 0 } }
  ]))
);
check(
  "非 step/end 事件不计入",
  countTurns([
    { type: "user/message", data: { turn: 0 } },
    { type: "assistant/message", data: { turn: 0 } },
    { type: "turn/end", data: { turn: 0 } }
  ]) === 0
);
check(
  "连续 turn 递增计数",
  countTurns([
    { type: "step/end", data: { turn: 0 } },
    { type: "step/end", data: { turn: 1 } },
    { type: "step/end", data: { turn: 2 } }
  ]) === 3
);

// ---------- 3. 路由行为 ----------
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
function fakeRequest({ method = "GET", url = TURN_COUNTS_ROUTE, remoteAddress = "127.0.0.1", site = "same-origin" } = {}) {
  const headers = {};
  if (site !== void 0) headers["sec-fetch-site"] = site;
  return { method, url, socket: { remoteAddress }, headers };
}

const EVENTS = {
  s1: [
    { type: "step/end", data: { turn: 0 } },
    { type: "todo/write", data: { todos: [{ content: "旧任务", status: "completed" }] } },
    { type: "step/end", data: { turn: 1 } },
    {
      type: "todo/write",
      data: {
        todos: [
          { content: "读取插件源码", status: "completed" },
          { content: "修复补丁锚点", status: "in_progress" },
          { content: "跑探针回归", status: "pending" }
        ]
      }
    }
  ],
  s2: [{ type: "step/end", data: { turn: 0 } }],
  s3: []
};
let readCount = 0;
const persistence = {
  stat: async (id) => (id === "missing" ? void 0 : { header: { id, cwd: "C:\\w" }, revision: "rev-1" }),
  readFrom: async (id) => {
    readCount += 1;
    return { meta: { id, cwd: "C:\\w" }, inheritedEventCount: 0, events: EVENTS[id] ?? [] };
  }
};
function makeCtx(options = {}) {
  const registered = [];
  const selected = options.noPersistence === true ? void 0 : (options.persistence ?? persistence);
  return {
    registered,
    ctx: {
      logger: { warn() {}, info() {}, error() {} },
      webServer: {
        register(routeOptions) {
          registered.push(routeOptions);
          return () => {};
        }
      },
      get(name) {
        if (name === "sessionPersistence") return selected;
        if (name === "workspace") return options.registry;
        return void 0;
      }
    }
  };
}

section("路由注册与常量");
{
  const { ctx, registered } = makeCtx();
  registerTurnCountRoute(ctx);
  check("注册两条路由（轮次 + 摘要别名）", registered.length === 2, String(registered.length));
  check("两条路由均为 exact", registered.every((route) => route.kind === "exact"), JSON.stringify(registered.map((route) => route.kind)));
  check(
    "路由路径覆盖两个端点",
    registered.map((route) => route.path).join(",") === `${TURN_COUNTS_ROUTE},${SESSION_DIGEST_ROUTE}`,
    registered.map((route) => route.path).join(",")
  );
  check("两条路由共用同一 handler", registered[0]?.handler === registered[1]?.handler);
  check("轮次路由路径与 client 常量一致", TURN_COUNTS_ROUTE === "/api/michengai/dsh-archive-manager/archived-turn-counts", TURN_COUNTS_ROUTE);
  check("摘要路由路径正确", SESSION_DIGEST_ROUTE === "/api/michengai/dsh-archive-manager/session-digest", SESSION_DIGEST_ROUTE);
  check(
    "缓存文件默认位于 ~/.dsh/data，且可用环境变量隔离",
    CACHE_FILE.endsWith("turn-counts.json") && CACHE_FILE === join(process.env.DSH_ARCHIVE_MANAGER_CACHE_DIR, "turn-counts.json"),
    CACHE_FILE
  );
  check(
    "默认缓存目录（未设置环境变量时）在 ~/.dsh/data 下",
    join(homedir(), ".dsh", "data", "dsh-archive-manager-fav", "turn-counts.json").includes(join(".dsh", "data"))
  );
}

section("todo 摘要归纳（零模型调用）");
const todoFixture = [
  { content: "读取插件源码", status: "completed" },
  { content: "修复补丁锚点", status: "in_progress" },
  { content: "跑探针回归", status: "pending" }
];
check("无 todo 记录返回 null", summarizeTodos(void 0) === null && summarizeTodos([]) === null);
const summary = summarizeTodos(todoFixture);
check(
  "计数与首项：优先 in_progress",
  summary.total === 3 && summary.done === 1 && summary.doing === 1 && summary.pending === 1 &&
    summary.firstOpen === "修复补丁锚点" && summary.lastDone === "读取插件源码",
  JSON.stringify(summary)
);
check(
  "摘要只保留统计字段（对话摘要功能已取消，不再返回 items）",
  summary.items === void 0 && summary.truncated === void 0,
  Object.keys(summary).join(",")
);
check(
  "全为待办时取首项",
  summarizeTodos([{ content: "甲", status: "pending" }, { content: "乙", status: "pending" }]).firstOpen === "甲"
);
check(
  "全部完成时回退最后一个已完成项",
  summarizeTodos([{ content: "甲", status: "completed" }, { content: "乙", status: "completed" }]).firstOpen === "乙"
);
check(
  "非法条目不影响首项选取",
  summarizeTodos([null, { content: "", status: "pending" }, { content: "有效", status: "pending" }]).firstOpen === "有效"
);
const analyzed = analyzeEvents(EVENTS.s1);
check("analyzeEvents 同时给出轮次与 todo", analyzed.turnCount === 2 && analyzed.todo.total === 3, JSON.stringify(analyzed));
check("analyzeEvents 取最后一次 todo/write", analyzed.todo.firstOpen === "修复补丁锚点", String(analyzed.todo.firstOpen));
check("analyzeEvents 无 todo 时返回 null", analyzeEvents(EVENTS.s2).todo === null, JSON.stringify(analyzeEvents(EVENTS.s2)));

section("路由行为");
{
  const { ctx, registered } = makeCtx();
  registerTurnCountRoute(ctx);
  const handler = registered[0].handler;
  const response = fakeResponse();
  await handler(fakeRequest({ url: TURN_COUNTS_ROUTE + "?sessionIds=s1,s2" }), response);
  const payload = JSON.parse(response.rawBody);
  const counts = Object.fromEntries(payload.items.map((item) => [item.sessionId, item.turnCount]));
  check("状态码 200", response.statusCode === 200, String(response.statusCode));
  check("s1 = 2 轮", counts.s1 === 2, String(counts.s1));
  check("s2 = 1 轮", counts.s2 === 1, String(counts.s2));
  check("空日志会话返回 0 轮", payload.items.every((item) => typeof item.turnCount === "number"));
  const s1Item = payload.items.find((item) => item.sessionId === "s1");
  const s2Item = payload.items.find((item) => item.sessionId === "s2");
  check("s1 返回 todo 摘要", s1Item?.todo?.total === 3 && s1Item.todo.firstOpen === "修复补丁锚点", JSON.stringify(s1Item?.todo));
  check("摘要不再返回 items（对话摘要功能已取消）", s1Item?.todo?.items === void 0, JSON.stringify(s1Item?.todo?.items));
  check("无 todo 的会话返回 todo: null", s2Item?.todo === null, JSON.stringify(s2Item?.todo));
  check("todo 摘要不额外读日志（与轮次同一次读取）", readCount === 2, `reads=${readCount}`);

  // 语义别名端点返回同样结构
  const digestResponse = fakeResponse();
  await handler(fakeRequest({ url: SESSION_DIGEST_ROUTE + "?sessionIds=s1" }), digestResponse);
  const digestPayload = JSON.parse(digestResponse.rawBody);
  check("session-digest 别名端点可用", digestResponse.statusCode === 200 && digestPayload.items.length === 1, String(digestResponse.statusCode));
  check("别名端点带 todo 摘要", digestPayload.items[0]?.todo?.doing === 1, JSON.stringify(digestPayload.items[0]?.todo));

  // 第二次请求应命中缓存（stat 的 revision 未变）
  const before = readCount;
  const again = fakeResponse();
  await handler(fakeRequest({ url: TURN_COUNTS_ROUTE + "?sessionIds=s1,s2" }), again);
  const second = JSON.parse(again.rawBody);
  check("重复请求命中缓存（不再读日志）", readCount === before, `reads=${readCount} before=${before}`);
  check("缓存标记为 true", second.items.every((item) => item.cached === true), JSON.stringify(second.items));

  // 未知会话 → failed 列表
  const missing = fakeResponse();
  await handler(fakeRequest({ url: TURN_COUNTS_ROUTE + "?sessionIds=missing" }), missing);
  const missingPayload = JSON.parse(missing.rawBody);
  check("未知会话进入 failed", missingPayload.failed?.length === 1, JSON.stringify(missingPayload.failed));
  check("未知会话不出现在 items", missingPayload.items.length === 0, String(missingPayload.items.length));
}
{
  const { ctx, registered } = makeCtx();
  registerTurnCountRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ method: "POST" }), response);
  check("POST 返回 405", response.statusCode === 405, String(response.statusCode));
}
{
  const { ctx, registered } = makeCtx();
  registerTurnCountRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ remoteAddress: "203.0.113.9" }), response);
  check("非回环来源 403", response.statusCode === 403, String(response.statusCode));
}
{
  const { ctx, registered } = makeCtx({ noPersistence: true });
  registerTurnCountRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ url: TURN_COUNTS_ROUTE + "?sessionIds=s1" }), response);
  check("无持久化服务 503", response.statusCode === 503, String(response.statusCode));
}
{
  // 未传 sessionIds → 回退宿主注册表归档集合
  const registry = { archivedSessionIdsForTarget: () => ["s1", "s2"] };
  const { ctx, registered } = makeCtx({ registry });
  registerTurnCountRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ url: TURN_COUNTS_ROUTE }), response);
  const payload = JSON.parse(response.rawBody);
  check("回退注册表枚举归档集合", payload.items.length === 2, JSON.stringify(payload.items.map((item) => item.sessionId)));
}
{
  const { ctx, registered } = makeCtx();
  registerTurnCountRoute(ctx);
  const response = fakeResponse();
  await registered[0].handler(fakeRequest({ method: "HEAD", url: TURN_COUNTS_ROUTE + "?sessionIds=s1" }), response);
  check("HEAD 返回 200 且无响应体", response.statusCode === 200 && response.rawBody === void 0, `${response.statusCode}/${response.rawBody}`);
}

let failed = 0;
const lines = [];
for (const item of results) {
  if (item.section !== void 0) {
    lines.push(`\n[${item.section}]`);
    continue;
  }
  if (item.ok !== true) failed += 1;
  lines.push(`  ${item.ok === true ? "PASS" : "FAIL"}  ${item.name}${item.detail === "" ? "" : `  → ${item.detail}`}`);
}
console.log(lines.join("\n"));
console.log(`\n合计：${results.filter((item) => item.section === void 0).length} 项断言，失败 ${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
