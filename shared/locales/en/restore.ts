/** 英文词典的一部分，键是中文原文：UI 设计照原画还原（从原画抠切图、对照、步骤、门槛设置） */
export const EN_RESTORE: Record<string, string> = {
  // 设置
  原画还原: 'Concept restore',
  位置误差: 'Position tolerance',
  控件和原画差几像素以内算对上: 'How many pixels off still counts as matching the concept',
  '按设计稿像素算，位置和大小都看。默认 2 像素': 'In design pixels, for both position and size. Default 2 px',
  '{n} 像素（默认）': '{n} px (default)',
  '{n} 像素': '{n} px',
  达标比例: 'Pass ratio',
  对上的元素至少占多少才算过关: 'Share of elements that must match to pass',
  '校验一步没过关时要你确认接受哪些差异。默认 95%':
    'If the Verify step does not pass, you confirm which differences to accept. Default 95%',
  '{n}（默认）': '{n} (default)',
  切图相似度: 'Asset similarity',
  切图和原画那一块至少多像: 'Minimum similarity between an asset and its area in the concept',
  '精修（照着原画重画）出来的切图低于它就不选用，仍用原画里抠的那版。默认 92%':
    'Refined assets below this are not used; the cut from the concept is kept. Default 92%',
}
