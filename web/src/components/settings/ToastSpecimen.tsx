import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'

/**
 * 设置 → 组件里提示的样张：点一下真的弹一条，和全站的提示同一个容器、同一套样式，
 * 调位置、停留时长、圆角时边调边点就能看到效果
 */
export function ToastSpecimen() {
  const samples = [
    { label: t('成功'), fire: () => toast.success(t('已保存')) },
    {
      label: t('提醒'),
      fire: () =>
        toast.info(t('有 {n} 个表格有上次没保存的改动', { n: 1 }), {
          description: t('文件树上带点的就是，打开时可以选择恢复。'),
        }),
    },
    { label: t('警告'), fire: () => toast.warning(t('还没有 Agent 在用这个 API')) },
    {
      label: t('出错'),
      fire: () => toast.error(t('保存失败'), { description: t('文件被别的程序占用，关掉后再试一次。') }),
    },
    {
      label: t('带按钮'),
      fire: () => toast(t('已删除 3 行'), { action: { label: t('撤销'), onClick: () => {} } }),
    },
  ]
  return (
    <>
      {samples.map((s) => (
        <Button key={s.label} variant="secondary" size="sm" onClick={s.fire}>
          {s.label}
        </Button>
      ))}
    </>
  )
}
