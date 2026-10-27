/**
 * 数据清理（server/cleanup.ts）：对话工作目录统计、失效目录判定、回收站排除、清理只删内容。
 * 数据目录和构建产物目录都指到临时目录，不碰真实的用户数据和仓库里的 dist/。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setLang } from '../shared/i18n.ts'
import { Task } from '../shared/schema.ts'

setLang('zh')
// 测试自己建仓库，不认外面的 git dir / 面板注入的防推送配置（见 server/exec/worktree.test.ts）
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE
delete process.env.GIT_INDEX_FILE
delete process.env.GIT_COMMON_DIR
delete process.env.GIT_CONFIG_COUNT

const tmp = mkdtempSync(path.join(tmpdir(), 'agent-panel-cleanup-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
const DATA = path.join(tmp, 'data')
const APP = path.join(tmp, 'app')
process.env.AGENT_PANEL_DATA = DATA
// 构建产物按它找：dist / dist-demo / release / ui-shots
process.env.AGENT_PANEL_APP_DIR = APP

const { Hono } = await import('hono')
const {
  buildOutputs,
  chatWorkspaceBlock,
  chatWorkspaces,
  cleanupApi,
  clearStaleWorktrees,
  deadWorktreeLinks,
  dirSize,
  staleWorktrees,
  sweepTaskInfoOf,
} = await import('./cleanup.ts')
const { CHATS_DIR, DATA_DIR } = await import('./store.ts')
const { WORKTREES_DIR } = await import('./exec/worktree.ts')
const { CHAT_WORKSPACE_TOP_N, CleanupReport, WorktreeCleanup } = await import('../shared/data.ts')

const DAY = new Date('2025-01-01T00:00:00.000Z').toISOString()
const t0 = '2025-01-01T00:00:00.000Z'

const task = (id: string, extra: Record<string, unknown> = {}) =>
  Task.parse({ id, projectId: '', title: id, mode: 'chat', status: 'done', createdAt: t0, updatedAt: t0, ...extra })

/** 假的对话记录：清理接口只读它判「在不在 / 回收站 / 在跑」，不写 */
const fakeTasks = (rows: Task[], working: string[] = []) => ({
  list: async () => rows,
  workingTasks: () => working.map((id) => ({ id })),
  get: async (id: string) => rows.find((r) => r.id === id) ?? null,
})
const fakeProjects = { list: async () => [], get: async () => null }
const api = (tasks: ReturnType<typeof fakeTasks>) =>
  new Hono().route('/data/cleanup', cleanupApi({ tasks, projects: fakeProjects }))

/** 每个用例从干净的工作目录开始：统计以 chats/ 下的目录为准，残留会互相干扰 */
const freshChats = () => rmSync(CHATS_DIR, { recursive: true, force: true })

/** 在对话工作目录里写几个文件（大小可控），模拟 Agent 下载的网页快照 */
const chatDir = (id: string, files: { name: string; bytes: number }[]) => {
  const dir = path.join(CHATS_DIR, id)
  mkdirSync(dir, { recursive: true })
  for (const f of files) writeFileSync(path.join(dir, f.name), 'x'.repeat(f.bytes))
  return dir
}

test('目录占用递归统计，不跟随链接（链接指向数据目录外面，跟进去会算成这里的）', async () => {
  const dir = path.join(tmp, 'size-a')
  mkdirSync(path.join(dir, 'sub'), { recursive: true })
  writeFileSync(path.join(dir, 'a.bin'), 'x'.repeat(10))
  writeFileSync(path.join(dir, 'sub', 'b.bin'), 'x'.repeat(20))
  assert.deepEqual(await dirSize(dir), { bytes: 30, files: 2 })
  // 读不到（多半是刚被删 / 失效链接）算 0，不抛
  assert.deepEqual(await dirSize(path.join(tmp, 'nope')), { bytes: 0, files: 0 })

  const outside = path.join(tmp, 'outside.bin')
  writeFileSync(outside, 'x'.repeat(10_000))
  const linked = path.join(tmp, 'size-link')
  mkdirSync(linked, { recursive: true })
  symlinkSync(outside, path.join(linked, 'big'), 'file')
  const linkedSize = await dirSize(linked)
  assert.ok(linkedSize.bytes < 1000, `链接只算链接本身，不算目标文件：${linkedSize.bytes}`)
})

test('对话工作目录：按大小倒序、回收站与在跑标出来、没有目录的对话不列', async () => {
  freshChats()
  chatDir('big', [{ name: 'snapshot.html', bytes: 300 }])
  chatDir('small', [{ name: 'a.txt', bytes: 10 }])
  chatDir('trashed', [{ name: 'a.txt', bytes: 50 }])
  chatDir('busy', [{ name: 'a.txt', bytes: 20 }])
  const tasks = fakeTasks(
    [
      task('big'),
      task('small'),
      // 回收站里的：保留期内恢复还要用这个目录
      task('trashed', { deletedAt: DAY }),
      task('busy', { working: true }),
      // 记录在、但没有工作目录（大多数对话）
      task('empty'),
    ],
    ['small'],
  )
  const r = await chatWorkspaces(tasks)
  assert.deepEqual(
    r.top.map((x) => x.id),
    ['big', 'trashed', 'busy', 'small'],
    '按占用倒序，没有目录的对话不列',
  )
  assert.equal(r.bytes, 380, '合计是全部工作目录（不只是前 N 个）')
  assert.equal(r.files, 4)
  assert.equal(r.more, 0)
  assert.equal(r.top.find((x) => x.id === 'trashed')!.trashed, true, '回收站里的标出来')
  assert.equal(r.top.find((x) => x.id === 'small')!.running, true, '内存里在跑的标出来')
  assert.equal(r.top.find((x) => x.id === 'busy')!.running, true, '记录里 working 的也算在跑')
  assert.equal(r.top.find((x) => x.id === 'big')!.orphan, false, '有记录的目录不是孤儿')
})

test('对话工作目录以目录为准：记录已删的孤儿目录也列出来、也能清（和 /data 的口径一致）', async () => {
  freshChats()
  chatDir('orphan', [{ name: 'a.txt', bytes: 30 }])
  // 任务记录里一个都没有
  const r = await chatWorkspaces(fakeTasks([]))
  assert.equal(r.bytes, 30, '孤儿目录计入合计（/data 的 workspace 也是这么算的）')
  assert.equal(r.top[0].id, 'orphan')
  assert.equal(r.top[0].orphan, true, '标成孤儿，界面按「记录已删除」显示')
  assert.equal(r.top[0].trashed, false)
  assert.equal(r.top[0].running, false)

  const res = await api(fakeTasks([])).request('/data/cleanup/chat', {
    method: 'POST',
    body: JSON.stringify({ id: 'orphan' }),
  })
  assert.equal(res.status, 200, '记录没了、目录还在的可以清')
  assert.equal(existsSync(path.join(CHATS_DIR, 'orphan')), false)
})

test(`只列前 ${CHAT_WORKSPACE_TOP_N} 个，其余计入合计和 more`, async () => {
  freshChats()
  const n = CHAT_WORKSPACE_TOP_N + 1
  const rows = Array.from({ length: n }, (_, i) => task(`t${i}`))
  for (let i = 0; i < n; i++) chatDir(`t${i}`, [{ name: 'a.txt', bytes: i + 1 }])
  const r = await chatWorkspaces(fakeTasks(rows))
  assert.equal(r.top.length, CHAT_WORKSPACE_TOP_N)
  assert.equal(r.more, 1)
  assert.equal(r.top[0].id, `t${n - 1}`, '最大的排最前')
  assert.equal(
    r.bytes,
    Array.from({ length: n }, (_, i) => i + 1).reduce((a, b) => a + b, 0),
  )
})

test('清理工作目录：回收站、在跑的对话要拒绝，并说明原因', async () => {
  freshChats()
  chatDir('keep', [{ name: 'a.txt', bytes: 10 }])
  chatDir('gone', [{ name: 'a.txt', bytes: 10 }])
  chatDir('run', [{ name: 'a.txt', bytes: 10 }])
  const app = api(fakeTasks([task('keep'), task('gone', { deletedAt: DAY }), task('run', { working: true })], ['run']))
  const post = (id: string) => app.request('/data/cleanup/chat', { method: 'POST', body: JSON.stringify({ id }) })

  const trashed = await post('gone')
  assert.equal(trashed.status, 409)
  assert.match(((await trashed.json()) as { error: string }).error, /回收站/)
  assert.ok(existsSync(path.join(CHATS_DIR, 'gone')), '回收站里的目录没被删')

  const running = await post('run')
  assert.equal(running.status, 409)
  assert.match(((await running.json()) as { error: string }).error, /正在执行/)
  assert.ok(existsSync(path.join(CHATS_DIR, 'run')), '在跑的目录没被删')

  // 没有这个目录时给出明确原因，不能悄悄返回成功
  const missing = await post('nope')
  assert.equal(missing.status, 404)
  assert.equal(existsSync(path.join(CHATS_DIR, 'nope')), false)
})

test('清理工作目录只删目录内容，对话记录（tasks/）不动，下次执行会重建', async () => {
  freshChats()
  chatDir('chat1', [{ name: 'a.txt', bytes: 40 }])
  mkdirSync(path.join(DATA_DIR, 'tasks'), { recursive: true })
  const record = path.join(DATA_DIR, 'tasks', 'tasks.json')
  writeFileSync(record, '[]')

  const res = await api(fakeTasks([task('chat1')])).request('/data/cleanup/chat', {
    method: 'POST',
    body: JSON.stringify({ id: 'chat1' }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { ok: boolean; bytes: number }
  assert.equal(body.ok, true)
  assert.equal(body.bytes, 40, '返回释放了多少')
  assert.equal(existsSync(path.join(CHATS_DIR, 'chat1')), false, '目录被删掉')
  assert.equal(existsSync(record), true, '对话记录还在')
})

test('清理接口只认 chats/ 下的目录名：../tasks 这种拼路径的请求要被拒绝', async () => {
  const tasksDir = path.join(DATA_DIR, 'tasks')
  mkdirSync(tasksDir, { recursive: true })
  writeFileSync(path.join(tasksDir, 'tasks.json'), '[]')
  for (const id of ['../tasks', '..', 'a/b', '']) {
    const res = await api(fakeTasks([])).request('/data/cleanup/chat', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
    assert.ok(res.status >= 400, `id=${JSON.stringify(id)} 不该被接受`)
  }
  assert.ok(existsSync(path.join(tasksDir, 'tasks.json')), '任务记录目录没被动')
})

test('chatWorkspaceBlock：孤儿放行，回收站和在跑各有原因', () => {
  assert.equal(chatWorkspaceBlock(null, false), '', '记录不在了的孤儿目录可以直接清')
  assert.equal(chatWorkspaceBlock(task('a'), false), '')
  assert.match(chatWorkspaceBlock(task('a', { deletedAt: DAY }), false), /回收站/)
  assert.match(chatWorkspaceBlock(task('a'), true), /正在执行/)
})

test('sweepTaskInfoOf 每次都重新读在跑的任务：面板启动时为空也不会让保护一直失效', async () => {
  const rows = [task('later')]
  let working: string[] = []
  const tasks = {
    list: async () => rows,
    workingTasks: () => working.map((id) => ({ id })),
    get: async (id: string) => rows.find((r) => r.id === id) ?? null,
  }
  const info = sweepTaskInfoOf(tasks, fakeProjects)
  assert.equal((await info('later'))?.working, false, '还没跑')
  working = ['later']
  assert.equal((await info('later'))?.working, true, '之后跑起来了要算在跑：读的是当前任务，不是创建这个函数时的快照')
  assert.equal((await info('missing'))?.working, undefined, '记录不在了返回 null')
})

// ---- 独立分支：判定复用 sweepWorktrees，这里只验「什么进清单、清完真的少了」 ----

const gitEnv = () => {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_COMMON_DIR
  return env
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' })

/** 一个有提交、能开 worktree 的项目 */
function project() {
  const dir = mkdtempSync(path.join(tmp, 'repo-'))
  git(dir, 'init', '-q', '-b', 'dev')
  git(dir, 'config', 'user.email', 'a@example.com')
  git(dir, 'config', 'user.name', 't')
  writeFileSync(path.join(dir, 'README.md'), '# demo\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

/** 在 worktrees 下开一个独立目录（createWorktree 的位置固定在数据目录，这里自己指定名字） */
function worktreeAt(repo: string, name: string, commit = false) {
  const dir = path.join(WORKTREES_DIR, name)
  const branch = `agent-panel/${name}`
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir, 'HEAD')
  if (commit) {
    writeFileSync(path.join(dir, 'x.txt'), 'x\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', '还没合回原分支的改动')
  }
  return { dir, branch }
}

test('失效目录判定：已合回且收口的进清单，没合回 / 在跑 / 回收站的不进；死链单独列', async () => {
  const repo = project()
  const merged = worktreeAt(repo, 'merged1')
  const unmerged = worktreeAt(repo, 'unmerged1', true)
  const busy = worktreeAt(repo, 'busy1')
  const trashed = worktreeAt(repo, 'trashed1')
  // 失效链接：目标不存在。junction 在 Windows 上不需要管理员权限
  const broken = path.join(WORKTREES_DIR, 'broken-link')
  symlinkSync(path.join(tmp, 'gone-target'), broken, 'junction')
  assert.deepEqual(await deadWorktreeLinks(WORKTREES_DIR), [broken], '只有没目标的链接算死链')

  const rows = [task('merged1'), task('unmerged1'), task('busy1'), task('trashed1', { deletedAt: DAY })]
  const taskInfo = sweepTaskInfoOf(fakeTasks(rows, ['busy1']), fakeProjects)
  // minAgeMs: 0：刚建出来也要参与判定（真实运行默认 10 分钟内不动）
  const stale = await staleWorktrees({ taskInfo, minAgeMs: 0 })
  const dirs = stale.map((s) => s.dir).sort()
  assert.ok(
    dirs.some((d) => d.endsWith('merged1')),
    `已合回、任务收口的进清单：${dirs.join(', ')}`,
  )
  assert.ok(
    dirs.some((d) => d.endsWith('broken-link')),
    '失效链接进清单',
  )
  assert.ok(!dirs.some((d) => d.endsWith('unmerged1')), '分支上还有没合回的提交，不动')
  assert.ok(!dirs.some((d) => d.endsWith('busy1')), '在跑的任务目录不动')
  assert.ok(!dirs.some((d) => d.endsWith('trashed1')), '回收站里的对话，目录要留着恢复')
  assert.ok(stale.find((s) => s.dir.endsWith('merged1'))!.bytes > 0, '清单带上占用')

  // 真清：清单里的一起清掉，没进清单的原样留着
  const res = await clearStaleWorktrees({ taskInfo, minAgeMs: 0 })
  assert.equal(res.removed, 2, '一个目录 + 一个死链')
  assert.ok(res.bytes > 0)
  assert.equal(existsSync(merged.dir), false, '失效目录被删')
  assert.equal(existsSync(broken), false, '死链被删')
  assert.ok(existsSync(unmerged.dir), '没合回的还在')
  assert.ok(existsSync(busy.dir), '在跑的还在')
  assert.ok(existsSync(trashed.dir), '回收站的还在')
  assert.deepEqual(await deadWorktreeLinks(WORKTREES_DIR), [], '死链清干净了')
})

test('构建产物：统计各目录占用，清理后目录没了并报释放量', async () => {
  mkdirSync(path.join(APP, 'dist', 'assets'), { recursive: true })
  writeFileSync(path.join(APP, 'dist', 'index.html'), 'x'.repeat(100))
  writeFileSync(path.join(APP, 'dist', 'assets', 'app.js'), 'x'.repeat(200))
  mkdirSync(path.join(APP, 'release'), { recursive: true })
  writeFileSync(path.join(APP, 'release', 'app.zip'), 'x'.repeat(300))
  const before = await buildOutputs(APP)
  assert.equal(before.find((b) => b.id === 'dist')!.bytes, 300)
  assert.equal(before.find((b) => b.id === 'dist')!.present, true)
  assert.equal(before.find((b) => b.id === 'release')!.bytes, 300)
  assert.equal(before.find((b) => b.id === 'ui-shots')!.present, false, '不在的目录标出来，不显示成 0 B')

  const res = await api(fakeTasks([])).request('/data/cleanup/builds', { method: 'POST', body: '{}' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { bytes: number }).bytes, 600)
  assert.equal(existsSync(path.join(APP, 'dist')), false)
  assert.equal(existsSync(path.join(APP, 'release')), false)
})

test('GET /data/cleanup 只回对话目录和构建产物；独立分支走单独接口（不跟设置页每次打开一起扫）', async () => {
  freshChats()
  chatDir('one', [{ name: 'a.txt', bytes: 7 }])
  const app = api(fakeTasks([task('one')]))
  const res = await app.request('/data/cleanup')
  assert.equal(res.status, 200)
  const body = CleanupReport.parse(await res.json())
  assert.equal(body.chats.top[0].id, 'one')
  assert.equal(body.chats.bytes, 7)
  assert.equal(body.builds.length, 4)
  assert.ok(!('worktrees' in body), 'worktrees 不在这一份里')

  const wt = await app.request('/data/cleanup/worktrees')
  assert.equal(wt.status, 200)
  const out = WorktreeCleanup.parse(await wt.json())
  // 前面用例留下的 worktree 还在：独立分支这一块要有数字，不能是 undefined
  assert.equal(typeof out.bytes, 'number')
  assert.ok(Array.isArray(out.stale))
})
