#!/usr/bin/env node
/**
 * 生成归档设置界面的「排版预览图」：
 *   1. 从已安装插件的 lib/client.js 里提取**真实 CSS**（保证预览与实机一致，避免误导）；
 *   2. 拼一份模拟 HTML（结构与真实组件一致：header / 工具栏 / 选择栏 / 分组 / 列表行）；
 *   3. 用本机 chromium / Edge 截图（fullPage），输出 PNG 路径。
 *
 * 用法：node make-layout-preview.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const PLUGIN = process.env.DSH_ARCHIVE_MANAGER_DIR ??
  join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager");
const OUT_DIR = resolve(process.argv[2] ?? process.env.DSH_PATCH_PROJECT_DIR ?? process.cwd());

const source = readFileSync(join(PLUGIN, "lib", "client.js"), "utf8");

/** 提取 `const NAME_CSS = "...";` 字符串字面量的真实内容。 */
function extractCss(name) {
  const marker = `const ${name} = "`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  let i = start + marker.length;
  let out = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      out += source[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i += 1;
  }
  return out;
}

const cssNames = [
  "ARCHIVE_SETTINGS_CSS",
  "ARCHIVE_SETTINGS_BATCH_CSS",
  "ARCHIVE_SETTINGS_EXTERNAL_LINK_CSS",
  "ARCHIVE_SETTINGS_SELECTION_CSS",
  "ARCHIVE_SETTINGS_DELETE_CONFIRM_CSS"
];
const pluginCss = cssNames.map(extractCss).join("");
if (pluginCss.length < 1000) {
  console.error("未能从 client.js 提取到插件 CSS，中止");
  process.exit(2);
}

const detailItems = [
  ["读取插件源码", "completed", "已完成"],
  ["修复补丁锚点", "in_progress", "进行中"],
  ["应用七批补丁", "in_progress", "进行中"],
  ["跑探针回归 162 项", "pending", "待办"]
];
const row = (title, meta, digest, favorite, expanded) => `
        <article class="dsham_settingsRow">
          <input type="checkbox" class="dsham_settingsCheckbox"${title.includes("网格") ? " checked" : ""}>
          <button type="button" class="dsham_settingsStar" data-favorite="${favorite}">★</button>
          <div class="dsham_settingsContent">
            <div class="dsham_settingsTitle">${title}</div>
            <div class="dsham_settingsMeta">${meta}</div>
          </div>
          <div class="dsham_settingsActions">
            <button type="button" class="dsham_settingsAction">查看对话</button>
            ${digest ? `<button type="button" class="dsham_digestToggle" data-open="${expanded}">对话摘要 ${expanded ? "▴" : "▾"}</button>` : ""}
            <button type="button" class="dsham_settingsAction">恢复并打开</button>
            <button type="button" class="dsham_settingsAction">取消归档</button>
            <button type="button" class="dsham_settingsDelete">🗑</button>
            ${expanded ? `<div class="dsham_digestDetail">
              <div class="dsham_digestDetailHead">进行中 2/4 · 修复补丁锚点</div>
              <ul class="dsham_digestItems">${detailItems.map(([content, status, label]) => `<li class="dsham_digestItem" data-status="${status}"><span class="dsham_digestDot"></span><span class="dsham_digestText">${content}</span><span class="dsham_digestState">${label}</span></li>`).join("")}</ul>
            </div>` : ""}
          </div>
        </article>`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>归档会话 · 排版预览</title>
<style>
:root{
  --dsw-alias-label-primary:#e8e8e8;
  --dsw-alias-label-secondary:#b6b6b6;
  --dsw-alias-label-tertiary:#8b8b8b;
  --dsw-alias-border-l2:#3a3a3a;
  --dsw-alias-border-l3:#4a4a4a;
  --dsw-alias-bg-layer-2:#1e1e1e;
  --dsw-alias-bg-layer-3:#262626;
  --dsw-alias-button-elevated-fill:#242424;
  --dsw-alias-interactive-bg-hover:#2b2b2b;
  --dsw-alias-state-error-primary:#ff6b6b;
  --dsw-alias-state-success-primary:#3fb950;
}
*{box-sizing:border-box}
body{margin:0;padding:28px 32px;background:#141414;font-family:"Microsoft YaHei","Segoe UI",sans-serif;color:var(--dsw-alias-label-primary)}
button{font-family:inherit}
${pluginCss}
</style></head>
<body>
<section class="dsham_settings" aria-label="归档会话">
  <header class="dsham_settingsHeader">
    <div>
      <div class="dsham_settingsTitleRow">
        <h2>归档会话</h2>
        <div class="dsham_settingsLinks">
          <a class="dsham_settingsExternalLink" href="#">GitHub</a>
          <a class="dsham_settingsExternalLink" href="#">问题反馈</a>
        </div>
      </div>
      <p class="dsham_settingsIntro">管理已归档的会话。</p>
    </div>
    <div class="dsham_settingsHeaderActions">
      <button type="button" class="dsham_settingsRestoreAll">全部恢复</button>
      <button type="button" class="dsham_settingsDangerQuiet">🗑 删除全部未收藏</button>
      <button type="button" class="dsham_settingsDanger">🗑 全部删除</button>
    </div>
  </header>

  <div class="dsham_settingsToolbar">
    <label class="dsham_settingsSearch">🔍 <input type="search" placeholder="搜索已归档聊天"></label>
    <button type="button" class="dsham_settingsFavoritesToggle" data-active="true">★ 只看收藏</button>
    <span class="dsham_settingsFavoritesCount">已收藏 3 条</span>
    <div class="dsham_settingsFilter"><button type="button" class="dsham_selectTrigger"><span class="dsham_selectValue">对话轮次</span><svg class="dsham_selectCaret" viewBox="0 0 12 12"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button></div>
    <div class="dsham_settingsFilter"><button type="button" class="dsham_selectTrigger"><span class="dsham_selectValue">所有项目</span><svg class="dsham_selectCaret" viewBox="0 0 12 12"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button></div>
    <button type="button" class="dsham_settingsDangerQuiet">🗑 删除未收藏</button>
  </div>

  <div class="dsham_settingsSelection">
    <label class="dsham_settingsSelectionToggle"><input type="checkbox" class="dsham_settingsCheckbox">全选当前筛选结果</label>
    <span class="dsham_settingsSelectionCount">已选 1 条，其中 0 条不在当前结果</span>
    <button type="button" class="dsham_settingsSelectionAction">清空选择</button>
    <button type="button" class="dsham_settingsSelectionAction">恢复所选</button>
    <button type="button" class="dsham_settingsSelectionAction dsham_settingsSelectionDelete">删除所选</button>
  </div>

  <section class="dsham_settingsGroup">
    <div class="dsham_settingsGroupHeading">
      <h3 class="dsham_settingsGroupTitle">📂 deepseekharness</h3>
      <div class="dsham_settingsGroupMeta"><span class="dsham_settingsCount">3 个聊天</span></div>
    </div>
    <div class="dsham_settingsList">${row("修复归档插件补丁锚点失配", "09-15 05:16 · 5 轮", true, "true", true)}${row("整理 Fluent 网格划分流程文档", "09-14 22:41 · 12 轮", true, "false", false)}${row("模型插件收录 PR 提交与 CI 跟踪", "09-14 19:03 · 3 轮", false, "false", false)}
    </div>
  </section>
</section>
</body></html>`;

const htmlPath = join(OUT_DIR, "layout-preview.html");
writeFileSync(htmlPath, html, "utf8");
console.log(`HTML 已生成：${htmlPath}`);

// 截图（优先 playwright 自带 chromium，其次本机 Edge/Chrome）
let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch (error) {
  try {
    const { pathToFileURL } = await import("node:url");
    const fallback = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "playwright-core", "index.js");
    ({ chromium } = await import(pathToFileURL(fallback).href));
    console.log("已从 DSH profile 的 node_modules 加载 playwright-core");
  } catch (error2) {
    console.log(`未找到 playwright-core（${String(error2).split("\n")[0]}），跳过截图（可直接用浏览器打开上面的 HTML）`);
    process.exit(0);
  }
}
const candidates = [
  {},
  { channel: "msedge" },
  { channel: "chrome" }
];
const pngPath = join(OUT_DIR, "layout-preview.png");
let done = false;
for (const options of candidates) {
  try {
    const browser = await chromium.launch(options);
    const page = await browser.newPage({ viewport: { width: 880, height: 900 }, deviceScaleFactor: 2 });
    await page.goto("file:///" + htmlPath.replace(/\\/g, "/"));
    await page.waitForTimeout(400);
    await page.screenshot({ path: pngPath, fullPage: true });
    await browser.close();
    console.log(`截图完成：${pngPath}（${JSON.stringify(options)}）`);
    done = true;
    break;
  } catch (error) {
    console.log(`截图尝试失败 ${JSON.stringify(options)}：${String(error).split("\n")[0]}`);
  }
}
if (!done) console.log("未能截图，请直接用浏览器打开 HTML 预览");
