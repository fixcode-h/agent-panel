import { useState } from 'react'
import type { CliDefinition } from '@shared/clis'
import { ExperienceSettings } from '@shared/experience'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'
import { Select } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { AssistModel, type CliDraft } from './CliSection'
import { Group, NumberField, Row } from './parts'

/**
 * 设置 →「经验」：总开关管整个功能（Agent 查经验的工具、新会话开头那一行、自动学习），关了等于没有经验；
 * 下面几项只在开着时有意义。提炼和 AI 评审用的模型默认跟随对话的 Agent。
 * 直接存 settings.experience（设置页的自动保存原样带着它，见 SettingsPage 的 value）
 */
export function ExperienceSection({
  clis,
  drafts,
  isReady,
}: {
  clis: CliDefinition[]
  drafts: Record<string, CliDraft>
  isReady: (id: string) => boolean
}) {
  const { settings, setSettings } = useData()
  const exp = ExperienceSettings.parse(settings?.experience ?? {})
  const [limit, setLimit] = useState(String(exp.dailyLimit))
  const [idle, setIdle] = useState(String(exp.idleMinutes))
  const save = async (patch: Partial<ExperienceSettings>) => {
    if (!settings) return
    try {
      setSettings(await api.saveSettings({ ...settings, experience: { ...exp, ...patch } }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const num = (v: string, min: number, max: number) => {
    const n = Number(v)
    return v !== '' && Number.isInteger(n) && n >= min && n <= max ? n : null
  }
  const limitN = num(limit, 1, 200)
  const idleN = num(idle, 0, 1440)
  return (
    <div className="flex flex-col">
      <p className="pb-2 text-body leading-relaxed text-subtle">
        {t(
          '经验是项目里「做某类事最快的路」：某类东西在哪个目录、你的说法在代码里叫什么、用什么命令、怎么验证。整个对话完成后面板自动学，存在项目文档的 agent-knowledge/experience/；Agent 需要时按关键词查，不会整份塞进提示词。教训管防错，经验管提速。',
        )}
      </p>
      <Group>
        <Row title={t('启用经验')} desc={t('关掉后不学、不查，新会话开头也不提')}>
          <Switch aria-label={t('启用经验')} checked={exp.enabled} onCheckedChange={(v) => void save({ enabled: v })} />
        </Row>
        {exp.enabled && (
          <>
            <Row
              title={t('整个对话完成后自动学')}
              desc={t('对话和它的子对话都完成、空闲一段时间后在后台学，不挡你')}
              hint={t(
                '先只看工具调用算这次绕了多少路（不花 token），绕路明显或命令反复试错时才调一次模型提炼，最多 2 条。',
              )}
            >
              <Switch
                aria-label={t('整个对话完成后自动学')}
                checked={exp.autoLearn}
                onCheckedChange={(v) => void save({ autoLearn: v })}
              />
            </Row>
            <Row title={t('新会话开头附上相关经验')} desc={t('按需求原文在本地匹配，命中了附上最多两条的标题和位置')}>
              <Switch
                aria-label={t('新会话开头附上相关经验')}
                checked={exp.preHint}
                onCheckedChange={(v) => void save({ preHint: v })}
              />
            </Row>
          </>
        )}
      </Group>
      {exp.enabled && exp.autoLearn && (
        <Group title={t('学习')}>
          <Row title={t('学得勤不勤')} desc={t('绕路多少次才值得学：少一点 12 次、适中 8 次、勤一点 5 次')}>
            <Segmented
              label={t('学得勤不勤')}
              size="sm"
              value={exp.sensitivity}
              onChange={(v) => void save({ sensitivity: v })}
              options={[
                { id: 'low', label: t('少一点') },
                { id: 'normal', label: t('适中') },
                { id: 'high', label: t('勤一点') },
              ]}
            />
          </Row>
          <Row title={t('对话完成后等多久再学')} desc={t('这段时间里你接着追问，就重新计时')}>
            <NumberField
              label={t('对话完成后等多久再学')}
              value={idle}
              unit={t('分钟')}
              invalid={idleN === null}
              onChange={(v) => {
                setIdle(v)
                const n = num(v, 0, 1440)
                if (n !== null) void save({ idleMinutes: n })
              }}
            />
          </Row>
          <Row title={t('每个项目每天最多提炼')} desc={t('到了上限当天不再调模型，只做不花 token 的那一步')}>
            <NumberField
              label={t('每个项目每天最多提炼')}
              value={limit}
              unit={t('次')}
              invalid={limitN === null}
              onChange={(v) => {
                setLimit(v)
                const n = num(v, 1, 200)
                if (n !== null) void save({ dailyLimit: n })
              }}
            />
          </Row>
        </Group>
      )}
      {exp.enabled && (
        <Group title={t('提炼和 AI 评审用的模型')}>
          <Row title={t('Agent')} desc={t('默认跟随对话的 Agent 和模型；AI 评审跟随默认 Agent')}>
            <Select
              aria-label={t('经验用的 Agent')}
              value={exp.cli}
              // 换 CLI 时模型名不通用，清空回到那个 CLI 的默认模型
              onChange={(e) => void save({ cli: e.target.value, model: '' })}
              options={[
                { value: '', label: t('跟随对话的 Agent') },
                ...clis.filter((c) => isReady(c.id) || c.id === exp.cli).map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </Row>
          {exp.cli && (
            <Row title={t('模型')} desc={t('默认用这个 Agent 的默认模型')}>
              <AssistModel
                key={exp.cli}
                cli={exp.cli}
                draft={drafts[exp.cli]}
                label={t('经验用的模型')}
                value={exp.model}
                onChange={(v) => void save({ model: v.trim() })}
              />
            </Row>
          )}
        </Group>
      )}
    </div>
  )
}
