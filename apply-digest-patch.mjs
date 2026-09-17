#!/usr/bin/env node
/**
 * @michengai/dsh-archive-manager 本地增强补丁 · 第四批：会话一句话 todo 摘要（小字显示）
 *
 * ⚠️ 执行顺序：apply-patch.mjs → apply-turns-patch.mjs → apply-pin-patch.mjs → 本脚本。
 *    或用 apply-all.mjs 一把跑完四批。
 *
 * 功能：
 *   - 侧栏会话行、归档页列表行在标题/时间后追加小字摘要，如「进行中 2/5 · 修复补丁锚点」；
 *   - 摘要来源：① 客户端已有的 `session.projectionValues.todos` 投影（活跃会话，即时、零请求）；
 *     ② 宿主端 `session-digest` 路由从转录提取（历史/归档会话，零模型调用、结果缓存）；
 *   - 无 todo 记录的会话不显示任何小字（保持界面干净）。
 *
 * 用法：
 *   node apply-digest-patch.mjs --dry-run
 *   node apply-digest-patch.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const TARGET = resolve(
  process.env.DSH_ARCHIVE_MANAGER_DIR ??
    join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager"),
  "lib",
  "client.js"
);
const BACKUP_ROOT = join(homedir(), ".dsh", "backups");

const DIGEST_HELPERS = `      const ARCHIVE_DIGEST_STORAGE_KEY = "dsham.sessionDigests.v1";
      const SESSION_DIGEST_ENDPOINT = "/api/michengai/dsh-archive-manager/session-digest";
      function truncateDigestText(value, max) {
        const text = String(value ?? "").replace(/\\s+/g, " ").trim();
        if (text === "") return "";
        const limit = typeof max === "number" && max > 1 ? max : 24;
        return text.length > limit ? text.slice(0, limit - 1) + "\\u2026" : text;
      }
      /** 从客户端 todo 投影（TodoItem[]）归纳摘要，口径与宿主端 summarizeTodos 一致。 */
      function todoDigestFromProjection(todos) {
        if (!Array.isArray(todos) || todos.length === 0) return null;
        let done = 0;
        let doing = 0;
        let pending = 0;
        let firstDoing = null;
        let firstPending = null;
        let lastDone = null;
        for (const item of todos) {
          const content = typeof item?.content === "string" ? item.content.trim() : "";
          const status = item?.status;
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
      /** 把摘要归纳成一句人话（不调用任何模型）。 */
      function todoDigestText(digest, t) {
        if (digest === null || digest === void 0 || typeof digest !== "object") return null;
        const total = typeof digest.total === "number" ? digest.total : 0;
        if (total <= 0) return null;
        const task = truncateDigestText(digest.firstOpen ?? digest.lastDone, 26);
        const params = { total, done: typeof digest.done === "number" ? digest.done : 0, task };
        if (typeof digest.doing === "number" && digest.doing > 0) return t("digest.doing", params);
        if (typeof digest.pending === "number" && digest.pending > 0) return t("digest.pending", params);
        return t("digest.done", params);
      }
      /** 会话摘要缓存（宿主转录提取结果 + 轮次），localStorage 持久化以便重启后立即可用。 */
      const archiveDigestStore = (() => {
        let byId = {};
        try {
          const raw = globalThis.localStorage?.getItem(ARCHIVE_DIGEST_STORAGE_KEY);
          const parsed = raw === null || raw === void 0 ? null : JSON.parse(raw);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) byId = parsed;
        } catch (error) {
          byId = {};
        }
        const listeners = /* @__PURE__ */ new Set();
        const persist = () => {
          try {
            globalThis.localStorage?.setItem(ARCHIVE_DIGEST_STORAGE_KEY, JSON.stringify(byId));
          } catch (error) {
            console.warn("archive-manager: session digests could not be persisted:", error);
          }
        };
        const emit = () => {
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              console.warn("archive-manager: digest listener failed:", error);
            }
          }
        };
        return {
          getSnapshot: () => byId,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          get: (sessionId) => byId[sessionId],
          merge: (entries) => {
            if (!Array.isArray(entries) || entries.length === 0) return;
            const next = { ...byId };
            let changed = false;
            for (const entry of entries) {
              if (entry === null || typeof entry !== "object" || typeof entry.sessionId !== "string") continue;
              const value = {
                turnCount: typeof entry.turnCount === "number" && Number.isFinite(entry.turnCount) ? entry.turnCount : 0,
                todo: entry.todo ?? null
              };
              const current = next[entry.sessionId];
              if (current === void 0 || current.turnCount !== value.turnCount || JSON.stringify(current.todo ?? null) !== JSON.stringify(value.todo)) {
                next[entry.sessionId] = value;
                changed = true;
              }
            }
            if (!changed) return;
            byId = next;
            persist();
            emit();
          },
          prune: (ids) => {
            const removed = ids instanceof Set ? ids : new Set(ids);
            if (removed.size === 0) return;
            const next = {};
            let changed = false;
            for (const [sessionId, value] of Object.entries(byId)) {
              if (removed.has(sessionId)) {
                changed = true;
                continue;
              }
              next[sessionId] = value;
            }
            if (!changed) return;
            byId = next;
            persist();
            emit();
          }
        };
      })();
      async function requestSessionDigests(sessionIds) {
        const list = Array.isArray(sessionIds) ? sessionIds.filter((sessionId) => typeof sessionId === "string" && sessionId !== "") : [];
        if (list.length === 0) return [];
        const response = await fetch(SESSION_DIGEST_ENDPOINT + "?sessionIds=" + encodeURIComponent(list.join(",")), {
          method: "GET",
          headers: { accept: "application/json" }
        });
        if (response.ok !== true) throw new Error("session digest lookup failed with status " + String(response.status));
        const payload = await response.json();
        return Array.isArray(payload?.items) ? payload.items : [];
      }
      /** 摘要请求批处理队列：把整屏会话的请求合并成少数几次调用。 */
      const digestQueue = { pending: /* @__PURE__ */ new Set(), requested: /* @__PURE__ */ new Set(), timer: void 0 };
      function scheduleSessionDigest(sessionId) {
        if (typeof sessionId !== "string" || sessionId === "") return;
        if (digestQueue.requested.has(sessionId) || digestQueue.pending.has(sessionId)) return;
        if (archiveDigestStore.get(sessionId) !== void 0) {
          digestQueue.requested.add(sessionId);
          return;
        }
        digestQueue.pending.add(sessionId);
        if (digestQueue.timer !== void 0) return;
        digestQueue.timer = setTimeout(() => {
          digestQueue.timer = void 0;
          void flushSessionDigestQueue();
        }, 250);
      }
      async function flushSessionDigestQueue() {
        const batch = [...digestQueue.pending].slice(0, 40);
        for (const sessionId of batch) {
          digestQueue.pending.delete(sessionId);
          digestQueue.requested.add(sessionId);
        }
        if (batch.length === 0) return;
        try {
          archiveDigestStore.merge(await requestSessionDigests(batch));
        } catch (error) {
          // 失败不重试（requested 保留，避免渲染循环反复打同一批会话）
          console.warn("archive-manager: session digest request failed:", error);
        }
      }
`;

const ZH_DIGEST = `        "digest.doing": "进行中 {done}/{total} · {task}",
        "digest.pending": "待办 {total} 项 · {task}",
        "digest.done": "已完成 {total} 项 · {task}",`;

const EN_DIGEST = `        "digest.doing": "{done}/{total} in progress · {task}",
        "digest.pending": "{total} to do · {task}",
        "digest.done": "all {total} done · {task}",`;

const OLD_SESSION_NODE = `          updatedAt: s.updatedAt,
          archived: archived.has(s.id),
          ...pendingInteraction === void 0 ? {} : { pendingInteraction }
        };
      }`;

const NEW_SESSION_NODE = `          updatedAt: s.updatedAt,
          archived: archived.has(s.id),
          projectionValues: s.projectionValues,
          ...pendingInteraction === void 0 ? {} : { pendingInteraction }
        };
      }`;

const OLD_ARCHIVE_META = `children: turnCountById[session.id] === void 0 ? archiveTimeLabel(session.updatedAt, t) : archiveTimeLabel(session.updatedAt, t) + " · " + t("archives.turnCount", { n: turnCountById[session.id] })`;

const NEW_ARCHIVE_META = `children: [archiveTimeLabel(session.updatedAt, t), turnCountById[session.id] === void 0 ? null : t("archives.turnCount", { n: turnCountById[session.id] }), todoDigestText(digestBySession[session.id]?.todo, t)].filter((part) => part !== null && part !== void 0 && part !== "").join(" · ")`;

const OLD_TURNS_REQUEST = `      async function requestArchivedTurnCounts(sessionIds) {
        const list = Array.isArray(sessionIds) ? sessionIds : [];
        const query = list.length === 0 ? "" : "?sessionIds=" + encodeURIComponent(list.join(","));
        const response = await fetch(TURN_COUNTS_ENDPOINT + query, {
          method: "GET",
          headers: { accept: "application/json" }
        });
        if (response.ok !== true) throw new Error("turn-count lookup failed with status " + String(response.status));
        const payload = await response.json();
        const counts = {};
        const items = Array.isArray(payload?.items) ? payload.items : [];
        for (const item of items) {
          if (item !== null && typeof item === "object" && typeof item.sessionId === "string" && typeof item.turnCount === "number" && Number.isFinite(item.turnCount)) {
            counts[item.sessionId] = item.turnCount;
          }
        }
        return counts;
      }`;

const NEW_TURNS_REQUEST = `      async function requestArchivedTurnCounts(sessionIds) {
        const items = await requestSessionDigests(sessionIds);
        archiveDigestStore.merge(items);
        const counts = {};
        for (const item of items) {
          if (item !== null && typeof item === "object" && typeof item.sessionId === "string" && typeof item.turnCount === "number" && Number.isFinite(item.turnCount)) {
            counts[item.sessionId] = item.turnCount;
          }
        }
        return counts;
      }`;

const PATCHES = [
  {
    name: "D1-摘要工具/store/请求队列",
    anchor: `      const ARCHIVE_PINNED_STORAGE_KEY = "dsham.pinnedSessions.v1";`,
    replace: () => DIGEST_HELPERS + `      const ARCHIVE_PINNED_STORAGE_KEY = "dsham.pinnedSessions.v1";`
  },
  {
    name: "D2-摘要中文词条",
    anchor: `        "pin.aria.unpin": "取消置顶会话“{name}”",`,
    replace: (m) => m + "\n" + ZH_DIGEST
  },
  {
    name: "D3-摘要英文词条",
    anchor: `        "pin.aria.unpin": "Unpin chat {name}",`,
    replace: (m) => m + "\n" + EN_DIGEST
  },
  {
    name: "D4-会话节点透传 todo 投影",
    anchor: OLD_SESSION_NODE,
    replace: () => NEW_SESSION_NODE
  },
  // 说明（2026-09-14 用户反馈）：曾有一版在**侧栏会话行**也渲染摘要小字（原 D5 按需请求 + D6 行内渲染，
  // 共 2 处补丁），因左侧空间紧张、挤占原有对话清单可读性，已整体撤销。
  // 摘要现在只在「设置 → 归档会话」列表行显示（见 D7/D8/D9）。如需恢复侧栏显示，从备份目录取回这两处补丁即可。
  {
    name: "D7-归档页订阅摘要 store",
    anchor: `        const favoriteSessionIdSet = (0, react.useMemo)(() => new Set(favoriteSessionIds), [favoriteSessionIds]);`,
    replace: (m) =>
      m +
      `
        const digestBySession = (0, react.useSyncExternalStore)(archiveDigestStore.subscribe, archiveDigestStore.getSnapshot);`
  },
  {
    name: "D8-归档页打开即加载摘要（不再限于轮次排序）",
    anchor: `          if (sortBy !== "turns") return;
          let cancelled = false;
          setTurnsStatus("loading");`,
    replace: () => `          if (workspaceState.archivedSessionIds.length === 0) return;
          let cancelled = false;
          setTurnsStatus("loading");`
  },
  // 说明（2026-09-14 用户反馈第 2 轮）：摘要**不再**直接显示在归档列表行内（原 D9 已撤销），
  // 改为归档页头部按钮打开弹窗查看 —— 见 apply-digest-view-patch.mjs。
  // 列表行保持第一批的形态：`时间 · n 轮`。
  {
    name: "D10-轮次请求改走 digest 端点（顺带缓存 todo）",
    anchor: OLD_TURNS_REQUEST,
    replace: () => NEW_TURNS_REQUEST
  },
  {
    name: "D11-摘要小字样式",
    anchor: `.dsham_pinBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#f5a623}`,
    replace: (m) => m + `.dsham_digest{margin-left:6px;min-width:0;flex:0 1 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`
  },
  {
    name: "D12-导出摘要探针钩子",
    anchor: `        archivePinStore,
        sortPinnedFirst,`,
    replace: () => `        archivePinStore,
        sortPinnedFirst,
        sessionNode,
        todoDigestFromProjection,
        todoDigestText,
        truncateDigestText,
        archiveDigestStore,
        scheduleSessionDigest,
        requestSessionDigests,
        SESSION_DIGEST_ENDPOINT,
        ARCHIVE_DIGEST_STORAGE_KEY,`
  }
];

function applyOnce(text, patch) {
  const occurrences = text.split(patch.anchor).length - 1;
  if (occurrences !== 1) return { ok: false, reason: `锚点命中 ${occurrences} 次（期望 1 次）` };
  return { ok: true, text: text.replace(patch.anchor, patch.replace(patch.anchor)) };
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (!existsSync(TARGET)) {
    console.error(`目标文件不存在：${TARGET}`);
    process.exit(2);
  }

  const original = readFileSync(TARGET, "utf8");
  const hasBom = original.charCodeAt(0) === 0xfeff;
  let current = hasBom ? original.slice(1) : original;
  const log = [];
  let failed = 0;

  for (const patch of PATCHES) {
    const result = applyOnce(current, patch);
    if (result.ok) {
      current = result.text;
      log.push(`  [ok]   ${patch.name}`);
    } else {
      failed += 1;
      log.push(`  [FAIL] ${patch.name} — ${result.reason}`);
    }
  }

  console.log(`目标：${TARGET}`);
  console.log(log.join("\n"));

  if (failed > 0) {
    console.error(`\n${failed} 处锚点失配：未写盘。请确认前三批补丁已应用。`);
    process.exit(1);
  }

  if (args.has("--dry-run")) {
    console.log(`\n--dry-run：${PATCHES.length} 处锚点全部命中且唯一，未写盘。`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(BACKUP_ROOT, `archive-manager-digest-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, "client.js.orig");
  copyFileSync(TARGET, backupPath);
  writeFileSync(TARGET, (hasBom ? "\ufeff" : "") + current, { encoding: "utf8" });
  console.log(`\n已应用 ${PATCHES.length} 处补丁。\n备份：${backupPath}\n提示：重启 DSH 后生效。`);
}

main();
