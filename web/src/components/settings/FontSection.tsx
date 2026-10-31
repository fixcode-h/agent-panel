import { Appearance, PALETTES, WORD_SPACING, type Palette } from '@shared/schema'
import { t } from '@shared/i18n'
import { applyAppearance } from '@/lib/appearance'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Group, Row } from '@/components/settings/parts'
import { cn } from '@/lib/utils'

const DEFAULTS = Appearance.parse({})

/**
 * 配色卡片上的小样：写死颜色，不读 CSS 变量（变量是当前配色的，画不出别的配色）。
 * 依次是侧栏、内容、强调色、主按钮；和 index.css 里对应配色的值保持一致
 */
const PALETTE_SAMPLES: Record<Palette, { light: string[]; dark: string[] }> = {
  code: { light: ['#f8f8f7', '#ffffff', '#2b6cd4', '#1a1a1a'], dark: ['#1f1f1f', '#191919', '#6aabf1', '#ececec'] },
  claude: { light: ['#f3f1ea', '#faf9f5', '#c6613f', '#c6613f'], dark: ['#1f1e1d', '#262624', '#d97757', '#d97757'] },
  neutral: { light: ['#f4f4f2', '#ffffff', '#c6613f', '#18181b'], dark: ['#151517', '#1d1d20', '#d97757', '#ededef'] },
  ocean: { light: ['#eef3f7', '#f7fafc', '#2f6fb3', '#2f6fb3'], dark: ['#0e151d', '#121a24', '#5b9be0', '#5b9be0'] },
  forest: { light: ['#eef2ea', '#f8faf6', '#3f7d58', '#3f7d58'], dark: ['#111512', '#161b17', '#6fb58a', '#6fb58a'] },
}

/** 一张配色卡：浅色、深色两块小样并排，选中描一圈主色 */
function PaletteCard({ id, on, onPick }: { id: Palette; on: boolean; onPick: () => void }) {
  const names: Record<Palette, string> = {
    code: t('Claude Code（默认）'),
    claude: 'Claude',
    neutral: t('中性'),
    ocean: t('海蓝'),
    forest: t('森绿'),
  }
  const sample = (c: string[]) => (
    <span className="flex h-12 flex-1 overflow-hidden rounded-md border border-black/5">
      <span className="w-1/3" style={{ background: c[0] }} />
      <span className="flex flex-1 flex-col justify-end gap-1 p-1.5" style={{ background: c[1] }}>
        <span className="h-1.5 w-2/3 rounded-full" style={{ background: c[2], opacity: 0.85 }} />
        <span className="h-2.5 w-1/3 rounded-sm" style={{ background: c[3] }} />
      </span>
    </span>
  )
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={cn(
        'flex cursor-pointer flex-col gap-2 rounded-xl p-2 text-left transition-colors',
        // 没选中的只有浅灰底，选中的白底加一圈主色：边界靠底色，不描边
        on ? 'bg-card ring-2 ring-primary' : 'bg-sel/40 hover:bg-sel/70',
      )}
    >
      <span className="flex gap-1.5">
        {sample(PALETTE_SAMPLES[id].light)}
        {sample(PALETTE_SAMPLES[id].dark)}
      </span>
      <span className="px-0.5 text-[0.8125rem] font-medium">{names[id]}</span>
    </button>
  )
}

/** 滑块一行：拖动时立即生效（applyAppearance），保存交给设置页的自动保存 */
function Slider({
  label,
  value,
  min,
  max,
  step,
  def,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  def: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-40 cursor-pointer accent-[var(--color-accent)]"
      />
      <span className="w-16 font-mono text-[0.8125rem] text-muted tabular-nums">{format(value)}</span>
      {value !== def && (
        <Button variant="ghost" size="sm" onClick={() => onChange(def)}>
          {t('恢复默认')}
        </Button>
      )}
    </div>
  )
}

export function FontSection({ value, onChange }: { value: Appearance; onChange: (a: Appearance) => void }) {
  const update = (next: Appearance) => {
    onChange(next)
    applyAppearance(next)
  }
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) => update({ ...value, [k]: v })
  // 浮点步进会出现 -0.019999 这样的值，显示和保存前都取整
  const round = (v: number, d: number) => Number(v.toFixed(d))
  return (
    <>
      <Group title={t('配色')}>
        <p className="pb-3 text-[0.8125rem] text-subtle">{t('只换颜色，布局不变；深浅色跟随侧栏的主题开关。')}</p>
        <div role="radiogroup" aria-label={t('配色')} className="grid grid-cols-2 gap-3 pb-4 sm:grid-cols-3">
          {PALETTES.map((p) => (
            <PaletteCard key={p} id={p} on={value.palette === p} onPick={() => set('palette', p)} />
          ))}
        </div>
        <Row title={t('圆角')} desc={t('主区和右栏的圆角，0 是直角')}>
          <Slider
            label={t('面板圆角')}
            value={value.panelRadius}
            min={0}
            max={24}
            step={1}
            def={DEFAULTS.panelRadius}
            format={(v) => `${Math.round(v)}px`}
            onChange={(v) => set('panelRadius', Math.round(v))}
          />
        </Row>
      </Group>
      <Group title={t('字体')}>
        <Row
          title={t('英文字体')}
          desc={t('字母、数字和符号用的字体')}
          hint={t(
            '默认是内置的等宽 Maple Mono NL（不带符号连字）；也可以换系统界面字体（Segoe UI / 苹方）、内置的 Inter 或 IBM Plex Sans。',
          )}
        >
          <Select
            aria-label={t('英文字体')}
            value={value.uiFont}
            onChange={(e) => {
              const f = e.target.value as Appearance['uiFont']
              // 空格宽度还是旧字体的默认值：跟着换成新字体的默认值（只有等宽字体要收窄空格）
              const ws = value.wordSpacing === WORD_SPACING[value.uiFont] ? WORD_SPACING[f] : value.wordSpacing
              update({ ...value, uiFont: f, wordSpacing: ws })
            }}
            options={[
              { value: 'maple', label: t('Maple Mono NL（内置）') },
              { value: 'system', label: t('系统字体') },
              { value: 'inter', label: t('Inter（内置）') },
              { value: 'plex', label: t('IBM Plex Sans（内置）') },
            ]}
          />
        </Row>
        <Row
          title={t('中文字体')}
          desc={t('汉字用的字体')}
          hint={t(
            '英文字体里没有汉字，汉字用这里选的字体。Maple Mono CN 是 Maple Mono 的中文版：一个汉字正好占两个英文字母宽，和 Maple Mono 英文上下对齐，但汉字之间比思源黑体疏；它只有常规和中粗两档，标题由浏览器加粗。',
          )}
        >
          <Select
            aria-label={t('中文字体')}
            value={value.cjkFont}
            onChange={(e) => set('cjkFont', e.target.value as Appearance['cjkFont'])}
            options={[
              { value: 'noto', label: t('思源黑体 Noto Sans SC（内置）') },
              { value: 'maple', label: t('Maple Mono CN（内置）') },
              { value: 'system', label: t('系统字体（苹方 / 微软雅黑）') },
            ]}
          />
        </Row>
        <Row title={t('代码字体')} desc={t('代码、命令和路径用的等宽字体')}>
          <Select
            aria-label={t('代码字体')}
            value={value.monoFont}
            onChange={(e) => set('monoFont', e.target.value as Appearance['monoFont'])}
            options={[
              { value: 'maple', label: t('Maple Mono NL（内置）') },
              { value: 'jetbrains', label: t('JetBrains Mono（内置）') },
            ]}
          />
        </Row>
        <Row
          title={t('自定义字体')}
          desc={t('本机字体名，优先于上面选的')}
          hint={t('填本机装了的字体名，多个用逗号隔开，会排在上面选的字体前面；没有的字还用上面的。留空不用。')}
        >
          <Input
            value={value.customFont}
            placeholder={t('例如 Sarasa Gothic SC')}
            aria-label={t('自定义字体')}
            onChange={(e) => set('customFont', e.target.value)}
            className="h-9"
          />
        </Row>
        <Row title={t('字号')} desc={t('正文字号，其他文字按比例跟着变')}>
          <Slider
            label={t('字号')}
            value={value.fontSize}
            min={12}
            max={18}
            step={0.5}
            def={DEFAULTS.fontSize}
            format={(v) => `${v}px`}
            onChange={(v) => set('fontSize', v)}
          />
        </Row>
        <Row title={t('字间距')} desc={t('负数更紧凑')} hint={t('Maple Mono 是等宽字体，默认稍微收紧一点。')}>
          <Slider
            label={t('字间距')}
            value={value.letterSpacing}
            min={-0.08}
            max={0.15}
            step={0.005}
            def={DEFAULTS.letterSpacing}
            format={(v) => `${round(v, 3)}em`}
            onChange={(v) => set('letterSpacing', round(v, 3))}
          />
        </Row>
        <Row
          title={t('空格宽度')}
          desc={t('中英文之间的空隙主要来自它')}
          hint={t('等宽字体的空格比较宽，默认收窄；代码里的空格不调。')}
        >
          <Slider
            label={t('空格宽度')}
            value={value.wordSpacing}
            min={-0.4}
            max={0.3}
            step={0.01}
            def={WORD_SPACING[value.uiFont]}
            format={(v) => `${round(v, 2)}em`}
            onChange={(v) => set('wordSpacing', round(v, 2))}
          />
        </Row>
        <Row title={t('行高')} desc={t('对话回复和文档正文的行距')}>
          <Slider
            label={t('行高')}
            value={value.lineHeight}
            min={1.3}
            max={2.2}
            step={0.05}
            def={DEFAULTS.lineHeight}
            format={(v) => round(v, 2).toFixed(2)}
            onChange={(v) => set('lineHeight', round(v, 2))}
          />
        </Row>
        <Card padding="md" className="mt-4">
          <p className="text-[0.75rem] text-subtle">{t('预览')}</p>
          <p className="mt-2 text-[0.875rem]">
            {t('Agent 面板按工作流调度本机的编码 Agent。')} The quick brown fox jumps over the lazy dog.
          </p>
          <pre className="mt-2 rounded-md bg-field px-3 py-2 font-mono text-[0.75rem]">
            {'const ok = a => b !== c && x >= 0 // 0O 1lI 中文注释'}
          </pre>
        </Card>
      </Group>
    </>
  )
}
