import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { CategoryPicker as Picker } from '@/components/ui/category-picker'

/** Agent 分类选择 */
export function CategoryPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { categories, setCategories } = useData()
  return (
    <Picker
      value={value}
      onChange={onChange}
      options={categories}
      onCreate={async (name) => {
        const c = await api.createCategory(name)
        setCategories((cs) => [...cs, c])
        return c
      }}
    />
  )
}
