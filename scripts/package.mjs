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
// 三个平台各自一个包：Windows 带托盘程序，macOS 带 .app，Linux 只有启动脚本。
// 包里放对方的启动方式会让人下错包，所以按平台分开
const platforms = ['win', 'mac', 'linux']
const base = `agent-panel-${version}`
// 三个平台各自的目录名；Windows 不带后缀（和以前一样），另外两个带平台名
const nameOf = (platform) => (platform === 'win' ? base : `${base}-${platform}`)
const outRoot = path.join(root, 'release')
// 暂存目录不能和任何平台包重名：Windows 包的名字就是 base
const stage = path.join(outRoot, '.stage')
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

/** Windows 上刚写过的文件常被杀毒软件、索引服务短暂占用，删不掉时等一会儿再试 */
function rmRetry(target, tries = 10) {
  for (let i = 1; ; i++) {
    try {
      rmSync(target, { recursive: true, force: true })
      return
    } catch (e) {
      const code = e?.code ?? ''
      if (i >= tries || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * i)
    }
  }
}

/**
 * macOS 的 .app：包里放一个启动脚本，双击后打开终端跑 start.sh。
 * 没有做代码签名和公证，第一次打开要右键 →「打开」，直接双击会被 Gatekeeper 拦下。
 */
function writeMacApp(dir) {
  const app = path.join(dir, 'Agent 面板.app', 'Contents')
  mkdirSync(path.join(app, 'MacOS'), { recursive: true })
  writeFileSync(
    path.join(app, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleName</key><string>Agent 面板</string>',
      '  <key>CFBundleDisplayName</key><string>Agent 面板</string>',
      `  <key>CFBundleExecutable</key><string>launch</string>`,
      '  <key>CFBundleIdentifier</key><string>com.fixcode.agent-panel</string>',
      `  <key>CFBundleShortVersionString</key><string>${version}</string>`,
      `  <key>CFBundleVersion</key><string>${version}</string>`,
      '  <key>CFBundlePackageType</key><string>APPL</string>',
      '  <key>LSMinimumSystemVersion</key><string>11.0</string>',
      '  <key>NSHighResolutionCapable</key><true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  )
  // 双击 .app 时由 Finder 启动，工作目录是 /，所以先切回包里的目录再启动
  const launch = path.join(app, 'MacOS', 'launch')
  writeFileSync(
    launch,
    [
      '#!/bin/sh',
      '# 双击 .app 时运行的启动脚本：切到 .app 所在的目录，再交给 start.sh',
      'cd "$(dirname "$0")/../../../.." || exit 1',
      'exec ./start.sh "$@"',
      '',
    ].join('\n'),
  )
  chmodSync(launch, 0o755)
}

rmRetry(stage)
for (const p of platforms) rmRetry(path.join(outRoot, nameOf(p)))
mkdirSync(stage, { recursive: true })
// 各平台包先从同一个暂存目录复制，最后再删掉暂存目录
const out = stage

// 1. 正式版前端（不带 --mode demo，演示用的模拟后端不会打进来）
// 直接用 node 跑 vite：Windows 上 npx 是 .cmd，execFileSync 启动不了
run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'])
cpSync(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true })
// 内置的 Maple Mono 是 SIL OFL 字体，许可证要跟着字体一起发
cpSync(path.join(root, 'web/src/assets/fonts/maple-mono-nl/OFL.txt'), path.join(out, 'dist/assets/MapleMono-OFL.txt'))
const files = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => files(path.join(p, f))) : [p])
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
  define: {
    'process.env.NODE_ENV': '"production"',
    __APP_VERSION__: JSON.stringify(version),
    // 浏览器扩展的文件打进 server.mjs：从旧版本在线更新过来时包里的 extension 目录可能没被复制
    // 自带的 Skill（skills/<分类>/<名字>/…）也写进来，装到各 CLI 时从这里取
    __BUNDLED_SKILLS__: JSON.stringify(
      Object.fromEntries(
        files(path.join(root, 'skills'))
          .filter((f) => path.relative(path.join(root, 'skills'), f).split(path.sep).length > 2)
          .map((f) => [
            path.relative(path.join(root, 'skills'), f).split(path.sep).join('/'),
            readFileSync(f).toString('base64'),
          ]),
      ),
    ),
    __EXTENSION_FILES__: JSON.stringify(
      Object.fromEntries(
        readdirSync(path.join(root, 'extension')).map((f) => [
          f,
          readFileSync(path.join(root, 'extension', f)).toString('base64'),
        ]),
      ),
    ),
  },
  // 依赖里有 CommonJS 模块（cross-spawn），给它一个 require
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})

// 演示用的模拟后端和模拟执行（示例输出）都不能出现在包里
// 不用系统的 grep：Windows 上没有，而且找不到命令时会被当成「没找到」
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
// macOS / Linux 装成开机自动运行的后台服务（launchd / systemd），和 Windows 的托盘程序对应
cpSync(path.join(root, 'scripts', 'service', 'install-service.sh'), path.join(out, 'install-service.sh'))
chmodSync(path.join(out, 'install-service.sh'), 0o755)
// Windows 托盘启动程序：在 CI 的 Windows 机器上编译（见 ci.yml），双击后不弹命令行窗口。
// 发布时必须带上（--require-tray）；本机出包没有编译过就不放。放到 Windows 包里，见下面按平台打包的部分
const tray = path.join(root, 'build', 'tray', 'AgentPanel.exe')
writeFileSync(
  path.join(out, '使用说明.txt'),
  [
    `Agent 面板 v${version}`,
    '',
    '1. 安装 Node.js 20 或更新版本：https://nodejs.org',
    '2. 至少安装并登录一个 CLI：Claude Code（claude）、Codex（codex）或 Command Code（cmdc）',
    '3. 启动：',
    '   Windows：双击 AgentPanel.exe，程序在任务栏右下角的通知区显示图标，不会打开命令行窗口，',
    '     启动完成后自动用默认浏览器打开面板；右键图标可以重新打开面板、查看运行日志或退出（退出后面板也会停止）。',
    '     第一次双击时如果提示「Windows 已保护你的电脑」：托盘程序没有购买代码签名证书，',
    '     点「更多信息」→「仍要运行」即可，之后不会再提示。',
    '   macOS：双击「Agent 面板.app」。没有做代码签名，第一次打开要右键 →「打开」；',
    '     也可以运行 ./start.sh（或 node server.mjs --prod）。',
    '   Linux：运行 ./start.sh（或 node server.mjs --prod），然后浏览器打开 http://127.0.0.1:8787 。',
    '   macOS / Linux 想开机自动在后台运行、不用一直开着终端，运行一次 ./install-service.sh',
    '     （移除：./install-service.sh uninstall）。',
    '',
    '数据保存在用户目录的 .agent-panel 下（Windows 是 C:\\Users\\<用户名>\\.agent-panel），升级、重新解压都不会丢；',
    '设置的「数据」里可以查看占用、清理，以及导出 / 导入数据，换电脑时用来迁移。',
    '旧版本放在本目录 data/ 下的数据，第一次启动时会自动复制过去。',
    '端口用环境变量 PORT 修改，数据目录用 AGENT_PANEL_DATA 修改。',
    '',
  ].join('\n'),
)
cpSync(path.join(root, 'README.md'), path.join(out, 'README.md'))
// 浏览器扩展：UI 设计里用已登录的 Gemini / ChatGPT 网页生成图片，在浏览器里「加载已解压的扩展程序」选这个目录
cpSync(path.join(root, 'extension'), path.join(out, 'extension'), { recursive: true })

// 打好的服务端要能直接加载（更新时新版本也是这样试跑的）
run(process.execPath, [path.join(stage, 'server.mjs'), '--self-check'], stage)

// 4. 按平台打包
// Windows 只需要托盘程序和核心文件；macOS 多一个 .app；Linux 只有启动脚本
const copyTo = (platform) => {
  const to = path.join(outRoot, nameOf(platform))
  rmRetry(to)
  mkdirSync(to, { recursive: true })
  for (const entry of ['dist', 'server.mjs', 'package.json', 'README.md', '使用说明.txt', 'extension']) {
    cpSync(path.join(stage, entry), path.join(to, entry), { recursive: true })
  }
  return to
}

// Linux：start.sh + install-service.sh（脚本自己识别 launchd / systemd，macOS 也能用）
const linuxDir = copyTo('linux')
for (const sh of ['start.sh', 'install-service.sh']) {
  cpSync(path.join(stage, sh), path.join(linuxDir, sh))
  chmodSync(path.join(linuxDir, sh), 0o755)
}

// macOS：和 Linux 一样能用，另外给一个 .app（没签名，首次打开要右键「打开」）
const macDir = copyTo('mac')
for (const sh of ['start.sh', 'install-service.sh']) {
  cpSync(path.join(stage, sh), path.join(macDir, sh))
  chmodSync(path.join(macDir, sh), 0o755)
}
writeMacApp(macDir)

// Windows：托盘程序；没有编译过时本机出包不放，发布时必须带上
const winDir = copyTo('win')
if (existsSync(tray)) cpSync(tray, path.join(winDir, 'AgentPanel.exe'))
else if (process.argv.includes('--require-tray')) throw new Error('缺少 build/tray/AgentPanel.exe（托盘启动程序）')
// Windows 包里也留一个命令行启动方式，托盘程序用不了时还能跑
cpSync(path.join(stage, 'start.sh'), path.join(winDir, 'start.sh'))
chmodSync(path.join(winDir, 'start.sh'), 0o755)

// 暂存目录只用来复制，不再单独发布
rmRetry(stage)

if (process.argv.includes('--no-archive')) {
  console.log(`已生成：${platforms.map((p) => `release/${nameOf(p)}`).join('、')}`)
  process.exit(0)
}

// 5. 压缩：Windows 用 zip（解压出来带目录，双击 AgentPanel.exe）；macOS / Linux 用 tar.gz。
// macOS 也出 zip：.app 是目录，zip 能带上可执行权限，方便在 Finder 里直接解压
// 用系统自带的 tar：Windows 10 起是 bsdtar，-a 按扩展名选格式，能直接写 zip；不依赖只有 Linux 才有的 zip 命令
const archives = {
  win: [`${base}.zip`],
  mac: [`${base}-mac.tar.gz`, `${base}-mac.zip`],
  linux: [`${base}-linux.tar.gz`],
}
for (const list of Object.values(archives)) for (const f of list) rmRetry(path.join(outRoot, f))

const archive = (file, dir) => {
  if (file.endsWith('.tar.gz')) run('tar', ['-czf', file, dir], outRoot)
  else run('tar', ['-a', '-cf', file, dir], outRoot)
}
for (const [platform, list] of Object.entries(archives)) for (const name of list) archive(name, nameOf(platform))

const all = [...archives.win, ...archives.mac, ...archives.linux]
for (const f of all) if (!existsSync(path.join(outRoot, f))) throw new Error(`压缩失败：${f}`)
// 校验文件和包一起发布：设置里更新时先对哈希，下载不完整就不装
const sums = all.map(
  (f) =>
    `${createHash('sha256')
      .update(readFileSync(path.join(outRoot, f)))
      .digest('hex')}  ${f}`,
)
writeFileSync(path.join(outRoot, 'SHA256SUMS'), sums.join('\n') + '\n')
console.log(`已出包：${all.map((f) => `release/${f}`).join('、')}、release/SHA256SUMS`)
