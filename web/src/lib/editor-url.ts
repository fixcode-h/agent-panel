/**
 * 「在编辑器中打开」的地址：VS Code 及兼容的编辑器认 vscode://file/。
 * 以前文件弹窗、任务文件弹窗、差异弹窗各写了一份，第三份还不带行号，这里收成一份。
 */
export function editorUrl(dir: string, file: string, line?: number) {
  // 传进来的已经是绝对路径（例如附件按绝对路径读）就不要再拼目录，否则会拼成 dir/D:/x
  const full = (/^([A-Za-z]:)?[\\/]/.test(file) ? file : `${dir.replace(/[\\/]+$/, '')}/${file}`).replace(/\\/g, '/')
  // 空格、中文按 URI 编码：浏览器打开外链时本来就会编码，这里先编码，地址里的空格不会被截断
  const path = encodeURI(full.startsWith('/') ? full.slice(1) : full)
  return `vscode://file/${path}${line ? `:${line}` : ''}`
}
