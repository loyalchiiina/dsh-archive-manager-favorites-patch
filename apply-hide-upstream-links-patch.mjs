#!/usr/bin/env node
/**
 * @michengai/dsh-archive-manager 本地增强补丁 · 第八批：隐藏 GitHub / 问题反馈 / 检查更新
 *
 * 用户要求："GitHub、问题反馈、检查更新 这三个删掉，不用显示这些"。
 *
 * 做法（三处，均为删除渲染而非改文案）：
 *   H1  删除归档设置页头部的 `.dsham_settingsLinks` 整块 —— 里面正是
 *       「GitHub」与「问题反馈」两个外链；标题 h2 保留。
 *   H2  删除注入「检查更新」按钮的 effect（observePluginUpdate），连带不再发更新检查请求；
 *       该按钮本就挂载在 H1 删掉的 `.dsham_settingsLinks` 上。
 *   H3  追加一条 CSS 兜底把 `.dsham_settingsLinks` 设为 display:none，
 *       防止宿主其他位置复用同类名时又冒出来。
 *
 * ⚠️ 执行顺序：第七批之后（apply-all.mjs 已按序串好）。
 *
 * 用法：
 *   node apply-hide-upstream-links-patch.mjs --dry-run
 *   node apply-hide-upstream-links-patch.mjs
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

/* H1：links 区块的起止标记（用区间删除，避免超长字面锚点易碎）。 */
const LINKS_START = `(0, react_jsx_runtime.jsxs)("div", { className: "dsham_settingsLinks"`;
const LINKS_END = `t("archives.feedback")] })] })`;

/* H2：注入「检查更新」的 effect 起止标记。 */
const UPDATE_START = `ctx.effect(() => observePluginUpdate({`;
const UPDATE_END = `"dsh-archive-manager: plugin update ui");`;

/* H3：CSS 兜底（挂在既有样式常量末尾）。 */
const CSS_ANCHOR = `.dsham_pinBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:#f5a623}`;
const CSS_HIDE = `.dsham_settingsLinks{display:none!important}`;

function removeRange(text, name, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return { ok: false, reason: `${name}：找不到起始标记` };
  if (text.indexOf(startMarker, start + 1) !== -1) return { ok: false, reason: `${name}：起始标记出现多次，无法定位` };
  const endRel = text.indexOf(endMarker, start);
  if (endRel === -1) return { ok: false, reason: `${name}：找不到结束标记` };
  const end = endRel + endMarker.length;
  // 一并吃掉紧邻的前置 ", "（H1 是数组元素），避免留下空槽
  let cut = start;
  if (text.slice(Math.max(0, cut - 2), cut) === ", ") cut -= 2;
  return { ok: true, text: text.slice(0, cut) + text.slice(end), removed: end - cut };
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

  const h1 = removeRange(current, "H1-GitHub/问题反馈链接块", LINKS_START, LINKS_END);
  if (h1.ok) {
    current = h1.text;
    log.push(`  [ok]   H1-删除 GitHub / 问题反馈链接块（${h1.removed} 字符）`);
  } else {
    failed += 1;
    log.push(`  [FAIL] ${h1.reason}`);
  }

  const h2 = removeRange(current, "H2-检查更新注入", UPDATE_START, UPDATE_END);
  if (h2.ok) {
    current = h2.text;
    log.push(`  [ok]   H2-移除「检查更新」注入（${h2.removed} 字符）`);
  } else {
    failed += 1;
    log.push(`  [FAIL] ${h2.reason}`);
  }

  const cssHits = current.split(CSS_ANCHOR).length - 1;
  if (cssHits === 1) {
    current = current.replace(CSS_ANCHOR, CSS_ANCHOR + CSS_HIDE);
    log.push("  [ok]   H3-CSS 兜底隐藏 .dsham_settingsLinks");
  } else {
    failed += 1;
    log.push(`  [FAIL] H3 — CSS 锚点命中 ${cssHits} 次（期望 1 次）`);
  }

  console.log(`目标：${TARGET}`);
  console.log(log.join("\n"));

  if (failed > 0) {
    console.error(`\n${failed} 处失败：未写盘。`);
    process.exit(1);
  }
  if (args.has("--dry-run")) {
    console.log("\n--dry-run：三处均可定位，未写盘。");
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(BACKUP_ROOT, `archive-manager-hidelinks-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, "client.js.orig");
  copyFileSync(TARGET, backupPath);
  writeFileSync(TARGET, (hasBom ? "\ufeff" : "") + current, { encoding: "utf8" });
  console.log(`\n已应用。\n备份：${backupPath}\n提示：重启 DSH 后生效（建议 Ctrl+Shift+R 硬刷新一次）。`);
}

main();
