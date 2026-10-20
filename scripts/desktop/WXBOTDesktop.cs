using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Runtime.InteropServices;

/// <summary>
/// WXBOT 桌面版（单 exe，WinForms）：不经过浏览器，窗口内查看会话/消息/状态。
/// 后台服务（reader/bridge/adapter/console）仍由 supervisor 管理；本程序只通过本机 HTTP API 读取。
/// 控制台端口从 config/app.json 的 ports.console 读取（默认 3210）。
/// </summary>
internal static class Program
{
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll")]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll")]
    private static extern uint GetConsoleProcessList(uint[] processList, uint processCount);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0)
        {
            string action = args[0].Trim().ToLowerInvariant();
            if (action == "--selftest")
            {
                return SelfTest();
            }
            if (action == "--start" || action == "--stop" || action == "--status")
            {
                return RunManageCli(action == "--start" ? "start" : (action == "--stop" ? "stop" : "status"));
            }
            if (action == "--help" || action == "/?")
            {
                Console.WriteLine("用法：WXBOT.exe [--start|--stop|--status|--settings|--selftest]");
                Console.WriteLine("  无参数      打开桌面窗口");
                Console.WriteLine("  --start     启动后台服务（不打开窗口）");
                Console.WriteLine("  --stop      停止后台服务");
                Console.WriteLine("  --status    查看服务状态");
                Console.WriteLine("  --settings  直接打开设置窗口");
                Console.WriteLine("  --selftest  自检（配置/端口/API/会话数）");
                return 0;
            }
            if (action == "--settings")
            {
                ReleasePrivateConsole();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.AddMessageFilter(WheelRouter.Instance);
                int tab = 0;
                if (args.Length > 1) { int.TryParse(args[1], out tab); }
                Application.Run(new MainForm(true, tab));
                return 0;
            }
            if (action == "--settings-selftest")
            {
                try
                {
                    Console.WriteLine(SettingsPanel.SelfTest(AppPaths.FindRoot()));
                    return 0;
                }
                catch (Exception error)
                {
                    Console.WriteLine("SETTINGS_SELFTEST_FAILED: " + error.Message);
                    return 1;
                }
            }
            if (action == "--settings-apply")
            {
                try
                {
                    using (SettingsPanel panel = new SettingsPanel(AppPaths.FindRoot()))
                    {
                        Console.WriteLine(panel.ApplyToDisk());
                    }
                    return 0;
                }
                catch (Exception error)
                {
                    Console.WriteLine("SETTINGS_APPLY_FAILED: " + error.Message);
                    return 1;
                }
            }
        }
        try { SetProcessDPIAware(); } catch { }
        // console 子系统 exe：双击/无父控制台时，销毁本进程私有控制台，避免残留 conhost 窗口。
        ReleasePrivateConsole();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.AddMessageFilter(WheelRouter.Instance);
        try
        {
            Application.Run(new MainForm());
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show("WXBOT 启动失败：\n" + error, "WXBOT", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    /// <summary>
    /// 仅当当前控制台属于本进程（没有父控制台可共享）时销毁它，避免双击启动后残留
    /// PseudoConsoleWindow / conhost.exe；从 PowerShell 等终端启动时保留父控制台，CLI 输出不受影响。
    /// </summary>
    private static void ReleasePrivateConsole()
    {
        try
        {
            uint[] processList = new uint[8];
            uint count = GetConsoleProcessList(processList, (uint)processList.Length);
            if (count <= 1)
            {
                FreeConsole();
            }
        }
        catch { }
    }

    private static int RunManageCli(string action)
    {
        string root = AppPaths.FindRoot();
        ProcessStartInfo info = new ProcessStartInfo("powershell.exe",
            "-NoProfile -ExecutionPolicy Bypass -File \"scripts\\manage.ps1\" " + action)
        {
            WorkingDirectory = root,
            UseShellExecute = false,
        };
        using (Process process = Process.Start(info))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static int SelfTest()
    {
        try
        {
            string root = AppPaths.FindRoot();
            ApiClient api = new ApiClient(root);
            var meta = api.GetJson("/api/meta");
            Console.WriteLine("root=" + root);
            Console.WriteLine("api=" + api.BaseUrl);
            Console.WriteLine("meta_ok=" + (meta != null && meta.ContainsKey("success")));
            var sessions = api.GetJson("/api/sessions?limit=5");
            Console.WriteLine("sessions=" + (sessions != null && sessions.ContainsKey("sessions")
                ? ((object[])sessions["sessions"]).Length : 0));
            var serialized = new JavaScriptSerializer().Serialize(meta != null && meta.ContainsKey("ports") ? meta["ports"] : null);
            Console.WriteLine("ports=" + serialized);
            return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine("SELFTEST_FAILED: " + error.Message);
            return 1;
        }
    }
}

/// <summary>项目路径与配置发现。</summary>
internal static class AppPaths
{
    public static string FindRoot()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        if (File.Exists(Path.Combine(baseDir, "scripts", "manage.ps1"))) { return baseDir; }
        DirectoryInfo parent = Directory.GetParent(baseDir);
        if (parent != null && File.Exists(Path.Combine(parent.FullName, "scripts", "manage.ps1"))) { return parent.FullName; }
        return baseDir;
    }
}

/// <summary>本机控制台 API 客户端（x-console-token）。</summary>
internal sealed class ApiClient
{
    private readonly string root;
    private readonly JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    public string BaseUrl { get; private set; }
    public int ConsolePort { get; private set; }
    public string HookBaseUrl { get; private set; }
    public string ExpectedHookVersion { get; private set; }
    public string WeChatExecutable { get; private set; }
    public string AccountDirectory { get; private set; }
    public bool AllowCoexist { get; private set; }
    private string token;
    private string hookToken;

    public ApiClient(string root)
    {
        this.root = root;
        int port = 3210;
        try
        {
            string config = File.ReadAllText(Path.Combine(root, "config", "app.json"));
            Match match = Regex.Match(config, "\"console\"\\s*:\\s*(\\d+)");
            if (match.Success) { port = int.Parse(match.Groups[1].Value); }
        }
        catch { }
        ConsolePort = port;
        BaseUrl = "http://127.0.0.1:" + port;
        HookBaseUrl = "http://127.0.0.1:30001";
        ExpectedHookVersion = "4.1.10.27";
        WeChatExecutable = Path.Combine(root, "state", "wechat-hook-client", "Weixin.exe");
        try { token = File.ReadAllText(Path.Combine(root, "state", "tokens", "console.txt")).Trim(); }
        catch { token = string.Empty; }
        try { hookToken = File.ReadAllText(Path.Combine(root, "state", "tokens", "hook.txt")).Trim(); }
        catch { hookToken = string.Empty; }
        try
        {
            string raw = File.ReadAllText(Path.Combine(root, "config", "app.json"));
            Dictionary<string, object> cfg = serializer.DeserializeObject(raw) as Dictionary<string, object>;
            Dictionary<string, object> hook = cfg != null && cfg.ContainsKey("hook") ? cfg["hook"] as Dictionary<string, object> : null;
            Dictionary<string, object> reader = cfg != null && cfg.ContainsKey("reader") ? cfg["reader"] as Dictionary<string, object> : null;
            if (hook != null)
            {
                HookBaseUrl = GetStringValue(hook, "baseUrl", HookBaseUrl).TrimEnd('/');
                ExpectedHookVersion = GetStringValue(hook, "expectedVersion", ExpectedHookVersion);
                string exe = GetStringValue(hook, "wechatExecutable", string.Empty);
                if (exe.Length > 0)
                {
                    WeChatExecutable = Path.IsPathRooted(exe) ? exe : Path.Combine(root, exe.Replace('/', '\\'));
                }
                object allow;
                if (hook.TryGetValue("allowCoexist", out allow) && allow != null)
                {
                    try { AllowCoexist = Convert.ToBoolean(allow); } catch { }
                }
            }
            if (reader != null) { AccountDirectory = GetStringValue(reader, "accountDirectory", string.Empty); }
        }
        catch { }
    }

    private static string GetStringValue(Dictionary<string, object> dict, string key, string fallback)
    {
        object value;
        return dict != null && dict.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback;
    }

    /// <summary>直接读取 Hook 健康（微信客户端登录状态），不依赖 console 服务。</summary>
    public Dictionary<string, object> GetHookHealth()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(HookBaseUrl + "/WeChatAgent/health");
            request.Method = "GET";
            request.Timeout = 700;
            request.Headers["Authorization"] = "Bearer " + hookToken;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                return serializer.DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>;
            }
        }
        catch
        {
            return null;
        }
    }

    public Dictionary<string, object> GetJson(string path)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(BaseUrl + path);
        request.Method = "GET";
        request.Timeout = 2500;
        request.Headers["x-console-token"] = token;
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        {
            string raw = reader.ReadToEnd();
            object parsed = serializer.DeserializeObject(raw);
            return parsed as Dictionary<string, object>;
        }
    }

    public Image GetImage(string imageId)
    {
        Dictionary<string, object> body = GetJson("/api/images/" + imageId);
        if (body == null) { return null; }
        string b64 = body.ContainsKey("b64") ? Convert.ToString(body["b64"]) : string.Empty;
        if (string.IsNullOrEmpty(b64)) { return null; }
        byte[] bytes = Convert.FromBase64String(b64);
        using (MemoryStream stream = new MemoryStream(bytes))
        {
            return Image.FromStream(stream);
        }
    }

    public bool TryGetJson(string path, out Dictionary<string, object> body)
    {
        try
        {
            body = GetJson(path);
            return body != null;
        }
        catch
        {
            body = null;
            return false;
        }
    }
}

/// <summary>主窗口。</summary>
internal sealed class MainForm : Form
{
    private static readonly Color Bg = UiTheme.Bg;
    private static readonly Color PanelBg = UiTheme.PanelBg;
    private static readonly Color PanelBg2 = UiTheme.PanelBg2;
    private static readonly Color Line = UiTheme.Line;
    private static readonly Color Muted = UiTheme.Muted;
    private static readonly Color Accent = UiTheme.Accent;
    private static readonly Color Ok = UiTheme.Ok;
    private static readonly Color Warn = UiTheme.Warn;
    private static readonly Color Err = UiTheme.Err;

    private readonly string root;
    private readonly ApiClient api;
    private readonly Timer refreshTimer = new Timer();
    private readonly Timer chatTimer = new Timer();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private static readonly Font SessionInitialFont = UiTheme.MascotFont;
    private static readonly Font SessionNameFont = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);
    private static readonly Font SessionSubFont = UiTheme.SmallFont;
    private static readonly Font BubbleHeaderFont = UiTheme.SmallFont;
    private static readonly Font BubbleContentFont = new Font("Microsoft YaHei UI", 9.5F);
    private static readonly StringFormat CenterText = UiTheme.Centered;

    private readonly Dictionary<string, Image> imageCache = new Dictionary<string, Image>();
    private readonly Queue<string> imageCacheOrder = new Queue<string>();
    private const int MaxCachedImages = 64;
    private List<string> cachedWeixinPaths = new List<string>();
    private DateTime cachedWeixinAt = DateTime.MinValue;
    private string lastStatusSignature = string.Empty;
    private string lastClientVersion = string.Empty;
    private DateTime lastClientVersionAt = DateTime.MinValue;

    private FlowLayoutPanel toolbar;
    private RoundButton toggleButton;
    private Button refreshButton;
    private Button settingsButton;
    private bool showImages = true;
    private Label stateLabel;
    private Label connectionLabel;
    private Label wechatLabel;
    private RoundButton loginButton;
    private RoundButton repairButton;
    private RoundButton copyAccountButton;
    private Label loginStatusLabel;
    private Label loginHintLabel;
    private Timer loginTimer = new Timer();
    private Timer serviceWatchdog = new Timer();
    private int watchdogDownTicks;
    private Panel settingsOverlay;
    private SettingsPanel settingsPanel;
    private bool openSettingsOnLoad;
    private int settingsInitialTab;
    private TextBox sessionSearch;
    private ListBox sessionList;
    private FlowLayoutPanel chatFlow;
    private FlowLayoutPanel statusBox;
    private Label titleLabel;
    private Label subtitleLabel;
    private StatusStrip statusStrip;
    private ToolStripStatusLabel statusText;
    private ToolStripStatusLabel statusRight;
    private ToolTip toolTip;

    private Dictionary<string, object> meta;
    private List<Dictionary<string, object>> sessions = new List<Dictionary<string, object>>();
    private List<Dictionary<string, object>> visibleSessions = new List<Dictionary<string, object>>();
    private string activeTalker = string.Empty;
    private string activeName = string.Empty;
    private string lastMessagesJson = string.Empty;
    private bool busy;
    private string busyAction = string.Empty;
    private bool userStopped;
    private bool closingForCleanup;
    private bool closeRequestedAfterBusy;
    private Timer closeBusyTimer;
    private bool wechatLaunchedByApp;
    private bool launchingWeChat;
    private bool launchingRepair;
    private bool wechatWasRunning;
    private int metaFailures;
    private DateTime statusHoldUntil = DateTime.MinValue;

    public MainForm(bool openSettings = false, int settingsTab = 0)
    {
        openSettingsOnLoad = openSettings;
        settingsInitialTab = settingsTab;
        root = AppPaths.FindRoot();
        api = new ApiClient(root);
        showImages = ReadShowImagesPreference();
        Text = "WXBOT · DeepSeek 大肥鱼";
        MinimumSize = new Size(1000, 640);
        Size = new Size(1200, 780);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Bg;
        ForeColor = Color.White;
        KeyPreview = true;
        Font = UiTheme.BodyFont;
        BuildLayout();

        refreshTimer.Interval = 5000;
        refreshTimer.Tick += (s, e) =>
        {
            if (WindowState == FormWindowState.Minimized) { return; }
            if (busy || userStopped) { return; }
            if (settingsOverlay != null && settingsOverlay.Visible) { return; }
            RefreshMeta();
            RefreshSessions();
        };
        chatTimer.Interval = 3000;
        chatTimer.Tick += (s, e) =>
        {
            if (WindowState == FormWindowState.Minimized) { return; }
            if (busy || userStopped) { return; }
            if (settingsOverlay != null && settingsOverlay.Visible) { return; }
            LoadMessages(false);
        };
        loginTimer.Interval = 3000;
        loginTimer.Tick += (s, e) =>
        {
            if (WindowState == FormWindowState.Minimized || busy) { return; }
            UpdateLoginCard();
        };
        KeyDown += (s, e) =>
        {
            if (e.KeyCode == Keys.F5) { e.Handled = true; RefreshAll(); }
        };
        Load += (s, e) =>
        {
            SetSearchCue();
            if (openSettingsOnLoad) { ShowSettings(settingsInitialTab); }
            wechatWasRunning = GetWeChatProcesses().Count > 0;
            RefreshAll();
            UpdateLoginCard();
            refreshTimer.Start();
            chatTimer.Start();
            loginTimer.Start();
            serviceWatchdog.Interval = 2500;
            serviceWatchdog.Tick += (ws, we) => ServiceWatchdogTick();
            serviceWatchdog.Start();
            BeginInvoke(new Action(() =>
            {
                try { EnsureSettingsOverlay(); } catch { }
            }));
        };
        FormClosing += OnClosing;
        FormClosed += (s, e) => { refreshTimer.Stop(); chatTimer.Stop(); loginTimer.Stop(); serviceWatchdog.Stop(); };
    }

    /// <summary>关闭窗口前先停掉 supervisor 与全部后台进程，避免残留。</summary>
    private void OnClosing(object sender, FormClosingEventArgs e)
    {
        if (closingForCleanup) { return; }
        if (busy)
        {
            closeRequestedAfterBusy = true;
            e.Cancel = true;
            SetStatus("正在完成当前操作，随后关闭并清理…");
            if (closeBusyTimer == null)
            {
                closeBusyTimer = new Timer { Interval = 15000 };
                closeBusyTimer.Tick += (s, ev) =>
                {
                    try { closeBusyTimer.Stop(); } catch { }
                    if (!closingForCleanup)
                    {
                        busy = false;
                        SetStatus("操作超时，强制关闭并清理…");
                        Close();
                    }
                };
                closeBusyTimer.Start();
            }
            return;
        }
        e.Cancel = true;
        closingForCleanup = true;
        try { if (closeBusyTimer != null) { closeBusyTimer.Stop(); } } catch { }
        try { refreshTimer.Stop(); chatTimer.Stop(); serviceWatchdog.Stop(); } catch { }
        if (toggleButton != null) { toggleButton.Enabled = false; }
        SetStatus("正在关闭并清理后台进程…");
        Task.Run(() =>
        {
            try
            {
                string tail;
                int exitCode = RunManageCommand("stop", 60000, out tail);
                try
                {
                    string logDir = Path.Combine(root, "state", "logs");
                    Directory.CreateDirectory(logDir);
                    File.WriteAllText(Path.Combine(logDir, "desktop-manage.log"),
                        DateTime.Now.ToString("o") + " action=close-stop exit=" + exitCode + "\n" + tail + "\n",
                        new UTF8Encoding(false));
                }
                catch { }
            }
            catch { }
            finally
            {
                try { KillWeChatIfOwned(); } catch { }
                try { BeginInvoke(new Action(Close)); }
                catch { try { Close(); } catch { } }
            }
        });
    }

    /// <summary>读取由本程序配置的固定版微信客户端进程（按 exe 路径匹配）。</summary>
    private List<Process> GetWeChatProcesses()
    {
        List<Process> result = new List<Process>();
        if (string.IsNullOrEmpty(api.WeChatExecutable)) { return result; }
        string target;
        try { target = Path.GetFullPath(api.WeChatExecutable); }
        catch { return result; }
        Process[] all;
        try { all = Process.GetProcessesByName("Weixin"); }
        catch { return result; }
        foreach (Process process in all)
        {
            bool keep = false;
            try
            {
                string file = process.MainModule != null ? process.MainModule.FileName : string.Empty;
                if (file.Length > 0 && string.Equals(Path.GetFullPath(file), target, StringComparison.OrdinalIgnoreCase))
                {
                    result.Add(process);
                    keep = true;
                }
            }
            catch { }
            if (!keep) { try { process.Dispose(); } catch { } }
        }
        return result;
    }

    /// <summary>枚举当前 Weixin 进程的可执行路径（只读探测，3 秒缓存）。</summary>
    private List<string> ScanWeixinPaths()
    {
        List<string> paths = new List<string>();
        try
        {
            foreach (Process process in Process.GetProcessesByName("Weixin"))
            {
                try
                {
                    string file = process.MainModule != null ? process.MainModule.FileName : string.Empty;
                    if (file.Length > 0) { paths.Add(file); }
                }
                catch { }
                finally { try { process.Dispose(); } catch { } }
            }
        }
        catch { }
        return paths;
    }

    private List<string> GetCachedWeixinPaths()
    {
        if (DateTime.Now - cachedWeixinAt > TimeSpan.FromSeconds(3))
        {
            cachedWeixinPaths = ScanWeixinPaths();
            cachedWeixinAt = DateTime.Now;
        }
        return cachedWeixinPaths;
    }

    /// <summary>是否有其它微信客户端在运行（微信单实例，固定版需其退出后才能启动）。</summary>
    private bool AnyOtherWeChatRunning()
    {
        string target;
        try { target = Path.GetFullPath(api.WeChatExecutable); }
        catch { return false; }
        foreach (string file in GetCachedWeixinPaths())
        {
            if (!string.Equals(Path.GetFullPath(file), target, StringComparison.OrdinalIgnoreCase)) { return true; }
        }
        return false;
    }

    /// <summary>读取固定版客户端 exe 的文件版本（被强制更新后会与预期不符）。</summary>
    private string GetClientVersion()
    {
        if (DateTime.Now - lastClientVersionAt < TimeSpan.FromSeconds(30))
        {
            return lastClientVersion;
        }
        lastClientVersionAt = DateTime.Now;
        try
        {
            if (File.Exists(api.WeChatExecutable))
            {
                lastClientVersion = FileVersionInfo.GetVersionInfo(api.WeChatExecutable).FileVersion ?? string.Empty;
            }
        }
        catch { }
        return lastClientVersion;
    }

    /// <summary>刷新「微信登录」卡片与顶栏微信状态。</summary>
    private void UpdateLoginCard()
    {
        if (loginStatusLabel == null || loginButton == null) { return; }
        List<string> runningPaths = GetCachedWeixinPaths();
        string targetPath = string.Empty;
        try { targetPath = Path.GetFullPath(api.WeChatExecutable); } catch { }
        bool ourClientRunning = false;
        bool otherClientRunning = false;
        foreach (string file in runningPaths)
        {
            if (targetPath.Length > 0 && string.Equals(Path.GetFullPath(file), targetPath, StringComparison.OrdinalIgnoreCase))
            {
                ourClientRunning = true;
            }
            else
            {
                otherClientRunning = true;
            }
        }
        Dictionary<string, object> hook = PortOpen(30001) ? api.GetHookHealth() : null;
        bool clientRunning = ourClientRunning || hook != null;
        string hookVersion = hook != null && hook.ContainsKey("version") ? Convert.ToString(hook["version"]) : string.Empty;
        string hookState = hook != null && hook.ContainsKey("startupState") ? Convert.ToString(hook["startupState"]) : string.Empty;
        List<string> accounts = new List<string>();
        object[] accountItems = hook != null && hook.ContainsKey("databaseAccounts") ? hook["databaseAccounts"] as object[] : null;
        if (accountItems != null)
        {
            foreach (object item in accountItems)
            {
                string account = Convert.ToString(item);
                if (!string.IsNullOrEmpty(account)) { accounts.Add(account); }
            }
        }
        bool accountMatches = false;
        foreach (string account in accounts)
        {
            if (!string.IsNullOrEmpty(api.AccountDirectory) && string.Equals(account, api.AccountDirectory, StringComparison.OrdinalIgnoreCase))
            {
                accountMatches = true;
            }
        }
        bool loggedIn = false;
        string clientVersion = GetClientVersion();
        bool versionMismatch = clientVersion.Length > 0
            && api.ExpectedHookVersion.Length > 0
            && !string.Equals(clientVersion, api.ExpectedHookVersion, StringComparison.OrdinalIgnoreCase);
        bool otherWeChat = !clientRunning && otherClientRunning;
        string status;
        Color color;
        string hint;
        string buttonText;
        if (versionMismatch)
        {
            status = "客户端版本不符（被自动更新）";
            color = Err;
            hint = "当前 " + clientVersion + "，Hook 需要 " + api.ExpectedHookVersion
                + "；已阻止后续自动更新，请运行 scripts\\restore-wechat-client.ps1 恢复固定版。";
            buttonText = "启动微信并登录";
        }
        else if (!clientRunning && hook == null && otherWeChat && !api.AllowCoexist)
        {
            status = "检测到其它微信在运行";
            color = Warn;
            hint = "微信为单实例：启动固定版前请先退出其它微信；固定版运行期间其它微信不能同时运行。";
            buttonText = "启动微信并登录";
        }
        else if (!clientRunning && hook == null)
        {
            status = "未检测到固定版微信客户端";
            color = Muted;
            hint = api.AllowCoexist
                ? "已启用共存补丁：可直接启动固定版微信，与你自己的微信同时运行。"
                : "点下方按钮启动固定版微信，然后扫码/手机确认登录（微信单实例，需先退出其它微信）。";
            buttonText = "启动微信并登录";
        }
        else if (hook == null)
        {
            status = "微信已启动，等待 Hook 就绪…";
            color = Warn;
            hint = "请确认是固定版本 " + api.ExpectedHookVersion + " 客户端；Hook 端口 " + api.HookBaseUrl;
            buttonText = "打开微信窗口";
        }
        else if (hookState != "ready")
        {
            status = "微信已启动，Hook 初始化中…";
            color = Warn;
            hint = "startupState=" + hookState + "，请稍候…";
            buttonText = "打开微信窗口";
        }
        else if (accounts.Count == 0)
        {
            status = "等待扫码登录…";
            color = Warn;
            hint = "请在打开的微信窗口完成扫码/手机确认。";
            buttonText = "打开微信窗口";
        }
        else if (api.ExpectedHookVersion.Length > 0 && hookVersion.Length > 0
            && !string.Equals(hookVersion, api.ExpectedHookVersion, StringComparison.OrdinalIgnoreCase))
        {
            status = "已登录，但 Hook 版本不符";
            color = Err;
            hint = "Hook=" + hookVersion + "，期望=" + api.ExpectedHookVersion;
            buttonText = "打开微信窗口";
        }
        else if (!string.IsNullOrEmpty(api.AccountDirectory) && !accountMatches)
        {
            status = "登录账号与配置不一致";
            color = Err;
            hint = "登录=" + accounts[0] + "，配置=" + api.AccountDirectory;
            buttonText = "打开微信窗口";
        }
        else
        {
            loggedIn = true;
            status = "已登录：" + accounts[0];
            color = Ok;
            hint = "微信登录完成，后台可正常收发；关闭程序时会一并退出该微信。";
            buttonText = "打开微信窗口";
        }
        string buttonTextFinal = launchingWeChat ? "正在启动微信…" : buttonText;
        string repairText = launchingRepair ? "正在恢复固定版…" : "恢复固定版客户端";
        string wechatText = "● 微信" + (loggedIn ? "已登录" : (versionMismatch ? "版本异常" : (clientRunning ? "等待登录" : "未启动")));
        Color wechatColor = loggedIn ? Ok : (versionMismatch ? Err : (clientRunning ? Warn : Muted));
        if (loginStatusLabel.Text != status) { loginStatusLabel.Text = status; }
        if (loginStatusLabel.ForeColor != color) { loginStatusLabel.ForeColor = color; }
        if (loginHintLabel.Text != hint) { loginHintLabel.Text = hint; }
        if (loginButton.Text != buttonTextFinal) { loginButton.Text = buttonTextFinal; }
        loginButton.Enabled = !launchingWeChat && !versionMismatch;
        loginButton.Visible = !versionMismatch;
        repairButton.Visible = versionMismatch;
        if (repairButton.Text != repairText) { repairButton.Text = repairText; }
        repairButton.Enabled = !launchingRepair;
        if (wechatLabel.Text != wechatText) { wechatLabel.Text = wechatText; }
        if (wechatLabel.ForeColor != wechatColor) { wechatLabel.ForeColor = wechatColor; }
    }

    /// <summary>「启动微信并登录」按钮：启动固定版客户端，或把已在运行的客户端窗口提到前台。</summary>
    private void StartWeChatLogin()
    {
        if (launchingWeChat) { return; }
        string clientVersion = GetClientVersion();
        if (clientVersion.Length > 0 && api.ExpectedHookVersion.Length > 0
            && !string.Equals(clientVersion, api.ExpectedHookVersion, StringComparison.OrdinalIgnoreCase))
        {
            loginHintLabel.Text = "客户端已被更新为 " + clientVersion + "，Hook 需要 " + api.ExpectedHookVersion
                + "；请先运行 scripts\\restore-wechat-client.ps1 恢复固定版。";
            loginHintLabel.ForeColor = Err;
            SetStatus("微信客户端版本不符：请恢复固定版客户端");
            return;
        }
        List<Process> running = GetWeChatProcesses();
        if (running.Count > 0)
        {
            BringWeChatToFront(running[0]);
            foreach (Process process in running) { try { process.Dispose(); } catch { } }
            UpdateLoginCard();
            return;
        }
        if (!api.AllowCoexist && AnyOtherWeChatRunning())
        {
            loginHintLabel.Text = "微信为单实例：请先退出其它微信，再点「启动微信并登录」；登录后可重新打开其它微信。";
            loginHintLabel.ForeColor = Warn;
            SetStatus("检测到其它微信在运行，已提示先退出（微信单实例限制）");
            return;
        }
        launchingWeChat = true;
        loginButton.Enabled = false;
        loginButton.Text = "正在启动微信…";
        loginHintLabel.Text = "正在启动固定版微信（可能需要几秒）…";
        loginHintLabel.ForeColor = Muted;
        Task.Run(() =>
        {
            int exitCode = 1;
            string outputText = string.Empty;
            try
            {
                ProcessStartInfo info = new ProcessStartInfo("powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -File \"scripts\\launch-hook-wechat.ps1\"")
                {
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using (Process process = Process.Start(info))
                {
                    string stdout = process.StandardOutput.ReadToEnd();
                    string stderr = process.StandardError.ReadToEnd();
                    process.WaitForExit(120000);
                    exitCode = process.ExitCode;
                    outputText = (stdout + "\n" + stderr).Trim();
                }
            }
            catch (Exception error)
            {
                outputText = error.Message;
            }
            try
            {
                BeginInvoke(new Action(() =>
                {
                    launchingWeChat = false;
                    List<Process> started = GetWeChatProcesses();
                    if (started.Count > 0)
                    {
                        wechatLaunchedByApp = true;
                        BringWeChatToFront(started[0]);
                        foreach (Process process in started) { try { process.Dispose(); } catch { } }
                    }
                    if (exitCode != 0 && started.Count == 0)
                    {
                        if (outputText.Contains("其他微信") || outputText.Contains("WECHAT_OTHER_INSTANCE_RUNNING") || outputText.Contains("单实例"))
                        {
                            loginHintLabel.Text = "未能启动固定版微信：检测到其它微信在运行（微信单实例限制）。请先退出其它微信后重试。";
                            loginHintLabel.ForeColor = Warn;
                            SetStatus("微信单实例限制：请先退出其它微信");
                        }
                        else
                        {
                            loginHintLabel.Text = "启动微信失败：" + TruncateText(outputText, 180);
                            loginHintLabel.ForeColor = Err;
                            SetStatus("微信启动失败（详见登录卡片）");
                        }
                    }
                    UpdateLoginCard();
                }));
            }
            catch { }
        });
    }

    private void BringWeChatToFront(Process process)
    {
        try
        {
            process.Refresh();
            for (int i = 0; i < 10 && process.MainWindowHandle == IntPtr.Zero; i++)
            {
                System.Threading.Thread.Sleep(200);
                process.Refresh();
            }
            IntPtr handle = process.MainWindowHandle;
            if (handle != IntPtr.Zero)
            {
                ShowWindow(handle, 9);
                SetForegroundWindow(handle);
            }
        }
        catch { }
    }

    /// <summary>客户端被强制升级后，从本地备份恢复固定版（内联执行，不弹窗）。</summary>
    private void RestoreWeChatClient()
    {
        if (launchingRepair) { return; }
        launchingRepair = true;
        UpdateLoginCard();
        loginHintLabel.Text = "正在从备份恢复固定版客户端…";
        loginHintLabel.ForeColor = Muted;
        Task.Run(() =>
        {
            int exitCode = 1;
            string output = string.Empty;
            try
            {
                ProcessStartInfo info = new ProcessStartInfo("powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -File \"scripts\\restore-wechat-client.ps1\"")
                {
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using (Process process = Process.Start(info))
                {
                    string stdout = process.StandardOutput.ReadToEnd();
                    string stderr = process.StandardError.ReadToEnd();
                    process.WaitForExit(300000);
                    exitCode = process.ExitCode;
                    output = (stdout + "\n" + stderr).Trim();
                }
            }
            catch (Exception error)
            {
                output = error.Message;
            }
            try
            {
                BeginInvoke(new Action(() =>
                {
                    launchingRepair = false;
                    if (exitCode == 0)
                    {
                        loginHintLabel.Text = "固定版客户端已恢复，请点「启动微信并登录」并扫码。";
                        loginHintLabel.ForeColor = Ok;
                        SetStatus("固定版客户端已恢复（4.1.10.27）");
                    }
                    else
                    {
                        loginHintLabel.Text = "恢复失败：" + TruncateText(output, 200);
                        loginHintLabel.ForeColor = Err;
                        SetStatus("恢复固定版客户端失败（详见登录卡片）");
                    }
                    UpdateLoginCard();
                }));
            }
            catch { }
        });
    }

    /// <summary>关闭程序时，如果微信是由本程序拉起的，则一并退出（外部自己开的微信不动）。</summary>
    private void KillWeChatIfOwned()
    {
        if (!wechatLaunchedByApp) { return; }
        List<Process> remaining = GetWeChatProcesses();
        foreach (Process process in remaining)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo("taskkill.exe", "/PID " + process.Id + " /T /F")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using (Process killer = Process.Start(info)) { killer.WaitForExit(8000); }
            }
            catch { }
            try { process.Dispose(); } catch { }
        }
        wechatLaunchedByApp = false;
    }

    private static bool PortOpen(int port)
    {
        try
        {
            using (TcpClient client = new TcpClient())
            {
                IAsyncResult result = client.BeginConnect("127.0.0.1", port, null, null);
                bool connected = result.AsyncWaitHandle.WaitOne(120);
                if (connected) { client.EndConnect(result); }
                return connected;
            }
        }
        catch { return false; }
    }

    private static string TruncateText(string text, int maxLength)
    {
        if (string.IsNullOrEmpty(text)) { return string.Empty; }
        return text.Length <= maxLength ? text : text.Substring(text.Length - maxLength);
    }

    /// <summary>读取桌面偏好：是否在聊天区显示图片缩略图。</summary>
    private bool ReadShowImagesPreference()
    {
        try
        {
            string raw = File.ReadAllText(Path.Combine(root, "config", "app.json"));
            Dictionary<string, object> config = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }
                .DeserializeObject(raw) as Dictionary<string, object>;
            if (config == null) { return true; }
            object desktopValue;
            Dictionary<string, object> desktop = config.TryGetValue("desktop", out desktopValue)
                ? desktopValue as Dictionary<string, object> : null;
            if (desktop == null) { return true; }
            object showValue;
            if (desktop.TryGetValue("showImages", out showValue) && showValue != null)
            {
                return Convert.ToBoolean(showValue);
            }
        }
        catch { }
        return true;
    }

    /// <summary>设置保存后应用桌面偏好；变化时立即重绘聊天图片。</summary>
    private void ApplyDesktopPreferences()
    {
        bool next = ReadShowImagesPreference();
        if (next == showImages) { return; }
        showImages = next;
        lastMessagesJson = string.Empty;
        LoadMessages(true);
    }

    /// <summary>创建设置覆盖层（可提前预热，避免首次打开卡顿）。</summary>
    private void EnsureSettingsOverlay()
    {
        if (settingsOverlay != null) { return; }
        settingsOverlay = new Panel { Dock = DockStyle.Fill, BackColor = Bg, Visible = false };
        Panel header = new Panel { Dock = DockStyle.Top, Height = 52, BackColor = PanelBg, Padding = new Padding(10, 8, 10, 8) };
        WhaleMascotControl settingsMascot = new WhaleMascotControl
        {
            Size = new Size(34, 34),
            Dock = DockStyle.Left,
            ShowGlow = true,
            Simplified = true,
            BackColor = PanelBg,
        };
        Label title = new Label
        {
            Text = "  设置 · 大肥鱼调校台",
            Dock = DockStyle.Left,
            Width = 240,
            ForeColor = UiTheme.TextColor,
            Font = UiTheme.TitleFont,
            TextAlign = ContentAlignment.MiddleLeft,
        };
        header.Controls.Add(title);
        header.Controls.Add(settingsMascot);
        settingsPanel = new SettingsPanel(root, 0) { Dock = DockStyle.Fill };
        settingsPanel.Saved += (s, e) =>
        {
            bool restart = settingsPanel.RestartRequested;
            HideSettings();
            ApplyDesktopPreferences();
            SetStatus(restart ? "设置已保存，正在重启后台服务…" : "设置已保存");
            if (restart) { RunManage("restart"); }
            else { SetStatus("设置已保存，稍后自动刷新"); }
        };
        settingsPanel.Cancelled += (s, e) => HideSettings();
        settingsOverlay.Controls.Add(settingsPanel);
        settingsOverlay.Controls.Add(header);
        Controls.Add(settingsOverlay);
    }

    /// <summary>顶部工具栏「设置 / 主界面」切换。</summary>
    private void ToggleSettings()
    {
        if (settingsOverlay != null && settingsOverlay.Visible) { HideSettings(); }
        else { ShowSettings(0); }
    }

    /// <summary>在主窗口内显示设置面板（不打开新窗口）。</summary>
    private void ShowSettings(int tab)
    {
        EnsureSettingsOverlay();
        settingsPanel.ReloadFromConfig();
        settingsPanel.SelectTab(tab);
        try { refreshTimer.Stop(); chatTimer.Stop(); loginTimer.Stop(); } catch { }
        settingsOverlay.Visible = true;
        settingsOverlay.BringToFront();
        if (settingsButton != null)
        {
            settingsButton.Text = "返回";
            if (toolTip != null) { toolTip.SetToolTip(settingsButton, "返回主界面（当前在设置页）"); }
        }
    }

    private void HideSettings()
    {
        SuspendLayout();
        if (settingsOverlay != null) { settingsOverlay.Visible = false; }
        try { refreshTimer.Start(); chatTimer.Start(); loginTimer.Start(); } catch { }
        ResumeLayout(true);
        if (settingsButton != null)
        {
            settingsButton.Text = "设置";
            if (toolTip != null) { toolTip.SetToolTip(settingsButton, "设置：白名单、回复频率、AI 人格、API Key"); }
        }
        // 不在这里同步刷新（会重建气泡导致 200ms+ 卡顿）；状态由定时器/后续操作异步刷新。
    }

    private void SetSearchCue()
    {
        try
        {
            if (sessionSearch != null && sessionSearch.IsHandleCreated)
            {
                SendMessage(sessionSearch.Handle, 0x1501, (IntPtr)1, "搜索会话（名称 / wxid）");
            }
        }
        catch { }
    }

    private void BuildLayout()
    {
        toolbar = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 48,
            Padding = new Padding(10, 8, 10, 6),
            BackColor = PanelBg,
            WrapContents = false,
            AutoSize = false,
        };
        Panel brand = new Panel
        {
            Width = 196,
            Height = 38,
            BackColor = PanelBg,
            Margin = new Padding(2, 1, 12, 0),
        };
        WhaleMascotControl brandMascot = new WhaleMascotControl
        {
            Size = new Size(34, 34),
            Location = new Point(0, 2),
            ShowGlow = true,
            Simplified = true,
            BackColor = PanelBg,
        };
        Label brandTitle = new Label
        {
            Text = "WXBOT",
            AutoSize = true,
            Font = UiTheme.TitleFont,
            ForeColor = UiTheme.TextColor,
            Location = new Point(40, 0),
        };
        Label brandSub = new Label
        {
            Text = "DeepSeek 大肥鱼",
            AutoSize = true,
            Font = UiTheme.SmallFont,
            ForeColor = UiTheme.Cyan,
            Location = new Point(41, 21),
        };
        brand.Controls.Add(brandSub);
        brand.Controls.Add(brandTitle);
        brand.Controls.Add(brandMascot);
        toggleButton = MakeButton("启动服务", (s, e) => ToggleService(), true);
        refreshButton = MakeButton("刷新", (s, e) => RefreshAll());
        settingsButton = MakeButton("设置", (s, e) => ToggleSettings());
        stateLabel = new Label
        {
            AutoSize = true,
            ForeColor = Muted,
            Margin = new Padding(12, 13, 0, 0),
            Text = "● 服务已停止",
        };
        wechatLabel = new Label
        {
            AutoSize = true,
            ForeColor = Muted,
            Margin = new Padding(14, 13, 0, 0),
            Text = "● 微信未启动",
        };
        connectionLabel = new Label
        {
            AutoSize = true,
            ForeColor = Muted,
            Margin = new Padding(14, 13, 0, 0),
            Text = "连接中…",
        };
        toolbar.Controls.AddRange(new Control[] { brand, toggleButton, refreshButton, settingsButton, stateLabel, wechatLabel, connectionLabel });
        toolTip = new ToolTip
        {
            InitialDelay = 1800,    // 鼠标停留 1.8s 后才显示，避免一放上去就弹提示
            AutoPopDelay = 20000,   // 显示后停留 20s
            ReshowDelay = 1200,     // 再次移到另一个控件时也需停留
            ShowAlways = true,
        };
        toolTip.SetToolTip(toggleButton, "启动或停止后台服务（启动 supervisor 管理全部进程）");
        toolTip.SetToolTip(refreshButton, "刷新状态与会话（F5）");
        toolTip.SetToolTip(settingsButton, "设置：白名单、回复频率、AI 人格、API Key");
        toolTip.SetToolTip(stateLabel, "后台服务当前状态");
        toolTip.SetToolTip(wechatLabel, "微信客户端登录状态");

        statusStrip = new StatusStrip { BackColor = PanelBg, ForeColor = Muted, SizingGrip = false };
        statusText = new ToolStripStatusLabel { Text = "等待连接" };
        statusRight = new ToolStripStatusLabel { Text = "api " + api.BaseUrl, Spring = true, TextAlign = ContentAlignment.MiddleRight };
        statusStrip.Items.Add(statusText);
        statusStrip.Items.Add(statusRight);

        SplitContainer outer = new SplitContainer
        {
            Dock = DockStyle.Fill,
            BackColor = Bg,
            SplitterWidth = 8,
            FixedPanel = FixedPanel.Panel1,
            IsSplitterFixed = false,
        };
        outer.Panel1.BackColor = Bg;
        outer.Panel2.BackColor = Bg;

        Panel leftPanel = new Panel { Dock = DockStyle.Fill, BackColor = PanelBg, Padding = new Padding(8) };
        Label sessionsTitle = new Label
        {
            Text = "会话",
            Dock = DockStyle.Top,
            Height = 30,
            ForeColor = Color.FromArgb(205, 216, 234),
            Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold),
            Padding = new Padding(4, 4, 0, 0),
        };
        sessionList = new ListBox
        {
            Dock = DockStyle.Fill,
            BackColor = PanelBg,
            ForeColor = Color.White,
            BorderStyle = BorderStyle.None,
            DrawMode = DrawMode.OwnerDrawFixed,
            ItemHeight = 48,
            IntegralHeight = false,
            SelectionMode = SelectionMode.One,
        };
        Panel searchWrap = new Panel { Dock = DockStyle.Top, Height = 32, BackColor = PanelBg, Padding = new Padding(2, 2, 2, 2) };
        sessionSearch = new TextBox
        {
            Dock = DockStyle.Fill,
            BackColor = PanelBg2,
            ForeColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Microsoft YaHei UI", 9F),
        };
        toolTip.SetToolTip(sessionSearch, "按会话名 / wxid 过滤");
        searchWrap.Controls.Add(sessionSearch);
        sessionList.DrawItem += SessionList_DrawItem;
        ContextMenuStrip sessionMenu = new ContextMenuStrip
        {
            BackColor = PanelBg2,
            ForeColor = UiTheme.TextColor,
            Font = UiTheme.BodyFont,
        };
        ToolStripMenuItem copyAccountItem = new ToolStripMenuItem("复制账号（白名单用）");
        ToolStripMenuItem copyNameItem = new ToolStripMenuItem("复制显示名");
        ToolStripMenuItem copyGroupIdItem = new ToolStripMenuItem("复制会话 ID");
        copyAccountItem.Click += (s, e) => CopySelectedSessionAccount();
        copyNameItem.Click += (s, e) => CopySelectedSessionName();
        copyGroupIdItem.Click += (s, e) => CopySelectedSessionId();
        sessionMenu.Items.Add(copyAccountItem);
        sessionMenu.Items.Add(copyNameItem);
        sessionMenu.Items.Add(copyGroupIdItem);
        sessionMenu.Opening += (s, e) =>
        {
            int index = sessionList.IndexFromPoint(sessionList.PointToClient(Cursor.Position));
            if (index >= 0 && index < visibleSessions.Count) { sessionList.SelectedIndex = index; }
            Dictionary<string, object> selected = GetSelectedSession();
            bool group = IsGroupSession(selected);
            copyAccountItem.Text = group ? "复制群名（白名单用）" : "复制账号（白名单用）";
            copyGroupIdItem.Text = group ? "复制群 ID / 会话 ID" : "复制 wxid / 会话 ID";
        };
        sessionList.ContextMenuStrip = sessionMenu;
        sessionList.MouseDown += (s, e) =>
        {
            if (e.Button != MouseButtons.Right) { return; }
            int index = sessionList.IndexFromPoint(e.Location);
            if (index >= 0 && index < visibleSessions.Count) { sessionList.SelectedIndex = index; }
        };
        sessionList.SelectedIndexChanged += (s, e) =>
        {
            if (sessionList.SelectedIndex < 0 || sessionList.SelectedIndex >= visibleSessions.Count) { return; }
            Dictionary<string, object> session = visibleSessions[sessionList.SelectedIndex];
            activeTalker = Convert.ToString(session["talker"]);
            activeName = session.ContainsKey("displayName") ? Convert.ToString(session["displayName"]) : activeTalker;
            lastMessagesJson = string.Empty;
            LoadMessages(true);
            UpdateCopyAccountButton();
        };
        sessionSearch.TextChanged += (s, e) => RenderSessions();
        leftPanel.Controls.Add(SlimScrollArea.Create(sessionList));
        leftPanel.Controls.Add(searchWrap);
        leftPanel.Controls.Add(sessionsTitle);
        outer.Panel1.Controls.Add(leftPanel);

        SplitContainer inner = new SplitContainer
        {
            Dock = DockStyle.Fill,
            BackColor = Bg,
            SplitterWidth = 8,
            FixedPanel = FixedPanel.Panel2,
        };
        inner.Panel1.BackColor = PanelBg;
        inner.Panel2.BackColor = PanelBg;

        Panel chatPanel = new Panel { Dock = DockStyle.Fill, BackColor = PanelBg, Padding = new Padding(0) };
        Panel chatHeader = new Panel { Dock = DockStyle.Top, Height = 52, BackColor = PanelBg2 };
        titleLabel = new Label
        {
            Text = "选择左侧会话",
            AutoSize = true,
            ForeColor = UiTheme.TextColor,
            Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold),
            Location = new Point(14, 8),
        };
        subtitleLabel = new Label
        {
            Text = "",
            AutoSize = true,
            ForeColor = Muted,
            Location = new Point(14, 30),
        };
        copyAccountButton = new RoundButton
        {
            Text = "复制账号",
            Dock = DockStyle.Right,
            Width = 100,
            AutoSize = false,
            Radius = 9,
            NormalBack = UiTheme.PanelBg3,
            HoverBack = UiTheme.AccentDark,
            BorderColor = UiTheme.Line,
            ForeColor = UiTheme.TextSoft,
            Font = UiTheme.SmallFont,
        };
        copyAccountButton.Click += (s, e) => CopyActiveSessionAccount();
        chatHeader.Controls.Add(titleLabel);
        chatHeader.Controls.Add(subtitleLabel);
        chatHeader.Controls.Add(copyAccountButton);
        toolTip.SetToolTip(copyAccountButton, "复制当前会话的账号/群名，粘贴到 设置 → 白名单");
        chatFlow = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            BackColor = PanelBg,
            Padding = new Padding(12),
        };
        chatFlow.Resize += (s, e) => ResizeBubbles();
        chatFlow.Controls.Add(CreateChatEmptyState());
        chatPanel.Controls.Add(SlimScrollArea.Create(chatFlow));
        chatPanel.Controls.Add(chatHeader);
        inner.Panel1.Controls.Add(chatPanel);

        Panel statusPanel = new Panel { Dock = DockStyle.Fill, BackColor = PanelBg, Padding = new Padding(10) };
        Label statusTitle = new Label
        {
            Text = "运行状态",
            Dock = DockStyle.Top,
            Height = 30,
            ForeColor = UiTheme.TextSoft,
            Font = UiTheme.HeadFont,
            Padding = new Padding(2, 4, 0, 0),
        };
        statusBox = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            BackColor = PanelBg,
            ForeColor = UiTheme.TextColor,
            Font = new Font("Microsoft YaHei UI", 9F),
            Padding = new Padding(2, 2, 2, 8),
        };
        statusBox.Resize += (s, e) =>
        {
            if (statusBox.Controls.Count > 0 && meta != null)
            {
                lastStatusSignature = string.Empty;
                UpdateStatusBox();
            }
        };
        CardPanel loginCard = new CardPanel
        {
            Dock = DockStyle.Top,
            Height = 196,
            FillTop = UiTheme.PanelBg3,
            FillBottom = UiTheme.PanelBg2,
            Border = Color.FromArgb(66, 104, 214, 255),
            Radius = 16,
            Padding = new Padding(12, 8, 12, 10),
            Margin = new Padding(0, 0, 0, 8),
        };
        Panel loginHeader = new Panel
        {
            Dock = DockStyle.Top,
            Height = 46,
            BackColor = Color.Transparent,
        };
        WhaleMascotControl loginMascot = new WhaleMascotControl
        {
            Size = new Size(42, 42),
            Dock = DockStyle.Right,
            ShowGlow = true,
            Simplified = false,
            BackColor = UiTheme.PanelBg3,
        };
        Label loginTitle = new Label
        {
            Text = "微信登录",
            Dock = DockStyle.Fill,
            ForeColor = UiTheme.TextColor,
            Font = UiTheme.HeadFont,
            TextAlign = ContentAlignment.MiddleLeft,
            BackColor = Color.Transparent,
        };
        loginHeader.Controls.Add(loginTitle);
        loginHeader.Controls.Add(loginMascot);
        loginStatusLabel = new Label
        {
            Text = "未检测到微信客户端",
            Dock = DockStyle.Top,
            Height = 40,
            ForeColor = Muted,
            Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold),
        };
        loginHintLabel = new Label
        {
            Text = "点下方按钮启动固定版微信，然后扫码/手机确认登录。",
            Dock = DockStyle.Top,
            Height = 52,
            ForeColor = Muted,
            Font = new Font("Microsoft YaHei UI", 8.5F),
        };
        loginButton = MakeButton("启动微信并登录", (s, e) => StartWeChatLogin(), true);
        loginButton.Dock = DockStyle.Bottom;
        loginButton.AutoSize = false;
        loginButton.Height = 32;
        loginButton.Margin = new Padding(0, 4, 0, 0);
        repairButton = MakeButton("恢复固定版客户端", (s, e) => RestoreWeChatClient());
        repairButton.Dock = DockStyle.Bottom;
        repairButton.AutoSize = false;
        repairButton.Height = 32;
        repairButton.Visible = false;
        repairButton.Margin = new Padding(0, 4, 0, 0);
        loginCard.Controls.Add(repairButton);
        loginCard.Controls.Add(loginButton);
        loginCard.Controls.Add(loginHintLabel);
        loginCard.Controls.Add(loginStatusLabel);
        loginCard.Controls.Add(loginHeader);
        toolTip.SetToolTip(loginButton, "启动固定版本微信 4.1.10.27 并安装 Hook；登录状态自动检测");
        statusPanel.Controls.Add(SlimScrollArea.Create(statusBox));
        statusPanel.Controls.Add(statusTitle);
        statusPanel.Controls.Add(loginCard);
        inner.Panel2.Controls.Add(statusPanel);
        outer.Panel2.Controls.Add(inner);

        Controls.Add(outer);
        Controls.Add(toolbar);
        Controls.Add(statusStrip);
        try
        {
            outer.SplitterDistance = 260;
            inner.SplitterDistance = Math.Max(420, inner.Width - 400);
        }
        catch { }
        Resize += (s, e) =>
        {
            try
            {
                if (outer.Width > 700) { outer.SplitterDistance = Math.Min(320, Math.Max(220, outer.Width / 4)); }
                if (inner.Width > 700) { inner.SplitterDistance = Math.Max(420, inner.Width - 400); }
            }
            catch { }
        };
    }

    private RoundButton MakeButton(string text, EventHandler handler, bool accent = false)
    {
        RoundButton button = new RoundButton
        {
            Text = text,
            Margin = new Padding(4, 10, 4, 0),
        };
        if (accent)
        {
            button.NormalBack = UiTheme.Accent;
            button.HoverBack = UiTheme.AccentBright;
            button.PressedBack = UiTheme.AccentDark;
            button.BorderColor = Color.FromArgb(150, 180, 255);
        }
        else
        {
            button.NormalBack = UiTheme.PanelBg2;
            button.HoverBack = UiTheme.PanelBg3;
            button.PressedBack = UiTheme.AccentDark;
            button.BorderColor = UiTheme.Line;
        }
        button.Click += handler;
        return button;
    }

    private void ToggleService()
    {
        if (busy) { return; }
        bool running = meta != null;
        userStopped = running;
        RunManage(running ? "stop" : "start");
    }

    /// <summary>执行 manage.ps1；异步读输出避免子进程继承管道导致 ReadToEnd 死锁。</summary>
    private int RunManageCommand(string action, int timeoutMs, out string output)
    {
        output = string.Empty;
        try
        {
            ProcessStartInfo info = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -File \"scripts\\manage.ps1\" " + action)
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            StringBuilder buffer = new StringBuilder();
            using (Process process = new Process { StartInfo = info, EnableRaisingEvents = true })
            {
                DataReceivedEventHandler handler = (s, e) => { if (e.Data != null) { lock (buffer) { buffer.AppendLine(e.Data); } } };
                process.OutputDataReceived += handler;
                process.ErrorDataReceived += handler;
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                bool exited = process.WaitForExit(timeoutMs);
                int exitCode = exited ? process.ExitCode : -999;
                if (!exited)
                {
                    try { process.Kill(); } catch { }
                    lock (buffer) { buffer.AppendLine("TIMEOUT after " + timeoutMs + "ms"); }
                }
                else
                {
                    System.Threading.Thread.Sleep(120);
                }
                lock (buffer) { output = buffer.ToString().Trim(); }
                return exitCode;
            }
        }
        catch (Exception error)
        {
            output = error.Message;
            return -1;
        }
    }

    private void RunManage(string action)
    {
        if (busy) { return; }
        busy = true;
        busyAction = action;
        UpdateControls();
        SetStatus(action == "start" ? "正在启动服务（supervisor）…"
            : (action == "stop" ? "正在停止服务…" : "正在重启服务（supervisor）…"));
        Task.Run(() =>
        {
            try
            {
                string tail;
                int exitCode = RunManageCommand(action, 120000, out tail);
                try
                {
                    string logDir = Path.Combine(root, "state", "logs");
                    Directory.CreateDirectory(logDir);
                    File.WriteAllText(Path.Combine(logDir, "desktop-manage.log"),
                        DateTime.Now.ToString("o") + " action=" + action + " exit=" + exitCode + "\n" + tail + "\n",
                        new UTF8Encoding(false));
                }
                catch { }
                if (exitCode != 0)
                {
                    string detail = tail.Length > 400 ? tail.Substring(tail.Length - 400) : tail;
                    string actionText = action == "start" ? "启动" : (action == "stop" ? "停止" : "重启");
                    SetStatus(actionText + "失败（exit=" + exitCode + "）：" + detail);
                }
            }
            catch (Exception error)
            {
                SetStatus("操作失败：" + error.Message);
            }
            finally
            {
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        busy = false;
                        string actionText = busyAction;
                        busyAction = string.Empty;
                        UpdateControls();
                        SetStatus(actionText == "stop" ? "服务已停止，可随时重新启动"
                            : (actionText == "restart" ? "设置已保存，后台服务已重启" : "服务已启动"));
                        RefreshMeta();
                        RefreshSessions();
                        if (closeRequestedAfterBusy) { Close(); }
                    }));
                }
                catch { }
            }
        });
    }

    private void UpdateControls()
    {
        if (toggleButton == null) { return; }
        toggleButton.Enabled = !busy;
        refreshButton.Enabled = !busy;
        settingsButton.Enabled = !busy;
        UpdateToggle();
    }

    private void UpdateToggle()
    {
        if (toggleButton == null) { return; }
        bool running = meta != null;
        if (busy)
        {
            toggleButton.Text = busyAction == "restart" ? "重启中…" : (running ? "停止中…" : "启动中…");
            toggleButton.NormalBack = Color.FromArgb(60, 68, 88);
            toggleButton.HoverBack = toggleButton.NormalBack;
            toggleButton.PressedBack = toggleButton.NormalBack;
            toggleButton.BorderColor = Line;
            stateLabel.Text = "● 处理中…";
            stateLabel.ForeColor = Warn;
            return;
        }
        if (running)
        {
            toggleButton.Text = "停止服务";
            toggleButton.NormalBack = Color.FromArgb(196, 92, 124);
            toggleButton.HoverBack = Color.FromArgb(222, 112, 146);
            toggleButton.PressedBack = Color.FromArgb(160, 70, 100);
            toggleButton.BorderColor = Color.FromArgb(255, 160, 190);
            stateLabel.Text = "● 服务运行中";
            stateLabel.ForeColor = Ok;
        }
        else
        {
            toggleButton.Text = "启动服务";
            toggleButton.NormalBack = UiTheme.Accent;
            toggleButton.HoverBack = UiTheme.AccentBright;
            toggleButton.PressedBack = UiTheme.AccentDark;
            toggleButton.BorderColor = Color.FromArgb(150, 180, 255);
            stateLabel.Text = "● 服务已停止";
            stateLabel.ForeColor = Muted;
        }
    }

    private void SetStatus(string text)
    {
        if (statusText == null || text == null) { return; }
        DateTime now = DateTime.Now;
        bool periodic = text.StartsWith("已连接 · ") || text.StartsWith("连接中") || text.StartsWith("等待连接");
        if (periodic && now < statusHoldUntil) { return; }
        statusText.Text = text;
        if (!periodic)
        {
            bool error = text.Contains("失败") || text.Contains("异常") || text.Contains("错误");
            statusHoldUntil = now.AddSeconds(error ? 15 : 10);
        }
    }

    private void RefreshAll()
    {
        RefreshMeta();
        RefreshSessions();
        LoadMessages(true);
    }

    private void RefreshMeta()
    {
        Dictionary<string, object> body = null;
        if (PortOpen(api.ConsolePort)) { api.TryGetJson("/api/meta", out body); }
        if (body == null)
        {
            meta = null;
            metaFailures += 1;
            connectionLabel.Text = "未连接";
            connectionLabel.ForeColor = Err;
            UpdateToggle();
            SetStatus("后台服务未运行：点击「启动服务」或等待自动启动");
            if (!busy && !userStopped && (!PortOpen(api.ConsolePort) || metaFailures >= 2)) { StartServicesIfNeeded(); }
            UpdateStatusBox();
            UpdateLoginCard();
            return;
        }
        metaFailures = 0;
        meta = body;
        connectionLabel.Text = "已连接";
        connectionLabel.ForeColor = Ok;
        SetStatus("已连接 · " + DateTime.Now.ToString("HH:mm:ss") + " 刷新");
        UpdateToggle();
        UpdateStatusBox();
        UpdateLoginCard();
    }

    /// <summary>独立服务看门狗：即使刷新定时器被忙/设置页影响，也能发现服务掉线并拉起。</summary>
    private void ServiceWatchdogTick()
    {
        try
        {
            if (closingForCleanup) { return; }
            if (userStopped) { watchdogDownTicks = 0; return; }
            if (busy) { return; }
            if (PortOpen(api.ConsolePort))
            {
                if (watchdogDownTicks > 0) { LogWatchdogEvent("recovered"); }
                watchdogDownTicks = 0;
                return;
            }
            watchdogDownTicks += 1;
            LogWatchdogEvent("down_tick", "ticks=" + watchdogDownTicks + " busy=" + busy + " userStopped=" + userStopped);
            if (watchdogDownTicks >= 2)
            {
                watchdogDownTicks = 0;
                LogWatchdogEvent("auto_start");
                StartServicesIfNeeded();
            }
        }
        catch (Exception error)
        {
            LogWatchdogEvent("watchdog_error", error.Message);
        }
    }

    private void LogWatchdogEvent(string evt, string detail = "")
    {
        try
        {
            string logDir = Path.Combine(root, "state", "logs");
            Directory.CreateDirectory(logDir);
            File.AppendAllText(Path.Combine(logDir, "desktop-watchdog.log"),
                DateTime.Now.ToString("o") + " event=" + evt + " " + detail + "\n", new UTF8Encoding(false));
        }
        catch { }
    }

    private void StartServicesIfNeeded()
    {
        if (busy || userStopped) { LogWatchdogEvent("start_skipped", "busy=" + busy + " userStopped=" + userStopped); return; }
        busy = true;
        UpdateToggle();
        SetStatus("检测到服务未运行，正在自动启动…");
        LogWatchdogEvent("start_begin");
        Task.Run(() =>
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo("powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -File \"scripts\\manage.ps1\" start")
                {
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using (Process process = Process.Start(info)) { process.WaitForExit(120000); }
            }
            catch { }
            finally
            {
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        busy = false;
                        UpdateControls();
                        bool up = PortOpen(api.ConsolePort);
                        LogWatchdogEvent("start_end", "console_up=" + up);
                        if (up) { SetStatus("后台服务已自动启动，已连接"); RefreshMeta(); RefreshSessions(); }
                        if (closeRequestedAfterBusy) { Close(); }
                    }));
                }
                catch { }
            }
        });
    }

    private void RefreshSessions()
    {
        if (!PortOpen(api.ConsolePort)) { return; }
        Dictionary<string, object> body;
        if (!api.TryGetJson("/api/sessions?limit=200", out body) || !body.ContainsKey("sessions"))
        {
            return;
        }
        object[] items = body["sessions"] as object[];
        List<Dictionary<string, object>> next = new List<Dictionary<string, object>>();
        if (items != null)
        {
            foreach (object item in items)
            {
                Dictionary<string, object> session = item as Dictionary<string, object>;
                if (session != null) { next.Add(session); }
            }
        }
        bool changed = next.Count != sessions.Count;
        if (!changed)
        {
            for (int i = 0; i < next.Count; i++)
            {
                if (Convert.ToString(next[i]["talker"]) != Convert.ToString(sessions[i]["talker"]))
                {
                    changed = true;
                    break;
                }
            }
        }
        sessions = next;
        if (changed)
        {
            RenderSessions();
        }
        else if (sessionList != null)
        {
            sessionList.Invalidate();
        }
    }

    private Dictionary<string, object> GetSelectedSession()
    {
        if (sessionList == null || sessionList.SelectedIndex < 0 || sessionList.SelectedIndex >= visibleSessions.Count) { return null; }
        return visibleSessions[sessionList.SelectedIndex];
    }

    private static bool IsGroupSession(Dictionary<string, object> session)
    {
        return session != null && Convert.ToString(session.ContainsKey("sessionType") ? session["sessionType"] : string.Empty) == "group";
    }

    private Dictionary<string, object> FindSessionByTalker(string talker)
    {
        if (string.IsNullOrEmpty(talker)) { return null; }
        foreach (Dictionary<string, object> session in sessions)
        {
            if (Convert.ToString(session["talker"]) == talker) { return session; }
        }
        return null;
    }

    private string WhitelistValueOf(Dictionary<string, object> session)
    {
        if (session == null) { return string.Empty; }
        bool group = IsGroupSession(session);
        if (group)
        {
            return session.ContainsKey("displayName") ? Convert.ToString(session["displayName"]) : Convert.ToString(session["talker"]);
        }
        return Convert.ToString(session["talker"]);
    }

    private void CopyToClipboard(string value, string label)
    {
        if (string.IsNullOrEmpty(value)) { return; }
        try
        {
            Clipboard.SetText(value);
            SetStatus("已复制" + label + "：" + value + "，可粘贴到 设置 → 白名单");
        }
        catch (Exception error)
        {
            SetStatus("复制失败：" + error.Message);
        }
    }

    private void CopySelectedSessionAccount()
    {
        Dictionary<string, object> session = GetSelectedSession();
        if (session == null) { return; }
        string value = WhitelistValueOf(session);
        CopyToClipboard(value, IsGroupSession(session) ? "群名" : "账号");
    }

    private void CopySelectedSessionName()
    {
        Dictionary<string, object> session = GetSelectedSession();
        if (session == null) { return; }
        CopyToClipboard(Convert.ToString(session.ContainsKey("displayName") ? session["displayName"] : session["talker"]), "显示名");
    }

    private void CopySelectedSessionId()
    {
        Dictionary<string, object> session = GetSelectedSession();
        if (session == null) { return; }
        CopyToClipboard(Convert.ToString(session["talker"]), "会话 ID");
    }

    private void CopyActiveSessionAccount()
    {
        Dictionary<string, object> session = FindSessionByTalker(activeTalker);
        if (session == null) { SetStatus("复制失败：当前没有选中的会话"); return; }
        CopyToClipboard(WhitelistValueOf(session), IsGroupSession(session) ? "群名" : "账号");
    }

    private void UpdateCopyAccountButton()
    {
        if (copyAccountButton == null) { return; }
        Dictionary<string, object> session = FindSessionByTalker(activeTalker);
        bool hasSession = session != null;
        copyAccountButton.Enabled = hasSession;
        copyAccountButton.Text = hasSession && IsGroupSession(session) ? "复制群名" : "复制账号";
    }

    private void RenderSessions()
    {
        if (sessionList == null) { return; }
        string keyword = sessionSearch != null ? sessionSearch.Text.Trim() : string.Empty;
        visibleSessions = new List<Dictionary<string, object>>();
        foreach (Dictionary<string, object> session in sessions)
        {
            string name = session.ContainsKey("displayName") ? Convert.ToString(session["displayName"]) : Convert.ToString(session["talker"]);
            string talker = Convert.ToString(session["talker"]);
            bool match = keyword.Length == 0
                || name.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0
                || talker.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0;
            if (match) { visibleSessions.Add(session); }
        }
        sessionList.BeginUpdate();
        sessionList.Items.Clear();
        foreach (Dictionary<string, object> session in visibleSessions)
        {
            string name = session.ContainsKey("displayName") ? Convert.ToString(session["displayName"]) : Convert.ToString(session["talker"]);
            sessionList.Items.Add(name);
        }
        sessionList.EndUpdate();
        int target = -1;
        for (int i = 0; i < visibleSessions.Count; i++)
        {
            if (Convert.ToString(visibleSessions[i]["talker"]) == activeTalker) { target = i; break; }
        }
        if (target >= 0)
        {
            if (sessionList.SelectedIndex != target) { sessionList.SelectedIndex = target; }
        }
        else if (visibleSessions.Count > 0)
        {
            sessionList.SelectedIndex = 0;
        }
        UpdateCopyAccountButton();
    }

    private void SessionList_DrawItem(object sender, DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= visibleSessions.Count) { return; }
        Dictionary<string, object> session = visibleSessions[e.Index];
        bool selected = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        // 自绘 ListBox 必须每行先铺底：否则选择移动时旧行的渐变色会残留，出现“两行同时高亮”。
        using (SolidBrush itemBack = new SolidBrush(PanelBg))
        {
            e.Graphics.FillRectangle(itemBack, e.Bounds);
        }
        Rectangle bounds = new Rectangle(e.Bounds.Left + 4, e.Bounds.Top + 2, e.Bounds.Width - 8, e.Bounds.Height - 4);
        if (selected)
        {
            using (GraphicsPath path = UiTheme.RoundedRect(bounds, 10))
            using (LinearGradientBrush brush = new LinearGradientBrush(bounds,
                Color.FromArgb(50, 78, 160), Color.FromArgb(30, 48, 104), 30f))
            {
                e.Graphics.FillPath(brush, path);
            }
            using (GraphicsPath accentPath = UiTheme.RoundedRect(new Rectangle(bounds.Left - 4, bounds.Top + 10, 3, bounds.Height - 20), 2))
            using (SolidBrush accentBrush = new SolidBrush(UiTheme.Cyan))
            {
                e.Graphics.FillPath(accentBrush, accentPath);
            }
        }
        string name = session.ContainsKey("displayName") ? Convert.ToString(session["displayName"]) : Convert.ToString(session["talker"]);
        bool group = Convert.ToString(session.ContainsKey("sessionType") ? session["sessionType"] : "") == "group";
        string lastTime = "";
        if (session.ContainsKey("lastTimestamp"))
        {
            long ts = 0;
            long.TryParse(Convert.ToString(session["lastTimestamp"]), out ts);
            if (ts > 0) { lastTime = DateTimeOffset.FromUnixTimeSeconds(ts).LocalDateTime.ToString("HH:mm"); }
        }
        int unread = 0;
        if (session.ContainsKey("unreadCount")) { int.TryParse(Convert.ToString(session["unreadCount"]), out unread); }
        int avatarSize = 32;
        Rectangle avatarRect = new Rectangle(bounds.Left + 10, bounds.Top + (bounds.Height - avatarSize) / 2, avatarSize, avatarSize);
        Color avatarFrom = group ? UiTheme.Pink : UiTheme.Accent;
        Color avatarTo = group ? UiTheme.Lavender : UiTheme.Cyan;
        using (LinearGradientBrush avatarBrush = new LinearGradientBrush(avatarRect, avatarFrom, avatarTo, 45f))
        {
            e.Graphics.FillEllipse(avatarBrush, avatarRect);
        }
        using (SolidBrush initialBrush = new SolidBrush(UiTheme.Bg))
        {
            e.Graphics.DrawString(UiTheme.InitialOf(name), SessionInitialFont, initialBrush, avatarRect, CenterText);
        }
        int textLeft = avatarRect.Right + 10;
        int nameTop = bounds.Top + 7;
        int rightPad = 12;
        int timeWidth = 44;
        Color nameColor = selected ? UiTheme.TextColor : UiTheme.TextSoft;
        Color timeColor = selected ? UiTheme.TextSoft : Muted;
        string tag = group ? "群聊" : "私聊";
        // 名称区域：固定右边界，超长省略，绝不压到时间列
        Rectangle nameRect = new Rectangle(textLeft, nameTop, Math.Max(40, bounds.Right - rightPad - timeWidth - 8 - textLeft), 20);
        TextRenderer.DrawText(e.Graphics, name, SessionNameFont, nameRect, nameColor,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
        // 时间固定右上角
        Rectangle timeRect = new Rectangle(bounds.Right - rightPad - timeWidth, nameTop, timeWidth, 18);
        TextRenderer.DrawText(e.Graphics, lastTime, SessionSubFont, timeRect, timeColor,
            TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
        // 会话类型第二行
        TextRenderer.DrawText(e.Graphics, tag, SessionSubFont, new Point(textLeft, nameTop + 21), timeColor,
            TextFormatFlags.Left | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
        if (unread > 0)
        {
            int badgeSize = 18;
            Rectangle badgeRect = new Rectangle(bounds.Right - badgeSize - 10, bounds.Bottom - badgeSize - 6, badgeSize, badgeSize);
            using (SolidBrush badgeBrush = new SolidBrush(UiTheme.Pink))
            {
                e.Graphics.FillEllipse(badgeBrush, badgeRect);
            }
            using (SolidBrush badgeText = new SolidBrush(Color.White))
            {
                e.Graphics.DrawString(unread.ToString(), UiTheme.TinyFont, badgeText, badgeRect, UiTheme.Centered);
            }
        }
    }

    private void LoadMessages(bool force)
    {
        if (string.IsNullOrEmpty(activeTalker)) { return; }
        if (!PortOpen(api.ConsolePort)) { return; }
        Dictionary<string, object> body;
        if (!api.TryGetJson("/api/messages?talker=" + Uri.EscapeDataString(activeTalker) + "&limit=100", out body))
        {
            return;
        }
        string json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(body);
        if (!force && json == lastMessagesJson) { return; }
        lastMessagesJson = json;
        object[] items = body.ContainsKey("messages") ? body["messages"] as object[] : null;
        List<Dictionary<string, object>> messages = new List<Dictionary<string, object>>();
        if (items != null)
        {
            foreach (object item in items)
            {
                Dictionary<string, object> message = item as Dictionary<string, object>;
                if (message != null) { messages.Add(message); }
            }
        }
        titleLabel.Text = activeName;
        subtitleLabel.Text = "最近 " + messages.Count + " 条 · " + activeTalker;
        int scrollBefore = chatFlow.VerticalScroll.Value;
        int scrollMax = chatFlow.VerticalScroll.Maximum;
        bool atBottom = scrollBefore >= scrollMax - 6;
        chatFlow.SuspendLayout();
        foreach (Control oldControl in chatFlow.Controls) { oldControl.Dispose(); }
        chatFlow.Controls.Clear();
        if (messages.Count == 0)
        {
            chatFlow.Controls.Add(CreateChatEmptyState());
        }
        int width = Math.Max(320, chatFlow.ClientSize.Width - 60);
        for (int i = messages.Count - 1; i >= 0; i--)
        {
            chatFlow.Controls.Add(CreateBubble(messages[i], width));
        }
        chatFlow.ResumeLayout();
        if (chatFlow.Controls.Count > 0)
        {
            if (force || atBottom)
            {
                chatFlow.ScrollControlIntoView(chatFlow.Controls[chatFlow.Controls.Count - 1]);
            }
            else
            {
                chatFlow.VerticalScroll.Value = Math.Min(scrollBefore, chatFlow.VerticalScroll.Maximum);
                chatFlow.PerformLayout();
            }
        }
    }

    /// <summary>聊天区空状态：大号大肥鱼 + 引导文案。</summary>
    private Control CreateChatEmptyState()
    {
        Panel empty = new Panel
        {
            Width = Math.Max(360, chatFlow.ClientSize.Width - 80),
            Height = 300,
            BackColor = Color.Transparent,
            Margin = new Padding(0, 24, 0, 0),
        };
        WhaleMascotControl emptyMascot = new WhaleMascotControl
        {
            Size = new Size(140, 140),
            Location = new Point(0, 4),
            ShowGlow = true,
            Simplified = false,
            BackColor = PanelBg,
        };
        Label emptyTitle = new Label
        {
            Text = "和大肥鱼一起等消息吧",
            AutoSize = true,
            Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Bold),
            ForeColor = UiTheme.TextColor,
            Location = new Point(158, 46),
        };
        Label emptyHint = new Label
        {
            Text = "选择左侧会话查看聊天记录\n自动回复由白名单 + DeepSeek 模型驱动\n所有窗口都在这里，不打扰你的桌面",
            AutoSize = true,
            Font = UiTheme.SmallFont,
            ForeColor = UiTheme.Muted,
            Location = new Point(160, 82),
        };
        empty.Controls.Add(emptyHint);
        empty.Controls.Add(emptyTitle);
        empty.Controls.Add(emptyMascot);
        return empty;
    }

    private Panel CreateBubble(Dictionary<string, object> message, int maxWidth)
    {
        bool isSend = message.ContainsKey("isSend") && Convert.ToBoolean(message["isSend"]);
        string content = message.ContainsKey("content") ? Convert.ToString(message["content"]) : string.Empty;
        string sender = message.ContainsKey("senderDisplay") ? Convert.ToString(message["senderDisplay"]) : (isSend ? "我" : "对方");
        long createTime = 0;
        if (message.ContainsKey("createTime")) { long.TryParse(Convert.ToString(message["createTime"]), out createTime); }
        string time = createTime > 0 ? DateTimeOffset.FromUnixTimeSeconds(createTime).LocalDateTime.ToString("MM-dd HH:mm") : "";
        string typeText = message.ContainsKey("typeText") ? Convert.ToString(message["typeText"]) : "";
        if (string.IsNullOrEmpty(sender)) { sender = isSend ? "我" : "对方"; }

        int bubbleMax = Math.Max(220, maxWidth - 110);
        Label header = new Label
        {
            Text = sender + "  " + time + "  " + typeText,
            AutoSize = true,
            ForeColor = UiTheme.Muted,
            Font = BubbleHeaderFont,
        };
        Label text = new Label
        {
            Text = string.IsNullOrEmpty(content) ? "[非文本消息]" : content,
            AutoSize = true,
            MaximumSize = new Size(bubbleMax - 26, 0),
            BackColor = Color.Transparent,
            ForeColor = UiTheme.TextColor,
            Font = BubbleContentFont,
            Location = new Point(13, 10),
        };
        BubblePanel bubble = new BubblePanel
        {
            Outgoing = isSend,
            Size = new Size(Math.Max(90, text.PreferredWidth + 26), text.PreferredHeight + 20),
        };
        bubble.Controls.Add(text);
        AvatarControl avatar = new AvatarControl
        {
            Initial = UiTheme.InitialOf(isSend ? "我" : sender),
            Outgoing = isSend,
            Size = new Size(34, 34),
        };
        Panel row = new Panel
        {
            Width = maxWidth,
            Height = bubble.Height + 34,
            BackColor = UiTheme.PanelBg,
            Margin = new Padding(0, 2, 0, 8),
        };
        int avatarX = isSend ? maxWidth - 34 : 0;
        int bubbleX = isSend ? Math.Max(50, maxWidth - 34 - 12 - bubble.Width) : 44;
        avatar.Location = new Point(avatarX, 22);
        bubble.Location = new Point(bubbleX, 20);
        header.Location = new Point(isSend ? Math.Max(bubbleX, bubbleX + bubble.Width - header.PreferredWidth) : bubbleX, 2);
        row.Controls.Add(header);
        row.Controls.Add(bubble);
        row.Controls.Add(avatar);

        // 图片：按需异步加载
        if (showImages && message.ContainsKey("image"))
        {
            Dictionary<string, object> image = message["image"] as Dictionary<string, object>;
            string imageId = image != null && image.ContainsKey("id") ? Convert.ToString(image["id"]) : "";
            if (!string.IsNullOrEmpty(imageId))
            {
                PictureBox box = new PictureBox
                {
                    Size = new Size(220, 150),
                    SizeMode = PictureBoxSizeMode.Zoom,
                    BackColor = Color.FromArgb(20, 30, 48),
                    Location = new Point(13, text.Height + 14),
                };
                Label loading = new Label
                {
                    Text = "图片加载中…",
                    ForeColor = UiTheme.Muted,
                    AutoSize = true,
                    BackColor = Color.Transparent,
                    Location = new Point(box.Left + 6, box.Top + 6),
                };
                bubble.Controls.Add(box);
                bubble.Controls.Add(loading);
                bubble.Height = box.Bottom + 10;
                row.Height = bubble.Height + 34;
                string id = imageId;
                Task.Run(() =>
                {
                    Image imageValue = null;
                    try
                    {
                        lock (imageCache)
                        {
                            if (imageCache.ContainsKey(id)) { imageValue = imageCache[id]; }
                        }
                        if (imageValue == null)
                        {
                            imageValue = api.GetImage(id);
                            if (imageValue != null)
                            {
                                lock (imageCache)
                                {
                                    if (!imageCache.ContainsKey(id))
                                    {
                                        imageCache[id] = imageValue;
                                        imageCacheOrder.Enqueue(id);
                                        while (imageCacheOrder.Count > MaxCachedImages)
                                        {
                                            string oldId = imageCacheOrder.Dequeue();
                                            Image oldImage;
                                            if (imageCache.TryGetValue(oldId, out oldImage))
                                            {
                                                imageCache.Remove(oldId);
                                                oldImage.Dispose();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    catch { }
                    if (imageValue != null)
                    {
                        try
                        {
                            BeginInvoke(new Action(() =>
                            {
                                loading.Visible = false;
                                box.Image = imageValue;
                            }));
                        }
                        catch { }
                    }
                    else
                    {
                        try { BeginInvoke(new Action(() => { loading.Text = "图片不可用"; })); } catch { }
                    }
                });
            }
        }
        return row;
    }

    private void ResizeBubbles()
    {
        int width = Math.Max(320, chatFlow.ClientSize.Width - 60);
        foreach (Control control in chatFlow.Controls)
        {
            control.Width = width;
        }
    }

    private int StatusContentWidth()
    {
        int width = statusBox != null ? statusBox.ClientSize.Width - 30 : 300;
        return Math.Max(220, width);
    }

    private void StatusText(string text, Color color, bool bold, int topMargin)
    {
        Label label = new Label
        {
            Text = text,
            AutoSize = true,
            MaximumSize = new Size(StatusContentWidth(), 0),
            ForeColor = color,
            Font = bold ? new Font(UiTheme.BodyFont, FontStyle.Bold) : UiTheme.BodyFont,
            Margin = new Padding(0, topMargin, 0, 1),
            BackColor = Color.Transparent,
        };
        statusBox.Controls.Add(label);
    }

    private void StatusSection(string title)
    {
        StatusText(title, UiTheme.Muted, true, 10);
    }

    private void StatusRow(string key, string value, Color color)
    {
        int width = StatusContentWidth();
        Panel row = new Panel
        {
            Width = width,
            Height = 20,
            BackColor = Color.Transparent,
            Margin = new Padding(0, 1, 0, 1),
        };
        Label caption = new Label
        {
            Text = key,
            AutoSize = false,
            Width = 92,
            Height = 19,
            ForeColor = UiTheme.Muted,
            Font = UiTheme.SmallFont,
            Location = new Point(0, 2),
            BackColor = Color.Transparent,
        };
        Label content = new Label
        {
            Text = value,
            AutoSize = true,
            MaximumSize = new Size(Math.Max(80, width - 96), 0),
            ForeColor = color,
            Font = UiTheme.BodyFont,
            Location = new Point(94, 0),
            BackColor = Color.Transparent,
        };
        row.Height = Math.Max(20, content.PreferredHeight + 2);
        row.Controls.Add(content);
        row.Controls.Add(caption);
        statusBox.Controls.Add(row);
    }

    private void UpdateStatusBox()
    {
        if (statusBox == null) { return; }
        string signature = meta == null ? "null"
            : new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(new object[]
            {
                meta.ContainsKey("services") ? meta["services"] : null,
                meta.ContainsKey("model") ? meta["model"] : null,
                meta.ContainsKey("deliveries") ? meta["deliveries"] : null,
                meta.ContainsKey("autoReply") ? meta["autoReply"] : null,
            });
        if (meta != null && signature == lastStatusSignature) { return; }
        lastStatusSignature = signature;
        statusBox.SuspendLayout();
        foreach (Control old in statusBox.Controls) { old.Dispose(); }
        statusBox.Controls.Clear();
        if (meta == null)
        {
            StatusText("后台服务未运行", UiTheme.Warn, true, 2);
            StatusText("点击「启动服务」或等待自动启动。", UiTheme.Muted, false, 2);
            statusBox.ResumeLayout();
            return;
        }
        Dictionary<string, object> services = meta.ContainsKey("services") ? meta["services"] as Dictionary<string, object> : null;
        StatusSection("服务");
        AppendService(services, "reader");
        AppendService(services, "bridge");
        AppendService(services, "adapter");
        AppendService(services, "hook");
        Dictionary<string, object> supervisor = services != null && services.ContainsKey("supervisor")
            ? services["supervisor"] as Dictionary<string, object> : null;
        if (supervisor != null && supervisor.ContainsKey("services"))
        {
            Dictionary<string, object> childs = supervisor["services"] as Dictionary<string, object>;
            int healthy = 0;
            foreach (KeyValuePair<string, object> pair in childs)
            {
                Dictionary<string, object> child = pair.Value as Dictionary<string, object>;
                if (child != null && Convert.ToString(child["status"]) == "healthy") { healthy++; }
            }
            StatusRow("supervisor", healthy + "/" + childs.Count + " healthy", healthy == childs.Count ? UiTheme.Ok : UiTheme.Warn);
        }

        Dictionary<string, object> model = meta.ContainsKey("model") ? meta["model"] as Dictionary<string, object> : null;
        StatusSection("模型与回复");
        if (model != null)
        {
            StatusRow("模型", Convert.ToString(model["provider"]) + " / " + Convert.ToString(model["model"]), UiTheme.Accent2);
            bool autoReply = meta.ContainsKey("autoReply") && Convert.ToBoolean(meta["autoReply"]);
            StatusRow("自动回复", autoReply ? "开启" : "关闭", autoReply ? UiTheme.Ok : UiTheme.Warn);
        }

        Dictionary<string, object> reader = services != null && services.ContainsKey("reader") ? services["reader"] as Dictionary<string, object> : null;
        if (reader != null && reader.ContainsKey("keys"))
        {
            Dictionary<string, object> keys = reader["keys"] as Dictionary<string, object>;
            Dictionary<string, object> current = keys != null && keys.ContainsKey("current") ? keys["current"] as Dictionary<string, object> : null;
            bool verified = current != null && current.ContainsKey("verified") && Convert.ToBoolean(current["verified"]);
            StatusSection("密钥");
            StatusRow("当前账号", Convert.ToString(reader.ContainsKey("accountDirectory") ? reader["accountDirectory"] : "-"), UiTheme.TextColor);
            StatusRow("密钥校验", verified ? "有效" : "异常", verified ? UiTheme.Ok : UiTheme.Err);
        }

        Dictionary<string, object> deliveries = meta.ContainsKey("deliveries") ? meta["deliveries"] as Dictionary<string, object> : null;
        if (deliveries != null && deliveries.ContainsKey("recent"))
        {
            StatusSection("最近发送回执");
            object[] recent = deliveries["recent"] as object[];
            if (recent != null)
            {
                int limit = 0;
                foreach (object item in recent)
                {
                    if (limit++ >= 5) { break; }
                    Dictionary<string, object> record = item as Dictionary<string, object>;
                    if (record == null) { continue; }
                    string state = Convert.ToString(record["state"]);
                    Color color = state == "confirmed" ? UiTheme.Ok : (state == "rejected" ? UiTheme.Err : UiTheme.Warn);
                    StatusRow(state, Convert.ToString(record["textLength"]) + " 字", color);
                }
            }
        }
        StatusText("白名单内只读；本程序不会发送消息。", UiTheme.Muted, false, 10);
        statusBox.ResumeLayout();
    }

    private void AppendService(Dictionary<string, object> services, string name)
    {
        if (services == null || !services.ContainsKey(name)) { StatusRow("● " + name, "-", UiTheme.Warn); return; }
        Dictionary<string, object> service = services[name] as Dictionary<string, object>;
        bool ok;
        string detail = "";
        if (name == "reader")
        {
            ok = service != null && service.ContainsKey("ready") && Convert.ToBoolean(service["ready"]);
            detail = ok ? "就绪" : "未就绪";
        }
        else if (name == "bridge")
        {
            ok = service != null && service.ContainsKey("ok") && Convert.ToBoolean(service["ok"]);
            detail = service != null && service.ContainsKey("connected") && Convert.ToBoolean(service["connected"]) ? "已连接" : "未连接";
        }
        else if (name == "adapter")
        {
            bool readerOk = service != null && service.ContainsKey("readerConnected") && Convert.ToBoolean(service["readerConnected"]);
            bool bridgeOk = service != null && service.ContainsKey("bridgeConnected") && Convert.ToBoolean(service["bridgeConnected"]);
            ok = readerOk && bridgeOk;
            detail = (readerOk ? "reader✔ " : "reader✘ ") + (bridgeOk ? "bridge✔" : "bridge✘");
        }
        else if (name == "hook")
        {
            string state = service != null && service.ContainsKey("startupState") ? Convert.ToString(service["startupState"]) : "";
            ok = state == "ready";
            detail = state;
        }
        else
        {
            ok = service != null && service.ContainsKey("ok") && Convert.ToBoolean(service["ok"]);
        }
        string value = (ok ? "正常" : "异常") + (detail.Length > 0 ? " · " + detail : "");
        StatusRow("● " + name, value, ok ? UiTheme.Ok : UiTheme.Err);
    }

}
