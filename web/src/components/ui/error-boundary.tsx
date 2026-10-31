import { Component, type ReactNode } from 'react'
import { AlertTriangle, Copy, RotateCw } from 'lucide-react'
import { copyText } from '@/lib/copy-text'
import { t } from '@shared/i18n'
import { Button } from './button'

interface Props {
  children: ReactNode
  /** 换了这个值（例如切到别的页面、别的任务）就重新渲染，不用手动点重试 */
  resetKey?: string
  className?: string
}

/**
 * 页面的一部分渲染出错时，只在这一块显示错误，侧栏和其他部分照常可用，不会整页白屏。
 * 常见原因是旧数据里少了字段，可以点「重新加载」再试，或者复制错误信息反馈。
 */
export class ErrorBoundary extends Component<Props, { error: Error | null; key?: string }> {
  state: { error: Error | null; key?: string } = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: { error: Error | null; key?: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: Error) {
    console.error(error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const detail = `${error.message}\n\n${error.stack ?? ''}`
    return (
      <div
        role="alert"
        className={
          this.props.className ?? 'flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-body'
        }
      >
        <AlertTriangle className="h-6 w-6 text-warning" />
        <p className="font-medium text-fg">{t('这部分出错了')}</p>
        <p className="max-w-md break-words text-subtle">{error.message}</p>
        <div className="mt-1 flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => this.setState({ error: null })}>
            <RotateCw className="h-3.5 w-3.5" />
            {t('重新加载')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void copyText(detail, { done: t('已复制错误信息'), fail: false })}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('复制错误信息')}
          </Button>
        </div>
      </div>
    )
  }
}
