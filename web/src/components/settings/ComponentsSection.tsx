import { useState } from 'react'
import {
  Diff,
  FileText,
  ImageIcon,
  Lock,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Smartphone,
  Sparkles,
  Terminal,
  Trash2,
  Workflow,
  WrapText,
  X,
  ZoomIn,
} from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Badge, StatusDot, UnreadDot } from '@/components/ui/badge'
import { BUTTON_SIZES, BUTTON_VARIANTS, Button, LINK_TONES } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ChipGroup } from '@/components/ui/chip-group'
import { ComposerPopover } from '@/components/ui/composer-popover'
import { ICON_BUTTON_SIZES, IconButton, ToggleIconButton } from '@/components/ui/icon-button'
import { InlineRename } from '@/components/ui/inline-rename'
import { menuItem } from '@/components/ui/menu'
import { MenuSearch } from '@/components/ui/menu-search'
import { MODAL_SIZES, Modal, type ModalSize } from '@/components/ui/modal'
import { PROGRESS_TONES, Progress } from '@/components/ui/progress'
import { Sheet } from '@/components/ui/sheet'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextRing } from '@/components/ui/context-ring'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { FlowStrip } from '@/components/ui/flow-strip'
import { InlineChip } from '@/components/ui/inline-chip'
import { MessageChip } from '@/components/chat/AttachmentView'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { ReplyHeader } from '@/components/ui/reply-header'
import { Segmented } from '@/components/ui/segmented'
import { STATUS_TONES, StatusPill, type StatusTone } from '@/components/ui/status-pill'
import { Switch } from '@/components/ui/switch'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { SourceLink } from '@/components/ui/source-link'
import { Logo } from '@/components/layout/Sidebar'
import {
  NavRow,
  SIDEBAR_GROUP_LABEL,
  SidebarModeMenu,
  SidebarProjectName,
  SidebarProjectRow,
  SidebarTaskBlock,
  SidebarTaskRowBody,
  TaskRowStatus,
  sidebarTaskRowClass,
} from '@/components/ui/sidebar'
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
        <MoreButtonSpecimens />
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
          <Badge tone="danger">{t('{n} 个失败', { n: 2 })}</Badge>
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
        <Specimen name="Progress">
          <div className="flex w-full max-w-sm flex-col gap-2.5">
            {PROGRESS_TONES.map((tone, i) => (
              <Progress key={tone} tone={tone} value={22 + i * 18} size={i % 2 ? 'xs' : 'sm'} label={t('示例进度')} />
            ))}
          </div>
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
          {/* sm：页头工具条里的视图切换（计划页「周 / 月 / 列表」） */}
          <Segmented
            size="sm"
            label={t('示例视图切换')}
            value={seg}
            onChange={setSeg}
            options={[
              { id: 'a', label: t('周') },
              { id: 'b', label: t('月') },
              { id: 'c', label: t('列表') },
            ]}
          />
        </Specimen>
        <MoreInputSpecimens />
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
        <Specimen name="TabBar · fit">
          <div className="w-full max-w-sm overflow-hidden rounded-lg border">
            <TabBar label={t('示例右栏页签')} variant="fit">
              <TabItem
                active={side === 'files'}
                onSelect={() => setSide('files')}
                icon={<FileText className="h-[0.8125rem] w-[0.8125rem]" />}
              >
                {t('项目文件')}
              </TabItem>
              <TabItem
                active={side === 'changes'}
                onSelect={() => setSide('changes')}
                icon={<Diff className="h-[0.8125rem] w-[0.8125rem]" />}
                tag="3"
              >
                {t('本对话改动')}
              </TabItem>
            </TabBar>
            <div className="h-10 bg-bg" />
          </div>
        </Specimen>
        <UnderlineTabSpecimen />
      </Group>
      <Group title={t('对话部件')}>
        <Specimen name="ReplyHeader">
          {/* 和对话里一样：图标 22px 宽、名字 15px，模型只写最后一段、强度写英文；正文缩进到名字那一列（reply-body） */}
          <div className="reply-body flex w-full flex-col gap-2">
            <ReplyHeader
              // 回复头的角色图标不带底色块，只是一个按 CLI 着色的图标
              avatar={
                <span className="flex h-7 w-[22px] items-center justify-center text-[#be185d]">
                  <Workflow className="h-[18px] w-[18px]" strokeWidth={2} />
                </span>
              }
              name={t('主理')}
              model="deepseek-v4.1-flash"
              effort="high"
            />
            <p className="text-[0.875rem] leading-relaxed text-fg">{t('先看一下现有的实现，再按设计稿改。')}</p>
          </div>
        </Specimen>
        <Specimen name="RowShell">
          {/* 过程行一组：每行默认浅底，行间留间距、不画分隔线（proc-list） */}
          <div className="proc-list flex w-full flex-col">
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
            <InlineChip
              tone="image"
              icon={<ImageIcon className="h-3.5 w-3.5" />}
              label="草图.png"
              status={t('已上传')}
            />
            {t('改，规则参考')}
            <InlineChip
              tone="file"
              icon={<FileText className="h-3.5 w-3.5" />}
              label="docs/lessons/ui.md"
              status={t('引用路径')}
              mono
            />
            {t('，用')}
            <InlineChip tone="skill" icon={<Sparkles className="h-3.5 w-3.5" />} label="code-review" status="Skill" />
          </p>
        </Specimen>
        <Specimen name="MessageChip">
          {/* 用户气泡里的卡片：气泡本身是 bg-sel，卡片要靠自己的颜色从气泡里跳出来 */}
          <div className="rounded-2xl bg-sel px-4 py-2.5 text-[0.9375rem] leading-relaxed">
            <MessageChip kind="quote" name="关于「截图」这一段" />
            {t('这里再改改，和')}
            <MessageChip kind="image" name="截图-081218.png" />
            {t('一样，参考')}
            <MessageChip kind="file" name="设计稿.pdf" />
            <MessageChip kind="image" name="旧图.png" missing />
          </div>
        </Specimen>
        <Specimen name="FlowStrip">
          {/* 工作流节点条：完成绿、运行中强调、没开始灰，节点之间一小段横线 */}
          <FlowStrip
            nodes={[
              { id: 'a', label: t('需求分析'), state: 'done' },
              { id: 'b', label: t('方案设计'), state: 'done' },
              { id: 'c', label: t('开发'), state: 'running' },
              { id: 'd', label: t('审查'), state: 'idle' },
              { id: 'e', label: t('合并'), state: 'idle' },
            ]}
          />
        </Specimen>
        <Specimen name="SourceLink">
          {/* Chat 右栏「来源」页签的一行：域名首字母方块 + 域名，路径和搜索词是小字 */}
          <div className="flex w-80 flex-col gap-px">
            <SourceLink
              url="https://react.dev/reference/react/use"
              host="react.dev"
              path="/reference/react/use"
              note="react.dev use() 文档"
            />
            <SourceLink url="https://github.com/facebook/react" host="github.com" path="/facebook/react" />
          </div>
        </Specimen>
      </Group>
      <Group title={t('侧栏')}>
        <Specimen name="ModeMenu · NavRow · ProjectRow · TaskRow">
          {/* 侧栏贴着底色画：项目 → 对话两层，选中项目是淡蓝底，选中对话是白卡片，行尾状态做轻 */}
          <div className="flex w-64 flex-col gap-0.5 rounded-lg bg-rail px-2.5 py-2.5">
            <div className="mb-2 flex">
              <SidebarModeMenu
                logo={<Logo />}
                modes={[
                  { id: 'agent', name: 'Agent', desc: t('按项目调度 CLI'), on: true },
                  { id: 'chat', name: 'Chat', desc: t('直接对话'), on: false },
                  { id: 'design', name: t('设计'), desc: t('画板'), on: false },
                ]}
                onPick={() => {}}
              />
            </div>
            {/* 快捷键和侧栏一样：悬停到这一行才出现 */}
            <NavRow
              icon={<Plus className="h-4 w-4" strokeWidth={1.8} />}
              label={t('新建任务')}
              className="group/nav"
              trailing={<Kbd className="ml-auto opacity-0 transition-opacity group-hover/nav:opacity-100">⌘⇧O</Kbd>}
            />
            <NavRow icon={<Workflow className="h-4 w-4" strokeWidth={1.8} />} label={t('工作流')} on />
            <p className={cn('px-2 pt-2.5 pb-1.5 font-semibold tracking-[0.08em]', SIDEBAR_GROUP_LABEL)}>{t('项目')}</p>
            {/* 项目行和对话行用侧栏同一套部件：正在看的项目是淡蓝底，里面选中的对话是白卡片 */}
            <SidebarProjectRow
              open
              on
              count={3}
              name={
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <SidebarProjectName open on name="agent-panel" />
                </span>
              }
            />
            <SidebarTaskBlock>
              <div className={cn(sidebarTaskRowClass(true, true), 'pr-2 pl-2')}>
                <SidebarTaskRowBody
                  active
                  title={t('右栏改成页签工作台')}
                  status={<TaskRowStatus kids={8} running />}
                />
              </div>
              <div className={cn(sidebarTaskRowClass(false, true), 'pr-2 pl-2')}>
                <SidebarTaskRowBody workflow title={t('修复设置弹窗闪动')} status={<TaskRowStatus unread />} />
              </div>
              <div className={cn(sidebarTaskRowClass(false, true), 'pr-2 pl-2')}>
                <SidebarTaskRowBody title={t('接入 Pi CLI 输出')} status={<TaskRowStatus needs />} />
              </div>
            </SidebarTaskBlock>
            <SidebarProjectRow
              open={false}
              running={1}
              count={2}
              name={
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <SidebarProjectName open={false} name="docs-site" />
                </span>
              }
            />
          </div>
        </Specimen>
      </Group>
      <Group title={t('空状态')}>
        <Specimen name="EmptyPanel">
          <EmptyPanel size="md" className="w-full max-w-md">
            {t('还没有计划')}
          </EmptyPanel>
        </Specimen>
      </Group>
      <OverlaySpecimens />
      <CardCanvasSpecimens />
    </>
  )
}

/*
 * 下面是第二批通用部件的样例，各自带自己的状态，不把上面主组件的 state 越拉越长
 */

function MoreButtonSpecimens() {
  const [readOnly, setReadOnly] = useState(true)
  const [wrap, setWrap] = useState(false)
  const linkLabel = {
    accent: t('打开这次执行'),
    muted: t('清除'),
    warning: t('仍要继续'),
    danger: t('失败 · AI 分析'),
  }
  return (
    <>
      <Specimen name="Button · link">
        {LINK_TONES.map((tone) => (
          <Button key={tone} variant="link" tone={tone}>
            {linkLabel[tone]}
          </Button>
        ))}
      </Specimen>
      <Specimen name="IconButton">
        {ICON_BUTTON_SIZES.map((s) => (
          <IconButton key={s} size={s} icon={MoreHorizontal} label={t('更多操作')} />
        ))}
        <IconButton size="sm" tone="danger" icon={Trash2} label={t('删除')} />
        {/* tone="bare"：页签条右端、输入框工具条这类一排图标，悬停也不出底，只变前景色 */}
        <IconButton size="sm" tone="bare" icon={MoreHorizontal} label={t('更多操作')} />
        {/* reveal="hover"：行尾操作平时不出现，悬停这一行才出来 */}
        <div className="group flex h-8 items-center gap-2 rounded-lg bg-sel/50 pr-1 pl-2.5 text-[0.8125rem]">
          {t('悬停这一行')}
          <IconButton reveal="hover" icon={X} label={t('移除')} />
        </div>
      </Specimen>
      <Specimen name="ToggleIconButton">
        <ToggleIconButton size="sm" icon={Lock} label={t('只读')} pressed={readOnly} onPressedChange={setReadOnly} />
        <ToggleIconButton size="sm" icon={WrapText} label={t('自动换行')} pressed={wrap} onPressedChange={setWrap} />
      </Specimen>
    </>
  )
}

function MoreInputSpecimens() {
  const [range, setRange] = useState('7d')
  const [status, setStatus] = useState<'all' | 'run' | 'done'>('all')
  const [days, setDays] = useState(['1', '3', '5'])
  const [name, setName] = useState(t('右栏改成页签工作台'))
  const [renaming, setRenaming] = useState(false)
  const [q, setQ] = useState('')
  const week = [t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六'), t('周日')]
  return (
    <>
      <Specimen name="Input · Select · sm · xs">
        <Input size="sm" aria-label={t('示例紧凑输入框')} placeholder={t('筛选')} className="w-44" />
        {/* xs：属性面板一行一个属性的小框 */}
        <Input size="xs" aria-label={t('示例属性输入框')} defaultValue="1920" className="w-20 font-mono" />
        <Select
          size="sm"
          aria-label={t('示例紧凑下拉框')}
          className="w-36"
          value={range}
          onChange={(e) => setRange(e.target.value)}
          options={[
            { value: '7d', label: t('近 7 天') },
            { value: 'all', label: t('全部') },
          ]}
        />
      </Specimen>
      <Specimen name="ChipGroup">
        <ChipGroup
          label={t('示例单选小块')}
          value={status}
          onChange={setStatus}
          options={[
            { id: 'all', label: t('全部') },
            { id: 'run', label: t('运行中') },
            { id: 'done', label: t('已完成') },
          ]}
        />
        <ChipGroup
          multiple
          size="sm"
          label={t('示例多选小块')}
          value={days}
          onChange={setDays}
          options={week.map((d, i) => ({ id: String(i + 1), label: d }))}
        />
      </Specimen>
      <Specimen name="InlineRename">
        {renaming ? (
          <InlineRename
            label={t('任务标题')}
            value={name}
            onCommit={(v) => {
              setRenaming(false)
              if (v.trim()) setName(v.trim())
            }}
            onCancel={() => setRenaming(false)}
            className="w-64"
          />
        ) : (
          <span className="flex h-8 items-center gap-1.5 text-[0.8125rem] font-medium">
            {name}
            <IconButton icon={Pencil} label={t('重命名')} onClick={() => setRenaming(true)} />
          </span>
        )}
      </Specimen>
      <Specimen name="MenuSearch">
        <div className="flex w-64 flex-col rounded-xl bg-card p-1 shadow-pop">
          <MenuSearch autoFocus={false} value={q} onChange={setQ} placeholder={t('筛选')} />
          {['Claude Code', 'Codex', 'Pi']
            .filter((n) => n.toLowerCase().includes(q.trim().toLowerCase()))
            .map((n) => (
              <div key={n} className={menuItem}>
                {n}
              </div>
            ))}
        </div>
      </Specimen>
    </>
  )
}

function UnderlineTabSpecimen() {
  const [tab, setTab] = useState('overview')
  const tabs = [
    { id: 'overview', label: t('概览') },
    { id: 'runs', label: t('运行记录') },
    { id: 'settings', label: t('设置') },
  ]
  return (
    <Specimen name="TabBar · underline">
      <div className="w-full max-w-md">
        <TabBar variant="underline" label={t('示例页内页签')}>
          {tabs.map((x) => (
            <TabItem key={x.id} active={tab === x.id} onSelect={() => setTab(x.id)}>
              {x.label}
            </TabItem>
          ))}
        </TabBar>
      </div>
    </Specimen>
  )
}

function OverlaySpecimens() {
  const [modal, setModal] = useState<ModalSize | 'bare' | null>(null)
  const [sheet, setSheet] = useState<'left' | 'right' | null>(null)
  const [side, setSide] = useState<'left' | 'right'>('right')
  const bare = modal === 'bare'
  return (
    <Group title={t('弹层')}>
      <Specimen name="Modal · size · bare">
        {MODAL_SIZES.map((s) => (
          <Button key={s} variant="secondary" size="sm" onClick={() => setModal(s)}>
            {s}
          </Button>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setModal('bare')}>
          bare
        </Button>
        <Modal
          open={modal !== null}
          onOpenChange={(o) => !o && setModal(null)}
          size={modal && !bare ? modal : undefined}
          bare={bare}
          closeOnOutside={bare}
          title={t('示例弹窗')}
          footer={
            <Button variant="secondary" className="ml-auto" onClick={() => setModal(null)}>
              {t('关闭')}
            </Button>
          }
        >
          {bare ? (
            <p className="p-6 text-[0.8125rem] text-muted">{t('只有外壳：标题栏和留白由调用方自己画，点外面就关。')}</p>
          ) : (
            <p className="text-[0.8125rem] text-muted">{t('宽度按档位取；不传 size 时和原来一样。')}</p>
          )}
        </Modal>
      </Specimen>
      <Specimen name="Sheet">
        {(['right', 'left'] as const).map((s) => (
          <Button
            key={s}
            variant="secondary"
            size="sm"
            onClick={() => {
              setSide(s)
              setSheet(s)
            }}
          >
            {s === 'right' ? t('从右边打开') : t('从左边打开')}
          </Button>
        ))}
        <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)} side={side} title={t('示例抽屉')}>
          <p className="text-[0.8125rem] leading-relaxed text-muted">
            {t('抽屉是浮起的一整列，靠底色和投影和页面分开，不描边。')}
          </p>
        </Sheet>
      </Specimen>
      <Specimen name="ComposerPopover">
        {/* 输入框外壳要是 relative，弹层贴在它顶上往上长 */}
        <div className="relative mt-24 w-full max-w-md rounded-xl bg-field px-3 py-2.5 text-[0.8125rem] text-subtle shadow-card">
          <ComposerPopover stretch scroll>
            {['/commit', '/review'].map((c) => (
              <div key={c} className={cn(menuItem, 'font-mono text-[0.75rem]')}>
                {c}
              </div>
            ))}
          </ComposerPopover>
          {t('继续输入要求')}
        </div>
      </Specimen>
    </Group>
  )
}

function CardCanvasSpecimens() {
  const [clicks, setClicks] = useState(0)
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop')
  return (
    <>
      <Group title={t('卡片')}>
        <Specimen name="Card · padding · interactive">
          <Card padding="md" className="flex w-56 flex-col gap-1 text-[0.8125rem]">
            <span className="font-medium">{t('代码审查')}</span>
            <span className="text-subtle">padding="md"</span>
          </Card>
          <Card
            as="button"
            interactive
            padding="md"
            onClick={() => setClicks((n) => n + 1)}
            className="flex w-56 flex-col gap-1 text-[0.8125rem]"
          >
            <span className="font-medium">{t('整张可点')}</span>
            <span className="text-subtle">{t('点了 {n} 次', { n: clicks })}</span>
          </Card>
        </Specimen>
      </Group>
      <Group title={t('深色画布')}>
        <Specimen name="Canvas · on-canvas">
          {/* 画布不跟主题变：工具条、按钮、分段都用 --canvas-* 这组色 */}
          <div className="flex h-32 w-full items-end justify-center rounded-xl bg-canvas p-3">
            <div className="flex items-center gap-1 rounded-xl bg-canvas-bar p-1 shadow-pop">
              <Segmented
                tone="canvas"
                size="sm"
                label={t('示例画布切换')}
                value={device}
                onChange={setDevice}
                options={[
                  { id: 'desktop', label: t('桌面') },
                  { id: 'phone', label: t('手机') },
                ]}
              />
              <Segmented
                tone="canvas"
                size="sm"
                iconOnly
                label={t('示例画布图标切换')}
                value={device}
                onChange={setDevice}
                options={[
                  { id: 'desktop', label: t('桌面'), icon: Monitor },
                  { id: 'phone', label: t('手机'), icon: Smartphone },
                ]}
              />
              <span aria-hidden className="mx-1 h-5 w-px bg-canvas-line" />
              <Button variant="on-canvas" size="sm">
                {t('适应画布')}
              </Button>
              <Button variant="on-canvas" size="icon-sm" aria-label={t('放大')} title={t('放大')}>
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Specimen>
      </Group>
    </>
  )
}
