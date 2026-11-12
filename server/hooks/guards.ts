import { fmtDuration } from '../../shared/duration.ts'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { Project, Task } from '../../shared/schema.ts'
import { FULL_SUITE_COMMAND } from '../../shared/schema.ts'
import type { HookFacts } from '../../shared/hooks.ts'
import { globMatch } from '../../shared/hook-defs.ts'
import { pluginTestSteps } from '../../shared/plugins/contrib.ts'
import { classifySegment, runSegments } from '../../shared/command-scope.ts'
import { isUeBuildCommand } from '../../shared/test-steps.ts'
import { fullScanStarts } from '../../shared/wide-search.ts'
import { latestDiagnosis } from '../../shared/bug-diagnosis.ts'
import { outOfPlan, cleaning, editScope, revOf } from '../../shared/bug-phase.ts'
import { inPlaceBugClosed } from '../../shared/bug-in-place.ts'
import { ASK_PUSH } from '../../shared/push-auth.ts'
import { DATA_DIR } from '../store.ts'
import { SECRET_RES } from './validate.ts'
import { scratchPath } from '../exec/file-events.ts'

/**
 * 内置的工具前守卫（ADR 0049 第四期）：把只写在提示词里、或者要等收尾才查的规则，在工具执行前就拦下来。
 * 每个守卫只看结构化的事实（工具类别、命令、文件路径、任务和项目的状态），不读模型回复的文字；
 * 拦住时返回交给模型的原因（发给 Agent 的提示词，不翻译），放行返回空串。纯函数，单测直接调用
 */
export interface GuardCtx {
  task: Pick<Task, 'id' | 'parentTaskId' | 'projectId' | 'bug' | 'remotePush' | 'worktree' | 'testSteps'>
  project: (Pick<Project, 'path' | 'gitPolicy' | 'testSteps'> & Partial<Pick<Project, 'pluginStepsOff'>>) | null
  cwd: string
  /** 子任务、工作流节点这类辅助调用（不是对话本身） */
  helper: boolean
  /** 这一轮能用面板的后台命令（run_background） */
  canBackground: boolean
  /** 这个守卫在设置里配的参数（列表一行一项） */
  list: (key: string) => string[]
  /** 这一段命令在这个项目里上次在前台跑了多久（超过一分钟才有，server/command-times.ts） */
  slowKnown?: (seg: string) => number | undefined
}

const inside = (dir: string, p: string) => {
  const r = path.relative(path.resolve(dir), path.resolve(p))
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}
// heredoc / here-string 的正文是要写进文件的内容，不是命令：去掉再拆段（command-scope.ts）
const segs = (facts: HookFacts) =>
  facts.tool?.kind === 'shell' ? runSegments(String(facts.tool.input.command ?? '')) : []
const editPaths = (facts: HookFacts) =>
  facts.tool?.kind === 'edit' ? (facts.tool.paths.length ? facts.tool.paths : [facts.tool.path]).filter(Boolean) : []
/** 子对话在自己的独立分支（worktree）里 */
const inWorktree = (c: GuardCtx) => !!c.task.parentTaskId && c.task.worktree?.state === 'active'

/** git 子命令：允许中间夹着 -C 目录、-c 配置这类全局参数 */
const gitSub = (seg: string, sub: string) => new RegExp(`^git(?:\\s+-[cC]\\s+\\S+)*\\s+${sub}\\b`).test(seg)

/**
 * 推送授权：项目设置「第一次推送时问一次」时，没在授权卡上同意过就推，以前只靠提示词让它先调 ask_push；
 * 「不推送」和子对话的独立分支虽然有 git 配置兜底（server/exec/no-push.ts），报错是看不懂的协议错误，模型会换着法子再推。
 * 这里在执行前给出明确的原因
 */
export function pushDeny(c: GuardCtx, facts: HookFacts): string {
  const hit = segs(facts).find((s) => gitSub(s, 'push') || /^gh\s+pr\s+merge\b/.test(s))
  if (!hit || !c.task.projectId || !c.project) return ''
  if (c.task.parentTaskId || c.helper)
    return '【面板】推送和合并主干只由项目里的父对话做：你把改动交回（子对话调用 submit_merge，子任务写进结果），不要 push、不要合并 PR。'
  if (c.project.gitPolicy === 'deny')
    return '【面板】项目设置是「不推送，只做本地提交」：不要 push、不建 PR、不合并主干。用户要推送时，告诉他先到项目设置把「推送到远端」改掉。'
  if (c.task.remotePush === 'denied')
    return `【面板】这个对话里用户拒绝过推送：不要推。用户之后明确要求推送时，先调用 ${ASK_PUSH} 请他在授权卡上确认。`
  if (c.project.gitPolicy !== 'allow' && c.task.remotePush !== 'allowed')
    return `【面板】还没拿到推送授权：先调用面板工具 ${ASK_PUSH} 请用户授权（面板会弹出「允许 / 拒绝」卡片），同意后再推。不要用提问工具问。`
  return ''
}

/**
 * Bug 先诊断：父对话派来的 Bug 要先交诊断、用户确认方案才能改。以前只在 submit_merge 时查（diagnosisGate），
 * 模型常常已经改了一大堆再被打回。这里在改文件前查：还没确认就改、改到方案以外的文件都拒绝（测试文件这类不限）
 */
export function bugDeny(c: GuardCtx, facts: HookFacts): string {
  // 普通对话里就地查的 Bug 结束了：对话照常用，不再按诊断阶段拦（shared/bug-in-place.ts）
  if (c.task.bug?.kind !== 'report' || inPlaceBugClosed(c.task)) return ''
  // 取消修复后删临时日志：要一处一处删，不整文件还原（实跑时它用 git checkout -- 文件 还原，
  // 共用目录里会把文件里别的改动一起冲掉，用户 2026-11-10 定由 Agent 删、连空行一起删）
  if (cleaning(latestDiagnosis(c.task)) && segs(facts).some(wholeFileRevert))
    return '【面板】这一步要用改文件工具一处一处删临时日志（连加日志时带进来的空行），不整文件还原：文件里可能还有别的改动。'
  // 面板给的临时目录、数据目录里的文件（编译脚本、日志副本）不是项目代码，不按方案拦（file-events.ts 也不记成改动）
  const raw = editPaths(facts)
  const files = raw.filter((p) => !scratchPath(path.resolve(c.cwd, p), c.cwd)).map((p) => rel(c.cwd, p) || p)
  // 插件的改文件类工具算不出要改哪些文件时没有路径：方案没确认前照样不许改，确认后没法按文件核对，放行
  const unknown = facts.tool?.kind === 'edit' && !raw.length
  if (!files.length && !unknown) return ''
  // 按阶段算能改哪些文件（bug-phase.ts）：同意加日志只放行日志计划里的文件，确认方案后放行方案里的文件和加过日志的文件
  const scope = editScope(c.task.bug?.diagnoses ?? [])
  if ('deny' in scope) return `【面板】${scope.deny}`
  if (unknown) return ''
  const extra = outOfPlan(files, scope.files)
  if (extra.length) {
    const d = latestDiagnosis(c.task)
    return `【面板】${extra.join('、')} 不在用户同意的范围（第 ${d ? revOf(d) : ''} 版）里：确实要改，先重新交报告写明为什么，等用户确认。`
  }
  return ''
}

/** 整文件还原的命令：git checkout -- 文件、git restore 文件、p4 revert、svn revert */
const wholeFileRevert = (seg: string) =>
  (gitSub(seg, 'checkout') && /\s--\s/.test(seg)) || gitSub(seg, 'restore') || /^(p4|svn)\s+revert\b/.test(seg)

const rel = (cwd: string, p: string) => {
  const r = path.relative(cwd, path.resolve(cwd, p))
  return r.startsWith('..') || path.isAbsolute(r) ? '' : r.replace(/\\/g, '/')
}

/**
 * 危险命令：对话常开「跳过所有确认」，误删目录、强推、清掉工作区没有任何兜底。只拦明确不可挽回的几类：
 * 递归删除根目录、家目录、项目根（或它的上级）、面板数据目录；原分支上 reset --hard / clean / 整目录 checkout；强推；删主干分支。
 * 子对话自己的独立分支里，reset / clean / checkout 放行（那是它自己的副本）
 */
export function dangerDeny(c: GuardCtx, facts: HookFacts): string {
  for (const s of segs(facts)) {
    const why = dangerOf(c, s)
    if (why)
      return `【面板】这条命令${why}，面板拦下了：${s.slice(0, 120)}。换一个只影响具体文件的做法；确实需要，说明原因请用户自己执行。`
  }
  return ''
}

const MAIN_BRANCHES = /^(main|master|trunk)$/

function dangerOf(c: GuardCtx, s: string): string {
  const extra = c.list('extra').find((x) => x && s.startsWith(x))
  if (extra) return `在设置里列为危险命令（${extra}）`
  const words = s.split(/\s+/)
  if (words[0] === 'rm' || (words[0] === 'sudo' && words[1] === 'rm')) {
    const args = words.slice(words[0] === 'sudo' ? 2 : 1)
    const flags = args.filter((a) => a.startsWith('-')).join('')
    const recursive = /-[a-zA-Z]*r|--recursive/i.test(flags)
    if (!recursive) return ''
    const home = homedir()
    const project = c.project?.path || c.cwd
    for (const raw of args.filter((a) => !a.startsWith('-'))) {
      const a = raw.replace(/^["']|["']$/g, '')
      if (/^(\/|\/\*|~|~\/|~\/\*|\$HOME\/?|\*|\.\/?\*?)$/.test(a)) return '会递归删除整个目录'
      const p = path.resolve(c.cwd, a.replace(/^~(?=\/|$)/, home))
      if (p === path.parse(p).root || p === home) return '会递归删除根目录或家目录'
      if (inside(p, project) || inside(p, c.cwd)) return '会递归删除整个项目（或它的上级目录）'
      if (inside(p, DATA_DIR) || inside(DATA_DIR, p)) return '会删除面板的数据目录'
    }
    return ''
  }
  if (gitSub(s, 'push') && /\s(--force\b|-f\b|--force-with-lease\b|\+\S)/.test(s)) return '是强制推送，会覆盖远端的提交'
  if (gitSub(s, 'branch') && /\s-D\s+(\S+)/.test(s) && MAIN_BRANCHES.test(/\s-D\s+(\S+)/.exec(s)![1]))
    return '会删除主干分支'
  if (inWorktree(c)) return ''
  if (gitSub(s, 'reset') && /\s--hard\b/.test(s)) return '会丢掉工作区里所有没提交的改动（可能有用户的）'
  if (gitSub(s, 'clean') && /\s-[a-zA-Z]*f/.test(s)) {
    // 点名了具体路径的只清那几处，放行；不带路径或者路径是整个目录才拦
    const paths = s
      .split(/\s+/)
      .slice(1)
      .filter((w) => w !== 'clean' && !w.startsWith('-') && w !== '--')
    if (!paths.length || paths.some((x) => x === '.' || x === './' || x === '*'))
      return '会删掉所有没跟踪的文件（可能有用户的）'
  }
  if ((gitSub(s, 'checkout') || gitSub(s, 'restore')) && /\s(--\s+)?\.(\s|$)/.test(s))
    return '会撤销整个工作区的改动（可能有用户的）'
  return ''
}

/**
 * 长命令转后台：完整测试、端到端、界面检查、开发服务器、UE 编译打包和整份装依赖（command-scope.ts 的 heavySegment）放在前台跑，用户执行中发来的消息要等它跑完才处理，
 * 对话看起来就是卡住（用户 2026-10-27 纠正过，docs/lessons/tooling.md）。这一轮有 run_background 时拒绝并说明用它。
 * 以前按段里的字样匹配，写文件的 heredoc 正文、commit 说明、grep 的参数里有 e2e 也被拦下、让它改用后台命令，
 * 结果写文件、查文件都跑去了后台（用户 2026-11-05 报）：现在只看段开头真正运行的程序
 */
export function longDeny(c: GuardCtx, facts: HookFacts): string {
  if (!c.canBackground) return ''
  const extra = c.list('extra').filter(Boolean)
  const slow = slowStep(c, facts)
  if (slow)
    return `【面板】${slow.command.slice(0, 80)} 是项目测试步骤「${slow.name}」（要编译、跑得久），放在前台会撞上命令的超时、整段输出也会进上下文：用面板工具 run_background 交给后台跑（带上计划步骤），跑完只推回错误、警告和结尾，完整日志存文件；交出去后做不依赖它的事，没有别的事就结束这一轮等结果。`
  for (const s of segs(facts)) {
    // 只看真正在跑的程序：cat、grep、git commit 这类快命令的参数里出现 e2e、--watch 不算；判定统一在 command-scope.ts 的 classifySegment
    const k = classifySegment(s, { extra, suite: FULL_SUITE_COMMAND, slowMs: c.slowKnown })
    const head = `【面板】${s.slice(0, 80)}`
    const hand =
      '用面板工具 run_background 交给后台跑（带上计划步骤），跑完只推回错误、警告和结尾；交出去后做不依赖它的事，没有别的事就结束这一轮等结果。'
    if (k.kind === 'service')
      return `${head} 不会自己结束，放在前台会一直挡着对话：用面板工具 run_background 在后台跑（service 设为 true），用 check_background 看它的输出确认起来了。`
    // UE 编译交给 run_background 时面板按编译目录占位排队（子对话的转成向父对话的申请），说法要和后台那边一致
    if (k.kind === 'heavy' && isUeBuildCommand(s))
      return `${head} 是 UE 编译，放在前台会撞上命令的超时被杀掉、整份日志也会进上下文：${hand}面板会按编译目录占位排队（子对话交来的会转成向父对话的编译申请），不用另找别的路。`
    if (k.kind === 'heavy')
      return `${head} 是要跑几分钟的编译、打包或装依赖，放在前台会撞上命令的超时被杀掉、也挡着对话：${hand}`
    if (k.kind === 'slow')
      return `${head} 在这个项目里上次跑了 ${fmtDuration(k.ms ?? 0)}，放在前台会挡着对话、还可能撞上命令的超时被杀掉：${hand}`
    if (k.kind === 'suite') return `${head} 是要跑很久的完整检查：${hand}`
  }
  return wideSearchDeny(c, facts)
}

/**
 * 项目测试步骤里慢的那些（工作包 I：编译命令默认进长命令守卫）：标了「合并时编译」或超时设到 3 分钟以上、
 * 又没标「小改动也跑」的步骤，是项目自己说了要编译、跑得久的命令。命令原文出现在这次命令里就算
 */
function slowStep(c: GuardCtx, facts: HookFacts) {
  if (facts.tool?.kind !== 'shell') return undefined
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim()
  const cmd = norm(String(facts.tool.input.command ?? ''))
  const steps = c.project?.testSteps.length ? c.project.testSteps : c.task.testSteps
  return steps.find(
    (x) =>
      x.enabled && !x.quick && (x.merge || x.timeoutSec >= 180) && x.command.trim() && cmd.includes(norm(x.command)),
  )
}

/**
 * 全项目全文搜索转后台：grep -r、findstr /s 这类从项目根起的递归搜索不跳过编译产物和缓存目录，大项目要扫几分钟
 * （用户 2026-11-07 报前台 grep -rl 整个 UE 项目跑了 2 分钟，shared/wide-search.ts）。起点是项目根或更上层时拒绝，
 * 让它放后台、或换成已经配好排除目录的 rg 并限定子目录；起点是子目录的照常放行
 */
function wideSearchDeny(c: GuardCtx, facts: HookFacts): string {
  if (facts.tool?.kind !== 'shell') return ''
  const cmd = String(facts.tool.input.command ?? '')
  const roots = [c.cwd, c.project?.path].filter((x): x is string => !!x)
  const wide = fullScanStarts(cmd).some((s) => roots.some((r) => inside(path.resolve(c.cwd, s), r)))
  if (!wide) return ''
  return `【面板】${cmd.trim().split('\n')[0].slice(0, 80)} 会把整个项目（连编译产物、缓存目录）逐个文件读一遍，大项目要跑几分钟，放在前台会一直挡着对话：确实要扫全项目就用面板工具 run_background 放后台跑（跑完结果推回来，交出去后做不依赖它的事）；只是找个东西就改用 rg（它跳过 .gitignore 和项目设置里的排除目录）并限定到具体子目录，几秒就完。`
}

/**
 * 测试步骤归属：项目里标了「禁止子对话执行」（scope = parent）的步骤，合回后由父对话跑（ADR 0018）。
 * 子对话在自己的独立分支里跑这些命令时拒绝；共用目录的子对话没有「合回后父对话代跑」，照常自己跑
 */
export function testScopeDeny(c: GuardCtx, facts: HookFacts): string {
  if (!inWorktree(c)) return ''
  const own = c.project?.testSteps.length ? c.project.testSteps : c.task.testSteps
  const steps = [...own, ...(c.project ? pluginTestSteps(c.project) : [])].filter(
    (x) => x.enabled && x.scope === 'parent' && x.command.trim(),
  )
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim()
  for (const s of segs(facts)) {
    const hit = steps.find((x) => norm(s).includes(norm(x.command)))
    if (hit)
      return `【面板】测试步骤「${hit.name}」在项目里设成了合回后由父对话跑，子对话不跑：在 submit_merge 的 tests 里写清你跑了哪些快速检查，父对话合回后会跑它。`
  }
  return ''
}

/** 凭据可以写进去的文件（本机的环境变量文件，一般不进仓库）：设置里可以再加 */
const SECRET_OK = ['.env', '.env.*', '**/.env', '**/.env.*']

/**
 * 凭据守卫：密码、令牌、API key 不进项目文件（AGENTS.md 的硬规则，面板管的其他项目同样适用）。
 * 改文件时扫写进去的内容，shell 命令只在往文件里写（>、tee）时扫；本机的 .env 这类文件放行
 */
export function secretDeny(c: GuardCtx, facts: HookFacts): string {
  const tool = facts.tool
  if (!tool) return ''
  const ok = [...SECRET_OK, ...c.list('allow')].filter(Boolean)
  let text = ''
  if (tool.kind === 'edit') {
    const files = editPaths(facts).map((p) => rel(c.cwd, p) || p.replace(/\\/g, '/'))
    if (files.length && files.every((f) => ok.some((g) => globMatch(g, f)))) return ''
    text = Object.values(tool.input)
      .filter((v): v is string => typeof v === 'string')
      .join('\n')
  } else if (tool.kind === 'shell') {
    const cmd = String(tool.input.command ?? '')
    if (!/>|\btee\b/.test(cmd)) return ''
    text = cmd
  }
  if (!SECRET_RES.some((re) => re.test(text))) return ''
  return '【面板】要写进去的内容里像是有真实的密钥、令牌或私钥：凭据不进项目文件。改成从环境变量读（示例写 your-api-key 这类占位符）；确实要存，放到本机的 .env 这类不进仓库的文件里。'
}

/**
 * 独立分支越界：子对话在自己的 worktree 里干活，父对话交代里的绝对路径却指向原仓库，照抄就会直接改原分支的文件，
 * 绕过隔离和合并。改的文件不在自己的目录、也不在系统临时目录里就拒绝
 */
export function worktreeDeny(c: GuardCtx, facts: HookFacts): string {
  if (!inWorktree(c)) return ''
  const root = c.task.worktree!.path
  const original = c.project?.path
  // 原仓库里的一律不行（项目本身放在临时目录里时也一样）；其余只许自己的目录和系统临时目录
  const out = editPaths(facts)
    .map((p) => path.resolve(c.cwd, p))
    .find((p) => !inside(root, p) && ((!!original && inside(original, p)) || !inside(tmpdir(), p)))
  if (!out) return ''
  return `【面板】${out} 不在你的独立分支目录（${root}）里：你只改自己目录里的文件，父对话交代里的路径换成你目录下的同一个相对路径再改。`
}
