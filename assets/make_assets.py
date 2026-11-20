"""README artwork for Pigment: hero and the two views, light and dark.
Run: python3 assets/make_assets.py   (writes assets/*.svg next to this file)
The numbers in the pictures are examples, and say so."""
import pathlib

OUT = pathlib.Path(__file__).parent

THEMES = {
    "light": dict(bg="#fbfaf6", surface="#f4f2ec", pane="#ffffff", ink="#1a1a18", muted="#6b675e", line="#e6e3d9",
                  accent="#b87524", amber="#e8a86a", btn="#1a1a18", btnink="#fbfaf6", track="#ece9e0", warn="#b87524"),
    "dark":  dict(bg="#0e0e0c", surface="#171715", pane="#1c1c1a", ink="#f6f5f2", muted="#a3a39b", line="rgba(255,255,255,.13)",
                  accent="#e8a86a", amber="#e8a86a", btn="#e8a86a", btnink="#2a1c0a", track="rgba(255,255,255,.10)", warn="#e8a86a"),
}
FONT = "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
SWATCHES = ["#e8a86a", "#d97757", "#5b7fd4", "#5ba87a", "#8b6bc4"]   # amber, Pigment's body, work, health, errands

# Pigment's own pixel figures (plugin/hooks/figures.ts)
MANAGER = ['......LLLLLL......', '......HHHHHH......', '......GGGGGG......', '...HHHHHHHHHHHH...',
           '....OOOOOOOOOO....', '....OOOOOOOOOO....', '....OOOOOOBBBO....', '..OOOOKKOOBKBOOO..',
           '..OOOOOOOOBBBOOO..', '....OOOOOOOOOB....', '....OOOOOOOOOOB...', '....DDDDDDDDDD.B..',
           '.....O.O..O.O.....', '.....O.O..O.O.....']
DEVELOPER = ['..................'] * 4 + ['....OOOOOOOOOO....', '....OOOOOOOOOO....', '....OOKOOOOKOO....',
             '..OOOOKOOOOKOOOO..', '..OOSSSSSSSSSSOO..', '....WWWWWWWWWW....', '....WWWWSSWWWW....',
             '....WWWWWWWWWW....', '...SSSSSSSSSSSS...', '.....O.O..O.O.....']
PIX = dict(O="#d97757", D="#b5603f", K="#1a1a18", H="#3b3936", L="#5a5651", G="#8b7d6b", B="#5b7fd4", W="#f2f0ea", S="#a8a29a")


def figure(grid, x, y, px, cls=""):
    rects = "".join(f'<rect x="{c}" y="{r}" width="1.02" height="1.02" fill="{PIX[ch]}"/>'
                    for r, row in enumerate(grid) for c, ch in enumerate(row) if ch in PIX)
    return (f'<g class="{cls}"><g transform="translate({x} {y}) scale({px})" shape-rendering="crispEdges">'
            f'{rects}</g></g>')


def T(x, y, s, size, weight=400, fill="var(--ink)", anchor="start", extra=""):
    return (f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
            f'text-anchor="{anchor}" {extra}>{s}</text>')


def wrap(w, h, t, body, css, title, desc):
    v = ";".join(f"--{k}:{val}" for k, val in t.items())
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="t d">
<title id="t">{title}</title><desc id="d">{desc}</desc>
<style>
svg{{{v}}}
text{{font-family:{FONT};font-variant-numeric:tabular-nums}}
.mono{{font-family:{MONO}}}
{css}
@media (prefers-reduced-motion: reduce){{*{{animation:none!important}}.stroke{{stroke-dashoffset:0!important}}.fill{{transform:none!important}}}}
</style>
<rect width="{w}" height="{h}" rx="20" fill="var(--bg)"/>
<rect x="1" y="1" width="{w-2}" height="{h-2}" rx="19" fill="none" stroke="var(--line)"/>
{body}
</svg>
'''


def row(x, y, w, label, value, note):
    return (T(x, y, label, 15, 500, "var(--muted)") + T(x + w, y, value, 22, 600, anchor="end")
            + T(x, y + 22, note, 14, 400, "var(--muted)"))


def pane_dev(x, y, w, h, animated=True):
    """The developer view: Your work."""
    b = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="var(--pane)" stroke="var(--line)"/>',
         figure(DEVELOPER, x + 22, y + 8, 3.4, "bob" if animated else ""),
         T(x + 92, y + 46, "Pigment · Your work", 18, 600),
         f'<line x1="{x}" x2="{x+w}" y1="{y+68}" y2="{y+68}" stroke="var(--line)"/>']
    cy = y + 102
    b.append(row(x + 24, cy, w - 48, "This prompt", "$0.18", "12.4k written · 96k read from memory"))
    b.append(f'<line x1="{x+24}" x2="{x+w-24}" y1="{cy+40}" y2="{cy+40}" stroke="var(--line)"/>')
    cy += 72
    b.append(row(x + 24, cy, w - 48, "This task · KAN-55", "$3.40", "3 sessions · 2h 10m worked"))
    b.append(f'<line x1="{x+24}" x2="{x+w-24}" y1="{cy+40}" y2="{cy+40}" stroke="var(--line)"/>')
    cy += 72
    b.append(T(x + 24, cy, "This session", 15, 500, "var(--muted)") + T(x + w - 24, cy, "$5.12", 22, 600, anchor="end"))
    bw = w - 48
    b.append(f'<rect x="{x+24}" y="{cy+14}" width="{bw}" height="8" rx="4" fill="var(--track)"/>'
             f'<rect x="{x+24}" y="{cy+14}" width="{bw*.72:.0f}" height="8" rx="4" fill="var(--amber)"/>'
             + T(x + 24, cy + 44, "Conversation 72% full", 14, 400, "var(--muted)"))
    cy += 70
    b.append(f'<g class="nudge"><rect x="{x+24}" y="{cy}" width="{w-48}" height="46" rx="12" fill="var(--btn)"/>'
             + T(x + w / 2, cy + 29, "Optimize now", 16, 600, "var(--btnink)", "middle") + '</g>')
    b.append(T(x + w / 2, cy + 72, "A short summary to carry on in a fresh session", 13, 400, "var(--muted)", "middle"))
    return "".join(b)


def pane_mgr(x, y, w, h):
    """The manager view: The sprint."""
    b = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="var(--pane)" stroke="var(--line)"/>',
         figure(MANAGER, x + 22, y + 8, 3.4),
         T(x + 92, y + 46, "Pigment · Sprint 22", 18, 600),
         f'<line x1="{x}" x2="{x+w}" y1="{y+68}" y2="{y+68}" stroke="var(--line)"/>',
         T(x + 24, y + 98, "The team now", 15, 500, "var(--muted)")]
    for i, (name, task) in enumerate((("Ana", "KAN-045"), ("Rui", "KAN-96"), ("Inês", "KAN-102"))):
        fx = x + 24 + i * ((w - 48) / 3)
        b.append(figure(DEVELOPER, fx, y + 96, 2.2, f"bob d{i}"))
        b.append(T(fx + 46, y + 138, name, 15, 600) + T(fx + 46, y + 156, task, 13, 400, "var(--muted)", extra='class="mono"'))
    cy = y + 196
    b.append(f'<line x1="{x+24}" x2="{x+w-24}" y1="{cy-14}" y2="{cy-14}" stroke="var(--line)"/>')
    b.append(T(x + 24, cy + 8, "Sprint 22 so far", 15, 500, "var(--muted)") + T(x + w - 24, cy + 8, "$184.20", 22, 600, anchor="end"))
    cy += 42
    b.append(f'<rect x="{x+24}" y="{cy}" width="{w-48}" height="62" rx="12" fill="none" stroke="var(--warn)" stroke-opacity=".55"/>'
             + T(x + 40, cy + 24, "Worth a look", 14, 600, "var(--warn)")
             + T(x + 40, cy + 46, "KAN-045 has used 5h of its 6h.", 15, 400))
    cy += 92
    b.append(T(x + 24, cy, "In development", 15, 500, "var(--muted)"))
    for i, (k, t_, p) in enumerate((("KAN-045", "5h of 6h", .83), ("KAN-96", "2h of 4h", .5), ("KAN-102", "40m", .18))):
        yy = cy + 26 + i * 30
        b.append(T(x + 24, yy, k, 14, 500, extra='class="mono"') + T(x + w - 24, yy, t_, 14, 500, "var(--muted)", "end")
                 + f'<rect x="{x+112}" y="{yy-9}" width="{w-230}" height="6" rx="3" fill="var(--track)"/>'
                 + f'<rect x="{x+112}" y="{yy-9}" width="{(w-230)*p:.0f}" height="6" rx="3" fill="{"var(--warn)" if p > .8 else "var(--muted)"}" fill-opacity="{1 if p > .8 else .5}"/>')
    return "".join(b)


ANIM = (".stroke{stroke-dasharray:420;stroke-dashoffset:420;animation:draw 1.4s .3s cubic-bezier(.65,0,.35,1) forwards}"
        "@keyframes draw{to{stroke-dashoffset:0}}"
        ".fill{animation:fill 2.2s .6s cubic-bezier(.65,0,.35,1) both}"
        "@keyframes fill{from{transform:scaleX(.08)}to{transform:scaleX(1)}}"
        ".nudge{animation:nudge 2.4s 2.8s ease-in-out infinite}"
        "@keyframes nudge{0%,100%{transform:none}50%{transform:translateY(-2px)}}"
        ".bob{animation:bob 1.6s steps(2) infinite}.d1{animation-delay:.4s}.d2{animation-delay:.8s}"
        "@keyframes bob{0%,100%{transform:none}50%{transform:translateY(-3px)}}"
        ".drop{animation:drop 3.2s ease-in-out infinite}.s1{animation-delay:.3s}.s2{animation-delay:.6s}.s3{animation-delay:.9s}.s4{animation-delay:1.2s}"
        "@keyframes drop{0%,100%{transform:none}50%{transform:translateY(-4px)}}")


def hero(th):
    t = THEMES[th]
    W, H = 1280, 520
    b = [T(72, 92, "A Claude Code mod", 18, 600, "var(--accent)"),
         T(68, 200, "Pigment", 108, 600, extra='letter-spacing="-3.5"'),
         T(74, 256, "How much paint went into each ", 28, 500, "var(--muted)", extra='textLength="400" lengthAdjust="spacingAndGlyphs"'),
         T(478, 256, "stroke.", 28, 600, "var(--accent)", extra='textLength="88" lengthAdjust="spacingAndGlyphs"'),
         '<path class="stroke" d="M 474 272 C 496 266, 528 264, 548 268 S 562 273, 568 269" fill="none" stroke="var(--amber)" stroke-width="7" stroke-linecap="round" stroke-opacity=".95"/>',
         T(74, 318, "What your AI work costs, beside the chat: each prompt,", 20, 400, "var(--muted)"),
         T(74, 346, "each task, each session, and the sprint for whoever runs it.", 20, 400, "var(--muted)")]
    for i, c in enumerate(SWATCHES):
        b.append(f'<g class="drop s{i}"><rect x="{74 + i*58}" y="392" width="44" height="44" rx="12" fill="{c}"/></g>')
    b.append(pane_dev(800, 40, 410, 440))
    b.append(T(1005, 506, "Example numbers", 12, 500, "var(--muted)", "middle"))
    return wrap(W, H, t, "".join(b), ANIM, "Pigment",
                "Pigment, a Claude Code mod: how much paint went into each stroke. What your AI work costs, beside the chat. "
                "Example of the Your work pane: this prompt, this task, this session, and Optimize now.")


def views(th):
    t = THEMES[th]
    W, H = 1280, 650
    b = [T(72, 70, "Two views", 15, 600, "var(--accent)"),
         T(72, 108, "One for the work, one for the sprint.", 30, 600, extra='letter-spacing="-.6"'),
         pane_dev(72, 140, 540, 460), pane_mgr(668, 140, 540, 460),
         T(342, 628, "Developer · Your work", 14, 500, "var(--muted)", "middle"),
         T(938, 628, "Manager · The sprint", 14, 500, "var(--muted)", "middle"),
         T(1208, 70, "Example numbers", 13, 500, "var(--muted)", "end")]
    return wrap(W, H, t, "".join(b), ANIM, "Pigment's two views",
                "Your work, for a developer: this prompt, this task, this session, Optimize now. "
                "The sprint, for a manager: the team working now, the sprint so far, a task close to its estimate, "
                "and every task in development with its time. Example numbers.")


for th in THEMES:
    (OUT / f"hero-{th}.svg").write_text(hero(th))
    (OUT / f"views-{th}.svg").write_text(views(th))
print("ok")
