// 在线演示提示条的文案：只在演示版里用到。不放进 en.ts，免得正式版的包里出现演示内容（出包脚本会检查）
export const EN_DEMO: Record<string, string> = {
  在线演示: 'Live demo',
  '：数据只存在你的浏览器里，Agent 和本机目录是模拟的。':
    ': data lives only in your browser; the agents and local folders are simulated.',
  恢复示例数据: 'Restore sample data',
  '恢复示例数据？': 'Restore sample data?',
  '你在演示里新建和修改的角色、工作流、项目和任务都会被清掉，换回最初的示例。':
    'Roles, workflows, projects and tasks you created or changed in the demo will be cleared and replaced with the original samples.',
}
