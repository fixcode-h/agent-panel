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
import { revealSetting } from '@/components/settings/section-nav'
import { Markdown } from '@/components/tasks/Markdown'

/** 预览用的示例：每种元素都出现一次（图片要外链地址，预览里不放） */
const SAMPLE = `# 一级标题
正文段落里有 **粗体**、*斜体*、~~删除线~~、[链接](https://example.com) 和 \`行内代码\`，还能 @主理 提及角色。

## 二级标题
> 引用：Agent 汇报里的原话放在这里。

> [!TIP]
> 提示块：> [!NOTE]、[!TIP]、[!IMPORTANT]、[!WARNING]、[!CAUTION] 五种。

- 无序列表
  - 第二层
- [x] 已完成的任务
- [ ] 没完成的任务

1. 有序列表第一项
2. 第二项

### 三级标题
| 文件 | 改动 | 状态 |
| --- | --- | --- |
| index.css | +120 | 通过 |
| Markdown.tsx | +8 | 通过 |
| schema.ts | +3 | 待测 |

\`\`\`ts
// 代码块：带行号，顶栏有折行和复制
const ok = (a: number) => a > 0
\`\`\`

\`\`\`mermaid
flowchart LR
  A([开始]) --> B{通过?}
  B -- 是 --> C[合并]
  B -- 否 --> D[返工] --> B
\`\`\`

---
#### 四级标题
##### 五级标题
###### 六级标题
`
const SAMPLE_TEAM = new Set(['主理'])

/** 点预览里的元素跳到对应的设置组：选择器按从里到外的顺序试 */
const PICK: [string, MdElement][] = [
  ['.md-mermaid', 'mermaid'],
  ['.md-alert', 'alert'],
  ['.md-code, .chat-md > pre', 'pre'],
  [':not(pre) > code', 'code'],
  ['.mention', 'mention'],
  ['a', 'link'],
  ['strong, b', 'strong'],
  ['em', 'em'],
  ['del', 'del'],
  ['input[type=checkbox]', 'task'],
  ['table', 'table'],
  ['blockquote', 'quote'],
  ['h1, h2, h3, h4, h5, h6', 'h1'],
  ['ol', 'ol'],
  ['ul', 'ul'],
  ['hr', 'hr'],
  ['img', 'img'],
  ['p', 'body'],
]

type Ctx = {
  style: MarkdownStyle
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
        <span className="w-14 text-right font-mono text-[0.8125rem] text-muted tabular-nums">{shown}</span>
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
            className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
          />
          <input
            type="color"
            aria-label={t('深色')}
            title={t('深色')}
            value={custom.dark}
            onChange={(e) => set(el, prop, { ...custom, dark: e.target.value })}
            className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
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

/** 小节右上角：这一组有改过的项才出现「恢复本组」 */
function GroupReset({ els }: { els: MdElement[] }) {
  const { style, set } = useStyle()
  const changed = els.filter((el) => style[el])
  if (!changed.length) return null
  return (
    <div className="-mt-7 flex justify-end pb-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          for (const el of changed) for (const prop of Object.keys(style[el] as object)) set(el, prop, undefined)
        }}
      >
        {t('恢复本组')}
      </Button>
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

  // 小节标题（翻译后的）：点预览时按它找到小节
  const groupTitle: Record<string, string> = {
    body: t('正文'),
    h1: t('标题'),
    strong: t('粗体、斜体、删除线'),
    em: t('粗体、斜体、删除线'),
    del: t('粗体、斜体、删除线'),
    link: t('链接'),
    code: t('行内代码'),
    pre: t('代码块'),
    quote: t('引用'),
    alert: t('提示块'),
    mermaid: t('Mermaid 图'),
    ul: t('无序列表'),
    ol: t('有序列表'),
    task: t('任务列表'),
    table: t('表格'),
    hr: t('分隔线'),
    img: t('图片'),
    mention: t('@提及'),
  }
  const onPreviewClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    // 预览里的链接、复制按钮不真的执行
    e.preventDefault()
    for (const [sel, el] of PICK) {
      const hit = target.closest(sel)
      if (!hit || !e.currentTarget.contains(hit)) continue
      if (el === 'h1') setLevel(hit.tagName.toLowerCase() as (typeof HEADINGS)[number])
      revealSetting([`[data-setting-group="${groupTitle[el]}"]`])
      return
    }
  }
  const changed = Object.keys(style).length > 0

  return (
    <StyleCtx.Provider value={{ style, set, basePx }}>
      <div className="sticky top-0 z-10 -mx-1 bg-card px-1 pt-4 pb-3">
        <div className="flex items-center gap-2 pb-2">
          <p className="flex-1 text-[0.8125rem] text-subtle">
            {t('对话回复、工作流说明、项目文档、总结报告都用这一套。点预览里的元素跳到它的设置。')}
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
        <div
          onClickCapture={onPreviewClick}
          className="thin-scroll max-h-72 cursor-pointer overflow-y-auto rounded-xl bg-panel px-5 py-4 ring-1 ring-line"
        >
          <Markdown text={SAMPLE} teamNames={SAMPLE_TEAM} compact={compact === 'compact'} />
        </div>
      </div>

      <Group title={t('正文')}>
        <GroupReset els={['body']} />
        <Row title={t('正文字号')} desc={t('相对「外观 → 字号」的倍数，其他元素按正文等比缩放。行高在「外观」里调。')}>
          <F el="body" prop="size" label={t('正文字号')} />
        </Row>
        <Row title={t('段落间距')}>
          <F el="body" prop="gap" label={t('段落间距')} />
        </Row>
        <Row title={t('正文颜色')}>
          <F el="body" prop="color" label={t('正文颜色')} />
        </Row>
      </Group>

      <Group title={t('标题')}>
        <GroupReset els={[...HEADINGS]} />
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
        <Row title={t('标题字号')}>
          <F el={level} prop="size" label={t('标题字号')} />
        </Row>
        <Row title={t('标题字重')}>
          <F el={level} prop="weight" label={t('标题字重')} />
        </Row>
        <Row title={t('标题颜色')}>
          <F el={level} prop="color" label={t('标题颜色')} />
        </Row>
        <Row title={t('标题装饰')} desc={t('标题前的竖条、菱形、短横、圆点，或标题下一条渐隐的线，颜色跟标题。')}>
          <F el={level} prop="deco" label={t('标题装饰')} />
        </Row>
        <Row title={t('标题字体')}>
          <F el={level} prop="font" label={t('标题字体')} />
        </Row>
        <Row title={t('标题上间距')}>
          <F el={level} prop="mt" label={t('标题上间距')} />
        </Row>
        <Row title={t('标题下间距')}>
          <F el={level} prop="mb" label={t('标题下间距')} />
        </Row>
        <Row title={t('标题底线')} desc={t('标题下面画一条细线，像文档里的章节分隔。')}>
          <F el={level} prop="rule" label={t('标题底线')} />
        </Row>
      </Group>

      <Group title={t('粗体、斜体、删除线')}>
        <GroupReset els={['strong', 'em', 'del']} />
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
        <Row title={t('链接颜色')}>
          <F el="link" prop="color" label={t('链接颜色')} />
        </Row>
        <Row title={t('链接下划线')}>
          <F el="link" prop="underline" label={t('链接下划线')} />
        </Row>
      </Group>

      <Group title={t('行内代码')}>
        <GroupReset els={['code']} />
        <Row title={t('行内代码字号')}>
          <F el="code" prop="size" label={t('行内代码字号')} />
        </Row>
        <Row title={t('行内代码文字颜色')}>
          <F el="code" prop="color" label={t('行内代码文字颜色')} />
        </Row>
        <Row title={t('行内代码底色')}>
          <F el="code" prop="bg" label={t('行内代码底色')} />
        </Row>
        <Row title={t('行内代码边框')}>
          <F el="code" prop="border" label={t('行内代码边框')} />
        </Row>
        <Row title={t('行内代码圆角')}>
          <F el="code" prop="radius" label={t('行内代码圆角')} />
        </Row>
      </Group>

      <Group title={t('代码块')}>
        <GroupReset els={['pre']} />
        <Row title={t('代码块字号')}>
          <F el="pre" prop="size" label={t('代码块字号')} />
        </Row>
        <Row title={t('代码块行高')}>
          <F el="pre" prop="leading" label={t('代码块行高')} />
        </Row>
        <Row title={t('代码块底色')} desc={t('mermaid 图也用这个底色、圆角和边框。')}>
          <F el="pre" prop="bg" label={t('代码块底色')} />
        </Row>
        <Row title={t('代码块圆角')}>
          <F el="pre" prop="radius" label={t('代码块圆角')} />
        </Row>
        <Row title={t('代码块边框')}>
          <F el="pre" prop="border" label={t('代码块边框')} />
        </Row>
        <Row title={t('代码块语言栏')} desc={t('顶部的语言名和复制按钮。')}>
          <F el="pre" prop="bar" label={t('代码块语言栏')} />
        </Row>
        <Row title={t('代码块自动换行')} desc={t('关掉时长行横向滚动，顶栏的「折行」可以单独打开一块。')}>
          <F el="pre" prop="wrap" label={t('代码块自动换行')} />
        </Row>
        <Row title={t('代码块行号')} desc={t('只有一行的代码块不显示；复制时不会带上行号。')}>
          <F el="pre" prop="lineNumbers" label={t('代码块行号')} />
        </Row>
      </Group>

      <Group title={t('引用')}>
        <GroupReset els={['quote']} />
        <Row title={t('引用左线颜色')}>
          <F el="quote" prop="line" label={t('引用左线颜色')} />
        </Row>
        <Row title={t('引用左线粗细')}>
          <F el="quote" prop="lineWidth" label={t('引用左线粗细')} />
        </Row>
        <Row title={t('引用文字颜色')}>
          <F el="quote" prop="color" label={t('引用文字颜色')} />
        </Row>
        <Row title={t('引用底色')}>
          <F el="quote" prop="bg" label={t('引用底色')} />
        </Row>
        <Row title={t('引用圆角')}>
          <F el="quote" prop="radius" label={t('引用圆角')} />
        </Row>
        <Row title={t('引用斜体')}>
          <F el="quote" prop="italic" label={t('引用斜体')} />
        </Row>
      </Group>

      <Group title={t('提示块')}>
        <GroupReset els={['alert']} />
        <Row title={t('提示块浅底')} desc={t('按类型（说明、提示、重要、注意、警告）铺一层同色浅底。')}>
          <F el="alert" prop="tint" label={t('提示块浅底')} />
        </Row>
        <Row title={t('提示块圆角')}>
          <F el="alert" prop="radius" label={t('提示块圆角')} />
        </Row>
      </Group>

      <Group title={t('无序列表')}>
        <GroupReset els={['ul']} />
        <Row title={t('列表符号')}>
          <F el="ul" prop="marker" label={t('列表符号')} />
        </Row>
        <Row title={t('列表符号颜色')}>
          <F el="ul" prop="markerColor" label={t('列表符号颜色')} />
        </Row>
        <Row title={t('无序列表缩进')}>
          <F el="ul" prop="indent" label={t('无序列表缩进')} />
        </Row>
        <Row title={t('无序列表项间距')}>
          <F el="ul" prop="gap" label={t('无序列表项间距')} />
        </Row>
      </Group>

      <Group title={t('有序列表')}>
        <GroupReset els={['ol']} />
        <Row title={t('序号颜色')}>
          <F el="ol" prop="markerColor" label={t('序号颜色')} />
        </Row>
        <Row title={t('序号字重')}>
          <F el="ol" prop="markerWeight" label={t('序号字重')} />
        </Row>
        <Row title={t('有序列表缩进')}>
          <F el="ol" prop="indent" label={t('有序列表缩进')} />
        </Row>
        <Row title={t('有序列表项间距')}>
          <F el="ol" prop="gap" label={t('有序列表项间距')} />
        </Row>
      </Group>

      <Group title={t('任务列表')}>
        <GroupReset els={['task']} />
        <Row title={t('勾选框颜色')}>
          <F el="task" prop="color" label={t('勾选框颜色')} />
        </Row>
        <Row title={t('已完成项变淡')}>
          <F el="task" prop="doneFade" label={t('已完成项变淡')} />
        </Row>
      </Group>

      <Group title={t('表格')}>
        <GroupReset els={['table']} />
        <Row title={t('表格字号')}>
          <F el="table" prop="size" label={t('表格字号')} />
        </Row>
        <Row title={t('表格边框')}>
          <F el="table" prop="border" label={t('表格边框')} />
        </Row>
        <Row title={t('表格外框')} desc={t('表格外面一圈圆角细框。')}>
          <F el="table" prop="outer" label={t('表格外框')} />
        </Row>
        <Row title={t('表格圆角')}>
          <F el="table" prop="radius" label={t('表格圆角')} />
        </Row>
        <Row title={t('表头底色')}>
          <F el="table" prop="headerBg" label={t('表头底色')} />
        </Row>
        <Row title={t('表头字重')}>
          <F el="table" prop="headerWeight" label={t('表头字重')} />
        </Row>
        <Row title={t('表格斑马纹')} desc={t('隔行加一层浅底，长表格更好对行。')}>
          <F el="table" prop="zebra" label={t('表格斑马纹')} />
        </Row>
        <Row title={t('单元格内边距')}>
          <F el="table" prop="pad" label={t('单元格内边距')} />
        </Row>
      </Group>

      <Group title={t('分隔线')}>
        <GroupReset els={['hr']} />
        <Row title={t('分隔线线型')}>
          <F el="hr" prop="style" label={t('分隔线线型')} />
        </Row>
        <Row title={t('分隔线粗细')}>
          <F el="hr" prop="width" label={t('分隔线粗细')} />
        </Row>
        <Row title={t('分隔线颜色')}>
          <F el="hr" prop="color" label={t('分隔线颜色')} />
        </Row>
        <Row title={t('分隔线上下间距')}>
          <F el="hr" prop="space" label={t('分隔线上下间距')} />
        </Row>
      </Group>

      <Group title={t('图片')}>
        <GroupReset els={['img']} />
        <Row title={t('图片圆角')}>
          <F el="img" prop="radius" label={t('图片圆角')} />
        </Row>
        <Row title={t('图片最大宽度')}>
          <F el="img" prop="maxWidth" label={t('图片最大宽度')} />
        </Row>
        <Row title={t('图片边框')}>
          <F el="img" prop="border" label={t('图片边框')} />
        </Row>
        <Row title={t('图片图注')} desc={t('把图片的替代文字显示在图下面。')}>
          <F el="img" prop="caption" label={t('图片图注')} />
        </Row>
      </Group>

      <Group title={t('Mermaid 图')}>
        <GroupReset els={['mermaid']} />
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
        <Row title={t('提及文字颜色')}>
          <F el="mention" prop="color" label={t('提及文字颜色')} />
        </Row>
        <Row title={t('提及底色')}>
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
