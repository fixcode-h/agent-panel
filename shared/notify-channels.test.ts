/**
 * 面板外的通知渠道：各模板的请求体、机器人业务失败的识别、地址打码、去重、直达链接。
 * 地址一律用 example.invalid 占位，不写真实的机器人地址。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from './i18n.ts'
import {
  channelWants,
  conversationLink,
  createNotifyDedupe,
  maskUrl,
  maskUrlIn,
  NotifyChannel,
  NotifyChannels,
  notifyPayload,
  notifyResponseError,
  notifyText,
  notifyUrlProblem,
  type NotifyMessage,
} from './notify-channels.ts'

setLang('zh')

const HOOK = 'https://example.invalid/hook/placeholder-path?key=placeholder'
const msg: NotifyMessage = {
  event: 'needs',
  project: '商城',
  title: '修购物车',
  taskId: 't1',
  link: 'http://127.0.0.1:8787/#/projects/p1/t1',
}

test('消息文字：开头是固定的关键词，项目、对话各一行，最后一行是直达链接；没有项目的聊天不写项目行', () => {
  const lines = notifyText(msg).split('\n')
  assert.equal(lines[0], 'Agent 面板 · 对话在等你处理：有提问或请求要你回复')
  assert.deepEqual(lines.slice(1), ['项目：商城', '对话：修购物车', msg.link])
  assert.deepEqual(
    notifyText({ ...msg, project: '' })
      .split('\n')
      .slice(1),
    ['对话：修购物车', msg.link],
  )
  // 测试消息、到了上限各有各的说法，不会被当成真的「快到」
  assert.match(notifyText({ ...msg, test: true }), /^Agent 面板 · 测试消息：/)
  assert.match(notifyText({ ...msg, event: 'budget' }), /快到用量上限/)
  assert.match(notifyText({ ...msg, event: 'budget', over: true }), /到了用量上限，已经停下/)
})

test('各模板的请求体：飞书 msg_type/content.text，钉钉和企业微信 msgtype/text.content，通用 JSON 字段写全', () => {
  const text = notifyText(msg)
  assert.deepEqual(notifyPayload('feishu', msg), { msg_type: 'text', content: { text } })
  assert.deepEqual(notifyPayload('dingtalk', msg), { msgtype: 'text', text: { content: text } })
  assert.deepEqual(notifyPayload('wecom', msg), { msgtype: 'text', text: { content: text } })
  assert.deepEqual(notifyPayload('json', msg, Date.parse('2026-11-10T00:00:00.000Z')), {
    source: 'agent-panel',
    event: 'needs',
    test: false,
    project: '商城',
    title: '修购物车',
    taskId: 't1',
    message: '对话在等你处理：有提问或请求要你回复',
    link: msg.link,
    text,
    sentAt: '2026-11-10T00:00:00.000Z',
  })
})

test('机器人回 200 但业务上拒收：按模板读出错误码和原因；成功、读不懂的响应、通用 JSON 都不算错', () => {
  assert.equal(notifyResponseError('feishu', '{"code":0,"msg":"success"}'), '')
  assert.equal(notifyResponseError('feishu', '{"StatusCode":0,"StatusMessage":"success"}'), '')
  assert.equal(
    notifyResponseError('feishu', '{"code":19024,"msg":"Key Words Not Found"}'),
    '对方返回错误 19024：Key Words Not Found',
  )
  assert.equal(notifyResponseError('dingtalk', '{"errcode":0,"errmsg":"ok"}'), '')
  assert.equal(
    notifyResponseError('dingtalk', '{"errcode":310000,"errmsg":"keywords not in content"}'),
    '对方返回错误 310000：keywords not in content',
  )
  assert.equal(
    notifyResponseError('wecom', '{"errcode":93000,"errmsg":"invalid webhook url"}'),
    '对方返回错误 93000：invalid webhook url',
  )
  assert.equal(notifyResponseError('wecom', '{"errcode":40001}'), '对方返回错误 40001')
  assert.equal(notifyResponseError('wecom', '<html>网关页面</html>'), '')
  assert.equal(notifyResponseError('json', '{"errcode":1,"errmsg":"自己的服务随便回"}'), '')
})

test('地址打码：只留协议和主机，路径和查询串（key 所在）不出现；报错文字里带着地址也一并换掉', () => {
  assert.equal(maskUrl(HOOK), 'https://example.invalid/***')
  assert.equal(maskUrl('http://example.invalid:8443/a/b?c=d'), 'http://example.invalid:8443/***')
  assert.equal(maskUrl('不是地址'), '***')
  const masked = maskUrlIn(`request to ${HOOK} failed, reason: connect ECONNREFUSED`, HOOK)
  assert.equal(masked, 'request to https://example.invalid/*** failed, reason: connect ECONNREFUSED')
  // 只带路径和查询串的写法（有的网络库这样报）也认得出
  const tail = maskUrlIn('POST /hook/placeholder-path?key=placeholder 502', HOOK)
  assert.ok(!tail.includes('placeholder'), tail)
  // 没有地址、报错里没带地址时原样返回
  assert.equal(maskUrlIn('fetch failed', HOOK), 'fetch failed')
  assert.equal(maskUrlIn('fetch failed', ''), 'fetch failed')
})

test('去重：同一个对话同一事件 60 秒内只放行一次，到点后再放行；不同对话、不同事件互不影响；过期的记录会清掉', () => {
  const d = createNotifyDedupe()
  const t0 = 1_000_000
  assert.equal(d.pass('t1|needs', t0), true)
  assert.equal(d.pass('t1|needs', t0 + 59_999), false)
  assert.equal(d.pass('t1|failed', t0 + 10), true)
  assert.equal(d.pass('t2|needs', t0 + 10), true)
  // 被挡下的那一次不续期：从第一次发出算满 60 秒就能再发
  assert.equal(d.pass('t1|needs', t0 + 60_000), true)
  assert.equal(d.pass('t1|needs', t0 + 60_001), false)
  // 很久以后来一条：之前的全过期，表里只剩这一条
  assert.equal(d.pass('t9|done', t0 + 600_000), true)
  assert.equal(d.size(), 1)
})

test('直达链接：项目里的对话、Chat 页的聊天各自的路由；面板地址末尾的斜杠不重复；没有对话时就是面板地址', () => {
  assert.equal(
    conversationLink('https://panel.example.invalid/', { id: 't1', projectId: 'p1' }),
    'https://panel.example.invalid/#/projects/p1/t1',
  )
  assert.equal(
    conversationLink('http://127.0.0.1:8787', { id: 'c 1', projectId: '' }),
    'http://127.0.0.1:8787/#/chat/c%201',
  )
  assert.equal(conversationLink('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787')
})

test('渠道的默认值和要不要发：默认勾等你处理和失败；停用、没填地址、地址不对、没勾的事件都不发', () => {
  const c = NotifyChannel.parse({ id: 'a', url: HOOK })
  assert.deepEqual(c.events, ['needs', 'failed'])
  assert.equal(c.template, 'json')
  assert.equal(channelWants(c, 'needs'), true)
  assert.equal(channelWants(c, 'done'), false)
  assert.equal(channelWants({ ...c, enabled: false }, 'needs'), false)
  assert.equal(channelWants({ ...c, url: '' }, 'needs'), false)
  assert.equal(channelWants({ ...c, url: 'ftp://example.invalid/x' }, 'needs'), false)
  assert.equal(notifyUrlProblem(''), '还没填地址')
  assert.equal(notifyUrlProblem('example.invalid/hook'), '地址要以 http:// 或 https:// 开头')
  assert.equal(notifyUrlProblem(HOOK), '')
  // 设置文件里这一项被手改坏了：按空列表读，不让整份设置作废；不认识的模板回到通用 JSON
  assert.deepEqual(NotifyChannels.parse('坏了'), [])
  assert.equal(NotifyChannel.parse({ id: 'b', template: 'slack' }).template, 'json')
})
