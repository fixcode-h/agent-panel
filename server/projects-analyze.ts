import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectSuggestion } from '../shared/project-scan.ts'
import { defaultTestSteps } from '../shared/test-steps.ts'
import { resolvePath } from './fs.ts'
import { t } from '../shared/i18n.ts'

/**
 * 项目目录的快速扫描：只读地按存在的文件判断技术栈、版本控制、文档和测试方式，
 * 给出项目名、简介、建议的工作流和配置项。
 *
 * 项目设置里的「AI 分析这个目录」先跑它，扫出来的线索交给本机 Agent 当参考（见 shared/assist.ts 的 project），
 * 工作流参数、WSL 发行版这类扫描就能定的事实直接用扫描结果
 */

/** 只看这一层，不递归整个源码树 */
const MAX_ENTRIES = 200

async function exists(p: string) {
  return !!(await stat(p).catch(() => null))
}

async function readJson<T = unknown>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T
  } catch {
    return null
  }
}

/** 一级目录和文件（跳过 .git、node_modules 这类目录） */
async function topLevel(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const skip = new Set(['.git', '.svn', 'node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj', '.next'])
  const dirs: string[] = []
  const files: string[] = []
  for (const e of entries.slice(0, MAX_ENTRIES)) {
    if (skip.has(e.name)) continue
    if (e.isDirectory()) dirs.push(e.name)
    else files.push(e.name)
  }
  return { dirs, files }
}

/** 从依赖清单看得出是什么项目：技术栈、用哪套结构技能、建议哪个工作流，以及构建和测试命令 */
async function detectStack(dir: string, files: string[], dirs: string[]) {
  const has = (f: string) => files.includes(f)
  if (has('.uproject') || dirs.includes('Source') || dirs.includes('Plugins')) {
    return {
      label: 'Unreal Engine',
      structure: 'ue-project-structure' as const,
      workflow: 'ue' as const,
      kind: 'ue' as const,
      build: 'Build.bat <Target> Win64 Development -Project=<项目>.uproject -WaitMutex',
      test: 'Automation RunTests（编辑器或 -game 模式）',
    }
  }
  const pkg = has('package.json')
    ? await readJson<{
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }>(path.join(dir, 'package.json'))
    : null
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const names = Object.keys(deps)
    const labels: string[] = []
    if (names.some((n) => /^(react|vue|svelte|solid-js|next|nuxt|@angular\/core)$/.test(n))) labels.push('前端')
    if (names.includes('typescript')) labels.push('TypeScript')
    if (names.some((n) => /^(express|koa|fastify|hono|nest)$/.test(n))) labels.push('Node 服务端')
    if (names.some((n) => /^(vitest|jest|mocha|ava|playwright|cypress)$/.test(n)))
      labels.push(names.find((n) => /^(vitest|jest|playwright|cypress)$/.test(n))!)
    const run = (k: string) => (pkg.scripts?.[k] ? t('npm run {k}', { k }) : '')
    return {
      label: labels.length ? labels.join(' + ') : 'Node.js',
      structure: 'project-structure' as const,
      workflow: 'general' as const,
      kind: 'node' as const,
      build: run('build'),
      test: run('test') || run('test:unit') || run('typecheck'),
      // 默认测试步骤只列项目里真的有的 scripts，不编不存在的命令
      scripts: pkg.scripts,
    }
  }
  if (has('Cargo.toml'))
    return {
      label: 'Rust',
      structure: 'project-structure' as const,
      workflow: 'general' as const,
      kind: 'rust' as const,
      build: 'cargo build',
      test: 'cargo test',
    }
  if (has('go.mod'))
    return {
      label: 'Go',
      structure: 'project-structure' as const,
      workflow: 'general' as const,
      kind: 'go' as const,
      build: 'go build ./...',
      test: 'go test ./...',
    }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py'))
    return {
      label: 'Python',
      structure: 'project-structure' as const,
      workflow: 'general' as const,
      kind: 'python' as const,
      build: '',
      test: has('pyproject.toml') ? 'pytest' : 'pytest',
    }
  if (files.some((f) => /\.(sln|csproj)$/.test(f)) || dirs.some((d) => d.endsWith('.sln')))
    return {
      label: '.NET',
      structure: 'project-structure' as const,
      workflow: 'general' as const,
      kind: 'dotnet' as const,
      build: 'dotnet build',
      test: 'dotnet test',
    }
  if (has('CMakeLists.txt'))
    return {
      label: 'C/C++（CMake）',
      structure: 'project-structure' as const,
      workflow: 'general' as const,
      kind: 'cmake' as const,
      build: 'cmake --build build',
      test: 'ctest',
    }
  return {
    label: '',
    structure: 'project-structure' as const,
    workflow: 'general' as const,
    kind: 'other' as const,
    build: '',
    test: '',
  }
}

/** 版本控制：目录里有 .git / .p4config / .svn，或者上层目录里有（P4 的工作区根常常在上面） */
async function detectVcs(dir: string) {
  let cur = dir
  for (let i = 0; i < 6; i++) {
    if (await exists(path.join(cur, '.git'))) return { vcs: 'git' as const, root: cur }
    if ((await exists(path.join(cur, '.p4config'))) || (await exists(path.join(cur, '.p4ignore'))))
      return { vcs: 'p4' as const, root: cur }
    if (await exists(path.join(cur, '.svn'))) return { vcs: 'svn' as const, root: cur }
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return { vcs: 'none' as const, root: dir }
}

/** 文档目录：已有的 docs / doc / documentation 优先 */
async function detectDocs(dir: string, dirs: string[]) {
  for (const name of ['docs', 'doc', 'documentation', 'Docs']) {
    if (dirs.includes(name)) return path.join(dir, name)
  }
  return ''
}

export async function analyzeProject(input: string): Promise<ProjectSuggestion | { error: string }> {
  const dir = resolvePath(input)
  const info = await stat(dir).catch(() => null)
  if (!info?.isDirectory()) return { error: t('目录不存在：{dir}', { dir }) }

  const { files, dirs } = await topLevel(dir)
  const stack = await detectStack(dir, files, dirs)
  const vcs = await detectVcs(dir)
  const docs = await detectDocs(dir, dirs)
  const name = path.basename(dir)
  const gitBranch =
    vcs.vcs === 'git'
      ? await readFile(path.join(vcs.root, '.git', 'HEAD'), 'utf8')
          .then((s) => (s.startsWith('ref: ') ? s.replace(/^ref: refs\/heads\//, '').trim() : ''))
          .catch(() => '')
      : ''

  const parts = [stack.label ? `${stack.label} 项目` : '项目', vcs.vcs === 'p4' ? 'P4' : vcs.vcs === 'git' ? 'Git' : '']
    .filter(Boolean)
    .join(' · ')
  const notes = [
    stack.build ? t('构建：{cmd}', { cmd: stack.build }) : '',
    stack.test ? t('测试：{cmd}', { cmd: stack.test }) : '',
    docs ? t('文档：{dir}', { dir: path.basename(docs) }) : '',
    gitBranch ? t('当前分支：{b}', { b: gitBranch }) : '',
  ].filter(Boolean)

  return {
    name,
    description: `${parts}${notes.length ? `。${notes.join('；')}` : ''}`.slice(0, 200),
    workflow: stack.workflow,
    workflowParams: {
      projectStructure: stack.structure,
      ...(docs ? { docRoot: docs } : {}),
    },
    // 默认测试步骤：按识别出的技术栈给一份，用户确认后保存才生效
    testSteps: defaultTestSteps(stack.kind, {
      windows: process.platform === 'win32',
      scripts: 'scripts' in stack ? stack.scripts : undefined,
    }),
    wslDistro: process.platform === 'win32' && stack.kind === 'node' ? 'Ubuntu-24.04' : '',
    category: '',
    /** 界面上给用户看的分析依据 */
    signals: [
      vcs.vcs === 'none' ? t('没有检测到版本控制') : t('版本控制：{vcs}', { vcs: vcs.vcs }),
      stack.label ? t('技术栈：{label}', { label: stack.label }) : t('没有识别出技术栈'),
      ...(stack.build ? [t('构建命令：{cmd}', { cmd: stack.build })] : []),
      ...(stack.test ? [t('测试命令：{cmd}', { cmd: stack.test })] : []),
      ...(docs ? [t('文档目录：{dir}', { dir: docs })] : []),
    ],
  }
}
