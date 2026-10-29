/**
 * worktree 测试的公共准备：`worktree.test.ts`（计时批、串行）和 `worktree-merge.test.ts`
 * （并发批）各跑一遍，各自在自己的进程里建一份临时目录和模板仓库。
 *
 * 准备为什么这么写：
 * - 测试进程和被测代码都不认外面的 git dir：createWorktree / mergeWorktree 这些函数内部
 *   用 process.env 跑 git，只清子进程的话，`git worktree add`、`git merge` 仍会落到共享仓库上
 *   （在 WSL 里带 GIT_DIR / GIT_WORK_TREE 跑测试时会污染主仓库，见 docs/lessons/e2e.md）。
 * - GIT_CONFIG_COUNT 是面板给后台命令注入的防推送配置（pushInsteadOf 指向不存在的协议），
 *   留着会让这里自己的 push / clone 失败；测试自己建仓库，不认外面的 git 配置。
 * - 独立目录和共用的依赖目录都建在 DATA_DIR 下：指到临时目录，别写进真实的数据目录。
 *
 * 这个文件不以 .test.ts 结尾，不会被 scripts/unit-tests.mjs 当成一个用例文件。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setLang } from '../../shared/i18n.ts'

// 断言的是 worktree.ts 里 t() 出来的报错文案：显式固定语言，不跟着 LANG 走
setLang('zh')

delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE
delete process.env.GIT_INDEX_FILE
delete process.env.GIT_COMMON_DIR
delete process.env.GIT_CONFIG_COUNT

/** 测试自己的临时目录：模板仓库、每个用例的项目和独立目录都建在这下面，进程退出时删掉 */
export const tmp = mkdtempSync(path.join(tmpdir(), 'agent-panel-wt-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
process.env.AGENT_PANEL_DATA = path.join(tmp, 'data')

// 依赖位置由 DATA_DIR 决定，必须在上面设置之后再加载
export const {
  branchesOverlap,
  createWorktree,
  ensureWorktree,
  isolateDeps,
  mergeOverlap,
  mergeSides,
  mergeSidesText,
  mergeWorktree,
  missingDeps,
  releaseWorktree,
  removeWorktree,
  sharedDepsDir,
  sweepWorktrees,
  worktreeStatus,
  WORKTREES_DIR,
} = await import('./worktree.ts')

/**
 * 子进程的 git 不能继承 GIT_DIR / GIT_WORK_TREE：在 WSL 里带这两个变量跑测试时，
 * git init 会把它们写进共享仓库的 .git/config（core.worktree = WSL 路径），
 * 之后主目录所有 git 命令都报 `fatal: Invalid path '/mnt'`。测试自己建仓库，不认外面的 git dir
 */
export const gitEnv = () => {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_COMMON_DIR
  return env
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'pipe',
    env: gitEnv(),
  })

/** 独立目录按任务 id 建在共享的数据目录下：每次用新 id，避免上一次失败的残留挡住 */
export const tid = () => `test-${Math.random().toString(36).slice(2, 10)}`

/** 分支还在不在：回收类用例看它有没有真的被删掉 */
export const branchAlive = (repo: string, branch: string) =>
  git(repo, 'branch', '--list', branch).toString().trim() !== ''

/** 共用依赖在 `<数据目录>/worktrees/<项目>-<哈希>/node_modules`；测试的数据目录是临时目录，整个根可以直接清 */
export const resetSharedDeps = () => rmSync(WORKTREES_DIR, { recursive: true, force: true })

/**
 * 模板仓库：init + add + commit 只在模块加载时做一次，每个用例 cpSync 一份（连 .git 和历史一起）。
 * 以前每例重跑 3 次 git 进程（30 处 project() 调用合计近 90 次），占了整个单测最慢的一档
 */
const templateRepo = path.join(tmp, 'template')
function buildTemplate(): void {
  mkdirSync(templateRepo, { recursive: true })
  writeFileSync(path.join(templateRepo, '.gitignore'), 'node_modules\n.env*\n')
  writeFileSync(path.join(templateRepo, 'README.md'), '# demo\n')
  mkdirSync(path.join(templateRepo, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(path.join(templateRepo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  writeFileSync(path.join(templateRepo, 'node_modules', 'dep', 'package.json'), '{"name":"dep","version":"1.0.0"}\n')
  // 共用依赖按 package-lock 判断要不要重新复制（见 worktree.ts 的 depsStamp）
  writeFileSync(path.join(templateRepo, 'package.json'), '{"name":"demo","version":"1.0.0"}\n')
  writeFileSync(path.join(templateRepo, 'package-lock.json'), '{"name":"demo","lockfileVersion":3,"packages":{}}\n')
  writeFileSync(path.join(templateRepo, '.env'), 'TOKEN=dev\n')
  writeFileSync(path.join(templateRepo, '.env.local'), 'SECRET=real\n')
  git(templateRepo, 'init', '-q')
  // 身份写进模板仓库自己：复制出去的仓库里 worktree.ts 内部还要 commit / merge，
  // 不能指望跑测试的机器配了全局 user.name / user.email
  git(templateRepo, 'config', 'user.name', 't')
  git(templateRepo, 'config', 'user.email', 't@t')
  git(templateRepo, 'add', '.')
  git(templateRepo, 'commit', '-qm', 'init')
}
buildTemplate()

/** 一个 git 仓库项目，带 node_modules 和环境文件：复制模板，历史从同一个 init 提交开始 */
export function project(): string {
  const dir = path.join(tmp, `p${Math.random().toString(36).slice(2, 8)}`)
  cpSync(templateRepo, dir, { recursive: true })
  return dir
}
