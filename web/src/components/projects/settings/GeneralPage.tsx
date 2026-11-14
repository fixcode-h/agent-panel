import { Loader2, Sparkles } from 'lucide-react'
import type { FileFormat, Project, ProjectInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { CategoryPicker } from '@/components/ui/category-picker'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FormSection, Input, Select } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { BudgetField } from '../BudgetField'
import { CherryPickTarget } from '../CherryPickTarget'
import { DirPicker, type useDirInfo } from '../DirPicker'
import { SearchExcludeField } from './SearchExcludeField'
import { CodeIndexField } from './CodeIndexField'
import type { SetField, Vcs } from './project-draft'

/**
 * 项目设置 →「常规」：名称、目录、cherry-pick、文件格式、搜索、独立分支、子对话、用量上限、推送。
 * 从 ProjectSettingsDialog.tsx 挪出；草稿在弹窗上（点「确认」才保存），这里按 set 改自己这几项。
 */
export function GeneralPage({
  project,
  draft,
  set,
  pickDir,
  dir,
  vcs,
  globalFormat,
  analyzing,
  onStartInit,
}: {
  project?: Project
  draft: ProjectInput
  set: SetField
  /** 换目录：名称没改过时跟着变成新的文件夹名 */
  pickDir: (path: string) => void
  dir: ReturnType<typeof useDirInfo>
  vcs: Vcs
  /** 项目没单独设置时跟随的全局格式 */
  globalFormat: FileFormat
  analyzing: boolean
  onStartInit: () => void
}) {
  const { projectCategories, setProjectCategories } = useData()
  const gitRepo = vcs === 'git'
  // 项目没单独设置时跟随全局的格式，下拉框里直接显示实际生效的那个
  const format = draft.fileFormat ?? globalFormat
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-7">
      <FormSection title={t('基本信息')}>
        <div className="flex flex-wrap gap-4">
          <Field
            label={t('名称')}
            className="flex-[1_1_200px]"
            error={draft.name.trim() ? undefined : t('名称不能为空')}
          >
            <Input
              autoFocus={!project}
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={t('例如：官网前端')}
            />
          </Field>
          <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
            <span className="text-xs text-muted">{t('分类')}</span>
            <CategoryPicker
              value={draft.categoryId}
              onChange={(id) => set('categoryId', id)}
              options={projectCategories}
              onCreate={async (name) => {
                const c = await api.createProjectCategory({ name, description: '', workflowId: '' })
                setProjectCategories((cs) => [...cs, c])
                return c
              }}
            />
          </div>
        </div>
        <Field label={t('简介')}>
          <Input
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder={t('这个项目是做什么的')}
          />
        </Field>
      </FormSection>

      <FormSection title={t('本地目录')}>
        <DirPicker value={draft.path} onChange={pickDir} info={dir} />
        {!draft.initializedAt && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-accent-soft px-3.5 py-2.5">
            <Sparkles className="h-4 w-4 shrink-0 text-accent-text" />
            <span className="min-w-0 flex-1 text-body">
              {draft.path.trim()
                ? t('选好目录后先 AI 初始化项目：写好 AGENTS.md 和文档框架，并推荐工作流和设置。')
                : t('选好本地目录后，先 AI 初始化项目才能保存。')}
            </span>
            <Button size="sm" onClick={onStartInit} disabled={!draft.path.trim() || analyzing}>
              {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {t('AI 初始化项目')}
            </Button>
          </div>
        )}
      </FormSection>

      <FormSection title={t('Cherry-pick 目标')}>
        <CherryPickTarget
          vcs={vcs}
          path={draft.path.trim()}
          value={draft.cherryPick ?? ''}
          onChange={(v) => set('cherryPick', v)}
        />
      </FormSection>

      <FormSection title={t('文件格式')}>
        <div className="flex flex-wrap gap-3">
          <Field
            label={t('编码')}
            className="flex-[1_1_200px]"
            tip={t(
              '这个项目里新建和改写的文本文件用它，角色写文件时也按这个来。默认 UTF-8（不带 BOM）+ LF，在 WSL / Linux 里执行带 shebang 的脚本不会报 bad interpreter。',
            )}
          >
            <Select
              value={format.encoding}
              onChange={(e) => set('fileFormat', { ...format, encoding: e.target.value as typeof format.encoding })}
              options={[
                { value: 'utf8', label: t('UTF-8（不带 BOM）') },
                { value: 'utf8-bom', label: 'UTF-8（带 BOM）' },
              ]}
            />
          </Field>
          <Field label={t('换行符')} className="flex-[1_1_200px]">
            <Select
              value={format.eol}
              onChange={(e) => set('fileFormat', { ...format, eol: e.target.value as typeof format.eol })}
              options={[
                { value: 'lf', label: 'LF（Linux / macOS）' },
                { value: 'crlf', label: 'CRLF（Windows）' },
              ]}
            />
          </Field>
        </div>
        <span className="text-xs text-subtle">
          {!draft.fileFormat && (
            <>
              <Button variant="link" onClick={() => set('fileFormat', { ...globalFormat })}>
                {t('和全局设置不同时，在这里单独指定')}
              </Button>
            </>
          )}
          {draft.fileFormat && (
            <>
              <Button variant="link" onClick={() => set('fileFormat', undefined)}>
                {t('跟随全局设置')}
              </Button>
            </>
          )}
        </span>
      </FormSection>

      <FormSection title={t('搜索')}>
        <SearchExcludeField value={draft.searchExclude} onChange={(v) => set('searchExclude', v)} />
        <CodeIndexField value={draft.codeIndexTools} onChange={(v) => set('codeIndexTools', v)} />
      </FormSection>

      {gitRepo && (
        <FormSection title={t('独立分支')}>
          <Checkbox
            checked={draft.isolateByDefault}
            onChange={(v) => set('isolateByDefault', v)}
            label={t('新建对话默认开独立分支')}
            tip={t(
              '打开后新建对话时输入框里的「独立分支」默认勾上：对话在自己的 git 分支和目录里改，几个对话同时做不会互相覆盖，做完再决定合并还是丢弃。每次新建仍可以在输入框里改。',
            )}
          />
        </FormSection>
      )}

      <FormSection title={t('子对话')}>
        <Field
          label={t('子对话隔离')}
          tip={
            draft.childIsolation === 'worktree'
              ? t(
                  '每个子对话要改文件时才开自己的独立分支目录，互不干扰；编译、测试在自己的分支里跑，通过后排队合回父对话所在的分支，有冲突撤回并交回子对话。子对话标记完成后删除分支。不是 Git 仓库（P4 等）时自动用共用目录。',
                )
              : t(
                  '子对话都在项目目录里直接改，改文件前先认领，同一个文件同一时间只归一个子对话。不用建分支，但编译时可能读到别的子对话改到一半的文件。',
                )
          }
        >
          <div>
            <Segmented
              label={t('子对话隔离')}
              value={draft.childIsolation}
              onChange={(v) => set('childIsolation', v as ProjectInput['childIsolation'])}
              options={[
                { id: 'worktree', label: t('独立 worktree（推荐）') },
                { id: 'claim', label: t('共用目录 + 认领文件') },
              ]}
            />
          </div>
        </Field>
      </FormSection>

      <FormSection title={t('用量上限')}>
        <BudgetField value={draft.budget} onChange={(v) => set('budget', v)} />
      </FormSection>

      <FormSection title={t('版本与推送')}>
        <Field
          label={t('推送到远端')}
          tip={t(
            '只管 Git 推送与合并主干，本地提交不受影响。允许直接推送：对话做完、本地提交后推到跟踪的远端分支，再用 gh 建 PR 并合并到主干；问一次：那时先问你；不推送：面板直接拦下 git push。P4 submit 仍要你在对话里要求。',
          )}
        >
          <Select
            value={draft.gitPolicy}
            onChange={(v) => set('gitPolicy', v.target.value as ProjectInput['gitPolicy'])}
            options={[
              { value: 'ask', label: t('第一次需要推送时问一次（推荐）') },
              { value: 'allow', label: t('允许直接推送') },
              { value: 'deny', label: t('不推送，只做本地提交') },
            ]}
          />
        </Field>
      </FormSection>
    </div>
  )
}
