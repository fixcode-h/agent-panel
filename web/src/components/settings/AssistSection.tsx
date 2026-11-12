import type { Settings } from '@shared/schema'
import { t } from '@shared/i18n'
import { Select, Textarea } from '@/components/ui/input'
import { Group, Row } from '@/components/settings/parts'
import { AssistModel } from '@/components/settings/CliSection'
import type { CliDrafts } from '@/components/settings/use-cli-drafts'

/**
 * 设置 →「AI 创建」：角色、工作流页里用 Agent 对话生成配置时用哪个 Agent、模型和额外规则。
 * 从 pages/SettingsPage.tsx 挪出；默认 Agent 和 CLI 草稿由设置页持有，这里按参数拿。
 */
export function AssistSection({
  cli,
  assist,
  onAssist,
}: {
  cli: Pick<CliDrafts, 'ordered' | 'statusOf' | 'drafts' | 'defCli'>
  assist: Settings['assist']
  onAssist: (v: Settings['assist']) => void
}) {
  const { ordered, statusOf, drafts, defCli } = cli
  return (
    <>
      <p className="text-body text-subtle">{t('在角色和工作流页面用 Agent 对话生成或优化配置。')}</p>
      <Group>
        <Row
          title={t('使用的 Agent')}
          desc={t('默认用默认 Agent')}
          hint={t('Agent 按固定格式输出，面板校验通过后才能应用。')}
        >
          <Select
            aria-label={t('AI 创建使用的 Agent')}
            value={assist.cli || defCli}
            // 选回默认的就不单独记，之后换了默认 CLI 会跟着变
            // 换 CLI 时模型名不通用，清空回到那个 CLI 的默认模型
            onChange={(e) => onAssist({ ...assist, cli: e.target.value === defCli ? '' : e.target.value, model: '' })}
            options={ordered
              .filter((c) => {
                const st = statusOf(c.id)
                return !st || (st.installed && st.enabled) || c.id === (assist.cli || defCli)
              })
              .map((c) => ({
                value: c.id,
                label: `${c.name}${c.id === defCli ? t('（默认）') : ''}`,
              }))}
          />
        </Row>
        <Row title={t('模型')} desc={t('默认用这个 Agent 的默认模型')}>
          <AssistModel
            key={assist.cli || defCli}
            cli={assist.cli || defCli}
            draft={drafts[assist.cli || defCli]}
            value={assist.model}
            onChange={(v) => onAssist({ ...assist, model: v })}
          />
        </Row>
        <Row title={t('角色规则')} desc={t('加进创建角色的提示词')} stack>
          <Textarea
            rows={4}
            value={assist.agentRules}
            onChange={(e) => onAssist({ ...assist, agentRules: e.target.value })}
            placeholder={t(
              '例如：\n- 角色设定统一包含「职责 / 工作方式 / 交付标准」三节\n- 前端相关的角色默认用 Claude Code',
            )}
            className="font-mono text-body"
          />
        </Row>
        <Row title={t('工作流规则')} desc={t('加进创建工作流的提示词')} stack>
          <Textarea
            rows={4}
            value={assist.workflowRules}
            onChange={(e) => onAssist({ ...assist, workflowRules: e.target.value })}
            placeholder={t('例如：\n- 写代码的节点都要配一个代码审查的验收流程\n- 验收最多 2 轮')}
            className="font-mono text-body"
          />
        </Row>
      </Group>
    </>
  )
}
