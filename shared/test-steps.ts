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
        `${i + 1}. ${s.name}（${ENV_LABEL[s.env]}${s.enabled ? '' : t('，已停用')}）`,
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
    ...extra,
  })
  if (kind === 'ue')
    return [
      step('ue-build', t('编译'), 'Build.bat <Target> Win64 Development -Project=<项目>.uproject -WaitMutex', {
        env: 'cmd',
        note: t('同一时间只编译一次；把 <Target> 和 <.uproject> 换成项目里的实际名字'),
      }),
      step('ue-lua', t('Lua 语法检查'), 'luac -p <文件>', {
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
      step('rust-fmt', t('格式检查'), 'cargo fmt --check'),
      step('rust-clippy', t('静态检查'), 'cargo clippy --all-targets -- -D warnings'),
      step('rust-test', t('单元测试'), 'cargo test'),
      step('rust-build', t('构建'), 'cargo build'),
    ]
  if (kind === 'go')
    return [
      step('go-vet', t('静态检查'), 'go vet ./...'),
      step('go-test', t('单元测试'), 'go test ./...'),
      step('go-build', t('构建'), 'go build ./...'),
    ]
  if (kind === 'python')
    return [
      step('py-test', t('单元测试'), 'pytest'),
      step('py-build', t('构建'), 'python -m build', { enabled: false }),
    ]
  if (kind === 'dotnet')
    return [step('net-build', t('构建'), 'dotnet build'), step('net-test', t('单元测试'), 'dotnet test')]
  if (kind === 'cmake')
    return [step('cmake-build', t('构建'), 'cmake --build build'), step('cmake-test', t('测试'), 'ctest')]
  // Node / TypeScript：只列出项目里真的有的 scripts，不编不存在的命令
  const has = (k: string) => !!opts.scripts?.[k]
  const node: TestStep[] = []
  if (has('typecheck')) node.push(step('node-typecheck', t('类型检查'), 'npm run typecheck'))
  if (has('lint')) node.push(step('node-lint', t('代码检查'), 'npm run lint'))
  if (has('test:unit')) node.push(step('node-unit', t('单元测试'), 'npm run test:unit'))
  if (has('test:e2e'))
    node.push(
      step('node-e2e', t('端到端测试'), 'npm run test:e2e', {
        // Windows 上 e2e 一般要在 WSL 里跑，避免路径和 shell 差异
        env: opts.windows ? 'wsl' : 'auto',
        note: opts.windows ? t('Windows 上在 WSL 里执行，不要在 PowerShell 里直接跑') : '',
      }),
    )
  if (has('build')) node.push(step('node-build', t('构建'), 'npm run build'))
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
