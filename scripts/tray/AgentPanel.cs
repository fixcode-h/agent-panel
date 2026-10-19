// Agent 面板的 Windows 启动程序：没有窗口，只在任务栏通知区放一个图标。
// 在后台（不弹 cmd 窗口）用 Node.js 启动 server.mjs，启动完成后用默认浏览器打开面板；
// 从图标菜单退出时把服务和它启动的 CLI 一起结束。
// 点图标时切到已经打开的面板标签页（找不到才打开新的），右键菜单有「设置」「检查更新」。
// 用 .NET Framework 自带的 csc 编译（只支持 C# 5 语法），见 .github/workflows/ci.yml。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

[assembly: AssemblyTitle("Agent 面板")]
[assembly: AssemblyProduct("Agent 面板")]
[assembly: AssemblyDescription("在本机调度编码 CLI 的网页控制台")]

static class Program
{
    [STAThread]
    static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        // 同一个目录只运行一个：再次双击时直接打开已经在运行的面板
        string id = ((uint)dir.ToLowerInvariant().GetHashCode()).ToString("x");
        bool created;
        Mutex mutex = new Mutex(true, "Local\\AgentPanelTray_" + id, out created);
        // 再次双击时通知正在运行的那个：由它切到已经打开的面板
        var show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AgentPanelTrayShow_" + id);
        if (!created)
        {
            show.Set();
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Tray(dir, show));
        GC.KeepAlive(mutex);
    }
}

class Tray : ApplicationContext
{
    // 服务要求重启（例如在设置里切换了版本）时用这个退出码
    const int RestartCode = 75;

    readonly string dir;
    readonly NotifyIcon icon;
    readonly Control ui;
    readonly ToolStripMenuItem openItem;
    readonly ToolStripMenuItem settingsItem;
    readonly ToolStripMenuItem updateItem;
    // 正在等服务回答的「切到面板」请求：标记 → 要打开的界面（null 表示只切过去）
    readonly Dictionary<string, string> focusing = new Dictionary<string, string>();
    readonly Random random = new Random();
    readonly IntPtr job;
    readonly List<string> tail = new List<string>();
    Process node;
    string url;
    StreamWriter log;
    bool quitting;

    public Tray(string dir, EventWaitHandle show)
    {
        this.dir = dir;
        ui = new Control();
        // 取一次句柄才会真正创建窗口句柄，之后才能用 BeginInvoke 回到界面线程
        IntPtr handle = ui.Handle;

        var menu = new ContextMenuStrip();
        openItem = new ToolStripMenuItem("打开 Agent 面板", null, delegate { Open(); });
        openItem.Font = new Font(openItem.Font, FontStyle.Bold);
        openItem.Enabled = false;
        menu.Items.Add(openItem);
        settingsItem = new ToolStripMenuItem("设置", null, delegate { Show("settings"); });
        settingsItem.Enabled = false;
        menu.Items.Add(settingsItem);
        // 和设置页里的检查更新是两回事：这里有新版本就直接下载安装，结果用通知告诉你
        updateItem = new ToolStripMenuItem("检查更新", null, delegate { CheckUpdate(); });
        updateItem.Enabled = false;
        menu.Items.Add(updateItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("查看运行日志", null, delegate { ShellOpen(LogPath); }));
        menu.Items.Add(new ToolStripMenuItem("打开程序目录", null, delegate { ShellOpen(dir); }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("退出", null, delegate { Quit(); }));

        icon = new NotifyIcon();
        icon.Icon = AppIcon();
        icon.Text = "Agent 面板 · 正在启动…";
        icon.ContextMenuStrip = menu;
        icon.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Open(); };
        icon.Visible = true;

        var waiter = new Thread(delegate()
        {
            while (true)
            {
                show.WaitOne();
                try { ui.BeginInvoke(new Action(Open)); } catch { return; }
            }
        });
        waiter.IsBackground = true;
        waiter.Start();

        // 服务和它启动的 CLI 都放进一个作业对象：这个程序退出（包括被结束进程）时系统会把它们一起结束
        job = Native.CreateKillOnCloseJob();
        // 等消息循环跑起来再启动，出错时 ExitThread 才能正常结束程序
        ui.BeginInvoke(new Action(Init));
    }

    void Init()
    {
        string nodePath = FindNode();
        if (nodePath == null)
        {
            if (MessageBox.Show("没有找到 Node.js。Agent 面板需要 Node.js 20 或更新的版本。\n\n要打开 Node.js 的下载页面吗？",
                    "Agent 面板", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                OpenUrl("https://nodejs.org/zh-cn/download");
            Exit();
            return;
        }
        int major = NodeMajor(nodePath);
        if (major > 0 && major < 20)
        {
            if (MessageBox.Show("找到的 Node.js 版本太旧（v" + major + "），Agent 面板需要 Node.js 20 或更新的版本。\n\n要打开 Node.js 的下载页面吗？",
                    "Agent 面板", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                OpenUrl("https://nodejs.org/zh-cn/download");
            Exit();
            return;
        }
        if (!File.Exists(Path.Combine(dir, "server.mjs")))
        {
            MessageBox.Show("程序目录里缺少 server.mjs，请重新下载完整的安装包并解压。", "Agent 面板",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            Exit();
            return;
        }
        Start(nodePath, false);
    }

    string LogPath { get { return Path.Combine(dir, "agent-panel.log"); } }

    static Icon AppIcon()
    {
        try
        {
            using (var big = Icon.ExtractAssociatedIcon(Application.ExecutablePath))
                return new Icon(big, SystemInformation.SmallIconSize);
        }
        catch
        {
            return SystemIcons.Application;
        }
    }

    /** 先找 PATH，再找默认安装位置 */
    static string FindNode()
    {
        var dirs = new List<string>((Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'));
        dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
        dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs\\nodejs"));
        foreach (string d in dirs)
        {
            string p = d.Trim().Trim('"');
            if (p.Length == 0) continue;
            try
            {
                string f = Path.Combine(p, "node.exe");
                if (File.Exists(f)) return f;
            }
            catch { }
        }
        return null;
    }

    /** Node.js 的主版本号；读不出来时返回 0，照常启动，由服务自己报错 */
    static int NodeMajor(string nodePath)
    {
        try
        {
            var psi = new ProcessStartInfo(nodePath, "-p process.versions.node.split('.')[0]");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            using (var p = Process.Start(psi))
            {
                string o = p.StandardOutput.ReadToEnd();
                if (!p.WaitForExit(10000)) return 0;
                int v;
                return int.TryParse(o.Trim(), out v) ? v : 0;
            }
        }
        catch
        {
            return 0;
        }
    }

    void Start(string nodePath, bool restarted)
    {
        try
        {
            if (log == null)
            {
                log = new StreamWriter(LogPath, false, new UTF8Encoding(false));
                log.AutoFlush = true;
            }
        }
        catch
        {
            log = null;
        }
        var psi = new ProcessStartInfo(nodePath, "server.mjs --prod");
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        psi.EnvironmentVariables["AGENT_PANEL_TRAY"] = "1";
        if (restarted) psi.EnvironmentVariables["AGENT_PANEL_RESTARTED"] = "1";
        else psi.EnvironmentVariables.Remove("AGENT_PANEL_RESTARTED");

        var p = new Process();
        p.StartInfo = psi;
        p.EnableRaisingEvents = true;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { OnLine(e.Data, false); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { OnLine(e.Data, true); };
        p.Exited += delegate { ui.BeginInvoke(new Action(delegate { OnExit(p, nodePath); })); };
        try
        {
            p.Start();
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动服务失败：" + ex.Message, "Agent 面板", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Exit();
            return;
        }
        if (job != IntPtr.Zero) Native.AssignProcessToJobObject(job, p.Handle);
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        node = p;
    }

    void OnLine(string line, bool err)
    {
        if (line == null) return;
        lock (tail)
        {
            if (log != null) try { log.WriteLine(line); } catch { }
            if (err)
            {
                tail.Add(line);
                if (tail.Count > 8) tail.RemoveAt(0);
            }
        }
        // 服务启动完成后输出的约定行：地址，以及要不要打开浏览器（设置里可以关掉）
        if (line.StartsWith("AGENT_PANEL_READY "))
        {
            string u = line.Substring(18).Trim();
            ui.BeginInvoke(new Action(delegate { Ready(u); }));
        }
        else if (line.StartsWith("AGENT_PANEL_OPEN "))
        {
            string u = line.Substring(17).Trim();
            ui.BeginInvoke(new Action(delegate { OpenUrl(u); }));
        }
        // 「切到面板」的回答：标记、有几个页面开着
        else if (line.StartsWith("AGENT_PANEL_FOCUS "))
        {
            string[] parts = line.Substring(18).Trim().Split(' ');
            int pages;
            if (parts.Length == 2 && int.TryParse(parts[1], out pages))
                ui.BeginInvoke(new Action(delegate { Focused(parts[0], pages); }));
        }
        // 「检查更新」的进度和结果：状态、要显示的话
        else if (line.StartsWith("AGENT_PANEL_UPDATE "))
        {
            string rest = line.Substring(19).Trim();
            int sp = rest.IndexOf(' ');
            string state = sp < 0 ? rest : rest.Substring(0, sp);
            string text = sp < 0 ? "" : rest.Substring(sp + 1);
            ui.BeginInvoke(new Action(delegate { UpdateProgress(state, text); }));
        }
    }

    void Ready(string u)
    {
        url = u;
        openItem.Enabled = true;
        settingsItem.Enabled = true;
        updateItem.Enabled = true;
        updateItem.Text = "检查更新";
        // 地址里带着访问令牌，提示文字里不显示
        int q = u.IndexOf('?');
        string text = "Agent 面板 · " + (q >= 0 ? u.Substring(0, q) : u);
        icon.Text = text.Length > 63 ? text.Substring(0, 63) : text;
    }

    void OnExit(Process p, string nodePath)
    {
        if (p != node) return;
        int code = 0;
        try { code = p.ExitCode; } catch { }
        node = null;
        if (quitting) { Exit(); return; }
        if (code == RestartCode)
        {
            icon.Text = "Agent 面板 · 正在重启…";
            Start(nodePath, true);
            return;
        }
        openItem.Enabled = false;
        settingsItem.Enabled = false;
        updateItem.Enabled = false;
        icon.Text = "Agent 面板 · 已停止";
        string detail;
        lock (tail) detail = string.Join("\n", tail.ToArray()).Trim();
        if (detail.Length == 0) detail = "退出码 " + code;
        var answer = MessageBox.Show("Agent 面板的服务停止了：\n\n" + detail + "\n\n要重新启动吗？", "Agent 面板",
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (answer == DialogResult.Yes) Start(nodePath, false);
        else Exit();
    }

    void Open()
    {
        Show(null);
    }

    /** 往服务的输入写一行命令；服务没在运行时返回 false */
    bool Send(string command)
    {
        var p = node;
        if (p == null) return false;
        try
        {
            p.StandardInput.WriteLine(command);
            p.StandardInput.Flush();
            return true;
        }
        catch
        {
            return false;
        }
    }

    /**
     * 切到已经打开的面板（view 为 settings 时再打开设置）：浏览器不让外面的程序切换标签页，
     * 所以先让服务通知打开着的页面把标题加上一个标记，再按标题找到那个标签页切过去；没有打开的页面或找不到时打开新的
     */
    void Show(string view)
    {
        if (url == null) return;
        string mark = "ap" + random.Next(0x100000, 0xffffff).ToString("x");
        if (!Send("focus " + mark + (view != null ? " " + view : "")))
        {
            OpenUrl(WithView(url, view));
            return;
        }
        focusing[mark] = view;
        // 服务一直没回答（卡住了）也不能没反应
        var timer = new System.Windows.Forms.Timer();
        timer.Interval = 2000;
        timer.Tick += delegate
        {
            timer.Stop();
            timer.Dispose();
            if (focusing.ContainsKey(mark)) Focused(mark, 0);
        };
        timer.Start();
    }

    void Focused(string mark, int pages)
    {
        string view;
        if (!focusing.TryGetValue(mark, out view)) return;
        focusing.Remove(mark);
        if (pages <= 0 || url == null)
        {
            if (url != null) OpenUrl(WithView(url, view));
            return;
        }
        string u = url;
        // 找窗口和标签页要一点时间，放到后台线程，不卡住托盘菜单
        var t = new Thread(delegate()
        {
            bool ok = false;
            try { ok = Browser.Activate(mark, 2500); } catch { }
            if (!ok) try { ui.BeginInvoke(new Action(delegate { OpenUrl(WithView(u, view)); })); } catch { }
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.MTA);
        t.Start();
    }

    /** 打开新页面时要直接打开的界面，页面读到 open 参数后会从地址里去掉 */
    static string WithView(string u, string view)
    {
        if (view == null) return u;
        return u + (u.IndexOf('?') >= 0 ? "&" : "?") + "open=" + view;
    }

    void CheckUpdate()
    {
        if (!Send("update"))
        {
            icon.ShowBalloonTip(5000, "Agent 面板", "服务没有在运行，不能检查更新", ToolTipIcon.Warning);
            return;
        }
        updateItem.Enabled = false;
        updateItem.Text = "正在检查更新…";
    }

    void UpdateProgress(string state, string text)
    {
        if (state == "checking") return;
        if (state == "downloading")
        {
            updateItem.Text = "正在下载更新…";
            icon.ShowBalloonTip(5000, "Agent 面板", text, ToolTipIcon.Info);
            return;
        }
        // 装好后服务会重启，重新就绪时菜单再恢复
        if (state != "done")
        {
            updateItem.Enabled = node != null;
            updateItem.Text = "检查更新";
        }
        icon.ShowBalloonTip(8000, "Agent 面板", text,
            state == "failed" ? ToolTipIcon.Error : state == "busy" ? ToolTipIcon.Warning : ToolTipIcon.Info);
    }

    public static void OpenUrl(string u)
    {
        ShellOpen(u);
    }

    static void ShellOpen(string target)
    {
        try
        {
            var psi = new ProcessStartInfo(target);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch { }
    }

    /** 退出：先让服务自己收尾（关掉它的输入，服务会停止任务、保存数据后退出），等一会儿还没退就强制结束 */
    void Quit()
    {
        quitting = true;
        icon.Text = "Agent 面板 · 正在退出…";
        var p = node;
        if (p == null) { Exit(); return; }
        try { p.StandardInput.Close(); } catch { }
        var timer = new System.Windows.Forms.Timer();
        timer.Interval = 4000;
        timer.Tick += delegate { timer.Stop(); Exit(); };
        timer.Start();
    }

    void Exit()
    {
        icon.Visible = false;
        icon.Dispose();
        // 关掉作业对象，服务和 CLI 一起结束
        if (job != IntPtr.Zero) Native.CloseHandle(job);
        if (log != null) try { log.Dispose(); } catch { }
        ExitThread();
    }
}

/** 在浏览器里找到标题带着标记的面板标签页，切过去并把窗口放到前台 */
static class Browser
{
    public static bool Activate(string mark, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        // 页面收到通知、改好标题要一小会儿
        Thread.Sleep(150);
        while (true)
        {
            // 标签页正好是窗口里当前的那个：窗口标题里就有标记
            IntPtr hwnd = Native.FindWindowByTitle(mark);
            if (hwnd != IntPtr.Zero)
            {
                Native.Activate(hwnd);
                return true;
            }
            // 不是当前标签页：用 UI 自动化在浏览器的标签栏里找（Chrome、Edge、Firefox 的标签都是 TabItem）
            hwnd = SelectTab(mark);
            if (hwnd != IntPtr.Zero)
            {
                Native.Activate(hwnd);
                return true;
            }
            if (sw.ElapsedMilliseconds > timeoutMs) return false;
            Thread.Sleep(250);
        }
    }

    static IntPtr SelectTab(string mark)
    {
        foreach (IntPtr hwnd in Native.BrowserWindows())
        {
            AutomationElement win;
            try { win = AutomationElement.FromHandle(hwnd); }
            catch { continue; }
            AutomationElement tab = FindTab(win, mark, 0);
            if (tab == null) continue;
            object p;
            if (tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) ((SelectionItemPattern)p).Select();
            else if (tab.TryGetCurrentPattern(InvokePattern.Pattern, out p)) ((InvokePattern)p).Invoke();
            else continue;
            return hwnd;
        }
        return IntPtr.Zero;
    }

    /** 只在浏览器自己的界面里找，不进网页内容：进去既慢，还会让浏览器为整个网页打开无障碍支持 */
    static AutomationElement FindTab(AutomationElement el, string mark, int depth)
    {
        if (depth > 14) return null;
        var walker = TreeWalker.ControlViewWalker;
        AutomationElement child;
        try { child = walker.GetFirstChild(el); }
        catch { return null; }
        while (child != null)
        {
            try
            {
                var type = child.Current.ControlType;
                if (type == ControlType.TabItem)
                {
                    string name = child.Current.Name ?? "";
                    if (name.Contains(mark)) return child;
                }
                else if (type != ControlType.Document)
                {
                    var found = FindTab(child, mark, depth + 1);
                    if (found != null) return found;
                }
                child = walker.GetNextSibling(child);
            }
            catch
            {
                return null;
            }
        }
        return null;
    }
}

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int cmd);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    static List<IntPtr> TopWindows()
    {
        var list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    static string Text(IntPtr hwnd, bool className)
    {
        var sb = new StringBuilder(512);
        if (className) GetClassName(hwnd, sb, sb.Capacity);
        else GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static IntPtr FindWindowByTitle(string mark)
    {
        foreach (IntPtr h in TopWindows())
            if (Text(h, false).Contains(mark)) return h;
        return IntPtr.Zero;
    }

    /** 浏览器的主窗口：Chromium 系（Chrome、Edge 等）和 Firefox */
    public static List<IntPtr> BrowserWindows()
    {
        var list = new List<IntPtr>();
        foreach (IntPtr h in TopWindows())
        {
            string c = Text(h, true);
            if ((c == "Chrome_WidgetWin_1" || c == "MozillaWindowClass") && Text(h, false).Length > 0) list.Add(h);
        }
        return list;
    }

    /** 把窗口放到前台；系统不让时按一下 Alt 再试（常见的做法，让系统认为这是用户的操作） */
    public static void Activate(IntPtr hwnd)
    {
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        if (SetForegroundWindow(hwnd) && GetForegroundWindow() == hwnd) return;
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(hwnd);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint length);

    [DllImport("kernel32.dll")]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return job;
        var info = new ExtendedLimit();
        info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimit))))
        {
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }
}
