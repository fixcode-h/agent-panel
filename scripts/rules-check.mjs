// 把 docs/lessons/ 里能机器判断的教训变成检查，`npm run lint` 会跑。
// 1. 不按 CLI 的名字写分支：CLI 的差异写进定义（shared/clis*），代码按字段走
// 2. 文档里写的仓库路径必须存在，避免改名、删文件后文档还指着旧路径
// 3. 教训分片的格式和大小：有 paths、每条有「规则」、单个分片不超过 6 KB、paths 至少命中一个文件
// 4. 已跟踪文本文件的换行和编码：仓库里统一 LF、UTF-8 无 BOM（见 .gitattributes）
// 4b. 文本文件里不能有裸 NUL 字节：写成 `` `\0` `` 的文本被误存成 0x00 时 grep / rg 会整份跳过、搜不到
// 5. 附件的原路径和 placed；6. 清掉任务字段写 undefined，不用 delete
// 6b. 界面不用细字重（font-thin / extralight / light、font-weight 100–300）：主次靠颜色和字号分
// 6c. 字号、圆角不手写，用阶梯里的名字
// 7. 模块文档和 MODULE-MAP 的模块表双向对得上：缺文档、模块删了文档目录还留着
// 7b. `docs/modules/<模块>/bugs.md` 由 `bugs/<bug-id>.md` 生成：手改索引、改了详情忘了重生成都会被拦下
// 8. 一轮结束只发一次回调：server/exec/runner.ts 里 markTurnDone 和 ctx.onTurnEnd 只能从 endTurn() 一处发出
// 9. 共享仓库的 config 里不能有 core.worktree
// 10. 默认代理端口只在 shared/proxy.ts 定义一处，别处写同样的 127.0.0.1:<端口> 字面量会被拦下
// 11. 界面检查用例必须写在 runShard 的回调里：`scripts/ui/` 分片里 runShard 调用之后的代码永远不执行
// 12. 提示只能从 web/src/lib/toast.ts 取 toast：直接从 sonner 引会绕过排队（例外写 `sonner-toast-ok: 原因`）
// 13. 「完成未看」的橙点只读 taskDoneDot：组件里不自己比 turnDoneAt / turnSeenAt
// 14. `scripts/ui/` 下的分片必须能被总入口收录、截图前缀认得出（新分片否则静默不跑）
// 15. 大文件只许变小：超过 scripts/file-caps.json 里的上限就失败
// 16. 界面上的中文要走 t()：JSX 文字节点里直接写中文会在英文界面里露出来
// 确实需要按名字区分时（例如内置适配器内部），在这一行或上一行写 `cli-id-ok: 原因`。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { globToRegExp, readShards } from './lessons.mjs'
import { checkModuleDocsInRoot } from './lib/doc-modules.mjs'
import { checkBugIndexesInRoot } from './lib/doc-bugs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => f && existsSync(path.join(root, f)))
const read = (f) => readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n')
const errors = []

// 1. CLI 名字分支
const ids = [
  'claude',
  'codex',
  ...files
    .filter((f) => /^shared\/clis\/[^/]+\.json$/.test(f))
    .map((f) => JSON.parse(read(f)).id)
    .filter(Boolean),
]
const q = `['"](?:${ids.join('|')})['"]`
const subject = String.raw`\b(?:id|cli|cliId|cliKey)\b`
const branch = new RegExp(`${subject}\\s*[!=]==?\\s*${q}|${q}\\s*[!=]==?\\s*(?:\\w+\\.)?${subject}`)
const SKIP = /\.test\.tsx?$|\/demo-|\/locales\/|^shared\/clis\.ts$/
for (const f of files) {
  if (!/^(shared|server|web\/src)\/.+\.tsx?$/.test(f) || SKIP.test(f)) continue
  const lines = read(f).split('\n')
  lines.forEach((l, i) => {
    if (!branch.test(l) || /cli-id-ok/.test(l) || /cli-id-ok/.test(lines[i - 1] ?? '')) return
    errors.push(`${f}:${i + 1} 按 CLI 名字写了分支，改成 CLI 定义里的字段（见 docs/lessons/cli.md）：${l.trim()}`)
  })
}

// 2. 文档里的路径
const docs = files.filter((f) => /^(AGENTS|CLAUDE|README)\.md$|^docs\/.+\.md$|\/README\.md$/.test(f))
const TOP = /^(shared|server|web|scripts|docs|skills|extension|\.github)\//
for (const f of docs) {
  const text = read(f)
  const refs = new Set()
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1].replace(/:\d+$/, '').replace(/\/$/, '')
    if (TOP.test(p) && !/[<>{}*|…]/.test(p)) refs.add(p)
  }
  for (const m of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
    refs.add(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])))
  }
  for (const p of refs) if (!existsSync(path.join(root, p))) errors.push(`${f} 引用的 ${p} 不存在`)
}

// 3. 教训分片
// 分片按功能模块拆，拆出来的 paths 必须比原来窄：paths 一模一样的两个分片改同一个文件时照样都要读，
// 等于只换了文件名、把 6 KB 的上限绕过去了（见 docs/lessons/README.md「怎么让它不越积越多」）
const shardsByPaths = new Map()
for (const s of readShards()) {
  const f = `docs/lessons/${s.name}`
  if (!s.globs.length) errors.push(`${f} 开头缺少 paths`)
  if (Buffer.byteLength(s.text) > 6144)
    errors.push(`${f} 超过 6 KB，把只和某个模块有关的几条拆进 paths 更窄的分片；拆不动再合并同类项或改成检查`)
  const key = [...new Set(s.globs)].sort().join(', ')
  if (key && shardsByPaths.has(key))
    errors.push(`${f} 的 paths 和 docs/lessons/${shardsByPaths.get(key)} 完全一样：拆分片要收窄 paths，否则合成一个`)
  else shardsByPaths.set(key, s.name)
  for (const g of s.globs) {
    const re = globToRegExp(g)
    if (!files.some((x) => re.test(x))) errors.push(`${f} 的 paths 里 ${g} 一个文件都没命中`)
  }
  for (const sec of s.body.split(/^## /m).slice(1)) {
    const title = sec.split('\n')[0]
    if (!/^- 规则：/m.test(sec)) errors.push(`${f}「${title}」缺少「- 规则：」`)
  }
}

// 4. 换行和编码：Windows 上 core.autocrlf 会把工作区转成 CRLF，编辑器存成带 BOM 的文字
// 在 WSL / Linux 里跑会报 bad interpreter，所以已跟踪的文本文件一律 LF、UTF-8 无 BOM
const attrs = existsSync(path.join(root, '.gitattributes'))
  ? readFileSync(path.join(root, '.gitattributes'), 'utf8').split('\n')
  : []
// .gitattributes 里标成 binary 或 -text 的按二进制处理；不带目录的模式匹配任意层
const attrBinary = attrs
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split(/\s+/))
  .filter(([, ...a]) => a.includes('binary') || a.includes('-text'))
  .map(([pattern]) => globToRegExp(pattern.includes('/') ? pattern : `**/${pattern}`))
const tracked = execFileSync('git', ['ls-files', '--cached'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(path.join(root, f)))
const crlf = []
const bom = []
for (const f of tracked) {
  if (attrBinary.some((re) => re.test(f))) continue
  const buf = readFileSync(path.join(root, f))
  // 和 git 一样：前 8 KB 里有 0 字节就当二进制，不检查换行和 BOM
  // （真混进 NUL 的情况由下面的 4b 单独查，这里跳过只是为了不把二进制资产当文本判 CRLF）
  if (buf.subarray(0, 8000).includes(0)) continue
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom.push(f)
  if (buf.includes('\r\n')) crlf.push(f)
}
const list = (a) => [...a.slice(0, 10).map((f) => `  ${f}`), ...(a.length > 10 ? [`  ……还有 ${a.length - 10} 个`] : [])]
if (crlf.length)
  errors.push(
    [
      `${crlf.length} 个已跟踪的文件含 CRLF 换行，仓库统一存 LF：`,
      ...list(crlf),
      '修复：git config core.autocrlf false，然后 git add --renormalize . 重新入库；工作区的文件用编辑器或 dos2unix 转成 LF',
    ].join('\n'),
  )
if (bom.length)
  errors.push(
    [
      `${bom.length} 个已跟踪的文件带 UTF-8 BOM，仓库统一用无 BOM：`,
      ...list(bom),
      '修复：把文件另存为 UTF-8 无 BOM（PowerShell 5.1 的 -Encoding UTF8 会写 BOM，改用 [System.IO.File]::WriteAllText）',
    ].join('\n'),
  )

// 4b. 文本文件里不能有裸 NUL 字节（0x00）：文档里写 `` `\0` `` 时被编辑成真正的 0 字节，
// 文件仍是 UTF-8 文本（file 认得出），grep 却报 `Binary file ... matches`、rg 默认直接跳过，
// 整份模块文档等于从所有人的搜索结果里消失。上面第 4 条碰到前 8 KB 含 NUL 的文件会按二进制跳过，
// 挡不住这种写法，所以单独查一遍。
// 只读白名单里的文本类型：图片、字体、压缩包这类资产别整个读进来。
// 扫 `files` 而不是 `tracked`：刚写进工作区、还没 git add 的文件也要拦住，否则要等下一次提交才发现。
const textExts = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.mjs',
  '.cjs',
  '.jsx',
  '.js',
  '.json',
  '.jsonl',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.css',
  '.html',
  '.sh',
  '.py',
  '.cs',
])
// 没有扩展名的文本文件按文件名认（.editorconfig 这类点开头的 extname 为空）
const textNames = new Set(['.editorconfig', '.gitattributes', '.gitignore', 'LICENSE', 'NOTICE'])
const isTextFile = (f) => textExts.has(path.extname(f).toLowerCase()) || textNames.has(path.posix.basename(f))
const nulFiles = []
for (const f of files) {
  if (!isTextFile(f) || attrBinary.some((re) => re.test(f))) continue
  const buf = readFileSync(path.join(root, f))
  // 绝大多数文件没有 NUL：先用原生 indexOf 快速跳过，只有真含 NUL 的才逐字节算行号
  if (buf.indexOf(0) < 0) continue
  // 一次顺序扫描就算出行号：按每个命中都从文件头数一遍换行是「命中数 × 文件长度」，
  // 一个几 MB、命中十万个的 NUL 文件要跑几十秒才报错；行号按行去重，同一行多个 NUL 只报一次
  const hitLines = new Set()
  let line = 1
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) line++
    else if (buf[i] === 0) hitLines.add(line)
  }
  for (const n of hitLines) nulFiles.push(`${f}:${n}`)
}
if (nulFiles.length)
  errors.push(
    [
      `${nulFiles.length} 处文本文件（受版本控制的或尚未提交的新文件）里含裸 NUL 字节（0x00），grep 会当成二进制、rg 会整份跳过：`,
      ...list(nulFiles),
      "修复：改成文本写法 `\\0`（反斜杠加 0，放在行内代码里），源码里要真的 NUL 用转义写法 '\\0' 或 String.fromCharCode(0)，不要留裸字节",
    ].join('\n'),
  )

// 5. 附件的两个路径：记进对话的用上传目录的原路径，拷进任务目录的 placed 只给 CLI
// （见 docs/lessons/attachments.md「附件落盘」）
for (const f of files) {
  if (!/^server\/.+\.ts$/.test(f) || /\.test\.ts$/.test(f)) continue
  if (/attachments:\s*placed\b/.test(read(f)))
    errors.push(`${f} 把拷进任务目录的附件（placed）记进了对话：对话里要存上传目录的原路径，placed 只给 CLI`)
}

// 6. 清掉任务字段写 undefined：store.update 把传入的字段盖到旧记录上，delete 掉的键盖不掉旧值
// （见 docs/lessons/data.md「清掉任务上的字段写 undefined」）
for (const f of files) {
  if (!/^server\/.+\.ts$/.test(f) || /\.test\.ts$/.test(f)) continue
  read(f)
    .split('\n')
    .forEach((l, i) => {
      if (/\bdelete\s+(?:tk|task|next|cur|child|parent)\.\w+\s*$/.test(l) && !/delete-ok/.test(l))
        errors.push(`${f}:${i + 1} 用 delete 清任务字段，落盘后旧值还在，改成写 undefined：${l.trim()}`)
    })
}

// 6b. 界面不用细字重：主次靠颜色和字号分（见 docs/lessons/visual.md「边界靠底色分，字不能细」）
for (const f of files) {
  if (!/^web\/src\/.+\.(tsx|css)$/.test(f)) continue
  read(f)
    .split('\n')
    .forEach((l, i) => {
      if (/\bfont-(?:thin|extralight|light)\b|font-weight:\s*[1-3]00\s*;/.test(l))
        errors.push(`${f}:${i + 1} 用了细字重，界面常规字最细 450，主次用颜色或字号分：${l.trim()}`)
    })
}

// 6c. 字号和圆角走阶梯（见 docs/lessons/ui.md「文案、命名和控件的写法」）：
// 不手写 text-[…rem] / text-[…px]，用 index.css @theme 里的 text-caption、text-body 这些角色；
// 圆角不手写 5px 以上的 rounded-[…]，用 rounded-sm / lg / xl / 2xl / 3xl。4px 以下的小色块按自身大小写，不拦
for (const f of files) {
  if (!/^web\/src\/.+\.(tsx?|css)$/.test(f) || /\.test\.tsx?$/.test(f)) continue
  read(f)
    .split('\n')
    .forEach((l, i) => {
      if (/\btext-\[[0-9.]+(?:rem|px|em)\]/.test(l))
        errors.push(`${f}:${i + 1} 手写了字号，改用 text-caption / text-body 这类字号角色：${l.trim()}`)
      const r = l.match(/\brounded(?:-[a-z]{1,2})?-\[([0-9.]+)(px|rem)\]/)
      if (r && (r[2] === 'rem' || Number(r[1]) > 4))
        errors.push(`${f}:${i + 1} 手写了圆角，改用 rounded-sm / lg / xl / 2xl / 3xl：${l.trim()}`)
    })
}

// 7. 模块文档和模块地图双向对得上（见 skills/docs/project-documentation「模块文档」）；root 必须是仓库根，传错会因为找不到 docs/MODULE-MAP.md 而静默通过
errors.push(...checkModuleDocsInRoot(root))

// 7b. Bug 索引是生成物：只写 docs/modules/<模块>/bugs/<bug-id>.md，bugs.md 由 node scripts/doc-bugs.mjs 生成
// （见 skills/docs/project-documentation「模块文档」）。多个子对话并行收尾时各自新增详情文件，就不会都改同一张表
// 末尾而反复冲突；手改索引或改完详情没重生成都在这里拦下
errors.push(...checkBugIndexesInRoot(root))

// 8. 一轮结束只发一次回调：runner 里 markTurnDone 和 ctx.onTurnEnd 只能从 endTurn() 一处发出。
// 两处各发一次时同一轮会被上报两遍（CLI 的 result 和「回复完停在等下一句」相隔几百毫秒，
// reportKey 按 turnDoneAt 去重挡不住），见 docs/lessons/execution.md「一轮结束只发一次回调」
{
  const f = 'server/exec/runner.ts'
  if (existsSync(path.join(root, f))) {
    // 按调用次数算，不按行：两个调用写在同一行也是守着「只从 endTurn 发出」；注释里提到不算
    const code = read(f)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    const calls = code.match(/\bmarkTurnDone\(\s*task\s*\)|ctx\.onTurnEnd\?\.\(/g) ?? []
    if (calls.length !== 2)
      errors.push(
        `${f} 里一轮结束只能从 endTurn() 一处发出（markTurnDone + onTurnEnd 各一次），实际 ${calls.length} 处`,
      )
  }
}

// 9. 共享仓库的 config 里不能有 core.worktree：在 WSL 里带 GIT_DIR/GIT_WORK_TREE 跑 lint 或测试时，
// 测试里的 git init 会把它们写进共享 config（core.worktree = /mnt/...），
// 之后主目录所有 git 命令都报 `fatal: Invalid path '/mnt'`，HEAD 也可能变成分离状态（见 docs/lessons/e2e.md）
{
  // worktree 的 .git 文件里是 Windows 路径（E:/...），在 WSL 里要换成 /mnt/e/... 才找得到；
  // 解析不出来时报错，不要静默跳过——WSL 正是会写坏 config 的那个环境
  const hostPath = (p) => {
    if (process.platform === 'win32') return p
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p
  }
  const dotgit = path.join(root, '.git')
  let common = dotgit
  if (existsSync(dotgit) && !statSync(dotgit).isDirectory()) {
    const m = readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)
    if (!m) errors.push(`${dotgit} 读不出 gitdir，没法检查共享 config 里的 core.worktree`)
    else common = path.resolve(root, hostPath(m[1]))
  }
  if (!existsSync(common)) errors.push(`${dotgit} 指向的 ${common} 不存在，没法检查共享 config 里的 core.worktree`)
  else {
    const cd = path.join(common, 'commondir')
    if (existsSync(cd)) common = path.resolve(common, readFileSync(cd, 'utf8').trim())
    const cfg = path.join(common, 'config')
    if (existsSync(cfg)) {
      let inCore = false
      for (const line of readFileSync(cfg, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
        const s = line.trim()
        if (/^\[/.test(s)) inCore = /^\[core\]$/i.test(s)
        else if (inCore && /^worktree\s*=/i.test(s))
          errors.push(
            `${cfg} 里写了 core.worktree（${s}）：在 WSL 里带 GIT_DIR/GIT_WORK_TREE 跑 lint 或测试时 git init 会写进去，主仓库的 git 命令会全部失败。删掉这一行`,
          )
      }
    }
  }
}

// 10. 默认代理地址只有一个出处：shared/proxy.ts 的 DEFAULT_PROXY_PORT。
// 其它地方再手写一份 127.0.0.1:<端口>，改默认值时就会漏改一处，界面示例和实际行为对不上。
// 范围包括 CLI 定义里的 JSON 和 scripts/ 下的脚本（CLI 环境变量示例就写在 shared/clis/*.json 里），
// 但不扫 *.test.ts：测试里大量写 127.0.0.1:7890 这类固件地址，与默认值无关。
// 要放宽（例如真实需要写死）在那一行或上一行写 `proxy-port-ok: 原因`。
{
  const file = 'shared/proxy.ts'
  if (!existsSync(path.join(root, file))) errors.push(`${file} 不存在，没法检查默认代理地址是否只有一个出处`)
  else {
    const src = read(file)
    // 允许 10_808 这种带下划线的写法
    const m = src.match(/export\s+const\s+DEFAULT_PROXY_PORT\s*=\s*(\d[\d_]*)/)
    if (!m) errors.push(`${file} 里找不到 DEFAULT_PROXY_PORT 的定义`)
    else {
      const port = m[1].replace(/_/g, '')
      const dup = new RegExp(`127\\.0\\.0\\.1:${port}\\b`)
      for (const f of files) {
        if (!/^(shared|server|web\/src|scripts)\/.+\.(tsx?|mjs|json)$/.test(f) || f === file) continue
        if (/\.test\.tsx?$|\.test\.mjs$/.test(f)) continue
        const lines = read(f).split('\n')
        lines.forEach((l, i) => {
          if (!dup.test(l) || /proxy-port-ok/.test(l) || /proxy-port-ok/.test(lines[i - 1] ?? '')) return
          errors.push(
            `${f}:${i + 1} 又写了一份默认代理地址的端口，改成从 shared/proxy.ts 的 DEFAULT_PROXY_URL 取（默认代理地址只在那里定义一次）：${l.trim()}`,
          )
        })
      }
    }
  }
}

// 11. 界面检查用例必须写在 runShard 的回调里：runShard 在回调结束后直接 process.exit(0/1)，
// 写在回调之后的代码永远不执行，分片却照样报「通过」，用例等于没加（这条教训已经整条改成下面的检查）
for (const f of files) {
  if (!/^scripts\/ui\/.+\.mjs$/.test(f) || f.endsWith('harness.mjs')) continue
  const src = read(f)
  const at = src.indexOf('await runShard(')
  if (at < 0) continue
  // runShard 调用本身以 `})` 结尾，之后除了注释和空行不该再有代码
  const end = src.indexOf('\n})\n', at)
  if (end < 0) continue
  const rest = src
    .slice(end + 3)
    .split('\n')
    .filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l))
  if (rest.length)
    errors.push(
      `${f} 里 runShard 调用之后还有 ${rest.length} 行代码（${rest[0].trim().slice(0, 60)}）；runShard 结束后会直接退出，这些用例永远不会执行，写进 runShard 的回调里`,
    )
}

// 12. 提示只能从 web/src/lib/toast.ts 取 toast：直接从 sonner 引会绕过排队
// （sonner 的 visibleToasts 不是排队，见 web/src/lib/toast-queue.ts），几百处调用点各写一遍不现实，
// 所以用一个统一入口卡住。Toaster 本体仍然从 sonner 引（只有 App.tsx 用）。
// 确实要直接拿 sonner 的（例如在入口里实现透传）在那一行或上一行写 `sonner-toast-ok: 原因`。
for (const f of files) {
  if (!/^web\/src\/.+\.tsx?$/.test(f) || /^web\/src\/lib\/toast(-queue)?(\.test)?\.ts$/.test(f)) continue
  const lines = read(f).split('\n')
  lines.forEach((l, i) => {
    // 只看从 sonner 引东西的行；`import type` 不算（类型不需要经过队列）
    if (!/^import\b/.test(l) || !/['"]sonner['"]/.test(l) || /^import\s+type\b/.test(l)) return
    // `import { toast }`、`import { toast as sonnerToast }`、`import { Toaster, toast }`、
    // `import sonner from 'sonner'`、`import * as sonner from 'sonner'` 都算
    const named = /\{[^}]*\}/.test(l) ? (/\{[^}]*\}/.exec(l)?.[0] ?? '') : ''
    const namedHasToast =
      /(?:^|[{,\s])(?:toast|sonner)\b/.test(named.replace(/\sas\s+[^,}]+/g, '')) ||
      /\{[^}]*\b(?:toast|sonner)\s+as\b/.test(named)
    const defaultImport = /^import\s+(?:toast|sonner)\s*(?:,|from\b)/.test(l)
    const namespaceImport = /^import\s+\*\s+as\s+(?:toast|sonner)\b/.test(l)
    if (!namedHasToast && !defaultImport && !namespaceImport) return
    if (/sonner-toast-ok/.test(l) || /sonner-toast-ok/.test(lines[i - 1] ?? '')) return
    errors.push(
      `${f}:${i + 1} 直接从 sonner 引了 toast，提示要排队，改成 import { toast } from '@/lib/toast'：${l.trim()}`,
    )
  })
}

// 13. 「完成未看」的橙点只在 shared/task.ts 的 taskDoneDot 一处判：组件里直接比 turnDoneAt / turnSeenAt
// 会和 taskState 各算一套，对话后来又跑起来时橙点和转圈同时出现在一行（见 docs/lessons/ui.md）
for (const f of files) {
  if (!/^web\/src\/components\/.+\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f)) continue
  read(f)
    .split('\n')
    .forEach((l, i) => {
      if (/\bturnDoneAt\b/.test(l) && /\bturnSeenAt\b/.test(l) && /[!=]==?/.test(l) && !/dot-ok/.test(l))
        errors.push(
          `${f}:${i + 1} 组件里直接比较 turnDoneAt / turnSeenAt 判「完成未看」，改读 shared/task.ts 的 taskDoneDot（见 docs/lessons/ui.md）：${l.trim()}`,
        )
    })
}

// 14. 界面检查的分片文件名要和两处正则对得上：
// scripts/ui-check.mjs 的 SHARD_FILE（认不到就不被收录，静默少跑一半检查）和
// scripts/ui/harness.mjs 的截图 prefix（认不出字母后缀时 02b/02c 都落到 00-，截图互相覆盖）。
// 正则直接从源码里读，不在这里再抄一份。拆片时容易只改一处（见 docs/lessons/ui-check.md）
const uiShardRegex = (file, re) => read(file).match(re)?.[1]
const uiShards = files.filter((f) => /^scripts\/ui\/\d[^/]*\.mjs$/.test(f))
const shardFileSrc = uiShardRegex('scripts/ui-check.mjs', /const SHARD_FILE = \/(.+)\/\s*$/m)
if (!shardFileSrc) errors.push('scripts/ui-check.mjs：读不到 SHARD_FILE（收录分片的正则），无法确认新分片会被跑')
else {
  const shardFile = new RegExp(shardFileSrc)
  for (const f of uiShards) {
    if (!shardFile.test(path.posix.basename(f)))
      errors.push(`${f}：不能被 scripts/ui-check.mjs 的 SHARD_FILE 收录，这个分片会被静默跳过`)
  }
}
const shotPrefixSrc = read('scripts/ui/harness.mjs').match(/path\.basename\(file\)\.match\(\/\^\((.+?)\)-\/\)/)?.[1]
if (!shotPrefixSrc) errors.push('scripts/ui/harness.mjs：读不到截图前缀正则（path.basename(file).match(...)）')
else {
  const shotPrefix = new RegExp(`^(${shotPrefixSrc})-`)
  for (const f of uiShards) {
    if (!shotPrefix.test(path.posix.basename(f)))
      errors.push(`${f}：截图前缀正则（scripts/ui/harness.mjs）认不出这个文件名，截图会和别的分片互相覆盖`)
  }
}

// 15. 大文件只许变小：scripts/file-caps.json 里列的文件不能超过各自的上限，没列的源码文件不能超过 default。
// server/tasks.ts 拆分前四天涨了 1000 行；上限只拦「继续变大」，新代码放进拆出来的模块（见 scripts/file-caps.mjs）
{
  const { capsPath, linesOf, sourceFiles } = await import('./lib/file-caps.mjs')
  const caps = JSON.parse(readFileSync(capsPath(root), 'utf8'))
  for (const f of sourceFiles(root)) {
    if (!existsSync(path.join(root, f))) continue
    const cap = caps.files[f] ?? caps.default
    const lines = linesOf(root, f)
    if (lines > cap)
      errors.push(
        `${f}：${lines} 行，超过上限 ${cap}（scripts/file-caps.json）。把新加的部分拆到独立模块里；文件变小了跑 node scripts/file-caps.mjs --update 把上限降下来`,
      )
  }
}

// 16. 界面上的中文要走 t()：i18n-check 只查 t() 里的文案有没有英文，没包 t() 直接写在 JSX 里的中文查不出来，
// 英文界面就会冒出中文（设计项目的风格预设就这样漏过）。只看 JSX 的文字节点（>中文<），演示数据和测试不管；
// 确实要原样显示中文的行在结尾加 i18n-ok 并写明原因
{
  const cjk = /[\u4e00-\u9fff]/
  const jsxText = />([^<>{}\n]*)</g
  for (const f of files.filter((x) => x.startsWith('web/src/') && x.endsWith('.tsx') && !x.includes('.test.'))) {
    const lines = readFileSync(path.join(root, f), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.includes('i18n-ok') || line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return
      for (const m of line.matchAll(jsxText)) {
        if (cjk.test(m[1]))
          errors.push(
            `${f}:${i + 1}：JSX 里直接写了中文「${m[1].trim().slice(0, 20)}」，界面文案要用 t('中文')（见 AGENTS.md）`,
          )
      }
    })
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log('规则检查通过')
