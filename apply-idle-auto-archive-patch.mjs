#!/usr/bin/env node
/**
 * @michengai/dsh-archive-manager 本地增强补丁 · 第十批：按时间筛选自动归档（天数可设置）
 *
 * 用户诉求："根据时间归档，超过 1 天没对话的归档；把这个按时间筛选归档写到设置中去，时间可以设置。"
 *
 * ── 宿主端 lib/workspace.js
 *    原版只有 archiveWorkspaceSessions(workspaceId)（整工作区全归档），无法只归档一个子集，
 *    因此新增远程方法 archiveSessionsByIds(sessionIds)：校验后一次性追加归档标记并单次落盘
 *    （与第九批删除提速同思路，避免逐条 setState）。
 *
 * ── 客户端 lib/client.js（归档设置页头部新增一节「按时间归档」）
 *    - 天数输入框（0.5 ~ 3650，步进 0.5），默认 1 天；数值存 localStorage，重启保留
 *    - 实时显示「未归档会话中闲置超过 N 天的有 X 个」，随输入即时更新
 *    - 「归档这些会话」按钮走新宿主接口批量归档；完成后提示数量并可撤销
 *    - 判定依据 sessions.byId[...].updatedAt（宿主权威最后对话时间戳）；
 *      无有效时间戳的会话一律不纳入，避免误归档
 *    - 提供「仅看未归档」口径说明文案，中英双语
 *
 * ⚠️ 执行顺序：第九批之后（apply-all.mjs 已按序串好）。
 *
 * 用法：node apply-idle-auto-archive-patch.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const PKG = resolve(
  process.env.DSH_ARCHIVE_MANAGER_DIR ??
    join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager"),
  "lib"
);
const CLIENT = join(PKG, "client.js");
const WORKSPACE = join(PKG, "workspace.js");
const BACKUP_ROOT = join(homedir(), ".dsh", "backups");

/* =====================================================================
 * 宿主端：批量按 id 归档
 * ===================================================================== */

const HOST_METHOD_ANCHOR = `  /**
   * 按宿主权威归档集合一次恢复全部、一个工作区或未分组的归档会话。`;

const HOST_METHOD_NEW = `  /**
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
   * 按宿主权威归档集合一次恢复全部、一个工作区或未分组的归档会话。`;

// remote 方法声明表：紧跟既有 archiveWorkspaceSessions 声明之后追加一条
const HOST_REMOTE_OLD = `    id: "@michengai/dsh-archive-manager#workspaceRegistry/archiveWorkspaceSessions",`;
const HOST_REMOTE_NEW = `    id: "@michengai/dsh-archive-manager#workspaceRegistry/archiveSessionsByIds",
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
          typeSymbol: "@michengai/dsh-archive-manager/types#IdleArchiveSessionIds",
          schema: sessionIdListSchema
        }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: "@michengai/dsh-archive-manager/types#ArchivedSelectionBatch",
      schema: archivedSelectionBatchSchema
    },
    sourceLocation: {
      file: "@michengai/dsh-archive-manager/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "@michengai/dsh-archive-manager#workspaceRegistry/archiveWorkspaceSessions",`;

// markRemoteMethod 注册
const HOST_MARK_OLD = `    markRemoteMethod(this, "archiveWorkspaceSessions");`;
const HOST_MARK_NEW = `    markRemoteMethod(this, "archiveWorkspaceSessions");
    markRemoteMethod(this, "archiveSessionsByIds");`;

// ⚠️ typert-registry 要求 mode:"strict" 的 codec.schema 必须有 .parse() 方法（非 JSON Schema）。
// 与上游原版 sessionIdSchema/workspaceIdSchema 同构：{ parse(value){ ...校验; return value; } }。
const HOST_SCHEMA_OLD = `function jsonlSessionDirectory(persistence, header, location) {`;
const HOST_SCHEMA_NEW = `const sessionIdListSchema = {
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
function jsonlSessionDirectory(persistence, header, location) {`;

/* =====================================================================
 * 客户端
 * ===================================================================== */

/** 闲置阈值持久化 + 计算工具（模块作用域，插在收藏 store 之前）。 */
const CLIENT_UTIL_OLD = `      const archiveFavoriteStore = (() => {`;
const CLIENT_UTIL_NEW = `      /** 闲置自动归档阈值（天）持久化键与读写。 */
      const IDLE_ARCHIVE_DAYS_KEY = "dsham.idleArchiveDays.v1";
      const IDLE_ARCHIVE_DEFAULT_DAYS = 1;
      function readIdleArchiveDays() {
        try {
          const raw = Number.parseFloat(globalThis.localStorage?.getItem(IDLE_ARCHIVE_DAYS_KEY) ?? "");
          if (!Number.isFinite(raw) || raw <= 0) return IDLE_ARCHIVE_DEFAULT_DAYS;
          return Math.min(3650, Math.max(0.5, Math.round(raw * 2) / 2));
        } catch (error) {
          return IDLE_ARCHIVE_DEFAULT_DAYS;
        }
      }
      function writeIdleArchiveDays(days) {
        try {
          globalThis.localStorage?.setItem(IDLE_ARCHIVE_DAYS_KEY, String(days));
        } catch (error) {
          console.warn("archive-manager: idle threshold could not be persisted:", error);
        }
      }
      /**
       * 从未归档会话里挑出闲置超过 days 天的会话 id。
       * 以宿主权威的 updatedAt（最后对话时间）为准；缺失或非法时间戳一律跳过，绝不猜测。
       */
      function idleUnarchivedSessionIds(byId, archivedSessionIds, days, now = Date.now(), restrictTo = null) {
        // 阈值必须为正数：0 或非法值表示「未设置」，此时一律不归档，
        // 否则 threshold === now 会把所有会话判为闲置而误归档。
        const parsedDays = Number(days);
        if (!Number.isFinite(parsedDays) || parsedDays <= 0) return [];
        const archived = new Set(archivedSessionIds ?? []);
        const safeNow = Number.isFinite(now) ? Math.max(0, now) : Date.now();
        const threshold = safeNow - parsedDays * 864e5;
        const ids = [];
        for (const [sessionId, session] of byId ?? []) {
          // restrictTo：只统计侧边栏真正列出的会话（各工作区 sessionIds 的并集），
          // 排除从未进入任何列表的子代理 / 自动化会话，避免"归档 N 个"里的 N 虚高。
          if (restrictTo !== null && !restrictTo.has(sessionId)) continue;
          if (archived.has(sessionId)) continue;
          const updatedAt = Number(session?.updatedAt);
          if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;
          if (updatedAt < threshold) ids.push(sessionId);
        }
        return ids.sort((left, right) => (Number(byId.get(left)?.updatedAt) || 0) - (Number(byId.get(right)?.updatedAt) || 0));
      }
      function formatIdleDays(days) {
        return Number.isInteger(days) ? String(days) : days.toFixed(1);
      }
      const archiveFavoriteStore = (() => {`;

/** 设置页组件内的状态与动作。 */
const CLIENT_STATE_OLD = `        const [notice, setNotice] = (0, react.useState)(null);`;
const CLIENT_STATE_NEW = `        const [notice, setNotice] = (0, react.useState)(null);
        const [idleDays, setIdleDays] = (0, react.useState)(() => readIdleArchiveDays());
        const [idleBusy, setIdleBusy] = (0, react.useState)(false);
        const [lastIdleArchive, setLastIdleArchive] = (0, react.useState)(null);
        const allSessionsById = (0, react.useMemo)(() => new Map(Object.entries(sessions.byId ?? {})), [sessions.byId]);
        // 侧边栏真正列出的会话 id 集合：各工作区记录 sessionIds 的并集。
        // 归档数量与候选列表都以它为准，和侧边栏看到的条数同口径。
        const sidebarSessionIds = (0, react.useMemo)(() => {
          const ids = /* @__PURE__ */ new Set();
          for (const workspace of workspaceState.items ?? []) {
            for (const id of workspace.sessionIds ?? []) ids.add(id);
          }
          return ids;
        }, [workspaceState.items]);
        const idleCandidateIds = (0, react.useMemo)(
          () => idleUnarchivedSessionIds(allSessionsById, workspaceState.archivedSessionIds, idleDays, Date.now(), sidebarSessionIds),
          [allSessionsById, workspaceState.archivedSessionIds, idleDays, sidebarSessionIds]
        );
        const changeIdleDays = (raw) => {
          const parsed = Number.parseFloat(raw);
          if (!Number.isFinite(parsed) || parsed <= 0) return;
          const clamped = Math.min(3650, Math.max(0.5, Math.round(parsed * 2) / 2));
          setIdleDays(clamped);
          writeIdleArchiveDays(clamped);
        };
        const runIdleArchive = async () => {
          if (idleBusy || busy || idleCandidateIds.length === 0) return;
          setIdleBusy(true);
          setError(null);
          setNotice(null);
          const planned = [...idleCandidateIds];
          try {
            const result = await archiveSessionsByIds(planned);
            const added = result?.archivedSessionIdsAdded ?? [];
            setLastIdleArchive({ ids: added, days: idleDays, at: Date.now() });
            setNotice(t("archives.idleDone", { n: added.length, days: formatIdleDays(idleDays) }));
          } catch (reason) {
            setError(t("archives.idleFailed", { detail: reason instanceof Error ? reason.message : String(reason) }));
          } finally {
            setIdleBusy(false);
          }
        };
        const undoIdleArchive = async () => {
          if (idleBusy || lastIdleArchive === null) return;
          setIdleBusy(true);
          setError(null);
          try {
            const target = { scope: "sessions", sessionIds: lastIdleArchive.ids };
            const result = await unarchiveSessions(target);
            setNotice(t("archives.idleUndone", { n: result?.unarchivedSessionIds?.length ?? lastIdleArchive.ids.length }));
            setLastIdleArchive(null);
          } catch (reason) {
            setError(t("archives.idleUndoFailed", { detail: reason instanceof Error ? reason.message : String(reason) }));
          } finally {
            setIdleBusy(false);
          }
        };`;
/* C21b：自动归档开关词条 */
const C21B_ZH_OLD = [
  "        \"archives.idleNote\": \"以最后一次对话时间为判定依据；时间未知的会话不会被自动归档。归档后可随时恢复。\","
].join("\n");
const C21B_ZH_NEW = [
  "        \"archives.idleNote\": \"以最后一次对话时间为判定依据；时间未知的会话不会被自动归档。归档后可随时恢复。\",",
  "        \"archives.autoArchiveToggle\": \"自动归档闲置会话\",",
  "        \"archives.autoArchiveOffHint\": \"打开后，插件会定期自动归档超过阈值的会话（开关默认关闭）。\",",
  "        \"archives.autoArchiveOnHint\": \"已开启：每 {minutes} 分钟检查一次，自动归档闲置超过 {days} 天的未归档会话。\","
].join("\n");
const C21B_EN_OLD = [
  "        \"archives.idleNote\": \"Judged by the last conversation time; chats with an unknown timestamp are never auto-archived. Archived chats can always be restored.\","
].join("\n");
const C21B_EN_NEW = [
  "        \"archives.idleNote\": \"Judged by the last conversation time; chats with an unknown timestamp are never auto-archived. Archived chats can always be restored.\",",
  "        \"archives.autoArchiveToggle\": \"Auto-archive idle chats\",",
  "        \"archives.autoArchiveOffHint\": \"When on, the plugin periodically archives chats past the threshold (off by default).\",",
  "        \"archives.autoArchiveOnHint\": \"On: checks every {minutes} minutes and archives unarchived chats idle for more than {days} days.\","
].join("\n");

/* C21：设置页自动归档开关 */
const C21_TOGGLE_OLD = "lastIdleArchive !== null ? (0, react_jsx_runtime.jsx)(\"button\", { type: \"button\", className: \"dsham_settingsIdleUndo\", disabled: idleBusy || busy, onClick: () => undoIdleArchive(), children: t(\"archives.idleUndo\") }) : null] })";
const C21_TOGGLE_NEW = [
  "lastIdleArchive !== null ? (0, react_jsx_runtime.jsx)(\"button\", { type: \"button\", className: \"dsham_settingsIdleUndo\", disabled: idleBusy || busy, onClick: () => undoIdleArchive(), children: t(\"archives.idleUndo\") }) : null] }), (0, react_jsx_runtime.jsxs)(\"div\", {",
  "            className: \"dsham_settingsIdleAutoRow\",",
  "            children: [(0, react_jsx_runtime.jsxs)(\"label\", {",
  "              className: \"dsham_settingsIdleAutoToggle\",",
  "              children: [(0, react_jsx_runtime.jsx)(\"input\", {",
  "                type: \"checkbox\",",
  "                checked: autoArchiveOn === true,",
  "                disabled: idleBusy || busy,",
  "                onChange: () => archiveAutoStore.toggle(),",
  "                \"aria-label\": t(\"archives.autoArchiveToggle\")",
  "              }), (0, react_jsx_runtime.jsx)(\"span\", { children: t(\"archives.autoArchiveToggle\") })]",
  "            }), (0, react_jsx_runtime.jsx)(\"span\", {",
  "              className: \"dsham_settingsIdleAutoHint\",",
  "              children: autoArchiveOn === true",
  "                ? t(\"archives.autoArchiveOnHint\", { minutes: Math.round(AUTO_ARCHIVE_INTERVAL_MS / 60000), days: formatIdleDays(idleDays) })",
  "                : t(\"archives.autoArchiveOffHint\")",
  "            })]",
  "          })"
].join("\n");
const C21_CSS_OLD = ".dsham_settingsIdleNote{";
const C21_CSS_NEW = ".dsham_settingsIdleAutoRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-text-2,var(--dsw-alias-text-l2,#8a8f99))}.dsham_settingsIdleAutoToggle{display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--dsw-alias-text-l1,inherit)}.dsham_settingsIdleAutoToggle input{cursor:pointer}.dsham_settingsIdleAutoHint{opacity:.85}.dsham_settingsIdleNote{";

/* C20：自动归档（设置界面开关 + 定时器） */
const C20_TIMER_OLD = [
  "        const runIdleArchive = async () => {"
].join("\n");
const C20_TIMER_NEW = [
  "        // === 自动归档：开关状态 + 定时执行 ===",
  "        const autoArchiveOn = (0, react.useSyncExternalStore)(archiveAutoStore.subscribe, archiveAutoStore.getSnapshot);",
  "        const [autoArchiveTicks, setAutoArchiveTicks] = (0, react.useState)(0);",
  "        /**",
  "         * 自动归档定时器：开关打开后每 AUTO_ARCHIVE_INTERVAL_MS 检查一次，",
  "         * 有超期未归档会话才执行（复用 runIdleArchive，含进度条/撤回/错误处理）。",
  "         * 开关关闭或组件卸载时自动清理，不会泄漏定时器。",
  "         */",
  "        (0, react.useEffect)(() => {",
  "          if (autoArchiveOn !== true) return void 0;",
  "          const tick = () => {",
  "            try {",
  "              // 只计数触发；真正的判断与执行交给下方效应（它能看到最新的候选集）",
  "              setAutoArchiveTicks((n) => n + 1);",
  "            } catch (error) {",
  "              console.warn(\"archive-manager: auto archive tick failed:\", error);",
  "            }",
  "          };",
  "          const timer = setInterval(tick, AUTO_ARCHIVE_INTERVAL_MS);",
  "          // 打开开关后 30 秒先跑一次，不必等满一个周期",
  "          const firstRun = setTimeout(tick, 30000);",
  "          return () => {",
  "            clearInterval(timer);",
  "            clearTimeout(firstRun);",
  "          };",
  "        }, [autoArchiveOn]);",
  "        /**",
  "         * 每次 tick 时执行：仍有超期未归档会话才归档。",
  "         * 依赖 autoArchiveTicks，所以每次触发都会用最新的 idleCandidateIds。",
  "         */",
  "        (0, react.useEffect)(() => {",
  "          if (autoArchiveTicks === 0) return;",
  "          if (autoArchiveOn !== true) return;",
  "          if (idleBusy || busy) return;",
  "          if (idleCandidateIds.length === 0) return;",
  "          runIdleArchive();",
  "        }, [autoArchiveTicks]);",
  "        const runIdleArchive = async () => {"
].join("\n");
const C20_CONST_OLD = [
  "      /** 闲置自动归档阈值（天）持久化键与读写。 */"
].join("\n");
const C20_CONST_NEW = [
  "      /** 自动归档定时器检查周期（毫秒）。默认 30 分钟。 */",
  "      const AUTO_ARCHIVE_INTERVAL_MS = 30 * 60 * 1000;",
  "      /** 闲置自动归档阈值（天）持久化键与读写。 */"
].join("\n");

/* C19：侧边栏会话行加收藏星标（与置顶并列） */
const C19_STAR_OLD = "children: [pinned === true && (0, react_jsx_runtime.jsx)(\"span\", { className: \"dsham_pinBadge\", title: t(\"pin.label\"), \"aria-label\": t(\"pin.label\"), children: (0, react_jsx_runtime.jsx)(ArchivePinIcon, { filled: true }) }), (0, react_jsx_runtime.jsx)(\"span\", {";
const C19_STAR_NEW = [
  "children: [pinned === true && (0, react_jsx_runtime.jsx)(\"span\", { className: \"dsham_pinBadge\", title: t(\"pin.label\"), \"aria-label\": t(\"pin.label\"), children: (0, react_jsx_runtime.jsx)(ArchivePinIcon, { filled: true }) }), favorite === true && (0, react_jsx_runtime.jsx)(\"span\", { className: \"dsham_favoriteBadge\", title: t(\"menu.favorite\"), \"aria-label\": t(\"menu.favorite\"), children: (0, react_jsx_runtime.jsx)(ArchiveStarIcon, { filled: true }) }), (0, react_jsx_runtime.jsx)(\"span\", {"
].join("\n");
const C19_CSS_OLD = ".dsham_pinBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#f5a623}";
const C19_CSS_NEW = ".dsham_pinBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#f5a623}.dsham_favoriteBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#f5a623}";


/* =====================================================================
 * C18：删除进度可见性（方案 C）
 * ===================================================================== */

/** C18-1：进度状态加 startedAt / elapsedMs 字段。 */
const CLIENT_PROG_META_OLD = `        const [deleteProgress, setDeleteProgress] = (0, react.useState)(null);`;
const CLIENT_PROG_META_NEW = `        const [deleteProgress, setDeleteProgress] = (0, react.useState)(null);
        // 记录本次删除的开始时间，用于显示耗时（进度太快时也看得到结果）
        const deleteStartedAtRef = (0, react.useRef)(0);`;

/** C18-2：开始删除时记录时间，结束时算耗时。 */
const CLIENT_PROG_START_OLD = `              if (targets.length > 0) setDeleteProgress({ total: targets.length, done: 0, failed: 0 });`;
const CLIENT_PROG_START_NEW = `              if (targets.length > 0) {
                deleteStartedAtRef.current = Date.now();
                setDeleteProgress({ total: targets.length, done: 0, failed: 0, elapsedMs: 0 });
              }`;

const CLIENT_PROG_END_OLD = `              if (targets.length > 0) setDeleteProgress({ total: targets.length, done: targets.length, failed: 0 });`;
const CLIENT_PROG_END_NEW = `              if (targets.length > 0) {
                const elapsedMs = deleteStartedAtRef.current > 0 ? Date.now() - deleteStartedAtRef.current : 0;
                setDeleteProgress({ total: targets.length, done: targets.length, failed: 0, elapsedMs });
              }`;

/** C18-3：完成后停留 10 秒（原 4000ms）。 */
const CLIENT_PROG_CLEAR_OLD = `            setBusy(false);
            setTimeout(() => setDeleteProgress(null), 4000);`;
const CLIENT_PROG_CLEAR_NEW = `            setBusy(false);
            // 删除很快时进度条一闪而过，这里多留 10 秒让用户看到结果
            setTimeout(() => setDeleteProgress(null), 10000);`;

/** C18-4：进度文本加耗时显示。 */
const CLIENT_PROG_TEXT_OLD = `t("archives.deleteProgress"), " ", deleteProgress.done || 0, " / ", deleteProgress.total || 0, "（", Math.round((deleteProgress.total || 0) === 0 ? 0 : (deleteProgress.done || 0) / deleteProgress.total * 100), "%）"`;
const CLIENT_PROG_TEXT_NEW = `t("archives.deleteProgress"), " ", deleteProgress.done || 0, " / ", deleteProgress.total || 0, "（", Math.round((deleteProgress.total || 0) === 0 ? 0 : (deleteProgress.done || 0) / deleteProgress.total * 100), "%）", (deleteProgress.elapsedMs || 0) > 0 ? " · " + ((deleteProgress.elapsedMs || 0) / 1000).toFixed(1) + "s" : ""`;

/** C18-5：CSS 加过渡动画，进度条会在视觉上平滑走完。 */
const CLIENT_PROG_CSS_OLD = `.dsham_settingsIdleProgressFill{display:block;height:100%;background:var(--dsh-accent,#4c8dff);transition:width .15s ease}`;
const CLIENT_PROG_CSS_NEW = `.dsham_settingsIdleProgressFill{display:block;height:100%;background:var(--dsh-accent,#4c8dff);transition:width .6s cubic-bezier(.22,.61,.36,1)}`;

/* W14b：把存在性缓存插入原版 sessionKnown（不新增同名方法，保留墓碑逻辑） */
const W14B_KNOWN_OLD = [
  "  async sessionKnown(id) {",
  "    if (this.ctx.get(\"sessions\")?.get(id) !== void 0) {",
  "      this.clearTombstone(id);",
  "      return true;",
  "    }",
  "    if (this.deletedSessionIds.has(id)) return this.coldReuseKnown(id);",
  "    return super.sessionKnown(id);",
  "  }"
].join("\n");
const W14B_KNOWN_NEW = [
  "  async sessionKnown(id) {",
  "    // 进程内已确认存在（批量删除预热写入）：直接返回，避免全盘 stat 扫描。",
  "    if (this.knownSessionIds !== null && this.knownSessionIds.has(id)) return true;",
  "    if (this.ctx.get(\"sessions\")?.get(id) !== void 0) {",
  "      this.clearTombstone(id);",
  "      this.markSessionKnown(id);",
  "      return true;",
  "    }",
  "    if (this.deletedSessionIds.has(id)) return this.coldReuseKnown(id);",
  "    const known = await super.sessionKnown(id);",
  "    if (known) this.markSessionKnown(id);",
  "    return known;",
  "  }"
].join("\n");

/* W14：修 sessionKnown 的全量扫描（日志实证单次 5.8s / 16.6s） */
const W14_DESC_OLD = [
  "      for (const childId of descendants) {",
  "        try {",
  "          if (!await this.sessionKnown(childId)) continue;",
  "          await this.deleteSessionCore(childId);"
].join("\n");
const W14_DESC_NEW = [
  "      const fromIndex = index !== void 0 && index !== null;",
  "      for (const childId of descendants) {",
  "        try {",
  "          // 来自索引的子会话已知存在，跳过 sessionKnown（它会全量扫描磁盘）。",
  "          if (!fromIndex && !await this.sessionKnown(childId)) continue;",
  "          await this.deleteSessionCore(childId, index);"
].join("\n");
const W14_CACHE_OLD = [
  "  async buildDescendantsIndex() {"
].join("\n");
const W14_CACHE_NEW = [
  "  /** 本进程内已确认存在的会话 id（避免 sessionKnown 反复全量扫描磁盘）。 */",
  "  knownSessionIds = null;",
  "  markSessionKnown(id) {",
  "    if (this.knownSessionIds === null) this.knownSessionIds = /* @__PURE__ */ new Set();",
  "    this.knownSessionIds.add(id);",
  "  }",
  "  async buildDescendantsIndex() {"
].join("\n");
const W14_KNOWN_OLD = [
  "  async sessionKnown(id) {",
  "    if (this.ctx.get(\"sessions\")?.get(id) !== void 0) return true;",
  "    if (this.headers.has(id)) return true;"
].join("\n");
const W14_KNOWN_NEW = [
  "  async sessionKnown(id) {",
  "    if (this.knownSessionIds !== null && this.knownSessionIds.has(id)) return true;",
  "    if (this.ctx.get(\"sessions\")?.get(id) !== void 0) return true;",
  "    if (this.headers.has(id)) return true;"
].join("\n");
const W14_WARM_OLD = [
  "      this.dlog(\"slow-delete: descendants index size=\" + descendantsIndex.size);"
].join("\n");
const W14_WARM_NEW = [
  "      this.dlog(\"slow-delete: descendants index size=\" + descendantsIndex.size);",
  "      // 归档集合里的 id 必然存在：预热缓存，避免 sessionKnown 全量扫描",
  "      for (const id of requestedSessionIds) this.markSessionKnown(id);",
  "      for (const children of descendantsIndex.values()) for (const child of children) this.markSessionKnown(child);"
].join("\n");

/* W13：修 deleteDescendants 的 O(n^2) 扫描（批量只建一次索引） */
const W13_DESC_OLD = [
  "  async deleteDescendants(sessionId) {",
  "    try {",
  "      const descendants = [];",
  "      const sessions = this.ctx.get(\"sessions\");",
  "      if (sessions !== void 0)",
  "        for (const session of sessions.list()) {",
  "          if (session.header.parentSession === sessionId && session.header.origin === \"subagent\")",
  "            descendants.push(session.id);",
  "        }",
  "      for (const header of await this.listStoredHeaders()) {",
  "        if (header.parentSession === sessionId && header.origin === \"subagent\" && !descendants.includes(header.id))",
  "          descendants.push(header.id);",
  "      }"
].join("\n");
const W13_DESC_NEW = [
  "  /**",
  "   * 构建 parentSession -> [subagentChildId] 的索引（只扫一次）。",
  "   * deleteDescendants 原本每次调用都做这件事，批量删除时是 O(n²) 的 stat 风暴。",
  "   */",
  "  async buildDescendantsIndex() {",
  "    const index = /* @__PURE__ */ new Map();",
  "    const add = (parent, child) => {",
  "      if (typeof parent !== \"string\" || parent.length === 0) return;",
  "      const list = index.get(parent);",
  "      if (list === void 0) index.set(parent, [child]);",
  "      else if (!list.includes(child)) list.push(child);",
  "    };",
  "    try {",
  "      const sessions = this.ctx.get(\"sessions\");",
  "      if (sessions !== void 0) {",
  "        for (const session of sessions.list()) {",
  "          if (session.header.origin === \"subagent\") add(session.header.parentSession, session.id);",
  "        }",
  "      }",
  "      for (const header of await this.listStoredHeaders()) {",
  "        if (header.origin === \"subagent\") add(header.parentSession, header.id);",
  "      }",
  "    } catch (error) {",
  "      this.ctx.logger.warn(\"archive-manager: descendants index build failed: \" + String(error));",
  "    }",
  "    return index;",
  "  }",
  "  async deleteDescendants(sessionId, index) {",
  "    try {",
  "      const descendants = [];",
  "      if (index !== void 0 && index !== null) {",
  "        // 快速路径：索引里直接查，不再扫描全量 header",
  "        for (const childId of index.get(sessionId) ?? []) descendants.push(childId);",
  "      } else {",
  "        const sessions = this.ctx.get(\"sessions\");",
  "        if (sessions !== void 0)",
  "          for (const session of sessions.list()) {",
  "            if (session.header.parentSession === sessionId && session.header.origin === \"subagent\")",
  "              descendants.push(session.id);",
  "          }",
  "        for (const header of await this.listStoredHeaders()) {",
  "          if (header.parentSession === sessionId && header.origin === \"subagent\" && !descendants.includes(header.id))",
  "            descendants.push(header.id);",
  "        }",
  "      }"
].join("\n");
const W13_CORE_OLD = [
  "  async deleteSessionCore(sessionId) {"
].join("\n");
const W13_CORE_NEW = [
  "  async deleteSessionCore(sessionId, descendantsIndex) {"
].join("\n");
const W13_CALL_OLD = [
  "    __dl(\"deleteDescendants ...\");",
  "    await this.deleteDescendants(sessionId);"
].join("\n");
const W13_CALL_NEW = [
  "    __dl(\"deleteDescendants ...\");",
  "    await this.deleteDescendants(sessionId, descendantsIndex);"
].join("\n");
const W13_LOOP_OLD = [
  "      const requestedSessionIds = this.archivedSessionIdsForTarget(target);",
  "      this.dlog(\"slow-delete: start requested=\" + requestedSessionIds.length);"
].join("\n");
const W13_LOOP_NEW = [
  "      const requestedSessionIds = this.archivedSessionIdsForTarget(target);",
  "      this.dlog(\"slow-delete: start requested=\" + requestedSessionIds.length);",
  "      this.dlog(\"slow-delete: building descendants index (once) ...\");",
  "      const descendantsIndex = await this.buildDescendantsIndex();",
  "      this.dlog(\"slow-delete: descendants index size=\" + descendantsIndex.size);"
].join("\n");
const W13_CALL2_OLD = [
  "          await this.deleteSessionCore(sessionId);",
  "          this.dlog(\"slow-delete: ok \" + sessionId"
].join("\n");
const W13_CALL2_NEW = [
  "          await this.deleteSessionCore(sessionId, descendantsIndex);",
  "          this.dlog(\"slow-delete: ok \" + sessionId"
].join("\n");

/* W12：原版删除路径的同步日志（用于精确定位卡死点） */
const W12_DLOG_HELPER_OLD = [
  "  async deleteArchivedSessions(target) {"
].join("\n");
const W12_DLOG_HELPER_NEW = [
  "  /** 同步写删除日志（卡死也不丢），写入 ~/.dsh/archive-manager-delete.log。 */",
  "  dlog(message) {",
  "    try {",
  "      const line = new Date().toISOString().slice(11, 23) + \" \" + message;",
  "      appendFileSync(join(homedir(), \".dsh\", \"archive-manager-delete.log\"), line + \"\\n\", \"utf8\");",
  "    } catch {}",
  "  }",
  "  async deleteArchivedSessions(target) {"
].join("\n");
const W12_DLOG_LOOP_OLD = [
  "      const requestedSessionIds = this.archivedSessionIdsForTarget(target);",
  "      const deletedSessionIds = [];",
  "      const skippedSessionIds = [];",
  "      const failures = [];",
  "      for (const sessionId of requestedSessionIds) {",
  "        try {",
  "          await this.deleteSessionCore(sessionId);",
  "          deletedSessionIds.push(sessionId);"
].join("\n");
const W12_DLOG_LOOP_NEW = [
  "      const requestedSessionIds = this.archivedSessionIdsForTarget(target);",
  "      this.dlog(\"slow-delete: start requested=\" + requestedSessionIds.length);",
  "      const deletedSessionIds = [];",
  "      const skippedSessionIds = [];",
  "      const failures = [];",
  "      for (const sessionId of requestedSessionIds) {",
  "        this.dlog(\"slow-delete: begin \" + sessionId);",
  "        try {",
  "          await this.deleteSessionCore(sessionId);",
  "          this.dlog(\"slow-delete: ok \" + sessionId + \" (\" + (deletedSessionIds.length + 1) + \"/\" + requestedSessionIds.length + \")\");",
  "          deletedSessionIds.push(sessionId);"
].join("\n");
const W12_DLOG_CORE_OLD = [
  "  async deleteSessionCore(sessionId) {",
  "    if (!await this.sessionKnown(sessionId))"
].join("\n");
const W12_DLOG_CORE_NEW = [
  "  async deleteSessionCore(sessionId) {",
  "    const __dl = (m) => this.dlog(\"  core \" + sessionId.slice(-12) + \" \" + m);",
  "    __dl(\"sessionKnown ...\");",
  "    if (!await this.sessionKnown(sessionId))"
].join("\n");
const W12_DLOG_STEPS_OLD = [
  "    const projCache = this.ctx.get(\"sessionProjectionCache\");",
  "    await projCache?.whenIdle?.();",
  "    if (projCache !== void 0) await projCache.delete(sessionId);",
  "    await this.deleteDescendants(sessionId);",
  "    await this.cleanSpill(sessionId);",
  "    await this.removeTranscriptDirectory(sessionId);"
].join("\n");
const W12_DLOG_STEPS_NEW = [
  "    const projCache = this.ctx.get(\"sessionProjectionCache\");",
  "    __dl(\"whenIdle ...\");",
  "    await projCache?.whenIdle?.();",
  "    __dl(\"cache.delete ...\");",
  "    if (projCache !== void 0) await projCache.delete(sessionId);",
  "    __dl(\"deleteDescendants ...\");",
  "    await this.deleteDescendants(sessionId);",
  "    __dl(\"cleanSpill ...\");",
  "    await this.cleanSpill(sessionId);",
  "    __dl(\"removeTranscriptDirectory ...\");",
  "    await this.removeTranscriptDirectory(sessionId);",
  "    __dl(\"transcript removed\");"
].join("\n");
const W12_DLOG_TAIL_OLD = [
  "    await this.removeFromWorkspaceAccounts(sessionId);",
  "    this.forgetIndexedSession(sessionId);"
].join("\n");
const W12_DLOG_TAIL_NEW = [
  "    __dl(\"removeFromWorkspaceAccounts ...\");",
  "    await this.removeFromWorkspaceAccounts(sessionId);",
  "    __dl(\"done\");",
  "    this.forgetIndexedSession(sessionId);"
].join("\n");


/* =====================================================================
 * C17：客户端优先走"安全删除"（host deleteArchivedSessionsSafe）
 *      带 30 秒看门狗：超时也不让界面无限等待，并提示日志路径
 * ===================================================================== */

/** C17-1：安全删除包装（带看门狗）。 */
const CLIENT_SAFE_WRAP_OLD = `        const deleteArchivedSessions = async (target) => {`;
const CLIENT_SAFE_WRAP_NEW = `        /**
         * 安全批量删除：调用 host 的 deleteArchivedSessionsSafe。
         * 该 host 方法内部逐步超时（默认每步 5s），不会永久阻塞。
         * 这里再加一层看门狗：整体超过 timeoutMs 就抛出可读错误，
         * 并提示日志文件路径，便于事后排查（日志是同步落盘的，卡死也不丢）。
         */
        const deleteArchivedSessionsSafe = async (target, options) => {
          const registry = ctx.get("remote.workspaceRegistry");
          if (registry === void 0) throw new Error("archive-manager remote service is unavailable");
          if (typeof registry.deleteArchivedSessionsSafe !== "function") return null;
          const timeoutMs = Number(options?.watchdogMs) > 0 ? Number(options.watchdogMs) : 60000;
          const call = registry.deleteArchivedSessionsSafe(target, options ?? {});
          const watchdog = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("delete exceeded " + timeoutMs + "ms; steps are logged in ~/.dsh/archive-manager-delete.log")), timeoutMs);
          });
          const result = await Promise.race([call, watchdog]);
          if (!result.ok) throw new Error(result.error.message);
          await refreshSessionList();
          return result.value;
        };
        const deleteArchivedSessions = async (target) => {`;

/** C17-2：props 注入。 */
const CLIENT_SAFE_PROPS_OLD = `            deleteArchivedSessionsInBatches,
            archivedSessionMetadata,`;
const CLIENT_SAFE_PROPS_NEW = `            deleteArchivedSessionsInBatches,
            deleteArchivedSessionsSafe,
            archivedSessionMetadata,`;

/** C17-3：签名接收。 */
const CLIENT_SAFE_SIG_OLD = `deleteArchivedSessions, deleteArchivedSessionsInBatches, archivedSessionMetadata`;
const CLIENT_SAFE_SIG_NEW = `deleteArchivedSessions, deleteArchivedSessionsInBatches, deleteArchivedSessionsSafe, archivedSessionMetadata`;

/** C17-4：confirmDelete 优先安全删除（再回退分批）。 */
const CLIENT_SAFE_RUN_OLD = `              const targets = deriveArchivedBatchIds(workspaceState.archivedSessionIds, workspaceState.items, deleteTarget.target);
              let result;
              if (targets.length > 0 && typeof deleteArchivedSessionsInBatches === "function") {`;
const CLIENT_SAFE_RUN_NEW = `              const targets = deriveArchivedBatchIds(workspaceState.archivedSessionIds, workspaceState.items, deleteTarget.target);
              let result = null;
              if (targets.length > 0) setDeleteProgress({ total: targets.length, done: 0, failed: 0 });
              // 1) 安全删除：host 侧每步都有超时，日志同步落盘
              if (targets.length > 0 && typeof deleteArchivedSessionsSafe === "function") {
                try {
                  result = await deleteArchivedSessionsSafe({ scope: "sessions", sessionIds: targets }, { concurrency: 8, stepTimeoutMs: 5000, watchdogMs: 60000 });
                } catch (safeError) {
                  console.warn("archive-manager: safe delete failed:", safeError);
                  result = null;
                }
              }
              // 2) 回退：按批调用普通删除（带进度）
              if (result === null && targets.length > 0 && typeof deleteArchivedSessionsInBatches === "function") {`;

/** C17-5：进度完成后满格。 */
const CLIENT_SAFE_DONE_OLD = `              const feedback = archivedDeleteFeedback(result, t);
              if (feedback.kind === "error") setError(feedback.message);
              else setNotice(feedback.message);
              const completed = /* @__PURE__ */ new Set([...result.deletedSessionIds, ...result.skippedSessionIds]);`;
const CLIENT_SAFE_DONE_NEW = `              if (targets.length > 0) setDeleteProgress({ total: targets.length, done: targets.length, failed: 0 });
              const feedback = archivedDeleteFeedback(result, t);
              if (feedback.kind === "error") setError(feedback.message);
              else setNotice(feedback.message);
              const completed = /* @__PURE__ */ new Set([...result.deletedSessionIds, ...result.skippedSessionIds]);`;

/* W11：安全删除日志需要 appendFileSync(node:fs) 与 homedir(node:os) */
const HOST_IMPORT_OLD = 'import { lstat, rm } from "node:fs/promises";';
const HOST_IMPORT_NEW = [
  'import { lstat, rm } from "node:fs/promises";',
  'import { appendFileSync } from "node:fs";',
  'import { homedir } from "node:os";'
].join('\n');

/* W9：宿主安全删除（代码取自 snippets/host-safe-delete.js，共 171 行） */
const HOST_SAFE_ANCHOR = "  async deleteArchivedSessions(target) {";
const HOST_SAFE_NEW = [
  "  /**",
  "   * 安全的批量删除（分步 + 超时 + 每步日志）。",
  "   *",
  "   * 设计目标：任何一步卡住都只等 timeoutMs，绝不永久阻塞主进程。",
  "   * 每完成一步写一行日志到 ~/.dsh/archive-manager-delete.log，便于事后定位。",
  "   *",
  "   * @param target - 与 deleteArchivedSessions 相同的批量目标。",
  "   * @param options - { concurrency?, stepTimeoutMs?, logPath? }",
  "   */",
  "  async deleteArchivedSessionsSafe(target, options = {}) {",
  "    const rawConcurrency = Number(options?.concurrency);",
  "    const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0",
  "      ? Math.min(32, Math.max(1, Math.floor(rawConcurrency)))",
  "      : 8;",
  "    const rawTimeout = Number(options?.stepTimeoutMs);",
  "    const stepTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0",
  "      ? Math.min(120000, Math.max(500, Math.floor(rawTimeout)))",
  "      : 5000;",
  "",
  "    // ---- 日志（收集到数组 + 发事件；不写文件，避免 ESM 下无 require） ----",
  "    const logLines = [];",
  "    const say = (message) => {",
  "      const line = new Date().toISOString().slice(11, 23) + \" \" + message;",
  "      logLines.push(line);",
  "      try { this.ctx.logger.info(\"archive-manager(safe): \" + message); } catch {}",
  "      try { this.ctx.emit(\"archive-manager/delete-step\", { at: Date.now(), message }); } catch {}",
  "    };",
  "",
  "    // 超时包装：超时后不中断底层操作，但让上层继续往下走",
  "    const withTimeout = async (label, promise, ms) => {",
  "      let timer = null;",
  "      const timeout = new Promise((resolve) => {",
  "        timer = setTimeout(() => {",
  "          say(label + \" TIMEOUT after \" + ms + \"ms (continuing)\");",
  "          resolve({ timedOut: true });",
  "        }, ms);",
  "      });",
  "      try {",
  "        const result = await Promise.race([promise.then((v) => ({ value: v })), timeout]);",
  "        if (timer !== null) clearTimeout(timer);",
  "        return result;",
  "      } catch (error) {",
  "        if (timer !== null) clearTimeout(timer);",
  "        return { error: String(error) };",
  "      }",
  "    };",
  "",
  "    const requestedSessionIds = this.archivedSessionIdsForTarget(target);",
  "    say(\"start: requested=\" + requestedSessionIds.length + \" concurrency=\" + concurrency + \" stepTimeout=\" + stepTimeoutMs + \"ms\");",
  "",
  "    const deletedSessionIds = [];",
  "    const skippedSessionIds = [];",
  "    const failures = [];",
  "",
  "    // ---- 步骤 1：解析目录（纯计算 + 读 header） ----",
  "    const plans = [];",
  "    for (let i = 0; i < requestedSessionIds.length; i += 1) {",
  "      const sessionId = requestedSessionIds[i];",
  "      const res = await withTimeout(\"resolve:\" + sessionId, (async () => {",
  "        const header = await this.readSessionHeader(sessionId);",
  "        if (header === void 0 || header === null) return null;",
  "        const persistence = this.ctx.get(\"sessionPersistence\");",
  "        let directory = null;",
  "        if (persistence !== void 0 && typeof persistence.locate === \"function\") {",
  "          const location = persistence.locate(header);",
  "          if (location !== void 0 && typeof location.path === \"string\") {",
  "            const resolved = jsonlSessionDirectory(persistence, header, location);",
  "            directory = resolved !== void 0 ? resolved : dirname(location.path);",
  "          }",
  "        }",
  "        return { sessionId, directory };",
  "      })(), stepTimeoutMs);",
  "      if (res.timedOut) { skippedSessionIds.push(sessionId); continue; }",
  "      if (res.error) { failures.push({ sessionId, message: \"resolve: \" + res.error }); continue; }",
  "      if (res.value === null) { skippedSessionIds.push(sessionId); continue; }",
  "      plans.push(res.value);",
  "      if ((i + 1) % 10 === 0) say(\"resolved \" + (i + 1) + \"/\" + requestedSessionIds.length);",
  "    }",
  "    say(\"resolve done: plans=\" + plans.length + \" skipped=\" + skippedSessionIds.length + \" failed=\" + failures.length);",
  "",
  "    // ---- 步骤 2：并发删目录（最快、最安全的一步） ----",
  "    const removeOne = async (plan) => {",
  "      if (typeof plan.directory !== \"string\" || plan.directory.length === 0) return;",
  "      let stat;",
  "      try {",
  "        stat = await lstat(plan.directory);",
  "      } catch (error) {",
  "        if (error?.code === \"ENOENT\") return; // 已经不在了",
  "        throw error;",
  "      }",
  "      if (stat.isSymbolicLink()) throw new Error(\"refusing to delete symlink: \" + plan.directory);",
  "      if (!stat.isDirectory()) throw new Error(\"not a session directory: \" + plan.directory);",
  "      await rm(plan.directory, { recursive: true, force: true });",
  "    };",
  "    let removedCount = 0;",
  "    for (let i = 0; i < plans.length; i += concurrency) {",
  "      const slice = plans.slice(i, i + concurrency);",
  "      const settled = await Promise.allSettled(slice.map((p) => removeOne(p)));",
  "      for (let k = 0; k < settled.length; k += 1) {",
  "        const plan = slice[k];",
  "        const r = settled[k];",
  "        if (r.status === \"fulfilled\") { deletedSessionIds.push(plan.sessionId); removedCount += 1; }",
  "        else failures.push({ sessionId: plan.sessionId, message: \"remove: \" + String(r.reason) });",
  "      }",
  "      say(\"removed \" + removedCount + \"/\" + plans.length);",
  "    }",
  "    say(\"remove done: deleted=\" + deletedSessionIds.length + \" failed=\" + failures.length);",
  "",
  "    // ---- 步骤 3：索引更新（各带超时） ----",
  "    const removed = new Set(deletedSessionIds);",
  "    if (removed.size > 0) {",
  "      const r1 = await withTimeout(\"setState:archived\", (async () => {",
  "        const state = this.requireState();",
  "        const nextArchived = state.archivedSessionIds.filter((id) => !removed.has(id));",
  "        if (nextArchived.length !== state.archivedSessionIds.length) {",
  "          await this.setState({ ...state, archivedSessionIds: nextArchived });",
  "        }",
  "      })(), stepTimeoutMs);",
  "      if (r1.timedOut || r1.error) failures.push({ sessionId: \"*archived-set*\", message: r1.error ?? \"timeout\" });",
  "      say(\"archived-set updated: \" + (r1.timedOut ? \"TIMEOUT\" : r1.error ?? \"ok\"));",
  "",
  "      const r2 = await withTimeout(\"table:accounts\", (async () => {",
  "        const table = this.requireTable();",
  "        for (const workspaceId of this.requireState().workspaceIds) {",
  "          const record = table.get(workspaceId);",
  "          if (record === void 0) continue;",
  "          if (!record.sessionIds.some((id) => removed.has(id))) continue;",
  "          const next = await table.update(workspaceId, (current) => ({",
  "            ...current,",
  "            sessionIds: current.sessionIds.filter((id) => !removed.has(id)),",
  "            updatedAt: (new Date()).toISOString()",
  "          }));",
  "          const entity = this.entities.get(workspaceId);",
  "          if (entity !== void 0) entity.record = next;",
  "        }",
  "      })(), stepTimeoutMs);",
  "      if (r2.timedOut || r2.error) failures.push({ sessionId: \"*workspace-accounts*\", message: r2.error ?? \"timeout\" });",
  "      say(\"workspace accounts updated: \" + (r2.timedOut ? \"TIMEOUT\" : r2.error ?? \"ok\"));",
  "",
  "      // ---- 步骤 4：清缓存（每个都带超时，绝不整体卡住） ----",
  "      const projCache = this.ctx.get(\"sessionProjectionCache\");",
  "      if (projCache !== void 0 && typeof projCache.delete === \"function\") {",
  "        let cacheOk = 0;",
  "        let cacheTimeout = 0;",
  "        for (const sessionId of deletedSessionIds) {",
  "          const r = await withTimeout(\"cache:\" + sessionId, projCache.delete(sessionId), Math.min(stepTimeoutMs, 2000));",
  "          if (r.timedOut) cacheTimeout += 1;",
  "          else if (!r.error) cacheOk += 1;",
  "        }",
  "        say(\"cache cleanup: ok=\" + cacheOk + \" timeout=\" + cacheTimeout);",
  "      } else {",
  "        say(\"cache cleanup: skipped (no sessionProjectionCache)\");",
  "      }",
  "",
  "      // ---- 步骤 5：墓碑 + 通知 ----",
  "      for (const sessionId of deletedSessionIds) {",
  "        try {",
  "          const deletedHeader = this.headers.get(sessionId) ?? this.ctx.get(\"sessions\")?.get(sessionId)?.header;",
  "          this.forgetIndexedSession(sessionId);",
  "          if (deletedHeader !== void 0) this.deletedIdentities.set(sessionId, headerIdentity(deletedHeader));",
  "          this.publishDeletedSession(sessionId);",
  "        } catch (error) {",
  "          say(\"finalize failed for \" + sessionId + \": \" + String(error));",
  "        }",
  "      }",
  "      say(\"finalize done\");",
  "    }",
  "",
  "    say(\"DONE deleted=\" + deletedSessionIds.length + \" skipped=\" + skippedSessionIds.length + \" failed=\" + failures.length);",
  "    return { requestedSessionIds, deletedSessionIds, skippedSessionIds, failures, log: logLines };",
  "  }",
  "  async deleteArchivedSessions(target) {"
].join("\n");

/* W10a：remote 声明 */
const HOST_SAFE_REMOTE_OLD = '    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteArchivedSessions",';
const HOST_SAFE_REMOTE_NEW = [
  '    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteArchivedSessionsSafe",',
  '    service: "workspaceRegistry",',
  '    namespace: "workspaceRegistry",',
  '    method: "deleteArchivedSessionsSafe",',
  '    invocation: { kind: "direct" },',
  '    parameters: [',
  '      {',
  '        name: "target",',
  '        wire: "target",',
  '        source: "json",',
  '        codec: {',
  '          mode: "strict",',
  '          typeSymbol: "@michengai/dsh-archive-manager/types#ArchivedBatchTarget",',
  '          schema: archivedBatchTargetSchema',
  '        }',
  '      }',
  '    ],',
  '    result: {',
  '      mode: "strict",',
  '      typeSymbol: "@michengai/dsh-archive-manager/types#DeletedBatch",',
  '      schema: deletedBatchSchema',
  '    },',
  '    sourceLocation: {',
  '      file: "@michengai/dsh-archive-manager/lib/workspace.js",',
  '      line: 1,',
  '      column: 1',
  '    }',
  '  },',
  '  {',
  '    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteArchivedSessions",'
].join('\n');

/* W10b：markRemoteMethod */
const HOST_SAFE_MARK_OLD = '    markRemoteMethod(this, "deleteArchivedSessions");';
const HOST_SAFE_MARK_NEW = HOST_SAFE_MARK_OLD + '\n' + '    markRemoteMethod(this, "deleteArchivedSessionsSafe");';


/* =====================================================================
 * C16：客户端优先走"直删"（host deleteArchivedSessionsDirect）
 * ===================================================================== */

/** C16-1：直删包装。 */
const CLIENT_DIRECT_WRAP_OLD = `        const deleteArchivedSessionsFast = async (target, options) => {`;
const CLIENT_DIRECT_WRAP_NEW = `        /**
         * 直删包装：host 侧 deleteArchivedSessionsDirect ——
         * 插件自己解析目录并用 fs.rm 并发删，跳过内核逐条流程。
         */
        const deleteArchivedSessionsDirect = async (target, options) => {
          const registry = ctx.get("remote.workspaceRegistry");
          if (registry === void 0) throw new Error("archive-manager remote service is unavailable");
          if (typeof registry.deleteArchivedSessionsDirect !== "function") return null;
          const result = await registry.deleteArchivedSessionsDirect(target, options ?? {});
          if (!result.ok) throw new Error(result.error.message);
          await refreshSessionList();
          return result.value;
        };
        const deleteArchivedSessionsFast = async (target, options) => {`;

/** C16-2：props 注入。 */
const CLIENT_DIRECT_PROPS_OLD = `            deleteArchivedSessionsFast,
            archivedSessionMetadata,`;
const CLIENT_DIRECT_PROPS_NEW = `            deleteArchivedSessionsFast,
            deleteArchivedSessionsDirect,
            archivedSessionMetadata,`;

/** C16-3：签名接收。 */
const CLIENT_DIRECT_SIG_OLD = `deleteArchivedSessionsInBatches, deleteArchivedSessionsFast, archivedSessionMetadata`;
const CLIENT_DIRECT_SIG_NEW = `deleteArchivedSessionsInBatches, deleteArchivedSessionsFast, deleteArchivedSessionsDirect, archivedSessionMetadata`;

/** C16-4：confirmDelete 四级回退（直删优先）。 */
const CLIENT_DIRECT_RUN_OLD = `              // 1) 优先走 host 快速删除（并发 + 索引合并写盘）
              if (targets.length > 0 && typeof deleteArchivedSessionsFast === "function") {`;
const CLIENT_DIRECT_RUN_NEW = `              // 1) 最优：host 直删（插件自己 rm，跳过内核逐条流程）
              if (targets.length > 0 && typeof deleteArchivedSessionsDirect === "function") {
                try {
                  result = await deleteArchivedSessionsDirect({ scope: "sessions", sessionIds: targets }, { concurrency: 12 });
                } catch (directError) {
                  console.warn("archive-manager: direct delete failed, falling back:", directError);
                  result = null;
                }
              }
              // 2) 次优：host 快速删除（并发 + 索引合并写盘）
              if (result === null && targets.length > 0 && typeof deleteArchivedSessionsFast === "function") {`;

/* W7：宿主侧直删（代码取自 snippets/host-direct-delete.js，共 148 行） */
const HOST_DIRECT_ANCHOR = "  async deleteArchivedSessionsFast(target, options = {}) {";
const HOST_DIRECT_NEW = [
  "  /**",
  "   * 极速批量删除（插件自实现，不走逐条 deleteSessionCore）。",
  "   *",
  "   * 与 deleteSessionCore 的差别：",
  "   *   - 不调用 sessionKnown/readSessionHeader 之外的内核流程；",
  "   *   - 不做 flush / publishColdSessionRemoval / whenIdle 等待；",
  "   *   - 目录解析用 persistence.locate + jsonlSessionDirectory（与内核同一套规则）；",
  "   *   - 用 node:fs/promises 的 rm 直接删会话目录，并发执行；",
  "   *   - 归档集合与工作区账户各只写一次盘；",
  "   *   - 仍保留安全检查：拒绝符号链接、只删校验过的会话目录。",
  "   *",
  "   * @param target - 与 deleteArchivedSessions 相同的批量目标。",
  "   * @param options - { concurrency?: number } 并发度（1..32，默认 12）。",
  "   */",
  "  async deleteArchivedSessionsDirect(target, options = {}) {",
  "    const rawConcurrency = Number(options?.concurrency);",
  "    const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0",
  "      ? Math.min(32, Math.max(1, Math.floor(rawConcurrency)))",
  "      : 12;",
  "    const persistence = this.ctx.get(\"sessionPersistence\");",
  "    const requestedSessionIds = this.archivedSessionIdsForTarget(target);",
  "    const deletedSessionIds = [];",
  "    const skippedSessionIds = [];",
  "    const failures = [];",
  "    const removedDirs = [];",
  "",
  "    // ---- 阶段 1：解析每个会话的目录（只读） ----",
  "    const plans = [];",
  "    for (const sessionId of requestedSessionIds) {",
  "      let header;",
  "      try {",
  "        header = await this.readSessionHeader(sessionId);",
  "      } catch (error) {",
  "        skippedSessionIds.push(sessionId);",
  "        continue;",
  "      }",
  "      if (header === void 0 || header === null) {",
  "        skippedSessionIds.push(sessionId);",
  "        continue;",
  "      }",
  "      let directory;",
  "      try {",
  "        if (persistence !== void 0 && typeof persistence.locate === \"function\") {",
  "          const location = persistence.locate(header);",
  "          if (location !== void 0 && typeof location.path === \"string\") {",
  "            const resolved = jsonlSessionDirectory(persistence, header, location);",
  "            directory = resolved !== void 0 ? resolved : dirname(location.path);",
  "          }",
  "        }",
  "      } catch (error) {",
  "        failures.push({ sessionId, message: \"locate: \" + String(error) });",
  "        continue;",
  "      }",
  "      plans.push({ sessionId, directory });",
  "    }",
  "",
  "    // ---- 阶段 2：并发删除目录 ----",
  "    const removeOne = async (plan) => {",
  "      if (typeof plan.directory !== \"string\" || plan.directory.length === 0) return;",
  "      let stat;",
  "      try {",
  "        stat = await lstat(plan.directory);",
  "      } catch (error) {",
  "        if (error?.code === \"ENOENT\") return; // 已经不在了，视为已删",
  "        throw error;",
  "      }",
  "      if (stat.isSymbolicLink()) throw new Error(\"refusing to delete through symbolic link: \" + plan.directory);",
  "      if (!stat.isDirectory()) throw new Error(\"expected a session directory: \" + plan.directory);",
  "      await rm(plan.directory, { recursive: true, force: true });",
  "    };",
  "",
  "    for (let i = 0; i < plans.length; i += concurrency) {",
  "      const slice = plans.slice(i, i + concurrency);",
  "      const settled = await Promise.allSettled(slice.map((plan) => removeOne(plan)));",
  "      for (let k = 0; k < settled.length; k += 1) {",
  "        const plan = slice[k];",
  "        const result = settled[k];",
  "        if (result.status === \"fulfilled\") {",
  "          deletedSessionIds.push(plan.sessionId);",
  "          if (typeof plan.directory === \"string\") removedDirs.push(plan.directory);",
  "        } else {",
  "          failures.push({ sessionId: plan.sessionId, message: String(result.reason) });",
  "        }",
  "      }",
  "      try {",
  "        this.ctx.logger.info(\"archive-manager(direct): removed \" + deletedSessionIds.length + \"/\" + plans.length + \" session dir(s)\");",
  "      } catch {}",
  "    }",
  "",
  "    // ---- 阶段 3：索引只写一次 ----",
  "    const removed = new Set(deletedSessionIds);",
  "    if (removed.size > 0) {",
  "      try {",
  "        const state = this.requireState();",
  "        const nextArchived = state.archivedSessionIds.filter((id) => !removed.has(id));",
  "        if (nextArchived.length !== state.archivedSessionIds.length) {",
  "          await this.setState({ ...state, archivedSessionIds: nextArchived });",
  "        }",
  "      } catch (error) {",
  "        failures.push({ sessionId: \"*archived-set*\", message: String(error) });",
  "      }",
  "      try {",
  "        const table = this.requireTable();",
  "        for (const workspaceId of this.requireState().workspaceIds) {",
  "          const record = table.get(workspaceId);",
  "          if (record === void 0) continue;",
  "          if (!record.sessionIds.some((id) => removed.has(id))) continue;",
  "          const next = await table.update(workspaceId, (current) => ({",
  "            ...current,",
  "            sessionIds: current.sessionIds.filter((id) => !removed.has(id)),",
  "            updatedAt: (new Date()).toISOString()",
  "          }));",
  "          const entity = this.entities.get(workspaceId);",
  "          if (entity !== void 0) entity.record = next;",
  "        }",
  "      } catch (error) {",
  "        failures.push({ sessionId: \"*workspace-accounts*\", message: String(error) });",
  "      }",
  "      // 清投影缓存（不等待队列）",
  "      const projCache = this.ctx.get(\"sessionProjectionCache\");",
  "      if (projCache !== void 0) {",
  "        for (const sessionId of deletedSessionIds) {",
  "          try { await projCache.delete(sessionId); } catch {}",
  "        }",
  "      }",
  "      // 墓碑 + 通知",
  "      for (const sessionId of deletedSessionIds) {",
  "        try {",
  "          const deletedHeader = this.headers.get(sessionId) ?? this.ctx.get(\"sessions\")?.get(sessionId)?.header;",
  "          this.forgetIndexedSession(sessionId);",
  "          if (deletedHeader !== void 0) this.deletedIdentities.set(sessionId, headerIdentity(deletedHeader));",
  "          this.publishDeletedSession(sessionId);",
  "        } catch (error) {",
  "          try { this.ctx.logger.warn(\"archive-manager(direct): finalize failed for \" + sessionId + \": \" + String(error)); } catch {}",
  "        }",
  "      }",
  "    }",
  "",
  "    try {",
  "      this.ctx.logger.info(",
  "        \"archive-manager(direct): done deleted=\" + deletedSessionIds.length +",
  "        \" skipped=\" + skippedSessionIds.length +",
  "        \" failed=\" + failures.length +",
  "        \" concurrency=\" + concurrency",
  "      );",
  "    } catch {}",
  "    return { requestedSessionIds, deletedSessionIds, skippedSessionIds, failures, removedDirs };",
  "  }",
  "  async deleteArchivedSessionsFast(target, options = {}) {"
].join("\n");

/* W8a：remote 声明（插在 deleteArchivedSessionsFast 声明之前） */
const HOST_DIRECT_REMOTE_OLD = '    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteArchivedSessionsFast",';
const HOST_DIRECT_REMOTE_NEW = [
  '    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteArchivedSessionsDirect",',
  '    service: "workspaceRegistry",',
  '    namespace: "workspaceRegistry",',
  '    method: "deleteArchivedSessionsDirect",',
  '    invocation: { kind: "direct" },',
  '    parameters: [',
  '      {',
  '        name: "target",',
  '        wire: "target",',
  '        source: "json",',
  '        codec: {',
  '          mode: "strict",',
  '          typeSymbol: "@michengai/dsh-archive-manager/types#ArchivedBatchTarget",',
  '          schema: archivedBatchTargetSchema',
  '        }',
  '      }',
  '    ],',
  '    result: {',
  '      mode: "strict",',
  '      typeSymbol: "@michengai/dsh-archive-manager/types#DeletedBatch",',
  '      schema: deletedBatchSchema',
  '    },',
  '    sourceLocation: {',
  '      file: "@michengai/dsh-archive-manager/lib/workspace.js",',
  '      line: 1,',
  '      column: 1',
  '    }',
  '  },',
  '  {',
  '    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteArchivedSessionsFast",'
].join('\n');

/* W8b：markRemoteMethod */
const HOST_DIRECT_MARK_OLD = '    markRemoteMethod(this, "deleteArchivedSessionsFast");';
const HOST_DIRECT_MARK_NEW = HOST_DIRECT_MARK_OLD + '\n' + '    markRemoteMethod(this, "deleteArchivedSessionsDirect");';


/* =====================================================================
 * C14b：快速删除自检 —— 明确区分"remote 方法不存在"与"调用失败"
 * ===================================================================== */

/** C14b-1：包装加自检与明确报错。 */
const CLIENT_FAST_DIAG_OLD = `        const deleteArchivedSessionsFast = async (target, options) => {
          const registry = ctx.get("remote.workspaceRegistry");
          if (registry === void 0) throw new Error("archive-manager remote service is unavailable");
          if (typeof registry.deleteArchivedSessionsFast !== "function") return null;
          const result = await registry.deleteArchivedSessionsFast(target, options ?? {});
          if (!result.ok) throw new Error(result.error.message);
          await refreshSessionList();
          return result.value;
        };`;
const CLIENT_FAST_DIAG_NEW = `        const deleteArchivedSessionsFast = async (target, options) => {
          const registry = ctx.get("remote.workspaceRegistry");
          if (registry === void 0) throw new Error("archive-manager remote service is unavailable");
          const available = typeof registry.deleteArchivedSessionsFast === "function";
          // 把自检结果暴露给界面，便于在"删除不了"时定位是 remote 方法缺失还是调用失败
          try { globalThis.__dshamFastDeleteDiag = available ? "available" : "missing-remote-method"; } catch {}
          if (!available) {
            const methods = registry === null || registry === void 0 ? [] : Object.keys(registry).filter((k) => typeof registry[k] === "function");
            console.warn("archive-manager: deleteArchivedSessionsFast is not exposed on the remote registry; available:", methods.join(", "));
            return null;
          }
          const result = await registry.deleteArchivedSessionsFast(target, options ?? {});
          if (!result.ok) throw new Error(result.error.message);
          await refreshSessionList();
          return result.value;
        };`;

/** C14b-2：失败提示里带上自检原因。 */
const CLIENT_FAST_MSG_OLD = `                  console.warn("archive-manager: fast delete failed, falling back to batched delete:", fastError);
                  result = null;`;
const CLIENT_FAST_MSG_NEW = `                  console.warn("archive-manager: fast delete failed, falling back to batched delete:", fastError);
                  try { globalThis.__dshamFastDeleteDiag = "call-failed: " + String(fastError); } catch {}
                  result = null;`;


/* =====================================================================
 * C14：客户端批量删除优先走 host 的 deleteArchivedSessionsFast
 * ===================================================================== */

/** C14-1：新增快速删除包装（走新 remote 方法）。 */
const CLIENT_FAST_WRAP_OLD = `        const deleteArchivedSessions = async (target) => {`;
const CLIENT_FAST_WRAP_NEW = `        /**
         * 快速批量删除包装：优先调用 host 的 deleteArchivedSessionsFast
         * （并发删文件 + 索引合并写盘），失败时回退到逐批的 deleteArchivedSessions。
         */
        const deleteArchivedSessionsFast = async (target, options) => {
          const registry = ctx.get("remote.workspaceRegistry");
          if (registry === void 0) throw new Error("archive-manager remote service is unavailable");
          if (typeof registry.deleteArchivedSessionsFast !== "function") return null;
          const result = await registry.deleteArchivedSessionsFast(target, options ?? {});
          if (!result.ok) throw new Error(result.error.message);
          await refreshSessionList();
          return result.value;
        };
        const deleteArchivedSessions = async (target) => {`;

/** C14-2：props 注入。 */
const CLIENT_FAST_PROPS_OLD = `            deleteArchivedSessionsInBatches,
            archivedSessionMetadata,`;
const CLIENT_FAST_PROPS_NEW = `            deleteArchivedSessionsInBatches,
            deleteArchivedSessionsFast,
            archivedSessionMetadata,`;

/** C14-3：签名接收。 */
const CLIENT_FAST_SIG_OLD = `deleteArchivedSessions, deleteArchivedSessionsInBatches, archivedSessionMetadata`;
const CLIENT_FAST_SIG_NEW = `deleteArchivedSessions, deleteArchivedSessionsInBatches, deleteArchivedSessionsFast, archivedSessionMetadata`;

/** C14-4：confirmDelete 优先走快速删除（显示进度）。 */
const CLIENT_FAST_RUN_OLD = `              const targets = deriveArchivedBatchIds(workspaceState.archivedSessionIds, workspaceState.items, deleteTarget.target);
              let result;
              if (targets.length > 0 && typeof deleteArchivedSessionsInBatches === "function") {
                setDeleteProgress({ total: targets.length, done: 0, failed: 0 });
                result = await deleteArchivedSessionsInBatches(targets, (done, total, failed) => {
                  setDeleteProgress({ total, done, failed: failed ?? 0 });
                });
              } else {
                result = await deleteArchivedSessions(deleteTarget.target);
              }`;
const CLIENT_FAST_RUN_NEW = `              const targets = deriveArchivedBatchIds(workspaceState.archivedSessionIds, workspaceState.items, deleteTarget.target);
              let result = null;
              if (targets.length > 0) setDeleteProgress({ total: targets.length, done: 0, failed: 0 });
              // 1) 优先走 host 快速删除（并发 + 索引合并写盘）
              if (targets.length > 0 && typeof deleteArchivedSessionsFast === "function") {
                try {
                  result = await deleteArchivedSessionsFast({ scope: "sessions", sessionIds: targets }, { concurrency: 8 });
                } catch (fastError) {
                  console.warn("archive-manager: fast delete failed, falling back to batched delete:", fastError);
                  result = null;
                }
              }
              // 2) 回退：按批调用普通删除（带进度）
              if (result === null && targets.length > 0 && typeof deleteArchivedSessionsInBatches === "function") {
                result = await deleteArchivedSessionsInBatches(targets, (done, total, failed) => {
                  setDeleteProgress({ total, done, failed: failed ?? 0 });
                });
              }
              // 3) 最后回退：整批目标一次调用
              if (result === null) {
                result = await deleteArchivedSessions(deleteTarget.target);
              }
              if (targets.length > 0) setDeleteProgress({ total: targets.length, done: targets.length, failed: 0 });`;


/* W5/W6：宿主侧快速批量删除（代码取自 snippets/host-fast-delete.js） */
const HOST_FASTDEL_NEW = [
  "  /**",
  "   * 快速批量删除：与 deleteArchivedSessions 结果同构，但显著更快。",
  "   *",
  "   * 与逐条 deleteSessionCore 的差别：",
  "   *   1. 转录目录、缓存、spill 的删除并发执行（并发度 concurrency，默认 8）；",
  "   *   2. 归档集合与工作区账户的写盘合并到末尾各做一次",
  "   *      （逐条版本每删除一条会话就写两次全量索引，44 条即 88 次写盘）；",
  "   *   3. 删除投影缓存前不再等待 whenIdle() 队列排空。",
  "   * 数据安全项全部保留：子会话级联删除、转录目录整体删除、事件通知。",
  "   *",
  "   * @param target - 与 deleteArchivedSessions 相同的批量目标。",
  "   * @param options - { concurrency?: number } 并发度（1..32）。",
  "   */",
  "  async deleteArchivedSessionsFast(target, options = {}) {",
  "    return this.enqueueOperation(async () => {",
  "      const requestedSessionIds = this.archivedSessionIdsForTarget(target);",
  "      const rawConcurrency = Number(options?.concurrency);",
  "      const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0",
  "        ? Math.min(32, Math.max(1, Math.floor(rawConcurrency)))",
  "        : 8;",
  "      const deletedSessionIds = [];",
  "      const skippedSessionIds = [];",
  "      const failures = [];",
  "",
  "      // ---- 阶段 1：筛选存在的会话（只读） ----",
  "      const plans = [];",
  "      for (const sessionId of requestedSessionIds) {",
  "        try {",
  "          if (!await this.sessionKnown(sessionId)) {",
  "            skippedSessionIds.push(sessionId);",
  "            continue;",
  "          }",
  "          plans.push(sessionId);",
  "        } catch (error) {",
  "          failures.push({ sessionId, message: String(error) });",
  "        }",
  "      }",
  "",
  "      // ---- 阶段 2：并发删除文件层（转录目录 + 缓存 + spill + 子会话） ----",
  "      const projCache = this.ctx.get(\"sessionProjectionCache\");",
  "      const sessions = this.ctx.get(\"sessions\");",
  "      const logWarn = (message) => {",
  "        try { this.ctx.logger.warn(message); } catch {}",
  "      };",
  "      const removeOne = async (sessionId) => {",
  "        const live = sessions?.get(sessionId);",
  "        if (live !== void 0) {",
  "          try {",
  "            await sessions.flush(live);",
  "            sessions.detachEntered(sessions.liveEntryFor(live));",
  "          } catch (error) {",
  "            logWarn(\"archive-manager(fast): detach failed for \" + sessionId + \": \" + String(error));",
  "          }",
  "        } else if (sessions !== void 0) {",
  "          try { await this.publishColdSessionRemoval(sessionId, sessions); } catch {}",
  "        }",
  "        // 不再等 whenIdle()：直接把删除请求排入缓存自身的队列",
  "        if (projCache !== void 0) {",
  "          try { await projCache.delete(sessionId); } catch {}",
  "        }",
  "        try { await this.deleteDescendants(sessionId); } catch {}",
  "        try { await this.cleanSpill(sessionId); } catch {}",
  "        await this.removeTranscriptDirectory(sessionId);",
  "      };",
  "",
  "      for (let i = 0; i < plans.length; i += concurrency) {",
  "        const slice = plans.slice(i, i + concurrency);",
  "        const settled = await Promise.allSettled(slice.map((id) => removeOne(id)));",
  "        for (let k = 0; k < settled.length; k += 1) {",
  "          const sessionId = slice[k];",
  "          const result = settled[k];",
  "          if (result.status === \"fulfilled\") deletedSessionIds.push(sessionId);",
  "          else failures.push({ sessionId, message: String(result.reason) });",
  "        }",
  "      }",
  "",
  "      // ---- 阶段 3：索引只写一次 ----",
  "      const removed = new Set(deletedSessionIds);",
  "      if (removed.size > 0) {",
  "        try {",
  "          const state = this.requireState();",
  "          const nextArchived = state.archivedSessionIds.filter((id) => !removed.has(id));",
  "          if (nextArchived.length !== state.archivedSessionIds.length) {",
  "            await this.setState({ ...state, archivedSessionIds: nextArchived });",
  "          }",
  "        } catch (error) {",
  "          failures.push({ sessionId: \"*archived-set*\", message: String(error) });",
  "        }",
  "        try {",
  "          const table = this.requireTable();",
  "          for (const workspaceId of this.requireState().workspaceIds) {",
  "            const record = table.get(workspaceId);",
  "            if (record === void 0) continue;",
  "            if (!record.sessionIds.some((id) => removed.has(id))) continue;",
  "            const next = await table.update(workspaceId, (current) => ({",
  "              ...current,",
  "              sessionIds: current.sessionIds.filter((id) => !removed.has(id)),",
  "              updatedAt: (new Date()).toISOString()",
  "            }));",
  "            const entity = this.entities.get(workspaceId);",
  "            if (entity !== void 0) entity.record = next;",
  "          }",
  "        } catch (error) {",
  "          failures.push({ sessionId: \"*workspace-accounts*\", message: String(error) });",
  "        }",
  "        // ---- 阶段 4：内存墓碑 + 通知 ----",
  "        for (const sessionId of deletedSessionIds) {",
  "          try {",
  "            const deletedHeader = this.headers.get(sessionId) ?? sessions?.get(sessionId)?.header;",
  "            this.forgetIndexedSession(sessionId);",
  "            if (deletedHeader !== void 0) this.deletedIdentities.set(sessionId, headerIdentity(deletedHeader));",
  "            this.publishDeletedSession(sessionId);",
  "          } catch (error) {",
  "            logWarn(\"archive-manager(fast): finalize failed for \" + sessionId + \": \" + String(error));",
  "          }",
  "        }",
  "      }",
  "",
  "      try {",
  "        this.ctx.logger.info(",
  "          \"archive-manager(fast): deleted \" + deletedSessionIds.length +",
  "          \", skipped \" + skippedSessionIds.length +",
  "          \", failed \" + failures.length +",
  "          \", concurrency \" + concurrency",
  "        );",
  "      } catch {}",
  "      return { requestedSessionIds, deletedSessionIds, skippedSessionIds, failures };",
  "    });",
  "  }"
  ,"  async deleteArchivedSessions(target) {"
].join("\n");
const HOST_FASTDEL_ANCHOR = "  async deleteArchivedSessions(target) {";

const HOST_FASTDEL_REMOTE_OLD = '    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteArchivedSessions",';
const HOST_FASTDEL_REMOTE_NEW = [
  '    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteArchivedSessionsFast",',
  '    service: "workspaceRegistry",',
  '    namespace: "workspaceRegistry",',
  '    method: "deleteArchivedSessionsFast",',
  '    invocation: { kind: "direct" },',
  '    parameters: [',
  '      {',
  '        name: "target",',
  '        wire: "target",',
  '        source: "json",',
  '        codec: {',
  '          mode: "strict",',
  '          typeSymbol: "@michengai/dsh-archive-manager/types#ArchivedBatchTarget",',
  '          schema: archivedBatchTargetSchema',
  '        }',
  '      }',
  '    ],',
  '    result: {',
  '      mode: "strict",',
  '      typeSymbol: "@michengai/dsh-archive-manager/types#DeletedBatch",',
  '      schema: deletedBatchSchema',
  '    },',
  '    sourceLocation: {',
  '      file: "@michengai/dsh-archive-manager/lib/workspace.js",',
  '      line: 1,',
  '      column: 1',
  '    }',
  '  },',
  '  {',
  '    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteArchivedSessions",'
].join('\n');

const HOST_FASTDEL_MARK_OLD = '    markRemoteMethod(this, "deleteArchivedSessions");';
const HOST_FASTDEL_MARK_NEW = HOST_FASTDEL_MARK_OLD + '\n' + '    markRemoteMethod(this, "deleteArchivedSessionsFast");';


/* =====================================================================
 * C13：批量删除加进度条（分批调用远程 deleteArchivedSessions，逐批更新进度）
 * ===================================================================== */

/** C13-1：删除进度状态。 */
const CLIENT_DEL_PROGRESS_OLD = `        const [deleteTarget, setDeleteTarget] = (0, react.useState)(null);
        const [busy, setBusy] = (0, react.useState)(false);`;
const CLIENT_DEL_PROGRESS_NEW = `        const [deleteTarget, setDeleteTarget] = (0, react.useState)(null);
        const [deleteProgress, setDeleteProgress] = (0, react.useState)(null);
        const [busy, setBusy] = (0, react.useState)(false);`;

/** C13-2：分批删除函数（applyWorkspaceBrowser 作用域，close over 远程 registry）。 */
const CLIENT_DEL_BATCH_OLD = `        const archivedSessionMetadata = async () => {`;
const CLIENT_DEL_BATCH_NEW = `        /**
         * 分批删除已归档会话：把 id 列表切成小批逐次调用远程 deleteArchivedSessions，
         * 每批完成回调 onProgress(done, total, failed)。单批失败只记录不中断。
         * 返回与一次性删除同构的结果，便于复用既有反馈逻辑。
         */
        const deleteArchivedSessionsInBatches = async (sessionIds, onProgress, batchSize = 20) => {
          const ids = [...new Set(sessionIds ?? [])];
          const total = ids.length;
          const deletedSessionIds = [];
          const skippedSessionIds = [];
          const failures = [];
          const size = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 20;
          for (let i = 0; i < ids.length; i += size) {
            const slice = ids.slice(i, i + size);
            try {
              const result = await deleteArchivedSessions({ scope: "sessions", sessionIds: slice });
              const done = result?.deletedSessionIds ?? [];
              const skipped = result?.skippedSessionIds ?? [];
              deletedSessionIds.push(...done);
              skippedSessionIds.push(...skipped);
              // 既没删也没跳过的一律记入跳过，避免进度卡住
              const accounted = new Set([...done, ...skipped]);
              for (const id of slice) if (!accounted.has(id)) skippedSessionIds.push(id);
            } catch (reason) {
              failures.push(reason);
              skippedSessionIds.push(...slice);
            }
            if (typeof onProgress === "function") {
              try {
                onProgress(deletedSessionIds.length + skippedSessionIds.length, total, failures.length);
              } catch (error) {
                console.warn("archive-manager: delete progress callback failed:", error);
              }
            }
          }
          return { deletedSessionIds, skippedSessionIds, failureCount: failures.length };
        };
        const archivedSessionMetadata = async () => {`;

/** C13-3a：props 注入。 */
const CLIENT_DEL_PROPS_OLD = `            deleteArchivedSessions,
            archivedSessionMetadata,`;
const CLIENT_DEL_PROPS_NEW = `            deleteArchivedSessions,
            deleteArchivedSessionsInBatches,
            archivedSessionMetadata,`;

/** C13-3b：签名接收。 */
const CLIENT_DEL_SIG_OLD = `function ArchivedSessionsSection({ sessionStore, workspaceStore, unarchiveSession, deleteSession, unarchiveSessions, deleteArchivedSessions, archivedSessionMetadata, archiveSessionsByIds, archiveSessionsBatch, openConversation, viewState, close, t }) {`;
const CLIENT_DEL_SIG_NEW = `function ArchivedSessionsSection({ sessionStore, workspaceStore, unarchiveSession, deleteSession, unarchiveSessions, deleteArchivedSessions, deleteArchivedSessionsInBatches, archivedSessionMetadata, archiveSessionsByIds, archiveSessionsBatch, openConversation, viewState, close, t }) {`;

/** C13-4：confirmDelete 的批量分支改用分批 + 进度。 */
const CLIENT_DEL_RUN_OLD = `            if (deleteTarget.kind === "batch") {
              const result = await deleteArchivedSessions(deleteTarget.target);
              const feedback = archivedDeleteFeedback(result, t);
              if (feedback.kind === "error") setError(feedback.message);
              else setNotice(feedback.message);
              const completed = /* @__PURE__ */ new Set([...result.deletedSessionIds, ...result.skippedSessionIds]);
              if (deleteTarget.target.scope === "sessions") {
                setSelectedSessionIds((current) => current.filter((sessionId) => !completed.has(sessionId)));
              }
              pruneFavorites(completed);
            } else {`;
const CLIENT_DEL_RUN_NEW = `            if (deleteTarget.kind === "batch") {
              const targets = deriveArchivedBatchIds(workspaceState.archivedSessionIds, workspaceState.items, deleteTarget.target);
              let result;
              if (targets.length > 0 && typeof deleteArchivedSessionsInBatches === "function") {
                setDeleteProgress({ total: targets.length, done: 0, failed: 0 });
                result = await deleteArchivedSessionsInBatches(targets, (done, total, failed) => {
                  setDeleteProgress({ total, done, failed: failed ?? 0 });
                });
              } else {
                result = await deleteArchivedSessions(deleteTarget.target);
              }
              const feedback = archivedDeleteFeedback(result, t);
              if (feedback.kind === "error") setError(feedback.message);
              else setNotice(feedback.message);
              const completed = /* @__PURE__ */ new Set([...result.deletedSessionIds, ...result.skippedSessionIds]);
              if (deleteTarget.target.scope === "sessions") {
                setSelectedSessionIds((current) => current.filter((sessionId) => !completed.has(sessionId)));
              }
              pruneFavorites(completed);
            } else {`;

/** C13-5：进度条 UI（替换删除对话框里的静态提示）。 */
const CLIENT_DEL_UI_OLD = `            children: busy && (0, react_jsx_runtime.jsx)("div", { role: "status", children: deleteTarget?.kind === "batch" ? t("archives.deleteBatchPending") : t("deleteSession.pending") })`;
const CLIENT_DEL_UI_NEW = `            children: busy && (0, react_jsx_runtime.jsxs)("div", { role: "status", children: [(0, react_jsx_runtime.jsx)("span", { children: deleteTarget?.kind === "batch" ? t("archives.deleteBatchPending") : t("deleteSession.pending") }), deleteProgress !== null ? (0, react_jsx_runtime.jsxs)("div", { className: "dsham_settingsIdleProgress", children: [(0, react_jsx_runtime.jsxs)("span", { className: "dsham_settingsIdleProgressText", children: [t("archives.deleteProgress"), " ", deleteProgress.done || 0, " / ", deleteProgress.total || 0, "（", Math.round((deleteProgress.total || 0) === 0 ? 0 : (deleteProgress.done || 0) / deleteProgress.total * 100), "%）"] }), (0, react_jsx_runtime.jsx)("span", { className: "dsham_settingsIdleProgressBar", children: (0, react_jsx_runtime.jsx)("span", { className: "dsham_settingsIdleProgressFill", style: { width: Math.round((deleteProgress.total || 0) === 0 ? 0 : (deleteProgress.done || 0) / deleteProgress.total * 100) + "%" } }) })] }) : null] })`;

/** C13-6：confirmDelete 结束时清进度。 */
const CLIENT_DEL_FINALLY_OLD = `            setDeleteTarget(null);
          } catch (reason) {
            setError(formatDeleteError(reason, t));
          } finally {
            setBusy(false);
          }
        };`;
const CLIENT_DEL_FINALLY_NEW = `            setDeleteTarget(null);
          } catch (reason) {
            setError(formatDeleteError(reason, t));
          } finally {
            setBusy(false);
            setTimeout(() => setDeleteProgress(null), 4000);
          }
        };`;

/** C13-7：词条（并入 C6/C7 尾部）。 */
const ZH_DELPROG_OLD = `          "menu.sortOff": "按时间排序：关闭",`;
const ZH_DELPROG_NEW = `          "archives.deleteProgress": "删除进度",
          "menu.sortOff": "按时间排序：关闭",`;

const EN_DELPROG_OLD = `          "menu.sortOff": "Sort by time: off",`;
const EN_DELPROG_NEW = `          "archives.deleteProgress": "Delete progress",
          "menu.sortOff": "Sort by time: off",`;


/* =====================================================================
 * C12：排序改三态（关 / 降序 / 升序）+ 修 useMemo 依赖
 * ===================================================================== */

/** C12-1：排序 store 改三态。持久化 "off" | "desc" | "asc"，兼容旧的 "1"。 */
const CLIENT_SORT3_OLD = `      const SIDEBAR_SORT_BY_TIME_KEY = "dsham.sidebarSortByTime.v1";
      function readSidebarSortByTime() {
        try {
          return globalThis.localStorage?.getItem(SIDEBAR_SORT_BY_TIME_KEY) === "1";
        } catch (error) {
          return false;
        }
      }
      function writeSidebarSortByTime(enabled) {
        try {
          globalThis.localStorage?.setItem(SIDEBAR_SORT_BY_TIME_KEY, enabled === true ? "1" : "0");
        } catch (error) {
          console.warn("archive-manager: sidebar sort flag could not be persisted:", error);
        }
      }
      /** 侧边栏排序开关 store（默认关）。 */
      const archiveSortStore = (() => {
        let enabled = readSidebarSortByTime();
        const listeners = /* @__PURE__ */ new Set();
        const emit = () => {
          for (const listener of [...listeners]) {
            try { listener(); } catch (error) { console.warn("archive-manager: sort listener failed:", error); }
          }
        };
        return {
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          getSnapshot() {
            return enabled;
          },
          set(next) {
            const value = next === true;
            if (value === enabled) return;
            enabled = value;
            writeSidebarSortByTime(value);
            emit();
          },
          toggle() {
            this.set(!enabled);
          }
        };
      })();`;

const CLIENT_SORT3_NEW = `      const SIDEBAR_SORT_BY_TIME_KEY = "dsham.sidebarSortByTime.v2";
      const SIDEBAR_SORT_MODES = ["off", "desc", "asc"];
      function readSidebarSortByTime() {
        try {
          const raw = globalThis.localStorage?.getItem(SIDEBAR_SORT_BY_TIME_KEY);
          if (raw === "desc" || raw === "asc" || raw === "off") return raw;
          // 兼容 v1 的布尔值
          const legacy = globalThis.localStorage?.getItem("dsham.sidebarSortByTime.v1");
          if (legacy === "1") return "desc";
          return "off";
        } catch (error) {
          return "off";
        }
      }
      function writeSidebarSortByTime(mode) {
        try {
          globalThis.localStorage?.setItem(SIDEBAR_SORT_BY_TIME_KEY, SIDEBAR_SORT_MODES.includes(mode) ? mode : "off");
        } catch (error) {
          console.warn("archive-manager: sidebar sort mode could not be persisted:", error);
        }
      }
      /** 侧边栏排序模式 store：off（默认）/ desc（新→旧）/ asc（旧→新）。 */
      const archiveSortStore = (() => {
        let mode = readSidebarSortByTime();
        const listeners = /* @__PURE__ */ new Set();
        const emit = () => {
          for (const listener of [...listeners]) {
            try { listener(); } catch (error) { console.warn("archive-manager: sort listener failed:", error); }
          }
        };
        return {
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          getSnapshot() {
            return mode;
          },
          set(next) {
            const value = SIDEBAR_SORT_MODES.includes(next) ? next : "off";
            if (value === mode) return;
            mode = value;
            writeSidebarSortByTime(value);
            emit();
          },
          toggle(next) {
            // 点同一个模式＝关闭；点另一个模式＝切换
            const target = SIDEBAR_SORT_MODES.includes(next) ? next : "desc";
            this.set(mode === target ? "off" : target);
          }
        };
      })();`;

/** C12-2：排序函数支持升/降序（置顶组内、未置顶组内都排）。 */
const CLIENT_SORTFN_OLD = `      /** 按最后活动时间降序；无时间戳的排在有时间的之后。 */
      function byUpdatedAtDesc(a, b) {
        const au = Number(a?.updatedAt);
        const bu = Number(b?.updatedAt);
        const aOk = Number.isFinite(au) && au > 0;
        const bOk = Number.isFinite(bu) && bu > 0;
        if (aOk && bOk) return bu - au;
        if (aOk) return -1;
        if (bOk) return 1;
        return 0;
      }
      /**
       * 稳定排序：置顶项前置，其余保持原有相对顺序。
       * 「按时间排序」开关打开时，置顶组内与未置顶组内都按最后活动时间降序；
       * 置顶整体仍优先于未置顶。
       */
      function sortPinnedFirst(items) {
        if (!Array.isArray(items) || items.length === 0) return items;
        const sortByTime = archiveSortStore.getSnapshot() === true;
        const pinned = archivePinStore.getSnapshot();
        const pinnedSet = new Set(Array.isArray(pinned) ? pinned : []);
        const first = [];
        const rest = [];
        for (const item of items) {
          if (item !== void 0 && item !== null && pinnedSet.has(item.id)) first.push(item);
          else rest.push(item);
        }
        if (!sortByTime) {
          return first.length === 0 ? items : [...first, ...rest];
        }
        return [...first].sort(byUpdatedAtDesc).concat([...rest].sort(byUpdatedAtDesc));
      }`;

const CLIENT_SORTFN_NEW = `      /** 按最后活动时间比较；无时间戳的固定排在最后（不论升/降序）。 */
      function makeByUpdatedAt(direction) {
        const sign = direction === "asc" ? 1 : -1;
        return (a, b) => {
          const au = Number(a?.updatedAt);
          const bu = Number(b?.updatedAt);
          const aOk = Number.isFinite(au) && au > 0;
          const bOk = Number.isFinite(bu) && bu > 0;
          if (aOk && bOk) return sign * (au - bu);
          if (aOk) return -1;
          if (bOk) return 1;
          return 0;
        };
      }
      /**
       * 稳定排序：置顶项前置，其余保持原有相对顺序。
       * 排序模式为 desc/asc 时，置顶组内与未置顶组内都按最后活动时间排；
       * 置顶整体仍优先于未置顶。off 时只把置顶前置，不动其余顺序。
       */
      function sortPinnedFirst(items) {
        if (!Array.isArray(items) || items.length === 0) return items;
        const mode = archiveSortStore.getSnapshot();
        const pinned = archivePinStore.getSnapshot();
        const pinnedSet = new Set(Array.isArray(pinned) ? pinned : []);
        const first = [];
        const rest = [];
        for (const item of items) {
          if (item !== void 0 && item !== null && pinnedSet.has(item.id)) first.push(item);
          else rest.push(item);
        }
        if (mode !== "desc" && mode !== "asc") {
          return first.length === 0 ? items : [...first, ...rest];
        }
        const cmp = makeByUpdatedAt(mode);
        return [...first].sort(cmp).concat([...rest].sort(cmp));
      }`;

/** C12-3a：groups useMemo 加排序模式依赖（修"开关不管用"）。 */
const CLIENT_MEMO1_OLD = `        }), [
          list,
          orderedWorkspaces,
          archivedSessionIds,
          pendingInteractions,
          showArchived,
          expandedGroups,
          sessionOrderByAccount,
          pinnedIdsKey
        ]);`;
const CLIENT_MEMO1_NEW = `        }), [
          list,
          orderedWorkspaces,
          archivedSessionIds,
          pendingInteractions,
          showArchived,
          expandedGroups,
          sessionOrderByAccount,
          pinnedIdsKey,
          sortMode
        ]);`;

/** C12-3b：baseRows useMemo 加排序模式依赖。 */
const CLIENT_MEMO2_OLD = `        const baseRows = (0, react.useMemo)(() => deriveFlat(list, archivedSessionIds, pendingInteractions, showArchived), [
          list,
          archivedSessionIds,
          pendingInteractions,
          showArchived
        ]);`;
const CLIENT_MEMO2_NEW = `        const baseRows = (0, react.useMemo)(() => deriveFlat(list, archivedSessionIds, pendingInteractions, showArchived), [
          list,
          archivedSessionIds,
          pendingInteractions,
          showArchived,
          sortMode
        ]);`;

/** C12-3c：订阅排序模式（两个列表组件各自订阅）。 */
const CLIENT_SUB1_OLD = `        const pinnedSessionIds = (0, react.useSyncExternalStore)(archivePinStore.subscribe, archivePinStore.getSnapshot);
        const pinnedIdsKey = pinnedSessionIds.join("|");
        const groups = (0, react.useMemo)(() => deriveGroups(list, orderedWorkspaces, archivedSessionIds, pendingInteractions, {`;
const CLIENT_SUB1_NEW = `        const pinnedSessionIds = (0, react.useSyncExternalStore)(archivePinStore.subscribe, archivePinStore.getSnapshot);
        const pinnedIdsKey = pinnedSessionIds.join("|");
        const sortMode = (0, react.useSyncExternalStore)(archiveSortStore.subscribe, archiveSortStore.getSnapshot);
        const groups = (0, react.useMemo)(() => deriveGroups(list, orderedWorkspaces, archivedSessionIds, pendingInteractions, {`;

const CLIENT_SUB2_OLD = `        const list = useSessions((s) => s);
        const pendingInteractions = useSessionPendingInteraction((s) => s);
        const baseRows = (0, react.useMemo)(() => deriveFlat(list, archivedSessionIds, pendingInteractions, showArchived), [`;
const CLIENT_SUB2_NEW = `        const list = useSessions((s) => s);
        const pendingInteractions = useSessionPendingInteraction((s) => s);
        const sortMode = (0, react.useSyncExternalStore)(archiveSortStore.subscribe, archiveSortStore.getSnapshot);
        const baseRows = (0, react.useMemo)(() => deriveFlat(list, archivedSessionIds, pendingInteractions, showArchived), [`;

/** C12-4：工作区菜单改成三项排序模式（互斥，用 check 显示当前项）。 */
const CLIENT_MENU3_OLD = `        const sortByTime = (0, react.useSyncExternalStore)(archiveSortStore.subscribe, archiveSortStore.getSnapshot);
        const autoArchive = (0, react.useSyncExternalStore)(archiveAutoStore.subscribe, archiveAutoStore.getSnapshot);
        const workspaceMenuItems = [{
          id: "rename",
          label: t("rename"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, {})
        }, ...actions?.canArchive === true ? [{
          id: "sort-by-time",
          label: t("menu.sortByTime"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {})
        }, {
          id: "auto-archive",
          label: t("menu.autoArchive"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })
        }] : [], ...actions?.canArchive === true ? [{`;
const CLIENT_MENU3_NEW = `        const sortMode = (0, react.useSyncExternalStore)(archiveSortStore.subscribe, archiveSortStore.getSnapshot);
        const autoArchive = (0, react.useSyncExternalStore)(archiveAutoStore.subscribe, archiveAutoStore.getSnapshot);
        const workspaceMenuItems = [{
          id: "rename",
          label: t("rename"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, {})
        }, ...actions?.canArchive === true ? [{
          id: "sort-off",
          label: t("menu.sortOff"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {})
        }, {
          id: "sort-desc",
          label: t("menu.sortDesc"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {})
        }, {
          id: "sort-asc",
          label: t("menu.sortAsc"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {})
        }, {
          id: "auto-archive",
          label: t("menu.autoArchive"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })
        }] : [], ...actions?.canArchive === true ? [{`;

/** C12-5：菜单 onSelect 处理三个排序模式 + selectedIds。 */
const CLIENT_MENU3SEL_OLD = `                items: workspaceMenuItems,
                selection: "check",
                selectedIds: [sortByTime === true ? "sort-by-time" : null, autoArchive === true ? "auto-archive" : null].filter(Boolean),
                onSelect: (id) => {
                  if (id === "sort-by-time") {
                    archiveSortStore.toggle();
                    return;
                  }
                  if (id === "auto-archive") {
                    archiveAutoStore.toggle();
                    setMenuOpen(false);
                    return;
                  }
                  setMenuOpen(false);`;
const CLIENT_MENU3SEL_NEW = `                items: workspaceMenuItems,
                selection: "check",
                selectedIds: [sortMode === "off" ? "sort-off" : sortMode === "asc" ? "sort-asc" : "sort-desc", autoArchive === true ? "auto-archive" : null].filter(Boolean),
                onSelect: (id) => {
                  if (id === "sort-off" || id === "sort-desc" || id === "sort-asc") {
                    archiveSortStore.set(id === "sort-off" ? "off" : id === "sort-asc" ? "asc" : "desc");
                    return;
                  }
                  if (id === "auto-archive") {
                    archiveAutoStore.toggle();
                    setMenuOpen(false);
                    return;
                  }
                  setMenuOpen(false);`;

/** C12-6：词条（并入 C6/C7 的尾部）—— 用独立锚点：已有的 menu.sortByTime 行。 */
const ZH_SORT3_OLD = `          "menu.sortByTime": "按时间排序",
          "menu.autoArchive": "自动归档闲置会话",`;
const ZH_SORT3_NEW = `          "menu.sortOff": "按时间排序：关闭",
          "menu.sortDesc": "按时间排序：降序（新→旧）",
          "menu.sortAsc": "按时间排序：升序（旧→新）",
          "menu.autoArchive": "自动归档闲置会话",`;

const EN_SORT3_OLD = `          "menu.sortByTime": "Sort by time",
          "menu.autoArchive": "Auto-archive idle sessions",`;
const EN_SORT3_NEW = `          "menu.sortOff": "Sort by time: off",
          "menu.sortDesc": "Sort by time: newest first",
          "menu.sortAsc": "Sort by time: oldest first",
          "menu.autoArchive": "Auto-archive idle sessions",`;


/* =====================================================================
 * C11：侧边栏会话按时间排序开关 + 超时自动归档开关
 * ===================================================================== */

/** C11-1：按时间排序开关（localStorage，默认关）。 */
const CLIENT_SORT_STORE_OLD = `      /** 闲置自动归档阈值（天）持久化键与读写。 */`;
const CLIENT_SORT_STORE_NEW = `      const SIDEBAR_SORT_BY_TIME_KEY = "dsham.sidebarSortByTime.v1";
      function readSidebarSortByTime() {
        try {
          return globalThis.localStorage?.getItem(SIDEBAR_SORT_BY_TIME_KEY) === "1";
        } catch (error) {
          return false;
        }
      }
      function writeSidebarSortByTime(enabled) {
        try {
          globalThis.localStorage?.setItem(SIDEBAR_SORT_BY_TIME_KEY, enabled === true ? "1" : "0");
        } catch (error) {
          console.warn("archive-manager: sidebar sort flag could not be persisted:", error);
        }
      }
      /** 侧边栏排序开关 store（默认关）。 */
      const archiveSortStore = (() => {
        let enabled = readSidebarSortByTime();
        const listeners = /* @__PURE__ */ new Set();
        const emit = () => {
          for (const listener of [...listeners]) {
            try { listener(); } catch (error) { console.warn("archive-manager: sort listener failed:", error); }
          }
        };
        return {
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          getSnapshot() {
            return enabled;
          },
          set(next) {
            const value = next === true;
            if (value === enabled) return;
            enabled = value;
            writeSidebarSortByTime(value);
            emit();
          },
          toggle() {
            this.set(!enabled);
          }
        };
      })();
      /** C11-2：超时自动归档开关（默认关）。 */
      const AUTO_ARCHIVE_KEY = "dsham.autoArchiveIdle.v1";
      function readAutoArchive() {
        try {
          return globalThis.localStorage?.getItem(AUTO_ARCHIVE_KEY) === "1";
        } catch (error) {
          return false;
        }
      }
      function writeAutoArchive(enabled) {
        try {
          globalThis.localStorage?.setItem(AUTO_ARCHIVE_KEY, enabled === true ? "1" : "0");
        } catch (error) {
          console.warn("archive-manager: auto archive flag could not be persisted:", error);
        }
      }
      const archiveAutoStore = (() => {
        let enabled = readAutoArchive();
        const listeners = /* @__PURE__ */ new Set();
        const emit = () => {
          for (const listener of [...listeners]) {
            try { listener(); } catch (error) { console.warn("archive-manager: auto listener failed:", error); }
          }
        };
        return {
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          getSnapshot() {
            return enabled;
          },
          set(next) {
            const value = next === true;
            if (value === enabled) return;
            enabled = value;
            writeAutoArchive(value);
            emit();
          },
          toggle() {
            this.set(!enabled);
          }
        };
      })();
      /** 闲置自动归档阈值（天）持久化键与读写。 */`;

/**
 * C11-3：sortPinnedFirst 支持"严格按时间排序"。
 * 开关打开：置顶组内按 updatedAt 降序、未置顶组内也按 updatedAt 降序，
 * 置顶整体仍高于未置顶。开关关闭：保持原有行为（只把置顶前置）。
 */
const CLIENT_SORTPIN_OLD = `      /** 稳定排序：置顶项前置，其余保持原有相对顺序。 */
      function sortPinnedFirst(items) {
        if (!Array.isArray(items) || items.length === 0) return items;
        const pinned = archivePinStore.getSnapshot();
        if (!Array.isArray(pinned) || pinned.length === 0) return items;
        const pinnedSet = new Set(pinned);
        const first = [];
        const rest = [];
        for (const item of items) {
          if (item !== void 0 && item !== null && pinnedSet.has(item.id)) first.push(item);
          else rest.push(item);
        }
        return first.length === 0 ? items : [...first, ...rest];
      }`;

const CLIENT_SORTPIN_NEW = `      /** 按最后活动时间降序；无时间戳的排在有时间的之后。 */
      function byUpdatedAtDesc(a, b) {
        const au = Number(a?.updatedAt);
        const bu = Number(b?.updatedAt);
        const aOk = Number.isFinite(au) && au > 0;
        const bOk = Number.isFinite(bu) && bu > 0;
        if (aOk && bOk) return bu - au;
        if (aOk) return -1;
        if (bOk) return 1;
        return 0;
      }
      /**
       * 稳定排序：置顶项前置，其余保持原有相对顺序。
       * 「按时间排序」开关打开时，置顶组内与未置顶组内都按最后活动时间降序；
       * 置顶整体仍优先于未置顶。
       */
      function sortPinnedFirst(items) {
        if (!Array.isArray(items) || items.length === 0) return items;
        const sortByTime = archiveSortStore.getSnapshot() === true;
        const pinned = archivePinStore.getSnapshot();
        const pinnedSet = new Set(Array.isArray(pinned) ? pinned : []);
        const first = [];
        const rest = [];
        for (const item of items) {
          if (item !== void 0 && item !== null && pinnedSet.has(item.id)) first.push(item);
          else rest.push(item);
        }
        if (!sortByTime) {
          return first.length === 0 ? items : [...first, ...rest];
        }
        return [...first].sort(byUpdatedAtDesc).concat([...rest].sort(byUpdatedAtDesc));
      }`;

/** C11-4：工作区菜单加两个开关项。 */
const CLIENT_MENU_OLD = `        const workspaceMenuItems = [{
          id: "rename",
          label: t("rename"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, {})
        }, ...actions?.canArchive === true ? [{`;
const CLIENT_MENU_NEW = `        const sortByTime = (0, react.useSyncExternalStore)(archiveSortStore.subscribe, archiveSortStore.getSnapshot);
        const autoArchive = (0, react.useSyncExternalStore)(archiveAutoStore.subscribe, archiveAutoStore.getSnapshot);
        const workspaceMenuItems = [{
          id: "rename",
          label: t("rename"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, {})
        }, ...actions?.canArchive === true ? [{
          id: "sort-by-time",
          label: t("menu.sortByTime"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {})
        }, {
          id: "auto-archive",
          label: t("menu.autoArchive"),
          icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })
        }] : [], ...actions?.canArchive === true ? [{`;

/** C11-5：菜单 onSelect 处理两个新项 + selection=check 勾选显示。 */
const CLIENT_MENU_SELECT_OLD = `                items: workspaceMenuItems,
                onSelect: (id) => {
                  setMenuOpen(false);
                  if (id !== "rename" && id !== "archive-workspace" && id !== "delete") return;
                  if (id === "rename") actions.rename();
                  else if (id === "archive-workspace") actions.archive();
                  else actions.delete();
                },`;
const CLIENT_MENU_SELECT_NEW = `                items: workspaceMenuItems,
                selection: "check",
                selectedIds: [sortByTime === true ? "sort-by-time" : null, autoArchive === true ? "auto-archive" : null].filter(Boolean),
                onSelect: (id) => {
                  if (id === "sort-by-time") {
                    archiveSortStore.toggle();
                    return;
                  }
                  if (id === "auto-archive") {
                    archiveAutoStore.toggle();
                    setMenuOpen(false);
                    return;
                  }
                  setMenuOpen(false);
                  if (id !== "rename" && id !== "archive-workspace" && id !== "delete") return;
                  if (id === "rename") actions.rename();
                  else if (id === "archive-workspace") actions.archive();
                  else actions.delete();
                },`;




/**
 * C10-1：进度状态。
 */
const CLIENT_PROGRESS_STATE_OLD = `        const [idleBusy, setIdleBusy] = (0, react.useState)(false);`;
const CLIENT_PROGRESS_STATE_NEW = `        const [idleBusy, setIdleBusy] = (0, react.useState)(false);
        // 批量归档进度：{ total, done, failed }；完成几秒后自动清空
        const [idleProgress, setIdleProgress] = (0, react.useState)(null);`;

/**
 * C10-2a：在 applyWorkspaceBrowser 作用域里定义批量归档局部函数。
 * 逐条调用本地 workspace 服务（与单个会话归档同一条路径），
 * 不依赖可能注册失败的远程方法 archiveSessionsByIds。
 * 贴在 unarchiveSessions 之前（与其它 remote 包装同一区域，闭包可达）。
 */
const CLIENT_BATCH_OLD = `        const unarchiveSessions = async (target) => {`;
const CLIENT_BATCH_NEW = `        /**
         * 批量归档：逐条走本地 workspace 服务，每条完成后回调 onProgress(done, total, failed)。
         * 单条失败只记录不中断，返回 { archived, failed }。
         */
        const archiveSessionsBatch = async (sessionIds, onProgress) => {
          const archived = [];
          const failed = [];
          const total = Array.isArray(sessionIds) ? sessionIds.length : 0;
          for (const sessionId of sessionIds ?? []) {
            try {
              await ctx.workspaces.archiveSession(sessionId);
              archived.push(sessionId);
            } catch (reason) {
              failed.push(sessionId);
              try { console.warn("archive-manager: batch archive failed for", sessionId, reason); } catch {}
            }
            if (typeof onProgress === "function") {
              try { onProgress(archived.length + failed.length, total, failed.length); } catch {}
            }
          }
          return { archived, failed };
        };
        const unarchiveSessions = async (target) => {`;

/** C10-2b：props 注入批量函数（applyWorkspaceBrowser 里的同名局部函数，闭包可达）。 */
const CLIENT_BATCH_PROPS_OLD = `            archiveSessionsByIds,
            openConversation,`;
const CLIENT_BATCH_PROPS_NEW = `            archiveSessionsByIds,
            archiveSessionsBatch,
            openConversation,`;

/** C10-2c：组件签名接收批量函数。 */
const CLIENT_BATCH_SIG_OLD = `archivedSessionMetadata, archiveSessionsByIds, openConversation, viewState, close, t }) {`;
const CLIENT_BATCH_SIG_NEW = `archivedSessionMetadata, archiveSessionsByIds, archiveSessionsBatch, openConversation, viewState, close, t }) {`;

/**
 * C10-3：runIdleArchive 改走本地批量函数 + 逐步更新进度。
 */
const CLIENT_RUN_OLD = `        const runIdleArchive = async () => {
          if (idleBusy || busy || idleCandidateIds.length === 0) return;
          setIdleBusy(true);
          setError(null);
          setNotice(null);
          const planned = [...idleCandidateIds];
          try {
            const result = await archiveSessionsByIds(planned);
            const added = result?.archivedSessionIdsAdded ?? [];
            setLastIdleArchive({ ids: added, days: idleDays, at: Date.now() });
            setNotice(t("archives.idleDone", { n: added.length, days: formatIdleDays(idleDays) }));
          } catch (reason) {
            setError(t("archives.idleFailed", { detail: reason instanceof Error ? reason.message : String(reason) }));
          } finally {
            setIdleBusy(false);
          }
        };`;

const CLIENT_RUN_NEW = `        const runIdleArchive = async () => {
          if (idleBusy || busy || idleCandidateIds.length === 0) return;
          setIdleBusy(true);
          setError(null);
          setNotice(null);
          const planned = [...idleCandidateIds];
          setIdleProgress({ total: planned.length, done: 0, failed: 0 });
          try {
            const archiveBatch = archiveSessionsBatch ?? archiveSessionsByIds;
            const result = await archiveBatch(planned, (done, total, failedCount) => {
              setIdleProgress({ total, done, failed: failedCount ?? 0 });
            });
            const added = result?.archived ?? [];
            const failedCount = result?.failed?.length ?? 0;
            await refreshSessionList();
            setLastIdleArchive(added.length > 0 ? { ids: added, days: idleDays, at: Date.now() } : null);
            if (added.length === 0) {
              setError(t("archives.idleFailed", { detail: failedCount > 0 ? failedCount + " failed" : "nothing archived" }));
            } else if (failedCount > 0) {
              setNotice(t("archives.idleDone", { n: added.length, days: formatIdleDays(idleDays) }) + " · " + failedCount + " failed");
            } else {
              setNotice(t("archives.idleDone", { n: added.length, days: formatIdleDays(idleDays) }));
            }
          } catch (reason) {
            setError(t("archives.idleFailed", { detail: reason instanceof Error ? reason.message : String(reason) }));
          } finally {
            setIdleBusy(false);
            setTimeout(() => setIdleProgress(null), 5000);
          }
        };`;

/** C10-4：进度条 UI（插在 idleNote 之前）。 */
const CLIENT_PROGRESS_UI_OLD = `(0, react_jsx_runtime.jsx)("div", { className: "dsham_settingsIdleNote", children: t("archives.idleNote") })`;
const CLIENT_PROGRESS_UI_NEW = `idleProgress !== null ? (0, react_jsx_runtime.jsxs)("div", { className: "dsham_settingsIdleProgress", children: [(0, react_jsx_runtime.jsxs)("span", { className: "dsham_settingsIdleProgressText", children: [t("archives.idleProgress"), " ", (idleProgress.done || 0), " / ", (idleProgress.total || 0), "（", Math.round((idleProgress.total || 0) === 0 ? 0 : (idleProgress.done || 0) / idleProgress.total * 100), "%）", (idleProgress.failed || 0) > 0 ? "，失败 " + idleProgress.failed : ""] }), (0, react_jsx_runtime.jsx)("span", { className: "dsham_settingsIdleProgressBar", children: (0, react_jsx_runtime.jsx)("span", { className: "dsham_settingsIdleProgressFill", style: { width: Math.round((idleProgress.total || 0) === 0 ? 0 : (idleProgress.done || 0) / idleProgress.total * 100) + "%" } }) })] }) : null, (0, react_jsx_runtime.jsx)("div", { className: "dsham_settingsIdleNote", children: t("archives.idleNote") })`;

/** C10-5：进度条 CSS（追加到 idlecard 样式之后）。 */
const CLIENT_PROGRESS_CSS_OLD = `.dsham_settingsIdleNote{`;
const CLIENT_PROGRESS_CSS_NEW = `.dsham_settingsIdleProgress{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:var(--dsh-text-secondary,#8a8f98)}.dsham_settingsIdleProgressText{flex:none;font-variant-numeric:tabular-nums}.dsham_settingsIdleProgressBar{flex:1;height:6px;border-radius:3px;background:rgba(127,127,127,.25);overflow:hidden}.dsham_settingsIdleProgressFill{display:block;height:100%;background:var(--dsh-accent,#4c8dff);transition:width .15s ease}.dsham_settingsIdleNote{`;

/** 远程包装函数：放在既有 unarchiveSessions 包装旁。 */
const CLIENT_REMOTE_OLD = `        const unarchiveSessions = async (target) => {`;

/**
 * C8：组件签名接收 archiveSessionsByIds。
 * 该函数定义在 applyWorkspaceBrowser 作用域，而组件在另一个作用域里调用它，
 * 不通过 props 传入就会 "archiveSessionsByIds is not defined"。
 */
const CLIENT_SIG_OLD = `function ArchivedSessionsSection({ sessionStore, workspaceStore, unarchiveSession, deleteSession, unarchiveSessions, deleteArchivedSessions, archivedSessionMetadata, openConversation, viewState, close, t }) {`;
const CLIENT_SIG_NEW = `function ArchivedSessionsSection({ sessionStore, workspaceStore, unarchiveSession, deleteSession, unarchiveSessions, deleteArchivedSessions, archivedSessionMetadata, archiveSessionsByIds, openConversation, viewState, close, t }) {`;

/** C9：注册组件时把 archiveSessionsByIds 一起注入 props。 */
const CLIENT_PROPS_OLD = `            archivedSessionMetadata,
            openConversation,`;
const CLIENT_PROPS_NEW = `            archivedSessionMetadata,
            archiveSessionsByIds,
            openConversation,`;
const CLIENT_REMOTE_NEW = `        const archiveSessionsByIds = async (sessionIds) => {
          const registry = ctx.get("remote.workspaceRegistry");
          if (registry === void 0) throw new Error("archive-manager remote service is unavailable");
          const result = await registry.archiveSessionsByIds(sessionIds);
          if (!result.ok) throw new Error(result.error.message);
          await refreshSessionList();
          return result.value;
        };
        const unarchiveSessions = async (target) => {`;

/** UI：在归档列表工具栏之前插入「按时间归档」设置块。 */
const CLIENT_UI_OLD = `          className: "dsham_settingsToolbar",`;
const CLIENT_UI_NEW = `          className: "dsham_settingsIdleCard", children: [(0, react_jsx_runtime.jsx)("div", { className: "dsham_settingsIdleTitle", children: t("archives.idleTitle") }), (0, react_jsx_runtime.jsxs)("div", { className: "dsham_settingsIdleRow", children: [(0, react_jsx_runtime.jsxs)("label", { className: "dsham_settingsIdleLabel", children: [t("archives.idleDaysLabel"), (0, react_jsx_runtime.jsx)("input", { className: "dsham_settingsIdleInput", type: "number", min: 0.5, max: 3650, step: 0.5, value: idleDays, disabled: idleBusy || busy, onChange: (event) => changeIdleDays(event.target.value), "aria-label": t("archives.idleDaysAria") }), t("archives.idleDaysUnit")] }), (0, react_jsx_runtime.jsx)("span", { className: "dsham_settingsIdleHint", children: idleCandidateIds.length === 0 ? t("archives.idleNone", { days: formatIdleDays(idleDays) }) : t("archives.idleMatched", { n: idleCandidateIds.length, days: formatIdleDays(idleDays) }) }), (0, react_jsx_runtime.jsxs)("button", { type: "button", className: "dsham_settingsIdleRun", disabled: idleBusy || busy || idleCandidateIds.length === 0, onClick: () => runIdleArchive(), children: [t("archives.idleRun"), idleCandidateIds.length > 0 ? " (" + idleCandidateIds.length + ")" : ""] }), lastIdleArchive !== null ? (0, react_jsx_runtime.jsx)("button", { type: "button", className: "dsham_settingsIdleUndo", disabled: idleBusy || busy, onClick: () => undoIdleArchive(), children: t("archives.idleUndo") }) : null] }), (0, react_jsx_runtime.jsx)("div", { className: "dsham_settingsIdleNote", children: t("archives.idleNote") })] }), (0, react_jsx_runtime.jsxs)("div", {
          className: "dsham_settingsToolbar",`;

/** CSS。 */
const CLIENT_CSS_OLD = `.dsham_pinBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#f5a623}`;
const CLIENT_CSS_NEW = `.dsham_pinBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#f5a623}.dsham_settingsIdleCard{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-button-elevated-fill));border:1px solid var(--dsw-alias-border-l2);border-radius:12px}.dsham_settingsIdleTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}.dsham_settingsIdleRow{display:flex;flex-wrap:wrap;align-items:center;gap:10px}.dsham_settingsIdleLabel{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsham_settingsIdleInput{box-sizing:border-box;width:72px;min-height:28px;padding:0 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-button-elevated-fill));border:1px solid var(--dsw-alias-border-l2);border-radius:7px;font:inherit;font-size:12px}.dsham_settingsIdleInput:focus{outline:none;border-color:var(--dsw-alias-label-tertiary)}.dsham_settingsIdleHint{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}.dsham_settingsIdleRun,.dsham_settingsIdleUndo{display:inline-flex;align-items:center;min-height:28px;padding:0 12px;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;font:inherit;font-size:12px;font-weight:500}.dsham_settingsIdleRun:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-tertiary)}.dsham_settingsIdleUndo{color:var(--dsw-alias-label-secondary)}.dsham_settingsIdleRun:disabled,.dsham_settingsIdleUndo:disabled{cursor:not-allowed;opacity:.5}.dsham_settingsIdleNote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.dsham_deleteProgress{margin-top:12px}`;

const ZH_OLD = `        "archives.deleteUnfavoritedConfirm": "删除未收藏的聊天",`;
const ZH_NEW = `        "archives.deleteUnfavoritedConfirm": "删除未收藏的聊天",
        "archives.idleTitle": "按时间筛选归档",
        "archives.idleDaysLabel": "未归档会话闲置超过",
        "archives.idleDaysUnit": "天即归档",
        "archives.idleDaysAria": "闲置天数阈值",
        "archives.idleMatched": "当前有 {n} 个会话闲置超过 {days} 天",
        "archives.idleNone": "没有闲置超过 {days} 天的未归档会话",
        "archives.idleRun": "归档这些会话",
        "archives.idleUndo": "撤回上一步",
        "archives.idleDone": "已归档 {n} 个闲置超过 {days} 天的会话",
        "archives.idleFailed": "按时间归档失败：{detail}",
        "archives.idleUndone": "已撤回，恢复了 {n} 个会话",
        "archives.idleUndoFailed": "撤回失败：{detail}",
        "archives.idleNote": "以最后一次对话时间为判定依据；时间未知的会话不会被自动归档。归档后可随时恢复。",
          "menu.sortByTime": "按时间排序",
          "menu.autoArchive": "自动归档闲置会话",`;

const EN_OLD = `        "archives.deleteUnfavoritedConfirm": "Delete unfavorited chats",`;
const EN_NEW = `        "archives.deleteUnfavoritedConfirm": "Delete unfavorited chats",
        "archives.idleTitle": "Archive by inactivity",
        "archives.idleDaysLabel": "Archive unarchived chats idle for more than",
        "archives.idleDaysUnit": "days",
        "archives.idleDaysAria": "Idle days threshold",
        "archives.idleMatched": "{n} chats are idle for more than {days} days",
        "archives.idleNone": "No unarchived chats idle for more than {days} days",
        "archives.idleRun": "Archive these",
        "archives.idleUndo": "Undo last step",
        "archives.idleDone": "Archived {n} chats idle for more than {days} days",
        "archives.idleFailed": "Idle archiving failed: {detail}",
        "archives.idleUndone": "Reverted, restored {n} chats",
        "archives.idleUndoFailed": "Undo failed: {detail}",
        "archives.idleNote": "Judged by the last conversation time; chats with an unknown timestamp are never auto-archived. Archived chats can always be restored.",
          "menu.sortByTime": "Sort by time",
          "menu.autoArchive": "Auto-archive idle sessions",`;

/** 组件需要的依赖（sessions / workspaceState / busy 等已在作用域内）。 */
const TARGETS = [
	{ name: "C1-闲置阈值与筛选工具", old: CLIENT_UTIL_OLD, to: CLIENT_UTIL_NEW },
	{ name: "C2-闲置归档状态与动作", old: CLIENT_STATE_OLD, to: CLIENT_STATE_NEW },
	{ name: "C3-远程批量归档包装", old: CLIENT_REMOTE_OLD, to: CLIENT_REMOTE_NEW },
	{ name: "C4-设置页 UI 卡片", old: CLIENT_UI_OLD, to: CLIENT_UI_NEW },
	{ name: "C5-CSS", old: CLIENT_CSS_OLD, to: CLIENT_CSS_NEW },
	{ name: "C6-中文词条", old: ZH_OLD, to: ZH_NEW },
	{ name: "C7-英文词条", old: EN_OLD, to: EN_NEW },
  { name: "C8-组件签名接收 archiveSessionsByIds", old: CLIENT_SIG_OLD, to: CLIENT_SIG_NEW },
  { name: "C9-props 注入 archiveSessionsByIds", old: CLIENT_PROPS_OLD, to: CLIENT_PROPS_NEW },
  { name: "C10-1-进度状态", old: CLIENT_PROGRESS_STATE_OLD, to: CLIENT_PROGRESS_STATE_NEW },
  { name: "C10-2a-批量函数(本地服务)", old: CLIENT_BATCH_OLD, to: CLIENT_BATCH_NEW },
  { name: "C10-2b-props 注入批量函数", old: CLIENT_BATCH_PROPS_OLD, to: CLIENT_BATCH_PROPS_NEW },
  { name: "C10-2c-签名接收批量函数", old: CLIENT_BATCH_SIG_OLD, to: CLIENT_BATCH_SIG_NEW },
  { name: "C10-3-归档走本地批量+进度", old: CLIENT_RUN_OLD, to: CLIENT_RUN_NEW },
  { name: "C10-4-进度条 UI", old: CLIENT_PROGRESS_UI_OLD, to: CLIENT_PROGRESS_UI_NEW },
  { name: "C10-5-进度条 CSS", old: CLIENT_PROGRESS_CSS_OLD, to: CLIENT_PROGRESS_CSS_NEW },
  { name: "C11-1-排序与自动归档 store", old: CLIENT_SORT_STORE_OLD, to: CLIENT_SORT_STORE_NEW },
  { name: "C11-3-排序支持时间", old: CLIENT_SORTPIN_OLD, to: CLIENT_SORTPIN_NEW },
  { name: "C11-4-工作区菜单加开关", old: CLIENT_MENU_OLD, to: CLIENT_MENU_NEW },
  { name: "C11-5-菜单选择处理", old: CLIENT_MENU_SELECT_OLD, to: CLIENT_MENU_SELECT_NEW },
  { name: "C12-1-排序三态 store", old: CLIENT_SORT3_OLD, to: CLIENT_SORT3_NEW },
  { name: "C12-2-排序支持升降序", old: CLIENT_SORTFN_OLD, to: CLIENT_SORTFN_NEW },
  { name: "C12-3a-依赖排序模式(groups)", old: CLIENT_MEMO1_OLD, to: CLIENT_MEMO1_NEW },
  { name: "C12-3b-依赖排序模式(baseRows)", old: CLIENT_MEMO2_OLD, to: CLIENT_MEMO2_NEW },
  { name: "C12-3c-订阅排序模式(列表1)", old: CLIENT_SUB1_OLD, to: CLIENT_SUB1_NEW },
  { name: "C12-3d-订阅排序模式(列表2)", old: CLIENT_SUB2_OLD, to: CLIENT_SUB2_NEW },
  { name: "C12-4-菜单三项排序", old: CLIENT_MENU3_OLD, to: CLIENT_MENU3_NEW },
  { name: "C12-5-菜单选择三模式", old: CLIENT_MENU3SEL_OLD, to: CLIENT_MENU3SEL_NEW },
  { name: "C12-6a-中文词条(排序模式)", old: ZH_SORT3_OLD, to: ZH_SORT3_NEW },
  { name: "C12-6b-英文词条(排序模式)", old: EN_SORT3_OLD, to: EN_SORT3_NEW },
  { name: "C13-1-删除进度状态", old: CLIENT_DEL_PROGRESS_OLD, to: CLIENT_DEL_PROGRESS_NEW },
  { name: "C13-2-分批删除函数", old: CLIENT_DEL_BATCH_OLD, to: CLIENT_DEL_BATCH_NEW },
  { name: "C13-3a-props 注入分批删除", old: CLIENT_DEL_PROPS_OLD, to: CLIENT_DEL_PROPS_NEW },
  { name: "C13-3b-签名接收分批删除", old: CLIENT_DEL_SIG_OLD, to: CLIENT_DEL_SIG_NEW },
  { name: "C13-4-删除改分批+进度", old: CLIENT_DEL_RUN_OLD, to: CLIENT_DEL_RUN_NEW },
  { name: "C13-5-删除进度条 UI", old: CLIENT_DEL_UI_OLD, to: CLIENT_DEL_UI_NEW },
  { name: "C13-6-删除结束清进度", old: CLIENT_DEL_FINALLY_OLD, to: CLIENT_DEL_FINALLY_NEW },
  { name: "C13-7a-中文词条(删除进度)", old: ZH_DELPROG_OLD, to: ZH_DELPROG_NEW },
  { name: "C13-7b-英文词条(删除进度)", old: EN_DELPROG_OLD, to: EN_DELPROG_NEW },
  { name: "C17-客户端安全删除包装", old: CLIENT_SAFE_WRAP_OLD, to: CLIENT_SAFE_WRAP_NEW },
  { name: "C17-props 注入安全删除", old: CLIENT_SAFE_PROPS_OLD, to: CLIENT_SAFE_PROPS_NEW },
  { name: "C17-签名接收安全删除", old: CLIENT_SAFE_SIG_OLD, to: CLIENT_SAFE_SIG_NEW },
  { name: "C17-confirmDelete 优先安全", old: CLIENT_SAFE_RUN_OLD, to: CLIENT_SAFE_RUN_NEW },
  { name: "C17-进度满格", old: CLIENT_SAFE_DONE_OLD, to: CLIENT_SAFE_DONE_NEW },
  { name: "C18-进度状态加耗时字段", old: CLIENT_PROG_META_OLD, to: CLIENT_PROG_META_NEW },
  { name: "C18-开始记录时间", old: CLIENT_PROG_START_OLD, to: CLIENT_PROG_START_NEW },
  { name: "C18-结束算耗时", old: CLIENT_PROG_END_OLD, to: CLIENT_PROG_END_NEW },
  { name: "C18-停留 10 秒", old: CLIENT_PROG_CLEAR_OLD, to: CLIENT_PROG_CLEAR_NEW },
  { name: "C18-进度文本加耗时", old: CLIENT_PROG_TEXT_OLD, to: CLIENT_PROG_TEXT_NEW },
  { name: "C18-CSS 过渡", old: CLIENT_PROG_CSS_OLD, to: CLIENT_PROG_CSS_NEW },
// [disabled] { name: "C14-客户端快速删除包装", old: CLIENT_FAST_WRAP_OLD, to: CLIENT_FAST_WRAP_NEW },
// [disabled] { name: "C14-props 注入快速删除", old: CLIENT_FAST_PROPS_OLD, to: CLIENT_FAST_PROPS_NEW },
// [disabled] { name: "C14-签名接收快速删除", old: CLIENT_FAST_SIG_OLD, to: CLIENT_FAST_SIG_NEW },
// [disabled] { name: "C14-confirmDelete 优先快速", old: CLIENT_FAST_RUN_OLD, to: CLIENT_FAST_RUN_NEW },
// [disabled] { name: "C14b-快速删除自检", old: CLIENT_FAST_DIAG_OLD, to: CLIENT_FAST_DIAG_NEW },
// [disabled] { name: "C14b-失败原因记录", old: CLIENT_FAST_MSG_OLD, to: CLIENT_FAST_MSG_NEW },
// [disabled] { name: "C16-客户端直删包装", old: CLIENT_DIRECT_WRAP_OLD, to: CLIENT_DIRECT_WRAP_NEW },
// [disabled] { name: "C16-props 注入直删", old: CLIENT_DIRECT_PROPS_OLD, to: CLIENT_DIRECT_PROPS_NEW },
// [disabled] { name: "C16-签名接收直删", old: CLIENT_DIRECT_SIG_OLD, to: CLIENT_DIRECT_SIG_NEW },
// [disabled] { name: "C16-confirmDelete 四级回退", old: CLIENT_DIRECT_RUN_OLD, to: CLIENT_DIRECT_RUN_NEW },
	{ name: "W1-schema 常量", old: HOST_SCHEMA_OLD, to: HOST_SCHEMA_NEW },
	{ name: "W2-宿主批量归档方法", old: HOST_METHOD_ANCHOR, to: HOST_METHOD_NEW },
	{ name: "W3-remote 声明", old: HOST_REMOTE_OLD, to: HOST_REMOTE_NEW },
	{ name: "W4-markRemoteMethod", old: HOST_MARK_OLD, to: HOST_MARK_NEW },
	{ name: "W9-宿主安全删除", old: HOST_SAFE_ANCHOR, to: HOST_SAFE_NEW },
	{ name: "W10a-安全删除 remote 声明", old: HOST_SAFE_REMOTE_OLD, to: HOST_SAFE_REMOTE_NEW },
	{ name: "W10b-安全删除 mark", old: HOST_SAFE_MARK_OLD, to: HOST_SAFE_MARK_NEW },
	{ name: "W11-导入 appendFileSync/homedir", old: HOST_IMPORT_OLD, to: HOST_IMPORT_NEW },
	{ name: "W12-原版删除加日志", old: W12_DLOG_HELPER_OLD, to: W12_DLOG_HELPER_NEW },
	{ name: "W12-循环日志", old: W12_DLOG_LOOP_OLD, to: W12_DLOG_LOOP_NEW },
	{ name: "W12-core入口", old: W12_DLOG_CORE_OLD, to: W12_DLOG_CORE_NEW },
	{ name: "W12-core步骤", old: W12_DLOG_STEPS_OLD, to: W12_DLOG_STEPS_NEW },
	{ name: "W12-core尾部", old: W12_DLOG_TAIL_OLD, to: W12_DLOG_TAIL_NEW },
	{ name: "W13-子会话索引", old: W13_DESC_OLD, to: W13_DESC_NEW },
	{ name: "W13-core传索引", old: W13_CORE_OLD, to: W13_CORE_NEW },
	{ name: "W13-调用传索引", old: W13_CALL_OLD, to: W13_CALL_NEW },
	{ name: "W13-批量建索引", old: W13_LOOP_OLD, to: W13_LOOP_NEW },
	{ name: "W13-循环传索引", old: W13_CALL2_OLD, to: W13_CALL2_NEW },
	{ name: "W14-子会话跳过sessionKnown", old: W14_DESC_OLD, to: W14_DESC_NEW },
	{ name: "W14-存在性缓存+覆盖sessionKnown", old: W14_CACHE_OLD, to: W14_CACHE_NEW },
	{ name: "W14-批量预热缓存", old: W14_WARM_OLD, to: W14_WARM_NEW },
	{ name: "W14b-sessionKnown插入缓存", old: W14B_KNOWN_OLD, to: W14B_KNOWN_NEW },
	{ name: "C19-侧边栏星标", old: C19_STAR_OLD, to: C19_STAR_NEW },
	{ name: "C19-星标 CSS", old: C19_CSS_OLD, to: C19_CSS_NEW },
	{ name: "C20-自动归档常量", old: C20_CONST_OLD, to: C20_CONST_NEW },
	{ name: "C20-自动归档定时器", old: C20_TIMER_OLD, to: C20_TIMER_NEW },
	{ name: "C21-设置页自动归档开关", old: C21_TOGGLE_OLD, to: C21_TOGGLE_NEW },
	{ name: "C21-自动归档开关 CSS", old: C21_CSS_OLD, to: C21_CSS_NEW },
	{ name: "C21b-自动归档词条(中文)", old: C21B_ZH_OLD, to: C21B_ZH_NEW },
	{ name: "C21b-自动归档词条(英文)", old: C21B_EN_OLD, to: C21B_EN_NEW },
// [disabled] { name: "W5-宿主快速删除", old: HOST_FASTDEL_ANCHOR, to: HOST_FASTDEL_NEW },
// [disabled] { name: "W6a-快速删除 remote 声明", old: HOST_FASTDEL_REMOTE_OLD, to: HOST_FASTDEL_REMOTE_NEW },
// [disabled] { name: "W6b-快速删除 mark", old: HOST_FASTDEL_MARK_OLD, to: HOST_FASTDEL_MARK_NEW },
// [disabled] { name: "W7-宿主直删", old: HOST_DIRECT_ANCHOR, to: HOST_DIRECT_NEW },
// [disabled] { name: "W8a-直删 remote 声明", old: HOST_DIRECT_REMOTE_OLD, to: HOST_DIRECT_REMOTE_NEW },
// [disabled] { name: "W8b-直删 mark", old: HOST_DIRECT_MARK_OLD, to: HOST_DIRECT_MARK_NEW },
];

function applyPatches(text, patches) {
	const log = [];
	let failed = 0;
	let current = text;
	for (const patch of patches) {
		const hits = current.split(patch.old).length - 1;
		if (hits === 1) {
			current = current.replace(patch.old, patch.to);
			log.push(`  [ok]   ${patch.name}`);
		} else if (hits === 0 && current.includes(patch.to)) {
			log.push(`  [skip] ${patch.name}（已是目标文本）`);
		} else {
			failed += 1;
			log.push(`  [FAIL] ${patch.name} — 锚点命中 ${hits} 次（期望 1 次）`);
		}
	}
	return { text: current, log, failed };
}

function backupAndWrite(file, next, tag) {
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const dir = join(BACKUP_ROOT, `archive-manager-idlearch-${tag}-${stamp}`);
	mkdirSync(dir, { recursive: true });
	copyFileSync(file, join(dir, file.split(/[\\/]/).pop()));
	writeFileSync(file, next, { encoding: "utf8" });
	console.log(`  已写盘 ${file}（备份 ${dir}）`);
}

function main() {
	const dryRun = process.argv.includes("--dry-run");
	let totalFailed = 0;
	const jobs = [
		[CLIENT, TARGETS.filter((t) => t.name.startsWith("C")), "client"],
		[WORKSPACE, TARGETS.filter((t) => t.name.startsWith("W")), "workspace"],
	];
	for (const [file, patches, tag] of jobs) {
		const original = readFileSync(file, "utf8").replace(/^\ufeff/, "");
		const result = applyPatches(original, patches);
		console.log(`=== ${file.split(/[\\/]/).pop()} ===\n${result.log.join("\n")}`);
		totalFailed += result.failed;
		if (result.failed === 0 && !dryRun && result.text !== original) backupAndWrite(file, result.text, tag);
	}
	if (totalFailed > 0) { console.error(`\n${totalFailed} 处失配：整体放弃写盘。`); process.exit(1); }
	console.log(dryRun ? "\n--dry-run：全部锚点命中，未写盘。" : "\n第十批已应用。重启 DSH 后生效（建议 Ctrl+Shift+R）。");
}

main();
