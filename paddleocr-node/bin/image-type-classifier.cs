using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

class ImageTypeClassifier
{
    static void Main(string[] args)
    {
        if (args.Length < 1) throw new ArgumentException("missing image path");
        using (var img = new Bitmap(args[0]))
        {
            const double side = 720.0;
            var scale = Math.Min(1.0, side / Math.Max(img.Width, img.Height));
            var w = Math.Max(1, (int)Math.Round(img.Width * scale));
            var h = Math.Max(1, (int)Math.Round(img.Height * scale));
            using (var small = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(small))
                    g.DrawImage(img, 0, 0, w, h);

                var rect = new Rectangle(0, 0, w, h);
                var bits = small.LockBits(rect, ImageLockMode.ReadOnly, small.PixelFormat);
                try
                {
                    var stride = Math.Abs(bits.Stride);
                    var bytes = new byte[stride * h];
                    Marshal.Copy(bits.Scan0, bytes, 0, bytes.Length);

                    double white = 0, edgeWhite = 0, edgePixels = 0, dark = 0, black = 0, markBlack = 0, colored = 0, transitions = 0, outerBlack = 0, outerPixels = 0;
                    for (var y = 0; y < h; y += 2)
                    {
                        var prevInk = false;
                        var row = y * stride;
                        for (var x = 0; x < w; x += 2)
                        {
                            var i = row + x * 3;
                            var b = bytes[i];
                            var gg = bytes[i + 1];
                            var r = bytes[i + 2];
                            var max = Math.Max(r, Math.Max(gg, b));
                            var min = Math.Min(r, Math.Min(gg, b));
                            var bright = (r + gg + b) / 3.0;
                            var isWhite = r > 238 && gg > 238 && b > 238 && max - min < 18;
                            var isDark = bright < 92;
                            var isInk = bright < 150 && max - min < 55;
                            var isBlack = bright < 70 && max - min < 45;
                            var nearWhite = false;
                            if (isBlack)
                            {
                                for (var dy = -10; dy <= 10 && !nearWhite; dy += 10)
                                {
                                    for (var dx = -10; dx <= 10; dx += 10)
                                    {
                                        if (dx == 0 && dy == 0) continue;
                                        var xx = x + dx;
                                        var yy = y + dy;
                                        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
                                        var ni = yy * stride + xx * 3;
                                        var nb = bytes[ni];
                                        var ng = bytes[ni + 1];
                                        var nr = bytes[ni + 2];
                                        var nmax = Math.Max(nr, Math.Max(ng, nb));
                                        var nmin = Math.Min(nr, Math.Min(ng, nb));
                                        if (nr > 238 && ng > 238 && nb > 238 && nmax - nmin < 18)
                                        {
                                            nearWhite = true;
                                            break;
                                        }
                                    }
                                }
                            }

                            if (isWhite) white++;
                            if (isDark) dark++;
                            if (isBlack) black++;
                            if (nearWhite) markBlack++;
                            if (max - min > 45 && bright > 70 && bright < 230) colored++;
                            if (x < w * .08 || x > w * .92 || y < h * .08 || y > h * .92)
                            {
                                edgePixels++;
                                if (isWhite) edgeWhite++;
                            }
                            if (x < w * .25 || x > w * .75 || y < h * .25 || y > h * .75)
                            {
                                outerPixels++;
                                if (isBlack) outerBlack++;
                            }
                            if (x > 0 && isInk != prevInk) transitions++;
                            prevInk = isInk;
                        }
                    }

                    var sampled = Math.Ceiling(w / 2.0) * Math.Ceiling(h / 2.0);
                    var whiteRatio = white / sampled;
                    var edgeWhiteRatio = edgePixels > 0 ? edgeWhite / edgePixels : 0;
                    var darkRatio = dark / sampled;
                    var blackRatio = black / sampled;
                    var markBlackShare = black > 0 ? markBlack / black : 0;
                    var outerBlackRatio = outerPixels > 0 ? outerBlack / outerPixels : 0;
                    var colorRatio = colored / sampled;
                    var transitionRatio = transitions / sampled;

                    string category, reason;
                    double confidence;
                    if (edgeWhiteRatio > .65 && blackRatio > .0035 && outerBlackRatio > .0025 && markBlackShare > .45)
                    {
                        category = "dimension";
                        confidence = Math.Min(.95, .58 + blackRatio * 20 + outerBlackRatio * 30 + transitionRatio);
                        reason = "dimension_marks";
                    }
                    else if (edgeWhiteRatio > .82 && whiteRatio > .25)
                    {
                        category = "white_background";
                        confidence = Math.Min(.95, .58 + edgeWhiteRatio * .32 + whiteRatio * .12);
                        reason = "white_background";
                    }
                    else
                    {
                        category = "other";
                        confidence = Math.Min(.9, .55 + Math.Abs(colorRatio - darkRatio));
                        reason = "other";
                    }

                    Console.WriteLine("{\"category\":\"" + category + "\",\"confidence\":" + confidence.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture) + ",\"reason\":\"" + reason + "\"}");
                }
                finally
                {
                    small.UnlockBits(bits);
                }
            }
        }
    }
}
