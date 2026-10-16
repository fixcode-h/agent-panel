#!/usr/bin/env node
/**
 * 出包：把正式版前端和打成单文件的服务端放进 release/agent-panel-<版本>/，再压成 zip 和 tar.gz。
 * 包里只有正式版（不含在线演示的模拟后端），解压后只需要 Node.js 20+，不用 npm install。
 *
 * 用法：node scripts/package.mjs [版本号]   版本号默认取 package.json
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = (process.argv.slice(2).find((a) => !a.startsWith('--')) ?? pkg.version).replace(/^v/, '')
const name = `agent-panel-${version}`
const outRoot = path.join(root, 'release')
const out = path.join(outRoot, name)
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// 1. 正式版前端（不带 --mode demo，演示用的模拟后端不会打进来）
run('npx', ['vite', 'build'])
cpSync(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true })
// 2. 服务端打成一个文件，依赖全部内联
await build({
  entryPoints: [path.join(root, 'server/index.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  legalComments: 'none',
  // 版本号写进服务端，设置里的「版本更新」靠它判断有没有新包
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(version) },
  // 依赖里有 CommonJS 模块（cross-spawn），给它一个 require
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})

// 演示用的模拟后端和模拟执行（示例输出）都不能出现在包里
const grep = (word) => {
  try {
    return execFileSync('grep', ['-rl', word, path.join(out, 'dist'), path.join(out, 'server.mjs')], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return '' // grep 没找到时退出码是 1
  }
}
for (const word of ['demo-backend', 'demo-assist', '恢复示例数据', '模拟执行', '找到 6 个相关文件']) {
  const hit = grep(word)
  if (hit) throw new Error(`包里混进了演示内容（${word}）：${hit}`)
}

// 3. 启动脚本和说明
writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'agent-panel',
      version,
      private: true,
      type: 'module',
      description: pkg.description,
      engines: { node: '>=20' },
      scripts: { start: 'node server.mjs --prod' },
    },
    null,
    2,
  ) + '\n',
)
writeFileSync(
  path.join(out, 'start.sh'),
  '#!/bin/sh\n# 启动 Agent 面板，浏览器打开 http://127.0.0.1:8787\ncd "$(dirname "$0")" && exec node server.mjs --prod\n',
)
chmodSync(path.join(out, 'start.sh'), 0o755)
// Windows 托盘启动程序：在 CI 的 Windows 机器上编译（见 ci.yml），双击后不弹命令行窗口。
// 发布时必须带上（--require-tray）；本机出包没有编译过就不放
const tray = path.join(root, 'build', 'tray', 'AgentPanel.exe')
if (existsSync(tray)) cpSync(tray, path.join(out, 'AgentPanel.exe'))
else if (process.argv.includes('--require-tray')) throw new Error('缺少 build/tray/AgentPanel.exe（托盘启动程序）')
writeFileSync(
  path.join(out, '使用说明.txt'),
  [
    `Agent 面板 v${version}`,
    '',
    '1. 安装 Node.js 20 或更新版本：https://nodejs.org',
    '2. 至少安装并登录一个 CLI：Claude Code（claude）、Codex（codex）或 Command Code（cmdc）',
    '3. 启动：Windows 双击 AgentPanel.exe，程序在任务栏右下角的通知区显示图标，不会打开命令行窗口，',
    '   启动完成后自动用默认浏览器打开面板；右键图标可以重新打开面板、查看运行日志或退出（退出后面板也会停止）。',
    '   macOS / Linux 运行 ./start.sh（或 node server.mjs --prod），然后浏览器打开 http://127.0.0.1:8787',
    '',
    '数据保存在本目录的 data/ 下。可以在设置的「版本更新」里检查和安装新版本，数据会保留；',
    '手动升级时把旧版本的 data/ 复制到新版本目录即可。',
    '端口用环境变量 PORT 修改，数据目录用 AGENT_PANEL_DATA 修改。',
    '',
  ].join('\n'),
)
cpSync(path.join(root, 'README.md'), path.join(out, 'README.md'))

// 4. 压缩（--no-archive 只生成目录，CI 在 Windows 上试运行托盘程序时用）
if (process.argv.includes('--no-archive')) {
  console.log(`已生成：release/${name}`)
  process.exit(0)
}
for (const f of [`${name}.zip`, `${name}.tar.gz`]) rmSync(path.join(outRoot, f), { force: true })
run('zip', ['-qr', `${name}.zip`, name], outRoot)
run('tar', ['-czf', `${name}.tar.gz`, name], outRoot)
if (!existsSync(path.join(outRoot, `${name}.zip`))) throw new Error('压缩失败')
console.log(`已出包：release/${name}.zip、release/${name}.tar.gz`)
