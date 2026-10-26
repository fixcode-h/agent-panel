/**
 * 端到端分片：勾了「禁止子对话执行」的测试步骤由父对话在合并后跑（ADR 0018）
 *
 * 覆盖的是整条链路，不是提示词：
 * - 子对话合并前不跑这条步骤；合并成功后父对话在自己的目录里真跑它（后台命令），
 *   结果和真实耗时回传给子对话，通过才标完成、删分支；
 * - 步骤失败时子对话不被标完成、独立分支保留，报错里写明「来自子对话「标题」（id）」；
 * - 再合一次时面板把步骤重跑一遍（tries 累加，不因为跑过一次就跳过）；
 * - 子对话自己跑过的项目步骤也记耗时（by='self'），和父对话跑的那条在同一份记录里；
 * - GET /fs/vcs 能把 Git 和非 Git 目录分开（设置页据此置灰，只对 Git 项目生效）。
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import { runShard } from './harness.mjs'

await runShard('父对话执行测试步骤', async (api) => {
  const { call, waitTask, waitDone, waitFor, calls, sleep, step, setupBase, tmp } = api
  const { project, A, B } = await setupBase()
  const { id: _id, createdAt: _c, updatedAt: _u, ...projectInput } = project

  // 一条要父对话跑的步骤 + 一条子对话自己跑的步骤：命令都真跑，耗时是后台命令的真实起止时间
  const parentStep = (command) => ({
    id: 'e2e-parent',
    name: '端到端测试',
    command,
    env: 'auto',
    cwd: '',
    when: '',
    appliesTo: [],
    timeoutSec: 60,
    note: '',
    enabled: true,
    merge: false,
    runInParent: true,
    quick: false,
  })
  const selfStep = {
    id: 'e2e-self',
    name: '自测步骤',
    command: 'node -e "setTimeout(()=>{},300)"',
    env: 'auto',
    cwd: '',
    when: '',
    appliesTo: [],
    timeoutSec: 60,
    note: '',
    enabled: true,
    merge: false,
    runInParent: false,
    quick: false,
  }
  const putSteps = (steps) =>
    call('PUT', `/projects/${project.id}`, { ...projectInput, childIsolation: 'worktree', testSteps: steps })
  const newParent = async (prompt) =>
    waitDone((await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt })).id, 20000)
  // fake-cli 在父对话的目录里写了输出文件，是未跟踪文件：不清掉会挡住子对话分支的合并
  const cleanOutputs = () => {
    for (const f of ['codex-output.txt', 'claude-output.txt']) rmSync(path.join(project.path, f), { force: true })
  }
  const newKid = (parentId, prompt) => {
    cleanOutputs()
    return call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      parentTaskId: parentId,
      prompt,
    })
  }
  // 子对话第一轮在项目根写完自己的输出文件（未跟踪）后，面板才在分支目录里接着做；
  // 这个文件留在合并目标目录里会挡住 git merge。等第二轮真的在分支目录里开始（第一轮已结束）再删，
  // 早删会被第一轮补写回来
  const dropRootOutput = async (kidId) => {
    const wt = await waitTask(kidId, (x) => x.worktree?.state === 'active', 20000)
    await waitFor(() => calls().some((c) => c.cwd === wt.worktree.path), {
      timeout: 20000,
      label: '子对话第二轮在分支目录里开始',
    })
    rmSync(path.join(project.path, 'codex-output.txt'), { force: true })
  }

  // ---- 通过：合并后父对话跑，子对话拿到结果和耗时才收尾 ----
  await putSteps([parentStep('node -e "setTimeout(()=>{},400)"'), selfStep])
  const parent = await newParent('父对话')
  const kid = await newKid(parent.id, 'COMMIT BEGIN_EDIT BG_TESTSTEP SUBMIT_MERGE 子对话的改动')
  await dropRootOutput(kid.id)
  const merged = await waitTask(kid.id, (x) => x.resolved && x.worktree?.state === 'merged', 60000)
  const parentRuns = merged.testRuns.filter((r) => r.by === 'parent')
  assert.equal(parentRuns.length, 1, '父对话跑过的那条步骤记在子对话的任务上')
  assert.equal(parentRuns[0].stepName, '端到端测试')
  assert.equal(parentRuns[0].ok, true)
  // 命令自己就跑 400ms，记录不能是 0 或估算出来的整数
  assert.ok(parentRuns[0].durationMs >= 350, `父对话跑的耗时是真实用时，拿到 ${parentRuns[0].durationMs}ms`)
  const selfRuns = merged.testRuns.filter((r) => r.by === 'self')
  assert.ok(selfRuns.length, '子对话自己跑的测试步骤也记耗时')
  assert.equal(selfRuns[0].stepName, '自测步骤')
  assert.ok(selfRuns[0].durationMs >= 250, `自己跑的耗时也是真实用时，拿到 ${selfRuns[0].durationMs}ms`)
  const passed = merged.messages.find((m) => (m.text ?? '').includes('父对话测试通过'))
  assert.ok(passed, '父对话测试通过的结果回传给了子对话')
  assert.match(passed.text, /- 端到端测试：父对话跑，通过，/) // 收尾总结要照抄的耗时行
  step('通过：子对话合并后不自己跑，父对话跑完把结果和真实耗时回传，子对话才收尾')

  // ---- 失败：报错写明来自哪个子对话，不标完成、分支保留，再合并时重跑 ----
  await putSteps([parentStep('node -e "process.exit(3)"')])
  const parent2 = await newParent('父对话（失败场景）')
  const kid2 = await newKid(parent2.id, 'COMMIT BEGIN_EDIT SUBMIT_MERGE 会失败的改动')
  await dropRootOutput(kid2.id)
  const failed = await waitTask(
    kid2.id,
    (x) => x.messages.some((m) => (m.text ?? '').includes('父对话测试未通过')),
    60000,
  )
  assert.ok(!failed.resolved, '父对话测试没过不能标完成')
  assert.equal(failed.worktree?.state, 'active', '独立分支保留，子对话还能接着修')
  const failText = failed.messages.find((m) => (m.text ?? '').includes('父对话测试未通过')).text
  assert.match(failText, new RegExp(`来自子对话「${kid2.title}」（id ${kid2.id}）`), '报错标明来自哪个子对话')
  assert.match(failText, /第 1 步「端到端测试」失败/)
  assert.equal(failed.testRuns.find((r) => r.by === 'parent').ok, false)
  step('失败：报错带上子对话标题和 id，不标完成、分支保留')

  // 修好再合一次：面板重跑这些步骤（跑过也不跳过），失败记录累计到第 2 次
  await call('POST', `/tasks/${kid2.id}/messages`, { text: 'SUBMIT_MERGE 修好了再合一次' })
  const again = await waitTask(
    kid2.id,
    (x) => x.messages.filter((m) => (m.text ?? '').includes('父对话测试未通过')).length >= 2,
    60000,
  )
  const run2 = again.testRuns.find((r) => r.by === 'parent')
  // fake-cli 的一轮里可能再请一次收尾，跑几次不是断言重点：tries 至少 2 就说明没有「跑过一次就跳过」
  assert.ok(run2.tries >= 2, `再合并时这些步骤重跑，不因为跑过一次就跳过（tries=${run2.tries}）`)
  assert.ok(!again.resolved, '仍然失败时不标完成')
  step('失败后重新合并：父对话再跑一遍这些步骤，tries 累加')

  // ---- 丢弃独立分支：父对话测试的批次取消、状态清掉，不再拦住标记完成（评审 R4 / R2）----
  // 失败消息会叫醒它跑一轮；等它停下来再丢弃（执行中不允许丢分支）
  await waitTask(kid2.id, (x) => !x.working, 30000)
  let dropped
  for (let i = 0; i < 20 && !dropped; i++) {
    try {
      dropped = await call('POST', `/tasks/${kid2.id}/worktree/discard`)
    } catch (e) {
      if (!/执行|合并/.test(e?.message ?? String(e))) throw e
      await sleep(300)
    }
  }
  assert.ok(dropped, '等它停下来后可以丢弃独立分支')
  // 分支已经合回过：丢弃时记 merged；没合回的记 discarded。两种都表示目录和分支没了
  assert.ok(['discarded', 'merged'].includes(dropped.worktree.state), `独立分支已回收（${dropped.worktree.state}）`)
  assert.equal(dropped.wrapRequest, undefined, '丢弃后不再留着 testing / test-failed')
  assert.ok(
    (dropped.plans?.at(-1)?.steps ?? []).filter((s) => s.wrapUp === 'merge').every((s) => s.status === 'done'),
    '计划里的合回收尾步骤一并收口，不再拦住完成',
  )
  // 丢弃后可能还有失败消息在送达、叫醒它跑一轮：等它停下来再标记完成（并行跑分片时更明显）
  await waitTask(kid2.id, (x) => !x.working, 30000)
  let completed
  for (let i = 0; i < 20 && !completed?.resolved; i++) {
    try {
      completed = await call('PATCH', `/tasks/${kid2.id}`, { resolved: true })
    } catch (e) {
      if (!/执行|计划|父对话的测试/.test(e?.message ?? '')) throw e
      await sleep(300)
    }
  }
  assert.ok(completed?.resolved, `丢弃分支后可以标记完成，不再被父对话测试拦住（${completed?.resolved}）`)
  step('丢弃独立分支：取消批次、清掉状态和收尾步骤，标记完成能通过')

  // ---- 只对 Git 项目生效：判定复用 detectVcs，设置页据此置灰 ----
  const nonGit = path.join(tmp, 'nongit')
  mkdirSync(nonGit, { recursive: true })
  assert.equal((await call('GET', `/fs/vcs?path=${encodeURIComponent(nonGit)}`)).vcs, 'none')
  assert.equal((await call('GET', `/fs/vcs?path=${encodeURIComponent(project.path)}`)).vcs, 'git')
  step('非 Git 目录能被分辨出来：「禁止子对话执行」只在 Git 项目里生效')
})
