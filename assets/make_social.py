"""GitHub social preview for Pigment (1280x640 PNG).
Run: python3 assets/make_social.py  ->  assets/social-preview.png
Upload it in the repository's Settings > General > Social preview."""
import pathlib
from PIL import Image, ImageDraw, ImageFont

S = 2
W, H = 1280, 640
BG, PANE, INK, MUTED, LINE = "#fbfaf6", "#ffffff", "#1a1a18", "#6b675e", "#e6e3d9"
ACCENT, AMBER, TRACK = "#b87524", "#e8a86a", "#ece9e0"
SWATCHES = ["#e8a86a", "#d97757", "#5b7fd4", "#5ba87a", "#8b6bc4"]
FONT = "/System/Library/Fonts/SFNS.ttf"   # stands in for Geist where Geist isn't installed
DEVELOPER = ['....OOOOOOOOOO....', '....OOOOOOOOOO....', '....OOKOOOOKOO....', '..OOOOKOOOOKOOOO..',
             '..OOSSSSSSSSSSOO..', '....WWWWWWWWWW....', '....WWWWSSWWWW....', '....WWWWWWWWWW....',
             '...SSSSSSSSSSSS...', '.....O.O..O.O.....']
PIX = dict(O="#d97757", K="#1a1a18", W="#f2f0ea", S="#a8a29a")

img = Image.new("RGB", (W * S, H * S), BG)
d = ImageDraw.Draw(img)
P = lambda v: round(v * S)


def font(size, weight):
    f = ImageFont.truetype(FONT, size * S)
    f.set_variation_by_axes([100, min(max(size, 17), 96), 400, weight])
    return f


def text(x, y, s, f, fill, tracking=0):
    for ch in (s if tracking else [s]):
        d.text((P(x), P(y)), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) / S + tracking
    return x


def rtext(x, y, s, f, fill):
    return text(x - d.textlength(s, font=f) / S, y, s, f, fill)


def bezier(p0, p1, p2, p3, n=40):
    return [tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * e
                  for a, b, c, e in zip(p0, p1, p2, p3)) for t in (i / n for i in range(n + 1))]


def stroke(points, width, fill):
    pts = [(P(x), P(y)) for x, y in points]
    d.line(pts, fill=fill, width=P(width), joint="curve")
    for x, y in (pts[0], pts[-1]):
        r = P(width) / 2
        d.ellipse((x - r, y - r, x + r, y + r), fill=fill)


d.rounded_rectangle((0, 0, P(W) - 1, P(H) - 1), radius=P(28), outline=LINE, width=P(2))

# left: name and promise
text(80, 96, "A Claude Code mod", font(22, 600), ACCENT)
text(74, 140, "Pigment", font(128, 650), INK, tracking=-3.5)
f = font(32, 500)
x = text(80, 310, "How much paint went into each ", f, MUTED)
x2 = text(x, 310, "stroke.", font(32, 620), ACCENT)
y = 356
stroke(bezier((x - 4, y), (x + 22, y - 7), (x + 54, y - 9), (x + (x2 - x) * .72, y - 5))
       + bezier((x + (x2 - x) * .72, y - 5), (x2 - 10, y), (x2 - 4, y + 1), (x2 + 4, y - 3)), 7, AMBER)
text(80, 392, "What your AI work costs, beside the chat.", font(24, 400), MUTED)
for i, c in enumerate(SWATCHES):
    d.rounded_rectangle((P(80 + i * 62), P(460), P(80 + i * 62 + 46), P(506)), radius=P(13), fill=c)
text(80, 548, "github.com/Alcagoita/pigment", font(22, 500), ACCENT)

# right: the Your work pane
px, py, pw, ph = 820, 110, 380, 410
d.rounded_rectangle((P(px), P(py), P(px + pw), P(py + ph)), radius=P(18), fill=PANE, outline=LINE, width=P(2))
for r, row in enumerate(DEVELOPER):
    for c, ch in enumerate(row):
        if ch in PIX:
            sx, sy = px + 22 + c * 3.2, py + 24 + r * 3.2
            d.rectangle((P(sx), P(sy), P(sx + 3.2) - 1, P(sy + 3.2) - 1), fill=PIX[ch])
text(px + 90, py + 26, "Pigment · Your work", font(19, 620), INK)
d.line((P(px), P(py + 72), P(px + pw), P(py + 72)), fill=LINE, width=P(1.5))
yy = py + 94
for label, val, note in (("This prompt", "$0.18", "12.4k written"), ("This task · KAN-55", "$3.40", "2h 10m worked")):
    text(px + 24, yy, label, font(16, 500), MUTED)
    rtext(px + pw - 24, yy - 4, val, font(24, 620), INK)
    text(px + 24, yy + 24, note, font(15, 400), MUTED)
    d.line((P(px + 24), P(yy + 58), P(px + pw - 24), P(yy + 58)), fill=LINE, width=P(1.5))
    yy += 76
text(px + 24, yy, "This session", font(16, 500), MUTED)
rtext(px + pw - 24, yy - 4, "$5.12", font(24, 620), INK)
bw = pw - 48
d.rounded_rectangle((P(px + 24), P(yy + 32), P(px + 24 + bw), P(yy + 40)), radius=P(4), fill=TRACK)
d.rounded_rectangle((P(px + 24), P(yy + 32), P(px + 24 + bw * .72), P(yy + 40)), radius=P(4), fill=AMBER)
text(px + 24, yy + 50, "Conversation 72% full", font(15, 400), MUTED)
by = yy + 90
d.rounded_rectangle((P(px + 24), P(by), P(px + pw - 24), P(by + 50)), radius=P(13), fill=INK)
bf = font(18, 620)
text(px + pw / 2 - d.textlength("Optimize now", font=bf) / S / 2, by + 13, "Optimize now", bf, BG)
ef = font(13, 500)
text(px + pw / 2 - d.textlength("Example numbers", font=ef) / S / 2, py + ph + 14, "Example numbers", ef, MUTED)

out = pathlib.Path(__file__).with_name("social-preview.png")
img.resize((W, H), Image.LANCZOS).save(out, optimize=True)
print(out, out.stat().st_size // 1024, "KB")
