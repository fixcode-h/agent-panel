import { TEST_STEP_ENVS, type TestStep } from './schema.ts'
import { t } from './i18n.ts'

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
export function testStepsText(steps: TestStep[], platform: string, wslDistro = '') {
  return steps
    .map((s, i) => {
      const lines = [
        `${i + 1}. ${s.name}（${ENV_LABEL[s.env]}${s.quick ? '，快速' : ''}${s.enabled ? '' : t('，已停用')}）`,
        `   - 命令：${stepCommand(s, platform, wslDistro)}`,
      ]
      if (s.cwd) lines.push(`   - 工作目录：${s.cwd}（相对项目根）`)
      if (s.when) lines.push(`   - 执行条件：${s.when}`)
      if (s.timeoutSec) lines.push(`   - 超时：${s.timeoutSec} 秒`)
      if (s.note) lines.push(`   - 说明：${s.note}`)
      const note = envNote(s, platform)
      if (note) lines.push(`   - 环境：${note}`)
      return lines.join('\n')
    })
    .join('\n')
}

/**
 * 注入工作流说明后面的项目测试步骤。没有配置时给出兜底：让 Agent 自己找命令，并在结果里建议配置。
 * 新建对话时写进任务快照，之后改项目设置不影响已经开始的任务。
 */
export function testStepsBlock(steps: TestStep[], platform: string, wslDistro = '') {
  const active = steps.filter((s) => s.enabled)
  const head = `## 项目测试步骤\n当前系统：${platform || '未知'}。这些步骤由项目设置维护，测试与验收时按顺序执行：`
  if (active.length) return `${head}\n${testStepsText(active, platform, wslDistro)}`
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
export function verifyBlock(steps: TestStep[], o: { platform: string; wslDistro?: string; scaled: boolean }) {
  const active = steps.filter((s) => s.enabled)
  const quick = active.filter((s) => s.quick)
  // 关掉时不分大小，「快速」标记没有意义，不写出来免得 Agent 只跑这几条
  const shown = o.scaled ? active : active.map((s) => ({ ...s, quick: false }))
  const list = active.length
    ? `项目的测试步骤（当前系统：${o.platform || '未知'}${o.scaled ? '；标「快速」的是小改动也要跑的' : ''}）：\n${testStepsText(shown, o.platform, o.wslDistro)}`
    : '项目还没有配置测试步骤：从 package.json 的 scripts、Makefile、CI 配置里找命令，找不到就说明缺口，不要编命令。'
  if (!o.scaled)
    return `## 验证
这个项目要求每次改动都跑完整的测试步骤，改完按顺序全部跑通再说完成。
${list}`
  const fast = quick.length
    ? `只跑标「快速」的步骤（${quick.map((s) => s.name).join('、')}）`
    : '挑一个最快的检查跑（类型检查、lint 或改动文件的语法检查，几十秒内跑完的）'
  return `## 验证按改动大小定
改完先判断这次改动的大小，再决定验证范围：
- 小改动：只改文案、样式、注释、文档、配置值，或者一两个文件里几十行以内的局部修改，不动接口、数据结构、执行流程、构建配置和依赖。${fast}，通过就收尾，不跑单元测试、端到端、完整构建，也不为它启动工作流。
- 其他都算大改动：按项目的测试步骤完整跑一遍（太长的放到后台）。
- 拿不准就按大改动；快速检查没过、或者报错不在你改的地方，也改按大改动处理。
- 回复里用一句话写明按哪种验证的、跑了什么。
${list}`
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
    timeoutSec: 0,
    note: '',
    enabled: true,
    merge: false,
    quick: false,
    ...extra,
  })
  if (kind === 'ue')
    return [
      step('ue-build', t('编译'), 'Build.bat <Target> Win64 Development -Project=<项目>.uproject -WaitMutex', {
        env: 'cmd',
        merge: true,
        note: t('同一时间只编译一次；把 <Target> 和 <.uproject> 换成项目里的实际名字'),
      }),
      step('ue-lua', t('Lua 语法检查'), 'luac -p <文件>', {
        quick: true,
        note: t('有 Lua 改动时执行；按项目实际用的 Lua 版本换命令'),
      }),
      step(
        'ue-automation',
        t('自动化测试'),
        'UnrealEditor-Cmd.exe <项目>.uproject -ExecCmds="Automation RunTests <测试名>; Quit" -unattended -nullrhi',
        {
          note: t('可选；需要 Editor 的验证登记为延期验证'),
          enabled: false,
        },
      ),
    ]
  if (kind === 'rust')
    return [
      step('rust-fmt', t('格式检查'), 'cargo fmt --check', { quick: true }),
      step('rust-clippy', t('静态检查'), 'cargo clippy --all-targets -- -D warnings'),
      step('rust-test', t('单元测试'), 'cargo test'),
      step('rust-build', t('构建'), 'cargo build', { merge: true }),
    ]
  if (kind === 'go')
    return [
      step('go-vet', t('静态检查'), 'go vet ./...', { quick: true }),
      step('go-test', t('单元测试'), 'go test ./...'),
      step('go-build', t('构建'), 'go build ./...', { merge: true }),
    ]
  if (kind === 'python')
    return [
      step('py-test', t('单元测试'), 'pytest'),
      step('py-build', t('构建'), 'python -m build', { enabled: false }),
    ]
  if (kind === 'dotnet')
    return [
      step('net-build', t('构建'), 'dotnet build', { merge: true }),
      step('net-test', t('单元测试'), 'dotnet test'),
    ]
  if (kind === 'cmake')
    return [
      step('cmake-build', t('构建'), 'cmake --build build', { merge: true }),
      step('cmake-test', t('测试'), 'ctest'),
    ]
  // Node / TypeScript：只列出项目里真的有的 scripts，不编不存在的命令
  const has = (k: string) => !!opts.scripts?.[k]
  const node: TestStep[] = []
  if (has('typecheck'))
    node.push(step('node-typecheck', t('类型检查'), 'npm run typecheck', { merge: true, quick: true }))
  if (has('lint')) node.push(step('node-lint', t('代码检查'), 'npm run lint', { quick: true }))
  if (has('test:unit')) node.push(step('node-unit', t('单元测试'), 'npm run test:unit'))
  if (has('test:e2e'))
    node.push(
      step('node-e2e', t('端到端测试'), 'npm run test:e2e', {
        // Windows 上 e2e 一般要在 WSL 里跑，避免路径和 shell 差异
        env: opts.windows ? 'wsl' : 'auto',
        note: opts.windows ? t('Windows 上在 WSL 里执行，不要在 PowerShell 里直接跑') : '',
      }),
    )
  if (has('build')) node.push(step('node-build', t('构建'), 'npm run build', { merge: true }))
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
