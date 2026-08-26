#!/usr/bin/env python3
"""Generate the neutral, deterministic product screenshot used by the public README."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "design" / "assets" / "ling-stack-workspace-overview.png"
WIDTH, HEIGHT = 1440, 900

FONT_REGULAR = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, size)


def rounded(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    fill: str,
    *,
    radius: int = 14,
    outline: str | None = None,
    width: int = 1,
) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    value: str,
    *,
    size: int = 16,
    fill: str = "#26332F",
    bold: bool = False,
    anchor: str | None = None,
) -> None:
    draw.text(xy, value, font=font(size, bold=bold), fill=fill, anchor=anchor)


def pill(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    label: str,
    *,
    fill: str,
    color: str,
    outline: str,
    width: int | None = None,
) -> int:
    label_width = draw.textlength(label, font=font(14, bold=True))
    pill_width = width or int(label_width + 30)
    x, y = xy
    rounded(draw, (x, y, x + pill_width, y + 34), fill, radius=17, outline=outline)
    text(draw, (x + pill_width // 2, y + 17), label, size=14, fill=color, bold=True, anchor="mm")
    return pill_width


image = Image.new("RGB", (WIDTH, HEIGHT), "#EEF2EC")
draw = ImageDraw.Draw(image)

# Window chrome
rounded(draw, (16, 14, WIDTH - 16, HEIGHT - 14), "#F7F6F1", radius=22, outline="#D7DDD5")
draw.rectangle((17, 68, WIDTH - 17, HEIGHT - 15), fill="#F7F6F1")
for x, color in ((42, "#F7655B"), (66, "#F6BF4F"), (90, "#43C269")):
    draw.ellipse((x - 7, 35 - 7, x + 7, 35 + 7), fill=color)
rounded(draw, (118, 24, 610, 50), "#FFFFFF", radius=8, outline="#DDE3DD")
text(draw, (136, 37), "http://127.0.0.1:17891", size=13, fill="#65716D", anchor="lm")
pill(draw, (1050, 20), "Daemon ready", fill="#EFF9F4", color="#08765D", outline="#B9DED0")
pill(draw, (1198, 20), "Local model", fill="#F4F6F3", color="#52605B", outline="#D7DDD5")

# Left navigation
draw.rectangle((17, 68, 260, HEIGHT - 15), fill="#F0EBDD")
rounded(draw, (32, 86, 72, 126), "#1F2926", radius=10)
text(draw, (52, 106), "L", size=21, fill="#FFFFFF", bold=True, anchor="mm")
text(draw, (86, 94), "Ling Stack", size=19, fill="#1C2925", bold=True)
text(draw, (86, 118), "Local AI workspace", size=13, fill="#73807B")

nav_items = (("Workspace", True), ("Inbox", False), ("Tasks", False), ("Runs", False))
for index, (label, active) in enumerate(nav_items):
    y = 150 + index * 43
    if active:
        rounded(draw, (30, y, 246, y + 34), "#FFFFFF", radius=8)
    text(draw, (48, y + 17), "•", size=17, fill="#08765D" if active else "#718079", anchor="lm")
    text(draw, (70, y + 17), label, size=15, fill="#25322E", anchor="lm")

text(draw, (32, 348), "CHANNELS", size=12, fill="#86908C", bold=True)
for index, label in enumerate(("# engineering", "# product", "# research")):
    y = 376 + index * 34
    if index == 0:
        rounded(draw, (30, y - 2, 246, y + 28), "#FFFFFF", radius=7)
    text(draw, (46, y + 13), label, size=14, fill="#31413B", anchor="lm")

text(draw, (32, 510), "AI TEAMMATES", size=12, fill="#86908C", bold=True)
for index, (initial, label, color) in enumerate((("E", "Engineer", "#E7873B"), ("R", "Reviewer", "#1D9B82"))):
    y = 546 + index * 42
    draw.ellipse((42, y - 12, 66, y + 12), fill=color)
    text(draw, (54, y), initial, size=12, fill="#FFFFFF", bold=True, anchor="mm")
    text(draw, (78, y), label, size=14, fill="#31413B", anchor="lm")

rounded(draw, (32, 812, 246, 850), "#FAFAF6", radius=9, outline="#D9DDD6")
text(draw, (48, 831), "Settings  ·  Plugins  ·  Models", size=13, fill="#50605A", anchor="lm")

# Main conversation surface
text(draw, (290, 94), "# engineering", size=27, fill="#15211E", bold=True)
text(draw, (290, 124), "/workspace/ling-stack-demo", size=14, fill="#6B7974")
pill(draw, (750, 86), "Daemon ready", fill="#EFF9F4", color="#08765D", outline="#B9DED0")
pill(draw, (890, 86), "Provider ready", fill="#EFF9F4", color="#08765D", outline="#B9DED0")
draw.line((278, 150, 1032, 150), fill="#E1E5E0", width=1)

# Conversation cards
for y, initial, name, color, line1, line2 in (
    (176, "L", "Ling Stack", "#E7873B", "This workspace is connected to the local daemon.", "Runs, approvals, and artifacts stay auditable."),
    (270, "E", "Engineer", "#59645F", "Prepare an open-source readiness review.", "Keep repository changes local until approved."),
    (364, "R", "Reviewer", "#1D9B82", "I will inspect repository policy and current integrations.", "High-risk actions will remain approval-gated."),
):
    draw.ellipse((292, y, 326, y + 34), fill=color)
    text(draw, (309, y + 17), initial, size=14, fill="#FFFFFF", bold=True, anchor="mm")
    rounded(draw, (340, y - 4, 1010, y + 72), "#FFFFFF", radius=12, outline="#E0E5E0")
    text(draw, (360, y + 13), name, size=15, fill="#23302C", bold=True)
    text(draw, (360, y + 39), line1, size=14, fill="#43514C")
    text(draw, (360, y + 60), line2, size=14, fill="#68746F")

# Task activity card
rounded(draw, (340, 462, 1010, 604), "#F7FBF8", radius=14, outline="#B9DED0")
text(draw, (362, 484), "Current task", size=13, fill="#08765D", bold=True)
text(draw, (362, 513), "Review public repository readiness", size=18, fill="#21302B", bold=True)
text(draw, (362, 542), "Inspect docs, CI, versioning, and publication boundaries.", size=14, fill="#5E6C67")
pill(draw, (836, 480), "In progress", fill="#FFF8E8", color="#8A5D00", outline="#E8C46B")
rounded(draw, (362, 564, 474, 591), "#FFFFFF", radius=7, outline="#D8DFD9")
text(draw, (418, 577), "Open run", size=13, fill="#3D4C47", bold=True, anchor="mm")

# Composer
rounded(draw, (290, 634, 1026, 832), "#FFFFFF", radius=14, outline="#DDE2DD")
text(draw, (312, 662), "New task", size=14, fill="#35443F", bold=True)
rounded(draw, (312, 690, 1004, 754), "#FBFCFA", radius=8, outline="#DFE4DF")
text(draw, (330, 712), "Review the current workspace and propose the next safe step.", size=14, fill="#596762")
text(draw, (330, 736), "Do not change external state without explicit approval.", size=14, fill="#7A8581")
for index, label in enumerate(("read", "search", "shell", "edit")):
    rounded(draw, (312 + index * 72, 775, 370 + index * 72, 804), "#F4F6F3", radius=7, outline="#DEE3DE")
    text(draw, (341 + index * 72, 789), label, size=12, fill="#596762", anchor="mm")
rounded(draw, (882, 770, 1004, 810), "#08765D", radius=9)
text(draw, (943, 790), "Create task", size=14, fill="#FFFFFF", bold=True, anchor="mm")

# Context sidebar
draw.rectangle((1048, 68, WIDTH - 17, HEIGHT - 15), fill="#F3F5F1")
text(draw, (1072, 94), "Workspace context", size=19, fill="#1E2B27", bold=True)
text(draw, (1072, 128), "Readiness", size=13, fill="#74817C", bold=True)
for index, (label, detail, state, fill, outline, color) in enumerate((
    ("Daemon", "Available locally", "Ready", "#EFF9F4", "#B9DED0", "#08765D"),
    ("Model provider", "1 verified model", "Ready", "#EFF9F4", "#B9DED0", "#08765D"),
    ("Approvals", "Risky actions require review", "Policy", "#FFF9EC", "#E8CB7C", "#865D0D"),
)):
    y = 154 + index * 104
    rounded(draw, (1068, y, 1414, y + 88), fill, radius=12, outline=outline)
    text(draw, (1090, y + 23), label, size=15, fill="#283630", bold=True)
    text(draw, (1090, y + 50), detail, size=13, fill="#5E6B66")
    pill(draw, (1326, y + 14), state, fill="#FFFFFF", color=color, outline=outline, width=72)

text(draw, (1072, 492), "Current integrations", size=13, fill="#74817C", bold=True)
rounded(draw, (1068, 518, 1414, 736), "#FFFFFF", radius=12, outline="#DFE4DF")
for index, (label, status) in enumerate((
    ("Chrome Extension", "Local dev"),
    ("Plugin Manager", "Source alpha"),
    ("Office native driver", "Local dev"),
    ("MCP & local tools", "Source alpha"),
    ("Model providers", "Source alpha"),
)):
    y = 548 + index * 37
    draw.ellipse((1090, y - 5, 1100, y + 5), fill="#1D9B82")
    text(draw, (1114, y), label, size=13, fill="#35443F", anchor="lm")
    text(draw, (1390, y), status, size=12, fill="#74817C", anchor="rm")

rounded(draw, (1068, 760, 1414, 830), "#FFFFFF", radius=12, outline="#DFE4DF")
text(draw, (1090, 782), "Audit evidence", size=14, fill="#35443F", bold=True)
text(draw, (1090, 807), "Runs and artifacts remain local by default.", size=13, fill="#68746F")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
image.save(OUTPUT, optimize=True)
print(OUTPUT)
