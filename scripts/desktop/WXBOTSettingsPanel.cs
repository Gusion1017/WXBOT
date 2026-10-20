using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

/// <summary>
/// WXBOT 桌面版设置窗口：AI 人格、白名单、回复频率、模型与发送通道。
/// 保存写回 config/app.json 与 config/persona.md；可选择立即重启后台服务生效。
/// </summary>
internal sealed class SettingsPanel : UserControl
{
    private static readonly Color Bg = UiTheme.Bg;
    private static readonly Color PanelBg = UiTheme.PanelBg;
    private static readonly Color PanelBg2 = UiTheme.PanelBg2;
    private static readonly Color Line = UiTheme.Line;
    private static readonly Color Muted = UiTheme.Muted;
    private static readonly Color Accent = UiTheme.Accent;

    private readonly string root;
    private readonly string configPath;
    private string personaPath = string.Empty;

    private CheckBox autoReplyBox;
    private CheckBox whitelistEnabledBox;
    private CheckBox showImagesCheckBox;
    private TextBox privateWhitelistBox;
    private TextBox groupWhitelistBox;

    private NumericUpDown privateIntervalBox;
    private NumericUpDown groupIntervalBox;
    private NumericUpDown perMinuteBox;
    private NumericUpDown perTenMinuteBox;
    private NumericUpDown debounceBox;
    private NumericUpDown maxConcurrentBox;
    private NumericUpDown pendingDelayBox;
    private ComboBox groupModeBox;
    private TextBox wakeWordsBox;

    private CheckBox modelEnabledBox;
    private TextBox providerBox;
    private TextBox baseUrlBox;
    private TextBox modelBox;
    private NumericUpDown temperatureBox;
    private NumericUpDown maxTokensBox;
    private TextBox personaBox;
    private Label personaPathLabel;

    private CheckBox senderEnabledBox;
    private NumericUpDown bufferBox;
    private CheckBox restartBox;

    private TextBox apiKeyBox;
    private CheckBox apiKeyShowBox;
    private NumericUpDown apiTimeoutBox;
    private RoundButton testApiButton;
    private Label testApiResult;
    private string apiKeyPath = string.Empty;

    private Dictionary<string, object> config;
    private Panel pagesContainer;
    private readonly List<Control> pages = new List<Control>();
    private readonly List<RoundButton> tabButtons = new List<RoundButton>();
    private int currentTab = -1;
    private Label saveStatusLabel;

    /// <summary>保存成功后触发（主窗口据此关闭设置面板并刷新）。</summary>
    public event EventHandler Saved;
    /// <summary>本次保存是否请求重启后台服务（由主窗口异步执行，避免阻塞 UI）。</summary>
    public bool RestartRequested { get; private set; }
    /// <summary>点「取消」时触发。</summary>
    public event EventHandler Cancelled;

    public SettingsPanel(string root, int initialTab = 0)
    {
        this.root = root;
        configPath = Path.Combine(root, "config", "app.json");
        if (!File.Exists(configPath)) { throw new FileNotFoundException("缺少 config\\app.json，请先初始化项目", configPath); }
        config = LoadJson(configPath);
        personaPath = ResolvePersonaPath(config);
        Dock = DockStyle.Fill;
        BackColor = Bg;
        ForeColor = Color.White;
        Font = new Font("Microsoft YaHei UI", 9F);
        BuildUi();
        FillFromConfig();
        SelectTab(initialTab);
    }

    /// <summary>重新读取 config/app.json 并刷新控件值（内嵌面板复用时调用）。</summary>
    public void ReloadFromConfig()
    {
        config = LoadJson(configPath);
        personaPath = ResolvePersonaPath(config);
        FillFromConfig();
    }

    private void BuildUi()
    {
        Panel nav = new Panel
        {
            Dock = DockStyle.Top,
            Height = 52,
            BackColor = PanelBg,
            Padding = new Padding(10, 9, 10, 0),
        };
        string[] titles = { "基本", "回复频率", "AI 与人格", "API", "高级", "表情包" };
        for (int i = 0; i < titles.Length; i++)
        {
            int index = i;
            RoundButton button = new RoundButton
            {
                Text = titles[i],
                AutoSize = false,
                Width = 116,
                Height = 34,
                Radius = 9,
                Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold),
                NormalBack = PanelBg2,
                HoverBack = UiTheme.PanelBg3,
                PressedBack = UiTheme.AccentDark,
                BorderColor = UiTheme.Line,
                ForeColor = UiTheme.Muted,
                Location = new Point(10 + i * 122, 9),
            };
            button.Click += (s, e) => SelectTab(index);
            nav.Controls.Add(button);
            tabButtons.Add(button);
        }

        Panel content = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = PanelBg,
            AutoScroll = true,
            Padding = new Padding(0),
        };
        pagesContainer = content;
        List<Control> pageList = new List<Control>
        {
            BuildBasicPage(), BuildRatePage(), BuildAiPage(), BuildApiPage(), BuildAdvancedPage()
        };
        try
        {
            pageList.Add(new StickerManagerPanel(root));
        }
        catch (Exception error)
        {
            Panel fallback = new Panel { Dock = DockStyle.Fill, BackColor = PanelBg, Padding = new Padding(18) };
            Label warning = new Label
            {
                Dock = DockStyle.Top,
                Height = 120,
                ForeColor = UiTheme.Err,
                Text = "表情包页加载失败：" + error.Message,
            };
            fallback.Controls.Add(warning);
            pageList.Add(fallback);
        }
        Control[] builtPages = pageList.ToArray();
        foreach (Control page in builtPages)
        {
            page.Visible = false;
            pages.Add(page);
            content.Controls.Add(page);
        }
        SlimScrollArea scroll = SlimScrollArea.Create(content);
        scroll.Dock = DockStyle.Fill;

        Panel bottom = new Panel { Dock = DockStyle.Bottom, Height = 56, BackColor = PanelBg, Padding = new Padding(12, 10, 12, 8) };
        restartBox = new CheckBox
        {
            Text = "保存后立即重启后台服务使配置生效",
            Checked = true,
            AutoSize = true,
            FlatStyle = FlatStyle.Flat,
            ForeColor = UiTheme.TextSoft,
            Location = new Point(64, 16),
        };
        WhaleMascotControl footerMascot = new WhaleMascotControl
        {
            Size = new Size(36, 36),
            Location = new Point(14, 9),
            ShowGlow = true,
            Simplified = true,
            BackColor = PanelBg,
        };
        RoundButton save = new RoundButton
        {
            Text = "保存",
            Width = 100,
            Height = 34,
            NormalBack = UiTheme.Accent,
            HoverBack = UiTheme.AccentBright,
            PressedBack = UiTheme.AccentDark,
            BorderColor = Color.FromArgb(150, 180, 255),
            ForeColor = Color.White,
            Anchor = AnchorStyles.Right | AnchorStyles.Top,
            Location = new Point(bottom.Width - 232, 10),
        };
        save.FlatAppearance.BorderSize = 0;
        save.Click += (s, e) => SaveSettings();
        RoundButton cancel = new RoundButton
        {
            Text = "取消",
            Width = 100,
            Height = 34,
            NormalBack = PanelBg2,
            HoverBack = UiTheme.PanelBg3,
            PressedBack = UiTheme.AccentDark,
            BorderColor = Line,
            ForeColor = UiTheme.TextSoft,
            Anchor = AnchorStyles.Right | AnchorStyles.Top,
            Location = new Point(bottom.Width - 120, 10),
        };
        cancel.Click += (s, e) => { if (Cancelled != null) { Cancelled(this, EventArgs.Empty); } };
        saveStatusLabel = new Label
        {
            Text = "",
            AutoSize = true,
            ForeColor = UiTheme.Muted,
            Location = new Point(360, 19),
        };
        bottom.Controls.Add(footerMascot);
        bottom.Controls.Add(restartBox);
        bottom.Controls.Add(saveStatusLabel);
        bottom.Controls.Add(save);
        bottom.Controls.Add(cancel);
        bottom.Resize += (s, e) =>
        {
            save.Left = bottom.Width - 232;
            cancel.Left = bottom.Width - 120;
        };

        Controls.Add(scroll);
        Controls.Add(nav);
        Controls.Add(bottom);
        SelectTab(0);
    }

    public void SelectTab(int index)
    {
        if (index < 0 || index >= pages.Count) { index = 0; }
        currentTab = index;
        for (int i = 0; i < pages.Count; i++)
        {
            pages[i].Visible = i == index;
            RoundButton button = i < tabButtons.Count ? tabButtons[i] : null;
            if (button == null) { continue; }
            bool selected = i == index;
            button.NormalBack = selected ? UiTheme.Accent : PanelBg2;
            button.HoverBack = selected ? UiTheme.AccentBright : UiTheme.PanelBg3;
            button.BorderColor = selected ? Color.FromArgb(150, 180, 255) : UiTheme.Line;
            button.ForeColor = selected ? Color.White : UiTheme.Muted;
            button.Invalidate();
        }
        if (pagesContainer != null)
        {
            pagesContainer.AutoScrollPosition = new Point(0, 0);
        }
    }

    private Panel NewPage(string title)
    {
        Panel page = new Panel
        {
            BackColor = PanelBg,
            ForeColor = UiTheme.TextColor,
            Padding = new Padding(16, 12, 16, 12),
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
        };
        WhaleMascotControl pageMascot = new WhaleMascotControl
        {
            Size = new Size(30, 30),
            Anchor = AnchorStyles.Bottom | AnchorStyles.Right,
            ShowGlow = false,
            Simplified = true,
            BackColor = PanelBg,
        };
        page.Resize += (s, e) => { pageMascot.Location = new Point(Math.Max(0, page.ClientSize.Width - 44), Math.Max(0, page.ClientSize.Height - 44)); };
        page.Controls.Add(pageMascot);
        return page;
    }

    private TableLayoutPanel NewTable(int labelWidth)
    {
        TableLayoutPanel table = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 2,
            BackColor = PanelBg,
            Padding = new Padding(0, 4, 0, 4),
        };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, labelWidth));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        return table;
    }

    private void AddRow(TableLayoutPanel table, string label, Control control, int height = 30)
    {
        int row = table.RowCount;
        Label caption = new Label
        {
            Text = label,
            ForeColor = Muted,
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 8, 8, 6),
        };
        Control cell = control;
        TextBox textBox = control as TextBox;
        if (textBox != null && textBox.Multiline && height > 30)
        {
            control.Dock = DockStyle.Fill;
            control.Height = height;
            SlimScrollArea area = SlimScrollArea.Create(control);
            area.Dock = DockStyle.Fill;
            area.Height = height;
            area.MinimumSize = new Size(80, height);
            area.Margin = new Padding(0, 4, 0, 4);
            cell = area;
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, height + 10));
        }
        else
        {
            control.Anchor = AnchorStyles.Left | AnchorStyles.Right;
            control.Margin = new Padding(0, 4, 0, 4);
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }
        table.RowCount = row + 1;
        table.Controls.Add(caption, 0, row);
        table.Controls.Add(cell, 1, row);
    }

    private void AddHint(TableLayoutPanel table, string text)
    {
        int row = table.RowCount;
        Label hint = new Label
        {
            Text = text,
            ForeColor = Muted,
            AutoSize = true,
            MaximumSize = new Size(660, 0),
            Margin = new Padding(0, 2, 0, 8),
        };
        table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        table.RowCount = row + 1;
        table.Controls.Add(new Label(), 0, row);
        table.Controls.Add(hint, 1, row);
    }

    private TextBox NewTextBox(string value, bool multiline = false, int height = 30)
    {
        return new TextBox
        {
            Text = value,
            Multiline = multiline,
            Height = height,
            ScrollBars = multiline ? ScrollBars.Vertical : ScrollBars.None,
            BackColor = PanelBg2,
            ForeColor = UiTheme.TextColor,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Microsoft YaHei UI", 9F),
        };
    }

    private CheckBox NewCheckBox(string text, bool value)
    {
        return new CheckBox
        {
            Text = text,
            Checked = value,
            AutoSize = true,
            FlatStyle = FlatStyle.Flat,
            ForeColor = UiTheme.TextSoft,
            Margin = new Padding(0, 6, 0, 6),
        };
    }

    private NumericUpDown NewNumber(decimal value, decimal min, decimal max, decimal step, int decimals = 0)
    {
        NumericUpDown box = new NumericUpDown
        {
            Minimum = min,
            Maximum = max,
            Increment = step,
            DecimalPlaces = decimals,
            Width = 140,
            BackColor = PanelBg2,
            ForeColor = UiTheme.TextColor,
            BorderStyle = BorderStyle.FixedSingle,
        };
        box.Value = Math.Min(max, Math.Max(min, value));
        return box;
    }

    private Panel BuildBasicPage()
    {
        Panel page = NewPage("基本");
        TableLayoutPanel table = NewTable(150);
        autoReplyBox = NewCheckBox("启用自动回复（bridge.autoReply）", false);
        whitelistEnabledBox = NewCheckBox("启用白名单（关闭后放行所有会话，慎用）", true);
        showImagesCheckBox = NewCheckBox("在聊天中显示图片缩略图（desktop.showImages）", true);
        privateWhitelistBox = NewTextBox(string.Empty, true, 90);
        groupWhitelistBox = NewTextBox(string.Empty, true, 70);
        AddRow(table, "自动回复", autoReplyBox);
        AddRow(table, "白名单启用", whitelistEnabledBox);
        AddRow(table, "显示图片", showImagesCheckBox);
        AddRow(table, "私聊白名单", privateWhitelistBox, 90);
        AddRow(table, "群白名单", groupWhitelistBox, 70);
        AddHint(table, "私聊：每行一个微信 wxid（如 wxid_xxxx）。\n群：每行一个群名（不带成员数尾巴，如 项目群）。\n只处理白名单内会话的入站与发送；改动需重启服务生效。\n「显示图片」只影响桌面聊天区的缩略图显示，不影响读取/发送。");
        page.Controls.Add(table);
        return page;
    }

    private Panel BuildRatePage()
    {
        Panel page = NewPage("回复频率");
        TableLayoutPanel table = NewTable(170);
        privateIntervalBox = NewNumber(1000, 0, 600000, 100);
        groupIntervalBox = NewNumber(15000, 0, 600000, 1000);
        perMinuteBox = NewNumber(3, 0, 1000, 1);
        perTenMinuteBox = NewNumber(10, 0, 10000, 1);
        debounceBox = NewNumber(3000, 0, 60000, 100);
        maxConcurrentBox = NewNumber(4, 1, 32, 1);
        pendingDelayBox = new NumericUpDown
        {
            Minimum = 0, Maximum = 600000, Increment = 1000,
            BackColor = PanelBg2, ForeColor = Color.White, BorderStyle = BorderStyle.FixedSingle,
        };
        pendingDelayBox.Value = 30000;
        pendingDelayBox.Width = 140;
        groupModeBox = new ComboBox
        {
            DropDownStyle = ComboBoxStyle.DropDownList,
            BackColor = PanelBg2,
            ForeColor = Color.White,
            Width = 160,
        };
        groupModeBox.Items.AddRange(new object[] { "hybrid（去抖后回复）", "mention（仅被 @/唤醒才回复）" });
        wakeWordsBox = NewTextBox(string.Empty);
        AddRow(table, "私聊最小间隔(ms)", privateIntervalBox);
        AddRow(table, "群最小间隔(ms)", groupIntervalBox);
        AddRow(table, "每分钟上限", perMinuteBox);
        AddRow(table, "每 10 分钟上限", perTenMinuteBox);
        AddRow(table, "去抖时间(ms)", debounceBox);
        AddRow(table, "并发上限", maxConcurrentBox);
        AddRow(table, "pending 回放延迟(ms)", pendingDelayBox);
        AddRow(table, "群回复模式", groupModeBox);
        AddRow(table, "唤醒词（逗号分隔）", wakeWordsBox);
        AddHint(table, "限流用于防止刷屏/封号风险：私聊 1s、群 15s、3 条/分、10 条/10 分是默认值；\n0 表示不限制对应项（不建议全开）。");
        page.Controls.Add(table);
        return page;
    }

    private Panel BuildAiPage()
    {
        Panel page = NewPage("AI 与人格");
        page.AutoScroll = true;
        TableLayoutPanel table = NewTable(150);
        modelEnabledBox = NewCheckBox("启用模型（model.enabled）", true);
        providerBox = NewTextBox("deepseek");
        baseUrlBox = NewTextBox("https://api.deepseek.com");
        modelBox = NewTextBox("deepseek-chat");
        temperatureBox = NewNumber(1.0m, 0m, 2m, 0.1m, 1);
        maxTokensBox = NewNumber(200, 1, 8000, 50);
        personaBox = NewTextBox(string.Empty, true, 250);
        personaPathLabel = new Label
        {
            Text = "人格文件：" + personaPath,
            ForeColor = Muted,
            AutoSize = true,
            MaximumSize = new Size(680, 0),
            Margin = new Padding(0, 2, 0, 4),
        };
        AddRow(table, "模型启用", modelEnabledBox);
        AddRow(table, "provider", providerBox);
        AddRow(table, "baseUrl", baseUrlBox);
        AddRow(table, "model", modelBox);
        AddRow(table, "temperature", temperatureBox);
        AddRow(table, "maxTokens", maxTokensBox);
        AddRow(table, "人格文本", personaBox, 250);
        AddRow(table, "", personaPathLabel);
        AddHint(table, "输出协议：模型只能回复 SILENT 或 RESPOND: <短回复>；聊天内容以不可信数据包裹。\n保存会覆盖人格文件；回复频率、白名单等改动同样在重启服务后生效。");
        page.Controls.Add(table);
        return page;
    }

    private Panel BuildApiPage()
    {
        Panel page = NewPage("API");
        page.AutoScroll = true;
        TableLayoutPanel table = NewTable(150);
        apiKeyBox = new TextBox
        {
            UseSystemPasswordChar = true,
            BackColor = PanelBg2,
            ForeColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Consolas", 10F),
        };
        apiKeyShowBox = new CheckBox
        {
            Text = "显示明文",
            AutoSize = true,
            ForeColor = Muted,
            Margin = new Padding(0, 2, 0, 4),
        };
        apiKeyShowBox.CheckedChanged += (s, e) => { apiKeyBox.UseSystemPasswordChar = !apiKeyShowBox.Checked; };
        apiTimeoutBox = new NumericUpDown
        {
            Minimum = 1000,
            Maximum = 600000,
            Increment = 1000,
            Width = 140,
            BackColor = PanelBg2,
            ForeColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
        };
        apiTimeoutBox.Value = 120000;
        testApiButton = new RoundButton
        {
            Text = "测试连接",
            Left = 0,
            Top = 0,
        };
        testApiButton.Click += (s, e) => TestApiConnection();
        testApiResult = new Label
        {
            Text = "未测试",
            ForeColor = Muted,
            AutoSize = true,
            MaximumSize = new Size(560, 0),
        };
        AddRow(table, "API Key", apiKeyBox);
        AddRow(table, "", apiKeyShowBox);
        AddRow(table, "超时(ms)", apiTimeoutBox);
        AddRow(table, "连接测试", testApiButton);
        AddRow(table, "", testApiResult);
        AddHint(table, "API Key 保存到 " + ApiKeyPathLabel() + "（仅当前用户可读）。\nprovider / baseUrl / model 在「AI 与人格」页调整；保存后建议重启服务使新 Key 生效。");
        page.Controls.Add(table);
        return page;
    }

    private string ApiKeyPathLabel()
    {
        if (string.IsNullOrEmpty(apiKeyPath))
        {
            Dictionary<string, object> model = EnsureDict(config, "model");
            string relative = GetString(model, "apiKeyFile", "state/model-key.txt");
            apiKeyPath = Path.IsPathRooted(relative) ? relative : Path.Combine(root, relative.Replace('/', '\\'));
        }
        return apiKeyPath;
    }

    private Panel BuildAdvancedPage()
    {
        Panel page = NewPage("高级");
        TableLayoutPanel table = NewTable(170);
        senderEnabledBox = NewCheckBox("启用发送通道（sender.enabled）", true);
        bufferBox = NewNumber(300, 10, 2000, 10);
        AddRow(table, "发送通道", senderEnabledBox);
        AddRow(table, "每会话缓冲条数", bufferBox);
        AddHint(table, "发送通道关闭后只读不回复；读取层/控制台仍可用。\n修改 Hook 版本、数据目录等机器相关配置请直接编辑 config/app.json。");
        page.Controls.Add(table);
        return page;
    }

    private void FillFromConfig()
    {
        Dictionary<string, object> bridge = EnsureDict(config, "bridge");
        Dictionary<string, object> wechat = EnsureDict(config, "wechat");
        Dictionary<string, object> whitelist = EnsureDict(wechat, "whitelist");
        Dictionary<string, object> model = EnsureDict(config, "model");
        Dictionary<string, object> sender = EnsureDict(config, "sender");
        Dictionary<string, object> desktop = EnsureDict(config, "desktop");

        autoReplyBox.Checked = GetBool(bridge, "autoReply", false);
        whitelistEnabledBox.Checked = GetBool(whitelist, "enabled", true);
        showImagesCheckBox.Checked = GetBool(desktop, "showImages", true);
        privateWhitelistBox.Text = string.Join("\r\n", GetStringArray(whitelist, "private"));
        groupWhitelistBox.Text = string.Join("\r\n", GetStringArray(whitelist, "groups"));

        privateIntervalBox.Value = Clamp(GetDecimal(bridge, "minIntervalPrivateMs", 1000), privateIntervalBox);
        groupIntervalBox.Value = Clamp(GetDecimal(bridge, "minIntervalGroupMs", 15000), groupIntervalBox);
        perMinuteBox.Value = Clamp(GetDecimal(bridge, "perMinute", 3), perMinuteBox);
        perTenMinuteBox.Value = Clamp(GetDecimal(bridge, "perTenMinute", 10), perTenMinuteBox);
        debounceBox.Value = Clamp(GetDecimal(bridge, "debounceMs", 3000), debounceBox);
        maxConcurrentBox.Value = Clamp(GetDecimal(bridge, "maxConcurrent", 4), maxConcurrentBox);
        pendingDelayBox.Value = Clamp(GetDecimal(bridge, "pendingReplayDelayMs", 30000), pendingDelayBox);
        string groupMode = GetString(bridge, "groupMode", "hybrid");
        groupModeBox.SelectedIndex = groupMode == "mention" ? 1 : 0;
        wakeWordsBox.Text = string.Join(",", GetStringArray(bridge, "wakeWords"));

        modelEnabledBox.Checked = GetBool(model, "enabled", false);
        providerBox.Text = GetString(model, "provider", "deepseek");
        baseUrlBox.Text = GetString(model, "baseUrl", "https://api.deepseek.com");
        modelBox.Text = GetString(model, "model", "deepseek-chat");
        temperatureBox.Value = Clamp(GetDecimal(model, "temperature", 1.0m), temperatureBox);
        maxTokensBox.Value = Clamp(GetDecimal(model, "maxTokens", 200), maxTokensBox);
        apiTimeoutBox.Value = Clamp(GetDecimal(model, "timeoutMs", 120000), apiTimeoutBox);
        apiKeyBox.Text = ReadApiKey();
        personaBox.Text = ReadPersona();

        senderEnabledBox.Checked = GetBool(sender, "enabled", true);
        bufferBox.Value = Clamp(GetDecimal(bridge, "bufferPerChat", 300), bufferBox);
    }

    private void SaveSettings()
    {
        try
        {
            Dictionary<string, object> fresh = BuildUpdatedConfig();
            WriteConfig(configPath, fresh);
            WritePersona(personaBox.Text);
            WriteApiKey(apiKeyBox.Text);
            RestartRequested = restartBox.Checked;
            saveStatusLabel.Text = RestartRequested ? "已保存，正在重启后台服务…" : "已保存（部分配置重启后生效）";
            saveStatusLabel.ForeColor = UiTheme.Ok;
            if (Saved != null) { Saved(this, EventArgs.Empty); }
        }
        catch (Exception error)
        {
            string detail = error.Message.Length > 160 ? error.Message.Substring(0, 160) : error.Message;
            saveStatusLabel.Text = "保存失败：" + detail;
            saveStatusLabel.ForeColor = UiTheme.Err;
        }
    }

    /// <summary>把当前表单值实际写入 config/persona（用于自检；值未变时等同于原样回写）。</summary>
    internal string ApplyToDisk()
    {
        Dictionary<string, object> updated = BuildUpdatedConfig();
        WriteConfig(configPath, updated);
        WritePersona(personaBox.Text);
        WriteApiKey(apiKeyBox.Text);
        return "SETTINGS_APPLY_OK config=" + configPath + " persona=" + personaPath + " apiKeyFile=" + ApiKeyPathLabel();
    }

    /// <summary>把界面上的值写回一份配置字典（保留原有未知字段）。</summary>
    internal Dictionary<string, object> BuildUpdatedConfig()
    {
        Dictionary<string, object> fresh = LoadJson(configPath);
        Dictionary<string, object> bridge = EnsureDict(fresh, "bridge");
        Dictionary<string, object> wechat = EnsureDict(fresh, "wechat");
        Dictionary<string, object> whitelist = EnsureDict(wechat, "whitelist");
        Dictionary<string, object> model = EnsureDict(fresh, "model");
        Dictionary<string, object> sender = EnsureDict(fresh, "sender");
        Dictionary<string, object> desktop = EnsureDict(fresh, "desktop");

        bridge["autoReply"] = autoReplyBox.Checked;
        desktop["showImages"] = showImagesCheckBox.Checked;
        whitelist["enabled"] = whitelistEnabledBox.Checked;
        whitelist["private"] = SplitLines(privateWhitelistBox.Text);
        whitelist["groups"] = SplitLines(groupWhitelistBox.Text);

        bridge["minIntervalPrivateMs"] = (long)privateIntervalBox.Value;
        bridge["minIntervalGroupMs"] = (long)groupIntervalBox.Value;
        bridge["perMinute"] = (int)perMinuteBox.Value;
        bridge["perTenMinute"] = (int)perTenMinuteBox.Value;
        bridge["debounceMs"] = (long)debounceBox.Value;
        bridge["maxConcurrent"] = (int)maxConcurrentBox.Value;
        bridge["pendingReplayDelayMs"] = (long)pendingDelayBox.Value;
        bridge["bufferPerChat"] = (int)bufferBox.Value;
        bridge["groupMode"] = groupModeBox.SelectedIndex == 1 ? "mention" : "hybrid";
        bridge["wakeWords"] = SplitComma(wakeWordsBox.Text);

        model["enabled"] = modelEnabledBox.Checked;
        model["provider"] = providerBox.Text.Trim();
        model["baseUrl"] = baseUrlBox.Text.Trim();
        model["model"] = modelBox.Text.Trim();
        model["temperature"] = (double)temperatureBox.Value;
        model["maxTokens"] = (int)maxTokensBox.Value;
        model["timeoutMs"] = (long)apiTimeoutBox.Value;

        sender["enabled"] = senderEnabledBox.Checked;
        return fresh;
    }

    /// <summary>序列化写入配置文件（UTF-8 无 BOM）。</summary>
    internal static void WriteConfig(string path, Dictionary<string, object> config)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        string json = serializer.Serialize(config);
        File.WriteAllText(path, json, new UTF8Encoding(false));
    }

    private string ReadPersona()
    {
        try
        {
            return File.Exists(personaPath) ? File.ReadAllText(personaPath, Encoding.UTF8) : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private string ReadApiKey()
    {
        try
        {
            string path = ApiKeyPathLabel();
            return File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8).Trim() : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private void WriteApiKey(string value)
    {
        string path = ApiKeyPathLabel();
        string directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) { Directory.CreateDirectory(directory); }
        File.WriteAllText(path, (value ?? string.Empty).Trim() + "\r\n", new UTF8Encoding(false));
        try
        {
            ProcessStartInfo info = new ProcessStartInfo("icacls.exe",
                "\"" + path + "\" /inheritance:r /grant:r \"" + Environment.UserName + ":F\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using (Process process = Process.Start(info)) { process.WaitForExit(5000); }
        }
        catch { }
    }

    /// <summary>调用模型 API 做一次连接测试（异步，不阻塞 UI）。</summary>
    private void TestApiConnection()
    {
        string baseUrl = baseUrlBox.Text.Trim().TrimEnd('/');
        string modelName = modelBox.Text.Trim();
        string key = apiKeyBox.Text.Trim();
        if (baseUrl.Length == 0 || modelName.Length == 0 || key.Length == 0)
        {
            testApiResult.Text = "请先填写 baseUrl / model / API Key";
            testApiResult.ForeColor = UiTheme.Warn;
            return;
        }
        testApiButton.Enabled = false;
        testApiResult.Text = "测试中…";
        testApiResult.ForeColor = UiTheme.Muted;
        JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["model"] = modelName;
        payload["max_tokens"] = 8;
        payload["temperature"] = 0;
        payload["messages"] = new object[]
        {
            new Dictionary<string, object> { { "role", "user" }, { "content", "ping" } },
        };
        string body = serializer.Serialize(payload);
        Task.Run(() =>
        {
            Stopwatch watch = Stopwatch.StartNew();
            string message;
            Color color;
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(baseUrl + "/chat/completions");
                request.Method = "POST";
                request.Timeout = 20000;
                request.ContentType = "application/json";
                request.Headers["Authorization"] = "Bearer " + key;
                byte[] bytes = Encoding.UTF8.GetBytes(body);
                request.ContentLength = bytes.Length;
                using (Stream stream = request.GetRequestStream()) { stream.Write(bytes, 0, bytes.Length); }
                using (WebResponse response = request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    string raw = reader.ReadToEnd();
                    message = "连接成功（" + watch.ElapsedMilliseconds + "ms，响应 " + raw.Length + " 字节）";
                    color = UiTheme.Ok;
                }
            }
            catch (Exception error)
            {
                message = "连接失败：" + error.Message;
                color = UiTheme.Err;
            }
            try
            {
                BeginInvoke(new Action(() =>
                {
                    testApiResult.Text = message;
                    testApiResult.ForeColor = color;
                    testApiButton.Enabled = true;
                }));
            }
            catch { }
        });
    }

    private void WritePersona(string text)
    {
        if (string.IsNullOrEmpty(personaPath)) { return; }
        string directory = Path.GetDirectoryName(personaPath);
        if (!string.IsNullOrEmpty(directory)) { Directory.CreateDirectory(directory); }
        File.WriteAllText(personaPath, text ?? string.Empty, new UTF8Encoding(false));
    }

    private string ResolvePersonaPath(Dictionary<string, object> configValue)
    {
        Dictionary<string, object> model = EnsureDict(configValue, "model");
        string relative = GetString(model, "personaFile", "config/persona.md");
        return Path.IsPathRooted(relative) ? relative : Path.Combine(root, relative.Replace('/', '\\'));
    }

    /// <summary>设置读写自检（不修改真实配置）。</summary>
    public static string SelfTest(string root)
    {
        string configPath = Path.Combine(root, "config", "app.json");
        if (!File.Exists(configPath)) { throw new FileNotFoundException("缺少 config/app.json", configPath); }
        SettingsPanel form = new SettingsPanel(root);
        Dictionary<string, object> updated = form.BuildUpdatedConfig();
        string tempConfig = Path.Combine(root, "state", "settings-selftest.json");
        Directory.CreateDirectory(Path.GetDirectoryName(tempConfig));
        WriteConfig(tempConfig, updated);
        string verify = File.ReadAllText(tempConfig, Encoding.UTF8);
        JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        Dictionary<string, object> parsed = serializer.DeserializeObject(verify) as Dictionary<string, object>;
        File.Delete(tempConfig);
        if (parsed == null) { throw new InvalidDataException("序列化回读失败"); }
        Dictionary<string, object> bridge = parsed.ContainsKey("bridge") ? parsed["bridge"] as Dictionary<string, object> : null;
        Dictionary<string, object> wechat = parsed.ContainsKey("wechat") ? parsed["wechat"] as Dictionary<string, object> : null;
        Dictionary<string, object> whitelist = wechat != null && wechat.ContainsKey("whitelist") ? wechat["whitelist"] as Dictionary<string, object> : null;
        string personaFile = GetString(EnsureDict(parsed, "model"), "personaFile", "config/persona.md");
        string personaPath = Path.IsPathRooted(personaFile) ? personaFile : Path.Combine(root, personaFile.Replace('/', '\\'));
        int personaChars = File.Exists(personaPath) ? File.ReadAllText(personaPath, Encoding.UTF8).Length : 0;
        form.Dispose();
        return "SETTINGS_SELFTEST_OK config=" + configPath
            + " autoReply=" + GetBool(bridge, "autoReply", false)
            + " whitelistEnabled=" + GetBool(whitelist, "enabled", true)
            + " whitelistPrivate=" + GetStringArray(whitelist, "private").Count
            + " personaChars=" + personaChars
            + " apiKeyChars=" + form.ReadApiKey().Length
            + " tempWrite=ok";
    }

    // ---------- JSON 小工具 ----------

    private static Dictionary<string, object> LoadJson(string path)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        object parsed = serializer.DeserializeObject(File.ReadAllText(path, Encoding.UTF8));
        Dictionary<string, object> root = parsed as Dictionary<string, object>;
        if (root == null) { throw new InvalidDataException("配置不是 JSON 对象：" + path); }
        return root;
    }

    private static Dictionary<string, object> EnsureDict(Dictionary<string, object> parent, string key)
    {
        if (parent == null) { return new Dictionary<string, object>(); }
        object existing;
        if (parent.TryGetValue(key, out existing))
        {
            Dictionary<string, object> dict = existing as Dictionary<string, object>;
            if (dict != null) { return dict; }
        }
        Dictionary<string, object> created = new Dictionary<string, object>();
        parent[key] = created;
        return created;
    }

    private static string GetString(Dictionary<string, object> dict, string key, string fallback)
    {
        if (dict == null) { return fallback; }
        object value;
        return dict.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback;
    }

    private static bool GetBool(Dictionary<string, object> dict, string key, bool fallback)
    {
        if (dict == null) { return fallback; }
        object value;
        if (!dict.TryGetValue(key, out value) || value == null) { return fallback; }
        try { return Convert.ToBoolean(value); } catch { return fallback; }
    }

    private static decimal GetDecimal(Dictionary<string, object> dict, string key, decimal fallback)
    {
        if (dict == null) { return fallback; }
        object value;
        if (!dict.TryGetValue(key, out value) || value == null) { return fallback; }
        try { return Convert.ToDecimal(value); } catch { return fallback; }
    }

    private static List<string> GetStringArray(Dictionary<string, object> dict, string key)
    {
        List<string> list = new List<string>();
        if (dict == null) { return list; }
        object value;
        if (!dict.TryGetValue(key, out value) || value == null) { return list; }
        object[] array = value as object[];
        if (array == null) { return list; }
        foreach (object item in array)
        {
            string text = Convert.ToString(item);
            if (!string.IsNullOrWhiteSpace(text)) { list.Add(text.Trim()); }
        }
        return list;
    }

    private static object[] SplitLines(string text)
    {
        List<string> result = new List<string>();
        foreach (string line in (text ?? string.Empty).Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string trimmed = line.Trim();
            if (trimmed.Length > 0) { result.Add(trimmed); }
        }
        return result.ToArray();
    }

    private static object[] SplitComma(string text)
    {
        List<string> result = new List<string>();
        foreach (string part in (text ?? string.Empty).Split(new[] { ',', '，', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string trimmed = part.Trim();
            if (trimmed.Length > 0) { result.Add(trimmed); }
        }
        return result.ToArray();
    }

    private static decimal Clamp(decimal value, NumericUpDown control)
    {
        if (value < control.Minimum) { return control.Minimum; }
        if (value > control.Maximum) { return control.Maximum; }
        return value;
    }
}
