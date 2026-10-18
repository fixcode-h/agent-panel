import type { Category } from '@shared/schema'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { CategoryPicker as Picker } from '@/components/ui/category-picker'

/** Agent / 工作流的分类选择：两边的分类各列各的 */
export function CategoryPicker({
  value,
  onChange,
  scope = 'agent',
}: {
  value: string
  onChange: (id: string) => void
  scope?: Category['scope']
}) {
  const { categories, setCategories } = useData()
  return (
    <Picker
      value={value}
      onChange={onChange}
      options={categories.filter((c) => (c.scope ?? 'agent') === scope)}
      onCreate={async (name) => {
        const c = await api.createCategory(name, scope)
        setCategories((cs) => [...cs, c])
        return c
      }}
    />
  )
}
