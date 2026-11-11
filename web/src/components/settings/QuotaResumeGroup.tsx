import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { CLIS } from '@shared/clis'
import { t } from '@shared/i18n'
import { QuotaResumeSettings, fallbackKey, type QuotaFallback } from '@shared/quota-resume'
import { orderClis } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { useCliDef } from '@/lib/cli-models'
import { useModelName } from '@/lib/model-name'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Group, Row } from './parts'

/**
 * 设置 →「常规」里的「额度用完或限流」一组（Agent 模式扩展 1，规则在 shared/quota-resume.ts）：
 * 到点自动继续、按备用顺序换模型，两项都默认关。直接存 settings.quotaResume（自己保存，设置页的自动保存带上最新值）
 */
export function QuotaResumeGroup() {
  const { settings, setSettings } = useData()
  const cfg = QuotaResumeSettings.parse(settings?.quotaResume ?? {})
  const modelName = useModelName()
  const save = async (patch: Partial<QuotaResumeSettings>) => {
    if (!settings) return
    try {
      setSettings(await api.saveSettings({ ...settings, quotaResume: { ...cfg, ...patch } }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const order = cfg.order
  const move = (i: number, d: number) => {
    const next = [...order]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    void save({ order: next })
  }
  const cliName = (id: string) => CLIS.find((c) => c.id === id)?.name ?? id
  return (
    <Group title={t('额度用完或限流')}>
      <Row
        title={t('到点自动继续')}
        desc={t('知道什么时候恢复时，到点接着做')}
        hint={t(
          '这一轮因为额度用完或被限流失败时，面板从报错和 Agent 报的额度窗口里读恢复时间，对话停在「等额度恢复」，到点自动继续（和点「继续执行」一样）。被限流又读不到时间时 5 分钟后再试；额度用完又读不到时间（多半要充值）就不等。每次都在对话里写一行；同一条要求之后最多自动接 6 次。默认关：继续会花钱。',
        )}
      >
        <Switch
          aria-label={t('额度用完或限流后到点自动继续')}
          checked={cfg.waitReset}
          onCheckedChange={(v) => void save({ waitReset: v })}
        />
      </Row>
      <Row
        title={t('换备用模型')}
        desc={t('按下面的顺序换一个接着做')}
        hint={t(
          '额度用完或被限流时，按顺序换成第一个还没用过的模型马上接着做，可以跨 Agent（换 Agent 时把之前的对话带过去）。用角色的对话：角色固定了 Agent 的只换这个 Agent 的模型。都用过了再看「到点自动继续」。切换时在对话里写明换成了什么。',
        )}
      >
        <Switch
          aria-label={t('额度用完或限流后换备用模型')}
          checked={cfg.fallback}
          onCheckedChange={(v) => void save({ fallback: v })}
        />
      </Row>
      {cfg.fallback && (
        <Row stack indent title={t('备用顺序')} desc={t('排在前面的先用；模型留空用这个 Agent 的默认模型')}>
          <div className="flex flex-col gap-2">
            {order.length > 0 && (
              <div className="flex flex-col">
                {order.map((f, i) => (
                  <div key={fallbackKey(f)} className="flex items-center gap-2 py-1">
                    <span className="w-5 shrink-0 text-right text-caption text-subtle tabular-nums">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-body">
                      {cliName(f.cli)}
                      <span className="text-subtle"> / </span>
                      <span className="font-mono text-footnote">
                        {f.model ? modelName(f.model, f.cli) : t('默认模型')}
                      </span>
                    </span>
                    <IconButton icon={ArrowUp} label={t('上移')} size="xs" disabled={!i} onClick={() => move(i, -1)} />
                    <IconButton
                      icon={ArrowDown}
                      label={t('下移')}
                      size="xs"
                      disabled={i === order.length - 1}
                      onClick={() => move(i, 1)}
                    />
                    <IconButton
                      icon={Trash2}
                      label={t('删除')}
                      size="xs"
                      onClick={() => void save({ order: order.filter((_, j) => j !== i) })}
                    />
                  </div>
                ))}
              </div>
            )}
            <AddFallback
              taken={new Set(order.map(fallbackKey))}
              full={order.length >= 12}
              onAdd={(f) => void save({ order: [...order, f] })}
            />
          </div>
        </Row>
      )}
    </Group>
  )
}

/** 加一项：先选 Agent，再从它的模型列表里选（和输入框里的模型下拉同一个来源） */
function AddFallback({ taken, full, onAdd }: { taken: Set<string>; full: boolean; onAdd: (f: QuotaFallback) => void }) {
  const { settings, clis } = useData()
  const enabled = (id: string) =>
    settings?.clis[id]?.enabled !== false && clis.find((c) => c.id === id)?.installed !== false
  const list = orderClis(CLIS, settings?.cliOrder ?? [], (c) => enabled(c.id)).filter((c) => enabled(c.id))
  const [cli, setCli] = useState(list[0]?.id ?? '')
  const [model, setModel] = useState('')
  const def = useCliDef(cli || undefined)
  const modelName = useModelName()
  const pick = { cli, model }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        size="sm"
        className="w-36"
        aria-label={t('备用的 Agent')}
        value={cli}
        options={list.map((c) => ({ value: c.id, label: c.name }))}
        onChange={(e) => {
          setCli(e.target.value)
          setModel('')
        }}
      />
      <Select
        size="sm"
        className="min-w-0 flex-1"
        aria-label={t('备用的模型')}
        value={model}
        options={[
          { value: '', label: t('默认模型') },
          ...(def?.models ?? []).filter((m) => m.id).map((m) => ({ value: m.id, label: modelName(m.id, cli) })),
        ]}
        onChange={(e) => setModel(e.target.value)}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={!cli || full || taken.has(fallbackKey(pick))}
        onClick={() => {
          onAdd(pick)
          setModel('')
        }}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('加入')}
      </Button>
    </div>
  )
}
