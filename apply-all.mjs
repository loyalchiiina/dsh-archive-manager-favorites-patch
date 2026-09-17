#!/usr/bin/env node
/**
 * 带门禁的一键重放：
 *   1. 从基线备份恢复 lib/client.js 与 lib/workspace.js；
 *   2. 依次应用各批补丁；
 *   3. **强制跑 verify-remote-descriptors.mjs 门禁** —— 不通过就整体回滚并中止，
 *      绝不让"会导致 DSH 起不来"的文件留在磁盘上（2026-09-16 事故教训）；
 *   4. 复查客户端与宿主端是否失配（例如客户端调用了一个宿主并不存在的方法）。
 *
 * 说明：**对话摘要功能已取消**，不再执行 apply-digest-view/detail 两个脚本；
 * 第四批 apply-digest-patch.mjs 保留（它是轮次排序的数据来源）。
 * 第九批（删除提速 + 进度条）暂未纳入本清单，待单独校验通过后再启用。
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager", "lib");
const BASE_BACKUP = process.env.DSH_ARCHIVE_MANAGER_BACKUP ??
  join(homedir(), ".dsh", "backups", "archive-manager-favorites-20260914-161730");

/** 需要恢复的上游原始文件：目标名 ← 备份名。 */
const RESTORE = [
  ["client.js", join(BASE_BACKUP, "client.js.orig")],
  ["workspace.js", join(BASE_BACKUP, "workspace.js.orig")],
];

function restoreBaseline() {
  for (const [name, backup] of RESTORE) {
    if (!existsSync(backup)) {
      console.error(`找不到基线备份：${backup}`);
      process.exit(2);
    }
    copyFileSync(backup, join(LIB_DIR, name));
    console.log(`[apply-all] 已恢复 ${name} ← ${backup}`);
  }
}

function run(file, args = [], options = {}) {
  const result = spawnSync(process.execPath, [join(here, file), ...args], {
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (options.capture) return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  if (result.status !== 0) {
    console.error(`[apply-all] ${file} 执行失败（退出码 ${result.status}），中止。`);
    process.exit(result.status ?? 1);
  }
  return { status: 0 };
}

restoreBaseline();

const BATCHES = [
  ["apply-patch.mjs", "第一批 收藏 / 复制 ID·路径 / 删除未收藏"],
  ["apply-turns-patch.mjs", "第二批 按对话轮次排序"],
  ["apply-pin-patch.mjs", "第三批 置顶会话"],
  ["apply-digest-patch.mjs", "第四批 轮次数据层"],
  ["apply-layout-patch.mjs", "第六批 设置界面排版重整"],
  ["apply-hide-upstream-links-patch.mjs", "第八批 隐藏 GitHub / 问题反馈 / 检查更新"],
  ["apply-idle-auto-archive-patch.mjs", "第十批 按时间筛选归档 + 撤回上一步"],
];

for (const [file, label] of BATCHES) {
  console.log(`\n[apply-all] ▶ ${label}`);
  run(file);
}

/* ---------- 门禁 1：remote 声明与语法（不通过即回滚） ---------- */
console.log("\n[apply-all] 🔒 门禁 1/2：remote 声明结构（防止重演 DSH 起不来）");
const gate = run("verify-remote-descriptors.mjs", [join(LIB_DIR, "workspace.js"), "--expect", "archiveSessionsByIds"], { capture: true });
process.stdout.write(gate.stdout);
if (gate.status !== 0) {
  console.error("\n[apply-all] ⛔ 门禁未通过 → 回滚到基线，避免 DSH 无法启动。");
  restoreBaseline();
  process.exit(1);
}

/* ---------- 门禁 2：两端一致性 ---------- */
console.log("\n[apply-all] 🔒 门禁 2/2：客户端与宿主端一致性");
const client = readFileSync(join(LIB_DIR, "client.js"), "utf8");
const host = readFileSync(join(LIB_DIR, "workspace.js"), "utf8");
const CHECKS = [
  { marker: "archiveSessionsByIds", label: "按时间归档（需两端）", needsHost: true },
  // 撤回上一步复用既有的 unarchiveSessions，客户端词条即可，不需要宿主新增方法
  { marker: "archives.idleUndo", label: "撤回上一步（仅客户端）", needsHost: false },
  { marker: "archivePinStore", label: "置顶会话（仅客户端）", needsHost: false },
  { marker: "dsham_settingsStar", label: "收藏星标（仅客户端）", needsHost: false },
  { marker: "archives.sortTurns", label: "按轮次排序（仅客户端）", needsHost: false },
];
let mismatch = 0;
for (const check of CHECKS) {
  const inClient = client.includes(check.marker);
  const inHost = host.includes(check.marker);
  const ok = inClient && (!check.needsHost || inHost);
  if (!ok) mismatch += 1;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${check.label}：client=${inClient} host=${inHost}`);
}
if (mismatch > 0) {
  console.error("\n[apply-all] ⛔ 两端失配 → 回滚到基线。");
  restoreBaseline();
  process.exit(1);
}

console.log("\n[apply-all] ✅ 全部门禁通过。重启 DSH 后生效（建议 Ctrl+Shift+R 硬刷新）。");
