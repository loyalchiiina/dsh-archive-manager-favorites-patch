/**
 * 归档/历史会话「轮次 + todo 摘要」统计路由（本地增强，只读、零模型调用）。
 *
 * GET /api/dsh-archive-manager-plus/archived-turn-counts?sessionIds=a,b,c
 * GET /api/dsh-archive-manager-plus/session-digest?sessionIds=a,b,c      （同一实现，语义化别名）
 *   → { items: [{ sessionId, turnCount, todo, cached }], failed: [...] }
 *
 * 数据来源：`sessionPersistence.readFrom(id, 0)` / `open(id, "read")` —— 后端负责
 * Zstandard 解压，故不可直接正则扫描磁盘文件。**不调用任何模型，零 token 消耗。**
 *
 * - `turnCount`：按日志顺序统计 `step/end` 的 turn 去重个数（与官方 `sessionStats` 同口径）。
 * - `todo`：取日志中**最后一次** `todo/write` 快照（官方 `todo_write` 工具写入
 *   `{ todos: [{ content, status }] }`，status ∈ pending | in_progress | completed），
 *   归纳为 `{ total, done, doing, pending, firstOpen, lastDone }`；无 todo 记录时为 null。
 *
 * 结果缓存在内存，并尽力写入 `~/.dsh/data/dsh-archive-manager-fav/turn-counts.json`；
 * 缓存以持久化 revision（或 sizeBytes）做失效判断，写盘失败不影响返回。
 *
 * 安全：仅本机回环来源可访问；只读，不修改会话。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TURN_COUNTS_ROUTE = "/api/dsh-archive-manager-plus/archived-turn-counts";
const SESSION_DIGEST_ROUTE = "/api/dsh-archive-manager-plus/session-digest";
const CACHE_ENTRY_VERSION = 3;
const CACHE_DIR = process.env.DSH_ARCHIVE_MANAGER_CACHE_DIR ?? join(homedir(), ".dsh", "data", "dsh-archive-manager-fav");
const CACHE_FILE = join(CACHE_DIR, "turn-counts.json");
const MAX_CONCURRENCY = 4;
const MAX_SESSIONS_PER_REQUEST = 500;

function header(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackAddress(value) {
  const address = value?.toLowerCase().replace(/^\[|\]$/g, "");
  return address === "localhost" || address === "localhost." || address === "::1" ||
    address?.startsWith("127.") === true || address?.startsWith("::ffff:127.") === true;
}

function isLocalRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const site = header(request, "sec-fetch-site");
  return site === void 0 || site === "same-origin" || site === "none";
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
}

/**
 * 按官方口径统计一个会话日志的轮次数：`step/end` 的 turn 去重计数。
 * @param events - 按日志顺序排列的事件数组。
 * @returns 非负整数轮次数。
 */
function countTurns(events) {
  let turns = 0;
  let lastTurn;
  for (const event of events ?? []) {
    if (event?.type !== "step/end") continue;
    const turn = event.data?.turn;
    if (turn === lastTurn) continue;
    turns += 1;
    lastTurn = turn;
  }
  return turns;
}

/**
 * 归纳一份 todo 清单：优先暴露第一个进行中项，其次是第一个待办项。
 * @param todos - `todo/write` 的 `data.todos`（`[{ content, status }]`）。
 * @returns 摘要对象；无有效条目时为 null。
 */
/** 官方 todo 状态白名单；未知值一律归一为 pending。 */
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
function normalizeTodoStatus(status) {
  return typeof status === "string" && TODO_STATUSES.has(status) ? status : "pending";
}

function summarizeTodos(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return null;
  let done = 0;
  let doing = 0;
  let pending = 0;
  let firstDoing = null;
  let firstPending = null;
  let lastDone = null;
  for (const item of todos) {
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    const status = normalizeTodoStatus(item?.status);
    if (status === "completed") {
      done += 1;
      if (content !== "") lastDone = content;
      continue;
    }
    if (status === "in_progress") {
      doing += 1;
      if (firstDoing === null && content !== "") firstDoing = content;
      continue;
    }
    pending += 1;
    if (firstPending === null && content !== "") firstPending = content;
  }
  return {
    total: todos.length,
    done,
    doing,
    pending,
    firstOpen: firstDoing ?? firstPending ?? lastDone,
    lastDone
  };
}

/**
 * 单次遍历事件流，同时得出轮次数与最后一次 todo 摘要（避免重复解析大日志）。
 * @param events - 按日志顺序排列的事件数组。
 * @returns `{ turnCount, todo }`。
 */
function analyzeEvents(events) {
  let todos;
  for (const event of events ?? []) {
    if (event?.type !== "todo/write") continue;
    const list = event.data?.todos;
    if (Array.isArray(list)) todos = list;
  }
  return { turnCount: countTurns(events), todo: summarizeTodos(todos) };
}

async function readSessionEvents(persistence, sessionId) {
  if (typeof persistence.readFrom === "function") {
    const stored = await persistence.readFrom(sessionId, 0);
    return stored?.events ?? [];
  }
  const handle = await persistence.open(sessionId, "read");
  try {
    const { events } = await handle.read(0);
    return events ?? [];
  } finally {
    await handle.close();
  }
}

async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function createDigestCache(ctx) {
  const memory = new Map();
  let loaded = false;
  let dirty = false;

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await readFile(CACHE_FILE, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [sessionId, entry] of Object.entries(parsed)) {
        if (entry !== null && typeof entry === "object" && typeof entry.turnCount === "number") {
          memory.set(sessionId, entry);
        }
      }
    } catch (error) {
      // 首次运行、缓存缺失或损坏都按空缓存处理
    }
  }

  async function persist() {
    if (!dirty) return;
    dirty = false;
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      const payload = {};
      for (const [sessionId, entry] of memory) payload[sessionId] = entry;
      const temporary = `${CACHE_FILE}.tmp`;
      await writeFile(temporary, JSON.stringify(payload), "utf8");
      await rename(temporary, CACHE_FILE);
    } catch (error) {
      ctx.logger?.warn?.(`archive-manager: digest cache could not be written: ${String(error)}`);
    }
  }

  return {
    async digest(persistence, sessionId) {
      let key;
      if (typeof persistence.stat === "function") {
        const snapshot = await persistence.stat(sessionId);
        if (snapshot === void 0) return void 0;
        key = snapshot.revision ?? (typeof snapshot.sizeBytes === "number" ? `size:${snapshot.sizeBytes}` : void 0);
      }
      const cached = memory.get(sessionId);
      // 代际校验：旧版缓存条目（无版本号 / 无 todo 字段）一律视为失效并重新读取，
      // 否则升级到「带 todo 摘要」的实现后，已缓存会话的摘要会长期为空。
      if (cached !== void 0 && cached.version === CACHE_ENTRY_VERSION && key !== void 0 && cached.key === key) {
        return { turnCount: cached.turnCount, todo: cached.todo, cached: true };
      }
      const events = await readSessionEvents(persistence, sessionId);
      const analyzed = analyzeEvents(events);
      memory.set(sessionId, { version: CACHE_ENTRY_VERSION, turnCount: analyzed.turnCount, todo: analyzed.todo, key });
      dirty = true;
      return { turnCount: analyzed.turnCount, todo: analyzed.todo, cached: false };
    },
    async flush() {
      await ensureLoaded();
      await persist();
    },
    async ensureLoaded() {
      await ensureLoaded();
    }
  };
}

function requestedSessionIds(ctx, request) {
  // 客户端传来的列表优先（与界面所见一致）；未传时回退到宿主注册表的归档集合。
  const raw = new URL(request.url ?? TURN_COUNTS_ROUTE, "http://127.0.0.1").searchParams.get("sessionIds");
  if (raw !== null && raw !== "") {
    const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => id !== ""))];
    if (ids.length > 0) return ids.slice(0, MAX_SESSIONS_PER_REQUEST);
  }
  const registry = ctx.get?.("workspace");
  if (registry !== void 0 && typeof registry.archivedSessionIdsForTarget === "function") {
    try {
      const ids = registry.archivedSessionIdsForTarget({ scope: "all" });
      if (Array.isArray(ids)) return [...new Set(ids)].slice(0, MAX_SESSIONS_PER_REQUEST);
    } catch (error) {
      ctx.logger?.warn?.(`archive-manager: archived session enumeration failed: ${String(error)}`);
    }
  }
  return [];
}

function createHandler(ctx, cache) {
  return async function handler(request, response) {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" });
        response.end();
        return;
      }
      if (!isLocalRequest(request)) {
        json(response, 403, { error: "forbidden" });
        return;
      }
      const persistence = ctx.get?.("sessionPersistence");
      if (persistence === void 0) {
        json(response, 503, { error: "session persistence is unavailable" });
        return;
      }
      await cache.ensureLoaded();
      const sessionIds = requestedSessionIds(ctx, request);
      const failed = [];
      const items = await mapWithLimit(sessionIds, MAX_CONCURRENCY, async (sessionId) => {
        try {
          const result = await cache.digest(persistence, sessionId);
          if (result === void 0) {
            failed.push({ sessionId, message: "unknown session" });
            return void 0;
          }
          return { sessionId, turnCount: result.turnCount, todo: result.todo, cached: result.cached };
        } catch (error) {
          ctx.logger?.warn?.(`archive-manager: digest for "${sessionId}" failed: ${String(error)}`);
          failed.push({ sessionId, message: String(error) });
          return void 0;
        }
      });
      await cache.flush();
      const payload = {
        items: items.filter((item) => item !== void 0),
        ...(failed.length === 0 ? {} : { failed })
      };
      if (request.method === "HEAD") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end();
        return;
      }
      json(response, 200, payload);
    } catch (error) {
      ctx.logger?.warn?.(`archive-manager: session digest lookup failed: ${String(error)}`);
      json(response, 500, { error: "session digest lookup failed" });
    }
  };
}

function registerTurnCountRoute(ctx) {
  const cache = createDigestCache(ctx);
  const handler = createHandler(ctx, cache);
  const disposers = [TURN_COUNTS_ROUTE, SESSION_DIGEST_ROUTE].map((path) =>
    ctx.webServer.register({ kind: "exact", path, handler })
  );
  return () => {
    for (const disposer of disposers) {
      try {
        disposer?.();
      } catch (error) {
        ctx.logger?.warn?.(`archive-manager: digest route disposal failed: ${String(error)}`);
      }
    }
  };
}

export {
  registerTurnCountRoute,
  countTurns,
  summarizeTodos,
  analyzeEvents,
  TURN_COUNTS_ROUTE,
  SESSION_DIGEST_ROUTE,
  CACHE_FILE
};
