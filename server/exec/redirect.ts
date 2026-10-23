/**
 * 补充（插话）排着时，什么时候值得为它停下正在执行的命令。
 *
 * 只有「这一批工具跑完才会取补充」的 CLI（Pi 这种）才需要停下命令（见 rpc.redirect）。
 * 原来只要有一条命令超过 8 秒就无条件停，`git worktree list`、`rg` 这种只读命令也被打断重跑：
 * 用户发一条消息，正在读的代码就白读了。只读命令应当等它自然跑完（Pi 跑完这批工具就会取补充），
 * 只有真卡住的才按更长的阈值兜底停下；会改文件、装依赖、跑测试这些命令才按短阈值打断。
 */

/** 会写东西或者会长时间占着前台的命令：按短阈值打断 */
const SHORT_WAIT_HEADS = [
  'sleep',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'node',
  'deno',
  'bun',
  'python',
  'python3',
  'pip',
  'pytest',
  'make',
  'cmake',
  'cargo',
  'go',
  'gh',
  'docker',
  'kubectl',
  'tsc',
  'vite',
  'jest',
  'vitest',
  'playwright',
]

/** 明确只读的命令头：跑完就结束，不会改仓库，也不会一直等外部状态 */
const READ_ONLY_HEADS = [
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'pwd',
  'echo',
  'printf',
  'wc',
  'tree',
  'file',
  'stat',
  'du',
  'df',
  'which',
  'where',
  'type',
  'rg',
  'grep',
  'find',
  'fd',
  'ag',
  'ack',
  'jq',
]

/** 只读的 git 子命令：git 要单独看子命令，`git log` 和 `git commit` 差别太大 */
const READ_ONLY_GIT: { cmd: string; allow: (args: string[]) => boolean }[] = [
  { cmd: 'log', allow: () => true },
  { cmd: 'show', allow: () => true },
  { cmd: 'diff', allow: () => true },
  { cmd: 'status', allow: () => true },
  { cmd: 'blame', allow: () => true },
  { cmd: 'ls-files', allow: () => true },
  { cmd: 'rev-parse', allow: () => true },
  { cmd: 'rev-list', allow: () => true },
  { cmd: 'describe', allow: () => true },
  { cmd: 'shortlog', allow: () => true },
  { cmd: 'show-ref', allow: () => true },
  // git branch -D / git tag v1 / git remote add 都是写操作，只认列出来的只读参数
  {
    cmd: 'branch',
    allow: (args) => args.every((a) => /^(-[arv]+|--list|--all|--remotes|--verbose|--show-current)$/.test(a)),
  },
  { cmd: 'tag', allow: (args) => args.length === 0 || args.every((a) => /^(-l|--list)/.test(a)) },
  {
    cmd: 'remote',
    allow: (args) => args.length === 0 || args.every((a) => /^(-v|--verbose|show)$/.test(a)),
  },
  { cmd: 'config', allow: (args) => args.some((a) => /^(--get|--get-all|--list|-l)/.test(a)) },
  { cmd: 'worktree', allow: (args) => args.length === 0 || args[0] === 'list' },
  { cmd: 'stash', allow: (args) => args[0] === 'list' },
]

/** 这些出现在任何位置都说明命令会写盘或者会派生新的命令，一律不当只读 */
const WRITE_HINTS = ['>', '-delete', '-exec', '-execdir', '--write', '--fix', '--output', '-o ']

/** 命令分段后的每一段都得是只读的：`ls && rm -rf x` 不能算 */
function readOnlyPart(part: string): boolean {
  const text = part.trim().replace(/^[({\s]+/, '')
  if (!text) return false
  if (WRITE_HINTS.some((h) => text.includes(h))) return false
  const words = text.split(/\s+/)
  const head = (words[0] ?? '').toLowerCase()
  if (!head) return false
  // 这些会把真正干的活藏在后面的命令里
  if (['sudo', 'timeout', 'xargs', 'watch', 'env', 'then', 'do'].includes(head)) return false
  if (SHORT_WAIT_HEADS.includes(head)) return false
  const rest = words.slice(1)
  if (head === 'git') {
    const sub = (rest[0] ?? '').toLowerCase()
    const hit = READ_ONLY_GIT.find((x) => x.cmd === sub)
    return hit ? hit.allow(rest.slice(1)) : false
  }
  return READ_ONLY_HEADS.includes(head)
}

/**
 * 这条命令是不是只读的（跑完就结束，不会改文件、不会等外部状态）。
 * 认不出来的一律当不是：宁可打断得早一点，也不要让用户的补充无限期等下去。
 */
export function readOnlyCommand(command: string): boolean {
  const text = command.trim()
  if (!text) return false
  const parts = text.split(/\|\||&&|[;\n|]/)
  if (!parts.length) return false
  return parts.every(readOnlyPart)
}

/** 还在跑的命令：怎么判读、从什么时候开始 */
export interface RunningCommand {
  /** 工具调用的类别：只关心 run（命令） */
  kind: string
  /** 命令原文 */
  label: string
  /** 开始的时间戳（毫秒） */
  startedAt: number
}

/** 两个阈值：普通命令跑这么久就停；只读命令等它自然跑完，卡住了才在这么久之后停 */
export interface RedirectLimits {
  command: number
  readOnly: number
}

/**
 * 补充排着时还要等多久才停下命令，`undefined` 表示不用计时（没有可停的命令）。
 * 返回 0 或负数表示现在就停。
 */
export function redirectWait(commands: RunningCommand[], now: number, limits: RedirectLimits): number | undefined {
  const run = commands.filter((x) => x.kind === 'run')
  if (!run.length) return undefined
  const deadline = Math.min(
    ...run.map((x) => x.startedAt + (readOnlyCommand(x.label) ? limits.readOnly : limits.command)),
  )
  return deadline - now
}
