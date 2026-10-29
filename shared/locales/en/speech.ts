/** 英文词典的一部分，键是中文原文 */
export const EN_SPEECH: Record<string, string> = {
  // 本机语音输入：输入框上的麦克风按钮
  '这个页面不能录音：浏览器只允许 localhost / 127.0.0.1 或 https 的页面使用麦克风':
    "This page can't record: browsers only allow the microphone on localhost / 127.0.0.1 or https pages",
  '没有麦克风权限：在浏览器地址栏左边的网站设置里允许使用麦克风后再试':
    'No microphone permission: allow the microphone in the site settings to the left of the address bar, then try again',
  没有找到麦克风: 'No microphone found',
  麦克风被别的程序占用了: 'The microphone is in use by another program',
  '录音失败：{error}': 'Recording failed: {error}',
  '没有听清说了什么，再说一遍试试': "Couldn't make out what was said. Try again",
  '语音识别失败：{error}': 'Speech recognition failed: {error}',
  '正在识别…': 'Recognizing…',
  '停止录音并识别（Esc 放弃）': 'Stop and transcribe (Esc to discard)',
  '语音输入：点一下开始说话，再点一下转成文字': 'Voice input: click to start talking, click again to transcribe',

  // 设置 → 语音输入
  语音输入: 'Voice input',
  '在本机把说的话转成文字，录音不上传到任何网站。识别用开源的 sherpa-onnx，模型和识别库都要在下面自己选了才下载，放在数据目录里。':
    'Turns speech into text on this computer; recordings are never uploaded anywhere. Recognition uses open-source sherpa-onnx. Nothing is downloaded until you pick a model below; models and the recognition library are stored in the data folder.',
  启用语音输入: 'Enable voice input',
  '打开后对话输入框上多一个麦克风按钮：点一下开始说话，再点一下转成文字插到光标处，录音中按 Esc 放弃。要先在下面下载一个模型。':
    'Adds a microphone button to the chat input: click to start talking, click again to insert the text at the cursor, press Esc while recording to discard. Download a model below first.',
  正在使用的模型: 'Model in use',
  '语音识别库没有这台电脑（{platform}）的版本，暂时用不了语音输入':
    "The speech recognition library has no build for this computer ({platform}), so voice input isn't available yet",
  '已下载，可以直接用': 'Downloaded and ready',
  '还没下载：在下面的模型列表里点「下载」': 'Not downloaded yet: click "Download" in the model list below',
  '选一个下载，下载好后点「使用」切换。中文为主推荐 SenseVoice；电脑内存小选 Paraformer；英文和其它语言多选 Whisper。第一次下载还会带上识别库（约 30 MB）。':
    'Download one, then click "Use" to switch to it. SenseVoice is best for mostly Chinese; Paraformer for low-memory computers; Whisper for English and other languages. The first download also fetches the recognition library (about 30 MB).',
  使用中: 'In use',
  使用国内镜像下载语音模型: 'Download speech models from China mirrors',
  '打不开 Hugging Face 时打开：模型从 hf-mirror.com 下载，识别库从 npmmirror 下载':
    'Turn on if Hugging Face is unreachable: models come from hf-mirror.com and the recognition library from npmmirror',
  存放位置: 'Location',
  '删掉后要用需要重新下载。识别库保留，别的模型不受影响。':
    "You'll need to download it again to use it. The recognition library and other models are kept.",

  // 模型说明（shared/speech.ts）
  '中文、粤语、英文、日文、韩文都能识别，中英混说也认得准，自带标点。速度很快，普通 CPU 上几秒的话不到半秒出字':
    'Recognizes Mandarin, Cantonese, English, Japanese and Korean, handles mixed Chinese and English well, and adds punctuation. Very fast: a few seconds of speech transcribes in under half a second on an ordinary CPU',
  '和上面是同一个模型的完整精度版：准确率略高一点，体积是它的 4 倍左右、也慢一些':
    'Full-precision version of the model above: slightly more accurate, about 4× the size and somewhat slower',
  '阿里 FunASR 的中文小模型：只有 79MB，最省内存，普通话识别稳，也认得夹在中文里的英文单词；不带标点':
    "Alibaba FunASR's small Chinese model: only 79 MB and the lightest on memory, reliable for Mandarin and picks up English words mixed in; no punctuation",
  'OpenAI Whisper 的小号模型：支持近百种语言，英文为主时选它；中文偶尔会写成繁体':
    "OpenAI Whisper's small model: nearly 100 languages, a good pick for mostly English; Chinese sometimes comes out in Traditional characters",
  'Whisper 里准确率最高的一档之一，多语言效果好；体积大，没有显卡时一句话要几秒':
    'One of the most accurate Whisper models, strong across languages; large, and takes a few seconds per sentence without a GPU',

  // 服务端（server/speech.ts）
  '下载识别库 {name}': 'Downloading recognition library {name}',
  '解压识别库失败：{error}': 'Failed to extract the recognition library: {error}',
  没有这个语音模型: 'No such speech model',
  '语音识别库没有这台电脑（{platform}）的版本':
    'The speech recognition library has no build for this computer ({platform})',
  '还有下载在进行：{step}': 'Another download is in progress: {step}',
  准备下载: 'Preparing download',
  '这个模型正在下载，先取消再删除': 'This model is downloading. Cancel it before deleting',
  '加载语音识别库失败：{error}': 'Failed to load the speech recognition library: {error}',
  '语音输入没有打开，请到设置 → 语音输入里打开': 'Voice input is off. Turn it on in Settings → Voice input',
  '还没有下载 {name}，请到设置 → 语音输入里下载': "{name} isn't downloaded yet. Download it in Settings → Voice input",
  没有收到录音: 'No recording received',
  '录音太长了，一次最多两分钟': 'The recording is too long; two minutes at most',
}
