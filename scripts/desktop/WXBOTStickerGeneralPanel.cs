using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

/// <summary>
/// 表情包「通用设置」：总开关、选择方式、群聊、冷却、每小时上限、模型使用提示。
/// 保存写入 config/app.json 的 sticker 字段；bridge 下一次回复动态读取，无需重启。
/// </summary>
internal sealed class StickerGeneralPanel : UserControl
{
    private static readonly Color Bg = UiTheme.Bg;
    private static readonly Color PanelBg = UiTheme.PanelBg;
    private static readonly Color PanelBg2 = UiTheme.PanelBg2;
    private static readonly Color Muted = UiTheme.Muted;
    private static readonly Color Ok = UiTheme.Ok;
    private static readonly Color Err = UiTheme.Err;

    private readonly string root;
    private readonly string configPath;
    private readonly JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    private CheckBox enabledBox;
    private ComboBox modeBox;
    private CheckBox groupsBox;
    private NumericUpDown cooldownBox;
    private NumericUpDown maxHourBox;
    private TextBox guidanceBox;
    private Label statusLabel;

    public event EventHandler BackRequested;
    public event EventHandler Saved;

    public StickerGeneralPanel(string root)
    {
        this.root = root;
        configPath = Path.Combine(root, "config", "app.json");
        Dock = DockStyle.Fill;
        BackColor = Bg;
        ForeColor = Color.White;
        Font = new Font("Microsoft YaHei UI", 9F);
        AutoScroll = true;
        BuildUi();
        ReloadFromConfig();
    }

    private void BuildUi()
    {
        Label title = new Label
        {
            Text = "表情包通用设置",
            AutoSize = true,
            ForeColor = UiTheme.TextColor,
            Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold),
            Location = new Point(0, 2),
        };
        Label hint = new Label
        {
            Text = "这些设置决定模型是否、何时可以使用表情包；保存后后台下一次回复自动读取，无需重启。",
            AutoSize = true,
            ForeColor = Muted,
            Font = new Font("Microsoft YaHei UI", 8.5F),
            Location = new Point(0, 30),
        };
        Controls.Add(title);
        Controls.Add(hint);

        enabledBox = NewCheckBox("启用表情包发送（关闭后模型完全不会选择表情）", 0, 46);
        Controls.Add(enabledBox);

        Label modeLabel = NewLabel("选择方式", 0, 74);
        Controls.Add(modeLabel);
        modeBox = new ComboBox
        {
            Location = new Point(0, 92),
            Width = 360,
            DropDownStyle = ComboBoxStyle.DropDownList,
            BackColor = PanelBg2,
            ForeColor = Color.White,
            Font = new Font("Microsoft YaHei UI", 9F),
        };
        modeBox.Items.AddRange(new object[] { "智能自动（由模型按聊天氛围选择）", "仅明确要求（对方要表情/图片时才提供）" });
        Controls.Add(modeBox);

        groupsBox = NewCheckBox("允许在群聊使用表情（仍受 @ / 唤醒词直呼限制）", 0, 122);
        Controls.Add(groupsBox);

        Label cooldownLabel = NewLabel("同一会话冷却（秒）", 0, 150);
        Controls.Add(cooldownLabel);
        cooldownBox = NewNumber(60, 0, 3600, 10, 160, 146);
        Controls.Add(cooldownBox);

        Label maxHourLabel = NewLabel("每小时最多发送（0 = 不限）", 0, 180);
        Controls.Add(maxHourLabel);
        maxHourBox = NewNumber(10, 0, 3600, 1, 160, 176);
        Controls.Add(maxHourBox);

        Label guidanceLabel = NewLabel("使用提示（会注入模型提示词，可描述你希望的使用风格）", 0, 212);
        Controls.Add(guidanceLabel);
        guidanceBox = new TextBox
        {
            Location = new Point(0, 230),
            Width = 520,
            Height = 58,
            Multiline = true,
            ScrollBars = ScrollBars.Vertical,
            BackColor = PanelBg2,
            ForeColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
        };
        Controls.Add(guidanceBox);

        RoundButton saveButton = NewButton("保存通用设置", Color.FromArgb(60, 140, 90), 0, 298, 128);
        saveButton.Click += (s, e) => SaveGeneralSettings();
        Controls.Add(saveButton);

        RoundButton backButton = NewButton("返回表情库", PanelBg2, 138, 298, 108);
        backButton.Click += (s, e) => { if (BackRequested != null) BackRequested(this, EventArgs.Empty); };
        Controls.Add(backButton);

        statusLabel = new Label
        {
            Location = new Point(0, 336),
            Size = new Size(560, 46),
            ForeColor = Muted,
            Font = new Font("Microsoft YaHei UI", 8.5F),
            Text = "提示：表情库页面的上传/删除仍然即时生效。",
        };
        Controls.Add(statusLabel);
    }

    private static Label NewLabel(string text, int x, int y)
    {
        return new Label { Text = text, AutoSize = true, ForeColor = UiTheme.TextSoft, Location = new Point(x, y) };
    }

    private static CheckBox NewCheckBox(string text, int x, int y)
    {
        return new CheckBox { Text = text, AutoSize = true, ForeColor = UiTheme.TextSoft, Location = new Point(x, y), Checked = true };
    }

    private static NumericUpDown NewNumber(int value, int min, int max, int step, int x, int y)
    {
        NumericUpDown box = new NumericUpDown
        {
            Location = new Point(x, y),
            Width = 120,
            Minimum = min,
            Maximum = max,
            Increment = step,
            BackColor = PanelBg2,
            ForeColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
        };
        box.Value = Math.Max(min, Math.Min(max, value));
        return box;
    }

    private static RoundButton NewButton(string text, Color back, int x, int y, int width)
    {
        return new RoundButton
        {
            Text = text,
            Location = new Point(x, y),
            Width = width,
            Height = 32,
            Radius = 8,
            NormalBack = back,
            HoverBack = Color.FromArgb(Math.Min(255, back.R + 16), Math.Min(255, back.G + 16), Math.Min(255, back.B + 16)),
            PressedBack = Color.FromArgb(Math.Max(0, back.R - 12), Math.Max(0, back.G - 12), Math.Max(0, back.B - 12)),
            BorderColor = UiTheme.Line,
            ForeColor = Color.White,
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold),
        };
    }

    /// <summary>重新读取 config 并刷新控件（打开通用设置时调用）。</summary>
    public void ReloadFromConfig()
    {
        try
        {
            Dictionary<string, object> config = LoadJson(configPath);
            Dictionary<string, object> sticker = EnsureDict(config, "sticker");
            enabledBox.Checked = GetBool(sticker, "enabled", true);
            modeBox.SelectedIndex = GetString(sticker, "mode", "smart") == "explicit" ? 1 : 0;
            groupsBox.Checked = GetBool(sticker, "groupsEnabled", true);
            cooldownBox.Value = Clamp(GetInt(sticker, "cooldownSeconds", 60), cooldownBox);
            maxHourBox.Value = Clamp(GetInt(sticker, "maxPerHour", 10), maxHourBox);
            guidanceBox.Text = GetString(sticker, "promptGuidance",
                "只在对方明确想要表情、或氛围明显合适时发送一个；不要连续刷表情。");
            statusLabel.Text = "提示：通用设置保存后 bridge 下一次回复自动读取；表情库上传/删除仍然即时生效。";
            statusLabel.ForeColor = Muted;
        }
        catch (Exception error)
        {
            statusLabel.Text = "读取设置失败：" + error.Message;
            statusLabel.ForeColor = Err;
        }
    }

    private void SaveGeneralSettings()
    {
        try
        {
            Dictionary<string, object> config = LoadJson(configPath);
            Dictionary<string, object> sticker = EnsureDict(config, "sticker");
            sticker["enabled"] = enabledBox.Checked;
            sticker["mode"] = modeBox.SelectedIndex == 1 ? "explicit" : "smart";
            sticker["groupsEnabled"] = groupsBox.Checked;
            sticker["cooldownSeconds"] = (int)cooldownBox.Value;
            sticker["maxPerHour"] = (int)maxHourBox.Value;
            sticker["promptGuidance"] = guidanceBox.Text.Trim();
            WriteConfig(configPath, config);
            statusLabel.Text = "已保存；下一次模型回复会自动读取新设置。";
            statusLabel.ForeColor = Ok;
            if (Saved != null) { Saved(this, EventArgs.Empty); }
        }
        catch (Exception error)
        {
            statusLabel.Text = "保存失败：" + error.Message;
            statusLabel.ForeColor = Err;
        }
    }

    private Dictionary<string, object> LoadJson(string path)
    {
        Dictionary<string, object> parsed = serializer.DeserializeObject(File.ReadAllText(path)) as Dictionary<string, object>;
        return parsed ?? new Dictionary<string, object>();
    }

    private void WriteConfig(string path, Dictionary<string, object> config)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        string temp = path + ".general.tmp";
        File.WriteAllText(temp, serializer.Serialize(config), new UTF8Encoding(false));
        if (File.Exists(path)) { File.Delete(path); }
        File.Move(temp, path);
    }

    private static Dictionary<string, object> EnsureDict(Dictionary<string, object> parent, string key)
    {
        object value;
        Dictionary<string, object> dict = parent.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
        if (dict == null)
        {
            dict = new Dictionary<string, object>();
            parent[key] = dict;
        }
        return dict;
    }

    private static string GetString(Dictionary<string, object> dict, string key, string fallback)
    {
        object value;
        return dict.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback;
    }

    private static int GetInt(Dictionary<string, object> dict, string key, int fallback)
    {
        object value;
        int parsed;
        return dict.TryGetValue(key, out value) && value != null && int.TryParse(Convert.ToString(value), out parsed) ? parsed : fallback;
    }

    private static bool GetBool(Dictionary<string, object> dict, string key, bool fallback)
    {
        object value;
        if (!dict.TryGetValue(key, out value) || value == null) { return fallback; }
        try { return Convert.ToBoolean(value); } catch { return fallback; }
    }

    private static decimal Clamp(int value, NumericUpDown box)
    {
        return Math.Max(box.Minimum, Math.Min(box.Maximum, value));
    }
}
