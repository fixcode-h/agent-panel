/** 英文词典的一部分，键是中文原文：照原画还原的六步流程（新建入口、步骤条、元素框、决策卡、校验） */
export const EN_RESTORE_FLOW: Record<string, string> = {
  格子: 'Slot',
  校验: 'Verify',
  先出拆件图: 'Generate a parts sheet first',
  '切图前让图片模型照原画把每个元素单独画一遍，从拆件图里切':
    'Before slicing, have the image model redraw every element of the art separately and cut slices from that sheet',
  '直接从原画抠会夹带别的 UI；拆件图里每件都是干净的。对不上的元素仍从原画抠。用设置里的图片 CLI':
    'Cutting straight from the art drags in neighboring UI; every piece on the parts sheet is clean. Elements that do not match are still cut from the art. Uses the image CLI from settings',
}
