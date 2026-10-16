#!/usr/bin/env node
/**
 * 出包：把正式版前端和打成单文件的服务端放进 release/agent-panel-<版本>/，再压成 zip 和 tar.gz。
 * 包里只有正式版（不含在线演示的模拟后端），解压后只需要 Node.js 20+，不用 npm install。
 *
 * 用法：node scripts/package.mjs [版本号]   版本号默认取 package.json
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
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
// 直接用 node 跑 vite：Windows 上 npx 是 .cmd，execFileSync 启动不了
run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'])
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
// 不用系统的 grep：Windows 上没有，而且找不到命令时会被当成「没找到」
const files = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => files(path.join(p, f))) : [p])
const shipped = [...files(path.join(out, 'dist')), path.join(out, 'server.mjs')]
const grep = (word) =>
  shipped
    .filter((f) => readFileSync(f).includes(word))
    .map((f) => path.relative(out, f))
    .join('、')
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
  [
    '#!/bin/sh',
    '# 启动 Agent 面板，浏览器打开 http://127.0.0.1:8787',
    'cd "$(dirname "$0")" || exit 1',
    // 没装 Node 或版本太旧时直接说清楚，不让用户对着一串报错猜
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "没有找到 Node.js。Agent 面板需要 Node.js 20 或更新的版本：https://nodejs.org/zh-cn/download" >&2',
    '  exit 1',
    'fi',
    'major=$(node -p "process.versions.node.split(\'.\')[0]" 2>/dev/null || echo 0)',
    'if [ "$major" -lt 20 ] 2>/dev/null; then',
    '  echo "Node.js 版本太旧（$(node -v)），需要 20 或更新的版本：https://nodejs.org/zh-cn/download" >&2',
    '  exit 1',
    'fi',
    'exec node server.mjs --prod "$@"',
    '',
  ].join('\n'),
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
    '   Windows 第一次双击时如果提示「Windows 已保护你的电脑」：托盘程序没有购买代码签名证书，',
    '   点「更多信息」→「仍要运行」即可，之后不会再提示。',
    '',
    '数据保存在用户目录的 .agent-panel 下（Windows 是 C:\\Users\\<用户名>\\.agent-panel），升级、重新解压都不会丢；',
    '设置的「数据」里可以查看占用、清理，以及导出 / 导入数据，换电脑时用来迁移。',
    '旧版本放在本目录 data/ 下的数据，第一次启动时会自动复制过去。',
    '端口用环境变量 PORT 修改，数据目录用 AGENT_PANEL_DATA 修改。',
    '',
  ].join('\n'),
)
cpSync(path.join(root, 'README.md'), path.join(out, 'README.md'))

// 打好的服务端要能直接加载（更新时新版本也是这样试跑的）
run(process.execPath, [path.join(out, 'server.mjs'), '--self-check'], out)

// 4. 压缩（--no-archive 只生成目录，CI 在 Windows 上试运行托盘程序时用）
if (process.argv.includes('--no-archive')) {
  console.log(`已生成：release/${name}`)
  process.exit(0)
}
for (const f of [`${name}.zip`, `${name}.tar.gz`]) rmSync(path.join(outRoot, f), { force: true })
run('zip', ['-qr', `${name}.zip`, name], outRoot)
run('tar', ['-czf', `${name}.tar.gz`, name], outRoot)
if (!existsSync(path.join(outRoot, `${name}.zip`))) throw new Error('压缩失败')
// 校验文件和包一起发布：设置里更新时先对哈希，下载不完整就不装
const sums = [`${name}.zip`, `${name}.tar.gz`].map(
  (f) =>
    `${createHash('sha256')
      .update(readFileSync(path.join(outRoot, f)))
      .digest('hex')}  ${f}`,
)
writeFileSync(path.join(outRoot, 'SHA256SUMS'), sums.join('\n') + '\n')
console.log(`已出包：release/${name}.zip、release/${name}.tar.gz、release/SHA256SUMS`)
