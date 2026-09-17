#!/usr/bin/env node
/**
 * @michengai/dsh-archive-manager 本地增强补丁（client 侧）
 *
 * 功能：
 *   A. 归档会话页（设置 → 归档会话）：星标收藏 / 只看收藏 / 收藏置顶 / 删除全部未收藏 / 删除当前筛选内未收藏
 *   B. 侧栏会话行「…」展开菜单：收藏（切换）、复制会话 ID、复制会话文件路径、一键复制 ID + 文件路径
 *
 * 配套宿主侧改动（本目录 sibling 文件，另行安装）：
 *   lib/session-path.js（新增只读路由 /api/michengai/dsh-archive-manager/session-path）
 *   lib/index.js（注册该路由）
 *
 * 用法：
 *   node apply-patch.mjs --dry-run  # 只校验锚点命中，不写盘
 *   node apply-patch.mjs            # 应用补丁（自动备份）
 *   node apply-patch.mjs --revert   # 回滚到最近一次自动备份
 *
 * 纪律：每处替换断言锚点恰好命中一次，任一失配则整体放弃写盘；保持 LF 与原编码。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const TARGET = resolve(
  process.env.DSH_ARCHIVE_MANAGER_DIR ??
    join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager"),
  "lib",
  "client.js"
);
const BACKUP_ROOT = join(homedir(), ".dsh", "backups");

const STORAGE_KEY = "dsham.favoriteArchivedSessions.v1";
const SESSION_PATH_ENDPOINT = "/api/michengai/dsh-archive-manager/session-path";

const FAVORITES_CSS =
  ".dsham_settingsToolbar{flex-wrap:wrap}" +
  ".dsham_settingsStar{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;flex:none;padding:0;color:var(--dsw-alias-label-tertiary);background:transparent;border:0;border-radius:50%;cursor:pointer}" +
  ".dsham_settingsStar:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
  ".dsham_settingsStar[data-favorite=true]{color:#f5a623}" +
  ".dsham_settingsStar:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:2px}" +
  ".dsham_settingsStar:disabled{cursor:not-allowed;opacity:.5}" +
  ".dsham_settingsFavoritesToggle{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 12px;flex:none;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;font:inherit;font-size:12px;font-weight:500}" +
  ".dsham_settingsFavoritesToggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
  ".dsham_settingsFavoritesToggle[data-active=true]{color:#f5a623;border-color:#f5a623;background:color-mix(in srgb,#f5a623 14%,transparent)}" +
  ".dsham_settingsFavoritesCount{display:inline-flex;align-items:center;min-height:32px;color:var(--dsw-alias-label-tertiary);font-size:12px}" +
  ".dsham_settingsDangerQuiet{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 12px;flex:none;color:var(--dsw-alias-state-error-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;font:inherit;font-size:12px;font-weight:500}" +
  ".dsham_settingsDangerQuiet:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}" +
  ".dsham_settingsDangerQuiet:disabled,.dsham_settingsFavoritesToggle:disabled{cursor:not-allowed;opacity:.5}" +
  ".dsham_copyNotice{color:var(--dsw-alias-state-success-primary,#3fb950)!important;font-size:11px;white-space:nowrap}";

const HELPERS = `      const ARCHIVE_FAVORITES_STORAGE_KEY = "${STORAGE_KEY}";
      const SESSION_PATH_ENDPOINT = "${SESSION_PATH_ENDPOINT}";
      function readFavoriteSessionIds() {
        try {
          const raw = globalThis.localStorage?.getItem(ARCHIVE_FAVORITES_STORAGE_KEY);
          if (raw === null || raw === void 0) return [];
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return [];
          return [...new Set(parsed.filter((sessionId) => typeof sessionId === "string" && sessionId !== ""))];
        } catch (error) {
          return [];
        }
      }
      function writeFavoriteSessionIds(sessionIds) {
        try {
          globalThis.localStorage?.setItem(ARCHIVE_FAVORITES_STORAGE_KEY, JSON.stringify([...new Set(sessionIds)]));
        } catch (error) {
          console.warn("archive-manager: favorite session ids could not be persisted:", error);
        }
      }
      function toggleFavoriteSessionId(sessionIds, sessionId) {
        return sessionIds.includes(sessionId) ? sessionIds.filter((id) => id !== sessionId) : [...sessionIds, sessionId];
      }
      function deriveUnfavoritedSessionIds(sessionIds, favoriteSessionIds) {
        const favorites = favoriteSessionIds instanceof Set ? favoriteSessionIds : new Set(favoriteSessionIds);
        return [...new Set(sessionIds ?? [])].filter((sessionId) => !favorites.has(sessionId));
      }
      /** 收藏集合的共享 store：设置页与侧栏会话行订阅同一份状态。 */
      const archiveFavoriteStore = (() => {
        let sessionIds = readFavoriteSessionIds();
        const listeners = /* @__PURE__ */ new Set();
        const emit = () => {
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              console.warn("archive-manager: favorite listener failed:", error);
            }
          }
        };
        const commit = (next) => {
          sessionIds = next;
          writeFavoriteSessionIds(next);
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
      async function requestSessionPath(sessionId) {
        const response = await fetch(SESSION_PATH_ENDPOINT + "?sessionId=" + encodeURIComponent(sessionId), {
          method: "GET",
          headers: { accept: "application/json" }
        });
        if (response.ok !== true) throw new Error("session path lookup failed with status " + String(response.status));
        const payload = await response.json();
        if (typeof payload?.path !== "string" || payload.path === "") throw new Error("session path is unavailable");
        return payload.path;
      }
      async function copyTextToClipboard(text) {
        if (navigator.clipboard === void 0 || typeof navigator.clipboard.writeText !== "function") throw new Error("clipboard is unavailable");
        await navigator.clipboard.writeText(text);
      }
      function sessionClipboardMenuItems(t, favorite) {
        return [
          {
            id: "favorite",
            label: t(favorite === true ? "menu.unfavorite" : "menu.favorite"),
            icon: (0, react_jsx_runtime.jsx)(ArchiveStarIcon, { filled: favorite === true })
          },
          {
            id: "copy-id",
            label: t("menu.copySessionId"),
            icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, {})
          },
          {
            id: "copy-path",
            label: t("menu.copySessionPath"),
            icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutline16, {})
          },
          {
            id: "copy-both",
            label: t("menu.copySessionIdAndPath"),
            icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLinkOutline16, {})
          }
        ];
      }
      function ArchiveStarIcon({ filled }) {
        return (0, react_jsx_runtime.jsx)("svg", {
          width: 16,
          height: 16,
          viewBox: "0 0 16 16",
          "aria-hidden": true,
          focusable: false,
          children: (0, react_jsx_runtime.jsx)("path", {
            d: "M8 1.9l1.86 3.77 4.16.6-3.01 2.94-.71 4.14L8 11.42l-3.3 1.93-.71-4.14-3.01-2.94 4.16-.6z",
            fill: filled === true ? "currentColor" : "none",
            stroke: "currentColor",
            strokeWidth: "1.3",
            strokeLinejoin: "round"
          })
        });
      }
`;

const ZH_FAVORITES = `        "archives.favorite": "收藏",
        "archives.unfavorite": "取消收藏",
        "archives.favoriteSession": "收藏聊天“{name}”",
        "archives.unfavoriteSession": "取消收藏聊天“{name}”",
        "archives.onlyFavorites": "只看收藏",
        "archives.onlyFavoritesAria": "只显示已收藏的归档聊天",
        "archives.favoriteCount": "已收藏 {n} 条",
        "archives.favoriteEmpty": "还没有收藏的归档聊天。点击聊天左侧的星标即可收藏，之后可在这里一键筛出。",
        "archives.deleteUnfavoritedAll": "删除全部未收藏",
        "archives.deleteUnfavoritedFiltered": "删除未收藏",
        "archives.deleteUnfavoritedTitle": "删除未收藏的归档聊天",
        "archives.deleteUnfavoritedAllDesc": "将永久删除全部 {n} 个未收藏的已归档聊天及其子代理（含正在运行的）和记录；已收藏的聊天会保留。此操作不可恢复。",
        "archives.deleteUnfavoritedFilteredDesc": "将永久删除当前筛选结果中 {n} 个未收藏的已归档聊天及其子代理（含正在运行的）和记录；已收藏的聊天会保留。此操作不可恢复。",
        "archives.deleteUnfavoritedConfirm": "删除未收藏的聊天",`;

const EN_FAVORITES = `        "archives.favorite": "Favorite",
        "archives.unfavorite": "Remove from favorites",
        "archives.favoriteSession": "Favorite chat {name}",
        "archives.unfavoriteSession": "Remove chat {name} from favorites",
        "archives.onlyFavorites": "Favorites only",
        "archives.onlyFavoritesAria": "Show favorited archived chats only",
        "archives.favoriteCount": "{n} favorited",
        "archives.favoriteEmpty": "No favorited archived chats yet. Use the star next to a chat to favorite it.",
        "archives.deleteUnfavoritedAll": "Delete all unfavorited",
        "archives.deleteUnfavoritedFiltered": "Delete unfavorited",
        "archives.deleteUnfavoritedTitle": "Delete unfavorited archived chats",
        "archives.deleteUnfavoritedAllDesc": "This permanently deletes the {n} archived chats that are not favorited, their child agents (including any that are still running), and their records. Favorited chats are kept. This cannot be undone.",
        "archives.deleteUnfavoritedFilteredDesc": "This permanently deletes the {n} unfavorited archived chats in the current results, their child agents (including any that are still running), and their records. Favorited chats are kept. This cannot be undone.",
        "archives.deleteUnfavoritedConfirm": "Delete unfavorited chats",`;

const ZH_MENU = `        "menu.favorite": "收藏会话",
        "menu.unfavorite": "取消收藏",
        "menu.copySessionId": "复制会话 ID",
        "menu.copySessionPath": "复制会话文件路径",
        "menu.copySessionIdAndPath": "复制 ID + 文件路径",
        "copy.idDone": "已复制 ID",
        "copy.pathPending": "正在解析路径…",
        "copy.pathDone": "已复制路径",
        "copy.bothDone": "已复制 ID + 路径",
        "copy.pathFailed": "未找到会话文件路径",
        "copy.failed": "复制失败",`;

const EN_MENU = `        "menu.favorite": "Favorite session",
        "menu.unfavorite": "Remove from favorites",
        "menu.copySessionId": "Copy session ID",
        "menu.copySessionPath": "Copy session file path",
        "menu.copySessionIdAndPath": "Copy ID + file path",
        "copy.idDone": "ID copied",
        "copy.pathPending": "Resolving path\u2026",
        "copy.pathDone": "Path copied",
        "copy.bothDone": "ID + path copied",
        "copy.pathFailed": "Session file path not found",
        "copy.failed": "Copy failed",`;

const OLD_SESSION_MENU = `        const sessionMenuItems = archived ? [
          {
            id: "unarchive",
            label: t("menu.unarchive"),
            icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })
          },
          {
            id: "delete-session",
            label: t("menu.deleteSession"),
            icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
            danger: true
          }
        ] : [
          {
            id: "rename",
            label: t("rename"),
            icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, {})
          },
          {
            id: "fork",
            label: t("menu.fork"),
            icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {})
          },
          {
            id: "archive",
            label: t("menu.archiveSession"),
            icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })
          },
          {
            id: "delete-session",
            label: t("menu.deleteSession"),
            icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
            danger: true
          }
        ];`;

const NEW_SESSION_MENU = `        const sessionMenuItems = [
          ...sessionClipboardMenuItems(t, favorite),
          ...(archived ? [
            {
              id: "unarchive",
              label: t("menu.unarchive"),
              icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })
            },
            {
              id: "delete-session",
              label: t("menu.deleteSession"),
              icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
              danger: true
            }
          ] : [
            {
              id: "rename",
              label: t("rename"),
              icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, {})
            },
            {
              id: "fork",
              label: t("menu.fork"),
              icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {})
            },
            {
              id: "archive",
              label: t("menu.archiveSession"),
              icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })
            },
            {
              id: "delete-session",
              label: t("menu.deleteSession"),
              icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
              danger: true
            }
          ])
        ];`;

const PATCHES = [
  {
    name: "01-收藏与复制提示样式",
    anchor: `.dsham_settingsSelectionAction+.dsham_settingsSelectionAction{margin-left:-2px}}";`,
    replace: (m) => m.replace(/";$/, FAVORITES_CSS + '";')
  },
  {
    name: "02-收藏工具函数/store/剪贴板/菜单项与星标图标",
    anchor: `      const ARCHIVE_UNGROUPED_KEY = "__ungrouped__";`,
    replace: () => HELPERS + `      const ARCHIVE_UNGROUPED_KEY = "__ungrouped__";`
  },
  {
    name: "03-归档页中文词条",
    anchor: `        "archives.selectedScope": "\\u5DF2\\u9009 {n} \\u6761\\uFF0C\\u5176\\u4E2D {hidden} \\u6761\\u4E0D\\u5728\\u5F53\\u524D\\u7ED3\\u679C",
        "archives.clearSelection": "\\u6E05\\u7A7A\\u9009\\u62E9",`,
    replace: (m) => m + "\n" + ZH_FAVORITES
  },
  {
    name: "04-归档页英文词条",
    anchor: `        "archives.selectedScope": "{n} selected, {hidden} outside current results",
        "archives.clearSelection": "Clear selection",`,
    replace: (m) => m + "\n" + EN_FAVORITES
  },
  {
    name: "05-侧栏菜单中文词条",
    anchor: `        "menu.unarchive": "\\u53D6\\u6D88\\u5F52\\u6863",
        "menu.deleteSession": "\\u5220\\u9664\\u4F1A\\u8BDD",`,
    replace: (m) => m + "\n" + ZH_MENU
  },
  {
    name: "06-侧栏菜单英文词条",
    anchor: `        "menu.unarchive": "Unarchive",
        "menu.deleteSession": "Delete session",`,
    replace: (m) => m + "\n" + EN_MENU
  },
  {
    name: "07-归档页收藏状态（共享 store）",
    anchor: `        const [selectedSessionIds, setSelectedSessionIds] = (0, react.useState)([]);`,
    replace: (m) =>
      m +
      `
        const favoriteSessionIds = (0, react.useSyncExternalStore)(archiveFavoriteStore.subscribe, archiveFavoriteStore.getSnapshot);
        const [favoritesOnly, setFavoritesOnly] = (0, react.useState)(false);
        const favoriteSessionIdSet = (0, react.useMemo)(() => new Set(favoriteSessionIds), [favoriteSessionIds]);`
  },
  {
    name: "08-归档页筛选与收藏置顶",
    anchor: `          return sortedGroups.filter((group) => project === "all" || project === group.key).map((group) => ({
            ...group,
            sessions: group.sessions.filter((session) => normalizedQuery === "" || displayTitle(session, t).toLocaleLowerCase().includes(normalizedQuery))
          })).filter((group) => group.sessions.length > 0);
        }, [sortedGroups, project, query, t]);`,
    replace: () => `          const favoriteRank = (session) => favoriteSessionIdSet.has(session.id) ? 0 : 1;
          return sortedGroups.filter((group) => project === "all" || project === group.key).map((group) => ({
            ...group,
            sessions: group.sessions.filter((session) => normalizedQuery === "" || displayTitle(session, t).toLocaleLowerCase().includes(normalizedQuery)).filter((session) => favoritesOnly !== true || favoriteSessionIdSet.has(session.id)).sort((left, right) => favoriteRank(left) - favoriteRank(right))
          })).filter((group) => group.sessions.length > 0);
        }, [sortedGroups, project, query, t, favoritesOnly, favoriteSessionIdSet]);`
  },
  {
    name: "09-未收藏集合派生",
    anchor: `        const visibleSessionIds = (0, react.useMemo)(() => archivedSessionIdsInGroups(filteredGroups), [filteredGroups]);`,
    replace: (m) =>
      m +
      `
        const listedArchivedSessionIds = (0, react.useMemo)(() => archivedSessionIdsInGroups(sortedGroups), [sortedGroups]);
        const unfavoritedListedIds = (0, react.useMemo)(() => deriveUnfavoritedSessionIds(listedArchivedSessionIds, favoriteSessionIdSet), [listedArchivedSessionIds, favoriteSessionIdSet]);
        const unfavoritedVisibleIds = (0, react.useMemo)(() => deriveUnfavoritedSessionIds(visibleSessionIds, favoriteSessionIdSet), [visibleSessionIds, favoriteSessionIdSet]);
        const favoriteCount = favoriteSessionIdSet.size;`
  },
  {
    name: "10-归档页收藏操作函数",
    anchor: `        const toggleVisibleSelection = (checked) => {
          setSelectedSessionIds((current) => toggleArchivedSelection(current, visibleSessionIds, checked));
        };`,
    replace: (m) =>
      m +
      `
        const toggleFavorite = (sessionId) => {
          archiveFavoriteStore.toggle(sessionId);
        };
        const pruneFavorites = (sessionIds) => {
          archiveFavoriteStore.prune(sessionIds);
        };`
  },
  {
    name: "11-删除确认：未收藏变体标题",
    anchor: `        const deleteDialogTitle = batchScope === "all" ? t("archives.deleteAllTitle")`,
    replace: () => `        const unfavoritedTarget = deleteTarget?.variant === "unfavorited";
        const deleteDialogTitle = unfavoritedTarget ? t("archives.deleteUnfavoritedTitle") : batchScope === "all" ? t("archives.deleteAllTitle")`
  },
  {
    name: "12-删除确认：未收藏变体描述",
    anchor: `        const deleteDialogDescription = deleteTarget === null ? void 0 : batchScope === "all" ?`,
    replace: () => `        const deleteDialogDescription = deleteTarget === null ? void 0 : unfavoritedTarget ? t(deleteTarget.filtered === true ? "archives.deleteUnfavoritedFilteredDesc" : "archives.deleteUnfavoritedAllDesc", { n: deleteTarget.count }) : batchScope === "all" ?`
  },
  {
    name: "13-删除确认：未收藏变体按钮",
    anchor: `        const deleteConfirmLabel = batchScope === "all" ?`,
    replace: () => `        const deleteConfirmLabel = unfavoritedTarget ? t("archives.deleteUnfavoritedConfirm") : batchScope === "all" ?`
  },
  {
    name: "14-删除后清理收藏",
    anchor: `              if (deleteTarget.target.scope === "sessions") {
                const completed = /* @__PURE__ */ new Set([...result.deletedSessionIds, ...result.skippedSessionIds]);
                setSelectedSessionIds((current) => current.filter((sessionId) => !completed.has(sessionId)));
              }
            } else {
              await deleteSession(deleteTarget.session.id);
            }`,
    replace: () => `              const completed = /* @__PURE__ */ new Set([...result.deletedSessionIds, ...result.skippedSessionIds]);
              if (deleteTarget.target.scope === "sessions") {
                setSelectedSessionIds((current) => current.filter((sessionId) => !completed.has(sessionId)));
              }
              pruneFavorites(completed);
            } else {
              await deleteSession(deleteTarget.session.id);
              pruneFavorites([deleteTarget.session.id]);
            }`
  },
  {
    name: "15-头部『删除全部未收藏』按钮",
    anchor: `, (0, react_jsx_runtime.jsxs)("button", { type: "button", className: "dsham_settingsDanger", disabled: busy || allBatchSessionIds.length === 0, onClick: () => setDeleteTarget({ kind: "batch", target: allBatchTarget, title: t("archives.allProjects"), count: allBatchSessionIds.length }), children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}), t("archives.deleteAll")] })]`,
    replace: (m) =>
      m.replace(
        /\}\)\]$/,
        `}), (0, react_jsx_runtime.jsxs)("button", { type: "button", className: "dsham_settingsDangerQuiet", disabled: busy || unfavoritedListedIds.length === 0, title: t("archives.deleteUnfavoritedTitle"), onClick: () => setDeleteTarget({ kind: "batch", variant: "unfavorited", filtered: false, target: { scope: "sessions", sessionIds: unfavoritedListedIds }, count: unfavoritedListedIds.length }), children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}), t("archives.deleteUnfavoritedAll")] })]`
      )
  },
  {
    name: "16-工具栏『只看收藏』开关",
    anchor: `            }), (0, react_jsx_runtime.jsx)(ArchiveProjectSelect, { id: "dsham-sort-filter",`,
    replace: () =>
      `            }), (0, react_jsx_runtime.jsxs)("button", { type: "button", className: "dsham_settingsFavoritesToggle", "data-active": favoritesOnly, "aria-pressed": favoritesOnly, "aria-label": t("archives.onlyFavoritesAria"), title: t("archives.onlyFavoritesAria"), disabled: busy, onClick: () => setFavoritesOnly((current) => !current), children: [(0, react_jsx_runtime.jsx)(ArchiveStarIcon, { filled: favoritesOnly }), t("archives.onlyFavorites")] }), favoriteCount > 0 ? (0, react_jsx_runtime.jsx)("span", { className: "dsham_settingsFavoritesCount", children: t("archives.favoriteCount", { n: favoriteCount }) }) : null, (0, react_jsx_runtime.jsx)(ArchiveProjectSelect, { id: "dsham-sort-filter",`
  },
  {
    name: "17-工具栏『删除未收藏(当前筛选)』按钮",
    anchor: `, (0, react_jsx_runtime.jsx)(ArchiveProjectSelect, { id: "dsham-project-filter", value: project, options: [{ value: "all", label: t("archives.allProjects") }, ...sortedGroups.map((group) => ({ value: group.key, label: group.title }))], onChange: setProject, "aria-label": t("archives.projectFilter") })]`,
    replace: (m) =>
      m.replace(
        /\}\)\]$/,
        `}), (0, react_jsx_runtime.jsxs)("button", { type: "button", className: "dsham_settingsDangerQuiet", disabled: busy || unfavoritedVisibleIds.length === 0, title: t("archives.deleteUnfavoritedTitle"), onClick: () => setDeleteTarget({ kind: "batch", variant: "unfavorited", filtered: true, target: { scope: "sessions", sessionIds: unfavoritedVisibleIds }, count: unfavoritedVisibleIds.length }), children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}), t("archives.deleteUnfavoritedFiltered")] })]`
      )
  },
  {
    name: "18-归档列表行内星标按钮",
    anchor: `, onChange: (event) => toggleSessionSelection(session.id, event.target.checked) }), (0, react_jsx_runtime.jsxs)("div", {`,
    replace: () =>
      `, onChange: (event) => toggleSessionSelection(session.id, event.target.checked) }), (0, react_jsx_runtime.jsx)("button", { type: "button", className: "dsham_settingsStar", "data-favorite": favoriteSessionIdSet.has(session.id), "aria-pressed": favoriteSessionIdSet.has(session.id), "aria-label": t(favoriteSessionIdSet.has(session.id) ? "archives.unfavoriteSession" : "archives.favoriteSession", { name: displayTitle(session, t) }), title: t(favoriteSessionIdSet.has(session.id) ? "archives.unfavorite" : "archives.favorite"), disabled: busy, onClick: () => toggleFavorite(session.id), children: (0, react_jsx_runtime.jsx)(ArchiveStarIcon, { filled: favoriteSessionIdSet.has(session.id) }) }), (0, react_jsx_runtime.jsx)("div", {`
  },
  {
    name: "19-归档页收藏空态文案",
    anchor: `filteredGroups.length === 0 ? (0, react_jsx_runtime.jsx)("div", { className: "dsham_settingsEmpty", children: t("archives.emptyFiltered") }) : filteredGroups.map((group) => {`,
    replace: () => `filteredGroups.length === 0 ? (0, react_jsx_runtime.jsx)("div", { className: "dsham_settingsEmpty", children: favoritesOnly === true && favoriteCount === 0 ? t("archives.favoriteEmpty") : t("archives.emptyFiltered") }) : filteredGroups.map((group) => {`
  },
  {
    name: "20-侧栏会话行：收藏与复制状态",
    anchor: `        const [menuOpen, setMenuOpen] = (0, react.useState)(false);
        const sessionMenuItems = archived ? [`,
    replace: () => `        const [menuOpen, setMenuOpen] = (0, react.useState)(false);
        const favoriteSessionIds = (0, react.useSyncExternalStore)(archiveFavoriteStore.subscribe, archiveFavoriteStore.getSnapshot);
        const favorite = favoriteSessionIds.includes(node.id);
        const [copyNotice, setCopyNotice] = (0, react.useState)(null);
        const copyNoticeTimer = (0, react.useRef)(void 0);
        (0, react.useEffect)(() => () => {
          if (copyNoticeTimer.current !== void 0) clearTimeout(copyNoticeTimer.current);
        }, []);
        const showCopyNotice = (message) => {
          setCopyNotice(message);
          if (copyNoticeTimer.current !== void 0) clearTimeout(copyNoticeTimer.current);
          copyNoticeTimer.current = setTimeout(() => {
            setCopyNotice(null);
          }, 2400);
        };
        const copySessionId = (sessionId) => {
          copyTextToClipboard(sessionId).then(() => showCopyNotice(t("copy.idDone"))).catch(() => showCopyNotice(t("copy.failed")));
        };
        const copySessionPath = (sessionId) => {
          showCopyNotice(t("copy.pathPending"));
          requestSessionPath(sessionId).then((path) => copyTextToClipboard(path)).then(() => showCopyNotice(t("copy.pathDone"))).catch(() => showCopyNotice(t("copy.pathFailed")));
        };
        const copySessionIdAndPath = (sessionId) => {
          showCopyNotice(t("copy.pathPending"));
          requestSessionPath(sessionId).then((path) => copyTextToClipboard(sessionId + "\\n" + path)).then(() => showCopyNotice(t("copy.bothDone"))).catch(() => showCopyNotice(t("copy.failed")));
        };
        const sessionMenuItems = archived ? [`
  },
  {
    name: "21-侧栏会话菜单项重构（加入收藏与复制）",
    anchor: OLD_SESSION_MENU,
    replace: () => NEW_SESSION_MENU
  },
  {
    name: "22-侧栏会话菜单选中分支",
    anchor: `                  onSelect: (id) => {
                    setMenuOpen(false);
                    if (id === "rename") onRename(node.id, row.title);`,
    replace: () => `                  onSelect: (id) => {
                    setMenuOpen(false);
                    if (id === "favorite") archiveFavoriteStore.toggle(node.id);
                    if (id === "copy-id") copySessionId(node.id);
                    if (id === "copy-path") copySessionPath(node.id);
                    if (id === "copy-both") copySessionIdAndPath(node.id);
                    if (id === "rename") onRename(node.id, row.title);`
  },
  {
    name: "23-侧栏行内复制结果提示",
    anchor: `              !row.blank && (0, react_jsx_runtime.jsx)("span", {
                className: Rows_module_css_default.time,
                children: timeLabel(row.updatedAt, now, t)
              }),`,
    replace: () => `              !row.blank && (0, react_jsx_runtime.jsx)("span", {
                className: clsx(Rows_module_css_default.time, copyNotice === null ? void 0 : "dsham_copyNotice"),
                children: copyNotice === null ? timeLabel(row.updatedAt, now, t) : copyNotice
              }),`
  },
  {
    name: "24-导出探针钩子",
    anchor: `        deriveArchivedBatchIds,
        archivedSessionIdsInGroups,`,
    replace: () => `        deriveArchivedBatchIds,
        deriveUnfavoritedSessionIds,
        toggleFavoriteSessionId,
        readFavoriteSessionIds,
        writeFavoriteSessionIds,
        sessionClipboardMenuItems,
        archiveFavoriteStore,
        ARCHIVE_FAVORITES_STORAGE_KEY,
        SESSION_PATH_ENDPOINT,
        archivedSessionIdsInGroups,`
  }
];

function backup(sourcePath) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(BACKUP_ROOT, `archive-manager-client-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "client.js.orig");
  copyFileSync(sourcePath, target);
  return target;
}

function latestBackup() {
  if (!existsSync(BACKUP_ROOT)) return void 0;
  const dirs = readdirSync(BACKUP_ROOT)
    .filter((name) => name.startsWith("archive-manager-"))
    .map((name) => join(BACKUP_ROOT, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory() && existsSync(join(path, "client.js.orig"));
      } catch {
        return false;
      }
    })
    .sort();
  const dir = dirs.at(-1);
  return dir === void 0 ? void 0 : join(dir, "client.js.orig");
}

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

  if (args.has("--revert")) {
    const backupPath = latestBackup();
    if (backupPath === void 0) {
      console.error(`找不到可回滚的备份（${BACKUP_ROOT}\\archive-manager-*）`);
      process.exit(2);
    }
    copyFileSync(backupPath, TARGET);
    console.log(`已回滚：${TARGET}\n来源备份：${backupPath}`);
    return;
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
    console.error(`\n${failed} 处锚点失配：未写盘（文件保持原样）。`);
    process.exit(1);
  }

  if (args.has("--dry-run")) {
    console.log(`\n--dry-run：${PATCHES.length} 处锚点全部命中且唯一，未写盘。`);
    return;
  }

  const backupPath = backup(TARGET);
  writeFileSync(TARGET, (hasBom ? "\ufeff" : "") + current, { encoding: "utf8" });
  console.log(`\n已应用 ${PATCHES.length} 处补丁。\n备份：${backupPath}\n提示：客户端 bundle 与宿主路由均需重启 DSH 后生效。`);
}

main();
