#!/usr/bin/env node
/**
 * @michengai/dsh-archive-manager 本地增强补丁 · 第七批：行内「对话摘要」按钮 + 展开详情
 *
 * ⚠️ 执行顺序：前六批之后（apply-all.mjs 已按序串好）。
 *
 * 用户反馈："查看对话、恢复并打开之间是对话摘要四个字，可以展开看详情，这样能显示清楚"。
 * 之前那里直接显示整句摘要（如「进行中 2/5 · 修复补丁锚点」），太长且挤压按钮。本批改为：
 *   - 中间只显示 **「对话摘要 ▾」** 按钮（无 todo 记录时完全不显示）；
 *   - 点击在该行**下方展开**完整清单：每项带状态点（○ 待办 / ◐ 进行中 / ● 已完成）+ 状态文字，
 *     已完成项加删除线；面板可滚动（超长清单不撑爆页面）；
 *   - 详情条目来自宿主端 `session-digest` 新返回的 `todo.items`（或客户端 todo 投影），
 *     上限 40 条 / 每条 300 字符（宿主端截断）。
 *
 * 用法：
 *   node apply-digest-detail-patch.mjs --dry-run
 *   node apply-digest-detail-patch.mjs
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

const OLD_ROW_DIGEST = `      /** 归档清单行内摘要：无 todo 记录时不渲染任何内容。 */
      function RowDigest({ digest, t }) {
        const text = todoDigestText(digest, t);
        return text === null ? null : (0, react_jsx_runtime.jsx)("span", { className: "dsham_rowDigest", title: text, children: text });
      }
`;

const NEW_ROW_DIGEST = `      /** 归档清单行内摘要入口：默认只显示「对话摘要」按钮，点击展开完整清单。 */
      function RowDigest({ digest, t }) {
        const [open, setOpen] = (0, react.useState)(false);
        const text = todoDigestText(digest, t);
        if (text === null) return null;
        const items = Array.isArray(digest?.items) ? digest.items : [];
        const statusLabel = (status) => t(status === "completed" ? "digest.status.completed" : status === "in_progress" ? "digest.status.in_progress" : "digest.status.pending");
        return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
          children: [
            (0, react_jsx_runtime.jsxs)("button", {
              type: "button",
              className: "dsham_digestToggle",
              "data-open": open,
              "aria-expanded": open,
              title: text,
              onClick: () => setOpen((current) => !current),
              children: [t("archives.digestToggle"), open ? " \\u25B4" : " \\u25BE"]
            }),
            open ? (0, react_jsx_runtime.jsxs)("div", {
              className: "dsham_digestDetail",
              children: [
                (0, react_jsx_runtime.jsx)("div", { className: "dsham_digestDetailHead", children: text }),
                items.length === 0
                  ? (0, react_jsx_runtime.jsx)("div", { className: "dsham_digestEmpty", children: t("digest.detailEmpty") })
                  : (0, react_jsx_runtime.jsx)("ul", { className: "dsham_digestItems", children: items.map((item, index) => (0, react_jsx_runtime.jsxs)("li", {
                      className: "dsham_digestItem",
                      "data-status": typeof item?.status === "string" ? item.status : "pending",
                      children: [
                        (0, react_jsx_runtime.jsx)("span", { className: "dsham_digestDot" }),
                        (0, react_jsx_runtime.jsx)("span", { className: "dsham_digestText", children: item?.content ?? "" }),
                        (0, react_jsx_runtime.jsx)("span", { className: "dsham_digestState", children: statusLabel(item?.status) })
                      ]
                    }, String(index) + ":" + String(item?.content ?? ""))) })
              ]
            }) : null
          ]
        });
      }
`;

const OLD_PROJECTION_DIGEST = `      /** 从客户端 todo 投影（TodoItem[]）归纳摘要，口径与宿主端 summarizeTodos 一致。 */
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
`;

const NEW_PROJECTION_DIGEST = `      /** 从客户端 todo 投影（TodoItem[]）归纳摘要，口径与宿主端 summarizeTodos 一致（含完整清单）。 */
      function todoDigestFromProjection(todos) {
        if (!Array.isArray(todos) || todos.length === 0) return null;
        const DIGEST_DETAIL_LIMIT = 40;
        const DIGEST_CONTENT_LIMIT = 300;
        let done = 0;
        let doing = 0;
        let pending = 0;
        let firstDoing = null;
        let firstPending = null;
        let lastDone = null;
        const items = [];
        for (const item of todos) {
          const content = typeof item?.content === "string" ? item.content.trim() : "";
          const rawStatus = item?.status;
          // 官方状态白名单：未知值归一为 pending，避免界面拿到非法枚举
          const status = typeof rawStatus === "string" && ["pending", "in_progress", "completed"].includes(rawStatus) ? rawStatus : "pending";
          if (items.length < DIGEST_DETAIL_LIMIT) {
            items.push({ content: content.slice(0, DIGEST_CONTENT_LIMIT), status });
          }
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
          lastDone,
          items,
          ...todos.length > items.length ? { truncated: true } : {}
        };
      }
`;

const OLD_ROW_CSS = `.dsham_rowDigest{max-width:200px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}`;

const NEW_DETAIL_CSS =
  ".dsham_digestToggle{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:0 9px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px dashed var(--dsw-alias-border-l2);border-radius:7px;cursor:pointer;font:inherit;font-size:12px;font-weight:500;white-space:nowrap}" +
  ".dsham_digestToggle:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}" +
  ".dsham_digestToggle[data-open=true]{color:var(--dsw-alias-label-primary);border-style:solid;border-color:var(--dsw-alias-border-l3)}" +
  ".dsham_settingsActions{flex-wrap:wrap}" +
  ".dsham_digestDetail{order:1;flex:1 1 100%;margin-top:6px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-button-elevated-fill));border:1px solid var(--dsw-alias-border-l2);border-radius:10px}" +
  ".dsham_digestDetailHead{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-bottom:6px}" +
  ".dsham_digestEmpty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}" +
  ".dsham_digestItems{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;max-height:34vh;overflow:auto}" +
  ".dsham_digestItem{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:18px}" +
  ".dsham_digestDot{width:8px;height:8px;flex:none;align-self:center;border-radius:50%;border:1.5px solid var(--dsw-alias-label-tertiary)}" +
  ".dsham_digestItem[data-status=in_progress] .dsham_digestDot{border-color:#f5a623;background:#f5a623}" +
  ".dsham_digestItem[data-status=completed] .dsham_digestDot{border-color:var(--dsw-alias-state-success-primary,#3fb950);background:var(--dsw-alias-state-success-primary,#3fb950)}" +
  ".dsham_digestItem[data-status=completed] .dsham_digestText{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}" +
  ".dsham_digestText{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary)}" +
  ".dsham_digestState{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}";

const ZH_DETAIL = `        "archives.digestToggle": "对话摘要",
        "digest.detailEmpty": "该会话没有 todo 清单记录。",
        "digest.status.pending": "待办",
        "digest.status.in_progress": "进行中",
        "digest.status.completed": "已完成",`;

const EN_DETAIL = `        "archives.digestToggle": "Summary",
        "digest.detailEmpty": "This session has no todo list.",
        "digest.status.pending": "To do",
        "digest.status.in_progress": "Doing",
        "digest.status.completed": "Done",`;

const PATCHES = [
  {
    name: "X1-行内改为「对话摘要」按钮 + 展开详情",
    anchor: OLD_ROW_DIGEST,
    replace: () => NEW_ROW_DIGEST
  },
  {
    name: "X2-详情中文词条",
    anchor: `        "digest.done": "已完成 {total} 项 · {task}",`,
    replace: (m) => m + "\n" + ZH_DETAIL
  },
  {
    name: "X3-详情英文词条",
    anchor: `        "digest.done": "all {total} done · {task}",`,
    replace: (m) => m + "\n" + EN_DETAIL
  },
  {
    name: "X4-投影摘要也带完整清单",
    anchor: OLD_PROJECTION_DIGEST,
    replace: () => NEW_PROJECTION_DIGEST
  },
  {
    name: "X5-详情面板样式",
    anchor: OLD_ROW_CSS,
    replace: () => NEW_DETAIL_CSS
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
    console.error(`\n${failed} 处锚点失配：未写盘。请确认前六批补丁已应用。`);
    process.exit(1);
  }

  if (args.has("--dry-run")) {
    console.log(`\n--dry-run：${PATCHES.length} 处锚点全部命中且唯一，未写盘。`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(BACKUP_ROOT, `archive-manager-digest-detail-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, "client.js.orig");
  copyFileSync(TARGET, backupPath);
  writeFileSync(TARGET, (hasBom ? "\ufeff" : "") + current, { encoding: "utf8" });
  console.log(`\n已应用 ${PATCHES.length} 处补丁。\n备份：${backupPath}\n提示：重启 DSH 后生效（建议 Ctrl+Shift+R 硬刷新一次）。`);
}

main();
