/**
 * 设置 →「快捷键」：开发者模式抓取元素的快捷键和鼠标按键。
 * 快捷键是录出来的，不是手打一个字符：点一下输入框、按一下想用的键就录好了（Esc 取消，Backspace 恢复默认）。
 */
import { useEffect, useState } from 'react'
import { Keyboard, MousePointerClick } from 'lucide-react'
import { t } from '@shared/i18n'
import { DEFAULT_PICK_BUTTON, DEFAULT_PICK_HOTKEY, PICK_BUTTONS, type ElementPicker } from '@shared/schema'
import { pickButtonLabel } from '@/lib/element-pick'
import { hotkeyFromEvent, hotkeyLabel, parseHotkey } from '@/lib/hotkey'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Group, Row } from '@/components/settings/parts'

/** 录键框：点一下进入录音，按下想用的键就写进去；Esc 取消、Backspace 恢复默认 */
function HotkeyField({ label, value, onChange }: { label: string; value: string; onChange: (hotkey: string) => void }) {
  const [recording, setRecording] = useState(false)
  // 录音时把键盘事件全接过来：修饰键本身的按下不能漏给页面（CommandPalette 的 ⌘K 会抢走）
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(false)
      if (e.key === 'Backspace') {
        onChange(DEFAULT_PICK_HOTKEY)
        return setRecording(false)
      }
      const hotkey = hotkeyFromEvent(e)
      if (!hotkey) return
      onChange(hotkey)
      setRecording(false)
    }
    // 录音时鼠标点别处、切走到其他窗口就取消，不要一直挂在录音状态
    const off = () => setRecording(false)
    window.addEventListener('keydown', onKey, { capture: true })
    window.addEventListener('pointerdown', off)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener('pointerdown', off)
      window.removeEventListener('blur', off)
    }
  }, [recording, onChange])
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={recording}
      onClick={() => setRecording((v) => !v)}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        'flex h-9 w-[240px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-[0.8125rem] transition-colors',
        recording ? 'border-accent bg-accent-soft text-accent-text' : 'border-line-strong bg-field hover:border-focus',
      )}
    >
      <Keyboard className="h-3.5 w-3.5 shrink-0 text-subtle" />
      {recording ? (
        <span className="text-muted">{t('按下想用的键，Esc 取消')}</span>
      ) : (
        <kbd className="font-mono">{hotkeyLabel(value)}</kbd>
      )}
    </button>
  )
}

export function ShortcutsSection({ value, onChange }: { value: ElementPicker; onChange: (v: ElementPicker) => void }) {
  const set = <K extends keyof ElementPicker>(k: K, v: ElementPicker[K]) => onChange({ ...value, [k]: v })
  const isDefault = value.hotkey === DEFAULT_PICK_HOTKEY && value.button === DEFAULT_PICK_BUTTON
  // 存下来的写法认不出来（手改了设置文件）：界面上提醒一句，不然用户不知道为什么按了没反应
  const broken = !parseHotkey(value.hotkey)
  return (
    <>
      <p className="text-[0.8125rem] leading-relaxed text-subtle">
        {t(
          '抓取界面元素（开发者模式）的快捷键：按一下进入抓取，再按一下退出。在输入框里打字时不会触发，带了 Ctrl / Alt 的组合键除外。',
        )}
      </p>
      <Group>
        <Row
          title={t('抓取元素的快捷键')}
          desc={t('默认是「{key}」。键盘上打不出这个键时，可以点右边换成别的组合（例如 Ctrl+Shift+E）。', {
            key: DEFAULT_PICK_HOTKEY,
          })}
        >
          <div className="flex flex-col gap-1">
            <HotkeyField label={t('抓取元素的快捷键')} value={value.hotkey} onChange={(k) => set('hotkey', k)} />
            {broken && <span className="text-xs text-danger">{t('这个写法认不出来，按 Backspace 恢复默认')}</span>}
          </div>
        </Row>
        <Row
          title={t('用哪个鼠标键抓取')}
          desc={t('其他两个键在抓取期间照常可用：左键还能点按钮、右键还能弹菜单，所以抓取键一般用中键。')}
        >
          <Select
            aria-label={t('用哪个鼠标键抓取')}
            value={value.button}
            onChange={(e) => set('button', e.target.value as ElementPicker['button'])}
            className="w-[240px]"
            options={PICK_BUTTONS.map((b) => ({ value: b, label: pickButtonLabel(b) }))}
          />
        </Row>
        <Row
          title={t('退出抓取')}
          desc={t('抓取期间按 Esc 或再按一次上面的快捷键都能退出；抓到一个元素后也会自动退出。')}
        >
          <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
            <MousePointerClick className="h-4 w-4 text-subtle" />
            <Kbd className="h-auto px-1.5 py-0.5 text-[0.75rem]">Esc</Kbd>
            <span>{t('或')}</span>
            <Kbd className="h-auto px-1.5 py-0.5 text-[0.75rem]">{hotkeyLabel(value.hotkey)}</Kbd>
          </div>
        </Row>
        {!isDefault && (
          <Row title={t('恢复默认')} desc={t('快捷键回到「{key}」，抓取键回到中键。', { key: DEFAULT_PICK_HOTKEY })}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange({ hotkey: DEFAULT_PICK_HOTKEY, button: DEFAULT_PICK_BUTTON })}
            >
              {t('恢复默认')}
            </Button>
          </Row>
        )}
      </Group>
    </>
  )
}
