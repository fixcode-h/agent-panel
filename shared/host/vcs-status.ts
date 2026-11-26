/**
 * 引擎宿主里的「版本管理状态一览」（vcs_status，2026-11-26 复盘 §5-5）：问 Git / P4、拼文字都在服务端
 * （server/vcs/status.ts），引擎只转交调用。单独成一个小接口，不往 VcsHost / OrchVcs 上加成员（重构文档第 5 条）
 */
export interface VcsStatusApi {
  /** files 不给时看这个对话记下的改动（P4 再加上工作目录下打开着的） */
  call: (req: { files?: string[] }) => Promise<string>
}

export interface VcsStatusHost {
  vcsStatus?: VcsStatusApi
}

export interface OrchVcsStatus {
  vcsStatus?: VcsStatusApi
}
