# Kompozycja grafik do Google Play w estetyce apki (metal + zielony fosfor CRT).
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT_DIR = "node_modules/@expo-google-fonts/kode-mono"
KODE500 = f"{FONT_DIR}/500Medium/KodeMono_500Medium.ttf"
KODE400 = f"{FONT_DIR}/400Regular/KodeMono_400Regular.ttf"

PHOSPHOR = (226, 255, 228)   # #E2FFE4 — jasny fosfor (jak tekst na ekranie apki)
GLOW = (60, 255, 120)        # zielona poświata

def center_x(draw, text, font, W):
    b = draw.textbbox((0, 0), text, font=font)
    return (W - (b[2] - b[0])) // 2 - b[0]

def darken_band(base, y0, y1, top_alpha, bot_alpha):
    """Pionowy gradient przyciemnienia (dla czytelności tekstu)."""
    W = base.width
    band = Image.new("L", (1, y1 - y0))
    for i in range(y1 - y0):
        t = i / max(1, (y1 - y0 - 1))
        band.putpixel((0, i), int(top_alpha + (bot_alpha - top_alpha) * t))
    mask = band.resize((W, y1 - y0))
    black = Image.new("RGB", (W, y1 - y0), (8, 10, 9))
    base.paste(black, (0, y0), mask)

def glow_text(base, xy, text, font, fill, glow, radius=10):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.text(xy, text, font=font, fill=glow + (255,))
    layer = layer.filter(ImageFilter.GaussianBlur(radius))
    base.alpha_composite(layer)
    d2 = ImageDraw.Draw(base)
    d2.text(xy, text, font=font, fill=fill + (255,))

# ---------- FEATURE GRAPHIC 1024x500 ----------
bg = Image.open("store_assets/raw/feature_bg.png").convert("RGBA")
# crop 1024x512 -> 1024x500 (po 6 px z góry i dołu)
bg = bg.crop((0, 6, 1024, 506))
fg = bg.copy()
# przyciemnij górny i dolny pas pod tekst
top = Image.new("RGBA", (1024, 150), (0, 0, 0, 0))
tb = Image.new("L", (1, 150))
for i in range(150):
    tb.putpixel((0, i), int(150 * (1 - i / 149)))   # mocniej u góry
tmask = tb.resize((1024, 150))
fg.paste(Image.new("RGBA", (1024, 150), (6, 8, 7, 255)), (0, 0), tmask)
bb = Image.new("L", (1, 130))
for i in range(130):
    bb.putpixel((0, i), int(150 * (i / 129)))        # mocniej u dołu
bmask = bb.resize((1024, 130))
fg.paste(Image.new("RGBA", (1024, 130), (6, 8, 7, 255)), (0, 370), bmask)

draw = ImageDraw.Draw(fg)
title_font = ImageFont.truetype(KODE500, 76)
tag_font = ImageFont.truetype(KODE400, 25)

title = "Gallery_AI"
tx = center_x(draw, title, title_font, 1024)
glow_text(fg, (tx, 26), title, title_font, PHOSPHOR, GLOW, radius=12)

tag = "AI PHOTO EDITOR  ·  RETRO CAMERA SOUL"
gx = center_x(draw, tag, tag_font, 1024)
glow_text(fg, (gx, 436), tag, tag_font, (200, 240, 205), GLOW, radius=5)

fg.convert("RGB").save("store_assets/feature_graphic_1024x500.png", optimize=True)
print("feature ->", Image.open("store_assets/feature_graphic_1024x500.png").size)

# ---------- IKONA 512x512 ----------
icon = Image.open("store_assets/raw/icon_raw.png").convert("RGB")
icon.resize((512, 512), Image.LANCZOS).save("store_assets/app_icon_512.png", optimize=True)
print("icon ->", Image.open("store_assets/app_icon_512.png").size)

import os
for f in ["store_assets/feature_graphic_1024x500.png", "store_assets/app_icon_512.png"]:
    print(f, round(os.path.getsize(f)/1024, 1), "KB")
