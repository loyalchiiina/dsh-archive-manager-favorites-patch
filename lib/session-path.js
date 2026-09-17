/**
 * 会话位置查询路由（本地增强，只读）。
 *
 * 用途：为侧栏会话菜单的「复制会话 ID / 文件路径」提供宿主侧权威的转录工件绝对路径。
 * 解析顺序：
 *   1. sessionPersistence.stat(sessionId) → header → persistence.locate(header)（冷/归档会话同样可用）
 *   2. 运行中会话：sessions.list() 的内存实体 header → locate(header)
 * 安全：仅接受本机回环来源；只读；不写盘、不改会话状态。
 */
const SESSION_PATH_ROUTE = "/api/dsh-archive-manager-plus/session-path";

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

/** 解析一个会话的转录工件位置；会话不存在时返回 `undefined`。 */
async function resolveSessionLocation(ctx, sessionId) {
  const persistence = ctx.get?.("sessionPersistence");
  let meta;
  if (persistence !== void 0 && typeof persistence.stat === "function") {
    const snapshot = await persistence.stat(sessionId);
    meta = snapshot?.header;
  }
  if (meta === void 0) {
    const sessions = ctx.get?.("sessions");
    const live = typeof sessions?.list === "function"
      ? sessions.list().find((session) => session.id === sessionId)
      : void 0;
    meta = live?.header;
  }
  if (meta === void 0) return void 0;
  const location = persistence !== void 0 && typeof persistence.locate === "function"
    ? persistence.locate(meta)
    : void 0;
  return {
    sessionId,
    cwd: typeof meta.cwd === "string" ? meta.cwd : null,
    path: typeof location?.path === "string" ? location.path : null,
    kind: typeof location?.kind === "string" ? location.kind : null
  };
}

function registerSessionPathRoute(ctx) {
  return ctx.webServer.register({
    kind: "exact",
    path: SESSION_PATH_ROUTE,
    handler: async (request, response) => {
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
        const sessionId = new URL(request.url ?? SESSION_PATH_ROUTE, "http://127.0.0.1").searchParams.get("sessionId");
        if (sessionId === null || sessionId === "") {
          json(response, 400, { error: "sessionId is required" });
          return;
        }
        const payload = await resolveSessionLocation(ctx, sessionId);
        if (payload === void 0) {
          json(response, 404, { error: "session not found" });
          return;
        }
        if (request.method === "HEAD") {
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end();
          return;
        }
        json(response, 200, payload);
      } catch (error) {
        ctx.logger?.warn?.(`archive-manager: session path lookup failed: ${String(error)}`);
        json(response, 500, { error: "session path lookup failed" });
      }
    }
  });
}

export { registerSessionPathRoute, SESSION_PATH_ROUTE };
