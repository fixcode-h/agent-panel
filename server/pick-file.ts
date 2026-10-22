/**
 * 本机文件选择框。
 *
 * 浏览器出于安全只会给出文件名，拿不到用户选文件时的完整路径，所以大文件在本机找不回原路径时
 * 只能由面板自己弹出系统的选择框：选完直接拿到绝对路径，文件内容不用经过浏览器。
 *
 * 平台各用一种现成的系统对话框：Windows 用 PowerShell 的 WinForms 文件对话框，
 * macOS 用 osascript，Linux 用 zenity，没有 zenity 再试 kdialog。
 */
import { spawn } from 'node:child_process'
import { t } from '../shared/i18n.ts'

/** 对话框里每一行路径前面加个标记：PowerShell 自己也可能往 stdout 写别的行 */
const MARK = '@@agent-panel-pick@@'

const TITLE = '选择要引用的文件'

const WINDOWS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Multiselect = $true
$d.Title = '${TITLE}'
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  foreach ($f in $d.FileNames) { Write-Output ("${MARK}" + $f) }
} else { Write-Output "${MARK}CANCELLED" }
`,
]

const MACOS = [
  '-e',
  `set out to ""
tell application "System Events"
  set picked to choose file with prompt "${TITLE}" with multiple selections allowed
  repeat with f in picked
    set out to out & (POSIX path of f) & linefeed
  end repeat
end tell
return out`,
]

/** zenity 和 kdialog 取消时的退出码都是 1 */
const LINUX = ['--file-selection', '--multiple', '--separator=\n', `--title=${TITLE}`]
const KDIALOG = ['--getopenfilename', '.', '--multiple', '--separate-output', '--title', TITLE]

type Run = { code: number | null; stdout: string; error?: Error }

/** 跑一个对话框程序，收集 stdout。等不到结果就杀掉，报超时 */
function run(command: string, args: string[], timeoutMs = 5 * 60_000): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true })
    let out = ''
    let settled = false
    const finish = (r: Run) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, stdout: '', error: new Error(t('选择文件的窗口一直没有响应')) })
    }, timeoutMs)
    child.stdout.on('data', (b) => (out += String(b)))
    child.stderr.on('data', () => {})
    child.on('error', (error) => finish({ code: null, stdout: '', error }))
    child.on('close', (code) => finish({ code, stdout: out }))
  })
}

/** 从 output 里取出路径；取消或失败时返回空数组 */
function pathsOf(r: Run): string[] {
  if (r.error) throw r.error
  if (r.code !== 0) return []
  const marked = r.stdout
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x.startsWith(MARK))
    .map((x) => x.slice(MARK.length))
  if (marked.includes('CANCELLED')) return []
  // zenity / kdialog / osascript 直接一行一个路径
  const list = marked.length ? marked : r.stdout.split('\n')
  return [...new Set(list.map((x) => x.trim()).filter(Boolean))]
}

/**
 * 弹出系统的文件选择框，返回选中的绝对路径；用户取消时返回空数组。
 * 平台没有可用的对话框时抛错，由接口告诉用户改用别的办法。
 */
export async function pickFiles(): Promise<string[]> {
  if (process.platform === 'win32') return pathsOf(await run('powershell.exe', WINDOWS))
  if (process.platform === 'darwin') return pathsOf(await run('osascript', MACOS))
  const zenity = await run('zenity', LINUX)
  if (!zenity.error) return pathsOf(zenity)
  return pathsOf(await run('kdialog', KDIALOG))
}
