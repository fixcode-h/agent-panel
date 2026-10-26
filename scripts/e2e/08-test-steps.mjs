/**
 * 端到端分片：项目测试步骤按改动范围筛选
 *
 * 断言的是交给测试角色的提示词本身（fake-cli 不会真的跑构建）：
 * - 步骤带着结构化的「适用改动」，没写的步骤标成「总是执行」；
 * - 先取改动清单再决定跑哪些，清单取「任务基线...HEAD」（三点比较，含合并进来的内容）；
 * - 拉取 / 合并进来的改动同样计入，不能以「不是我改的」为理由跳过；
 * - 跳过的步骤要写理由，一条都不匹配时也要说明，不许为了保险全跑。
 *
 * 判定本身（哪条步骤匹配哪批文件，含「只改了文档但合并进来 C++ 改动」）在
 * shared/test-steps.test.ts 里用真实改动清单断言，这里管的是提示词有没有把规则交到角色手上。
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs）。
 */
import assert from 'node:assert/strict'

import { runShard } from './harness.mjs'

await runShard('测试步骤筛选', async (api) => {
  const { call, waitDone, calls, step, projectDir, putSettings } = api
  // 设置里没启用的 CLI 不会被执行（默认都不启用），先按别的分片一样把 CLI 打开
  await putSettings()

  // 测试角色按「范围 + 环境」两个参数认（shared/test-steps.ts 的 isTestAgent），不看名字
  const tester = await call('POST', '/agents', {
    name: '测试验收',
    description: '',
    model: '',
    icon: 'test',
    categoryId: '',
    instructions: '跑测试：TESTER_STEPS',
    extraArgs: [],
    enabled: true,
    cli: 'claude',
    params: [{ key: 'scope' }, { key: 'env' }],
  })
  const wf = await call('POST', '/workflows', {
    name: '测试工作流',
    description: '',
    mainAgentId: tester.id,
    members: [],
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          { id: 'n1', title: '测试', agentId: tester.id, instructions: '按项目测试步骤验证这次改动。', x: 0, y: 0 },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'n1' },
          { id: 'e2', from: 'n1', to: 'end' },
        ],
      },
    ],
    entryFlowId: 'main',
    document: '# 目标\n验证这次改动\n',
  })
  // 三步覆盖三种情况：写了 C++ 适用范围的编译、只认 Lua 的语法检查、老步骤（没有 appliesTo）
  const testSteps = [
    {
      id: 'ue-build',
      name: '编译',
      command: 'Build.bat Game Win64 Development -Project=Game.uproject -WaitMutex',
      env: 'cmd',
      cwd: '',
      when: '',
      appliesTo: ['**/*.cpp', '**/*.h', '**/*.cs', '**/*.uproject'],
      timeoutSec: 0,
      note: '',
      enabled: true,
      merge: true,
      quick: false,
    },
    {
      id: 'ue-lua',
      name: 'Lua 语法检查',
      command: 'luac -p <文件>',
      env: 'auto',
      cwd: '',
      when: '',
      appliesTo: ['**/*.lua'],
      timeoutSec: 0,
      note: '',
      enabled: true,
      merge: false,
      quick: true,
    },
    {
      id: 'legacy-unit',
      name: '单元测试',
      command: 'npm run test:unit',
      env: 'auto',
      cwd: '',
      when: '',
      timeoutSec: 0,
      note: '',
      enabled: true,
      merge: false,
      quick: false,
    },
  ]
  const project = await call('POST', '/projects', {
    name: '步骤项目',
    description: '',
    path: projectDir,
    categoryId: '',
    workflowId: wf.id,
    childIsolation: 'claim',
    testSteps,
  })
  assert.deepEqual(
    project.testSteps.find((s) => s.id === 'ue-build').appliesTo,
    testSteps[0].appliesTo,
    '适用范围要原样存下来',
  )
  assert.deepEqual(project.testSteps.find((s) => s.id === 'legacy-unit').appliesTo, [], '没写适用范围的步骤存成空数组')

  const task = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '改一下 UI' })
  const done = await waitDone(task.id)
  assert.equal(done.status, 'done', JSON.stringify(done.messages.filter((m) => m.role === 'system')))
  step('测试角色跑完一轮')
  // 快照进任务的步骤也带着适用范围，之后改项目设置不影响已开始的对话
  assert.deepEqual(done.testSteps.find((s) => s.id === 'ue-build').appliesTo, testSteps[0].appliesTo)

  // 角色设定走 CLI 的 system prompt（在参数里，不在 stdin），所以按节点自己的说明认这次调用
  const prompt = calls()
    .map((c) => c.input ?? '')
    .filter((t) => t.includes('按项目测试步骤验证这次改动'))
    .at(-1)
  assert.ok(prompt, '测试角色的提示里没有拿到任务说明')
  assert.match(prompt, /## 项目测试步骤/, '测试步骤要注入给测试角色')
  assert.match(prompt, /不要无脑全跑/)
  // 改动清单：任务基线到 HEAD 的完整变更（三点比较），合并进来的文件也算
  assert.match(prompt, /改动清单是「任务起点 → 当前 HEAD」的完整变更/)
  assert.match(prompt, /git diff --name-only <任务基线>\.\.\.HEAD/)
  assert.match(prompt, /合并进来的文件也算本次改动/, '拉取 / 合并进来的改动同样计入')
  assert.match(prompt, /不能以「这部分不是我改的」为理由跳过/)
  // 跳过要写理由，一条都不匹配也要说明
  assert.match(prompt, /跳过：<步骤名> — 本次及合并进来的改动都没有/)
  assert.match(prompt, /本次改动不涉及配置的测试步骤/)
  assert.match(prompt, /为了保险全部跑一遍/)
  // 每条步骤的适用范围原样带上；没写范围的说明总是执行
  assert.match(
    prompt,
    /适用改动（清单里一个都不匹配就跳过这一步）：\*\*\/\*\.cpp、\*\*\/\*\.h、\*\*\/\*\.cs、\*\*\/\*\.uproject/,
  )
  assert.match(prompt, /适用改动（清单里一个都不匹配就跳过这一步）：\*\*\/\*\.lua/)
  assert.match(prompt, /适用改动（清单里一个都不匹配就跳过这一步）：未设置，总是执行/)
  assert.match(prompt, /同一时间仍然只编译一次/, 'merge 的编译仍然串行')
  assert.match(prompt, /名字后面标了「合并时编译」的步骤/, '步骤行会标「合并时编译」，规则不能悬空')
  // 这里写的是迁移后的范围：UE 编译命令不匹配 FULL_SUITE_COMMAND，步骤走 legacyTestStepScope 时落到 changed；
  // 改了那组全量命令的模式后这条断言要跟着看
  assert.match(
    prompt,
    /编译（cmd，合并时编译，范围：命中适用改动才跑）/,
    '标了 merge 的步骤在提示词里看得出来，并带上范围',
  )
  // 取不到改动清单（没有版本控制 / 命令失败 / 不知道基线）时按总是执行，不能静默漏跑
  assert.match(prompt, /取不到改动清单时/)
  assert.match(prompt, /清单未知不等于不相关/)
  // 范围是「整体」（发布前验证 / 整体验收 / 依赖升级确认步骤）时不按改动清单筛，否则和角色设定里的
  // 「{{else}}从项目根按顺序跑完整的步骤」矛盾
  assert.match(prompt, /不按改动清单筛/, '整体类节点要能看出来不筛')
  assert.match(prompt, /发布前验证、整体验收这类节点存在的意义就是不筛/)
})
