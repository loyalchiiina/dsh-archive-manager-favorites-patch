#!/usr/bin/env node
/**
 * @michengai/dsh-archive-manager 本地增强补丁 · 第二批：归档页「按对话轮次排序」
 *
 * ⚠️ 执行顺序：必须先跑 apply-patch.mjs（第一批 24 处），再跑本脚本（本脚本锚点基于其产物）。
 *    可直接用 apply-all.mjs 一把跑完两批。
 *
 * 数据来源：宿主端新增路由 GET /api/michengai/dsh-archive-manager/archived-turn-counts
 *          （lib/turn-counts.js，口径与官方 sessionStats 一致：step/end 的 turn 去重计数）
 *
 * 用法：
 *   node apply-turns-patch.mjs --dry-run
 *   node apply-turns-patch.mjs
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

const TURN_COUNTS_ENDPOINT = "/api/michengai/dsh-archive-manager/archived-turn-counts";

const TURN_HELPERS = `      const TURN_COUNTS_ENDPOINT = "${TURN_COUNTS_ENDPOINT}";
      async function requestArchivedTurnCounts(sessionIds) {
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
      }
`;

const ZH_TURNS = `        "archives.sortTurns": "对话轮次",
        "archives.turnCount": "{n} 轮",
        "archives.turnsLoading": "正在统计轮次…",
        "archives.turnsFailed": "轮次统计失败，已按其它条件排序",`;

const EN_TURNS = `        "archives.sortTurns": "Turns",
        "archives.turnCount": "{n} turns",
        "archives.turnsLoading": "Counting turns\u2026",
        "archives.turnsFailed": "Turn counting failed; falling back to other order",`;

const OLD_SORT = `      function sortArchivedGroups(groups, sortBy, createdAtById, t) {
        const compareText = (left, right) => String(left).localeCompare(String(right), void 0, { numeric: true, sensitivity: "base" });
        const timestampOf = (session) => {
          const value = sortBy === "created" ? createdAtById[session.id] : session.updatedAt;
          return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
        };
        const compareSessions = (left, right) => {
          if (sortBy !== "alphabetical") {
            const byTime = timestampOf(right) - timestampOf(left);
            if (Number.isFinite(byTime) && byTime !== 0) return byTime;
          }
          return compareText(displayTitle(left, t), displayTitle(right, t)) || compareText(left.id, right.id);
        };
        const result = groups.map((group) => ({ ...group, sessions: [...group.sessions].sort(compareSessions) }));
        return result.sort((left, right) => {
          if (sortBy !== "alphabetical") {
            const byTime = timestampOf(right.sessions[0]) - timestampOf(left.sessions[0]);
            if (Number.isFinite(byTime) && byTime !== 0) return byTime;
          }
          return compareText(left.title, right.title) || compareText(left.key, right.key);
        });
      }`;

const NEW_SORT = `      function sortArchivedGroups(groups, sortBy, createdAtById, t, turnCountById = {}) {
        const compareText = (left, right) => String(left).localeCompare(String(right), void 0, { numeric: true, sensitivity: "base" });
        const timestampOf = (session) => {
          const value = sortBy === "created" ? createdAtById[session.id] : session.updatedAt;
          return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
        };
        const turnCountOf = (session) => {
          const value = session === void 0 ? void 0 : turnCountById[session.id];
          return typeof value === "number" && Number.isFinite(value) ? value : -1;
        };
        const compareSessions = (left, right) => {
          if (sortBy === "turns") {
            const byTurns = turnCountOf(right) - turnCountOf(left);
            if (byTurns !== 0) return byTurns;
          } else if (sortBy !== "alphabetical") {
            const byTime = timestampOf(right) - timestampOf(left);
            if (Number.isFinite(byTime) && byTime !== 0) return byTime;
          }
          return compareText(displayTitle(left, t), displayTitle(right, t)) || compareText(left.id, right.id);
        };
        const result = groups.map((group) => ({ ...group, sessions: [...group.sessions].sort(compareSessions) }));
        return result.sort((left, right) => {
          if (sortBy === "turns") {
            const byTurns = turnCountOf(right.sessions[0]) - turnCountOf(left.sessions[0]);
            if (byTurns !== 0) return byTurns;
          } else if (sortBy !== "alphabetical") {
            const byTime = timestampOf(right.sessions[0]) - timestampOf(left.sessions[0]);
            if (Number.isFinite(byTime) && byTime !== 0) return byTime;
          }
          return compareText(left.title, right.title) || compareText(left.key, right.key);
        });
      }`;

const PATCHES = [
  {
    name: "T1-轮次统计请求函数",
    anchor: `      function ArchiveStarIcon({ filled }) {`,
    replace: () => TURN_HELPERS + `      function ArchiveStarIcon({ filled }) {`
  },
  {
    name: "T2-轮次中文词条",
    anchor: `        "archives.deleteUnfavoritedConfirm": "删除未收藏的聊天",`,
    replace: (m) => m + "\n" + ZH_TURNS
  },
  {
    name: "T3-轮次英文词条",
    anchor: `        "archives.deleteUnfavoritedConfirm": "Delete unfavorited chats",`,
    replace: (m) => m + "\n" + EN_TURNS
  },
  {
    name: "T4-轮次状态与按需加载",
    anchor: `        const favoriteSessionIdSet = (0, react.useMemo)(() => new Set(favoriteSessionIds), [favoriteSessionIds]);`,
    replace: (m) =>
      m +
      `
        const [turnCountById, setTurnCountById] = (0, react.useState)({});
        const [turnsStatus, setTurnsStatus] = (0, react.useState)("idle");
        const archivedIdsKey = workspaceState.archivedSessionIds.join("|");
        (0, react.useEffect)(() => {
          if (sortBy !== "turns") return;
          let cancelled = false;
          setTurnsStatus("loading");
          requestArchivedTurnCounts(workspaceState.archivedSessionIds).then((counts) => {
            if (cancelled) return;
            setTurnCountById(counts);
            setTurnsStatus("ready");
          }).catch(() => {
            if (cancelled) return;
            setTurnsStatus("failed");
          });
          return () => {
            cancelled = true;
          };
        }, [sortBy, archivedIdsKey]);`
  },
  {
    name: "T5-工具栏轮次状态提示",
    anchor: `favoriteCount > 0 ? (0, react_jsx_runtime.jsx)("span", { className: "dsham_settingsFavoritesCount", children: t("archives.favoriteCount", { n: favoriteCount }) }) : null,`,
    replace: (m) =>
      m +
      ` turnsStatus === "loading" || turnsStatus === "failed" ? (0, react_jsx_runtime.jsx)("span", { className: "dsham_settingsFavoritesCount", children: t(turnsStatus === "loading" ? "archives.turnsLoading" : "archives.turnsFailed") }) : null,`
  },
  {
    name: "T6-排序函数支持轮次",
    anchor: OLD_SORT,
    replace: () => NEW_SORT
  },
  {
    name: "T7-排序下拉新增『对话轮次』",
    anchor: `options: [{ value: "updated", label: t("archives.sortUpdated") }, { value: "created", label: t("archives.sortCreated") }, { value: "alphabetical", label: t("archives.sortAlphabetical") }]`,
    replace: () => `options: [{ value: "updated", label: t("archives.sortUpdated") }, { value: "created", label: t("archives.sortCreated") }, { value: "turns", label: t("archives.sortTurns") }, { value: "alphabetical", label: t("archives.sortAlphabetical") }]`
  },
  {
    name: "T8-排序调用传入轮次映射",
    anchor: `(0, react.useMemo)(() => sortArchivedGroups(groups, sortBy, createdAtById, t), [groups, sortBy, createdAtById, t]);`,
    replace: () => `(0, react.useMemo)(() => sortArchivedGroups(groups, sortBy, createdAtById, t, turnCountById), [groups, sortBy, createdAtById, t, turnCountById]);`
  },
  {
    name: "T9-列表行展示轮次数",
    anchor: `children: archiveTimeLabel(session.updatedAt, t)`,
    replace: () => `children: turnCountById[session.id] === void 0 ? archiveTimeLabel(session.updatedAt, t) : archiveTimeLabel(session.updatedAt, t) + " · " + t("archives.turnCount", { n: turnCountById[session.id] })`
  },
  {
    name: "T10-导出轮次钩子",
    anchor: `        sessionClipboardMenuItems,
        archiveFavoriteStore,`,
    replace: () => `        sessionClipboardMenuItems,
        archiveFavoriteStore,
        requestArchivedTurnCounts,
        TURN_COUNTS_ENDPOINT,`
  }
];

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
    console.error(`\n${failed} 处锚点失配：未写盘。请确认已先执行 apply-patch.mjs（第一批补丁）。`);
    process.exit(1);
  }

  if (args.has("--dry-run")) {
    console.log(`\n--dry-run：${PATCHES.length} 处锚点全部命中且唯一，未写盘。`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(BACKUP_ROOT, `archive-manager-turns-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, "client.js.orig");
  copyFileSync(TARGET, backupPath);
  writeFileSync(TARGET, (hasBom ? "\ufeff" : "") + current, { encoding: "utf8" });
  console.log(`\n已应用 ${PATCHES.length} 处补丁。\n备份：${backupPath}\n提示：重启 DSH 后生效。`);
}

main();
