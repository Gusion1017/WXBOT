using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

/// <summary>
/// 设置页「表情包」管理（优化版）：
/// - 缩略图卡片列表 + 搜索
/// - 批量上传 / 拖拽上传 jpg/png/gif，统一保存为 GIF
/// - 右侧大图预览、名字/时机编辑、启用状态、文件信息
/// - 数据：state/stickers/catalog.json + state/stickers/library/&lt;md5&gt;.gif
/// </summary>
internal sealed class StickerManagerPanel : UserControl
{
    private static readonly Color Bg = UiTheme.Bg;
    private static readonly Color PanelBg = UiTheme.PanelBg;
    private static readonly Color PanelBg2 = UiTheme.PanelBg2;
    private static readonly Color PanelBg3 = UiTheme.PanelBg3;
    private static readonly Color Line = UiTheme.Line;
    private static readonly Color Muted = UiTheme.Muted;
    private static readonly Color Accent = UiTheme.Accent;
    private static readonly Color Err = UiTheme.Err;
    private static readonly Color Ok = UiTheme.Ok;

    private const int MaxStickers = 50;
    private const int MaxBytes = 8 * 1024 * 1024;
    private const int ItemHeight = 88;
    private static readonly Font ItemNameFont = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);
    private static readonly Font PlaceholderFont = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold);

    private readonly string root;
    private readonly string catalogPath;
    private readonly string libraryDir;
    private readonly JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    private readonly List<Dictionary<string, object>> stickers = new List<Dictionary<string, object>>();
    private readonly List<Dictionary<string, object>> visible = new List<Dictionary<string, object>>();
    private readonly Dictionary<string, Image> thumbnails = new Dictionary<string, Image>(StringComparer.OrdinalIgnoreCase);

    private ListBox stickerList;
    private TextBox searchBox;
    private TextBox nameBox;
    private TextBox occasionBox;
    private CheckBox enabledBox;
    private PictureBox previewBox;
    private Label countLabel;
    private Label infoLabel;
    private Label statusLabel;
    private Label emptyLabel;
    private TableLayoutPanel rootLayout;
    private Panel bodyPanel;
    private StickerGeneralPanel generalPanel;
    private RoundButton saveButton;
    private RoundButton deleteButton;
    private RoundButton enableButton;
    private bool loadingEditor;

    private Image previewImage;
    private MemoryStream previewStream;

    public StickerManagerPanel(string root)
    {
        this.root = root;
        catalogPath = Path.Combine(root, "state", "stickers", "catalog.json");
        libraryDir = Path.Combine(root, "state", "stickers", "library");
        Dock = DockStyle.Fill;
        BackColor = Bg;
        ForeColor = Color.White;
        Font = new Font("Microsoft YaHei UI", 9F);
        AllowDrop = true;
        DragEnter += OnDragEnter;
        DragDrop += OnDragDrop;
        BuildUi();
        LoadCatalog();
    }

    private void BuildUi()
    {
        rootLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = Bg,
        };
        rootLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        rootLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 116));
        rootLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(rootLayout);

        Panel topDock = new Panel { Dock = DockStyle.Fill, BackColor = PanelBg };

        Panel header = new Panel { Dock = DockStyle.Top, Height = 78, BackColor = PanelBg };
        Label title = new Label
        {
            Text = "表情包管理",
            AutoSize = true,
            ForeColor = UiTheme.TextColor,
            Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold),
            Location = new Point(18, 8),
        };
        Label subtitle = new Label
        {
            Text = "上传 jpg / png / gif，统一转为 GIF；机器人会根据名字和“适合发送的时机”选择。",
            AutoSize = true,
            ForeColor = Muted,
            Font = new Font("Microsoft YaHei UI", 8.5F),
            Location = new Point(20, 34),
        };
        countLabel = new Label
        {
            AutoSize = true,
            ForeColor = UiTheme.TextSoft,
            Font = new Font("Microsoft YaHei UI", 8.5F),
            Location = new Point(20, 54),
        };
        header.Controls.Add(title);
        header.Controls.Add(subtitle);
        header.Controls.Add(countLabel);

        Panel actions = new Panel { Dock = DockStyle.Right, Width = 144, BackColor = PanelBg };
        RoundButton addButton = MakeButton("添加图片", Color.FromArgb(60, 110, 220), 128, 32);
        addButton.Location = new Point(4, 8);
        addButton.Click += (s, e) => AddImages();
        RoundButton generalButton = MakeButton("通用设置", PanelBg2, 62, 26);
        generalButton.Location = new Point(4, 46);
        generalButton.Click += (s, e) => ShowGeneralSettings();
        RoundButton folderButton = MakeButton("打开目录", PanelBg2, 62, 26);
        folderButton.Location = new Point(70, 46);
        folderButton.Click += (s, e) => OpenLibraryFolder();
        actions.Controls.Add(addButton);
        actions.Controls.Add(generalButton);
        actions.Controls.Add(folderButton);
        header.Controls.Add(actions);

        Panel searchWrap = new Panel { Dock = DockStyle.Top, Height = 38, BackColor = PanelBg, Padding = new Padding(18, 2, 18, 6) };
        searchBox = new TextBox
        {
            Dock = DockStyle.Fill,
            BackColor = PanelBg2,
            ForeColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Microsoft YaHei UI", 9F),
        };
        SetCue(searchBox, "搜索名字或发送时机…");
        searchBox.TextChanged += (s, e) => ApplyFilter();
        searchWrap.Controls.Add(searchBox);
        topDock.Controls.Add(searchWrap);
        topDock.Controls.Add(header);
        rootLayout.Controls.Add(topDock, 0, 0);

        bodyPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 0, 18, 12), BackColor = Bg };
        rootLayout.Controls.Add(bodyPanel, 0, 1);

        TableLayoutPanel bodyLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = Bg,
        };
        bodyLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 340));
        bodyLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        bodyLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        bodyPanel.Controls.Add(bodyLayout);
        Panel left = new Panel { Dock = DockStyle.Fill, BackColor = PanelBg, Padding = new Padding(8) };
        bodyLayout.Controls.Add(left, 0, 0);
        stickerList = new ListBox
        {
            Dock = DockStyle.Fill,
            BackColor = PanelBg,
            ForeColor = Color.White,
            BorderStyle = BorderStyle.None,
            DrawMode = DrawMode.OwnerDrawFixed,
            ItemHeight = ItemHeight,
            IntegralHeight = false,
            Font = new Font("Microsoft YaHei UI", 9F),
            AllowDrop = true,
        };
        stickerList.DrawItem += DrawStickerItem;
        stickerList.SelectedIndexChanged += (s, e) => LoadSelectedIntoEditor();
        stickerList.DragEnter += OnDragEnter;
        stickerList.DragDrop += OnDragDrop;
        left.Controls.Add(SlimScrollArea.Create(stickerList));

        emptyLabel = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Muted,
            Font = new Font("Microsoft YaHei UI", 9.5F),
            Text = "还没有表情包\r\n点右上角「添加图片」，或把图片拖到这里",
            BackColor = PanelBg,
        };
        left.Controls.Add(emptyLabel);
        emptyLabel.BringToFront();

        Panel right = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18, 0, 0, 0), BackColor = Bg, AutoScroll = false };
        bodyLayout.Controls.Add(right, 1, 0);

        Panel previewCard = new Panel
        {
            Location = new Point(0, 0),
            Size = new Size(420, 132),
            BackColor = PanelBg2,
            BorderStyle = BorderStyle.FixedSingle,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
        };
        previewBox = new PictureBox
        {
            Dock = DockStyle.Fill,
            BackColor = PanelBg2,
            SizeMode = PictureBoxSizeMode.Zoom,
        };
        previewCard.Controls.Add(previewBox);
        right.Controls.Add(previewCard);
        right.Resize += (s, e) =>
        {
            previewCard.Width = Math.Max(280, right.ClientSize.Width - 24);
            LayoutEditor(right, previewCard);
        };

        Label nameLabel = FieldLabel("表情包名字", 0, 142);
        right.Controls.Add(nameLabel);
        nameBox = FieldTextBox(0, 162, 320);
        nameBox.TextChanged += (s, e) => MarkDirty();
        right.Controls.Add(nameBox);

        Label occasionLabel = FieldLabel("适合发送的时机（给模型判断）", 0, 194);
        right.Controls.Add(occasionLabel);
        occasionBox = FieldTextBox(0, 214, 420);
        occasionBox.Multiline = true;
        occasionBox.Height = 46;
        occasionBox.ScrollBars = ScrollBars.Vertical;
        occasionBox.Text = "例如：对方夸我、收到好消息、想撒娇时";
        occasionBox.TextChanged += (s, e) => MarkDirty();
        right.Controls.Add(occasionBox);

        infoLabel = new Label
        {
            AutoSize = true,
            ForeColor = Muted,
            Font = new Font("Microsoft YaHei UI", 8F),
            Location = new Point(0, 268),
        };
        right.Controls.Add(infoLabel);

        enabledBox = new CheckBox
        {
            Text = "启用（可被机器人选择）",
            AutoSize = true,
            ForeColor = UiTheme.TextSoft,
            Location = new Point(0, 290),
            Checked = true,
        };
        enabledBox.CheckedChanged += (s, e) => MarkDirty();
        right.Controls.Add(enabledBox);

        Panel buttons = new Panel { Location = new Point(0, 312), Size = new Size(420, 34), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
        saveButton = MakeButton("保存修改", Color.FromArgb(60, 140, 90), 118, 32);
        saveButton.Location = new Point(0, 0);
        saveButton.Click += (s, e) => SaveSelectedInfo();
        deleteButton = MakeButton("删除", Color.FromArgb(150, 70, 70), 82, 32);
        deleteButton.Location = new Point(128, 0);
        deleteButton.Click += (s, e) => DeleteSelected();
        enableButton = MakeButton("停用", PanelBg3, 82, 32);
        enableButton.Location = new Point(220, 0);
        enableButton.Click += (s, e) => ToggleEnabled();
        buttons.Controls.Add(saveButton);
        buttons.Controls.Add(deleteButton);
        buttons.Controls.Add(enableButton);
        right.Controls.Add(buttons);

        statusLabel = new Label
        {
            Location = new Point(0, 348),
            Size = new Size(520, 38),
            ForeColor = Muted,
            Font = new Font("Microsoft YaHei UI", 8.5F),
            Text = "提示：添加后先填写名字与时机，再点「保存修改」。",
        };
        right.Controls.Add(statusLabel);

        generalPanel = new StickerGeneralPanel(root);
        generalPanel.Visible = false;
        generalPanel.BackRequested += (s, e) => ShowLibraryView();
        generalPanel.Saved += (s, e) => { statusLabel.Text = "通用设置已保存，下一次回复自动生效。"; statusLabel.ForeColor = Ok; };
        rootLayout.Controls.Add(generalPanel, 0, 1);

        LayoutEditor(right, previewCard);
    }

    /// <summary>切换到通用设置。</summary>
    private void ShowGeneralSettings()
    {
        if (generalPanel == null) { return; }
        generalPanel.ReloadFromConfig();
        bodyPanel.Visible = false;
        generalPanel.Visible = true;
        generalPanel.BringToFront();
    }

    /// <summary>从通用设置返回表情库。</summary>
    private void ShowLibraryView()
    {
        if (generalPanel != null) { generalPanel.Visible = false; }
        bodyPanel.Visible = true;
        bodyPanel.BringToFront();
        LoadCatalog();
    }

    private static void LayoutEditor(Panel right, Panel previewCard)
    {
        int width = Math.Max(280, right.ClientSize.Width - 28);
        previewCard.Width = width;
        foreach (Control control in right.Controls)
        {
            TextBox box = control as TextBox;
            if (box != null) { box.Width = width; }
            Panel panel = control as Panel;
            if (panel != null && panel != previewCard) { panel.Width = width; }
        }
    }

    private static Label FieldLabel(string text, int x, int y)
    {
        return new Label { Text = text, Location = new Point(x, y), AutoSize = true, ForeColor = UiTheme.TextSoft };
    }

    private static TextBox FieldTextBox(int x, int y, int width)
    {
        return new TextBox
        {
            Location = new Point(x, y),
            Width = width,
            BackColor = PanelBg2,
            ForeColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
        };
    }

    private static RoundButton MakeButton(string text, Color back, int width, int height)
    {
        return new RoundButton
        {
            Text = text,
            Width = width,
            Height = height,
            Radius = 8,
            NormalBack = back,
            HoverBack = Color.FromArgb(Math.Min(255, back.R + 16), Math.Min(255, back.G + 16), Math.Min(255, back.B + 16)),
            PressedBack = Color.FromArgb(Math.Max(0, back.R - 12), Math.Max(0, back.G - 12), Math.Max(0, back.B - 12)),
            BorderColor = Line,
            ForeColor = Color.White,
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold),
        };
    }

    private static void SetCue(TextBox box, string cue)
    {
        try { SendMessage(box.Handle, 0x1501, (IntPtr)1, cue); } catch { }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);

    private void OnDragEnter(object sender, DragEventArgs e)
    {
        e.Effect = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
    }

    private void OnDragDrop(object sender, DragEventArgs e)
    {
        string[] files = e.Data.GetData(DataFormats.FileDrop) as string[];
        if (files == null || files.Length == 0) { return; }
        AddFiles(files);
    }

    private void AddImages()
    {
        using (OpenFileDialog dialog = new OpenFileDialog
        {
            Title = "选择表情图片（可多选）",
            Filter = "图片 (*.jpg;*.jpeg;*.png;*.gif)|*.jpg;*.jpeg;*.png;*.gif",
            Multiselect = true,
        })
        {
            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                AddFiles(dialog.FileNames);
            }
        }
    }

    private void AddFiles(string[] files)
    {
        int added = 0;
        int failed = 0;
        string lastId = string.Empty;
        foreach (string file in files)
        {
            try
            {
                string id = AddOneFile(file);
                if (id.Length > 0) { added++; lastId = id; }
            }
            catch (Exception error)
            {
                failed++;
                statusLabel.Text = "「" + Path.GetFileName(file) + "」添加失败：" + error.Message;
                statusLabel.ForeColor = Err;
            }
        }
        LoadCatalog(lastId);
        if (added > 0)
        {
            statusLabel.Text = "已添加 " + added + " 张" + (failed > 0 ? "，失败 " + failed + " 张" : string.Empty) + "；请填写名字和发送时机。";
            statusLabel.ForeColor = Ok;
        }
    }

    private string AddOneFile(string sourcePath)
    {
        int width;
        int height;
        byte[] gif = NormalizeToGif(sourcePath, out width, out height);
        if (gif.Length > MaxBytes) { throw new InvalidOperationException("转换后的 GIF 超过 8MB"); }
        string md5 = Md5(gif);
        string id = "s_" + md5.Substring(0, 12);
        Dictionary<string, object> existing = FindById(id);
        if (existing == null && stickers.Count >= MaxStickers)
        {
            throw new InvalidOperationException("表情包最多 " + MaxStickers + " 个，请先删除一些");
        }
        Directory.CreateDirectory(libraryDir);
        string relative = Path.Combine("state", "stickers", "library", md5 + ".gif");
        string absolute = Path.Combine(root, relative);
        string temp = absolute + "." + Guid.NewGuid().ToString("n") + ".tmp";
        File.WriteAllBytes(temp, gif);
        if (File.Exists(absolute)) { File.Delete(absolute); }
        File.Move(temp, absolute);

        Dictionary<string, object> sticker = existing ?? new Dictionary<string, object>
        {
            { "id", id },
            { "name", Path.GetFileNameWithoutExtension(sourcePath) },
            { "occasion", string.Empty },
            { "createdAt", DateTime.Now.ToString("o") },
        };
        sticker["file"] = relative.Replace('\\', '/');
        sticker["md5"] = md5;
        sticker["len"] = gif.Length;
        sticker["width"] = width;
        sticker["height"] = height;
        if (!sticker.ContainsKey("enabled")) { sticker["enabled"] = true; }
        if (existing == null) { stickers.Add(sticker); }
        SaveCatalog();
        return id;
    }

    private static byte[] NormalizeToGif(string path, out int width, out int height)
    {
        byte[] raw = File.ReadAllBytes(path);
        bool isGif = raw.Length >= 6 && raw[0] == (byte)'G' && raw[1] == (byte)'I' && raw[2] == (byte)'F';
        using (Image image = Image.FromFile(path))
        {
            width = image.Width;
            height = image.Height;
            if (width <= 0 || height <= 0 || width > 4096 || height > 4096)
            {
                throw new InvalidOperationException("图片边长必须在 1-4096 像素之间");
            }
            if (isGif)
            {
                if (raw.Length > MaxBytes) { throw new InvalidOperationException("GIF 超过 8MB"); }
                return raw;
            }
            using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    graphics.Clear(Color.Transparent);
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.DrawImage(image, 0, 0, width, height);
                }
                using (MemoryStream output = new MemoryStream())
                {
                    bitmap.Save(output, ImageFormat.Gif);
                    return output.ToArray();
                }
            }
        }
    }

    private void LoadCatalog(string selectId = null)
    {
        string selectedId = selectId;
        if (selectedId == null)
        {
            Dictionary<string, object> selected = SelectedSticker();
            if (selected != null) { selectedId = GetString(selected, "id"); }
        }
        foreach (Image image in thumbnails.Values) { try { image.Dispose(); } catch { } }
        thumbnails.Clear();
        stickers.Clear();
        try
        {
            if (File.Exists(catalogPath))
            {
                Dictionary<string, object> rootObj = serializer.DeserializeObject(File.ReadAllText(catalogPath)) as Dictionary<string, object>;
                object[] items = rootObj != null && rootObj.ContainsKey("stickers") ? rootObj["stickers"] as object[] : null;
                if (items != null)
                {
                    foreach (object item in items)
                    {
                        Dictionary<string, object> entry = item as Dictionary<string, object>;
                        if (entry != null && GetString(entry, "id").Length > 0 && GetString(entry, "md5").Length > 0)
                        {
                            stickers.Add(entry);
                        }
                    }
                }
            }
        }
        catch { stickers.Clear(); }
        stickers.Sort((a, b) => string.Compare(GetString(b, "createdAt"), GetString(a, "createdAt"), StringComparison.Ordinal));
        ApplyFilter(selectedId);
    }

    private void ApplyFilter(string selectId = null)
    {
        string keyword = searchBox == null ? string.Empty : searchBox.Text.Trim();
        string selectedId = selectId;
        if (selectedId == null)
        {
            Dictionary<string, object> selected = SelectedSticker();
            if (selected != null) { selectedId = GetString(selected, "id"); }
        }
        visible.Clear();
        foreach (Dictionary<string, object> sticker in stickers)
        {
            if (keyword.Length == 0
                || GetString(sticker, "name").IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0
                || GetString(sticker, "occasion").IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                visible.Add(sticker);
            }
        }
        loadingEditor = true;
        stickerList.BeginUpdate();
        stickerList.Items.Clear();
        foreach (Dictionary<string, object> sticker in visible)
        {
            stickerList.Items.Add(GetString(sticker, "name"));
        }
        stickerList.EndUpdate();
        loadingEditor = false;
        int index = 0;
        if (selectedId != null)
        {
            for (int i = 0; i < visible.Count; i++)
            {
                if (GetString(visible[i], "id") == selectedId) { index = i; break; }
            }
        }
        if (stickerList.Items.Count > 0) { stickerList.SelectedIndex = Math.Min(index, stickerList.Items.Count - 1); }
        UpdateEmptyState();
        UpdateCountLabel();
        LoadSelectedIntoEditor();
    }

    private void UpdateEmptyState()
    {
        if (emptyLabel == null) { return; }
        emptyLabel.Visible = visible.Count == 0;
        emptyLabel.Text = stickers.Count == 0
            ? "还没有表情包\r\n点右上角「添加图片」，或把图片拖到这里"
            : "没有匹配的表情包";
        if (emptyLabel.Visible) { emptyLabel.BringToFront(); }
    }

    private void UpdateCountLabel()
    {
        if (countLabel == null) { return; }
        int enabled = 0;
        foreach (Dictionary<string, object> sticker in stickers)
        {
            if (GetBool(sticker, "enabled", true)) { enabled++; }
        }
        countLabel.Text = "已添加 " + stickers.Count + " / " + MaxStickers + " · 启用 " + enabled + " 个";
    }

    private Dictionary<string, object> SelectedSticker()
    {
        if (stickerList == null || stickerList.SelectedIndex < 0 || stickerList.SelectedIndex >= visible.Count) { return null; }
        return visible[stickerList.SelectedIndex];
    }

    private void LoadSelectedIntoEditor()
    {
        if (loadingEditor) { return; }
        Dictionary<string, object> sticker = SelectedSticker();
        DisposePreview();
        if (sticker == null)
        {
            loadingEditor = true;
            nameBox.Text = string.Empty;
            occasionBox.Text = string.Empty;
            enabledBox.Checked = true;
            enabledBox.Enabled = false;
            infoLabel.Text = string.Empty;
            saveButton.Enabled = false;
            deleteButton.Enabled = false;
            enableButton.Enabled = false;
            loadingEditor = false;
            return;
        }
        loadingEditor = true;
        nameBox.Text = GetString(sticker, "name");
        occasionBox.Text = GetString(sticker, "occasion");
        enabledBox.Checked = GetBool(sticker, "enabled", true);
        enabledBox.Enabled = true;
        saveButton.Enabled = true;
        deleteButton.Enabled = true;
        enableButton.Enabled = true;
        enableButton.Text = enabledBox.Checked ? "停用" : "启用";
        infoLabel.Text = BuildInfoText(sticker);
        loadingEditor = false;
        LoadPreview(ResolveFile(sticker));
        statusLabel.ForeColor = Muted;
        statusLabel.Text = "提示：修改后点「保存修改」立即生效。";
    }

    private void LoadPreview(string path)
    {
        if (!File.Exists(path)) { return; }
        try
        {
            byte[] bytes = File.ReadAllBytes(path);
            MemoryStream stream = new MemoryStream(bytes);
            Image image = Image.FromStream(stream);
            previewStream = stream;
            previewImage = image;
            previewBox.Image = image;
        }
        catch { DisposePreview(); }
    }

    private void DisposePreview()
    {
        previewBox.Image = null;
        if (previewImage != null) { try { previewImage.Dispose(); } catch { } previewImage = null; }
        if (previewStream != null) { try { previewStream.Dispose(); } catch { } previewStream = null; }
    }

    private string BuildInfoText(Dictionary<string, object> sticker)
    {
        int width = GetInt(sticker, "width");
        int height = GetInt(sticker, "height");
        int len = GetInt(sticker, "len");
        string animated = "静态";
        try
        {
            string file = ResolveFile(sticker);
            if (File.Exists(file))
            {
                using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (Image image = Image.FromStream(stream))
                {
                    if (image.FrameDimensionsList != null && image.FrameDimensionsList.Length > 0)
                    {
                        try
                        {
                            int count = image.GetFrameCount(new FrameDimension(image.FrameDimensionsList[0]));
                            if (count > 1) { animated = "动画 " + count + " 帧"; }
                        }
                        catch { }
                    }
                }
            }
        }
        catch { }
        return "GIF · " + width + "×" + height + " · " + FormatBytes(len) + " · " + animated;
    }

    private static string FormatBytes(int bytes)
    {
        if (bytes >= 1024 * 1024) { return (bytes / 1024.0 / 1024.0).ToString("0.0") + " MB"; }
        if (bytes >= 1024) { return (bytes / 1024.0).ToString("0.0") + " KB"; }
        return bytes + " B";
    }

    private void DrawStickerItem(object sender, DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= visible.Count) { return; }
        Dictionary<string, object> sticker = visible[e.Index];
        bool selected = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
        bool enabled = GetBool(sticker, "enabled", true);
        Color background = selected ? PanelBg3 : PanelBg2;
        using (SolidBrush brush = new SolidBrush(background))
        {
            e.Graphics.FillRectangle(brush, e.Bounds);
        }
        if (selected)
        {
            using (Pen pen = new Pen(Color.FromArgb(120, 160, 255)))
            {
                e.Graphics.DrawRectangle(pen, e.Bounds.Left + 1, e.Bounds.Top + 1, e.Bounds.Width - 3, e.Bounds.Height - 3);
            }
        }
        Rectangle thumbRect = new Rectangle(e.Bounds.Left + 10, e.Bounds.Top + 12, 58, 58);
        using (SolidBrush thumbBack = new SolidBrush(PanelBg))
        {
            e.Graphics.FillRectangle(thumbBack, thumbRect);
        }
        Image thumbnail = GetThumbnail(sticker, thumbRect.Width);
        if (thumbnail != null)
        {
            e.Graphics.DrawImage(thumbnail, thumbRect);
        }
        else
        {
            TextRenderer.DrawText(e.Graphics, "?", PlaceholderFont, thumbRect, Muted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
        string name = GetString(sticker, "name");
        string occasion = GetString(sticker, "occasion");
        if (occasion.Length == 0) { occasion = "未填写发送时机"; }
        Rectangle nameRect = new Rectangle(e.Bounds.Left + 82, e.Bounds.Top + 13, e.Bounds.Width - 130, 24);
        Rectangle occasionRect = new Rectangle(e.Bounds.Left + 82, e.Bounds.Top + 38, e.Bounds.Width - 130, 26);
        TextRenderer.DrawText(e.Graphics, name, ItemNameFont,
            nameRect, enabled ? UiTheme.TextColor : Muted,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        TextRenderer.DrawText(e.Graphics, occasion, UiTheme.SmallFont, occasionRect, Muted,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        using (SolidBrush dot = new SolidBrush(enabled ? Ok : Line))
        {
            e.Graphics.FillEllipse(dot, e.Bounds.Right - 24, e.Bounds.Top + 16, 8, 8);
        }
        if (!enabled)
        {
            TextRenderer.DrawText(e.Graphics, "已停用", UiTheme.TinyFont,
                new Rectangle(e.Bounds.Right - 64, e.Bounds.Top + 34, 48, 18), Muted,
                TextFormatFlags.Right | TextFormatFlags.VerticalCenter);
        }
        using (Pen line = new Pen(Color.FromArgb(25, 72, 108, 150)))
        {
            e.Graphics.DrawLine(line, e.Bounds.Left + 78, e.Bounds.Bottom - 8, e.Bounds.Right - 12, e.Bounds.Bottom - 8);
        }
    }

    private Image GetThumbnail(Dictionary<string, object> sticker, int size)
    {
        string path = ResolveFile(sticker);
        if (thumbnails.ContainsKey(path)) { return thumbnails[path]; }
        try
        {
            if (!File.Exists(path)) { return null; }
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (Image source = Image.FromStream(stream))
            {
                Bitmap bitmap = new Bitmap(source, size, size);
                thumbnails[path] = bitmap;
                return bitmap;
            }
        }
        catch { return null; }
    }

    private void SaveSelectedInfo()
    {
        Dictionary<string, object> sticker = SelectedSticker();
        if (sticker == null) { return; }
        string name = nameBox.Text.Trim();
        if (name.Length == 0 || name.Length > 120)
        {
            statusLabel.Text = "名字不能为空，且不超过 120 字。";
            statusLabel.ForeColor = Err;
            return;
        }
        sticker["name"] = name;
        sticker["occasion"] = occasionBox.Text.Trim();
        sticker["enabled"] = enabledBox.Checked;
        SaveCatalog();
        LoadCatalog(GetString(sticker, "id"));
        statusLabel.Text = "已保存；后台下一次回复会自动读取新目录。";
        statusLabel.ForeColor = Ok;
    }

    private void ToggleEnabled()
    {
        Dictionary<string, object> sticker = SelectedSticker();
        if (sticker == null) { return; }
        bool next = !GetBool(sticker, "enabled", true);
        sticker["enabled"] = next;
        enabledBox.Checked = next;
        SaveCatalog();
        LoadCatalog(GetString(sticker, "id"));
        statusLabel.Text = next ? "已启用。" : "已停用；模型不会再选择它。";
        statusLabel.ForeColor = Ok;
    }

    private void DeleteSelected()
    {
        Dictionary<string, object> sticker = SelectedSticker();
        if (sticker == null) { return; }
        if (MessageBox.Show(this, "删除表情包「" + GetString(sticker, "name") + "」？\r\n只删除本地文件，不影响微信聊天记录。",
            "确认删除", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) { return; }
        string id = GetString(sticker, "id");
        string file = ResolveFile(sticker);
        stickers.Remove(sticker);
        SaveCatalog();
        try { if (File.Exists(file)) { File.Delete(file); } } catch { }
        LoadCatalog();
        statusLabel.Text = "已删除。";
        statusLabel.ForeColor = Ok;
    }

    private void OpenLibraryFolder()
    {
        try
        {
            Directory.CreateDirectory(libraryDir);
            Process.Start("explorer.exe", libraryDir);
        }
        catch (Exception error)
        {
            statusLabel.Text = "打开目录失败：" + error.Message;
            statusLabel.ForeColor = Err;
        }
    }

    private void MarkDirty()
    {
        if (loadingEditor) { return; }
        if (SelectedSticker() != null)
        {
            statusLabel.Text = "有未保存修改，点「保存修改」生效。";
            statusLabel.ForeColor = Accent;
        }
    }

    private void SaveCatalog()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(catalogPath));
        Dictionary<string, object> rootObj = new Dictionary<string, object>
        {
            { "version", 1 },
            { "stickers", stickers },
        };
        string temp = catalogPath + ".tmp";
        File.WriteAllText(temp, serializer.Serialize(rootObj), new UTF8Encoding(false));
        if (File.Exists(catalogPath)) { File.Delete(catalogPath); }
        File.Move(temp, catalogPath);
    }

    private Dictionary<string, object> FindById(string id)
    {
        foreach (Dictionary<string, object> sticker in stickers)
        {
            if (GetString(sticker, "id") == id) { return sticker; }
        }
        return null;
    }

    private string ResolveFile(Dictionary<string, object> sticker)
    {
        string file = GetString(sticker, "file");
        return Path.IsPathRooted(file) ? file : Path.Combine(root, file.Replace('/', '\\'));
    }

    private static string GetString(Dictionary<string, object> dict, string key)
    {
        object value;
        return dict.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : string.Empty;
    }

    private static int GetInt(Dictionary<string, object> dict, string key)
    {
        object value;
        int parsed;
        return dict.TryGetValue(key, out value) && value != null && int.TryParse(Convert.ToString(value), out parsed) ? parsed : 0;
    }

    private static bool GetBool(Dictionary<string, object> dict, string key, bool fallback)
    {
        object value;
        if (!dict.TryGetValue(key, out value) || value == null) { return fallback; }
        try { return Convert.ToBoolean(value); } catch { return fallback; }
    }

    private static string Md5(byte[] data)
    {
        using (MD5 algorithm = MD5.Create())
        {
            byte[] hash = algorithm.ComputeHash(data);
            StringBuilder builder = new StringBuilder(hash.Length * 2);
            foreach (byte value in hash) { builder.Append(value.ToString("x2")); }
            return builder.ToString();
        }
    }
}
