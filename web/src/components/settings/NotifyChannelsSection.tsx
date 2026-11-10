import { useEffect, useState } from 'react'
import { Eye, EyeOff, Loader2, Plus, Send, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import {
  NOTIFY_EVENTS,
  NOTIFY_TEMPLATES,
  NotifyChannel,
  notifyEventLabel,
  notifyKeyword,
  notifyTemplateLabel,
  notifyUrlProblem,
  type NotifyEvent,
  type NotifyTemplate,
} from '@shared/notify-channels'
import { notifyApi, type NotifyStatus } from '@/lib/api-notify'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Group, Row } from './parts'

const newId = () => Math.random().toString(36).slice(2, 10) || 'n'

/** 各模板地址的样子：只写到路径为止，key 的位置用省略号，不放任何像真 key 的东西 */
const URL_HINT: Record<NotifyTemplate, string> = {
  json: 'https://example.com/hook',
  feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
  dingtalk: 'https://oapi.dingtalk.com/robot/send?…',
  wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?…',
}

const TEMPLATE_OPTIONS = NOTIFY_TEMPLATES.map((x) => ({ value: x, label: notifyTemplateLabel(x) }))

/** 这种机器人要用户在对方后台做的设置；没有就不显示 */
function templateNote(x: NotifyTemplate): string {
  // 钉钉必须选一种安全设置，飞书可选：面板不做加签，用关键词这一种（每条消息开头固定是这几个字）
  if (x === 'dingtalk' || x === 'feishu')
    return t('机器人的安全设置选「自定义关键词」，关键词填「{word}」；不支持加签', { word: notifyKeyword() })
  if (x === 'json') return t('POST 一份 JSON：event、project、title、message、link、text 等字段')
  return ''
}

/**
 * 设置里的「通知渠道」（分析稿 A5）：浏览器通知出不了浏览器，页面关了、人不在电脑前就收不到；
 * 这里填几个 Webhook，对话等你处理、失败、做完、快到用量上限时服务端往外发一条，带直达那个对话的链接。
 * 渠道存在设置里，跟着设置页自动保存；「最近一次」的投递结果在服务端内存里，这一页打开和发完测试时读。
 * 地址里带着机器人的 key：默认按密码框显示，点眼睛才看得到
 */
export function NotifyChannelsSection({
  value,
  onChange,
}: {
  value: NotifyChannel[]
  onChange: (v: NotifyChannel[]) => void
}) {
  const [status, setStatus] = useState<NotifyStatus>({})
  const [testing, setTesting] = useState('')
  /** 哪几行的地址正明文显示 */
  const [shown, setShown] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let alive = true
    notifyApi
      .status()
      .then((s) => alive && setStatus(s))
      // 读不到最近结果不影响编辑渠道：出错照实提示
      .catch((e: Error) => toast.error(e.message))
    return () => {
      alive = false
    }
  }, [])

  const update = (id: string, patch: Partial<NotifyChannel>) =>
    onChange(value.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const add = (template: NotifyTemplate) => {
    const c = NotifyChannel.parse({ id: newId(), name: notifyTemplateLabel(template), template })
    // 新加的一行地址还空着，直接明文：要往里粘贴，粘完才知道贴对没有
    setShown((s) => ({ ...s, [c.id]: true }))
    onChange([...value, c])
  }
  const toggleEvent = (c: NotifyChannel, e: NotifyEvent, on: boolean) =>
    // 按固定顺序存：同样的勾选不会因为点的先后不同存成两种样子，自动保存也不会白跑
    update(c.id, { events: NOTIFY_EVENTS.filter((x) => (x === e ? on : c.events.includes(x))) })

  const test = async (c: NotifyChannel) => {
    setTesting(c.id)
    try {
      const r = await notifyApi.test(c)
      setStatus(r.status)
      if (r.ok) toast.success(t('测试消息已发出，去对应的群或服务里看看'))
      else toast.error(t('没发出去：{error}', { error: r.error }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTesting('')
    }
  }

  return (
    // 组名不再写「通知渠道」：页面标题已经是它，重复一遍只是多一行字
    <Group title="Webhook">
      <Row
        title={t('添加渠道')}
        desc={t('对话等你处理、失败时发到群机器人或你自己的服务')}
        hint={t(
          '浏览器通知只在页面开着时有用。这里填的 Webhook 由面板服务端来发：消息里有项目名、对话标题、发生了什么和直达这个对话的链接（开了外部访问用外网地址，否则是本机地址）。同一个对话同一种事件 60 秒内只发一次；对方 5 秒没回应算失败，原因显示在那一行，不会自动重发。地址只存在本机的设置文件里。',
        )}
      >
        <div className="flex max-w-[420px] flex-wrap justify-end gap-1.5">
          {NOTIFY_TEMPLATES.map((x) => (
            <Button key={x} size="sm" variant="secondary" onClick={() => add(x)}>
              <Plus className="h-3.5 w-3.5" />
              {notifyTemplateLabel(x)}
            </Button>
          ))}
        </div>
      </Row>
      {value.map((c) => {
        const problem = c.url.trim() ? notifyUrlProblem(c.url) : ''
        const lastRun = status[c.id]
        const failed = !!lastRun && !lastRun.ok
        const tone = !c.enabled
          ? 'bg-line-strong'
          : problem || failed
            ? 'bg-danger'
            : lastRun?.ok
              ? 'bg-success'
              : 'bg-line-strong'
        const note = templateNote(c.template)
        const label = c.name || t('未命名渠道')
        return (
          <Row
            key={c.id}
            title={label}
            desc={
              problem ? (
                <span className="text-danger">{problem}</span>
              ) : failed ? (
                <span className="text-danger" data-notify-error>
                  {t('最近一次没发出去：{error}', { error: lastRun.error })}
                </span>
              ) : !c.enabled ? (
                t('已停用')
              ) : lastRun?.ok ? (
                t('最近一次已发出')
              ) : (
                note || undefined
              )
            }
            stack
          >
            <div className="flex flex-col gap-2.5" data-notify-channel={c.id}>
              <div className="flex flex-wrap items-center gap-2 text-body text-muted">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
                <Input
                  value={c.name}
                  onChange={(e) => update(c.id, { name: e.target.value })}
                  placeholder={t('名称')}
                  className="w-[160px] text-body"
                  aria-label={t('名称')}
                />
                <Select
                  aria-label={t('消息格式')}
                  value={c.template}
                  onChange={(e) => update(c.id, { template: e.target.value as NotifyTemplate })}
                  className="w-[170px]"
                  options={TEMPLATE_OPTIONS}
                />
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!testing || !c.url.trim() || !!problem}
                    onClick={() => void test(c)}
                    title={t('往这个地址发一条测试消息')}
                  >
                    {testing === c.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    {t('发一条测试')}
                  </Button>
                  <Switch
                    aria-label={t('启用 {name}', { name: label })}
                    checked={c.enabled}
                    onCheckedChange={(on) => update(c.id, { enabled: on })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onChange(value.filter((x) => x.id !== c.id))}
                    aria-label={t('删除渠道 {name}', { name: label })}
                    title={t('删除渠道')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  // 地址里带着机器人的 key：平时按密码框显示，旁边有人、截图时不会露出来
                  type={shown[c.id] ? 'text' : 'password'}
                  autoComplete="off"
                  value={c.url}
                  onChange={(e) => update(c.id, { url: e.target.value })}
                  placeholder={URL_HINT[c.template]}
                  spellCheck={false}
                  className="font-mono text-body"
                  aria-label={t('Webhook 地址')}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 shrink-0"
                  onClick={() => setShown((s) => ({ ...s, [c.id]: !s[c.id] }))}
                  aria-label={shown[c.id] ? t('隐藏地址') : t('显示地址')}
                  title={shown[c.id] ? t('隐藏地址') : t('显示地址')}
                >
                  {shown[c.id] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-body">
                <span className="text-subtle">{t('什么时候发')}</span>
                {NOTIFY_EVENTS.map((e) => (
                  <Checkbox
                    key={e}
                    checked={c.events.includes(e)}
                    onChange={(on) => toggleEvent(c, e, on)}
                    label={notifyEventLabel(e)}
                  />
                ))}
              </div>
              {/* 上面那行说明被「最近一次」的结果占了时，对方后台要做的设置还是要看得到 */}
              {note && (problem || failed || lastRun?.ok || !c.enabled) && (
                <p className="text-caption text-subtle">{note}</p>
              )}
            </div>
          </Row>
        )
      })}
    </Group>
  )
}
