/**
 * 「在编辑器中打开」的地址：路径拼错、反斜杠没换、行号丢在盘符后面，点了都打不开文件。
 * 这几个用例盯住 Windows 盘符、正反斜杠、行号和空格四件事。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { editorUrl } from '@/lib/editor-url'

test('editorUrl：Windows 目录和带反斜杠的路径换成斜杠，盘符保留', () => {
  assert.equal(editorUrl('C:\\work\\proj', 'src\\a.ts'), 'vscode://file/C:/work/proj/src/a.ts')
})

test('editorUrl：目录末尾的斜杠不重复', () => {
  assert.equal(editorUrl('C:/work/proj/', 'src/a.ts'), 'vscode://file/C:/work/proj/src/a.ts')
})

test('editorUrl：带行号时行号在路径后面', () => {
  assert.equal(editorUrl('/home/me/proj', 'src/a.ts', 12), 'vscode://file/home/me/proj/src/a.ts:12')
})

test('editorUrl：文件本身是绝对路径时不再拼目录', () => {
  assert.equal(editorUrl('C:/work/proj', 'D:/other/b.txt'), 'vscode://file/D:/other/b.txt')
  assert.equal(editorUrl('C:/work/proj', '/home/me/c.txt'), 'vscode://file/home/me/c.txt')
})

test('editorUrl：空格和中文按 URI 编码', () => {
  assert.equal(editorUrl('C:\\my project', 'a b.ts'), 'vscode://file/C:/my%20project/a%20b.ts')
  assert.equal(editorUrl('/home/me/项目', '说明.md'), 'vscode://file/home/me/%E9%A1%B9%E7%9B%AE/%E8%AF%B4%E6%98%8E.md')
})

test('editorUrl：没有行号时路径后面不接行号', () => {
  assert.ok(editorUrl('/home/me', 'a.ts').endsWith('/a.ts'))
})
