/**
 * 端到端测试分片：对话里的 Agent 按用户指令操控软件（ADR 0011 的动作表）。
 * 走完整链路：CLI 调面板 MCP 的 app_do → 动作表 → 进程内调面板接口，和用户点按钮是同一段代码
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { runShard } from './harness.mjs'

await runShard('Agent 操控软件', async (api) => {
  const { log, call, waitFor, waitDone, waitTask, calls, step, setupBase } = api
  const { project, B } = await setupBase()
  const panelLog = () =>
    existsSync(`${log}.panel`)
      ? readFileSync(`${log}.panel`, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
  const chat = (prompt, extra = {}) =>
    call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt, ...extra })

  // ---- 用户说「停掉所有后台任务」：对话自己调 task.stop_background，后台命令停下，对话本身不停 ----
  {
    let parent = await chat('BG_LONG BG_SLOW 起一个慢命令')
    parent = await waitTask(parent.id, (t) => (t.jobs ?? []).some((j) => j.state === 'running'), 20000)
    await waitDone(parent.id, 20000).catch(() => {})
    await call('POST', `/tasks/${parent.id}/messages`, {
      text: '停掉所有后台任务 APP_DO:{"action":"task.stop_background"}',
    })
    await waitFor(() => panelLog().some((x) => x.name === 'app_do'), { label: '对话调了 app_do' })
    const got = panelLog().find((x) => x.name === 'app_do')
    assert.equal(got.isError, false, `app_do 执行成功：${got.text}`)
    assert.match(got.text, /"stopped": 1/, '停了那一条后台命令')
    const after = await waitTask(parent.id, (t) => !(t.jobs ?? []).some((j) => j.state === 'running'), 20000)
    assert.ok(after, '后台命令停下了')
    assert.ok(
      calls().some((c) => c.input.includes('app_actions') && c.input.includes('APP_DO')),
      '对话的输入里带上了操控软件的用法说明',
    )
    step('用户指令：对话调 app_do 停掉自己的全部后台命令')

    // ---- 用户说「关闭全部子对话」：父对话调 task.stop_children，在跑的子对话停下 ----
    const kid = await chat('SLOW 子对话慢慢做', { parentTaskId: parent.id })
    await waitFor(() => calls().some((c) => c.input.includes('SLOW 子对话慢慢做')), { label: '子对话开始执行' })
    await waitDone(parent.id, 20000).catch(() => {})
    const before = panelLog().length
    await call('POST', `/tasks/${parent.id}/messages`, {
      text: '关闭全部子对话 APP_DO:{"action":"task.stop_children"}',
    })
    await waitFor(() => panelLog().length > before, { label: '父对话调了 app_do' })
    const stopped = panelLog().at(-1)
    assert.equal(stopped.isError, false, `stop_children 执行成功：${stopped.text}`)
    const k = await waitTask(kid.id, (t) => t.status === 'stopped', 20000)
    assert.equal(k.status, 'stopped', '在跑的子对话被停下')
    step('用户指令：父对话调 app_do 关闭全部子对话')

    // ---- 删除自己所在的对话被拒绝，原因交回给模型 ----
    const n = panelLog().length
    await call('POST', `/tasks/${kid.id}/messages`, {
      text: `删掉父对话 APP_DO:{"action":"task.delete","args":{"id":"${parent.id}"}}`,
    })
    await waitFor(() => panelLog().length > n, { label: '子对话调了 app_do' })
    const refused = panelLog().at(-1)
    assert.equal(refused.isError, true, '不能删父对话')
    assert.match(refused.text, /父对话/)
    assert.ok(await call('GET', `/tasks/${parent.id}`), '父对话还在')
    step('边界：子对话不能删自己的父对话')
  }

  // ---- 人和脚本的 HTTP 入口是同一份动作表 ----
  {
    const list = await call('GET', '/actions')
    assert.ok(list.some((a) => a.name === 'task.stop_subtasks' && a.level === 'danger'))
    const saved = await call('POST', '/actions/settings.set', { patch: { backgroundLimit: 4 } })
    assert.deepEqual(saved, { backgroundLimit: 4 })
    assert.equal((await call('GET', '/settings')).backgroundLimit, 4)
    const denied = await call('POST', '/actions/settings.set', { patch: { requireToken: true } }).catch((e) => e)
    assert.ok(denied instanceof Error, '访问令牌开关不能由动作改')
    step('HTTP 入口：列动作、改设置，密钥和访问控制不能改')
  }
})
