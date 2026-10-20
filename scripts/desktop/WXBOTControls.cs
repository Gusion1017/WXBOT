using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

/// <summary>桌面版主题：DeepSeek 深海蓝 + 大肥鱼配色。</summary>
internal static class UiTheme
{
    // 深海蓝背景
    public static readonly Color Bg = Color.FromArgb(7, 12, 24);
    public static readonly Color BgSoft = Color.FromArgb(10, 17, 33);
    public static readonly Color PanelBg = Color.FromArgb(13, 22, 40);
    public static readonly Color PanelBg2 = Color.FromArgb(18, 30, 54);
    public static readonly Color PanelBg3 = Color.FromArgb(24, 40, 70);
    public static readonly Color Line = Color.FromArgb(33, 53, 88);
    public static readonly Color LineSoft = Color.FromArgb(26, 42, 70);

    // 文本
    public static readonly Color TextColor = Color.FromArgb(234, 241, 255);
    public static readonly Color TextSoft = Color.FromArgb(204, 218, 243);
    public static readonly Color Muted = Color.FromArgb(139, 158, 195);

    // DeepSeek 蓝 + 大肥鱼点缀
    public static readonly Color Accent = Color.FromArgb(77, 107, 254);
    public static readonly Color AccentBright = Color.FromArgb(122, 152, 255);
    public static readonly Color Accent2 = Color.FromArgb(119, 231, 255);
    public static readonly Color AccentDark = Color.FromArgb(48, 76, 210);
    public static readonly Color Cyan = Color.FromArgb(119, 231, 255);
    public static readonly Color Pink = Color.FromArgb(255, 174, 205);
    public static readonly Color PinkSoft = Color.FromArgb(255, 214, 230);
    public static readonly Color Lavender = Color.FromArgb(184, 178, 255);

    // 状态
    public static readonly Color Ok = Color.FromArgb(74, 226, 174);
    public static readonly Color Warn = Color.FromArgb(255, 201, 108);
    public static readonly Color Err = Color.FromArgb(255, 128, 158);

    public static readonly Font TitleFont = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold);
    public static readonly Font HeadFont = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold);
    public static readonly Font BodyFont = new Font("Microsoft YaHei UI", 9F);
    public static readonly Font SmallFont = new Font("Microsoft YaHei UI", 8F);
    public static readonly Font TinyFont = new Font("Microsoft YaHei UI", 7.5F, FontStyle.Bold);
    public static readonly Font MascotFont = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);

    private static StringFormat centered;

    public static StringFormat Centered
    {
        get
        {
            if (centered == null)
            {
                centered = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            }
            return centered;
        }
    }

    public static GraphicsPath RoundedRect(Rectangle bounds, int radius)
    {
        int diameter = Math.Max(4, radius * 2);
        GraphicsPath path = new GraphicsPath();
        if (radius <= 0 || bounds.Width < diameter || bounds.Height < diameter)
        {
            path.AddRectangle(bounds);
            return path;
        }
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static GraphicsPath EllipsePath(RectangleF bounds)
    {
        GraphicsPath path = new GraphicsPath();
        path.AddEllipse(bounds);
        return path;
    }

    public static Color Blend(Color a, Color b, float t)
    {
        t = Math.Max(0f, Math.Min(1f, t));
        return Color.FromArgb(
            (int)(a.A + (b.A - a.A) * t),
            (int)(a.R + (b.R - a.R) * t),
            (int)(a.G + (b.G - a.G) * t),
            (int)(a.B + (b.B - a.B) * t));
    }

    public static string InitialOf(string name)
    {
        if (string.IsNullOrEmpty(name)) { return "?"; }
        return name.Substring(0, 1).ToUpperInvariant();
    }

    // ---------- Windows 深色标题栏 ----------

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    private static extern int SetWindowTheme(IntPtr hWnd, string pszSubAppName, string pszSubIdList);

    public static void ApplyDarkTitleBar(Form form)
    {
        try
        {
            if (form == null || form.Handle == IntPtr.Zero) { return; }
            int enabled = 1;
            if (DwmSetWindowAttribute(form.Handle, 20, ref enabled, sizeof(int)) != 0)
            {
                DwmSetWindowAttribute(form.Handle, 19, ref enabled, sizeof(int));
            }
            int caption = ColorToBgr(BgSoft);
            DwmSetWindowAttribute(form.Handle, 35, ref caption, sizeof(int));
            int textColor = ColorToBgr(TextColor);
            DwmSetWindowAttribute(form.Handle, 36, ref textColor, sizeof(int));
            SetWindowTheme(form.Handle, "DarkMode_Explorer", null);
        }
        catch { }
    }

    private static int ColorToBgr(Color color)
    {
        return color.R | (color.G << 8) | (color.B << 16);
    }

    public static Icon CreateAppIcon(int size)
    {
        try
        {
            using (Bitmap bitmap = new Bitmap(size, size))
            {
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    graphics.Clear(Color.Transparent);
                    graphics.SmoothingMode = SmoothingMode.AntiAlias;
                    WhaleGirl.Draw(graphics, new Rectangle(1, 1, size - 2, size - 2), true, false);
                }
                IntPtr handle = bitmap.GetHicon();
                return Icon.FromHandle(handle);
            }
        }
        catch { return null; }
    }
}

/// <summary>大肥鱼（DeepSeek 风格原创简笔形象，全代码绘制，无外部素材）。</summary>
internal static class WhaleGirl
{
    private static Image mascotImage;
    private static MemoryStream mascotStream;
    private static bool mascotTried;

    private static Image LoadMascot()
    {
        if (!mascotTried)
        {
            mascotTried = true;
            try
            {
                byte[] bytes = Convert.FromBase64String(WhaleMascotData.PngBase64);
                mascotStream = new MemoryStream(bytes);
                mascotImage = Image.FromStream(mascotStream);
            }
            catch { mascotImage = null; }
        }
        return mascotImage;
    }

    private static void DrawImageMascot(Graphics g, Rectangle bounds, bool glow)
    {
        Image image = LoadMascot();
        if (image == null) { return; }
        if (glow)
        {
            using (GraphicsPath glowPath = UiTheme.EllipsePath(new RectangleF(0, 2, bounds.Width, bounds.Height - 2)))
            using (PathGradientBrush brush = new PathGradientBrush(glowPath))
            {
                brush.CenterColor = Color.FromArgb(80, 96, 150, 255);
                brush.SurroundColors = new[] { Color.FromArgb(0, 96, 150, 255) };
                g.FillPath(brush, glowPath);
            }
        }
        float scale = Math.Min(bounds.Width / (float)image.Width, bounds.Height / (float)image.Height);
        int width = Math.Max(1, (int)(image.Width * scale));
        int height = Math.Max(1, (int)(image.Height * scale));
        int x = bounds.X + (bounds.Width - width) / 2;
        int y = bounds.Y + (bounds.Height - height) / 2;
        g.DrawImage(image, new Rectangle(x, y, width, height));
    }

    private static Color HoodTop { get { return Color.FromArgb(91, 124, 255); } }
    private static Color HoodBottom { get { return Color.FromArgb(47, 78, 222); } }
    private static Color HoodDeep { get { return Color.FromArgb(30, 52, 160); } }
    private static Color Skin { get { return Color.FromArgb(255, 228, 212); } }
    private static Color SkinShade { get { return Color.FromArgb(250, 205, 190); } }
    private static Color Hair { get { return Color.FromArgb(38, 60, 150); } }
    private static Color Eye { get { return Color.FromArgb(22, 34, 76); } }
    private static Color Blush { get { return Color.FromArgb(255, 154, 184); } }

    /// <summary>在指定矩形内绘制大肥鱼。simplified 用于 32px 小图标。</summary>
    public static void Draw(Graphics g, Rectangle bounds, bool simplified, bool glow)
    {
        if (bounds.Width < 6 || bounds.Height < 6) { return; }
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        if (LoadMascot() != null)
        {
            DrawImageMascot(g, bounds, glow);
            return;
        }
        GraphicsState state = g.Save();
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;

        float scale = Math.Min(bounds.Width, bounds.Height) / 100f;
        g.TranslateTransform(bounds.X + (bounds.Width - 100f * scale) / 2f, bounds.Y + (bounds.Height - 100f * scale) / 2f);
        g.ScaleTransform(scale, scale);

        // 光晕/气泡
        if (glow && !simplified)
        {
            using (GraphicsPath glowPath = UiTheme.EllipsePath(new RectangleF(4, 8, 92, 88)))
            using (PathGradientBrush brush = new PathGradientBrush(glowPath))
            {
                brush.CenterColor = Color.FromArgb(70, 96, 150, 255);
                brush.SurroundColors = new[] { Color.FromArgb(0, 96, 150, 255) };
                g.FillPath(brush, glowPath);
            }
            DrawBubble(g, 10, 16, 5f, Color.FromArgb(150, 119, 231, 255));
            DrawBubble(g, 88, 26, 4f, Color.FromArgb(140, 255, 174, 205));
            DrawBubble(g, 82, 72, 3f, Color.FromArgb(120, 119, 231, 255));
        }

        // 鲸鱼尾（右侧）
        using (GraphicsPath tail = new GraphicsPath())
        {
            tail.AddBezier(74, 66, 90, 56, 96, 44, 92, 34);
            tail.AddBezier(92, 34, 86, 42, 82, 46, 76, 50);
            tail.AddBezier(76, 50, 84, 62, 82, 72, 74, 78);
            tail.CloseFigure();
            using (LinearGradientBrush tailBrush = new LinearGradientBrush(new Rectangle(72, 30, 24, 50), HoodTop, HoodBottom, 70f))
            {
                g.FillPath(tailBrush, tail);
            }
            using (Pen tailPen = new Pen(Color.FromArgb(120, 30, 52, 160), 1.2f))
            {
                g.DrawPath(tailPen, tail);
            }
        }

        // 鲸鱼头套（外轮廓：圆头 + 顶部小鳍）
        using (GraphicsPath hood = new GraphicsPath())
        {
            hood.AddArc(10, 12, 80, 78, 150, 240);
            hood.AddBezier(30, 18, 38, 6, 48, 6, 54, 14);
            hood.AddBezier(54, 14, 58, 8, 64, 8, 66, 16);
            hood.AddArc(26, 16, 62, 62, 200, 140);
            hood.CloseFigure();
            using (LinearGradientBrush hoodBrush = new LinearGradientBrush(new Rectangle(10, 8, 82, 82), HoodTop, HoodBottom, 65f))
            {
                g.FillPath(hoodBrush, hood);
            }
            using (Pen hoodPen = new Pen(HoodDeep, 1.4f))
            {
                g.DrawPath(hoodPen, hood);
            }
        }

        // 左鳍（小手）
        using (GraphicsPath fin = new GraphicsPath())
        {
            fin.AddBezier(18, 62, 8, 66, 6, 76, 14, 82);
            fin.AddBezier(14, 82, 20, 84, 24, 80, 26, 74);
            fin.CloseFigure();
            using (SolidBrush finBrush = new SolidBrush(HoodBottom))
            {
                g.FillPath(finBrush, fin);
            }
        }

        // 脸
        using (GraphicsPath face = UiTheme.EllipsePath(new RectangleF(24, 27, 54, 49)))
        using (LinearGradientBrush faceBrush = new LinearGradientBrush(new Rectangle(24, 25, 54, 52), Skin, SkinShade, 80f))
        {
            g.FillPath(faceBrush, face);
        }

        // 刘海
        using (GraphicsPath bangs = new GraphicsPath())
        {
            bangs.AddBezier(25, 45, 28, 22, 48, 18, 58, 24);
            bangs.AddBezier(58, 24, 62, 20, 70, 22, 73, 30);
            bangs.AddBezier(73, 30, 70, 29, 66, 30, 62, 32);
            bangs.AddBezier(62, 32, 58, 28, 55, 28, 52, 30);
            bangs.AddBezier(52, 30, 48, 27, 45, 27, 41, 30);
            bangs.AddBezier(41, 30, 38, 29, 33, 30, 30, 33);
            bangs.CloseFigure();
            using (SolidBrush hairBrush = new SolidBrush(Hair))
            {
                g.FillPath(hairBrush, bangs);
            }
        }

        // 呆毛（小水滴/心形芽）
        using (GraphicsPath ahoge = new GraphicsPath())
        {
            ahoge.AddBezier(52, 12, 48, 2, 56, 0, 58, 8);
            ahoge.AddBezier(58, 8, 61, 4, 64, 8, 60, 13);
            ahoge.CloseFigure();
            using (SolidBrush ahogeBrush = new SolidBrush(UiTheme.Cyan))
            {
                g.FillPath(ahogeBrush, ahoge);
            }
        }

        if (!simplified)
        {
            // 眼睛
            DrawEye(g, 37.5f, 49, 1.05f);
            DrawEye(g, 60.5f, 49, 1.05f);
            // 腮红
            using (SolidBrush blushBrush = new SolidBrush(Color.FromArgb(120, Blush)))
            {
                g.FillEllipse(blushBrush, 28, 62, 13, 6.5f);
                g.FillEllipse(blushBrush, 61, 62, 13, 6.5f);
            }
            // 微笑
            using (Pen mouth = new Pen(Color.FromArgb(210, 96, 58), 1.8f))
            {
                mouth.StartCap = LineCap.Round;
                mouth.EndCap = LineCap.Round;
                g.DrawArc(mouth, 44, 61, 12, 10, 20, 140);
            }
            // 领口（水手领 + 小领结）
            using (GraphicsPath collar = new GraphicsPath())
            {
                collar.AddBezier(30, 72, 38, 80, 62, 80, 70, 72);
                collar.AddBezier(70, 72, 64, 82, 58, 86, 50, 86);
                collar.AddBezier(50, 86, 42, 86, 36, 82, 30, 72);
                collar.CloseFigure();
                using (SolidBrush collarBrush = new SolidBrush(Color.FromArgb(245, 249, 255)))
                {
                    g.FillPath(collarBrush, collar);
                }
                using (Pen collarPen = new Pen(Color.FromArgb(120, 77, 107, 254), 1.2f))
                {
                    g.DrawPath(collarPen, collar);
                }
            }
            using (SolidBrush tie = new SolidBrush(UiTheme.Pink))
            {
                g.FillEllipse(tie, 47, 77, 6, 5);
            }
            // 尾巴蝴蝶结
            using (SolidBrush bow = new SolidBrush(Color.FromArgb(235, UiTheme.Pink)))
            {
                g.FillEllipse(bow, 78, 36, 9, 7);
                g.FillEllipse(bow, 85, 40, 9, 7);
                g.FillEllipse(bow, 82, 40, 6, 6);
            }
        }
        else
        {
            // 小图标：简化眼睛
            using (SolidBrush eyeBrush = new SolidBrush(Eye))
            {
                g.FillEllipse(eyeBrush, 35, 46, 10, 13);
                g.FillEllipse(eyeBrush, 58, 46, 10, 13);
            }
            using (SolidBrush highlight = new SolidBrush(Color.White))
            {
                g.FillEllipse(highlight, 37, 48, 3, 3);
                g.FillEllipse(highlight, 60, 48, 3, 3);
            }
        }

        g.Restore(state);
    }

    private static void DrawEye(Graphics g, float cx, float cy, float scale)
    {
        float w = 12f * scale;
        float h = 15f * scale;
        using (SolidBrush eyeBrush = new SolidBrush(Eye))
        {
            g.FillEllipse(eyeBrush, cx - w / 2f, cy - h / 2f, w, h);
        }
        using (SolidBrush shine = new SolidBrush(Color.White))
        {
            g.FillEllipse(shine, cx - w / 2f + 2f, cy - h / 2f + 2f, w * 0.34f, h * 0.34f);
        }
        using (SolidBrush blueShine = new SolidBrush(Color.FromArgb(190, UiTheme.Cyan)))
        {
            g.FillEllipse(blueShine, cx - 1f, cy + 1f, w * 0.2f, h * 0.2f);
        }
        using (Pen lash = new Pen(Color.FromArgb(235, 24, 36, 82), 1.2f))
        {
            g.DrawArc(lash, cx - w / 2f - 1f, cy - h / 2f - 1f, w + 2f, h, 200, 70);
        }
    }

    private static void DrawBubble(Graphics g, float x, float y, float r, Color color)
    {
        using (SolidBrush brush = new SolidBrush(color))
        {
            g.FillEllipse(brush, x, y, r * 2, r * 2);
        }
        using (SolidBrush shine = new SolidBrush(Color.FromArgb(200, 255, 255, 255)))
        {
            g.FillEllipse(shine, x + r * 0.3f, y + r * 0.3f, r * 0.5f, r * 0.5f);
        }
    }
}

/// <summary>大肥鱼控件（可缩放到任意大小）。</summary>
internal sealed class WhaleMascotControl : Control
{
    public bool Simplified { get; set; }
    public bool ShowGlow { get; set; }

    public WhaleMascotControl()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
            | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        Size = new Size(32, 32);
        Simplified = true;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (BackColor.A > 0)
        {
            using (SolidBrush backdrop = new SolidBrush(BackColor))
            {
                e.Graphics.FillRectangle(backdrop, ClientRectangle);
            }
        }
        WhaleGirl.Draw(e.Graphics, new Rectangle(0, 0, Width, Height), Simplified, ShowGlow);
    }
}

/// <summary>圆角卡片容器（自绘背景/描边，子控件透明）。</summary>
internal sealed class CardPanel : Panel
{
    public Color FillTop = UiTheme.PanelBg2;
    public Color FillBottom = UiTheme.PanelBg;
    public Color Border = UiTheme.Line;
    public int Radius = 14;

    public CardPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
            | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
            | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        Padding = new Padding(10);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        // 完全自绘，避免透明背景闪烁
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath path = UiTheme.RoundedRect(rect, Radius))
        using (LinearGradientBrush brush = new LinearGradientBrush(rect, FillTop, FillBottom, 90f))
        {
            e.Graphics.FillPath(brush, path);
            using (Pen pen = new Pen(Border))
            {
                e.Graphics.DrawPath(pen, path);
            }
        }
    }
}

/// <summary>圆角按钮（带 hover / pressed 状态）。</summary>
internal sealed class RoundButton : Button
{
    public Color NormalBack = UiTheme.PanelBg2;
    public Color HoverBack = UiTheme.PanelBg3;
    public Color PressedBack = UiTheme.AccentDark;
    public Color BorderColor = UiTheme.Line;
    public int Radius = 10;

    private bool hover;
    private bool pressed;

    public RoundButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
            | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        ForeColor = UiTheme.TextColor;
        Cursor = Cursors.Hand;
        Font = UiTheme.BodyFont;
        AutoSize = true;
        Padding = new Padding(10, 5, 10, 5);
    }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Color back = pressed ? PressedBack : (hover ? HoverBack : NormalBack);
        Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath path = UiTheme.RoundedRect(rect, Radius))
        {
            // 轻微底部投影
            using (SolidBrush shadow = new SolidBrush(Color.FromArgb(45, 0, 0, 0)))
            {
                using (GraphicsPath shadowPath = UiTheme.RoundedRect(new Rectangle(1, 2, Width - 1, Height - 1), Radius))
                {
                    e.Graphics.FillPath(shadow, shadowPath);
                }
            }
            using (SolidBrush brush = new SolidBrush(back))
            {
                e.Graphics.FillPath(brush, path);
            }
            if (BorderColor.A > 0)
            {
                using (Pen pen = new Pen(BorderColor))
                {
                    e.Graphics.DrawPath(pen, path);
                }
            }
        }
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, Enabled ? ForeColor : UiTheme.Muted,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}

/// <summary>圆形头像（渐变底 + 首字母/大肥鱼）。</summary>
internal sealed class AvatarControl : Control
{
    public string Initial = "?";
    public bool Outgoing;

    public AvatarControl()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
            | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        Size = new Size(34, 34);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
        Color from = Outgoing ? UiTheme.Accent : Color.FromArgb(64, 132, 255);
        Color to = Outgoing ? UiTheme.Lavender : UiTheme.Cyan;
        using (LinearGradientBrush brush = new LinearGradientBrush(rect, from, to, 45f))
        {
            e.Graphics.FillEllipse(brush, rect);
        }
        if (Outgoing)
        {
            GraphicsState state = e.Graphics.Save();
            using (GraphicsPath clip = UiTheme.EllipsePath(new RectangleF(0, 0, Width, Height)))
            {
                e.Graphics.SetClip(clip);
                WhaleGirl.Draw(e.Graphics, new Rectangle(1, 1, Width - 2, Height - 2), true, false);
            }
            e.Graphics.Restore(state);
        }
        else
        {
            using (SolidBrush text = new SolidBrush(UiTheme.Bg))
            {
                e.Graphics.DrawString(Initial, UiTheme.MascotFont, text, new RectangleF(0, 1, Width, Height), UiTheme.Centered);
            }
        }
    }
}

/// <summary>圆角消息气泡容器（内容控件放在内部）。</summary>
internal sealed class BubblePanel : Panel
{
    public bool Outgoing;
    public int Radius = 14;

    public BubblePanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
            | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
    }

    protected override void OnPaintBackground(PaintEventArgs e) { }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath path = UiTheme.RoundedRect(rect, Radius))
        {
            if (Outgoing)
            {
                using (LinearGradientBrush brush = new LinearGradientBrush(rect,
                    Color.FromArgb(72, 104, 255), Color.FromArgb(48, 76, 210), 45f))
                using (Pen pen = new Pen(Color.FromArgb(120, 130, 165, 255)))
                {
                    e.Graphics.FillPath(brush, path);
                    e.Graphics.DrawPath(pen, path);
                }
            }
            else
            {
                using (LinearGradientBrush brush = new LinearGradientBrush(rect,
                    Color.FromArgb(28, 44, 76), Color.FromArgb(22, 35, 62), 45f))
                using (Pen pen = new Pen(UiTheme.Line))
                {
                    e.Graphics.FillPath(brush, path);
                    e.Graphics.DrawPath(pen, path);
                }
            }
        }
    }
}

/// <summary>DeepSeek 深色标签页（自绘标签头）。</summary>
internal sealed class DarkTabControl : TabControl
{
    public DarkTabControl()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
            | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        DrawMode = TabDrawMode.OwnerDrawFixed;
        SizeMode = TabSizeMode.Fixed;
        ItemSize = new Size(118, 36);
        Padding = new Point(0, 0);
        Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);
        BackColor = UiTheme.PanelBg;
        DrawItem += DrawTabItem;
    }

    private void DrawTabItem(object sender, DrawItemEventArgs e)
    {
        Rectangle bounds = GetTabRect(e.Index);
        bool selected = SelectedIndex == e.Index;
        using (SolidBrush back = new SolidBrush(selected ? UiTheme.PanelBg3 : UiTheme.PanelBg))
        {
            e.Graphics.FillRectangle(back, bounds);
        }
        if (selected)
        {
            using (LinearGradientBrush accent = new LinearGradientBrush(
                new Rectangle(bounds.Left + 14, bounds.Bottom - 4, bounds.Width - 28, 3),
                UiTheme.Accent, UiTheme.Cyan, 0f))
            {
                e.Graphics.FillRectangle(accent, new Rectangle(bounds.Left + 14, bounds.Bottom - 4, bounds.Width - 28, 3));
            }
        }
        TextRenderer.DrawText(e.Graphics, TabPages[e.Index].Text, Font, bounds,
            selected ? UiTheme.TextColor : UiTheme.Muted,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }

}

/// <summary>DeepSeek 深色细滚动条（8px，圆角渐变滑块）。</summary>
internal sealed class SlimScrollBar : Control
{
    private int minimum;
    private int maximum;
    private int pageSize = 1;
    private int value;
    private bool hover;
    private bool dragging;
    private int dragOffset;

    public event EventHandler ValueChanged;

    public SlimScrollBar()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
            | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Width = 10;
        Cursor = Cursors.Hand;
        BackColor = UiTheme.PanelBg;
        TabStop = false;
    }

    public void SetState(int min, int max, int page, int current)
    {
        if (page < 1) { page = 1; }
        if (max < min) { max = min; }
        if (current < min) { current = min; }
        if (current > max) { current = max; }
        if (minimum == min && maximum == max && pageSize == page && value == current) { return; }
        minimum = min;
        maximum = max;
        pageSize = page;
        value = current;
        Invalidate();
    }

    public int GetValue() { return value; }

    private bool NeedsScroll { get { return maximum - minimum + 1 > pageSize; } }

    private Rectangle TrackRect { get { return new Rectangle(2, 2, Math.Max(1, Width - 4), Math.Max(1, Height - 4)); } }

    private Rectangle ThumbRect()
    {
        Rectangle track = TrackRect;
        if (!NeedsScroll) { return Rectangle.Empty; }
        int total = maximum - minimum + 1;
        int thumbHeight = Math.Max(28, (int)((long)track.Height * pageSize / total));
        if (thumbHeight > track.Height) { thumbHeight = track.Height; }
        int span = Math.Max(1, total - pageSize);
        int offset = (int)((long)(value - minimum) * (track.Height - thumbHeight) / span);
        return new Rectangle(track.X, track.Y + offset, track.Width, thumbHeight);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        e.Graphics.Clear(BackColor);
        Rectangle track = TrackRect;
        using (GraphicsPath trackPath = UiTheme.RoundedRect(track, 4))
        using (SolidBrush trackBrush = new SolidBrush(UiTheme.PanelBg2))
        {
            e.Graphics.FillPath(trackBrush, trackPath);
        }
        if (!NeedsScroll) { return; }
        Rectangle thumb = ThumbRect();
        if (thumb.Width <= 0 || thumb.Height <= 0) { return; }
        using (GraphicsPath thumbPath = UiTheme.RoundedRect(thumb, 4))
        using (LinearGradientBrush brush = new LinearGradientBrush(thumb,
            hover || dragging ? UiTheme.Cyan : UiTheme.Accent,
            hover || dragging ? UiTheme.AccentBright : UiTheme.AccentDark, 90f))
        {
            e.Graphics.FillPath(brush, thumbPath);
        }
    }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        Rectangle thumb = ThumbRect();
        if (thumb.Contains(e.Location))
        {
            dragging = true;
            dragOffset = e.Y - thumb.Y;
        }
        else
        {
            int step = Math.Max(1, pageSize);
            int next = e.Y < thumb.Y ? value - step : value + step;
            SetValue(next);
        }
        base.OnMouseDown(e);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (dragging && NeedsScroll)
        {
            Rectangle track = TrackRect;
            Rectangle thumb = ThumbRect();
            int travel = Math.Max(1, track.Height - thumb.Height);
            int position = Math.Max(track.Y, Math.Min(track.Y + travel, e.Y - dragOffset));
            int span = Math.Max(1, maximum - minimum + 1 - pageSize);
            int next = minimum + (int)((long)(position - track.Y) * span / travel);
            SetValue(next);
        }
        base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        dragging = false;
        Invalidate();
        base.OnMouseUp(e);
    }

    private void SetValue(int next)
    {
        if (next < minimum) { next = minimum; }
        if (next > maximum - pageSize + 1) { next = maximum - pageSize + 1; }
        if (next == value) { return; }
        value = next;
        Invalidate();
        if (ValueChanged != null) { ValueChanged(this, EventArgs.Empty); }
    }
}

/// <summary>把原生滚动目标包成「内容 + 深色细滚动条」区域。</summary>
internal sealed class SlimScrollArea : Panel
{
    private const int SB_VERT = 1;
    private const uint WM_VSCROLL = 0x0115;
    private const int SB_THUMBTRACK = 5;
    private const uint SIF_ALL = 0x17;
    private const uint SIF_POS = 0x4;
    private const uint SIF_TRACKPOS = 0x10;

    [StructLayout(LayoutKind.Sequential)]
    private struct SCROLLINFO
    {
        public uint cbSize;
        public uint fMask;
        public int nMin;
        public int nMax;
        public uint nPage;
        public int nPos;
        public int nTrackPos;
    }

    [DllImport("user32.dll")]
    private static extern bool ShowScrollBar(IntPtr hWnd, int wBar, bool bShow);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern bool RedrawWindow(IntPtr hWnd, IntPtr rect, IntPtr region, uint flags);

    private const int GWL_STYLE = -16;
    private const long WS_VSCROLL = 0x00200000L;

    [DllImport("user32.dll")]
    private static extern bool GetScrollInfo(IntPtr hwnd, int bar, ref SCROLLINFO info);

    [DllImport("user32.dll")]
    private static extern int SetScrollInfo(IntPtr hwnd, int bar, ref SCROLLINFO info, bool redraw);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    private readonly SlimScrollBar bar;
    private readonly Timer syncTimer = new Timer();
    private Control target;
    private Func<int[]> getState;
    private Action<int> setValue;
    private bool syncing;
    private bool hidingNative;
    private TargetHook targetHook;
    private static readonly List<SlimScrollArea> ActiveAreas = new List<SlimScrollArea>();

    private const int WM_NCCALCSIZE = 0x0083;
    private const int WM_NCPAINT = 0x0085;
    private const int WM_STYLECHANGING = 0x007C;
    private const int WM_STYLECHANGED = 0x007D;
    private const int WM_WINDOWPOSCHANGED = 0x0047;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_PAINT = 0x000F;

    private SlimScrollArea()
    {
        BackColor = UiTheme.PanelBg;
        Padding = new Padding(0);
        bar = new SlimScrollBar { Dock = DockStyle.Right };
        bar.ValueChanged += (s, e) => { if (!syncing) { setValue(bar.GetValue()); } };
        syncTimer.Interval = 220;
        syncTimer.Tick += (s, e) => Sync();
        ActiveAreas.Add(this);
        Disposed += (s, e) =>
        {
            try { syncTimer.Stop(); syncTimer.Dispose(); } catch { }
            DetachTargetHook();
            ActiveAreas.Remove(this);
        };
    }

    public bool HitTest(Control control)
    {
        if (control == null || target == null) { return false; }
        if (control == target || control == this) { return true; }
        return target.Contains(control) || Contains(control);
    }

    public void ScrollBy(int wheelDelta)
    {
        if (getState == null || wheelDelta == 0) { return; }
        int[] state = getState();
        int total = state[1] - state[0] + 1;
        if (total <= state[2]) { return; }
        int step = Math.Max(1, state[2] / 5);
        int direction = wheelDelta > 0 ? -1 : 1;
        setValue(state[3] + direction * step);
    }

    public static bool RouteWheel(Control control, int wheelDelta)
    {
        if (control == null) { return false; }
        SlimScrollArea[] areas;
        lock (ActiveAreas) { areas = ActiveAreas.ToArray(); }
        foreach (SlimScrollArea area in areas)
        {
            if (area.HitTest(control))
            {
                area.ScrollBy(wheelDelta);
                return true;
            }
        }
        return false;
    }

    public static SlimScrollArea Create(Control target)
    {
        SlimScrollArea area = new SlimScrollArea
        {
            Dock = target.Dock,
            Margin = target.Margin,
            BackColor = target.BackColor,
        };
        target.Dock = DockStyle.Fill;
        area.target = target;
        area.Controls.Add(target);
        area.Controls.Add(area.bar);
        area.BindState();
        target.HandleCreated += (s, e) => { area.AttachTargetHook(); area.HideNative(); };
        target.Resize += (s, e) => { area.HideNative(); area.Sync(); };
        target.HandleDestroyed += (s, e) => { try { area.syncTimer.Stop(); } catch { } area.DetachTargetHook(); };
        area.AttachTargetHook();
        area.HideNative();
        area.Sync();
        area.syncTimer.Start();
        return area;
    }

    private void BindState()
    {
        ScrollableControl scrollable = target as ScrollableControl;
        if (scrollable != null)
        {
            scrollable.AutoScroll = true;
            getState = () =>
            {
                int value = -scrollable.AutoScrollPosition.Y;
                int page = Math.Max(1, scrollable.ClientSize.Height);
                return new[] { scrollable.VerticalScroll.Minimum, scrollable.VerticalScroll.Maximum, page, value };
            };
            setValue = value =>
            {
                syncing = true;
                scrollable.AutoScrollPosition = new Point(0, value);
                syncing = false;
                HideNative();
                Sync();
            };
            scrollable.Scroll += (s, e) => HideNative();
            scrollable.MouseWheel += (s, e) => HideNative();
            return;
        }
        ListBox list = target as ListBox;
        if (list != null)
        {
            getState = () =>
            {
                int page = Math.Max(1, list.ClientSize.Height / Math.Max(1, list.ItemHeight));
                return new[] { 0, Math.Max(0, list.Items.Count - 1), page, Math.Max(0, list.TopIndex) };
            };
            setValue = value =>
            {
                if (list.Items.Count == 0) { return; }
                if (value < 0) { value = 0; }
                if (value > list.Items.Count - 1) { value = list.Items.Count - 1; }
                list.TopIndex = value;
                list.Invalidate();
                HideNative();
                Sync();
            };
            list.MouseWheel += (s, e) => { HideNative(); syncTimer.Stop(); syncTimer.Start(); };
            list.SelectedIndexChanged += (s, e) => Sync();
            return;
        }
        TextBox edit = target as TextBox;
        if (edit != null)
        {
            getState = () =>
            {
                SCROLLINFO info = new SCROLLINFO();
                info.cbSize = (uint)Marshal.SizeOf(typeof(SCROLLINFO));
                info.fMask = SIF_ALL;
                if (edit.IsHandleCreated && GetScrollInfo(edit.Handle, SB_VERT, ref info))
                {
                    return new[] { info.nMin, info.nMax, (int)Math.Max(1, info.nPage), info.nPos };
                }
                return new[] { 0, Math.Max(0, edit.Lines.Length - 1), 1, 0 };
            };
            setValue = value =>
            {
                if (!edit.IsHandleCreated) { return; }
                SCROLLINFO info = new SCROLLINFO();
                info.cbSize = (uint)Marshal.SizeOf(typeof(SCROLLINFO));
                info.fMask = SIF_ALL;
                GetScrollInfo(edit.Handle, SB_VERT, ref info);
                info.fMask = SIF_POS | SIF_TRACKPOS;
                info.nPos = value;
                info.nTrackPos = value;
                SetScrollInfo(edit.Handle, SB_VERT, ref info, true);
                SendMessage(edit.Handle, WM_VSCROLL, (IntPtr)(SB_THUMBTRACK | (value << 16)), IntPtr.Zero);
                HideNative();
                Sync();
            };
            edit.MouseWheel += (s, e) => HideNative();
            return;
        }
        RichTextBox rich = target as RichTextBox;
        if (rich != null)
        {
            getState = () =>
            {
                SCROLLINFO info = new SCROLLINFO();
                info.cbSize = (uint)Marshal.SizeOf(typeof(SCROLLINFO));
                info.fMask = SIF_ALL;
                if (rich.IsHandleCreated && GetScrollInfo(rich.Handle, SB_VERT, ref info))
                {
                    return new[] { info.nMin, info.nMax, (int)Math.Max(1, info.nPage), info.nPos };
                }
                return new[] { 0, Math.Max(0, rich.Lines.Length - 1), 1, 0 };
            };
            setValue = value =>
            {
                if (!rich.IsHandleCreated) { return; }
                SCROLLINFO info = new SCROLLINFO();
                info.cbSize = (uint)Marshal.SizeOf(typeof(SCROLLINFO));
                info.fMask = SIF_ALL;
                GetScrollInfo(rich.Handle, SB_VERT, ref info);
                info.fMask = SIF_POS | SIF_TRACKPOS;
                info.nPos = value;
                info.nTrackPos = value;
                SetScrollInfo(rich.Handle, SB_VERT, ref info, true);
                SendMessage(rich.Handle, WM_VSCROLL, (IntPtr)(SB_THUMBTRACK | (value << 16)), IntPtr.Zero);
                HideNative();
                Sync();
            };
            rich.MouseWheel += (s, e) => HideNative();
            return;
        }
        getState = () => new[] { 0, 0, 1, 0 };
        setValue = value => { };
    }

    private void HideNative()
    {
        EnsureNoScrollbarStyle();
    }

    /// <summary>反复强制移除 WS_VSCROLL（WinForms 滚动/布局时可能重新加回）。</summary>
    private void EnsureNoScrollbarStyle()
    {
        if (hidingNative || target == null || !target.IsHandleCreated) { return; }
        hidingNative = true;
        try
        {
            long style = GetWindowLongPtr(target.Handle, GWL_STYLE).ToInt64();
            if ((style & WS_VSCROLL) != 0)
            {
                SetWindowLongPtr(target.Handle, GWL_STYLE, (IntPtr)(style & ~WS_VSCROLL));
                ShowScrollBar(target.Handle, SB_VERT, false);
                // 强制非客户区重算并重绘，否则 ListBox 等控件会残留旧滚动条像素（白色竖条）
                SetWindowPos(target.Handle, IntPtr.Zero, 0, 0, 0, 0,
                    0x0002 | 0x0001 | 0x0004 | 0x0010 | 0x0020); // NOMOVE|NOSIZE|NOZORDER|NOACTIVATE|FRAMECHANGED
                RedrawWindow(target.Handle, IntPtr.Zero, IntPtr.Zero, 0x0001 | 0x0004 | 0x0100 | 0x0080); // INVALIDATE|NOERASE|UPDATENOW|ALLCHILDREN
                target.Invalidate();
            }
        }
        catch { }
        finally { hidingNative = false; }
    }

    private void AttachTargetHook()
    {
        if (target == null || !target.IsHandleCreated) { return; }
        DetachTargetHook();
        targetHook = new TargetHook(this);
        targetHook.AssignHandle(target.Handle);
        HideNative();
    }

    private void DetachTargetHook()
    {
        if (targetHook == null) { return; }
        try { targetHook.ReleaseHandle(); } catch { }
        targetHook = null;
    }

    private sealed class TargetHook : NativeWindow
    {
        private readonly SlimScrollArea area;

        public TargetHook(SlimScrollArea area) { this.area = area; }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCCALCSIZE || m.Msg == WM_WINDOWPOSCHANGED || m.Msg == WM_STYLECHANGING)
            {
                area.EnsureNoScrollbarStyle();
            }
            base.WndProc(ref m);
            if (m.Msg == WM_NCPAINT || m.Msg == WM_STYLECHANGED || m.Msg == WM_VSCROLL || m.Msg == WM_MOUSEWHEEL || m.Msg == WM_PAINT)
            {
                area.EnsureNoScrollbarStyle();
            }
        }
    }

    private void Sync()
    {
        try
        {
            if (getState == null || target == null || target.IsDisposed) { return; }
            HideNative();
            int[] state = getState();
            int min = state[0];
            int max = state[1];
            int page = state[2];
            int value = state[3];
            syncing = true;
            bar.SetState(min, max, page, value);
            bar.Visible = (max - min + 1 > page);
            syncing = false;
        }
        catch { }
    }
}

/// <summary>把鼠标滚轮路由到光标下的 SlimScrollArea（统一各区域滚动行为）。</summary>
internal sealed class WheelRouter : IMessageFilter
{
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);

    public static readonly WheelRouter Instance = new WheelRouter();

    private const int WM_MOUSEWHEEL = 0x020A;

    public bool PreFilterMessage(ref Message m)
    {
        if (m.Msg != WM_MOUSEWHEEL) { return false; }
        try
        {
            Point cursor = Cursor.Position;
            IntPtr handle = WindowFromPoint(new POINT { X = cursor.X, Y = cursor.Y });
            Control control = Control.FromChildHandle(handle);
            if (control == null) { control = Control.FromHandle(handle); }
            if (control == null) { return false; }
            if (control is ComboBox || control is NumericUpDown) { return false; }
            long wparam = m.WParam.ToInt64();
            int delta = (short)((wparam >> 16) & 0xFFFF);
            return SlimScrollArea.RouteWheel(control, delta);
        }
        catch { return false; }
    }
}
