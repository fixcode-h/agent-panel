import { useState } from 'react'
import { FileText, ImageIcon, MessageSquare, Pencil, Search, Sparkles, Terminal, Workflow } from 'lucide-react'
import { t } from '@shared/i18n'
import { Badge, StatusDot, UnreadDot } from '@/components/ui/badge'
import { BUTTON_SIZES, BUTTON_VARIANTS, Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextRing } from '@/components/ui/context-ring'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { InlineChip } from '@/components/ui/inline-chip'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { ReplyHeader } from '@/components/ui/reply-header'
import { Segmented } from '@/components/ui/segmented'
import { STATUS_TONES, StatusPill, type StatusTone } from '@/components/ui/status-pill'
import { Switch } from '@/components/ui/switch'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { RowShell } from '@/components/tasks/ToolRow'
import { Group } from '@/components/settings/parts'

/** 一格展示：左边部件名（代码里的名字），右边实物 */
function Specimen({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 border-b border-line/80 py-4 last:border-b-0 sm:flex-row sm:gap-6">
      <span className="w-40 shrink-0 pt-1 font-mono text-[0.75rem] text-subtle">{name}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">{children}</div>
    </div>
  )
}

/**
 * 设置 → 组件：界面用到的通用部件全在这里，按当前配色和深浅色画出来。
 * 页面只用 components/ui 里的部件拼；新加或改了部件，在这里加一格，换配色时一眼能看全
 */
export function ComponentsSection() {
  const [tab, setTab] = useState('parent')
  const [side, setSide] = useState('files')
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('a')
  const [on, setOn] = useState(true)
  const [checked, setChecked] = useState(true)
  const [pick, setPick] = useState('claude')
  const [open, setOpen] = useState(false)
  const [kids, setKids] = useState(['review', 'flow'])
  const toneLabel: Record<StatusTone, string> = {
    run: t('运行中'),
    ok: t('已完成'),
    wait: t('等你回复'),
    err: t('失败'),
    idle: t('计划中'),
  }
  const close = (id: string) => {
    setKids((k) => k.filter((x) => x !== id))
    if (tab === id) setTab('parent')
  }
  return (
    <>
      <p className="pt-2 text-[0.8125rem] leading-relaxed text-subtle">
        {t('界面里用到的通用部件都在这里，按当前配色画出来。页面只用这些部件拼，改一处全站跟着变。')}
      </p>
      <Group title={t('按钮')}>
        <Specimen name="Button · variant">
          {BUTTON_VARIANTS.map((v) => (
            <Button key={v} variant={v}>
              {v}
            </Button>
          ))}
        </Specimen>
        <Specimen name="Button · size">
          {BUTTON_SIZES.map((s) =>
            s.startsWith('icon') ? (
              <Button key={s} variant="secondary" size={s} aria-label={s}>
                <Search className="h-4 w-4" />
              </Button>
            ) : (
              <Button key={s} size={s}>
                {s}
              </Button>
            ),
          )}
          <Button disabled>{t('不可用')}</Button>
        </Specimen>
      </Group>
      <Group title={t('状态')}>
        <Specimen name="StatusPill">
          {STATUS_TONES.map((tone) => (
            <StatusPill key={tone} tone={tone} spin={tone === 'run'}>
              {toneLabel[tone]}
            </StatusPill>
          ))}
        </Specimen>
        <Specimen name="Badge">
          <Badge>{t('内置')}</Badge>
          <Badge tone="accent">{t('新')}</Badge>
          <Badge tone="success">{t('已安装')}</Badge>
          <Badge tone="warning">{t('有更新')}</Badge>
        </Specimen>
        <Specimen name="StatusDot · UnreadDot · Kbd">
          <StatusDot tone="success" label={t('就绪')} />
          <StatusDot tone="warning" label={t('未登录')} />
          <StatusDot tone="muted" label={t('已停用')} />
          <UnreadDot />
          <Kbd>⌘K</Kbd>
          <Kbd>Esc</Kbd>
        </Specimen>
        <Specimen name="ContextRing">
          <ContextRing percent={23} label={t('上下文已用 {n}%', { n: 23 })} />
          <ContextRing percent={86} label={t('上下文已用 {n}%', { n: 86 })} />
        </Specimen>
      </Group>
      <Group title={t('输入')}>
        <Specimen name="Input · Select">
          <Input aria-label={t('示例输入框')} placeholder={t('搜索任务')} className="w-56" />
          <Select
            aria-label={t('示例下拉框')}
            className="w-56"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            options={[
              { value: 'claude', label: 'Claude Code' },
              { value: 'codex', label: 'Codex' },
              { value: 'pi', label: 'Pi' },
            ]}
          />
        </Specimen>
        <Specimen name="Textarea">
          <Textarea
            aria-label={t('示例多行输入')}
            rows={2}
            placeholder={t('继续输入要求')}
            className="w-full max-w-md"
          />
        </Specimen>
        <Specimen name="Switch · Checkbox · Segmented">
          <Switch checked={on} onCheckedChange={setOn} aria-label={t('示例开关')} />
          <Checkbox checked={checked} onChange={setChecked} label={t('推送到远端')} />
          <Segmented
            label={t('示例分段')}
            value={seg}
            onChange={setSeg}
            options={[
              { id: 'a', label: 'Skill' },
              { id: 'b', label: t('命令') },
              { id: 'c', label: t('自带 Skill') },
            ]}
          />
        </Specimen>
      </Group>
      <Group title={t('页签')}>
        <Specimen name="TabBar · TabItem">
          <div className="w-full overflow-hidden rounded-lg border">
            <TabBar label={t('示例页签')}>
              <TabItem
                active={tab === 'parent'}
                onSelect={() => setTab('parent')}
                busy
                icon={<MessageSquare className="h-3.5 w-3.5" />}
              >
                {t('右栏改成页签工作台')}
              </TabItem>
              {kids.includes('review') && (
                <TabItem
                  active={tab === 'review'}
                  onSelect={() => setTab('review')}
                  onClose={() => close('review')}
                  tag={t('子对话')}
                  icon={<MessageSquare className="h-3.5 w-3.5" />}
                >
                  {t('代码审查')}
                </TabItem>
              )}
              {kids.includes('flow') && (
                <TabItem
                  active={tab === 'flow'}
                  onSelect={() => setTab('flow')}
                  onClose={() => close('flow')}
                  tag={t('工作流')}
                  icon={<Workflow className="h-3.5 w-3.5" />}
                >
                  {t('开发流程')}
                </TabItem>
              )}
            </TabBar>
            <div className="h-10 bg-bg" />
          </div>
        </Specimen>
        <Specimen name="TabItem · fill">
          <div className="w-full max-w-sm overflow-hidden rounded-lg border">
            <TabBar label={t('示例右栏页签')}>
              <TabItem fill active={side === 'files'} onSelect={() => setSide('files')}>
                {t('项目文件')}
              </TabItem>
              <TabItem fill active={side === 'changes'} onSelect={() => setSide('changes')} tag="3">
                {t('本对话改动')}
              </TabItem>
            </TabBar>
            <div className="h-10 bg-bg" />
          </div>
        </Specimen>
      </Group>
      <Group title={t('对话部件')}>
        <Specimen name="ReplyHeader">
          <ReplyHeader
            avatar={
              <span className="grid h-[26px] w-[26px] place-items-center rounded-[7px] bg-[#be185d] text-white">
                <Workflow className="h-3.5 w-3.5" />
              </span>
            }
            name={t('主理')}
            agent={t('Command（默认）')}
            effort={t('高档')}
            model="OpenDesign/deepseek-v4.1-flash"
          />
        </Specimen>
        <Specimen name="RowShell">
          <div className="flex w-full flex-col gap-1">
            <RowShell
              glyph={<Search className="h-3.5 w-3.5" />}
              verb={t('搜索')}
              title="sticky top-0"
              ms={111}
              open={false}
            />
            <RowShell
              glyph={<Pencil className="h-3.5 w-3.5" />}
              verb={t('编辑')}
              title="web/src/components/tasks/ProjectWorkspace.tsx"
              detail={<span className="text-success">+31 −30</span>}
              ms={56}
              open={open}
              onToggle={() => setOpen((o) => !o)}
            >
              <pre className="px-3 py-2 font-mono text-[0.75rem] text-muted">
                {'- <header className="sticky top-0">'}
              </pre>
            </RowShell>
            <RowShell
              glyph={<Terminal className="h-3.5 w-3.5" />}
              verb={t('后台命令')}
              title='npm run test:unit > "$SCRATCHPAD/unit.log" 2>&1'
              detail={<span className="text-danger">{t('结果丢失')}</span>}
              ms={0}
              failed
              open={false}
            />
          </div>
        </Specimen>
        <Specimen name="InlineChip">
          <p className="text-[0.875rem] leading-7">
            {t('按这张')}
            <InlineChip icon={<ImageIcon className="h-3.5 w-3.5" />} label="草图.png" status={t('已上传')} />
            {t('改，规则参考')}
            <InlineChip
              icon={<FileText className="h-3.5 w-3.5" />}
              label="docs/lessons/ui.md"
              status={t('引用路径')}
              mono
            />
            {t('，用')}
            <InlineChip icon={<Sparkles className="h-3.5 w-3.5 text-peer" />} label="code-review" status="Skill" />
          </p>
        </Specimen>
      </Group>
      <Group title={t('空状态')}>
        <Specimen name="EmptyPanel">
          <EmptyPanel size="md" className="w-full max-w-md">
            {t('还没有计划')}
          </EmptyPanel>
        </Specimen>
      </Group>
    </>
  )
}
