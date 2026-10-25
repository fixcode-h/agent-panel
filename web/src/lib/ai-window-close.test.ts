/**
 * AI 分析窗口的关闭：只关窗口，不停分析。
 * 浮条的 ✕ 和标题栏的 ✕ 都走同一个 closeAiWindow，所以直接测这个函数：
 * 不发停止请求、不清任务 id（清了 watch() 的轮询就退出，后台跑完没人提醒）、还在跑时提醒「继续在后台进行」。
 */
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { toast } from 'sonner'
import { setLang, t } from '@shared/i18n'
import { closeWindowPlan } from '@/lib/ai-window-close'
import { aiWindowState, closeAiWindow, hideAiWindow, openAiWindow, resetAiWindow } from '@/lib/ai-window'
import { api } from '@/lib/api'

// 断言里是中文，不管本机是什么语言
setLang('zh')

const job = {
  label: 'AI 分析',
  title: '购物车右上角',
  create: async () => ({ id: 'task-1', status: 'running', projectId: 'p1', parentTaskId: 'parent-1' }) as never,
}
const keepRunning = t('{label}继续在后台进行：{title}', { label: 'AI 分析', title: '购物车右上角' })
const building = t('{label}正在新建对话，关掉窗口不影响它继续建：{title}', {
  label: 'AI 分析',
  title: '购物车右上角',
})

const plan = (over: Partial<Parameters<typeof closeWindowPlan>[0]>) =>
  closeWindowPlan({ starting: false, gone: false, ...over })

/** sonner 历史里最后一条带标题的 toast（跳过没有 title 的「已关闭」项） */
const lastToast = () => {
  const items = toast.getHistory()
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]
    if (it && 'title' in it && it.title) return it.title
  }
  return undefined
}

/** 等一个条件成立；不写成无限循环，条件一直不成立时测试要失败而不是挂住 */
async function waitFor(ok: () => boolean, ms = 2000) {
  const until = Date.now() + ms
  while (!ok()) {
    if (Date.now() > until) throw new Error('等超时了：条件一直没成立')
    await new Promise((r) => setTimeout(r, 1))
  }
}

// state 是模块单例：每个用例都从干净的状态开始，否则上一个用例留下的 taskId / starting 会串味
beforeEach(() => resetAiWindow())

test('closeWindowPlan：在跑时只收窗口，不清 taskId / status，并提醒分析还在跑', () => {
  const p = plan({ taskId: 'task-1', status: 'running', job })
  assert.deepEqual(p.patch, { open: false, minimized: false })
  assert.equal('taskId' in p.patch, false, '清了 taskId 轮询就退出，后台跑完没人知道')
  assert.equal('status' in p.patch, false)
  assert.deepEqual(p.notify, { kind: 'running', label: 'AI 分析', title: '购物车右上角' })
})

test('closeWindowPlan：正在新建说的是「正在新建」，不和「已经在跑」混成一句话', () => {
  assert.deepEqual(plan({ starting: true, job }).notify, {
    kind: 'starting',
    label: 'AI 分析',
    title: '购物车右上角',
  })
  assert.equal(plan({ taskId: 'task-1', status: 'done', job }).notify, undefined)
  assert.equal(plan({ taskId: 'task-1', status: 'stopped', job }).notify, undefined)
})

test('closeWindowPlan：对话已经删掉时连状态一起清，否则新分析永远建不出来', () => {
  // status 会冻在最后一次轮到的值（常见是 running），openAiWindow 会一直当它还在跑
  const p = plan({ taskId: 'task-1', status: 'running', gone: true, job })
  assert.deepEqual(p.patch, { open: false, minimized: false, taskId: undefined, status: undefined, gone: false })
  assert.equal(p.notify, undefined, '对话都删了，不能说「继续在后台进行」')
})

test('closeAiWindow：还在新建时关窗口，提醒说的是「正在新建」而不是「在后台进行」', async () => {
  const origStop = api.stopTask
  api.stopTask = (async () => {
    throw new Error('不该在这里停止')
  }) as typeof api.stopTask
  // 卡在新建：create 一直不返回（关窗口的行为不依赖它返回）
  const stuck = { ...job, create: () => new Promise<never>(() => {}) }
  try {
    openAiWindow(stuck)
    toast.dismiss()
    closeAiWindow()
    assert.equal(aiWindowState().open, false)
    assert.equal(lastToast(), building)
  } finally {
    api.stopTask = origStop
  }
})

test('closeAiWindow：分析中关窗口不发停止请求，任务和状态都还留着', async () => {
  const requests: string[] = []
  const origStop = api.stopTask
  const origTask = api.task
  api.stopTask = (async (id: string) => {
    requests.push(`stop:${id}`)
    throw new Error('不该在这里停止')
  }) as typeof api.stopTask
  // watch() 的定时器 1.5s 后才发请求，到点时测试已经结束：给它 404 让它直接收尾，
  // 不留下永不 resolve 的 promise（那样进程退不掉）
  const gone = Object.assign(new Error(t('任务不存在')), { status: 404 })
  api.task = (async () => {
    throw gone
  }) as typeof api.task

  try {
    openAiWindow(job)
    await waitFor(() => !!aiWindowState().taskId)
    toast.dismiss()
    closeAiWindow()

    const s = aiWindowState()
    assert.deepEqual(requests, [], '关窗口不能停止分析：停止入口只剩对话输入框里那个')
    assert.equal(s.open, false)
    assert.equal(s.minimized, false)
    assert.equal(s.taskId, 'task-1', 'taskId 要留着，watch() 才继续盯后台跑完')
    assert.equal(s.status, 'running')
    assert.equal(lastToast(), keepRunning)
  } finally {
    api.stopTask = origStop
    api.task = origTask
  }
})

test('hideAiWindow：去对话里看时收起窗口，同样不停分析也不打扰', () => {
  const before = toast.getHistory().length
  hideAiWindow()
  assert.equal(aiWindowState().open, false)
  assert.equal(toast.getHistory().length, before, 'hide 是用户自己走过去看的，不再多弹一句')
})
