#!/usr/bin/env python3
"""The card a link turns into when somebody pastes it into a chat.

This station spreads person to person: somebody says "you should be on this at
nine" and sends the address. That preview is the first impression far more often
than any search result will ever be, and until this existed it was a grey
rectangle with a hostname in it.

Drawn rather than screenshotted, and the difference matters. A screenshot of the
station is a dark player at card size, which is illegible: unfurls render around
five hundred pixels wide in most clients and smaller on a phone. So this is the
wordmark, one sentence, and the on-air lamp — three things that survive being
made small, because they are the three things somebody needs to decide whether
to tap.

The face is a stand-in. The real one is Space Grotesk, vendored as woff2 for the
browser, which Pillow cannot read and which is not worth a build-time conversion
for one image. Lato is the closest thing likely to be installed; the fallbacks
below are what to try after it. If the card ever stops looking like the station,
this is the line that is lying.

    python3 scripts/og-card.py       # or: npm run assets:og

Writes public/og.png (1200x630) and public/apple-touch-icon.png (180x180).
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# The station's own values, from src/tokens.css. Nothing here invents a colour.
BG = "#0a0a0a"
FG = "#ffffff"
DIM = "#d4d4d4"
LIVE = "#fb2c36"
RAISED = "#1c1c1c"

# What every unfurler asks for. Not a guess: Facebook, Slack, Discord, iMessage
# and X all crop to roughly 1.91:1, and anything else gets letterboxed or cut.
WIDTH, HEIGHT = 1200, 630

FACES = [
    "/usr/share/fonts/truetype/lato/Lato-{w}.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans{dash}{w}.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-{w}.ttf",
]

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"


def face(weight: str, size: int) -> ImageFont.FreeTypeFont:
    """The heaviest thing that will load, at this size."""
    for pattern in FACES:
        path = pattern.format(w=weight, dash="-" if weight != "Regular" else "")
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    # Pillow's built-in bitmap face, which is unreadable at this size and is
    # here so the script fails visibly rather than by raising in a build.
    print(f"  ! no system face for {weight}; the card will look wrong")
    return ImageFont.load_default()


def wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int) -> list[str]:
    """Greedy wrap. The sentence is fixed and short; this is not a typesetter."""
    lines: list[str] = []
    line = ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) <= width:
            line = trial
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def card() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)

    margin = 96

    # The lamp, and the one thing on here that is the station's own red. It is
    # what the badge on the deck looks like, so somebody who has been on the
    # station once recognises the card before they have read it.
    lamp_y = margin + 6
    draw.ellipse([margin, lamp_y, margin + 18, lamp_y + 18], fill=LIVE)
    lamp = face("Bold", 26)
    draw.text((margin + 34, lamp_y - 4), "LIVE RADIO", font=lamp, fill=DIM)

    # The wordmark. `.fm` in the dimmer ink, exactly as the page draws it.
    mark = face("Black", 132)
    tld = face("Black", 132)
    y = 196
    draw.text((margin, y), "chunky", font=mark, fill=FG)
    draw.text((margin + draw.textlength("chunky", font=mark), y), ".fm", font=tld, fill="#8a8a8a")

    # The sentence. The same one that is the page's description and the first
    # line of its prose: three places, one claim.
    body = face("Regular", 40)
    lines = wrap(
        draw,
        "Everyone hears the same second of the same song.",
        body,
        WIDTH - margin * 2,
    )
    y = 386
    for line in lines:
        draw.text((margin, y), line, font=body, fill=DIM)
        y += 54

    # And the part that says it is a person rather than a service.
    quiet = face("Regular", 30)
    draw.text(
        (margin, HEIGHT - margin - 24),
        "One room  ·  one person on the decks  ·  no algorithm",
        font=quiet,
        fill="#7a7a7a",
    )

    # A hairline off the bottom edge, so the card has a floor on a white
    # background as well as on a dark one.
    draw.rectangle([0, HEIGHT - 4, WIDTH, HEIGHT], fill=RAISED)
    return image


def touch_icon() -> Image.Image:
    """The square one, for a phone that saves the station to a home screen."""
    size = 180
    image = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(image)
    mark = face("Black", 96)
    text = "c"
    width = draw.textlength(text, font=mark)
    draw.text(((size - width) / 2, 28), text, font=mark, fill=FG)
    draw.ellipse([size / 2 - 9, size - 44, size / 2 + 9, size - 26], fill=LIVE)
    return image


def main() -> None:
    PUBLIC.mkdir(exist_ok=True)
    out = PUBLIC / "og.png"
    card().save(out, "PNG", optimize=True)
    print(f"  {out.relative_to(ROOT)}  {out.stat().st_size // 1024} kB")

    icon = PUBLIC / "apple-touch-icon.png"
    touch_icon().save(icon, "PNG", optimize=True)
    print(f"  {icon.relative_to(ROOT)}  {icon.stat().st_size // 1024} kB")


if __name__ == "__main__":
    main()
