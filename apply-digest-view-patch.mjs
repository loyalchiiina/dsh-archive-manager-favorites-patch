#!/usr/bin/env node
/**
 * @michengai/dsh-archive-manager 本地增强补丁 · 第五批：归档清单**行内**任务摘要
 *
 * ⚠️ 执行顺序：apply-patch → apply-turns-patch → apply-pin-patch → apply-digest-patch → 本脚本。
 *    或用 apply-all.mjs 一把跑完五批。
 *
 * 演进（三次按用户反馈定型）：
 *   1. 首版把摘要渲染在**侧栏**会话行小字里 → 挤占对话清单，撤销；
 *   2. 第二版渲染在归档列表行**时间后** → 同样影响清单可读性，撤销；
 *   3. 第三版做成页头「任务摘要」按钮 + 汇总弹窗 → 用户反馈"这样显示没有作用"，撤销；
 *   4. 现版（本脚本）：在每条归档记录的**「查看对话」与「恢复并打开」两个按钮之间**，
 *      内联显示**该行自己的**任务摘要（灰色小字，超长省略，悬停看全文）。不新增按钮、不弹窗。
 *
 * 摘要数据来自第四批（宿主 `session-digest` 路由 + 客户端 `archiveDigestStore` 缓存），零模型调用。
 *
 * 用法：
 *   node apply-digest-view-patch.mjs --dry-run
 *   node apply-digest-view-patch.mjs
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

const ROW_DIGEST_COMPONENT = `      /** 归档清单行内摘要：无 todo 记录时不渲染任何内容。 */
      function RowDigest({ digest, t }) {
        const text = todoDigestText(digest, t);
        return text === null ? null : (0, react_jsx_runtime.jsx)("span", { className: "dsham_rowDigest", title: text, children: text });
      }
`;

const OLD_ACTION_HEAD = `children: [(0, react_jsx_runtime.jsx)("button", { type: "button", className: "dsham_settingsAction", disabled: busy || unarchivingSessionIds.has(session.id), onClick: () => viewConversation(session), children: t("archives.viewConversation") }), (0, react_jsx_runtime.jsx)("button", { type: "button", className: "dsham_settingsAction", disabled: busy || unarchivingSessionIds.has(session.id), onClick: () => viewConversation(session, true), children: t("archives.restoreOpen") })`;

const NEW_ACTION_HEAD = `children: [(0, react_jsx_runtime.jsx)("button", { type: "button", className: "dsham_settingsAction", disabled: busy || unarchivingSessionIds.has(session.id), onClick: () => viewConversation(session), children: t("archives.viewConversation") }), (0, react_jsx_runtime.jsx)(RowDigest, { digest: digestBySession[session.id]?.todo, t }), (0, react_jsx_runtime.jsx)("button", { type: "button", className: "dsham_settingsAction", disabled: busy || unarchivingSessionIds.has(session.id), onClick: () => viewConversation(session, true), children: t("archives.restoreOpen") })`;

const OLD_ROW_CSS = `.dsham_digest{margin-left:6px;min-width:0;flex:0 1 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`;

const NEW_ROW_CSS = `.dsham_rowDigest{max-width:200px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}`;

const PATCHES = [
  {
    name: "R1-行内摘要组件",
    anchor: `      function todoDigestText(digest, t) {`,
    replace: (m) => ROW_DIGEST_COMPONENT + m
  },
  {
    name: "R2-插到「查看对话」与「恢复并打开」之间",
    anchor: OLD_ACTION_HEAD,
    replace: () => NEW_ACTION_HEAD
  },
  {
    name: "R3-行内摘要样式（替换上一版侧栏样式）",
    anchor: OLD_ROW_CSS,
    replace: () => NEW_ROW_CSS
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
    console.error(`\n${failed} 处锚点失配：未写盘。请确认前四批补丁已应用。`);
    process.exit(1);
  }

  if (args.has("--dry-run")) {
    console.log(`\n--dry-run：${PATCHES.length} 处锚点全部命中且唯一，未写盘。`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(BACKUP_ROOT, `archive-manager-rowdigest-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, "client.js.orig");
  copyFileSync(TARGET, backupPath);
  writeFileSync(TARGET, (hasBom ? "\ufeff" : "") + current, { encoding: "utf8" });
  console.log(`\n已应用 ${PATCHES.length} 处补丁。\n备份：${backupPath}\n提示：重启 DSH 后生效（建议 Ctrl+Shift+R 硬刷新一次）。`);
}

main();
