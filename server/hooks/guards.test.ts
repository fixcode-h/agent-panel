/**
 * 第四期的内置守卫（ADR 0049）：每个守卫只看工具、命令、路径和任务 / 项目的状态，拦住时说清原因。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const data = mkdtempSync(path.join(tmpdir(), 'agent-panel-guards-'))
process.env.AGENT_PANEL_DATA = data

const { bugDeny, dangerDeny, longDeny, pushDeny, secretDeny, testScopeDeny, worktreeDeny } = await import('./guards.ts')
type Ctx = import('./guards.ts').GuardCtx

const proj = path.join(tmpdir(), 'proj-x')
const ctx = (
  over: Omit<Partial<Ctx>, 'task' | 'project'> & {
    task?: Partial<Ctx['task']>
    project?: Partial<NonNullable<Ctx['project']>>
  } = {},
): Ctx => ({
  cwd: proj,
  helper: false,
  canBackground: true,
  list: () => [],
  ...over,
  task: { id: 't', parentTaskId: '', projectId: 'p1', testSteps: [], worktree: null, ...over.task } as Ctx['task'],
  project: { path: proj, gitPolicy: 'ask', testSteps: [], ...over.project } as NonNullable<Ctx['project']>,
})
const sh = (command: string) => ({
  tool: { kind: 'shell' as const, name: 'Bash', input: { command }, path: '', paths: [] },
})
const edit = (file: string, content = 'x') => ({
  tool: { kind: 'edit' as const, name: 'Write', input: { file_path: file, content }, path: file, paths: [file] },
})

test('推送授权：没授权先 ask_push，拒绝过、项目不推送、子对话都拒绝；同意过或项目允许就放行', () => {
  assert.match(pushDeny(ctx(), sh('git push origin dev')), /ask_push/)
  assert.match(pushDeny(ctx(), sh('cd /p && git -C /p push')), /ask_push/, '前面有 cd、带 -C 也认得')
  assert.match(pushDeny(ctx({ task: { remotePush: 'denied' } }), sh('git push')), /拒绝过/)
  assert.match(pushDeny(ctx({ project: { gitPolicy: 'deny' } }), sh('gh pr merge 3 --merge')), /不推送/)
  assert.match(pushDeny(ctx({ task: { parentTaskId: 'par' } }), sh('git push')), /父对话做/)
  assert.equal(pushDeny(ctx({ task: { remotePush: 'allowed' } }), sh('git push')), '')
  assert.equal(pushDeny(ctx({ project: { gitPolicy: 'allow' } }), sh('git push')), '')
  assert.equal(pushDeny(ctx(), sh('git pull && git status')), '', '不是推送不管')
})

test('Bug 先诊断：没诊断、等确认、被提意见时不改文件；确认后只改方案里的文件', () => {
  const diag = (status: string) =>
    ({ task: { bug: true, diagnoses: [{ version: 1, status, files: ['src/a.ts'] }] } }) as never
  assert.match(bugDeny(ctx({ task: { bug: true } }), edit(path.join(proj, 'src/a.ts'))), /submit_diagnosis/)
  assert.match(bugDeny(ctx(diag('pending')), edit(path.join(proj, 'src/a.ts'))), /等用户确认/)
  assert.match(bugDeny(ctx(diag('questioned')), edit(path.join(proj, 'src/a.ts'))), /提了意见/)
  assert.match(
    bugDeny(ctx(diag('cancelled')), edit(path.join(proj, 'src/a.ts'))),
    /取消了第 1 版.*先用 submit_diagnosis 重新交报告/,
  )
  assert.equal(bugDeny(ctx(diag('approved')), edit(path.join(proj, 'src/a.ts'))), '')
  assert.match(bugDeny(ctx(diag('approved')), edit(path.join(proj, 'src/b.ts'))), /不在用户同意的范围/)
  assert.equal(
    bugDeny(ctx(diag('approved')), edit(path.join(data, 'tasks/files/t/tmp/build_editor.bat'))),
    '',
    '面板给的临时目录不按方案拦',
  )
  assert.equal(bugDeny(ctx(), edit(path.join(proj, 'src/b.ts'))), '', '不是 Bug 不管')
  // 按阶段（用户 2026-11-05 定的）：同意了根因还不能改，确认了方案放行方案里的文件和论证时加过日志的文件
  const list = (...ds: object[]) => ({ task: { bug: true, diagnoses: ds } }) as never
  const ev = { version: 1, phase: 'evidence', status: 'answered', files: ['src/log.ts'], logPlan: [] }
  const cause = { version: 2, phase: 'cause', status: 'approved', files: [], logPlan: [] }
  const plan = { version: 3, phase: 'plan', status: 'approved', files: ['src/a.ts'], logPlan: [] }
  assert.match(bugDeny(ctx(list(ev)), edit(path.join(proj, 'src/log.ts'))), /先分析/)
  assert.match(bugDeny(ctx(list(ev, cause)), edit(path.join(proj, 'src/a.ts'))), /先交 phase: plan/)
  assert.equal(bugDeny(ctx(list(ev, cause, plan)), edit(path.join(proj, 'src/log.ts'))), '', '删临时日志')
  assert.match(bugDeny(ctx(list(ev, cause, plan)), edit(path.join(proj, 'src/b.ts'))), /不在用户同意的范围/)
})

test('危险命令：递归删根、家、项目，原分支上清工作区，强推、删主干都拦；普通删除和独立分支里的 reset 放行', () => {
  for (const c of [
    'rm -rf /',
    'rm -rf ~',
    `rm -fr ${homedir()}`,
    `rm -rf ${proj}`,
    'cd x && rm -rf .',
    'sudo rm -r /*',
  ])
    assert.ok(dangerDeny(ctx(), sh(c)), c)
  for (const c of ['git reset --hard HEAD', 'git clean -fd', 'git checkout -- .', 'git restore .'])
    assert.ok(dangerDeny(ctx(), sh(c)), c)
  assert.ok(dangerDeny(ctx(), sh('git push --force origin dev')))
  assert.ok(dangerDeny(ctx(), sh('git branch -D main')))
  for (const c of [
    'rm -rf dist node_modules',
    'rm a.txt',
    'git checkout -- src/a.ts',
    'git branch -D old',
    'git push',
    'git clean -fd .cache',
  ])
    assert.equal(dangerDeny(ctx(), sh(c)), '', c)
  const wt = ctx({ task: { parentTaskId: 'par', worktree: { path: proj, state: 'active' } as never } })
  assert.equal(dangerDeny(wt, sh('git reset --hard HEAD')), '', '子对话自己的分支里放行')
  assert.ok(dangerDeny(ctx({ list: () => ['docker system prune'] }), sh('docker system prune -a')), '设置里加的也拦')
})

test('长命令转后台：开发服务器、完整测试在前台跑时拒绝；没有后台工具、普通命令放行', () => {
  assert.match(longDeny(ctx(), sh('npm run dev')), /run_background/)
  assert.match(longDeny(ctx(), sh('npx vite')), /不会自己结束/)
  assert.match(longDeny(ctx(), sh('cd web && npm run test:e2e')), /完整检查/)
  assert.equal(longDeny(ctx(), sh('npx vite build')), '')
  assert.equal(longDeny(ctx(), sh('npm run typecheck')), '')
  assert.equal(longDeny(ctx({ canBackground: false }), sh('npm run test:e2e')), '', '没有后台工具时不拦')
  assert.ok(longDeny(ctx({ list: () => ['cargo test'] }), sh('cargo test --all')), '设置里加的也算')
  assert.match(longDeny(ctx(), sh('npm run dev')), /service/, '常驻进程提示用 service')
})

test('长命令转后台：只看真正运行的程序，写文件、查文件、提交说明里出现 e2e、--watch 不拦（用户 2026-11-05 报）', () => {
  for (const cmd of [
    "cat > docs/a.md <<'EOF'\n先跑 npm run test:e2e\n再用 vite --watch\nEOF",
    "git commit -m '修复 e2e 超时'",
    'grep -rn e2e scripts',
    'cat scripts/e2e/07-local.mjs',
    'ls scripts/ui-check.mjs',
    'sed -n 1,20p docs/e2e.md',
    "@'\nnpm run test:e2e\n'@ | Set-Content a.md",
  ])
    assert.equal(longDeny(ctx(), sh(cmd)), '', cmd)
  assert.match(
    longDeny(ctx(), sh("cat > a.md <<'EOF'\nx\nEOF\nnpm run test:e2e")),
    /完整检查/,
    'heredoc 之后真跑的照样拦',
  )
  assert.match(longDeny(ctx(), sh('CI=1 npx playwright test')), /完整检查/, '前面的环境变量跳过')
  // heredoc 正文不当命令：里面写着 git push --force 不触发危险命令守卫
  assert.equal(dangerDeny(ctx(), sh("cat > notes.md <<'EOF'\n不要 git push --force\nEOF")), '')
  assert.match(dangerDeny(ctx(), sh('git push --force origin dev')), /强制推送/)
})

test('测试步骤归属：独立分支里的子对话跑「合回后由父对话跑」的步骤时拒绝，共用目录照常', () => {
  const steps = [{ name: '全量单测', command: 'npm run test:unit', scope: 'parent', enabled: true }] as never
  const wt = { parentTaskId: 'par', worktree: { path: proj, state: 'active' } as never }
  assert.match(testScopeDeny(ctx({ task: wt, project: { testSteps: steps } }), sh('npm  run test:unit')), /全量单测/)
  assert.equal(
    testScopeDeny(ctx({ task: { parentTaskId: 'par' }, project: { testSteps: steps } }), sh('npm run test:unit')),
    '',
  )
  assert.equal(testScopeDeny(ctx({ task: wt, project: { testSteps: steps } }), sh('npm run typecheck')), '')
})

test('凭据守卫：往项目文件、重定向里写像真实密钥的内容拒绝；.env 和占位符放行', () => {
  const key = 'sk-' + 'a'.repeat(30) // secret-check-ok: 测试用的假密钥
  assert.match(secretDeny(ctx(), edit(path.join(proj, 'src/config.ts'), `const k = '${key}'`)), /环境变量/)
  assert.ok(secretDeny(ctx(), sh(`echo ${key} > key.txt`)))
  assert.equal(secretDeny(ctx(), edit(path.join(proj, '.env'), `KEY=${key}`)), '')
  assert.equal(secretDeny(ctx(), edit(path.join(proj, 'src/config.ts'), "const k = 'your-api-key'")), '')
  assert.equal(secretDeny(ctx(), sh(`curl -H "x: ${key}"`)), '', '不往文件里写的命令不管')
})

test('独立分支越界：子对话改分支目录以外的文件拒绝；自己目录、临时目录、不在独立分支的放行', () => {
  const wtDir = path.join(tmpdir(), 'wt-1')
  const wt = ctx({ cwd: wtDir, task: { parentTaskId: 'par', worktree: { path: wtDir, state: 'active' } as never } })
  assert.match(worktreeDeny(wt, edit(path.join(proj, 'src/a.ts'))), /独立分支目录/)
  assert.equal(worktreeDeny(wt, edit('src/a.ts')), '')
  assert.equal(worktreeDeny(wt, edit(path.join(tmpdir(), 'x.txt'))), '')
  assert.equal(worktreeDeny(ctx(), edit(path.join(proj, 'src/a.ts'))), '')
})
