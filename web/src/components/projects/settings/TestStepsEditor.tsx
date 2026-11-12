import { useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, Sparkles, Trash2 } from 'lucide-react'
import type { TestStep } from '@shared/schema'
import { ENV_LABEL, newTestStepId, parseGlobs } from '@shared/test-steps'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Checkbox } from '@/components/ui/checkbox'
import { Input, Select } from '@/components/ui/input'

/**
 * 测试步骤编辑器：增删、排序、启停，每条写明名称、命令、环境和工作目录。
 * 步骤属于项目，改了保存就对进行中的对话生效（执行时现读项目设置），所以这里改完要点「确认」。
 */
export function TestStepsEditor({
  steps,
  distro,
  gitRepo,
  onChange,
  onDistro,
  onAi,
  aiRunning,
}: {
  steps: TestStep[]
  distro: string
  /** 项目是 Git 仓库：「禁止子对话执行」才生效（ADR 0018），不是时置灰并说明原因 */
  gitRepo: boolean
  onChange: (v: TestStep[]) => void
  onDistro: (v: string) => void
  onAi: () => void
  aiRunning: boolean
}) {
  const patch = (i: number, p: Partial<TestStep>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...p } : s)))
  // 「适用改动」在输入过程中保存用户敲的原文（逗号、空格原样回显），失焦后才按 parseGlobs 归一。
  // 每次按键就 parse 再 join 会把刚敲下的逗号吞掉，手敲不进第二条 glob，续敲会拼成匹配不上的串。
  // 草稿按步骤 id 记：上下移动不会串到别的步骤；内部生成的步骤 id 可能重复（两个都叫 node-typecheck），
  // 那时草稿会短暂盖住 AI 回填的新值，下一次失焦就对上了
  const [appliesDraft, setAppliesDraft] = useState<Record<string, string>>({})
  const dropDraft = (id: string) =>
    setAppliesDraft((d) => {
      const next = { ...d }
      delete next[id]
      return next
    })
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const hasWsl = steps.some((s) => s.env === 'wsl')
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-xs leading-relaxed text-subtle">
          {t(
            '测试角色按这些步骤执行构建、测试和检查。改了这里，进行中的对话下一轮、下一次子对话合并就按新步骤执行（命令、开关都是现读的），不用等新建对话；没配置时角色会自己找命令并建议你补上。',
          )}
          {t(
            '每条可以写「适用改动」（glob）：只改文档、资源这类没碰到的步骤会被跳过，并在验收结论里写清原因——同时会算上从远端拉取、合并进来的改动。',
          )}
          {t(
            '每条步骤选一个范围：「总是跑」每次改动都跑（类型检查、lint 这类几十秒的）；「命中适用改动才跑」只在改动命中了下面的 glob 时跑，子对话只跑命中的单测文件 / 界面分片；「全量，合并后由父对话跑」子对话不跑，合并回父对话的分支后由父对话跑（一次只跑一个），结果和耗时回传给子对话，适合全量单测、全量界面检查、端到端测试。最后的范围只对 Git 项目的独立分支子对话生效，其他情况步骤照常由执行者自己跑。',
          )}
        </span>
        <Button size="sm" variant="secondary" onClick={onAi} disabled={aiRunning}>
          {aiRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {t('AI 生成步骤')}
        </Button>
      </div>
      {steps.length === 0 && (
        <EmptyPanel size="sm" className="text-xs">
          {t('还没有测试步骤。「AI 初始化项目」会按项目的脚本推荐一份。')}
        </EmptyPanel>
      )}
      <ul className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <li key={s.id} className={cn('flex flex-col gap-2 rounded-xl bg-sel/40 p-3', !s.enabled && 'opacity-60')}>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-subtle">{i + 1}</span>
              <Input
                className="h-8 flex-[1_1_140px]"
                value={s.name}
                aria-label={t('步骤名')}
                placeholder={t('步骤名，例如「单元测试」')}
                onChange={(e) => patch(i, { name: e.target.value })}
              />
              <Select
                className="h-8 w-auto min-w-[6.5rem]"
                aria-label={t('环境')}
                value={s.env}
                onChange={(e) => patch(i, { env: e.target.value as TestStep['env'] })}
                options={(Object.keys(ENV_LABEL) as TestStep['env'][]).map((k) => ({ value: k, label: ENV_LABEL[k] }))}
              />
              <IconButton icon={ChevronUp} size="sm" label={t('上移')} onClick={() => move(i, -1)} />
              <IconButton icon={ChevronDown} size="sm" label={t('下移')} onClick={() => move(i, 1)} />
              <IconButton
                icon={Trash2}
                size="sm"
                label={t('删除这一步')}
                onClick={() => onChange(steps.filter((_, j) => j !== i))}
              />
            </div>
            <Input
              className="h-8 font-mono text-xs"
              value={s.command}
              aria-label={t('命令')}
              placeholder={t('要执行的命令')}
              onChange={(e) => patch(i, { command: e.target.value })}
            />
            <Input
              className="h-8 font-mono text-xs"
              value={appliesDraft[s.id] ?? (s.appliesTo ?? []).join(', ')}
              aria-label={t('适用改动')}
              placeholder={t('适用改动（相对项目根的 glob，逗号分隔）：例如 **/*.cpp、**/Build.cs；留空表示总是执行')}
              onChange={(e) => {
                // 原文留给输入框，步骤里存解析后的 glob：保存和提示词都读后者
                const text = e.target.value
                setAppliesDraft((d) => ({ ...d, [s.id]: text }))
                patch(i, { appliesTo: parseGlobs(text) })
              }}
              onBlur={() => dropDraft(s.id)}
            />
            {s.scope === 'always' && (
              <span className="text-xs text-subtle">
                {t('范围是「总是跑」时不用填这里：这条每次都跑，不按 glob 筛')}
              </span>
            )}
            {s.scope === 'parent' && (
              <span className="text-xs text-subtle">
                {t('范围是「全量，合并后由父对话跑」时不用填这里：合并后由父对话跑全量，不按 glob 筛')}
              </span>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 flex-[1_1_120px] font-mono text-xs"
                value={s.cwd}
                aria-label={t('工作目录')}
                placeholder={t('工作目录（相对项目根，可空）')}
                onChange={(e) => patch(i, { cwd: e.target.value })}
              />
              <Input
                className="h-8 flex-[1_1_140px] text-xs"
                value={s.when}
                aria-label={t('补充说明')}
                placeholder={t('补充说明，写给人看（判定以适用改动为准）')}
                onChange={(e) => patch(i, { when: e.target.value })}
              />
              <Input
                className="h-8 w-[7rem] text-xs"
                type="number"
                min={0}
                value={s.timeoutSec || ''}
                aria-label={t('超时秒数')}
                placeholder={t('超时（秒）')}
                onChange={(e) => patch(i, { timeoutSec: Math.max(0, Number(e.target.value) || 0) })}
              />
              <Checkbox
                checked={s.enabled}
                onChange={(v) => patch(i, { enabled: v })}
                label={t('启用')}
                className="items-center"
              />
              <span
                className="flex"
                title={t('角色判断是小改动时只跑勾了这项的步骤，适合几十秒内跑完的类型检查、lint')}
              >
                <Checkbox
                  checked={s.quick}
                  onChange={(v) => patch(i, { quick: v })}
                  label={t('小改动也跑')}
                  className="items-center"
                />
              </span>
              <label
                className="flex items-center gap-1.5 text-xs text-muted"
                title={t(
                  '子对话只跑「总是跑」和命中了「适用改动」的步骤；选「全量，合并后由父对话跑」的步骤子对话不跑，合并后由父对话在全量里跑。',
                )}
              >
                {t('范围')}
                <Select
                  className="h-8 w-[12.5rem] text-xs"
                  aria-label={t('范围')}
                  value={s.scope}
                  onChange={(e) => patch(i, { scope: e.target.value as TestStep['scope'] })}
                  options={[
                    { value: 'always', label: t('总是跑') },
                    { value: 'changed', label: t('命中适用改动才跑') },
                    {
                      value: 'parent',
                      label: gitRepo ? t('全量，合并后由父对话跑') : t('全量（非 Git 项目自己跑）'),
                    },
                  ]}
                />
              </label>
            </div>
            {s.note && <span className="text-xs text-subtle">{s.note}</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            onChange([
              ...steps,
              {
                id: newTestStepId(steps),
                name: '',
                command: '',
                env: 'auto',
                cwd: '',
                when: '',
                appliesTo: [],
                timeoutSec: 0,
                note: '',
                enabled: true,
                merge: false,
                scope: 'always' as const,
                quick: false,
              },
            ])
          }
        >
          {t('加一条步骤')}
        </Button>
        {hasWsl && (
          <label className="flex items-center gap-2 text-xs text-subtle">
            {t('WSL 发行版')}
            <Input
              className="h-8 w-[10rem] font-mono text-xs"
              value={distro}
              placeholder="Ubuntu-24.04"
              onChange={(e) => onDistro(e.target.value)}
            />
          </label>
        )}
      </div>
    </div>
  )
}
