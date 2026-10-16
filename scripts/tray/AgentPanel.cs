// Agent 面板的 Windows 启动程序：没有窗口，只在任务栏通知区放一个图标。
// 在后台（不弹 cmd 窗口）用 Node.js 启动 server.mjs，启动完成后用默认浏览器打开面板；
// 从图标菜单退出时把服务和它启动的 CLI 一起结束。
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
        bool created;
        Mutex mutex = new Mutex(true, "Local\\AgentPanelTray_" + ((uint)dir.ToLowerInvariant().GetHashCode()).ToString("x"), out created);
        if (!created)
        {
            Tray.OpenUrl(Tray.SavedUrl(dir) ?? "http://127.0.0.1:8787");
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Tray(dir));
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
    readonly IntPtr job;
    readonly List<string> tail = new List<string>();
    Process node;
    string url;
    StreamWriter log;
    bool quitting;

    public Tray(string dir)
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
    }

    void Ready(string u)
    {
        url = u;
        openItem.Enabled = true;
        // 地址里带着访问令牌，提示文字里不显示
        int q = u.IndexOf('?');
        string text = "Agent 面板 · " + (q >= 0 ? u.Substring(0, q) : u);
        icon.Text = text.Length > 63 ? text.Substring(0, 63) : text;
        try { File.WriteAllText(Path.Combine(dir, ".agent-panel-url"), u); } catch { }
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
        if (url != null) OpenUrl(url);
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

    public static string SavedUrl(string dir)
    {
        try
        {
            string u = File.ReadAllText(Path.Combine(dir, ".agent-panel-url")).Trim();
            return u.StartsWith("http://127.0.0.1:") ? u : null;
        }
        catch
        {
            return null;
        }
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
        try { File.Delete(Path.Combine(dir, ".agent-panel-url")); } catch { }
        if (log != null) try { log.Dispose(); } catch { }
        ExitThread();
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
