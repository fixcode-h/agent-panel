/**
 * 时间拼串的口径：年月日、时分、补零都只在这里实现。
 *
 * 以前各处自己写 `String(n).padStart(2, '0')` 和模板串，同一个格式有好几份，
 * 加减一个空格或换成 UTC 都只改到一处、漏掉另一处。时间一律按本机时区（和任务列表按天分组一致）。
 */

/** 两位补零：月、日、时、分、秒 */
export const pad2 = (n: number) => String(n).padStart(2, '0')

/** 本机时区的日期 YYYY-MM-DD（按自然日分桶、存文件名） */
export const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** 本机时区的时分 HH:mm（固定 24 小时制，不跟着系统语言变） */
export const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
