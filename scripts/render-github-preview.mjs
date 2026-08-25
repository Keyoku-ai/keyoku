#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [input, output = "output/playwright/keyoku-github-proof.html"] = process.argv.slice(2);
if (!input) {
  console.error("Usage: node scripts/render-github-preview.mjs <factfile.github.md> [output.html]");
  process.exit(2);
}

const body = execFileSync("gh", [
  "api", "markdown", "--method", "POST",
  "-F", `text=@${resolve(input)}`,
  "-f", "mode=gfm",
  "-f", "context=Keyoku-ai/keyoku",
], { encoding: "utf8", maxBuffer: 4_000_000 });

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keyoku GitHub proof preview</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f6f8fa;color:#1f2328;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.chrome{height:64px;background:#0d1117;color:#f0f6fc;display:flex;align-items:center;padding:0 32px;gap:14px}.mark{width:32px;height:32px;border-radius:50%;background:#f0f6fc;color:#0d1117;display:grid;place-items:center;font-weight:800}.repo{font-weight:600}.branch{color:#8c959f;font-size:12px}.page{max-width:1120px;margin:30px auto;padding:0 24px}.check{background:#fff;border:1px solid #d0d7de;border-radius:10px;overflow:hidden;box-shadow:0 1px 2px rgba(31,35,40,.04)}.check-head{padding:16px 22px;border-bottom:1px solid #d8dee4;display:flex;justify-content:space-between;align-items:center}.check-head strong{font-size:16px}.check-head span{border:1px solid #d0d7de;border-radius:999px;padding:3px 9px;color:#57606a;font-size:12px}.markdown-body{padding:28px 34px 44px}.markdown-body h2{font-size:24px;padding-bottom:.3em;border-bottom:1px solid #d8dee4}.markdown-body h3{font-size:20px;margin-top:28px}.markdown-body blockquote{border-left:.25em solid #d0d7de;color:#636c76;margin:16px 0;padding:0 1em}.markdown-body table{border-spacing:0;border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow:auto;margin:16px 0}.markdown-body th,.markdown-body td{border:1px solid #d0d7de;padding:8px 13px;vertical-align:top}.markdown-body tr:nth-child(2n){background:#f6f8fa}.markdown-body code{background:#eff1f3;border-radius:6px;padding:.2em .4em;font:85% ui-monospace,SFMono-Regular,Menlo,monospace}.markdown-body details{border-top:1px solid #d8dee4;padding:14px 0;margin-top:16px}.markdown-body summary{cursor:pointer}.markdown-body sub{color:#656d76}@media(max-width:700px){.page{margin:14px auto;padding:0 10px}.markdown-body{padding:20px 16px}.chrome{padding:0 16px}.check-head{padding:13px 16px}}
</style></head><body><header class="chrome"><span class="mark">K</span><span class="repo">Keyoku-ai / keyoku</span><span class="branch">Checks / Outcome proof</span></header><main class="page"><section class="check"><header class="check-head"><strong>Keyoku proof</strong><span>GitHub-rendered preview</span></header><article class="markdown-body">${body}</article></section></main></body></html>`;

const target = resolve(output);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, html, "utf8");
console.log(target);
