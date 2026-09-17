import { lstat, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { WorkspaceRegistry } from "@deepseek-ai/dsh-workspace";
import { bindTypertRemote, Remote } from "@deepseek-ai/dsh-typert-protocol";
import { sessionDir } from "@deepseek-ai/dsh-spill-local";
import { trackTombstone } from "./tombstone.js";
const sessionIdListSchema = {
  parse(value) {
    if (!Array.isArray(value)) throw new TypeError("sessionIds must be an array");
    for (const id of value) {
      if (typeof id !== "string" || id.length === 0) throw new TypeError("each sessionId must be a non-empty string");
    }
    return value;
  }
};
const archivedSelectionBatchSchema = {
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("result must be an object");
    if (!Array.isArray(value.archivedSessionIds)) throw new TypeError("archivedSessionIds must be an array");
    if (!Array.isArray(value.archivedSessionIdsAdded)) throw new TypeError("archivedSessionIdsAdded must be an array");
    return value;
  }
};
function jsonlSessionDirectory(persistence, header, location) {
  if (persistence.name !== "session-persistence-jsonl" || location.kind !== "jsonl")
    return;
  const root = persistence.root ?? persistence.config?.root;
  if (typeof root !== "string" || !isAbsolute(root) || !isAbsolute(location.path))
    return;
  if (!/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(
    basename(location.path)
  ))
    return;
  if (typeof header.id !== "string" || header.id.length === 0) return;
  const encode = (text) => text.replace(
    /[^A-Za-z0-9._-]/g,
    (ch) => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`
  );
  const segment = header.id === "." ? "~002E" : header.id === ".." ? "~002E~002E" : encode(header.id);
  let project = "_no-cwd";
  if (header.cwd !== void 0) {
    if (typeof header.cwd !== "string" || header.cwd.length === 0) return;
    const readable = encode(header.cwd.replace(/[\\/:]+/g, "-")).replace(/^-+/, "") || "root";
    project = `--${readable.slice(0, 251)}--`;
  }
  const directory = join(resolve(root), project, segment);
  if (location.path !== join(directory, basename(location.path))) return;
  return directory;
}
function markRemoteMethod(instance, method) {
  const context = {
    private: false,
    static: false,
    name: method,
    addInitializer(fn) {
      fn.call(instance);
    }
  };
  Remote(method)(void 0, context);
}
function unknownSessionMessage(sessionId) {
  return `unknown session "${sessionId}" (UNKNOWN_SESSION)`;
}
var ArchiveUnknownSessionError = class extends Error {
  sessionId;
  constructor(sessionId) {
    super(unknownSessionMessage(sessionId));
    this.sessionId = sessionId;
    this.name = "ArchiveUnknownSessionError";
  }
};
function headerIdentity(header) {
  return {
    createdAt: header.createdAt,
    cwd: header.cwd ?? null
  };
}
const sessionIdSchema = {
  parse(value) {
    if (typeof value !== "string" || value.length === 0)
      throw new TypeError(
        `sessionId must be a non-empty string, got ${String(value)}`
      );
    return value;
  }
};
const workspaceIdSchema = {
  parse(value) {
    if (typeof value !== "string" || value.length === 0)
      throw new TypeError(
        `workspaceId must be a non-empty string, got ${String(value)}`
      );
    return value;
  }
};
const archivedSetSchema = {
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("result must be an object");
    const ids = value.archivedSessionIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
      throw new TypeError("archivedSessionIds must be a string array");
    return value;
  }
};
const deletedSchema = {
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || value.deleted !== true)
      throw new TypeError("deleted must be true");
    return value;
  }
};
const archivedBatchTargetSchema = {
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("target must be an object");
    if (value.scope === "all" || value.scope === "ungrouped") return value;
    if (value.scope === "workspace" && typeof value.workspaceId === "string" && value.workspaceId.length > 0)
      return value;
    if (value.scope === "sessions" && Array.isArray(value.sessionIds) && value.sessionIds.length > 0 && value.sessionIds.every((id) => typeof id === "string" && id.length > 0))
      return value;
    throw new TypeError(
      "target.scope must be all, ungrouped, workspace with a non-empty workspaceId, or sessions with non-empty sessionIds"
    );
  }
};
const unarchivedBatchSchema = {
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("result must be an object");
    if (!Array.isArray(value.archivedSessionIds) || value.archivedSessionIds.some((id) => typeof id !== "string"))
      throw new TypeError("archivedSessionIds must be a string array");
    if (!Array.isArray(value.unarchivedSessionIds) || value.unarchivedSessionIds.some((id) => typeof id !== "string"))
      throw new TypeError("unarchivedSessionIds must be a string array");
    return value;
  }
};
const archivedWorkspaceBatchSchema = {
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("result must be an object");
    if (!Array.isArray(value.archivedSessionIds) || value.archivedSessionIds.some((id) => typeof id !== "string"))
      throw new TypeError("archivedSessionIds must be a string array");
    if (!Array.isArray(value.archivedSessionIdsAdded) || value.archivedSessionIdsAdded.some((id) => typeof id !== "string"))
      throw new TypeError("archivedSessionIdsAdded must be a string array");
    return value;
  }
};
const deletedBatchSchema = {
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("result must be an object");
    for (const key of [
      "requestedSessionIds",
      "deletedSessionIds",
      "skippedSessionIds"
    ]) {
      if (!Array.isArray(value[key]) || value[key].some((id) => typeof id !== "string"))
        throw new TypeError(`${key} must be a string array`);
    }
    if (!Array.isArray(value.failures) || value.failures.some(
      (failure) => typeof failure !== "object" || failure === null || typeof failure.sessionId !== "string" || typeof failure.message !== "string"
    ))
      throw new TypeError("failures must contain sessionId/message objects");
    return value;
  }
};
const archivedSessionMetadataSchema = {
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !Array.isArray(value.items))
      throw new TypeError("result.items must be an array");
    if (value.items.some(
      (item) => typeof item !== "object" || item === null || typeof item.sessionId !== "string" || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)
    ))
      throw new TypeError("items must contain sessionId/createdAt objects");
    if (value.repairedSessionIds !== void 0 && (!Array.isArray(value.repairedSessionIds) || value.repairedSessionIds.some((id) => typeof id !== "string")))
      throw new TypeError("repairedSessionIds must be a string array");
    return value;
  }
};
const ARCHIVE_MANAGER_INVOCATIONS = [
  {
    id: "dsh-archive-manager-plus#workspaceRegistry/unarchiveSession",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "unarchiveSession",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "sessionId",
        wire: "sessionId",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
          schema: sessionIdSchema
        }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-archive-manager-plus/types#ArchivedSessionIds",
      schema: archivedSetSchema
    },
    sourceLocation: {
      file: "dsh-archive-manager-plus/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "dsh-archive-manager-plus#workspaceRegistry/deleteSession",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "deleteSession",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "sessionId",
        wire: "sessionId",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
          schema: sessionIdSchema
        }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-archive-manager-plus/types#Deleted",
      schema: deletedSchema
    },
    sourceLocation: {
      file: "dsh-archive-manager-plus/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "dsh-archive-manager-plus#workspaceRegistry/unarchiveSessions",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "unarchiveSessions",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "target",
        wire: "target",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "dsh-archive-manager-plus/types#ArchivedBatchTarget",
          schema: archivedBatchTargetSchema
        }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-archive-manager-plus/types#UnarchivedBatch",
      schema: unarchivedBatchSchema
    },
    sourceLocation: {
      file: "dsh-archive-manager-plus/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "dsh-archive-manager-plus#workspaceRegistry/archiveSessionsByIds",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "archiveSessionsByIds",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "sessionIds",
        wire: "sessionIds",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "dsh-archive-manager-plus/types#IdleArchiveSessionIds",
          schema: sessionIdListSchema
        }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-archive-manager-plus/types#ArchivedSelectionBatch",
      schema: archivedSelectionBatchSchema
    },
    sourceLocation: {
      file: "dsh-archive-manager-plus/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "dsh-archive-manager-plus#workspaceRegistry/archiveWorkspaceSessions",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "archiveWorkspaceSessions",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "workspaceId",
        wire: "workspaceId",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "@deepseek-ai/dsh-workspace/types#WorkspaceId",
          schema: workspaceIdSchema
        }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-archive-manager-plus/types#ArchivedWorkspaceBatch",
      schema: archivedWorkspaceBatchSchema
    },
    sourceLocation: {
      file: "dsh-archive-manager-plus/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "dsh-archive-manager-plus#workspaceRegistry/deleteArchivedSessionsSafe",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "deleteArchivedSessionsSafe",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "target",
        wire: "target",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "dsh-archive-manager-plus/types#ArchivedBatchTarget",
          schema: archivedBatchTargetSchema
        }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-archive-manager-plus/types#DeletedBatch",
      schema: deletedBatchSchema
    },
    sourceLocation: {
      file: "dsh-archive-manager-plus/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "dsh-archive-manager-plus#workspaceRegistry/deleteArchivedSessions",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "deleteArchivedSessions",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "target",
        wire: "target",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "dsh-archive-manager-plus/types#ArchivedBatchTarget",
          schema: archivedBatchTargetSchema
        }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: "dsh-archive-manager-plus/types#DeletedBatch",
      schema: deletedBatchSchema
    },
    sourceLocation: {
      file: "dsh-archive-manager-plus/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "dsh-archive-manager-plus#workspaceRegistry/archivedSessionMetadata",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "archivedSessionMetadata",
    invocation: { kind: "direct" },
    parameters: [],
    result: {
      mode: "strict",
      typeSymbol: "dsh-archive-manager-plus/types#ArchivedSessionMetadata",
      schema: archivedSessionMetadataSchema
    },
    sourceLocation: {
      file: "dsh-archive-manager-plus/lib/workspace.js",
      line: 1,
      column: 1
    }
  }
];
const ARCHIVE_MANAGER_TYPERT = {
  package: "dsh-archive-manager-plus",
  face: "host",
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: ARCHIVE_MANAGER_INVOCATIONS
};
function registerHostRemote(ctx) {
  const existing = ctx.get("typert");
  if (existing !== void 0) {
    existing.register(ARCHIVE_MANAGER_TYPERT);
    return;
  }
  ctx.inject(["typert"], (typertCtx) => {
    typertCtx.typert.register(ARCHIVE_MANAGER_TYPERT);
  });
}
var ArchiveWorkspaceRegistry = class extends WorkspaceRegistry {
  static inject = [
    "storageDomain",
    "sessionPersistence",
    "sessionProjectionCache",
    "typert"
  ];
  /** 本进程内已物理删除的会话；阻止父类把 stale list() 重新编入索引。 */
  deletedSessionIds = /* @__PURE__ */ new Set();
  /** 墓碑插入顺序，用于在上限处淘汰最旧项。 */
  deletedSessionOrder = [];
  /** 墓碑上限：足够挡住 stale list()，又避免长驻进程无限增长。 */
  deletedSessionTombstoneLimit = 4096;
  /** 被删生命周期的日志身份（createdAt/cwd）：冷复用探针区分“同 id 新会话”与 stale list() 的依据。 */
  deletedIdentities = /* @__PURE__ */ new Map();
  constructor(ctx) {
    super(ctx);
    this.typertRemote = bindTypertRemote(this, this.name);
    markRemoteMethod(this, "unarchiveSession");
    markRemoteMethod(this, "deleteSession");
    markRemoteMethod(this, "unarchiveSessions");
    markRemoteMethod(this, "archiveWorkspaceSessions");
    markRemoteMethod(this, "archiveSessionsByIds");
    markRemoteMethod(this, "deleteArchivedSessions");
    markRemoteMethod(this, "deleteArchivedSessionsSafe");
    markRemoteMethod(this, "archivedSessionMetadata");
    registerHostRemote(this.ctx);
  }
  /**
   * 归档设置页创建时间排序所需的最小元数据。老用户可能仍有会话原文和
   * 归档标记、却没有投影缓存；这里按需从完整日志重建一次，再通知客户端
   * 刷新会话列表。已有缓存不读原文，新老 DSH 的缓存布局都走同一 put。
   */
  async archivedSessionMetadata() {
    const items = [];
    const repairedSessionIds = [];
    for (const sessionId of [
      ...new Set(this.requireState().archivedSessionIds)
    ]) {
      try {
        const header = await this.readSessionHeader(sessionId);
        if (await this.repairArchivedProjection(header))
          repairedSessionIds.push(sessionId);
        if (typeof header.createdAt === "number" && Number.isFinite(header.createdAt))
          items.push({ sessionId, createdAt: header.createdAt });
      } catch (error) {
        this.ctx.logger.warn(
          `archive-manager: could not read creation time for archived session "${sessionId}": ${String(error)}`
        );
      }
    }
    return {
      items,
      ...repairedSessionIds.length === 0 ? {} : { repairedSessionIds }
    };
  }
  /** 从会话原文补齐缺失的派生缓存；任何失败都只降级为原有无摘要列表。 */
  async repairArchivedProjection(header) {
    const cache = this.ctx.get("sessionProjectionCache");
    const persistence = this.ctx.get("sessionPersistence");
    const projections = this.ctx.get("sessionProjections");
    if (cache === void 0 || typeof cache.cachedSnapshot !== "function" || typeof cache.put !== "function")
      return false;
    if (persistence === void 0 || typeof persistence.readFrom !== "function" && typeof persistence.open !== "function" || projections === void 0 || typeof projections.restore !== "function")
      return false;
    try {
      if (!header.isSeeded && cache.cachedSnapshot(header, 0) !== void 0)
        return false;
      const stored = await this.readStoredProjectionSource(persistence, header.id);
      const meta = stored.meta ?? header;
      if (meta.isSeeded === true && stored.inheritedEventCount === void 0) {
        this.ctx.logger.warn(
          `archive-manager: projection repair for seeded archived session "${header.id}" skipped because its inherited event count is unavailable`
        );
        return false;
      }
      const inheritedEventCount = stored.inheritedEventCount ?? 0;
      if (meta.isSeeded !== true && inheritedEventCount !== 0) {
        this.ctx.logger.warn(
          `archive-manager: projection repair for unseeded archived session "${header.id}" skipped because its inherited event count is not zero`
        );
        return false;
      }
      if (cache.cachedSnapshot(meta, inheritedEventCount) !== void 0) return false;
      const restored = projections.restore(
        {},
        stored.events,
        0,
        meta,
        inheritedEventCount
      );
      if (restored === void 0 || typeof restored !== "object" || restored.checkpoint === void 0)
        return false;
      await cache.put(
        header.id,
        {
          // 支持的宿主头部均有 version；新版缓存校验格式代际，旧版逐字段比较忽略此键。
          formatVersion: meta.version,
          createdAt: meta.createdAt,
          ...meta.cwd === void 0 ? {} : { cwd: meta.cwd },
          isSeeded: meta.isSeeded ?? false,
          inheritedEventCount
        },
        restored.checkpoint
      );
      return true;
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: projection repair for archived session "${header.id}" failed: ${String(error)}`
      );
      return false;
    }
  }
  /** 新版读句柄必须关闭；旧版仍沿用 readFrom，避免激活 Agent 或写入会话日志。 */
  async readStoredProjectionSource(persistence, sessionId) {
    if (typeof persistence.readFrom === "function")
      return persistence.readFrom(sessionId, 0);
    const handle = await persistence.open(sessionId, "read");
    try {
      const { events } = await handle.read(0);
      return {
        meta: handle.header,
        inheritedEventCount: handle.inheritedEventCount,
        events
      };
    } finally {
      await handle.close();
    }
  }
  /**
   * 把一个会话移出注册表全局归档集合，恢复其正常可见性（其记账位从未
   * 移动，会话在原工作区位置重新出现）。幂等：未归档的已知会话直接返回
   * 当前集合不写入；未知会话与 `archiveSession` 一样抛错。
   * @param sessionId - 要取消归档的会话。
   * @returns 更新后的完整归档集合。
   */
  async unarchiveSession(sessionId) {
    return this.enqueueOperation(async () => {
      if (!await this.sessionKnown(sessionId))
        throw new ArchiveUnknownSessionError(sessionId);
      const state = this.requireState();
      if (!state.archivedSessionIds.includes(sessionId))
        return { archivedSessionIds: [...state.archivedSessionIds] };
      const next = {
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(
          (id) => id !== sessionId
        )
      };
      await this.setState(next);
      return { archivedSessionIds: [...next.archivedSessionIds] };
    });
  }
  /**
   * 将一个工作区内所有会话加入归档集合。先确认所有待归档会话仍存在，
   * 再执行单次状态写入，因此未知会话不会导致项目只归档一部分。
   */
  async archiveWorkspaceSessions(workspaceId) {
    return this.enqueueOperation(async () => {
      workspaceId = workspaceIdSchema.parse(workspaceId);
      const workspace = this.requireTable().get(workspaceId);
      if (workspace === void 0)
        throw new Error(`unknown workspace "${workspaceId}"`);
      const state = this.requireState();
      const archived = new Set(state.archivedSessionIds);
      const archivedSessionIdsAdded = [...new Set(workspace.sessionIds)].filter(
        (sessionId) => !archived.has(sessionId)
      );
      for (const sessionId of archivedSessionIdsAdded) {
        if (!await this.sessionKnown(sessionId))
          throw new ArchiveUnknownSessionError(sessionId);
      }
      if (archivedSessionIdsAdded.length === 0)
        return {
          archivedSessionIds: [...state.archivedSessionIds],
          archivedSessionIdsAdded
        };
      const next = {
        ...state,
        archivedSessionIds: [
          ...state.archivedSessionIds,
          ...archivedSessionIdsAdded
        ]
      };
      await this.setState(next);
      return {
        archivedSessionIds: [...next.archivedSessionIds],
        archivedSessionIdsAdded
      };
    });
  }
  /**
   * 按显式会话清单批量归档（供「按时间筛选归档」等选择性子集使用）。
   * 与整工作区归档不同：这里只处理传入的 id，且跳过已归档项，
   * 归档标记一次追加、单次落盘。未知会话计入 failures 而不中断整批。
   */
  async archiveSessionsByIds(sessionIds) {
    return this.enqueueOperation(async () => {
      const requestedSessionIds = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map(String).filter((id) => id !== ""))];
      if (requestedSessionIds.length === 0) {
        return { archivedSessionIds: [...this.requireState().archivedSessionIds], archivedSessionIdsAdded: [], skippedSessionIds: [], failures: [] };
      }
      const state = this.requireState();
      const alreadyArchived = new Set(state.archivedSessionIds);
      const skippedSessionIds = [];
      const failures = [];
      const candidates = [];
      for (const sessionId of requestedSessionIds) {
        if (alreadyArchived.has(sessionId)) {
          skippedSessionIds.push(sessionId);
          continue;
        }
        try {
          if (!await this.sessionKnown(sessionId)) throw new ArchiveUnknownSessionError(sessionId);
          candidates.push(sessionId);
        } catch (error) {
          if (error instanceof ArchiveUnknownSessionError) failures.push({ sessionId, message: "unknown session" });
          else failures.push({ sessionId, message: String(error) });
        }
      }
      if (candidates.length === 0) {
        return { archivedSessionIds: [...state.archivedSessionIds], archivedSessionIdsAdded: [], skippedSessionIds, failures };
      }
      const next = { ...state, archivedSessionIds: [...state.archivedSessionIds, ...candidates] };
      await this.setState(next);
      return { archivedSessionIds: [...next.archivedSessionIds], archivedSessionIdsAdded: candidates, skippedSessionIds, failures };
    });
  }
  /**
   * 按宿主权威归档集合一次恢复全部、一个工作区或未分组的归档会话。
   * 目标全部来自已归档集合，因此即使日志已被外部移除，也会清掉陈旧归档标记。
   */
  async unarchiveSessions(target) {
    return this.enqueueOperation(async () => {
      const unarchivedSessionIds = this.archivedSessionIdsForTarget(target);
      if (unarchivedSessionIds.length === 0)
        return {
          archivedSessionIds: [...this.requireState().archivedSessionIds],
          unarchivedSessionIds: []
        };
      const restored = new Set(unarchivedSessionIds);
      const state = this.requireState();
      const next = {
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(
          (id) => !restored.has(id)
        )
      };
      await this.setState(next);
      return {
        archivedSessionIds: [...next.archivedSessionIds],
        unarchivedSessionIds
      };
    });
  }
  /**
   * 按作用域永久删除归档会话。跨会话文件删除无法组成事务，因此继续处理
   * 后续目标并把成功、并发消失和失败分别返回给客户端。
   */
  /**
   * 安全的批量删除（分步 + 超时 + 每步日志）。
   *
   * 设计目标：任何一步卡住都只等 timeoutMs，绝不永久阻塞主进程。
   * 每完成一步写一行日志到 ~/.dsh/archive-manager-delete.log，便于事后定位。
   *
   * @param target - 与 deleteArchivedSessions 相同的批量目标。
   * @param options - { concurrency?, stepTimeoutMs?, logPath? }
   */
  async deleteArchivedSessionsSafe(target, options = {}) {
    const rawConcurrency = Number(options?.concurrency);
    const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0
      ? Math.min(32, Math.max(1, Math.floor(rawConcurrency)))
      : 8;
    const rawTimeout = Number(options?.stepTimeoutMs);
    const stepTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(120000, Math.max(500, Math.floor(rawTimeout)))
      : 5000;

    // ---- 日志（收集到数组 + 发事件；不写文件，避免 ESM 下无 require） ----
    const logLines = [];
    const say = (message) => {
      const line = new Date().toISOString().slice(11, 23) + " " + message;
      logLines.push(line);
      try { this.ctx.logger.info("archive-manager(safe): " + message); } catch {}
      try { this.ctx.emit("archive-manager/delete-step", { at: Date.now(), message }); } catch {}
    };

    // 超时包装：超时后不中断底层操作，但让上层继续往下走
    const withTimeout = async (label, promise, ms) => {
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          say(label + " TIMEOUT after " + ms + "ms (continuing)");
          resolve({ timedOut: true });
        }, ms);
      });
      try {
        const result = await Promise.race([promise.then((v) => ({ value: v })), timeout]);
        if (timer !== null) clearTimeout(timer);
        return result;
      } catch (error) {
        if (timer !== null) clearTimeout(timer);
        return { error: String(error) };
      }
    };

    const requestedSessionIds = this.archivedSessionIdsForTarget(target);
    say("start: requested=" + requestedSessionIds.length + " concurrency=" + concurrency + " stepTimeout=" + stepTimeoutMs + "ms");

    const deletedSessionIds = [];
    const skippedSessionIds = [];
    const failures = [];

    // ---- 步骤 1：解析目录（纯计算 + 读 header） ----
    const plans = [];
    for (let i = 0; i < requestedSessionIds.length; i += 1) {
      const sessionId = requestedSessionIds[i];
      const res = await withTimeout("resolve:" + sessionId, (async () => {
        const header = await this.readSessionHeader(sessionId);
        if (header === void 0 || header === null) return null;
        const persistence = this.ctx.get("sessionPersistence");
        let directory = null;
        if (persistence !== void 0 && typeof persistence.locate === "function") {
          const location = persistence.locate(header);
          if (location !== void 0 && typeof location.path === "string") {
            const resolved = jsonlSessionDirectory(persistence, header, location);
            directory = resolved !== void 0 ? resolved : dirname(location.path);
          }
        }
        return { sessionId, directory };
      })(), stepTimeoutMs);
      if (res.timedOut) { skippedSessionIds.push(sessionId); continue; }
      if (res.error) { failures.push({ sessionId, message: "resolve: " + res.error }); continue; }
      if (res.value === null) { skippedSessionIds.push(sessionId); continue; }
      plans.push(res.value);
      if ((i + 1) % 10 === 0) say("resolved " + (i + 1) + "/" + requestedSessionIds.length);
    }
    say("resolve done: plans=" + plans.length + " skipped=" + skippedSessionIds.length + " failed=" + failures.length);

    // ---- 步骤 2：并发删目录（最快、最安全的一步） ----
    const removeOne = async (plan) => {
      if (typeof plan.directory !== "string" || plan.directory.length === 0) return;
      let stat;
      try {
        stat = await lstat(plan.directory);
      } catch (error) {
        if (error?.code === "ENOENT") return; // 已经不在了
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error("refusing to delete symlink: " + plan.directory);
      if (!stat.isDirectory()) throw new Error("not a session directory: " + plan.directory);
      await rm(plan.directory, { recursive: true, force: true });
    };
    let removedCount = 0;
    for (let i = 0; i < plans.length; i += concurrency) {
      const slice = plans.slice(i, i + concurrency);
      const settled = await Promise.allSettled(slice.map((p) => removeOne(p)));
      for (let k = 0; k < settled.length; k += 1) {
        const plan = slice[k];
        const r = settled[k];
        if (r.status === "fulfilled") { deletedSessionIds.push(plan.sessionId); removedCount += 1; }
        else failures.push({ sessionId: plan.sessionId, message: "remove: " + String(r.reason) });
      }
      say("removed " + removedCount + "/" + plans.length);
    }
    say("remove done: deleted=" + deletedSessionIds.length + " failed=" + failures.length);

    // ---- 步骤 3：索引更新（各带超时） ----
    const removed = new Set(deletedSessionIds);
    if (removed.size > 0) {
      const r1 = await withTimeout("setState:archived", (async () => {
        const state = this.requireState();
        const nextArchived = state.archivedSessionIds.filter((id) => !removed.has(id));
        if (nextArchived.length !== state.archivedSessionIds.length) {
          await this.setState({ ...state, archivedSessionIds: nextArchived });
        }
      })(), stepTimeoutMs);
      if (r1.timedOut || r1.error) failures.push({ sessionId: "*archived-set*", message: r1.error ?? "timeout" });
      say("archived-set updated: " + (r1.timedOut ? "TIMEOUT" : r1.error ?? "ok"));

      const r2 = await withTimeout("table:accounts", (async () => {
        const table = this.requireTable();
        for (const workspaceId of this.requireState().workspaceIds) {
          const record = table.get(workspaceId);
          if (record === void 0) continue;
          if (!record.sessionIds.some((id) => removed.has(id))) continue;
          const next = await table.update(workspaceId, (current) => ({
            ...current,
            sessionIds: current.sessionIds.filter((id) => !removed.has(id)),
            updatedAt: (new Date()).toISOString()
          }));
          const entity = this.entities.get(workspaceId);
          if (entity !== void 0) entity.record = next;
        }
      })(), stepTimeoutMs);
      if (r2.timedOut || r2.error) failures.push({ sessionId: "*workspace-accounts*", message: r2.error ?? "timeout" });
      say("workspace accounts updated: " + (r2.timedOut ? "TIMEOUT" : r2.error ?? "ok"));

      // ---- 步骤 4：清缓存（每个都带超时，绝不整体卡住） ----
      const projCache = this.ctx.get("sessionProjectionCache");
      if (projCache !== void 0 && typeof projCache.delete === "function") {
        let cacheOk = 0;
        let cacheTimeout = 0;
        for (const sessionId of deletedSessionIds) {
          const r = await withTimeout("cache:" + sessionId, projCache.delete(sessionId), Math.min(stepTimeoutMs, 2000));
          if (r.timedOut) cacheTimeout += 1;
          else if (!r.error) cacheOk += 1;
        }
        say("cache cleanup: ok=" + cacheOk + " timeout=" + cacheTimeout);
      } else {
        say("cache cleanup: skipped (no sessionProjectionCache)");
      }

      // ---- 步骤 5：墓碑 + 通知 ----
      for (const sessionId of deletedSessionIds) {
        try {
          const deletedHeader = this.headers.get(sessionId) ?? this.ctx.get("sessions")?.get(sessionId)?.header;
          this.forgetIndexedSession(sessionId);
          if (deletedHeader !== void 0) this.deletedIdentities.set(sessionId, headerIdentity(deletedHeader));
          this.publishDeletedSession(sessionId);
        } catch (error) {
          say("finalize failed for " + sessionId + ": " + String(error));
        }
      }
      say("finalize done");
    }

    say("DONE deleted=" + deletedSessionIds.length + " skipped=" + skippedSessionIds.length + " failed=" + failures.length);
    return { requestedSessionIds, deletedSessionIds, skippedSessionIds, failures, log: logLines };
  }
  /** 同步写删除日志（卡死也不丢），写入 ~/.dsh/archive-manager-delete.log。 */
  dlog(message) {
    try {
      const line = new Date().toISOString().slice(11, 23) + " " + message;
      appendFileSync(join(homedir(), ".dsh", "archive-manager-delete.log"), line + "\n", "utf8");
    } catch {}
  }
  async deleteArchivedSessions(target) {
    return this.enqueueOperation(async () => {
      const requestedSessionIds = this.archivedSessionIdsForTarget(target);
      this.dlog("slow-delete: start requested=" + requestedSessionIds.length);
      this.dlog("slow-delete: building descendants index (once) ...");
      const descendantsIndex = await this.buildDescendantsIndex();
      this.dlog("slow-delete: descendants index size=" + descendantsIndex.size);
      // 归档集合里的 id 必然存在：预热缓存，避免 sessionKnown 全量扫描
      for (const id of requestedSessionIds) this.markSessionKnown(id);
      for (const children of descendantsIndex.values()) for (const child of children) this.markSessionKnown(child);
      const deletedSessionIds = [];
      const skippedSessionIds = [];
      const failures = [];
      for (const sessionId of requestedSessionIds) {
        this.dlog("slow-delete: begin " + sessionId);
        try {
          await this.deleteSessionCore(sessionId, descendantsIndex);
          this.dlog("slow-delete: ok " + sessionId + " (" + (deletedSessionIds.length + 1) + "/" + requestedSessionIds.length + ")");
          deletedSessionIds.push(sessionId);
        } catch (error) {
          if (error instanceof ArchiveUnknownSessionError) {
            try {
              await this.cleanupUnknownArchivedSession(sessionId);
              skippedSessionIds.push(sessionId);
            } catch (cleanupError) {
              failures.push({ sessionId, message: String(cleanupError) });
            }
            continue;
          }
          failures.push({ sessionId, message: String(error) });
        }
      }
      return {
        requestedSessionIds,
        deletedSessionIds,
        skippedSessionIds,
        failures
      };
    });
  }
  /**
   * 清理已无转录的陈旧归档项。缓存墓碑只在清除在途写入期间短暂持有：
   * workspace 没有可记录的旧 header 身份，永久保留它会挡住未来的冷复用。
   * 归档标记最后清除，前序可失败步骤出错时批量入口仍能再次命中。
   */
  async cleanupUnknownArchivedSession(sessionId) {
    const projCache = this.ctx.get("sessionProjectionCache");
    await projCache?.whenIdle?.();
    if (projCache !== void 0) {
      await projCache.delete(sessionId);
      await projCache.whenIdle?.();
      projCache.clearTombstone?.(sessionId);
    }
    await this.cleanSpill(sessionId);
    await this.removeFromWorkspaceAccounts(sessionId);
    const state = this.requireState();
    if (state.archivedSessionIds.includes(sessionId)) {
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(
          (id) => id !== sessionId
        )
      });
    }
  }
  /** 以归档集合顺序解析批量目标，避免依赖浏览器尚未加载完整的摘要投影。 */
  archivedSessionIdsForTarget(target) {
    target = archivedBatchTargetSchema.parse(target);
    const state = this.requireState();
    const archivedSessionIds = [...new Set(state.archivedSessionIds)];
    if (target.scope === "all") return archivedSessionIds;
    if (target.scope === "sessions") {
      const selected = new Set(target.sessionIds);
      return archivedSessionIds.filter((id) => selected.has(id));
    }
    if (target.scope === "workspace") {
      const workspace = this.requireTable().get(target.workspaceId);
      if (workspace === void 0)
        throw new Error(`unknown workspace "${target.workspaceId}"`);
      const accounted2 = new Set(workspace.sessionIds);
      return archivedSessionIds.filter((id) => accounted2.has(id));
    }
    const accounted = /* @__PURE__ */ new Set();
    const table = this.requireTable();
    for (const workspaceId of state.workspaceIds) {
      for (const sessionId of table.get(workspaceId)?.sessionIds ?? [])
        accounted.add(sessionId);
    }
    return archivedSessionIds.filter((id) => !accounted.has(id));
  }
  /**
   * 永久删除一个会话及其全部痕迹（转录目录、工作区记账、归档标记、
   * 投影缓存行）。
   * @param sessionId - 要删除的会话。
   * @returns 持久化完成后的 `{ deleted: true }`。
   * @throws {@link ArchiveUnknownSessionError} 会话未知时抛出。
   */
  async deleteSession(sessionId) {
    return this.enqueueOperation(() => this.deleteSessionCore(sessionId));
  }
  /** 串行化后的删除主体（级联路径复用：它已持有操作链，绝不能再入队）。 */
  async deleteSessionCore(sessionId, descendantsIndex) {
    const __dl = (m) => this.dlog("  core " + sessionId.slice(-12) + " " + m);
    __dl("sessionKnown ...");
    if (!await this.sessionKnown(sessionId))
      throw new ArchiveUnknownSessionError(sessionId);
    const sessions = this.ctx.get("sessions");
    const live = sessions?.get(sessionId);
    const deletedHeader = this.headers.get(sessionId) ?? live?.header;
    if (live !== void 0) {
      await sessions.flush(live);
      const entry = sessions.liveEntryFor(live);
      sessions.detachEntered(entry);
    } else if (sessions !== void 0)
      await this.publishColdSessionRemoval(sessionId, sessions);
    const projCache = this.ctx.get("sessionProjectionCache");
    __dl("whenIdle ...");
    await projCache?.whenIdle?.();
    __dl("cache.delete ...");
    if (projCache !== void 0) await projCache.delete(sessionId);
    __dl("deleteDescendants ...");
    await this.deleteDescendants(sessionId, descendantsIndex);
    __dl("cleanSpill ...");
    await this.cleanSpill(sessionId);
    __dl("removeTranscriptDirectory ...");
    await this.removeTranscriptDirectory(sessionId);
    __dl("transcript removed");
    const state = this.requireState();
    if (state.archivedSessionIds.includes(sessionId)) {
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(
          (id) => id !== sessionId
        )
      });
    }
    __dl("removeFromWorkspaceAccounts ...");
    await this.removeFromWorkspaceAccounts(sessionId);
    __dl("done");
    this.forgetIndexedSession(sessionId);
    if (deletedHeader !== void 0)
      this.deletedIdentities.set(sessionId, headerIdentity(deletedHeader));
    this.publishDeletedSession(sessionId);
    return { deleted: true };
  }
  /** 删除完成后通知全部客户端；新版不再通过伪造冷会话生命周期触发通知。 */
  publishDeletedSession(sessionId) {
    try {
      this.ctx.emit("api-session/removed", sessionId);
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: session "${sessionId}" deleted but removal notification failed: ${String(error)}`
      );
    }
  }
  /**
   * 从父类内存索引中遗忘已删除会话，并阻止后续 indexHeaders 把它加回。
   * 实时会话以同 id 重新出现时（自定义 id 复用）会撤掉墓碑。
   */
  clearTombstone(sessionId) {
    this.deletedSessionIds.delete(sessionId);
    this.deletedIdentities.delete(sessionId);
    const idx = this.deletedSessionOrder.indexOf(sessionId);
    if (idx !== -1) this.deletedSessionOrder.splice(idx, 1);
    this.ctx.get("sessionProjectionCache")?.clearTombstone?.(sessionId);
  }
  forgetIndexedSession(sessionId) {
    for (const evicted of trackTombstone(
      this.deletedSessionIds,
      this.deletedSessionOrder,
      sessionId,
      this.deletedSessionTombstoneLimit
    ))
      this.deletedIdentities.delete(evicted);
    this.headers.delete(sessionId);
    this.sessionPaths.delete(sessionId);
    this.invalidSessionPaths.delete(sessionId);
  }
  /**
   * 已删除会话对归档/删除入口都视为未知。实时复用同一 id 时撤墓碑，
   * 避免挡住新会话。
   */
  async sessionKnown(id) {
    // 进程内已确认存在（批量删除预热写入）：直接返回，避免全盘 stat 扫描。
    if (this.knownSessionIds !== null && this.knownSessionIds.has(id)) return true;
    if (this.ctx.get("sessions")?.get(id) !== void 0) {
      this.clearTombstone(id);
      this.markSessionKnown(id);
      return true;
    }
    if (this.deletedSessionIds.has(id)) return this.coldReuseKnown(id);
    const known = await super.sessionKnown(id);
    if (known) this.markSessionKnown(id);
    return known;
  }
  /**
   * 墓碑分支的冷复用探针：其他进程以同 id 重建并落盘的新会话（日志身份
   * 不同）撤墓碑放行并重新编入索引；stale list() 里同生命周期的旧头部
   * 仍视为未知。身份不可考（删除时未取到头部）时保守维持未知。
   */
  async coldReuseKnown(id) {
    const deletedIdentity = this.deletedIdentities.get(id);
    if (deletedIdentity === void 0) return false;
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0 || typeof persistence.list !== "function")
      return false;
    let header;
    try {
      header = (await this.listStoredHeaders()).find((item) => item.id === id);
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: cold-reuse probe for "${id}" failed: ${String(error)}`
      );
      return false;
    }
    if (header === void 0) return false;
    const listed = headerIdentity(header);
    if (listed.createdAt === deletedIdentity.createdAt && listed.cwd === deletedIdentity.cwd)
      return false;
    this.clearTombstone(id);
    await this.indexHeader(header);
    return true;
  }
  /**
   * 父类 indexHeaders 只增不减；跳过墓碑 id，避免 stale persistence.list()
   * 把已删除会话重新编入 headers。
   */
  async indexHeader(header) {
    if (this.deletedSessionIds.has(header.id)) return;
    return super.indexHeader(header);
  }
  /** 统一旧版头部数组与 0.1.3 的持久化快照，供父类索引和本插件枚举共用。 */
  async listStoredHeaders() {
    return (await this.ctx.sessionPersistence.list()).map(
      (item) => item.header ?? item
    );
  }
  async indexHeaders(items) {
    for (const item of items) await this.indexHeader(item.header ?? item);
  }
  /** 为未处于实时状态的持久化会话发布相同的移除事件。 */
  async publishColdSessionRemoval(sessionId, sessions) {
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0 || typeof persistence.prepare !== "function")
      return;
    try {
      const preparation = await persistence.prepare(sessionId);
      const detach = sessions.enter(preparation.session);
      try {
        sessions.announce(preparation.session);
      } finally {
        detach();
        preparation[Symbol.dispose]();
      }
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: could not publish removal for stored session "${sessionId}": ${String(error)}`
      );
    }
  }
  /** 官方 JSONL 已知布局清理会话专属目录；其他后端只删除定位到的工件。 */
  async removeTranscriptDirectory(sessionId) {
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0 || typeof persistence.locate !== "function") {
      throw new Error(
        `cannot delete session "${sessionId}": the session persistence backend does not expose locate() to resolve its transcript artifact`
      );
    }
    const header = await this.readSessionHeader(sessionId);
    const location = persistence.locate(header);
    if (location === void 0 || typeof location.path !== "string") {
      throw new Error(
        `cannot delete session "${sessionId}": the session persistence backend could not resolve its transcript artifact`
      );
    }
    let target = { path: location.path, kind: "transcript artifact" };
    try {
      const directory = jsonlSessionDirectory(persistence, header, location);
      if (directory !== void 0) {
        target = { path: directory, kind: "session directory" };
        for (const path of [dirname(directory), directory]) {
          let stat;
          try {
            stat = await lstat(path);
          } catch (error) {
            if (error?.code === "ENOENT") continue;
            throw error;
          }
          if (stat.isSymbolicLink())
            throw new Error(`refusing to delete through symbolic link "${path}"`);
          if (!stat.isDirectory())
            throw new Error(`expected session storage directory "${path}"`);
        }
      } else if (persistence.name === "session-persistence-jsonl") {
        this.ctx.logger.warn(
          `archive-manager: session "${sessionId}": JSONL directory ownership could not be verified; falling back to artifact-only deletion at "${location.path}" (parent directory retained)`
        );
      }
      await rm(target.path, { recursive: true, force: true });
      if (typeof persistence.stat === "function" && await persistence.stat(sessionId) !== void 0) {
        throw new Error(
          `session "${sessionId}" is still present in persistence after artifact removal`
        );
      }
    } catch (error) {
      const message = `cannot delete session "${sessionId}": cleanup of ${target.kind} "${target.path}" failed; bookkeeping retained for retry`;
      const detail = `${message}: ${String(error)}`;
      this.ctx.logger.warn(`archive-manager: ${detail}`);
      throw new Error(detail, { cause: error });
    }
  }
  /** 把 id 从每个工作区记录中移除，并刷新实体快照。 */
  async removeFromWorkspaceAccounts(sessionId) {
    const table = this.requireTable();
    const state = this.requireState();
    for (const workspaceId of state.workspaceIds) {
      const record = table.get(workspaceId);
      if (record === void 0 || !record.sessionIds.includes(sessionId)) continue;
      const next = await table.update(workspaceId, (current) => ({
        ...current,
        sessionIds: current.sessionIds.filter((id) => id !== sessionId),
        updatedAt: /* @__PURE__ */ (/* @__PURE__ */ new Date()).toISOString()
      }));
      const entity = this.entities.get(workspaceId);
      if (entity !== void 0) entity.record = next;
    }
  }
  /** 尽力而为的级联删除：删除 `sessionId` 的 SUBAGENT 子会话。
   * 仅头部标记 `origin: "subagent"` 的会话参与：单凭 `parentSession` 有歧义
   *（fork 分支也携带它），而 fork 分支是独立的用户会话，绝不能被级联删除。 */
  /**
   * 构建 parentSession -> [subagentChildId] 的索引（只扫一次）。
   * deleteDescendants 原本每次调用都做这件事，批量删除时是 O(n²) 的 stat 风暴。
   */
  /** 本进程内已确认存在的会话 id（避免 sessionKnown 反复全量扫描磁盘）。 */
  knownSessionIds = null;
  markSessionKnown(id) {
    if (this.knownSessionIds === null) this.knownSessionIds = /* @__PURE__ */ new Set();
    this.knownSessionIds.add(id);
  }
  async buildDescendantsIndex() {
    const index = /* @__PURE__ */ new Map();
    const add = (parent, child) => {
      if (typeof parent !== "string" || parent.length === 0) return;
      const list = index.get(parent);
      if (list === void 0) index.set(parent, [child]);
      else if (!list.includes(child)) list.push(child);
    };
    try {
      const sessions = this.ctx.get("sessions");
      if (sessions !== void 0) {
        for (const session of sessions.list()) {
          if (session.header.origin === "subagent") add(session.header.parentSession, session.id);
        }
      }
      for (const header of await this.listStoredHeaders()) {
        if (header.origin === "subagent") add(header.parentSession, header.id);
      }
    } catch (error) {
      this.ctx.logger.warn("archive-manager: descendants index build failed: " + String(error));
    }
    return index;
  }
  async deleteDescendants(sessionId, index) {
    try {
      const descendants = [];
      if (index !== void 0 && index !== null) {
        // 快速路径：索引里直接查，不再扫描全量 header
        for (const childId of index.get(sessionId) ?? []) descendants.push(childId);
      } else {
        const sessions = this.ctx.get("sessions");
        if (sessions !== void 0)
          for (const session of sessions.list()) {
            if (session.header.parentSession === sessionId && session.header.origin === "subagent")
              descendants.push(session.id);
          }
        for (const header of await this.listStoredHeaders()) {
          if (header.parentSession === sessionId && header.origin === "subagent" && !descendants.includes(header.id))
            descendants.push(header.id);
        }
      }
      const fromIndex = index !== void 0 && index !== null;
      for (const childId of descendants) {
        try {
          // 来自索引的子会话已知存在，跳过 sessionKnown（它会全量扫描磁盘）。
          if (!fromIndex && !await this.sessionKnown(childId)) continue;
          await this.deleteSessionCore(childId, index);
        } catch (error) {
          if (error instanceof ArchiveUnknownSessionError) continue;
          this.ctx.logger.warn(
            `archive-manager: cascade delete of subagent session "${childId}" (child of "${sessionId}") failed: ${String(error)}`
          );
        }
      }
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: descendant enumeration for deleted session "${sessionId}" failed: ${String(error)}`
      );
    }
  }
  /** 尽力而为的 spill 清理：移除该会话作用域的 spill 目录。 */
  async cleanSpill(sessionId) {
    try {
      const spill = this.ctx.get("spillStore");
      if (spill === void 0 || typeof spill.root !== "string") return;
      await rm(sessionDir(spill.root, sessionId), {
        recursive: true,
        force: true
      });
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: spill cleanup for deleted session "${sessionId}" failed: ${String(error)}`
      );
    }
  }
};
export {
  ArchiveWorkspaceRegistry,
  ArchiveWorkspaceRegistry as default
};
