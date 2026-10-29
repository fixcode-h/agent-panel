import { useEffect, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { MessageCircleQuestion } from 'lucide-react'
import type { TaskRequest } from '@shared/schema'
import { api } from '@/lib/api'
import { useScopedSetting } from '@/lib/useScopedSetting'
import { askUserDefault } from '@/lib/askUserDefault'
import { useData } from '@/lib/data'
import { RequestCard } from '@/components/tasks/RequestCard'
import { Button } from '@/components/ui/button'
import { ToggleIconButton } from '@/components/ui/icon-button'
import { Modal } from '@/components/ui/modal'
import { ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/menu'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { childAskChecked, childAskInitial } from '@shared/child-ask'

/**
 * 「提问」开关，所有 AI 会话的输入框上都有：打开时 AI 有问题会弹出卡片问你，它等你回答；
 * 关着时让 AI 自己选最合适的做法接着做。审批（命令、改文件）不受它影响，按设置里的权限决定要不要你确认。
 *
 * 父对话上还多一个右键菜单「子对话也提问」：之后新建的子对话默认开不开提问（见 shared/child-ask.ts）
 */
export function AskToggle({
  value,
  onChange,
  childAskUser,
  onChildAskUserChange,
  className,
}: {
  value: boolean
  onChange: (v: boolean) => void
  /** 父对话才有：它名下新建的子对话默认是否开启提问（存在任务上的 childAskUser） */
  childAskUser?: boolean
  /** 父对话才有：右键菜单改「子对话也提问」；applyExisting 表示现在就把已创建的子对话一起打开 */
  onChildAskUserChange?: (on: boolean, applyExisting: boolean) => void
  className?: string
}) {
  // 勾上「子对话也提问」时要问用户：已创建的子对话要不要一起开（只对之后的生效就不弹）
  const [askExisting, setAskExisting] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(openTimer.current), [])
  /**
   * 等右键菜单真正关掉再开弹窗：菜单卸载时会把焦点还给触发按钮，和弹窗的自动聚焦在同一批更新里时，
   * 默认焦点可能被抢回提问按钮上（键盘用户回车会选不中默认项）
   */
  const openDialog = () => {
    clearTimeout(openTimer.current)
    openTimer.current = setTimeout(() => setAskExisting(true), 0)
  }
  const button = (
    <ToggleIconButton
      size="sm"
      icon={MessageCircleQuestion}
      pressed={value}
      onPressedChange={onChange}
      // 没有「子对话也提问」菜单的地方（子对话、新建任务）也挡掉浏览器右键菜单：
      // 应用内的按钮上弹出「另存为 / 打印」没有意义，和父对话有菜单时也不一致。
      // 有菜单时交给下面的 ContextMenuTrigger，它自己会挡
      onContextMenu={onChildAskUserChange ? undefined : (e) => e.preventDefault()}
      label={t('AI 有问题时问我')}
      title={
        value
          ? t('AI 有问题时会问你，等你回答再继续（点一下改成让 AI 自己选）')
          : t('AI 有问题时自己选最合适的做法（点一下改成问你）')
      }
      // 设计稿：输入框工具条里只有图标、不出底色；开着是运行色，关着是次要色
      tone="bare"
      className={cn(value ? 'text-run hover:text-run aria-pressed:text-run' : 'text-subtle', className)}
    />
  )
  // 子对话、其他会话没有「子对话也提问」这回事：保持原来的单按钮
  if (!onChildAskUserChange) return button
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuCheckboxItem
            // 父对话关着提问时这一项跟着显示未勾选，重新打开后回到原来的值
            checked={childAskChecked({ askUser: value, childAskUser: childAskInitial({ childAskUser }) })}
            onCheckedChange={(next) => {
              // 取消勾选只影响之后新建的子对话，已有子对话保持不动，所以不弹窗
              if (!next) return onChildAskUserChange(false, false)
              openDialog()
            }}
          >
            {t('子对话也提问')}
          </ContextMenuCheckboxItem>
          <p className="px-2.5 pb-1.5 text-[0.6875rem] leading-relaxed text-subtle">
            {t('只对之后新建的子对话生效，已创建的子对话保持各自的选择。')}
          </p>
        </ContextMenuContent>
      </ContextMenu>
      <ChildAskDialog
        open={askExisting}
        onOpenChange={setAskExisting}
        onPick={(applyExisting) => onChildAskUserChange(true, applyExisting)}
      />
    </>
  )
}

/**
 * 勾上「子对话也提问」后问用户：已创建的子对话要不要一起开。
 * 默认选「只对之后新建」：它改的范围小，已创建的子对话再改一次也不麻烦
 */
function ChildAskDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** applyExisting: true 表示现在就把已创建的子对话的提问都打开 */
  onPick: (applyExisting: boolean) => void
}) {
  const defaultRef = useRef<HTMLButtonElement>(null)
  const pick = (applyExisting: boolean) => {
    onPick(applyExisting)
    onOpenChange(false)
  }
  return (
    // 点遮罩关闭（closeOnOutside）：和 Esc 一样什么都不改
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={null}
      size="sm"
      bare
      closeOnOutside
      className="p-6"
      // 默认焦点自己指定，不靠 autoFocus 和 Radix 菜单的焦点还原抢时序
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        defaultRef.current?.focus()
      }}
    >
      <D.Title className="text-[0.9375rem] font-semibold">{t('子对话也提问')}</D.Title>
      <D.Description className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">
        {t('已创建的子对话要不要也打开「提问」？之后新建的子对话都会向你提问。')}
      </D.Description>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={() => pick(true)}>
          {t('应用到已创建的子对话')}
        </Button>
        <Button ref={defaultRef} onClick={() => pick(false)}>
          {t('只对之后新建的子对话')}
        </Button>
      </div>
    </Modal>
  )
}

/** 每个会话各自记住「提问」开关；新会话按设置里的默认值 */
export function useAskUser(scope: string) {
  return useScopedSetting<boolean>(
    'ask-user',
    scope,
    (raw) => raw === '1',
    (v) => (v ? '1' : '0'),
    askUserDefault,
  )
}

/** 新建任务的输入框这类每次都开新会话的：不记上次的选择，每次打开都按设置里的默认值 */
export function useNewAskUser() {
  const [value, setValue] = useState(askUserDefault)
  // 设置取回来或在设置里改了默认值：还没发出去的新会话跟着变
  const def = useData().settings?.askUserDefault
  const [seen, setSeen] = useState(def)
  if (seen !== def) {
    setSeen(def)
    if (def !== undefined) setValue(def)
  }
  return [value, setValue] as const
}

/**
 * 任务页以外的会话在等你处理的审批和提问：执行中定时取回来。
 * active 为 false（没在执行）时不取
 */
export function useScopeRequests(scope: string, active: boolean) {
  const [list, setList] = useState<TaskRequest[]>([])
  useEffect(() => {
    if (!active) {
      setList([])
      return
    }
    let stop = false
    const load = () =>
      api
        .asks(scope)
        .then((l) => !stop && setList(l))
        .catch(() => {})
    void load()
    const timer = setInterval(load, 1200)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [scope, active])
  const answer = async (id: string, r: { allow: boolean; answer?: string; answers?: string[] }) => {
    await api.answerAsk(id, r)
    setList((l) => l.filter((x) => x.id !== id))
  }
  /** 提问窗口的关闭：不回答，这次会话终止（服务端停掉它，和点停止一样） */
  const close = async () => {
    const id = list[0]?.id
    if (!id) return
    await api.closeAsk(id)
    setList([])
  }
  return { list, answer, close }
}

/** 等你处理的审批和提问，贴在输入框上方 */
export function ScopeRequests({ scope, active, className }: { scope: string; active: boolean; className?: string }) {
  const { list, answer, close } = useScopeRequests(scope, active)
  return <RequestCard requests={list} className={className} onAnswer={answer} onClose={close} />
}
