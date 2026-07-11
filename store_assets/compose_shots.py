# Składa 4 promocyjne screeny 1080x1920 (tła z deAPI + podpisy Kode Mono, fosfor).
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

FONT_DIR = "node_modules/@expo-google-fonts/kode-mono"
KODE500 = f"{FONT_DIR}/500Medium/KodeMono_500Medium.ttf"
KODE400 = f"{FONT_DIR}/400Regular/KodeMono_400Regular.ttf"
PHOSPHOR = (226, 255, 228)
GLOW = (60, 255, 120)
W, H = 1080, 1920

def center_x(draw, text, font):
    b = draw.textbbox((0, 0), text, font=font)
    return (W - (b[2] - b[0])) // 2 - b[0]

def glow_text(base, xy, text, font, fill, glow, radius=10):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).text(xy, text, font=font, fill=glow + (255,))
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(radius)))
    ImageDraw.Draw(base).text(xy, text, font=font, fill=fill + (255,))

def top_scrim(base, height=320, strength=205):
    band = Image.new("L", (1, height))
    for i in range(height):
        band.putpixel((0, i), int(strength * (1 - i / (height - 1))))
    mask = band.resize((W, height))
    base.paste(Image.new("RGBA", (W, height), (6, 9, 7, 255)), (0, 0), mask)

SHOTS = [
    ("shot1_bg.png", "EDIT WITH AI", ["Just type what you want —", "Gallery_AI generates the result."]),
    ("shot3_bg.png", "CROP & ROTATE", ["Corner handles, aspect lock,", "and a smooth full-circle dial."]),
    ("shot2_bg.png", "TUNE THE LOOK", ["Immersive · Retro · Clean", "phosphor display modes."]),
    ("shot4_bg.png", "BROWSE, CAMERA-STYLE", ["Folders, feed & fast", "thumbnails at your fingertips."]),
]

title_font = ImageFont.truetype(KODE500, 66)
sub_font = ImageFont.truetype(KODE400, 31)
mark_font = ImageFont.truetype(KODE400, 30)

for idx, (bgf, title, sublines) in enumerate(SHOTS, 1):
    im = Image.open(f"store_assets/raw/{bgf}").convert("RGBA").resize((W, H), Image.LANCZOS)
    top_scrim(im)
    # dolny scrim pod wordmark
    bband = Image.new("L", (1, 200))
    for i in range(200):
        bband.putpixel((0, i), int(170 * (i / 199)))
    im.paste(Image.new("RGBA", (W, 200), (6, 9, 7, 255)), (0, H - 200), bband.resize((W, 200)))

    d = ImageDraw.Draw(im)
    # tytuł — auto-zmniejsz, gdyby był za szeroki
    tf = title_font
    while d.textbbox((0, 0), title, font=tf)[2] > W - 80 and tf.size > 40:
        tf = ImageFont.truetype(KODE500, tf.size - 2)
    glow_text(im, (center_x(d, title, tf), 96), title, tf, PHOSPHOR, GLOW, 12)
    # cienka linia fosforowa pod tytułem
    ImageDraw.Draw(im).line([(W//2 - 150, 190), (W//2 + 150, 190)], fill=GLOW + (180,), width=3)
    # podpis (2 linie)
    y = 224
    for line in sublines:
        glow_text(im, (center_x(d, line, sub_font), y), line, sub_font, (205, 240, 210), GLOW, 4)
        y += 46
    # wordmark na dole
    glow_text(im, (center_x(d, "Gallery_AI", mark_font), H - 96), "Gallery_AI", mark_font, PHOSPHOR, GLOW, 6)

    out = f"store_assets/screenshot_{idx}_1080x1920.png"
    im.convert("RGB").save(out, optimize=True)
    print(out, Image.open(out).size, round(os.path.getsize(out)/1024), "KB")
