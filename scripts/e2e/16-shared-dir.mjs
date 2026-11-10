/**
 * 几个对话共用项目目录（都没开独立分支）时的保护（分析稿 A1）：
 * - 每轮的改动按文件归属：两个对话同时在项目目录里各改各的文件，各自的改动卡片只有自己的文件，撤销互不影响；
 * - 发送前的提醒：同目录有别的对话正在改文件时接口给出它，「这个对话开独立分支」之后不再提醒、下一句在分支目录里做。
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs）。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { runShard } from './harness.mjs'

await runShard('同目录多个对话：改动归属和提醒', async (api) => {
  const { call, waitFor, waitDone, calls, step, setupBase, clearCliOutputs } = api
  const { project } = await setupBase()
  const chat = (cli, prompt) =>
    call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: '', cli, prompt })
  const claudeFile = path.join(project.path, 'claude-output.txt')
  const codexFile = path.join(project.path, 'codex-output.txt')
  /** 等这个对话的每轮改动记上（快照比这一轮的结束晚一点） */
  const withChanges = (id) =>
    waitFor(
      async () => {
        const x = await call('GET', `/tasks/${id}`)
        const m = x.messages.find((y) => y.turnChanges?.files.length)
        return m ? { task: x, msg: m } : null
      },
      { timeout: 15000, label: '这一轮记下了改动' },
    )

  // 第三个对话先做完一轮放着：后面站在它的输入框前看提醒
  let idle = await chat('claude', '先放着的对话')
  idle = await waitDone(idle.id, 20000)
  clearCliOutputs(project.path)

  // ---- 两个对话同时在项目目录里改不同的文件 ----
  // 甲（Claude Code）写 claude-output.txt，乙（Codex）写 codex-output.txt；都带 SLOW，两轮一定重叠。
  // 甲先开始：它收尾时乙还没写，乙收尾时甲的文件已经在目录里——以前乙的卡片会把甲的文件也算进来
  const a0 = await chat('claude', 'SLOW 甲对话写文件')
  await waitFor(() => calls().some((c) => c.input.includes('SLOW 甲对话写文件')), { label: '甲开始执行' })
  const b0 = await chat('codex', 'SLOW 乙对话写文件')
  assert.ok(!a0.worktree && !b0.worktree, '两个对话都没开独立分支，共用项目目录')
  await waitDone(a0.id, 40000)
  await waitDone(b0.id, 40000)
  assert.ok(existsSync(claudeFile) && existsSync(codexFile), '两个对话各写了自己的文件')
  const a = await withChanges(a0.id)
  const b = await withChanges(b0.id)
  assert.deepEqual(
    a.msg.turnChanges.files.map((f) => f.path),
    ['claude-output.txt'],
    '甲的卡片只有甲的文件',
  )
  assert.deepEqual(
    b.msg.turnChanges.files.map((f) => f.path),
    ['codex-output.txt'],
    '乙的卡片只有乙的文件',
  )
  assert.deepEqual(b.msg.turnChanges.others, ['claude-output.txt'], '乙的卡片记下剔除了甲改的那个文件，界面据此说明')
  step('两个对话同目录同时改不同文件：各自的改动卡片只有自己的文件')

  // 撤销乙的这一轮：只撤乙的文件，甲的还在；再撤甲的
  const rb = await call('POST', `/tasks/${b0.id}/turn-revert`, { msg: b.msg.id })
  assert.equal(rb.ok, true)
  assert.deepEqual(rb.files, ['codex-output.txt'])
  assert.ok(!existsSync(codexFile), '乙新建的文件撤掉了')
  assert.ok(existsSync(claudeFile), '撤销乙的改动不动甲的文件')
  const ra = await call('POST', `/tasks/${a0.id}/turn-revert`, { msg: a.msg.id })
  assert.equal(ra.ok, true)
  assert.ok(!existsSync(claudeFile), '甲自己的文件由甲撤')
  step('撤销互不影响：撤乙的不动甲的文件')

  // ---- 发送前的提醒 ----
  // 没有别的对话在跑：不提醒
  assert.deepEqual(await call('GET', `/tasks/${idle.id}/shared-dir`), { peers: [], canIsolate: false })
  // 甲上一轮改过文件、现在又在跑：站在第三个对话里要提醒，并且可以让这个对话开独立分支
  await call('POST', `/tasks/${a0.id}/messages`, { text: 'SLOW 甲接着改' })
  const info = await waitFor(
    async () => {
      const x = await call('GET', `/tasks/${idle.id}/shared-dir`)
      return x.peers.length ? x : null
    },
    { label: '同目录有对话正在改文件' },
  )
  assert.deepEqual(
    info.peers.map((p) => p.id),
    [a0.id],
    '只列正在跑、最近改过文件的甲；停着的乙不列',
  )
  assert.equal(info.canIsolate, true)
  // 正在跑的对话自己不能这时候换目录
  await assert.rejects(call('POST', `/tasks/${a0.id}/isolate`), /409/)
  const moved = await call('POST', `/tasks/${idle.id}/isolate`)
  assert.equal(moved.worktree?.state, 'active', '这个对话开了自己的独立分支')
  assert.notEqual(moved.worktree.path, project.path)
  assert.deepEqual((await call('GET', `/tasks/${idle.id}/shared-dir`)).peers, [], '开了独立分支就不再和别人共用目录')
  await assert.rejects(call('POST', `/tasks/${idle.id}/isolate`), /409/)
  await call('POST', `/tasks/${idle.id}/messages`, { text: '在分支里接着做' })
  await waitDone(idle.id, 20000)
  const last = calls()
    .filter((c) => c.input.includes('在分支里接着做'))
    .at(-1)
  assert.equal(last.cwd, moved.worktree.path, '下一句在独立分支的目录里执行')
  assert.ok(existsSync(path.join(moved.worktree.path, 'claude-output.txt')), '文件写在分支目录里，不写进项目目录')
  await call('POST', `/tasks/${a0.id}/stop`)
  step('发送前的提醒：同目录有对话正在改文件时给出它；这个对话开独立分支后不再提醒，下一句在分支目录里做')
})
