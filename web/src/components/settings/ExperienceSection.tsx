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
 * 直接存 settings.experience（设置页的自动保存原样带着它，见 settings-value.ts 的 buildSettings）
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
  // 0 表示不限
  const limitN = num(limit, 0, 200)
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
              desc={t('对话和它的子对话都完成后马上在后台学，不挡你')}
              hint={t(
                '先只看工具调用判断值不值得学（不花 token）：找到要改的地方前搜索、读文件太多，或者命令失败几次才试成功，才调一次模型提炼，最多记 2 条。',
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
          <Row
            title={t('学得勤不勤')}
            desc={t('绕路达到几次才学：少一点 12 次、适中 8 次、勤一点 5 次')}
            hint={t(
              '绕路：找到最后要改的目录之前，搜索和读别处文件的次数，次数多说明这次找得费劲，值得记下来。命令失败后换了写法才成功的也会学：少一点要失败 3 次，适中和勤一点 2 次。',
            )}
          >
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
          <Row title={t('每个项目每天最多提炼')} desc={t('填 0 不限；到了上限当天不再调模型提炼')}>
            <NumberField
              label={t('每个项目每天最多提炼')}
              value={limit}
              unit={t('次')}
              invalid={limitN === null}
              onChange={(v) => {
                setLimit(v)
                const n = num(v, 0, 200)
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
