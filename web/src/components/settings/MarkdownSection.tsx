import { createContext, useContext, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { Appearance } from '@shared/schema'
import {
  MD_BGS,
  MD_COLORS,
  mdCssValue,
  mdField,
  mdValue,
  setMdValue,
  type MarkdownStyle,
  type MdCustomColor,
  type MdElement,
  type MdValue,
} from '@shared/markdown-style'
import { t } from '@shared/i18n'
import { applyAppearance } from '@/lib/appearance'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { IconButton } from '@/components/ui/icon-button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Group, Row } from '@/components/settings/parts'
import { Markdown } from '@/components/tasks/Markdown'

/**
 * 每组设置上面一块自己的预览：只放这一组管的元素，改哪项就在旁边看到哪里变（用户要求不要把效果都堆在一个大预览里）。
 * 图片用内联的 SVG（data:image），不依赖外网
 */
const IMG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='480' height='140'><defs><linearGradient id='g' x1='0' x2='1'><stop offset='0' stop-color='#6aabf1' stop-opacity='.35'/><stop offset='1' stop-color='#b7a1ff' stop-opacity='.35'/></linearGradient></defs><rect width='480' height='140' fill='url(#g)'/><circle cx='90' cy='70' r='38' fill='#6aabf1' opacity='.6'/><circle cx='190' cy='70' r='28' fill='#b7a1ff' opacity='.6'/><circle cx='265' cy='70' r='20' fill='#6fd6bd' opacity='.6'/><circle cx='320' cy='70' r='14' fill='#f2c46d' opacity='.6'/></svg>",
  )
const PREVIEW: Record<string, string> = {
  body: '正文段落：Agent 的回复、工作流说明、项目文档都按这里的字号、颜色和段距排版。\n\n第二段：段落之间的距离就是「段落间距」。',
  strong: '正文里有 **粗体**、*斜体* 和 ~~删除线~~ 三种强调。',
  link: '详细说明见 [ADR 0034](https://example.com)，链接在正文里这样显示。',
  code: '改完运行 `npm run lint`，配置在 `.prettierrc.json`。',
  pre: '```ts\n// 找到这个对话最近一次工作流运行\nexport function latestRun(runs: Run[], id: string) {\n  return runs.filter((r) => r.conv === id).at(-1) ?? null\n}\n```\n\n```diff\n- onClick={() => openTab(run)}\n+ onClick={() => showGraph(run)}\n```',
  quote: '> 引用：Agent 汇报里的原话放在这里。\n>\n> > 引用里再引用换一种颜色。',
  alert:
    '> [!NOTE]\n> 说明：普通的补充信息。\n\n> [!TIP]\n> 提示：双击分界线恢复默认高度。\n\n> [!WARNING]\n> 注意：等出包后更新才能用上。\n\n> [!CAUTION]\n> 警告：这一步不能撤销。',
  ul: '- 无序列表第一项\n  - 第二层\n- 第二项',
  ol: '1. 有序列表第一项\n2. 第二项\n3. 第三项',
  task: '- [x] 已完成的任务\n- [ ] 没完成的任务',
  table:
    '| 文件 | 改动 | 状态 |\n| --- | --: | :-: |\n| index.css | +120 | 通过 |\n| Markdown.tsx | +8 | 通过 |\n| schema.ts | +3 | 待测 |',
  hr: '分隔线上面的一段。\n\n---\n\n分隔线下面的一段。',
  img: `![替代文字显示成图注](${IMG})`,
  mention: '@主理 是团队里的角色；@不存在 不在团队里，标成警告色。',
  mermaid:
    '```mermaid\nflowchart LR\n  A([开始]) --> B{通过?}\n  B -- 是 --> C[合并]\n  B -- 否 --> D[返工] --> B\n```',
}
const headingPreview = (h: string) =>
  `${'#'.repeat(Number(h.slice(1)))} ${h.toUpperCase()} 标题\n标题下面跟着的正文，看上下间距。`
const SAMPLE_TEAM = new Set(['主理'])

type Ctx = {
  style: MarkdownStyle
  /** 预览用紧凑密度（提问面板那种窄面板） */
  compact: boolean
  set: (el: MdElement, prop: string, v: MdValue | undefined) => void
  /** 正文多少像素：尺寸项按它换算成像素显示 */
  basePx: number
}
const StyleCtx = createContext<Ctx | null>(null)
const useStyle = () => useContext(StyleCtx)!

const round = (v: number, d = 2) => Number(v.toFixed(d))

/** 选项的显示名：静态写出来，文案检查才认得 */
const optionLabel = (v: string) =>
  ({
    sans: t('无衬线'),
    serif: t('衬线'),
    always: t('一直显示'),
    hover: t('悬停时'),
    none: t('不要'),
    disc: t('实心圆'),
    circle: t('空心圆'),
    square: t('方块'),
    dash: t('短横线'),
    rows: t('横线'),
    grid: t('全边框'),
    solid: t('实线'),
    dashed: t('虚线'),
    dotted: t('点线'),
    fade: t('两头渐隐'),
    bar: t('左侧竖条'),
    diamond: t('菱形'),
    dot: t('圆点'),
    underline: t('渐隐底线'),
    '450': t('常规'),
    '500': t('中等'),
    '600': t('半粗'),
    '700': t('粗体'),
  })[v] ?? `${v}%`

const colorLabel = (v: string) =>
  ({
    inherit: t('跟随上下文'),
    fg: t('正文色'),
    muted: t('次要色'),
    subtle: t('弱化色'),
    accent: t('强调色'),
    success: t('成功色'),
    warning: t('警告色'),
    danger: t('危险色'),
    code: t('代码色'),
    line: t('边框色'),
    border: t('强边框色'),
    gold: t('金色'),
    blue: t('蓝色'),
    violet: t('紫色'),
    teal: t('青绿'),
    coral: t('珊瑚色'),
    gray: t('灰色'),
    bright: t('亮白'),
    sand: t('沙色'),
    custom: t('自定义'),
  })[v] ?? v

const bgLabel = (v: string) =>
  ({
    none: t('无'),
    card: t('卡片色'),
    field: t('输入框色'),
    code: t('代码底色'),
    chip: t('代码标签底色'),
    sel: t('选中底色'),
    accent: t('强调浅底'),
    blue: t('蓝色浅底'),
    warm: t('暖色浅底'),
    head: t('表头浅底'),
    custom: t('自定义'),
  })[v] ?? v

/** 改过的项右边一个恢复按钮；没改过的占位，控件不跳 */
function Reset({ el, prop }: { el: MdElement; prop: string }) {
  const { style, set } = useStyle()
  const changed = (style[el] as Record<string, unknown> | undefined)?.[prop] !== undefined
  return changed ? (
    <IconButton size="sm" icon={RotateCcw} label={t('恢复默认')} onClick={() => set(el, prop, undefined)} />
  ) : (
    <span className="w-7 shrink-0" />
  )
}

/** 一项的控件：按定义里的类型给滑块、开关、分段或颜色下拉 */
function F({ el, prop, label }: { el: MdElement; prop: string; label: string }) {
  const { style, set, basePx } = useStyle()
  const f = mdField(el, prop)
  const v = mdValue(style, el, prop)
  let control: React.ReactNode
  if (f.kind === 'num') {
    const n = v as number
    const shown =
      f.unit === 'px'
        ? `${n}px`
        : f.unit === 'em'
          ? `${round(n * basePx, 1)}px`
          : el === 'body' && prop === 'size'
            ? `${round(n * basePx, 1)}px`
            : `×${round(n)}`
    control = (
      <div className="flex flex-1 items-center gap-3">
        <input
          type="range"
          min={f.min}
          max={f.max}
          step={f.step}
          value={n}
          aria-label={label}
          onChange={(e) => set(el, prop, round(Number(e.target.value)))}
          className="min-w-0 flex-1 cursor-pointer accent-[var(--color-accent)]"
        />
        <span className="w-14 text-right font-mono text-body text-muted tabular-nums">{shown}</span>
      </div>
    )
  } else if (f.kind === 'bool') {
    control = (
      <div className="flex flex-1 justify-end">
        <Switch aria-label={label} checked={v as boolean} onCheckedChange={(on) => set(el, prop, on)} />
      </div>
    )
  } else if (f.kind === 'enum') {
    control = (
      <div className="flex flex-1 justify-end">
        <Segmented
          size="sm"
          label={label}
          value={v as string}
          onChange={(o) => set(el, prop, o)}
          options={f.options.map((o) => ({ id: o, label: optionLabel(o) }))}
        />
      </div>
    )
  } else {
    control = <ColorPick el={el} prop={prop} label={label} roles={f.kind === 'color' ? MD_COLORS : MD_BGS} />
  }
  return (
    <div className="flex items-center gap-2">
      {control}
      <Reset el={el} prop={prop} />
    </div>
  )
}

/** 颜色：主题色下拉（前面一块色样），选自定义时浅色、深色各一个取色器 */
function ColorPick({
  el,
  prop,
  label,
  roles,
}: {
  el: MdElement
  prop: string
  label: string
  roles: readonly string[]
}) {
  const { style, set } = useStyle()
  const f = mdField(el, prop)
  const v = mdValue(style, el, prop)
  const custom = typeof v === 'object' ? (v as MdCustomColor) : null
  const dark = document.documentElement.classList.contains('dark')
  const swatch = mdCssValue(f, v, dark, el, prop)
  const name = f.kind === 'bg' ? bgLabel : colorLabel
  return (
    <div className="flex flex-1 items-center justify-end gap-2">
      {custom && (
        <>
          <input
            type="color"
            aria-label={t('浅色')}
            title={t('浅色')}
            value={custom.light}
            onChange={(e) => set(el, prop, { ...custom, light: e.target.value })}
            className="h-7 w-7 cursor-pointer rounded-sm border-0 bg-transparent p-0"
          />
          <input
            type="color"
            aria-label={t('深色')}
            title={t('深色')}
            value={custom.dark}
            onChange={(e) => set(el, prop, { ...custom, dark: e.target.value })}
            className="h-7 w-7 cursor-pointer rounded-sm border-0 bg-transparent p-0"
          />
        </>
      )}
      {!custom && (
        <span
          className="h-4 w-4 shrink-0 rounded-full ring-1 ring-line-strong"
          style={{ background: swatch === 'currentColor' ? 'var(--fg)' : swatch }}
        />
      )}
      <Select
        size="sm"
        aria-label={label}
        value={custom ? 'custom' : (v as string)}
        onChange={(e) => {
          const next = e.target.value
          if (next !== 'custom') return set(el, prop, next)
          // 从当前看到的颜色起步：读出主题色在浅色、深色下的实际值不方便，先给一对中性的灰
          set(el, prop, { light: '#6b6a65', dark: '#b5b3ab' })
        }}
        options={[...roles, 'custom'].map((r) => ({ value: r, label: name(r) }))}
      />
    </div>
  )
}

/** 一组设置自己的预览：真的 Markdown 组件，样式改了立刻跟着变；里面的链接、按钮不真的执行 */
function Preview({ md, remount }: { md: string; remount?: string }) {
  const { compact } = useStyle()
  return (
    <div
      onClickCapture={(e) => {
        if ((e.target as HTMLElement).closest('a')) e.preventDefault()
      }}
      className="mb-2 rounded-xl bg-panel px-5 py-4 ring-1 ring-line"
    >
      <Markdown key={remount} text={md} teamNames={SAMPLE_TEAM} compact={compact} />
    </div>
  )
}

/**
 * 小节顶部固定高度的一行，专门放「恢复本组」：这一组有改过的项才显示按钮，
 * 没改过时按钮隐藏但行还在，改动前后下面的预览和设置项不跳动。
 */
function GroupReset({ els }: { els: MdElement[] }) {
  const { style, set } = useStyle()
  const changed = els.filter((el) => style[el])
  return (
    <div className="settings-card-head">
      {changed.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            for (const el of changed) for (const prop of Object.keys(style[el] as object)) set(el, prop, undefined)
          }}
        >
          {t('恢复本组')}
        </Button>
      )}
    </div>
  )
}

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

/**
 * 设置 → Markdown 样式：对话回复、文档预览、总结报告共用的那套样式，按元素逐项调。
 * 顶部预览就是真的 Markdown 组件，改动立刻生效到整个面板（applyAppearance），保存交给设置页的自动保存。
 */
export function MarkdownSection({ value, onChange }: { value: Appearance; onChange: (a: Appearance) => void }) {
  const [compact, setCompact] = useState<'normal' | 'compact'>('normal')
  const [level, setLevel] = useState<(typeof HEADINGS)[number]>('h1')
  const [confirm, setConfirm] = useState(false)
  const style = value.markdown
  const update = (markdown: MarkdownStyle) => {
    const next = { ...value, markdown }
    onChange(next)
    applyAppearance(next)
  }
  // 连续改同一组时以最新的为准：恢复本组会一口气调用好几次
  let latest = style
  const set: Ctx['set'] = (el, prop, v) => {
    latest = setMdValue(latest, el, prop, v)
    update(latest)
  }
  const rootPx = (16 * value.fontSize) / 14
  const basePx = 0.875 * rootPx * (mdValue(style, 'body', 'size') as number)

  const changed = Object.keys(style).length > 0

  return (
    <StyleCtx.Provider value={{ style, set, basePx, compact: compact === 'compact' }}>
      <div className="frost-card sticky top-0 z-10 -mx-1 px-1 pt-4 pb-1">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-body text-subtle">
            {t('对话回复、工作流说明、项目文档、总结报告都用这一套。每组上面的预览会跟着这一组的设置变。')}
          </p>
          <Segmented
            size="sm"
            label={t('预览密度')}
            value={compact}
            onChange={setCompact}
            options={[
              { id: 'normal', label: t('正常') },
              { id: 'compact', label: t('紧凑') },
            ]}
          />
          {changed && (
            <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>
              {t('全部恢复默认')}
            </Button>
          )}
        </div>
      </div>

      <Group title={t('正文')}>
        <GroupReset els={['body']} />
        <Preview md={PREVIEW.body} />
        <Row
          title={t('字号')}
          desc={t('相对「外观 → 字号」的倍数')}
          hint={t('其他元素按正文等比缩放。行高在「外观」里调。')}
        >
          <F el="body" prop="size" label={t('正文字号')} />
        </Row>
        <Row title={t('段落间距')}>
          <F el="body" prop="gap" label={t('段落间距')} />
        </Row>
        <Row title={t('颜色')}>
          <F el="body" prop="color" label={t('正文颜色')} />
        </Row>
      </Group>

      <Group title={t('标题')}>
        <GroupReset els={[...HEADINGS]} />
        <Preview md={headingPreview(level)} />
        <div className="pb-1">
          <Segmented
            size="sm"
            label={t('标题级别')}
            value={level}
            onChange={setLevel}
            options={HEADINGS.map((h) => ({
              id: h,
              label: h.toUpperCase() + (style[h] ? ' •' : ''),
            }))}
          />
        </div>
        <Row title={t('字号')}>
          <F el={level} prop="size" label={t('标题字号')} />
        </Row>
        <Row title={t('字重')}>
          <F el={level} prop="weight" label={t('标题字重')} />
        </Row>
        <Row title={t('颜色')}>
          <F el={level} prop="color" label={t('标题颜色')} />
        </Row>
        <Row
          title={t('装饰')}
          desc={t('标题前的符号或标题下的线')}
          hint={t('标题前的竖条、菱形、短横、圆点，或标题下一条渐隐的线，颜色跟标题。')}
        >
          <F el={level} prop="deco" label={t('标题装饰')} />
        </Row>
        <Row title={t('字体')}>
          <F el={level} prop="font" label={t('标题字体')} />
        </Row>
        <Row title={t('上间距')}>
          <F el={level} prop="mt" label={t('标题上间距')} />
        </Row>
        <Row title={t('下间距')}>
          <F el={level} prop="mb" label={t('标题下间距')} />
        </Row>
        <Row title={t('底线')} desc={t('标题下面画一条细线，像文档里的章节分隔。')}>
          <F el={level} prop="rule" label={t('标题底线')} />
        </Row>
      </Group>

      <Group title={t('粗体、斜体、删除线')}>
        <GroupReset els={['strong', 'em', 'del']} />
        <Preview md={PREVIEW.strong} />
        <Row title={t('粗体字重')}>
          <F el="strong" prop="weight" label={t('粗体字重')} />
        </Row>
        <Row title={t('粗体颜色')}>
          <F el="strong" prop="color" label={t('粗体颜色')} />
        </Row>
        <Row title={t('斜体颜色')}>
          <F el="em" prop="color" label={t('斜体颜色')} />
        </Row>
        <Row title={t('删除线颜色')}>
          <F el="del" prop="color" label={t('删除线颜色')} />
        </Row>
      </Group>

      <Group title={t('链接')}>
        <GroupReset els={['link']} />
        <Preview md={PREVIEW.link} />
        <Row title={t('颜色')}>
          <F el="link" prop="color" label={t('链接颜色')} />
        </Row>
        <Row title={t('下划线')}>
          <F el="link" prop="underline" label={t('链接下划线')} />
        </Row>
      </Group>

      <Group title={t('行内代码')}>
        <GroupReset els={['code']} />
        <Preview md={PREVIEW.code} />
        <Row title={t('字号')}>
          <F el="code" prop="size" label={t('行内代码字号')} />
        </Row>
        <Row title={t('文字颜色')}>
          <F el="code" prop="color" label={t('行内代码文字颜色')} />
        </Row>
        <Row title={t('底色')}>
          <F el="code" prop="bg" label={t('行内代码底色')} />
        </Row>
        <Row title={t('边框')}>
          <F el="code" prop="border" label={t('行内代码边框')} />
        </Row>
        <Row title={t('圆角')}>
          <F el="code" prop="radius" label={t('行内代码圆角')} />
        </Row>
      </Group>

      <Group title={t('代码块')}>
        <GroupReset els={['pre']} />
        <Preview md={PREVIEW.pre} />
        <Row title={t('字号')}>
          <F el="pre" prop="size" label={t('代码块字号')} />
        </Row>
        <Row title={t('行高')}>
          <F el="pre" prop="leading" label={t('代码块行高')} />
        </Row>
        <Row title={t('底色')} desc={t('mermaid 图也用这个底色、圆角和边框。')}>
          <F el="pre" prop="bg" label={t('代码块底色')} />
        </Row>
        <Row title={t('圆角')}>
          <F el="pre" prop="radius" label={t('代码块圆角')} />
        </Row>
        <Row title={t('边框')}>
          <F el="pre" prop="border" label={t('代码块边框')} />
        </Row>
        <Row title={t('语言栏')} desc={t('顶部的语言名和复制按钮。')}>
          <F el="pre" prop="bar" label={t('代码块语言栏')} />
        </Row>
        <Row title={t('自动换行')} desc={t('关掉时长行横向滚动')} hint={t('顶栏的「折行」可以单独打开一块。')}>
          <F el="pre" prop="wrap" label={t('代码块自动换行')} />
        </Row>
        <Row title={t('行号')} desc={t('只有一行的代码块不显示；复制时不会带上行号。')}>
          <F el="pre" prop="lineNumbers" label={t('代码块行号')} />
        </Row>
      </Group>

      <Group title={t('引用')}>
        <GroupReset els={['quote']} />
        <Preview md={PREVIEW.quote} />
        <Row title={t('左线颜色')}>
          <F el="quote" prop="line" label={t('引用左线颜色')} />
        </Row>
        <Row title={t('左线粗细')}>
          <F el="quote" prop="lineWidth" label={t('引用左线粗细')} />
        </Row>
        <Row title={t('文字颜色')}>
          <F el="quote" prop="color" label={t('引用文字颜色')} />
        </Row>
        <Row title={t('底色')}>
          <F el="quote" prop="bg" label={t('引用底色')} />
        </Row>
        <Row title={t('圆角')}>
          <F el="quote" prop="radius" label={t('引用圆角')} />
        </Row>
        <Row title={t('斜体')}>
          <F el="quote" prop="italic" label={t('引用斜体')} />
        </Row>
      </Group>

      <Group title={t('提示块')}>
        <GroupReset els={['alert']} />
        <Preview md={PREVIEW.alert} />
        <Row title={t('浅底')} desc={t('按类型（说明、提示、重要、注意、警告）铺一层同色浅底。')}>
          <F el="alert" prop="tint" label={t('提示块浅底')} />
        </Row>
        <Row title={t('圆角')}>
          <F el="alert" prop="radius" label={t('提示块圆角')} />
        </Row>
      </Group>

      <Group title={t('无序列表')}>
        <GroupReset els={['ul']} />
        <Preview md={PREVIEW.ul} />
        <Row title={t('符号')}>
          <F el="ul" prop="marker" label={t('列表符号')} />
        </Row>
        <Row title={t('符号颜色')}>
          <F el="ul" prop="markerColor" label={t('列表符号颜色')} />
        </Row>
        <Row title={t('缩进')}>
          <F el="ul" prop="indent" label={t('无序列表缩进')} />
        </Row>
        <Row title={t('项间距')}>
          <F el="ul" prop="gap" label={t('无序列表项间距')} />
        </Row>
      </Group>

      <Group title={t('有序列表')}>
        <GroupReset els={['ol']} />
        <Preview md={PREVIEW.ol} />
        <Row title={t('序号颜色')}>
          <F el="ol" prop="markerColor" label={t('序号颜色')} />
        </Row>
        <Row title={t('序号字重')}>
          <F el="ol" prop="markerWeight" label={t('序号字重')} />
        </Row>
        <Row title={t('缩进')}>
          <F el="ol" prop="indent" label={t('有序列表缩进')} />
        </Row>
        <Row title={t('项间距')}>
          <F el="ol" prop="gap" label={t('有序列表项间距')} />
        </Row>
      </Group>

      <Group title={t('任务列表')}>
        <GroupReset els={['task']} />
        <Preview md={PREVIEW.task} />
        <Row title={t('勾选框颜色')}>
          <F el="task" prop="color" label={t('勾选框颜色')} />
        </Row>
        <Row title={t('已完成项变淡')}>
          <F el="task" prop="doneFade" label={t('已完成项变淡')} />
        </Row>
      </Group>

      <Group title={t('表格')}>
        <GroupReset els={['table']} />
        <Preview md={PREVIEW.table} />
        <Row title={t('字号')}>
          <F el="table" prop="size" label={t('表格字号')} />
        </Row>
        <Row title={t('边框')}>
          <F el="table" prop="border" label={t('表格边框')} />
        </Row>
        <Row title={t('外框')} desc={t('表格外面一圈圆角细框。')}>
          <F el="table" prop="outer" label={t('表格外框')} />
        </Row>
        <Row title={t('圆角')}>
          <F el="table" prop="radius" label={t('表格圆角')} />
        </Row>
        <Row title={t('表头底色')}>
          <F el="table" prop="headerBg" label={t('表头底色')} />
        </Row>
        <Row title={t('表头字重')}>
          <F el="table" prop="headerWeight" label={t('表头字重')} />
        </Row>
        <Row title={t('斑马纹')} desc={t('隔行加一层浅底，长表格更好对行。')}>
          <F el="table" prop="zebra" label={t('表格斑马纹')} />
        </Row>
        <Row title={t('单元格内边距')}>
          <F el="table" prop="pad" label={t('单元格内边距')} />
        </Row>
      </Group>

      <Group title={t('分隔线')}>
        <GroupReset els={['hr']} />
        <Preview md={PREVIEW.hr} />
        <Row title={t('线型')}>
          <F el="hr" prop="style" label={t('分隔线线型')} />
        </Row>
        <Row title={t('粗细')}>
          <F el="hr" prop="width" label={t('分隔线粗细')} />
        </Row>
        <Row title={t('颜色')}>
          <F el="hr" prop="color" label={t('分隔线颜色')} />
        </Row>
        <Row title={t('上下间距')}>
          <F el="hr" prop="space" label={t('分隔线上下间距')} />
        </Row>
      </Group>

      <Group title={t('图片')}>
        <GroupReset els={['img']} />
        <Preview md={PREVIEW.img} />
        <Row title={t('圆角')}>
          <F el="img" prop="radius" label={t('图片圆角')} />
        </Row>
        <Row title={t('最大宽度')}>
          <F el="img" prop="maxWidth" label={t('图片最大宽度')} />
        </Row>
        <Row title={t('边框')}>
          <F el="img" prop="border" label={t('图片边框')} />
        </Row>
        <Row title={t('图注')} desc={t('把图片的替代文字显示在图下面。')}>
          <F el="img" prop="caption" label={t('图片图注')} />
        </Row>
      </Group>

      <Group title={t('Mermaid 图')}>
        <GroupReset els={['mermaid']} />
        {/* 动画、悬停、渐变是画图时读的设置：改了就重新挂载，让图按新设置再画一遍 */}
        <Preview md={PREVIEW.mermaid} remount={JSON.stringify(style.mermaid ?? {})} />
        <Row title={t('出场动画')} desc={t('画好后节点依次浮现、连线从头画到尾、饼图展开、甘特条长出。')}>
          <F el="mermaid" prop="motion" label={t('出场动画')} />
        </Row>
        <Row title={t('悬停高亮')} desc={t('鼠标停在节点上时，它和相连的线高亮并流动，其余变淡。')}>
          <F el="mermaid" prop="hover" label={t('悬停高亮')} />
        </Row>
        <Row title={t('节点渐变底')}>
          <F el="mermaid" prop="gradient" label={t('节点渐变底')} />
        </Row>
        <Row title={t('画布点阵底')}>
          <F el="mermaid" prop="grid" label={t('画布点阵底')} />
        </Row>
      </Group>

      <Group title={t('@提及')}>
        <GroupReset els={['mention']} />
        <Preview md={PREVIEW.mention} />
        <Row title={t('文字颜色')}>
          <F el="mention" prop="color" label={t('提及文字颜色')} />
        </Row>
        <Row title={t('底色')}>
          <F el="mention" prop="bg" label={t('提及底色')} />
        </Row>
      </Group>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('全部恢复默认？')}
        description={t('Markdown 样式里改过的项都会恢复成默认值。')}
        confirmText={t('恢复默认')}
        onConfirm={() => {
          update({})
          setConfirm(false)
        }}
      />
    </StyleCtx.Provider>
  )
}
