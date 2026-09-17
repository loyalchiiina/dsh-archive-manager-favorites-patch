#!/usr/bin/env node
/**
 * @michengai/dsh-archive-manager 本地增强补丁 · 第三批：会话置顶
 *
 * ⚠️ 执行顺序：apply-patch.mjs（第一批）→ apply-turns-patch.mjs（第二批）→ 本脚本。
 *    或用 apply-all.mjs 一把跑完三批。
 *
 * 功能：
 *   - 侧栏会话行「…」菜单新增「置顶会话 / 取消置顶」（localStorage 持久化，键 dsham.pinnedSessions.v1）；
 *   - 置顶会话在其所在分组内始终排最前（分组视图与单列表视图都生效，且不受「手动排序/最近更新」覆盖）；
 *   - 置顶会话标题前显示图钉标记。
 *
 * 用法：
 *   node apply-pin-patch.mjs --dry-run
 *   node apply-pin-patch.mjs
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

const PIN_HELPERS = `      const ARCHIVE_PINNED_STORAGE_KEY = "dsham.pinnedSessions.v1";
      function readPinnedSessionIds() {
        try {
          const raw = globalThis.localStorage?.getItem(ARCHIVE_PINNED_STORAGE_KEY);
          if (raw === null || raw === void 0) return [];
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return [];
          return [...new Set(parsed.filter((sessionId) => typeof sessionId === "string" && sessionId !== ""))];
        } catch (error) {
          return [];
        }
      }
      function writePinnedSessionIds(sessionIds) {
        try {
          globalThis.localStorage?.setItem(ARCHIVE_PINNED_STORAGE_KEY, JSON.stringify([...new Set(sessionIds)]));
        } catch (error) {
          console.warn("archive-manager: pinned session ids could not be persisted:", error);
        }
      }
      /** 置顶集合的共享 store：会话列表各视图与行组件订阅同一份状态。 */
      const archivePinStore = (() => {
        let sessionIds = readPinnedSessionIds();
        const listeners = /* @__PURE__ */ new Set();
        const emit = () => {
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              console.warn("archive-manager: pin listener failed:", error);
            }
          }
        };
        const commit = (next) => {
          sessionIds = next;
          writePinnedSessionIds(next);
          emit();
        };
        return {
          getSnapshot: () => sessionIds,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          toggle: (sessionId) => {
            commit(toggleFavoriteSessionId(sessionIds, sessionId));
          },
          prune: (sessionIdsToRemove) => {
            const removed = sessionIdsToRemove instanceof Set ? sessionIdsToRemove : new Set(sessionIdsToRemove);
            if (removed.size === 0) return;
            const next = sessionIds.filter((sessionId) => !removed.has(sessionId));
            if (next.length !== sessionIds.length) commit(next);
          }
        };
      })();
      /** 稳定排序：置顶项前置，其余保持原有相对顺序。 */
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
      }
      function ArchivePinIcon({ filled }) {
        return (0, react_jsx_runtime.jsxs)("svg", {
          width: 16,
          height: 16,
          viewBox: "0 0 16 16",
          "aria-hidden": true,
          focusable: false,
          children: [
            (0, react_jsx_runtime.jsx)("circle", {
              cx: 8,
              cy: 5.2,
              r: 3.1,
              fill: filled === true ? "currentColor" : "none",
              stroke: "currentColor",
              strokeWidth: "1.3"
            }),
            (0, react_jsx_runtime.jsx)("path", {
              d: "M8 8.4v6",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "1.3",
              strokeLinecap: "round"
            })
          ]
        });
      }
`;

const ZH_PIN = `        "menu.pin": "置顶会话",
        "menu.unpin": "取消置顶",
        "pin.label": "已置顶",
        "pin.aria.pin": "置顶会话“{name}”",
        "pin.aria.unpin": "取消置顶会话“{name}”",`;

const EN_PIN = `        "menu.pin": "Pin session",
        "menu.unpin": "Unpin session",
        "pin.label": "Pinned",
        "pin.aria.pin": "Pin chat {name}",
        "pin.aria.unpin": "Unpin chat {name}",`;

const OLD_GROUP = `      function buildGroup(key, workspaceId, cwd, createdAt, label, members, order) {
        const sessions = [...members];
        if (order === "recency") sessions.sort(byRecency);
        return {
          key,
          workspaceId,
          cwd,
          createdAt,
          label,
          sessions
        };
      }`;

const NEW_GROUP = `      function buildGroup(key, workspaceId, cwd, createdAt, label, members, order) {
        const sessions = [...members];
        if (order === "recency") sessions.sort(byRecency);
        return {
          key,
          workspaceId,
          cwd,
          createdAt,
          label,
          sessions: sortPinnedFirst(sessions)
        };
      }`;

const OLD_FLAT_ROWS = `        const rows = (0, react.useMemo)(() => {
          const byId = new Map(baseRows.map((row) => [row.id, row]));
          return reconciledSessionOrder(sessionIds, sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).flatMap((id) => {
            const row = byId.get(id);
            return row === void 0 ? [] : [row];
          });
        }, [
          baseRows,
          sessionOrderByAccount,
          sessionIds
        ]);`;

const NEW_FLAT_ROWS = `        const pinnedSessionIds = (0, react.useSyncExternalStore)(archivePinStore.subscribe, archivePinStore.getSnapshot);
        const pinnedIdsKey = pinnedSessionIds.join("|");
        const rows = (0, react.useMemo)(() => {
          const byId = new Map(baseRows.map((row) => [row.id, row]));
          const ordered = reconciledSessionOrder(sessionIds, sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).flatMap((id) => {
            const row = byId.get(id);
            return row === void 0 ? [] : [row];
          });
          return sortPinnedFirst(ordered);
        }, [
          baseRows,
          sessionOrderByAccount,
          sessionIds,
          pinnedIdsKey
        ]);`;

const OLD_TREE_GROUPS = `        const groups = (0, react.useMemo)(() => deriveGroups(list, orderedWorkspaces, archivedSessionIds, pendingInteractions, {
          expandedGroups,
          showArchived,
          ...sessionOrderByAccount[""] === void 0 ? {} : { ungroupedOrder: sessionOrderByAccount[""] }
        }), [
          list,
          orderedWorkspaces,
          archivedSessionIds,
          pendingInteractions,
          showArchived,
          expandedGroups,
          sessionOrderByAccount
        ]);`;

const NEW_TREE_GROUPS = `        const pinnedSessionIds = (0, react.useSyncExternalStore)(archivePinStore.subscribe, archivePinStore.getSnapshot);
        const pinnedIdsKey = pinnedSessionIds.join("|");
        const groups = (0, react.useMemo)(() => deriveGroups(list, orderedWorkspaces, archivedSessionIds, pendingInteractions, {
          expandedGroups,
          showArchived,
          ...sessionOrderByAccount[""] === void 0 ? {} : { ungroupedOrder: sessionOrderByAccount[""] }
        }), [
          list,
          orderedWorkspaces,
          archivedSessionIds,
          pendingInteractions,
          showArchived,
          expandedGroups,
          sessionOrderByAccount,
          pinnedIdsKey
        ]);`;

const PATCHES = [
  {
    name: "V1-置顶集合 store 与排序/图标工具",
    anchor: `      const archiveFavoriteStore = (() => {`,
    replace: () => PIN_HELPERS + `      const archiveFavoriteStore = (() => {`
  },
  {
    name: "V2-置顶中文词条",
    anchor: `        "menu.copySessionIdAndPath": "复制 ID + 文件路径",`,
    replace: (m) => m + "\n" + ZH_PIN
  },
  {
    name: "V3-置顶英文词条",
    anchor: `        "menu.copySessionIdAndPath": "Copy ID + file path",`,
    replace: (m) => m + "\n" + EN_PIN
  },
  {
    name: "V4-菜单项新增置顶",
    anchor: `      function sessionClipboardMenuItems(t, favorite) {
        return [
          {
            id: "favorite",`,
    replace: () => `      function sessionClipboardMenuItems(t, favorite, pinned) {
        return [
          {
            id: "pin",
            label: t(pinned === true ? "menu.unpin" : "menu.pin"),
            icon: (0, react_jsx_runtime.jsx)(ArchivePinIcon, { filled: pinned === true })
          },
          {
            id: "favorite",`
  },
  {
    name: "V5-会话行订阅置顶状态",
    anchor: `        const favorite = favoriteSessionIds.includes(node.id);`,
    replace: (m) =>
      m +
      `
        const pinnedSessionIds = (0, react.useSyncExternalStore)(archivePinStore.subscribe, archivePinStore.getSnapshot);
        const pinned = pinnedSessionIds.includes(node.id);`
  },
  {
    name: "V6-菜单项传入置顶状态",
    anchor: `          ...sessionClipboardMenuItems(t, favorite),`,
    replace: () => `          ...sessionClipboardMenuItems(t, favorite, pinned),`
  },
  {
    name: "V7-菜单选中分支新增置顶",
    anchor: `                    if (id === "favorite") archiveFavoriteStore.toggle(node.id);`,
    replace: (m) => m + `\n                    if (id === "pin") archivePinStore.toggle(node.id);`
  },
  {
    name: "V8-会话行图钉标记",
    anchor: `              }) : (0, react_jsx_runtime.jsx)("span", {
                className: Rows_module_css_default.title,
                children: title
              }),`,
    replace: () => `              }) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [pinned === true && (0, react_jsx_runtime.jsx)("span", { className: "dsham_pinBadge", title: t("pin.label"), "aria-label": t("pin.label"), children: (0, react_jsx_runtime.jsx)(ArchivePinIcon, { filled: true }) }), (0, react_jsx_runtime.jsx)("span", {
                className: Rows_module_css_default.title,
                children: title
              })] }),`
  },
  {
    name: "V9-分组视图：置顶优先",
    anchor: OLD_GROUP,
    replace: () => NEW_GROUP
  },
  {
    name: "V10-单列表派生：置顶优先",
    anchor: `        rows.sort(byRecency);
        return rows.map((session) => sessionNode(session, descendants, archived, pendingInteractions));`,
    replace: () => `        rows.sort(byRecency);
        return sortPinnedFirst(rows).map((session) => sessionNode(session, descendants, archived, pendingInteractions));`
  },
  {
    name: "V11-单列表视图：置顶优先（覆盖手动排序）",
    anchor: OLD_FLAT_ROWS,
    replace: () => NEW_FLAT_ROWS
  },
  {
    name: "V12-分组视图订阅置顶变化",
    anchor: OLD_TREE_GROUPS,
    replace: () => NEW_TREE_GROUPS
  },
  {
    name: "V13-图钉标记样式",
    anchor: `.dsham_copyNotice{color:var(--dsw-alias-state-success-primary,#3fb950)!important;font-size:11px;white-space:nowrap}`,
    replace: (m) => m + `.dsham_pinBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#f5a623}`
  },
  {
    name: "V14-导出置顶探针钩子",
    anchor: `        sessionClipboardMenuItems,
        archiveFavoriteStore,`,
    replace: () => `        sessionClipboardMenuItems,
        archiveFavoriteStore,
        archivePinStore,
        sortPinnedFirst,
        readPinnedSessionIds,
        writePinnedSessionIds,
        ARCHIVE_PINNED_STORAGE_KEY,`
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
    console.error(`\n${failed} 处锚点失配：未写盘。请确认前两批补丁（apply-patch.mjs / apply-turns-patch.mjs）已应用。`);
    process.exit(1);
  }

  if (args.has("--dry-run")) {
    console.log(`\n--dry-run：${PATCHES.length} 处锚点全部命中且唯一，未写盘。`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(BACKUP_ROOT, `archive-manager-pin-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, "client.js.orig");
  copyFileSync(TARGET, backupPath);
  writeFileSync(TARGET, (hasBom ? "\ufeff" : "") + current, { encoding: "utf8" });
  console.log(`\n已应用 ${PATCHES.length} 处补丁。\n备份：${backupPath}\n提示：重启 DSH 后生效。`);
}

main();
