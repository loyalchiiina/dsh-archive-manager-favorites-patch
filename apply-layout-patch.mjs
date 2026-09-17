#!/usr/bin/env node
/**
 * @michengai/dsh-archive-manager 本地增强补丁 · 第六批：归档设置界面排版重整
 *
 * ⚠️ 执行顺序：apply-patch → apply-turns-patch → apply-pin-patch → apply-digest-patch
 *    → apply-digest-view-patch → 本脚本。或用 apply-all.mjs 一把跑完六批。
 *
 * 用户反馈："太乱、可读性太低、太拥挤"。诊断：
 *   - 列表行是单行 flex，把 checkbox / 星标 / 标题 / 时间 / 摘要 / 4~5 个操作按钮全塞在一行，
 *     标题被压扁；
 *   - 工具栏一行放搜索 + 只看收藏 + 计数 + 排序 + 项目筛选 + 删除未收藏 + 状态提示（7 个控件）；
 *   - 头部三个批量按钮与标题之间没有视觉分组。
 *
 * 本批**只改 CSS**（不动 JSX，风险最低），做四件事：
 *   1. 列表行改**两行布局**：第一行 = 选择框 + 星标 + 标题 + 时间；第二行 = 摘要（左）+ 操作按钮（右）；
 *   2. 工具栏卡片化，**搜索框独占一行**，其余筛选控件换行排列；
 *   3. 头部批量操作区卡片化，与内容形成分组；
 *   4. 选择栏卡片化、分组间距与列表边框收口（最后一行去下划线）。
 *
 * 用法：
 *   node apply-layout-patch.mjs --dry-run
 *   node apply-layout-patch.mjs
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

const LAYOUT_CSS =
  ".dsham_settingsRow{flex-wrap:wrap;align-items:flex-start;row-gap:8px;column-gap:10px;min-height:0;padding:12px 14px}" +
  ".dsham_settingsRow:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".dsham_settingsList .dsham_settingsRow:last-child{border-bottom:0}" +
  ".dsham_settingsContent{flex:1 1 220px}" +
  ".dsham_settingsActions{flex:1 1 100%;justify-content:flex-end;align-items:center;gap:8px;padding-top:2px}" +
  ".dsham_settingsToolbar{flex-wrap:wrap;gap:10px;padding:12px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-button-elevated-fill));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;margin-bottom:16px}" +
  ".dsham_settingsSearch{flex:1 1 100%}" +
  ".dsham_settingsHeaderActions{flex-wrap:wrap;gap:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-button-elevated-fill));border:1px solid var(--dsw-alias-border-l2);border-radius:12px}" +
  ".dsham_settingsSelection{padding:8px 12px;border-radius:12px;margin:0 0 16px}" +
  ".dsham_settingsGroup{margin:0 0 24px}" +
  ".dsham_settingsGroupHeading{padding:0 2px 6px}" +
  ".dsham_settingsMeta{display:flex;flex-wrap:wrap;align-items:center;gap:6px}";

const PATCHES = [
  {
    // 锚点说明（2026-09-15）：对话摘要取消后，第五批注入的 .dsham_rowDigest 不再存在，
    // 这里改为锚定第四批遗留的旧摘要样式（现已无用），直接替换成新的排版规则 —— 顺带清掉死样式。
    name: "L1-排版重整（行内两行布局 + 分区卡片化）",
    anchor: `.dsham_digest{margin-left:6px;min-width:0;flex:0 1 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
    replace: () => LAYOUT_CSS
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
    console.error(`\n${failed} 处锚点失配：未写盘。请确认前五批补丁已应用。`);
    process.exit(1);
  }

  if (args.has("--dry-run")) {
    console.log(`\n--dry-run：${PATCHES.length} 处锚点全部命中且唯一，未写盘。`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = join(BACKUP_ROOT, `archive-manager-layout-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, "client.js.orig");
  copyFileSync(TARGET, backupPath);
  writeFileSync(TARGET, (hasBom ? "\ufeff" : "") + current, { encoding: "utf8" });
  console.log(`\n已应用 ${PATCHES.length} 处补丁。\n备份：${backupPath}\n提示：重启 DSH 后生效（建议 Ctrl+Shift+R 硬刷新一次）。`);
}

main();
