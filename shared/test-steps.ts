import { TEST_STEP_ENVS, type TaskTestRun, type TestStep } from './schema.ts'
import { t } from './i18n.ts'
import { fmtDuration } from './duration.ts'

/**
 * 项目级测试步骤：项目设置里维护，新建对话时快照进任务，测试 Agent 按它执行。
 * 这里放步骤的默认值、命令的行写法（wsl / powershell / cmd / bash）和交给 CLI 的提示词片段，
 * 前后端共用，界面预览和真实执行看到的一样。
 */

export const ENV_LABEL: Record<TestStep['env'], string> = {
  auto: t('自动'),
  wsl: 'WSL',
  powershell: 'PowerShell',
  cmd: 'cmd',
  bash: 'bash',
}

/**
 * 把一条 glob 转成正则。支持 `**`（跨目录；`**` 后面接斜杠还能匹配零层目录）、`*`、`?`；
 * 以 / 结尾的写法按目录算（`web/` 等于 `web/**`）。没写通配符的也按目录前缀算（`web/src` 等于 `web/src/**`）：
 * 项目教训里的 glob 就是这么写的（`shared/lessons.ts` 的 `web/src` 能匹配 `web/src/App.tsx`），
 * 用户照抄进「适用改动」时不能变成一条永远匹配不上的规则、把步骤静默跳掉。
 * 路径统一用 /，Windows 传来的反斜杠先换掉。
 */
function globToRegExp(glob: string) {
  let g = glob.trim().replace(/\\/g, '/')
  if (!g) return null
  while (g.endsWith('/')) g = g.slice(0, -1)
  // 没有通配符的写法（`web/src`、`web/`）按「精确命中或作为目录前缀」算，两种写法都认
  const plain = !!g && !/[*?]/.test(g)
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        // `**/` 可以匹配零层目录，`**/*.cpp` 才认得出仓库根下的 a.cpp
        if (g[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}${plain ? '(?:/.*)?' : ''}$`, 'i')
}

const GLOB_CACHE = new Map<string, RegExp | null>()

/** 一个改动文件是否匹配这条 glob（相对项目根，两侧都按 / 比） */
export function matchesGlob(file: string, glob: string) {
  const f = file.trim().replace(/\\/g, '/')
  if (!f) return false
  let re = GLOB_CACHE.get(glob)
  if (re === undefined) {
    re = globToRegExp(glob)
    GLOB_CACHE.set(glob, re)
  }
  return !!re?.test(f)
}

/** 这条步骤写了的适用范围（去掉空项）；空数组表示没写，总是执行 */
export function stepGlobs(step: Pick<TestStep, 'appliesTo'>) {
  return (step.appliesTo ?? []).map((g) => g.trim()).filter(Boolean)
}

/**
 * 这条步骤对这批改动适不适用——匹配判定的唯一实现，单测和以后要接进执行流程的代码都走它。
 * 口径是「这次任务实际波及的改动」：自己改的、从远端拉取或合并进来的都算。
 * 两种情况按总是执行：没写适用范围（老项目升级上来的步骤）；改动清单为空——
 * 空清单意味着取不到（没有版本控制、命令失败、不知道基线），未知不等于不相关，宁可多跑不能漏跑。
 */
export function stepApplies(step: Pick<TestStep, 'appliesTo'>, changedFiles: string[]) {
  const globs = stepGlobs(step)
  if (!globs.length || !changedFiles.length) return true
  return changedFiles.some((f) => globs.some((g) => matchesGlob(f, g)))
}

/**
 * 界面上那行文字怎么变回 glob 列表：逗号（中英文都认）和换行分隔，去掉空项。
 * 最多留 30 条（和 schema.ts 里的 .max(30) 同一个上限），超出的丢弃是故意的：
 * 三十条以上说明该拆成多条步骤或直接用一条宽一点的 glob，多了反而看不清哪条命中
 */
export function parseGlobs(text: string) {
  return text
    .split(/[,，\n]/)
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 30)
}

/** 交给 Agent 的「适用改动」一行：没写范围时说明总是执行，免得 Agent 当成条件缺失 */
export function appliesToText(step: Pick<TestStep, 'appliesTo'>) {
  const globs = stepGlobs(step)
  return globs.length ? globs.join('、') : '未设置，总是执行'
}

/**
 * 勾了「禁止子对话执行」的步骤：只对子对话生效——子对话不跑，合回父对话的分支后面板在父对话目录里跑一遍，
 * 结果回传给它（见 ADR 0018）。父对话自己验证时用的是全部启用的步骤（`verifyBlock`），不经过这里。
 * 只取启用的、有命令的；`merge`（合并时编译）不在里面：那条仍由父对话按 ADR 0004 向面板申请编译，
 * 两边都跑会让 UE 编译编两次。
 * 只对 Git 项目的独立分支子对话生效：P4 / SVN / 没有版本控制的子对话没有分支可合，勾了这个字段也不跑这些步骤
 */
export function parentRunSteps(steps: TestStep[]) {
  return steps.filter((s) => s.enabled && s.runInParent && !s.merge && !!s.command.trim())
}

/**
 * 勾了「禁止子对话执行」的步骤在这个对话里由谁跑（ADR 0018）：只对 Git 项目生效。
 * - 有父对话 + 独立分支（真正会合回的那种子对话）→ child：它不跑，合并后由父对话跑。
 * - 顶层父对话 → parent：子对话合并后由面板在它的目录里跑；它自己改代码时没人替它跑，要自己跑（评审 R2）。
 * - 共用目录的子对话、P4 / SVN / 没有版本控制、没有勾这种步骤 → 空：步骤照常由 Agent 自己跑。
 * 顶层对话即使自己开了独立分支也算 parent：它没有父对话，收尾走的是推送 / 分 changelist，没有「合回后父对话跑」这一步。
 */
export function parentRunRoleOf(x: {
  /** 有没有父对话（是不是子对话） */
  child: boolean
  /** 有没有独立分支（还在用 worktree） */
  isolated: boolean
  /** 项目目录是不是 Git 仓库 */
  git: boolean
  steps: TestStep[]
}): 'child' | 'parent' | '' {
  if (!parentRunSteps(x.steps).length) return ''
  if (x.child) return x.isolated ? 'child' : ''
  return x.git ? 'parent' : ''
}

/** 比对命令时忽略空白差异：后台命令原文和步骤里的写法常常只差几个空格 */
const normCommand = (s: string) => s.trim().replace(/\s+/g, ' ')

/**
 * 一条后台命令对的是项目里的哪条测试步骤：返回 None 表示不是测试步骤（Agent 自己拼的查看命令不动它）。
 * 两种写法都认：步骤里的命令原文，以及按环境拼出来的整行（wsl / powershell 包了一层的）。
 * 耗时记录只靠这个匹配，不靠 Agent 自报：它自己跑的和父对话跑的都从后台命令的真实起止时间算
 */
export function matchTestStep(steps: TestStep[], command: string, platform: string, wslDistro = '') {
  const want = normCommand(command)
  if (!want) return undefined
  return steps.find(
    (s) =>
      s.enabled &&
      !!s.command.trim() &&
      (normCommand(s.command) === want || normCommand(stepCommand(s, platform, wslDistro)) === want),
  )
}

/**
 * 记一次测试步骤的耗时：同一条步骤 + 同一个执行方只留最后一次，tries 累加。
 * 选择「按最后一次算」而不是分行列出每次：收尾总结只要一表一行，失败重跑的那几次只会让表变长，
 * 而失败本身已经写在结果（ok: false）和 tries 里了
 */
export function mergeTestRun(runs: TaskTestRun[], next: Omit<TaskTestRun, 'tries'>): TaskTestRun[] {
  const i = runs.findIndex((r) => r.stepId === next.stepId && r.stepName === next.stepName && r.by === next.by)
  if (i < 0) return [...runs, { ...next, tries: 1 }]
  return runs.map((r, j) => (j === i ? { ...next, tries: r.tries + 1 } : r))
}

/** 谁跑的：收尾总结里要能看出哪些步骤是父对话跑的 */
export function testRunByText(by: TaskTestRun['by']) {
  return by === 'parent' ? t('父对话') : t('自己')
}

/**
 * 推给子对话（和写进提示词）的耗时统计：一行一步，只写步骤名、谁跑的、结果、耗时，
 * 不贴命令原文、不复述输出。子对话收尾总结里的那张表按它写，不靠模型自己编数字
 */
export function testRunLines(runs: TaskTestRun[]) {
  return runs.map(
    (r) =>
      `- ${r.stepName}：${testRunByText(r.by)}跑，${r.ok ? t('通过') : t('失败')}，${fmtDuration(r.durationMs)}${r.tries > 1 ? t('（第 {n} 次，按最后一次算）', { n: r.tries }) : ''}`,
  )
}

/**
 * 收尾总结里的「编译 / 测试耗时」要求：子对话和执行角色的提示词都用这一段，说法只留一处。
 * 要求带执行方是这次新功能的一部分：同一条步骤可能是父对话跑的，不能让人误以为子对话自己跑过
 */
export const TEST_TIME_SUMMARY_RULE = `## 收尾总结里的编译 / 测试耗时
收尾总结里必须有一份「编译 / 测试耗时」：逐行写步骤名（用项目测试步骤里的名字）、谁跑的（父对话 / 自己）、结果（通过 / 失败 / 跳过）、耗时（例如 \`1m 34s\`），几步就几行：
- 结果里带了耗时统计（面板按后台命令的真实起止时间记的）时就照它写，不自己换算、不取整成整数。
- 自己跑过的步骤看后台命令结果里的用时；没跑、或者结果里没有用时的写「未记录」，不要编数字，也不要按印象估。
- 只写真正跑过的步骤，不贴命令原文、不复述输出；总共几十秒的步骤也照实写，不要省。`

/** 平台判断用的关键词：任务快照里存 process.platform，界面上的判断也按它 */
export const isWindows = (platform: string) => /^win/i.test(platform)

const DEFAULT_WSL = 'Ubuntu-24.04'

/**
 * 一条步骤实际要跑的命令行。
 * wsl 在非 Windows 上只能按 bash 跑（没有 WSL），这时写明降级，避免假装在 WSL 里跑过。
 */
export function stepCommand(step: Pick<TestStep, 'command' | 'env'>, platform: string, wslDistro = '') {
  const platformWin = isWindows(platform)
  const cmd = step.command.trim()
  if (step.env === 'wsl') {
    if (!platformWin) return `bash -lc ${quote(cmd)}`
    return `wsl.exe -d ${wslDistro.trim() || DEFAULT_WSL} -- bash -lc ${quote(cmd)}`
  }
  if (step.env === 'powershell')
    return platformWin ? `powershell -NoProfile -Command ${quote(cmd)}` : `pwsh -NoProfile -Command ${quote(cmd)}`
  if (step.env === 'cmd') return platformWin ? `cmd.exe /d /c ${quote(cmd)}` : cmd
  if (step.env === 'bash') return `bash -lc ${quote(cmd)}`
  return cmd
}

/** 传进 shell 的一整段命令用双引号包住；里面的双引号和反斜杠转义 */
function quote(s: string) {
  return `"${s.replace(/(["\\$])/g, '\\$1')}"`
}

/** 步骤的环境说明：wsl 在非 Windows 上会降级，提示词里要说清楚 */
export function envNote(step: Pick<TestStep, 'env'>, platform: string) {
  if (step.env === 'wsl' && !isWindows(platform))
    return t('这条标了 WSL，但当前不是 Windows，只能按 bash 执行；执行不了就登记为延期验证')
  if (step.env === 'wsl') return t('在 WSL 里执行，不要直接在本机的 PowerShell / cmd 里跑')
  if (step.env === 'auto') return t('按项目所在系统和命令自己选择执行环境')
  return ''
}

/** 交给 CLI 的测试步骤原文：名称、环境、命令、工作目录、条件和说明都写清楚 */
export function testStepsText(
  steps: TestStep[],
  platform: string,
  wslDistro = '',
  /** 这一份是给谁看的（见 ADR 0018）：子对话不跑标了「禁止子对话执行」的步骤，父对话由面板自动跑 */
  parentRun: 'child' | 'parent' | '' = '',
) {
  return steps
    .map((s, i) => {
      // 只有这类步骤真的生效的场合才标「禁止子对话执行」：非 Git 项目、共用目录的子对话、工作流节点里
      // 没人代它跑，标出来只会让 Agent 跳过没人跑的步骤
      const inParent = !!s.runInParent && !s.merge && !!parentRun
      const lines = [
        `${i + 1}. ${s.name}（${ENV_LABEL[s.env]}${s.quick ? '，快速' : ''}${s.merge ? t('，合并时编译') : ''}${inParent ? t('，禁止子对话执行') : ''}${s.enabled ? '' : t('，已停用')}）`,
        `   - 命令：${stepCommand(s, platform, wslDistro)}`,
      ]
      // 由父对话跑的步骤只有这一处说清「谁跑」：两边看到的是同一份步骤，说法必须一致
      if (inParent && parentRun === 'child') lines.push(`   - 由谁执行：父对话（合并后自动跑，结果回传给你；你不要跑）`)
      if (inParent && parentRun === 'parent')
        lines.push(
          `   - 由谁执行：子对话合并后由面板在你的目录里自动跑（结果直接回传子对话）；你自己改代码时没人替你跑，要自己执行`,
        )
      if (s.cwd) lines.push(`   - 工作目录：${s.cwd}（相对项目根）`)
      lines.push(`   - 适用改动（清单里一个都不匹配就跳过这一步）：${appliesToText(s)}`)
      if (s.when) lines.push(`   - 补充说明：${s.when}`)
      if (s.timeoutSec) lines.push(`   - 超时：${fmtDuration(s.timeoutSec * 1000)}`)
      if (s.note) lines.push(`   - 说明：${s.note}`)
      const note = envNote(s, platform)
      if (note) lines.push(`   - 环境：${note}`)
      return lines.join('\n')
    })
    .join('\n')
}

/**
 * 改动清单怎么取、怎么筛步骤：提示词里唯一的一份，testStepsBlock 和 verifyBlock 都用它。
 * 口径是「这次任务实际波及的改动」——自己改的、从远端拉取或合并进来的都算；
 * 只按自己的提交判断的话，合并进来的 C++ 改动会被漏掉，编译该跑却没跑。
 */
export const CHANGED_FILES_RULE = `先取本次实际改了什么，再决定跑哪几条（不要为了保险全部跑一遍）：
0. 先看这次要跑的范围：范围是「整体」，或者任务说明要求「全跑一遍」「发布前验证」「整体验收」「依赖升级后确认步骤」时，**不按改动清单筛**——按步骤顺序全部执行，跳过的只能因为环境跑不了（比如需要 Editor、需要别的系统），不能写「本次没改 X」当理由；发布前验证、整体验收这类节点存在的意义就是不筛。范围是「本次改动」时才按下面的清单筛。
1. 改动清单是「任务起点 → 当前 HEAD」的完整变更，不是只看自己的那几个提交：Git 用「git diff --name-only <任务基线>...HEAD」（三点比较，含合并进来的内容），再补上「git status --short」里的工作区改动。任务基线就是任务开始时的 HEAD（开工时记下的 git rev-parse HEAD）；拿不到就退回「git diff --name-only $(git merge-base HEAD <主分支>)..HEAD」。Perforce 用「p4 opened」加上「p4 diff」里本次涉及的文件；其它版本控制按项目自己的约定。
2. 拉取或合并远端更新后，按合并后的改动清单重新判断：合并进来的文件也算本次改动，涉及的步骤要正常执行，不能以「这部分不是我改的」为理由跳过。
   例：自己只改了文档、但从远端合并进来 C++ 改动 → 编译照跑；自己改了 C++、合并进来的是文档 → 编译照跑；两边都只有文档 → 才可以跳过并写原因。
3. 取不到改动清单时（项目没有版本控制、命令失败、不知道任务基线）按总是执行：清单未知不等于不相关，这种情况宁可多跑也不能漏跑，并在结论里说明这次为什么没筛。
4. 一条步骤的「适用改动」和这份清单完全不匹配才跳过；跳过的写一行：「跳过：<步骤名> — 本次及合并进来的改动都没有 <这类文件>（实际改的是 <改了什么>）」。所有步骤都跳过时写「本次改动不涉及配置的测试步骤 — 本次改的是 …」，不能不吭声。
5. 没写「适用改动」的步骤表示总是执行（老项目升级上来的步骤）。
6. 名字后面标了「合并时编译」的步骤被选中时，同一时间仍然只编译一次：等它结束再跑下一条。`

/**
 * 注入工作流说明后面的项目测试步骤。没有配置时给出兜底：让 Agent 自己找命令，并在结果里建议配置。
 * 提示词里先教怎么按改动清单筛，再列步骤：不筛的话 Agent 会为了保险全部跑一遍。
 * 新建对话时写进任务快照，之后改项目设置不影响已经开始的任务。
 */
export function testStepsBlock(steps: TestStep[], platform: string, wslDistro = '') {
  const active = steps.filter((s) => s.enabled)
  const head = `## 项目测试步骤
当前系统：${platform || '未知'}。这些步骤由项目设置维护。**不要无脑全跑**：先看这次要跑的范围（下面的第 0 条）和实际改了什么，再决定跑哪几条。`
  if (active.length)
    return `${head}\n\n${CHANGED_FILES_RULE}\n\n步骤（每条写了「适用改动」：相对项目根的 glob，改动清单里一个都不匹配就跳过）：\n${testStepsText(active, platform, wslDistro)}`
  const off = steps.filter((s) => !s.enabled)
  if (off.length)
    return `${head}\n项目里配置的步骤都已停用（${off.map((s) => s.name).join(t('、'))}）。先按下面的兜底方式找命令，并在结果里建议用户启用或补充步骤。`
  return `${head}
项目还没有配置测试步骤。按下面的顺序自己找命令，找不到就报告缺口，不要编命令：
1. package.json 的 scripts、Makefile、CI 配置、README 里的测试说明
2. 按项目技术栈的常用命令（npm run build / cargo test / go test ./... / dotnet test 等）
结果里写清楚「项目没有配置测试步骤，建议在项目设置里补上：名称 + 命令 + 环境」。`
}

/**
 * 对话里怎么验证：按改动大小定范围（参照 Claude Code 的做法，小改动跑完快速检查就收尾）。
 * 只给对话用，工作流里的测试验收节点照常跑完整步骤：走工作流本身就说明改动不小
 */
export function verifyBlock(
  steps: TestStep[],
  o: { platform: string; wslDistro?: string; scaled: boolean; parentRun?: 'child' | 'parent' },
) {
  const active = steps.filter((s) => s.enabled)
  const quick = active.filter((s) => s.quick)
  // 关掉时不分大小，「快速」标记没有意义，不写出来免得 Agent 只跑这几条
  const shown = o.scaled ? active : active.map((s) => ({ ...s, quick: false }))
  const inParent = parentRunSteps(active)
  const parentNote = inParent.length
    ? o.parentRun === 'child'
      ? `\n这些步骤标了「禁止子对话执行」：${inParent.map((s) => `「${s.name}」`).join('、')}。你不要跑它们（跑了也不算数，父对话会重新跑），也不要在结果里写跑过；合并后面板由父对话跑，结果回传给你。你的完成条件是「改动已合回父对话所在的分支 + 父对话测试通过」；父对话测试失败时面板会把报错原文推回来，按它修好再调用 submit_merge。`
      : o.parentRun === 'parent'
        ? `\n这些步骤标了「禁止子对话执行」（只对子对话生效）：${inParent.map((s) => `「${s.name}」`).join('、')}。子对话不跑它们；子对话合并成功后由面板在你的目录里自动跑（后台命令名里带子对话的名字），结果直接回传给对应的子对话，你不用转述。但**你自己改代码时没人替你跑**（没有子对话合并这一步）：这些步骤照常由你自己按清单执行。跑完之前，你计划里等那个子对话的步骤保持等待。`
        : ''
    : ''
  const list = active.length
    ? `项目的测试步骤（当前系统：${o.platform || '未知'}${o.scaled ? '；标「快速」的是小改动也要跑的' : ''}）：
${testStepsText(shown, o.platform, o.wslDistro, o.parentRun ?? '')}`
    : '项目还没有配置测试步骤：从 package.json 的 scripts、Makefile、CI 配置里找命令，找不到就说明缺口，不要编命令。'
  if (!o.scaled)
    return `## 验证
这个项目要求每次改动都跑完整的测试步骤：先按改动清单筛出适用的步骤，再按筛选后的顺序全部跑通才说完成。
${CHANGED_FILES_RULE}

${list}${parentNote}`
  const fast = quick.length
    ? `只跑标「快速」的步骤（${quick.map((s) => s.name).join('、')}）`
    : '挑一个最快的检查跑（类型检查、lint 或改动文件的语法检查，几十秒内跑完的）'
  return `## 验证按改动大小定
改完先判断这次改动的大小，再决定验证范围；两种大小都先按改动清单筛出适用的步骤：
${CHANGED_FILES_RULE}

- 小改动：只改文案、样式、注释、文档、配置值，或者一两个文件里几十行以内的局部修改，不动接口、数据结构、执行流程、构建配置和依赖。${fast}，通过就收尾，不跑单元测试、端到端、完整构建，也不为它启动工作流。
- 其他都算大改动：按筛选后的步骤完整跑一遍（太长的放到后台），不要为了保险全部跑一遍。
- 拿不准就按大改动；快速检查没过、或者报错不在你改的地方，也改按大改动处理。
- 回复里用一句话写明按哪种验证的、跑了什么，跳过的步骤写清原因。
${list}${parentNote}`
}

/** 新建项目时的默认步骤：按技术栈给一份够用的，用户确认后保存才生效 */
export function defaultTestSteps(
  kind: TestKind,
  opts: { windows: boolean; scripts?: Record<string, string> } = { windows: true },
) {
  const step = (id: string, name: string, command: string, extra: Partial<TestStep> = {}): TestStep => ({
    id,
    name,
    command,
    env: 'auto',
    cwd: '',
    when: '',
    // 空表示总是执行：只有确实知道「改了哪些文件才需要跑」的步骤才填 appliesTo
    appliesTo: [],
    timeoutSec: 0,
    note: '',
    enabled: true,
    merge: false,
    runInParent: false,
    quick: false,
    ...extra,
  })
  // 各技术栈真正会进构建 / 测试的文件：源码加上清单文件（清单变了编译单元和依赖就变了）。
  // 只改文档、资源、脚本这些不进编译的东西时，对应的编译和测试步骤不跑
  const rustSrc = ['**/*.rs', '**/Cargo.toml', '**/Cargo.lock']
  const goSrc = ['**/*.go', '**/go.mod', '**/go.sum']
  const pySrc = ['**/*.py', '**/pyproject.toml', '**/setup.cfg', '**/pytest.ini', '**/requirements*.txt']
  const netSrc = ['**/*.cs', '**/*.csproj', '**/*.sln', '**/*.props', '**/*.targets']
  const cmakeSrc = ['**/*.c', '**/*.cc', '**/*.cpp', '**/*.h', '**/*.hpp', '**/CMakeLists.txt', '**/*.cmake']
  if (kind === 'ue')
    return [
      step('ue-build', t('编译'), 'Build.bat <Target> Win64 Development -Project=<项目>.uproject -WaitMutex', {
        env: 'cmd',
        merge: true,
        // UBT 按这些文件算编译规则：C++ 源码；Build.cs / Target.cs 这类 *.cs 脚本（改了它 UBT 会重新生成
        // 编译规则，不重编就还在用旧的）；.uproject / .uplugin（模块和插件列表）。只改资源（.uasset /
        // .umap）、配置（.ini）或文档时不用重编，这也正是最常见的「改了点东西要不要编」的分界
        appliesTo: ['**/*.cpp', '**/*.h', '**/*.inl', '**/*.cs', '**/*.uproject', '**/*.uplugin'],
        note: t('同一时间只编译一次；把 <Target> 和 <.uproject> 换成项目里的实际名字'),
      }),
      step('ue-lua', t('Lua 语法检查'), 'luac -p <文件>', {
        quick: true,
        // luac 只解析 Lua 源文件，改了 Lua 才需要跑
        appliesTo: ['**/*.lua'],
        note: t('有 Lua 改动时执行；只做语法检查，不生成 .luac；按项目实际用的 Lua 版本换命令'),
      }),
      step(
        'ue-automation',
        t('自动化测试'),
        'UnrealEditor-Cmd.exe <项目>.uproject -ExecCmds="Automation RunTests <测试名>; Quit" -unattended -nullrhi',
        {
          // 自动化测试本身是 C++ 写的（AutomationTest），只有源码变了才需要重跑
          appliesTo: ['**/*.cpp', '**/*.h'],
          note: t('可选；需要 Editor 的验证登记为延期验证'),
          enabled: false,
        },
      ),
    ]
  if (kind === 'rust')
    return [
      // cargo fmt 只格式化 .rs，改了 Cargo.toml 不需要重新格式化
      step('rust-fmt', t('格式检查'), 'cargo fmt --check', { quick: true, appliesTo: ['**/*.rs'] }),
      step('rust-clippy', t('静态检查'), 'cargo clippy --all-targets -- -D warnings', { appliesTo: rustSrc }),
      step('rust-test', t('单元测试'), 'cargo test', { appliesTo: rustSrc }),
      step('rust-build', t('构建'), 'cargo build', { merge: true, appliesTo: rustSrc }),
    ]
  if (kind === 'go')
    return [
      step('go-vet', t('静态检查'), 'go vet ./...', { quick: true, appliesTo: goSrc }),
      step('go-test', t('单元测试'), 'go test ./...', { appliesTo: goSrc }),
      step('go-build', t('构建'), 'go build ./...', { merge: true, appliesTo: goSrc }),
    ]
  if (kind === 'python')
    return [
      step('py-test', t('单元测试'), 'pytest', { appliesTo: pySrc }),
      step('py-build', t('构建'), 'python -m build', { enabled: false, appliesTo: pySrc }),
    ]
  if (kind === 'dotnet')
    return [
      step('net-build', t('构建'), 'dotnet build', { merge: true, appliesTo: netSrc }),
      step('net-test', t('单元测试'), 'dotnet test', { appliesTo: netSrc }),
    ]
  if (kind === 'cmake')
    return [
      step('cmake-build', t('构建'), 'cmake --build build', { merge: true, appliesTo: cmakeSrc }),
      step('cmake-test', t('测试'), 'ctest', { appliesTo: cmakeSrc }),
    ]
  // Node / TypeScript：只列出项目里真的有的 scripts，不编不存在的命令
  const has = (k: string) => !!opts.scripts?.[k]
  const node: TestStep[] = []
  // 类型检查只看能进 tsc 的 TS 源码；单测、端到端看所有会被加载的源码（含纯 JS 项目：只有 .js / .jsx / .cjs
  // 的项目改源码同样得跑）；lint 还管样式和文档（prettier 检查 css / json / md / yml）
  const nodeSrc = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts']
  const nodeJs = ['**/*.js', '**/*.jsx', '**/*.cjs']
  const nodeRun = [...nodeSrc, ...nodeJs, '**/*.mjs', '**/package.json']
  if (has('typecheck'))
    node.push(
      step('node-typecheck', t('类型检查'), 'npm run typecheck', {
        merge: true,
        quick: true,
        appliesTo: [...nodeSrc, '**/tsconfig*.json', '**/package.json'],
      }),
    )
  if (has('lint'))
    node.push(
      step('node-lint', t('代码检查'), 'npm run lint', {
        quick: true,
        appliesTo: [...nodeSrc, ...nodeJs, '**/*.mjs', '**/*.css', '**/*.json', '**/*.md', '**/*.yml', '**/*.yaml'],
      }),
    )
  if (has('test:unit')) node.push(step('node-unit', t('单元测试'), 'npm run test:unit', { appliesTo: nodeRun }))
  if (has('test:e2e'))
    node.push(
      step('node-e2e', t('端到端测试'), 'npm run test:e2e', {
        // Windows 上 e2e 一般要在 WSL 里跑，避免路径和 shell 差异
        env: opts.windows ? 'wsl' : 'auto',
        appliesTo: nodeRun,
        note: opts.windows ? t('Windows 上在 WSL 里执行，不要在 PowerShell 里直接跑') : '',
      }),
    )
  if (has('build'))
    node.push(
      step('node-build', t('构建'), 'npm run build', {
        merge: true,
        // 构建要重新打包的是源码和前端产物配置：JS 项目改 .js / .jsx / .cjs 同样要重建
        appliesTo: [...nodeSrc, ...nodeJs, '**/*.mjs', '**/*.css', '**/*.html', '**/*.json'],
      }),
    )
  return node
}

export type TestKind = 'node' | 'ue' | 'rust' | 'go' | 'python' | 'dotnet' | 'cmake' | 'other'

/** 步骤列表的最小校验（界面和 AI 结果共用）：返回问题列表，空表示没问题 */
export function testStepIssues(steps: Pick<TestStep, 'name' | 'command' | 'env'>[]) {
  const out: string[] = []
  steps.forEach((s, i) => {
    if (!s.name.trim()) out.push(t('第 {n} 条：步骤名不能为空', { n: i + 1 }))
    if (!s.command.trim()) out.push(t('第 {n} 条：命令不能为空', { n: i + 1 }))
    if (!(TEST_STEP_ENVS as readonly string[]).includes(s.env))
      out.push(t('第 {n} 条：环境只能是 {list}', { n: i + 1, list: TEST_STEP_ENVS.join(' / ') }))
  })
  return out
}

/** 新步骤的 id：用时间戳加序号，项目内唯一即可 */
export function newTestStepId(steps: Pick<TestStep, 'id'>[]) {
  const used = new Set(steps.map((s) => s.id))
  for (let i = 1; ; i++) {
    const id = `ts${Date.now().toString(36).slice(-5)}${i}`
    if (!used.has(id)) return id
  }
}

/**
 * 这个 Agent 是不是负责跑测试的：它声明了「范围 + 环境」这两个参数。
 * 按参数判断而不是按名字或 origin：用户复制、改名的测试 Agent 也认得出来，
 * 内置的测试 Agent 改名后也照样注入测试步骤。
 */
export function isTestAgent(agent: { params: { key: string }[] } | undefined) {
  if (!agent) return false
  const keys = new Set(agent.params.map((p) => p.key))
  return keys.has('scope') && keys.has('env')
}

/**
 * UE 项目里父对话申请编译时跑哪些步骤：标了「合并时编译」的；一条都没标时退回名字或 id 像编译的。
 * 只取启用的，按项目里的顺序
 */
export function buildSteps(steps: TestStep[]) {
  const on = steps.filter((s) => s.enabled && s.command.trim())
  const merge = on.filter((s) => s.merge)
  return merge.length ? merge : on.filter((s) => s.id === 'ue-build' || /编译|build|compile/i.test(s.name))
}

/** 会占用 UE 编译资源的命令（UBT、UHT、Build.bat、RunUAT、Editor）：子对话里不跑，交给父对话申请 */
export function isUeBuildCommand(command: string) {
  return /(^|[\s"'\\/&|;(])(Build\.(bat|sh|command)|RunUAT\.(bat|sh)|UnrealBuildTool(\.exe|\.dll)?|UnrealHeaderTool(\.exe)?|UnrealEditor(-Cmd)?(\.exe)?|UE4Editor(-Cmd)?(\.exe)?)(?=$|[\s"'])/i.test(
    command,
  )
}
