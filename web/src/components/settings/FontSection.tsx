import { Appearance, WORD_SPACING } from '@shared/schema'
import { t } from '@shared/i18n'
import { applyAppearance } from '@/lib/appearance'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Group, Row } from '@/components/settings/parts'

const DEFAULTS = Appearance.parse({})

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
    <Group>
      <Row title={t('英文字体')} desc={t('默认是内置的 Maple Mono NL：不带符号连字，=> 、!= 这些不会合成一个符号。')}>
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
            { value: 'plex', label: t('IBM Plex Sans（内置）') },
            { value: 'system', label: t('系统字体') },
          ]}
        />
      </Row>
      <Row
        title={t('中文字体')}
        desc={t('英文字体里没有汉字，汉字用这里选的字体。思源黑体和 Maple Mono 中文版是同一套字形。')}
      >
        <Select
          aria-label={t('中文字体')}
          value={value.cjkFont}
          onChange={(e) => set('cjkFont', e.target.value as Appearance['cjkFont'])}
          options={[
            { value: 'noto', label: t('思源黑体 Noto Sans SC（内置）') },
            { value: 'system', label: t('系统字体（苹方 / 微软雅黑）') },
          ]}
        />
      </Row>
      <Row title={t('代码字体')} desc={t('代码块、命令、路径用的等宽字体。')}>
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
        desc={t('填本机装了的字体名，多个用逗号隔开，会排在上面选的字体前面；没有的字还用上面的。留空不用。')}
      >
        <Input
          value={value.customFont}
          placeholder={t('例如 Sarasa Gothic SC')}
          aria-label={t('自定义字体')}
          onChange={(e) => set('customFont', e.target.value)}
          className="h-9"
        />
      </Row>
      <Row title={t('字号')} desc={t('界面正文的字号，其他文字按比例跟着变。')}>
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
      <Row title={t('字间距')} desc={t('字和字之间的距离，负数更紧凑。Maple Mono 是等宽字体，默认稍微收紧一点。')}>
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
        desc={t('调整空格的宽度，中英文之间的空隙主要来自它。等宽字体的空格比较宽，默认收窄；代码里的空格不调。')}
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
      <Row title={t('行高')} desc={t('对话回复和文档正文的行距。')}>
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
      <div className="mt-4 rounded-xl border bg-card p-4">
        <p className="text-[0.75rem] text-subtle">{t('预览')}</p>
        <p className="mt-2 text-[0.875rem]">
          {t('Agent 面板按工作流调度本机的编码 CLI。')} The quick brown fox jumps over the lazy dog.
        </p>
        <pre className="mt-2 rounded-md bg-field px-3 py-2 font-mono text-[0.78125rem]">
          {'const ok = a => b !== c && x >= 0 // 0O 1lI 中文注释'}
        </pre>
      </div>
    </Group>
  )
}
