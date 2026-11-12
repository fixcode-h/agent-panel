/**
 * 后台命令的记录落盘：面板异常退出后重启，那一行的收口说明写得出当时跑到了哪（server/bg-persist.ts）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBackground, reapLostJobs } from './background.ts'
import { createBgPersist } from './bg-persist.ts'

const until = async (cond: () => boolean) => {
  const end = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > end) assert.fail('等不到')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('没结束的记录写盘；重启后收口说明写清在跑还是在排队、最后的输出和日志路径，取过一次就删', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bg-persist-'))
  const file = path.join(dir, 'bg-jobs.json')
  const persist = createBgPersist(file)
  const bg = createBackground(() => {}, { run: (() => new Promise(() => {})) as never, persist, logDir: dir })
  const a = bg.start({ taskId: 't', name: '编译', command: 'make all', cwd: '', root: dir, exclusive: true })
  const b = bg.start({ taskId: 't', name: '打包', command: 'make dist', cwd: '', root: dir, exclusive: true })
  await until(() => bg.list('t').some((j) => j.state === 'running' && !!j.logFile))
  const running = bg.list('t').find((j) => j.state === 'running')!
  writeFileSync(running.logFile!, '$ make all\nCompiling a.cpp\nCompiling b.cpp\n')
  persist.flush()
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { id: string; state: string }[]
  assert.deepEqual(saved.map((x) => [x.id, x.state]).sort(), [
    [a.id!, 'running'],
    [b.id!, 'queued'],
  ])

  // 面板被强杀后重启：新的一份认不出这两条，但写得出说明
  const again = createBackground(() => {}, { persist: createBgPersist(file), logDir: dir })
  assert.equal(again.known(a.id!), false)
  const task = {
    messages: [
      {
        tools: [{ kind: 'other', label: 'panel · run_background', detail: '', output: `已放到后台（编号 ${a.id}）。` }],
      },
    ],
  } as unknown as Parameters<typeof reapLostJobs>[0]
  assert.equal(reapLostJobs(task, again.known, again.lostNote), 1)
  const out = task.messages[0].tools[0].output ?? ''
  assert.match(out, /跑着的时候面板异常退出了/)
  assert.match(out, /Compiling b\.cpp/)
  assert.match(out, /完整日志：/)
  assert.match(again.lostNote(b.id!) ?? '', /还在排队、没开始跑/)
  assert.equal(again.lostNote(a.id!), undefined, '取过一次就删')
})
