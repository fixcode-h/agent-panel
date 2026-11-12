import type { ProjectInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { Checkbox } from '@/components/ui/checkbox'
import { PluginTestSteps } from '@/plugins/PluginTestSteps'
import { TestStepsEditor } from './TestStepsEditor'
import { PageIntro } from './parts'
import type { AiSession, SetField } from './project-draft'

/**
 * 项目设置 →「测试步骤」：验证范围的两个开关、步骤编辑器和插件自带的步骤。
 * 从 ProjectSettingsDialog.tsx 挪出；只读写草稿里的 testSteps、wslDistro、scaledVerify、requireVerify、pluginStepsOff。
 */
export function TestsPage({
  draft,
  set,
  gitRepo,
  onAssist,
}: {
  draft: ProjectInput
  set: SetField
  /** 项目是 Git 仓库：「禁止子对话执行」才生效（ADR 0018） */
  gitRepo: boolean
  onAssist: (s: AiSession) => void
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <PageIntro
        title={t('测试步骤')}
        desc={t(
          '测试验收角色按这里的顺序执行。改了这里，进行中的对话下一次执行就按新步骤走；写清楚命令、在哪执行和什么时候跑，没有配置时它会自己找命令并提醒你补上。',
        )}
      />
      <Checkbox
        checked={draft.scaledVerify}
        onChange={(v) => set('scaledVerify', v)}
        label={t('按改动大小决定验证范围')}
        tip={t(
          '对话里改代码时，角色先判断改动大小：改文案、样式这类小改动只跑勾了「小改动也跑」的步骤就收尾，其他改动跑完整的测试步骤。关掉后每次都按「适用改动」跑完整的步骤（不适用的一样跳过）。工作流里的测试验收不受影响。',
        )}
      />
      <Checkbox
        checked={!!draft.requireVerify}
        onChange={(v) => set('requireVerify', v)}
        label={t('改了代码要跑过测试步骤才能结束')}
        tip={t(
          '对话用 end_turn 说做完了时，面板看这一轮改了什么、跑了什么：改了代码，适用这次改动的测试步骤却一条都没跑过、或者最后一次没通过（没配步骤时看测试、类型检查或编译），就不让它结束，并告诉它去跑或修。用命令、插件工具改的文件也算；插件自己验证通过的资产不再要求跑这里的步骤。关着时不拦，只在「完成依据」卡片上标出来。',
        )}
      />
      <TestStepsEditor
        steps={draft.testSteps}
        distro={draft.wslDistro}
        gitRepo={gitRepo}
        onChange={(v) => set('testSteps', v)}
        onDistro={(v) => set('wslDistro', v)}
        aiRunning={false}
        onAi={() =>
          onAssist({
            kind: 'teststeps',
            title: t('AI 生成测试步骤'),
            start: t('按这个项目现在的脚本和配置，生成类型检查、单元测试、端到端和构建的测试步骤'),
          })
        }
      />
      <PluginTestSteps off={draft.pluginStepsOff ?? []} onChange={(v) => set('pluginStepsOff', v)} />
    </div>
  )
}
