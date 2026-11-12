// 代码结构只许变好（rules-check 第 21 条调用 checkStructure；基线在 scripts/structure-caps.json）。
// node scripts/structure-check.mjs           列出现在的各项数字和基线
// node scripts/structure-check.mjs --update  把变好了的项跟着收紧（只收紧不放宽），已经不存在的项删掉
//
// 为什么要有：2026-11-12 梳理结构（docs/lessons/structure.md）时发现的乱，都是一次加一点攒出来的——
// 千行闭包、113 个字段的 Task、七份 git 包装、两百多处界面自己拼状态。文件行数上限（file-caps）管不住函数和这些写法，
// 这里把每一类都量成数字：已有的记进基线，只许变小；新代码一出现就失败，提示该放哪里。
// 确实要放宽某一项时手改 structure-caps.json，提交说明里写为什么。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { functionsOf, maskCode } from './lib/code-scan.mjs'

/** 函数（含闭包、箭头函数、方法）超过这么多行就要进基线：新函数不许超过 */
export const FN_MAX = 300
/** shared/host/ 里新开的小接口最多几个成员（记进基线以后只许变少）：再多就该按能力再拆一个 */
export const HOST_NEW_MAX = 16
/** 已经超长的函数的上限：现在的行数留 20 行余量取整到 10（小修小补不用每次改基线，但不能再往里堆功能） */
const fnCap = (lines) => Math.ceil((lines + 20) / 10) * 10
/** 不许再往顶层加文件的目录：新文件放进按模块分的子目录（见 docs/MODULE-MAP.md） */
const FLAT_DIRS = ['server', 'shared', 'web/src/lib']
/** 前端组件里直接读的对话运行时字段：状态从 convState 派生的工具函数取（web/src/lib、shared/task.ts） */
const LIVE_RE =
  /\.(?:working|cliAlive|awaitingUser|prewarming|childrenWorking|childrenCli|childrenNeeds)\b|\btask\??\.status\s*[!=]==/g
const GIT_RE = /\(\s*'git'\s*,/g
/** 模块顶层的可变状态：let，或者 const x = new Map / Set / WeakMap / WeakSet */
const STATE_RE = /^(?:export )?(?:let |const [\w$]+(?:\s*:[^=]+)?\s*=\s*new (?:Map|Set|WeakMap|WeakSet)\b)/

const capsFile = (root) => path.join(root, 'scripts', 'structure-caps.json')

function listFiles(root) {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'server', 'shared', 'web/src'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f) && existsSync(path.join(root, f)))
}

const isTest = (f) => /\.test\.tsx?$|test-kit\.ts$/.test(f)
const isDemo = (f) => /\/demo-[^/]*$/.test(f)

const marked = (lines, i, re) => re.test(lines[i] ?? '') || re.test(lines[i - 1] ?? '')

/** 从某一行开始的块（到第一个只有 } 或 }) 的行为止）里，缩进两格的成员 / 字段有几个 */
function membersAfter(lines, head) {
  const i = lines.findIndex((l) => head.test(l))
  if (i < 0) return 0
  let n = 0
  for (let k = i + 1; k < lines.length && !/^}/.test(lines[k]); k++) if (/^  [\w$]+\??\s*[:(]/.test(lines[k])) n++
  return n
}

/** 量出现在的各项数字 */
export function measure(root) {
  const files = listFiles(root)
  const m = {
    functions: {},
    flatFiles: {},
    taskFields: 0,
    preprocess: 0,
    orchInlineTools: 0,
    hostMembers: {},
    gitCalls: {},
    moduleState: {},
    uiLiveFields: {},
    intervals: {},
    unreadable: [],
  }
  for (const dir of FLAT_DIRS) m.flatFiles[dir] = []
  for (const f of files) {
    const dir = path.posix.dirname(f)
    if (FLAT_DIRS.includes(dir) && !isTest(f)) m.flatFiles[dir].push(path.posix.basename(f))
    if (isTest(f) || f.startsWith('shared/locales/')) continue
    const text = readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n')
    const lines = text.split('\n')
    const demo = isDemo(f)
    // 1. 函数长度（演示后端也算：它是界面检查跑的那一份）
    const code = maskCode(text)
    if ((code.match(/{/g) ?? []).length !== (code.match(/}/g) ?? []).length) m.unreadable.push(f)
    const seen = new Map()
    for (const fn of functionsOf(text)) {
      if (fn.lines <= FN_MAX) continue
      const base = `${f}::${fn.name}`
      const k = seen.has(base) ? `${base}#${seen.get(base) + 1}` : base
      seen.set(base, (seen.get(base) ?? 0) + 1)
      m.functions[k] = fn.lines
    }
    const codeLines = code.split('\n')

    if (f === 'shared/schema.ts') m.taskFields = membersAfter(codeLines, /^export const TaskData = z\.object\(\{/)
    if (f === 'shared/engine-host.ts')
      for (const name of ['Orchestra', 'EngineHost'])
        m.hostMembers[name] = membersAfter(codeLines, new RegExp(`^export interface ${name}\\b`))
    // 从两个大接口按能力拆出来的小接口（重构文档第 5 条）：每个都记成员数，同样只许变少
    if (/^shared\/host\/[^/]+\.ts$/.test(f))
      for (const [, name] of text.matchAll(/^export interface (Orch\w+|\w+Host)\b/gm))
        m.hostMembers[name] = membersAfter(codeLines, new RegExp(`^export interface ${name}\\b`))
    if (f === 'server/orch-mcp.ts') m.orchInlineTools = (text.match(/^\s+name: '[a-z_]+',$/gm) ?? []).length
    if (!demo && /^(shared|server)\//.test(f)) m.preprocess += (text.match(/z\.preprocess\(/g) ?? []).length

    // git 只经 server/exec/git.ts 调
    if (f.startsWith('server/') && f !== 'server/exec/git.ts') {
      const n = (text.match(GIT_RE) ?? []).length
      if (n) m.gitCalls[f] = n
    }

    // 模块级可变状态：顶层的 let、new Map / Set；写明「模块状态：缓存 / 运行时」的不算
    if (/^(shared|server)\//.test(f)) {
      let n = 0
      codeLines.forEach((l, i) => {
        if (STATE_RE.test(l) && !marked(lines, i, /模块状态：/)) n++
      })
      if (n) m.moduleState[f] = n
    }

    if (/^web\/src\/(components|pages)\//.test(f) && !demo) {
      const n = (code.match(LIVE_RE) ?? []).length
      if (n) m.uiLiveFields[f] = n
    }
    if (f.startsWith('web/src/') && !demo) {
      let n = 0
      lines.forEach((l, i) => {
        if (/\bsetInterval\(/.test(codeLines[i]) && !marked(lines, i, /interval-ok/)) n++
      })
      if (n) m.intervals[f] = n
    }
  }
  for (const dir of FLAT_DIRS) m.flatFiles[dir].sort()
  return m
}

const CAPPED_MAPS = {
  gitCalls: (f, n, cap) =>
    `${f}：直接调 git ${n} 处（基线 ${cap}）。git 只经 server/exec/git.ts 调（固定带 core.quotepath=off、windowsHide、超时），缺的操作加进那个文件`,
  moduleState: (f, n, cap) =>
    `${f}：顶层可变状态 ${n} 个（基线 ${cap}）。运行时状态收进注入的对象；确实要放在模块顶层时，在那一行或上一行写「// 模块状态：缓存，丢了没事」或「// 模块状态：运行时，<谁负责、重启后怎么办>」`,
  uiLiveFields: (f, n, cap) =>
    `${f}：直接读对话的 status / working / cliAlive 这类运行时字段 ${n} 处（基线 ${cap}）。界面上的对话状态只从 convState 派生（shared/task.ts、web/src/lib 里的工具函数），缺的显示加进那里`,
  intervals: (f, n, cap) =>
    `${f}：setInterval ${n} 处（基线 ${cap}）。走表用 web/src/lib/useNow.ts；拉数据不要再加轮询，用已有的推送（task-stream）；确实要定时的写 interval-ok: 原因`,
}

/** 和基线比：变差了就返回错误 */
export function checkStructure(root) {
  if (!existsSync(capsFile(root)))
    return ['缺少 scripts/structure-caps.json：跑 node scripts/structure-check.mjs --update 生成']
  const caps = JSON.parse(readFileSync(capsFile(root), 'utf8'))
  const m = measure(root)
  const errors = m.unreadable.map(
    (f) =>
      `${f}：结构检查配不上这个文件的括号（多半是字符串、正则或 JSX 文字里的符号让 scripts/lib/code-scan.mjs 认错了），修那个扫描器，别绕开`,
  )
  for (const [k, len] of Object.entries(m.functions)) {
    const cap = caps.functions[k]
    if (cap === undefined)
      errors.push(
        `${k}：函数 ${len} 行，超过 ${FN_MAX} 行。按阶段拆成独立函数，共享的变量收进显式的上下文对象传进去，不要再写大闭包（docs/lessons/structure.md）`,
      )
    else if (len > cap)
      errors.push(
        `${k}：函数 ${len} 行，超过基线 ${cap}。新逻辑写成独立函数放进别的文件，这里只留调用（docs/lessons/structure.md）`,
      )
  }
  for (const dir of FLAT_DIRS)
    for (const f of m.flatFiles[dir])
      if (!caps.flatFiles[dir]?.includes(f))
        errors.push(
          `${dir}/${f}：${dir}/ 顶层不再加新文件。放进所属模块的子目录（没有就按 docs/MODULE-MAP.md 的模块新建一个，比如 ${dir}/<模块>/）`,
        )
  if (m.taskFields > caps.taskFields)
    errors.push(
      `shared/schema.ts 的 TaskData 顶层字段 ${m.taskFields} 个（基线 ${caps.taskFields}）。新字段放进所属功能的子对象；只在运行时算、不存盘的状态不要加到 Task 上（docs/lessons/structure.md）`,
    )
  if (m.preprocess > caps.preprocess)
    errors.push(
      `z.preprocess ${m.preprocess} 处（基线 ${caps.preprocess}）。不要再往 schema 里挂读一次迁一次的迁移，迁移写成一次性的、迁完写回磁盘（docs/lessons/structure.md）`,
    )
  if (m.orchInlineTools > caps.orchInlineTools)
    errors.push(
      `server/orch-mcp.ts 里直接写的工具定义 ${m.orchInlineTools} 个（基线 ${caps.orchInlineTools}）。新工具一个文件：导出定义、给不给的条件、用法说明和处理函数（参照 server/end-turn-tool.ts），orch-mcp.ts 只接线`,
    )
  for (const [name, n] of Object.entries(m.hostMembers)) {
    const cap = caps.hostMembers[name] ?? HOST_NEW_MAX
    if (n > cap)
      errors.push(
        `${name} 有 ${n} 个成员（基线 ${cap}）。EngineHost / Orchestra 只是 shared/host/ 里小接口的组合：新能力加进对应的小接口，小接口满了按能力再拆一个，不要再往大接口上加`,
      )
  }
  for (const [key, msg] of Object.entries(CAPPED_MAPS))
    for (const [f, n] of Object.entries(m[key])) {
      const cap = caps[key][f] ?? 0
      if (n > cap) errors.push(msg(f, n, cap))
    }
  return errors
}

/** 收紧基线：只降不升，没了的项删掉；基线文件不存在时按现状生成 */
function update(root) {
  const m = measure(root)
  const file = capsFile(root)
  if (!existsSync(file)) {
    const { unreadable: _, ...rest } = m
    const caps = { ...rest, functions: Object.fromEntries(Object.entries(m.functions).map(([k, v]) => [k, fnCap(v)])) }
    writeCaps(file, caps)
    return console.log('已按现状生成 scripts/structure-caps.json')
  }
  const caps = JSON.parse(readFileSync(file, 'utf8'))
  const shrink = (old, cur, fn = (x) => x) =>
    Object.fromEntries(
      Object.entries(old).flatMap(([k, v]) => (cur[k] === undefined ? [] : [[k, Math.min(v, fn(cur[k]))]])),
    )
  caps.functions = shrink(caps.functions, m.functions, fnCap)
  for (const dir of FLAT_DIRS)
    caps.flatFiles[dir] = (caps.flatFiles[dir] ?? []).filter((f) => m.flatFiles[dir].includes(f))
  caps.taskFields = Math.min(caps.taskFields, m.taskFields)
  caps.preprocess = Math.min(caps.preprocess, m.preprocess)
  caps.orchInlineTools = Math.min(caps.orchInlineTools, m.orchInlineTools)
  // 新开的小接口按现状记进基线（检查时没记过的按 HOST_NEW_MAX 放行）；记过的只降不升
  caps.hostMembers = {
    ...Object.fromEntries(Object.entries(m.hostMembers).filter(([k]) => !(k in caps.hostMembers))),
    ...shrink(caps.hostMembers, m.hostMembers),
  }
  for (const key of Object.keys(CAPPED_MAPS)) caps[key] = shrink(caps[key], m[key])
  writeCaps(file, caps)
  console.log('基线已收紧到现状')
}

function writeCaps(file, caps) {
  const out = {
    _说明:
      '代码结构只许变好：超过这里的数字 npm run lint 会失败。见 scripts/structure-check.mjs、docs/lessons/structure.md',
    ...caps,
  }
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (process.argv.includes('--update')) update(root)
  else {
    const m = measure(root)
    const caps = existsSync(capsFile(root)) ? JSON.parse(readFileSync(capsFile(root), 'utf8')) : {}
    for (const [k, v] of Object.entries(m.functions).sort((a, b) => b[1] - a[1]))
      console.log(`${String(v).padStart(5)} / ${caps.functions?.[k] ?? '-'}  ${k}`)
    console.log(
      `TaskData 字段 ${m.taskFields} / ${caps.taskFields ?? '-'}，z.preprocess ${m.preprocess} / ${caps.preprocess ?? '-'}`,
    )
    console.log(
      `orch-mcp 内联工具 ${m.orchInlineTools} / ${caps.orchInlineTools ?? '-'}，接口成员 ${JSON.stringify(m.hostMembers)}`,
    )
    for (const key of Object.keys(CAPPED_MAPS))
      console.log(
        `${key}：${Object.values(m[key]).reduce((a, b) => a + b, 0)} 处，${Object.keys(m[key]).length} 个文件`,
      )
    const errors = checkStructure(root)
    console.log(errors.length ? `\n${errors.join('\n')}` : '\n结构检查通过')
  }
}
