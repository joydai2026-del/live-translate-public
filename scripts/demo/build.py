"""Edits /tmp/lt-demo/{host,guest}.webm + voiceover into evidence/demo.mp4 (house style, see ../DEMO-STYLE.md).
Host page in a browser window on the left, guest page in a phone frame on the right, on a dark backdrop.
Title card, top-center pill captions per scene, voice placed at each scene start, end card, fade to black.
Frozen stretches from a stalled browser are cut to a short hold, then each scene is held until its line ends.
usage: python3 scripts/demo/build.py   (after tts.sh and record.mjs)"""
import json, os, re, subprocess
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
W = "/tmp/lt-demo"
OUT = os.path.join(ROOT, "evidence/demo.mp4")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FPS = 24
BG = (27, 36, 50)
INTRO, OUTRO, TAIL = 3.6, 3.8, 1.5  # card lengths; TAIL = black + silence at the very end

# Layout on the 1280x720 canvas. Recordings: host 1000x760, phone 375x760 (see record.mjs).
HX, HY, HW, HH, BAR = 40, 104, 800, 608, 26   # host content box (scale 0.8), browser bar above it
PX, PY, PW, PH, BEZ = 925, 106, 293, 594, 11  # phone screen box (scale 0.78), bezel width

scenes = json.load(open(os.path.join(HERE, "scenes.json")))
marks = json.load(open(f"{W}/marks.json"))
vo = json.load(open(f"{W}/vo/durations.json"))
INTRO, OUTRO = max(INTRO, vo["intro"] + 0.9), max(OUTRO, vo["outro"] + 0.9)  # cards hold their whole line
app = [s for s in scenes if s["id"] in marks]
first = marks[app[0]["id"]] - 0.3  # trim the page load before the first scene
raw_len = marks["_end"] - first


def run(args):
    subprocess.run(args, check=True)


def esc(t):
    return t.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%")


def card(path, dur, title, sub):
    vf = (f"drawtext=fontfile={FONT}:text='{esc(title)}':fontcolor=white:fontsize=64:x=(w-tw)/2:y=(h/2)-70,"
          f"drawtext=fontfile={FONT_REG}:text='{esc(sub)}':fontcolor=0xB8BEC8:fontsize=28:x=(w-tw)/2:y=(h/2)+20,"
          f"fade=in:st=0:d=0.5,fade=out:st={dur - 0.5}:d=0.5")
    run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x1b2432:s=1280x720:r={FPS}:d={dur}",
         "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(FPS), path])


card(f"{W}/intro.mp4", INTRO, "Live Translate", "Speak here, they read it there  ·  local test-mode demo")
card(f"{W}/outro.mp4", OUTRO, "Live Translate", "English and Chinese, browser to phone. No app, no account.")


def frame(path):
    """Backdrop with holes for the two screens, a browser bar, a phone bezel and small device labels."""
    im = Image.new("RGBA", (1280, 720), BG + (255,))
    d = ImageDraw.Draw(im)
    # phone bezel, then the transparent screen hole
    d.rounded_rectangle((PX - BEZ, PY - BEZ, PX + PW + BEZ, PY + PH + BEZ), radius=38, fill=(10, 12, 16, 255), outline=(70, 78, 92, 255), width=2)
    d.rounded_rectangle((PX, PY, PX + PW, PY + PH), radius=28, fill=(0, 0, 0, 0))
    # browser window: bar with traffic lights, transparent content hole with rounded bottom corners
    d.rounded_rectangle((HX, HY - BAR, HX + HW, HY + HH), radius=10, fill=(0, 0, 0, 0))
    d.rounded_rectangle((HX, HY - BAR, HX + HW, HY + 10), radius=10, fill=(222, 225, 230, 255))
    d.rectangle((HX, HY, HX + HW, HY + 10), fill=(0, 0, 0, 0))
    for i, c in enumerate([(237, 106, 94), (245, 191, 79), (98, 197, 84)]):
        d.ellipse((HX + 12 + i * 18, HY - BAR + 8, HX + 22 + i * 18, HY - BAR + 18), fill=c + (255,))
    f = ImageFont.truetype(FONT_REG, 13)
    d.text((HX + 78, HY - BAR + 5), "Host: laptop browser (localhost)", font=f, fill=(90, 96, 108, 255))
    lf = ImageFont.truetype(FONT, 14)
    d.text((PX - BEZ + 2, PY - BEZ - 22), "GUEST PHONE", font=lf, fill=(150, 160, 176, 255))
    im.save(path)


def pill(path, text):
    f = ImageFont.truetype(FONT, 22)
    x0, y0, x1, y1 = f.getbbox(text)
    w, h = x1 - x0 + 40, 44
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=(51, 51, 51, 217))
    d.text((20 - x0, (h - (y1 - y0)) // 2 - y0), text, font=f, fill="white")
    im.save(path)


frame(f"{W}/frame.png")


def sync_time(video):
    """Video time of the first magenta sync frame (see record.mjs)."""
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-t", "30", "-i", video, "-vf", "fps=50,scale=4:4",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    for i in range(len(raw) // 48):
        r, g, b = (sum(raw[i * 48 + k::3][:16]) / 16 for k in range(3))
        if r > 200 and g < 70 and b > 200:
            return i / 50
    raise SystemExit(f"no sync frame in {video}")


# Video time = wall time - shift, measured per video from the sync flash.
hshift = marks["_sync_host"] - sync_time(f"{W}/host.webm")
gshift = marks["_sync_guest"] - sync_time(f"{W}/guest.webm")
print(f"video lag: host {hshift:.2f}s, guest {gshift:.2f}s")
hfirst, gfirst = first - hshift, first - gshift

# 1) Raw composite in real time: host window left, phone right, frame on top.
run(["ffmpeg", "-loglevel", "error", "-y",
     "-ss", f"{hfirst:.3f}", "-t", f"{raw_len:.3f}", "-i", f"{W}/host.webm",
     "-ss", f"{gfirst:.3f}", "-t", f"{raw_len:.3f}", "-i", f"{W}/guest.webm", "-i", f"{W}/frame.png",
     "-filter_complex", ";".join([
         f"color=c=0x1b2432:s=1280x720:r={FPS}:d={raw_len:.3f}[bg]",
         f"[0:v]fps={FPS},scale={HW}:{HH}:flags=lanczos,setpts=PTS-STARTPTS[h]",
         f"[1:v]fps={FPS},scale={PW}:{PH}:flags=lanczos,setpts=PTS-STARTPTS[g]",
         f"[bg][h]overlay={HX}:{HY}:eof_action=repeat[c1]",
         f"[c1][g]overlay={PX}:{PY}:eof_action=repeat[c2]",
         "[c2][2:v]overlay=0:0[v]"]),
     "-map", "[v]", "-t", f"{raw_len:.3f}", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", f"{W}/raw.mp4"])

# 2) The shared box can stall the browser for minutes, which records as a frozen picture.
#    Every freeze longer than FREEZE is cut down to HOLD seconds; scenes are padded back to their voice line below.
FREEZE, HOLD = 2.5, 1.2  # deliberate pauses in record.mjs are under 2.5 s, so they stay
log = subprocess.run(["ffmpeg", "-hide_banner", "-i", f"{W}/raw.mp4", "-vf", f"freezedetect=n=0.0001:d={FREEZE}",
                      "-an", "-f", "null", "-"], capture_output=True, text=True).stderr
fs = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", log)]
fe = [float(x) for x in re.findall(r"freeze_end: ([\d.]+)", log)] + [raw_len]
cuts = [(s + HOLD, e) for s, e in zip(fs, fe) if e - s > HOLD]
print("cut", f"{sum(e - s for s, e in cuts):.1f}s of frozen video in", len(cuts), "stretches")


def squash(t):
    """Raw-timeline time -> time after the cuts."""
    return t - sum(max(0.0, min(t, e) - s) for s, e in cuts)


keep = "+".join(f"between(t,{s:.3f},{e:.3f})" for s, e in cuts) or "0"
run(["ffmpeg", "-loglevel", "error", "-y", "-i", f"{W}/raw.mp4", "-vf", f"select='not({keep})',setpts=N/({FPS}*TB)",
     "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", f"{W}/compact.mp4"])

# 3) Scenes on the compact timeline, each held on its last frame until its voice line (plus a breath) has finished.
bounds = [0.0] + [squash(marks[s["id"]] - first) for s in app[1:]] + [squash(raw_len)]
lead = 0.3  # the first scene starts 0.3 s into the body
segs, start, t = [], {}, 0.0
for i, s in enumerate(app):
    a, b = bounds[i], bounds[i + 1]
    need = vo[s["id"]] + 0.8 + (lead if i == 0 else 0)
    segs.append((a, b, max(0.0, need - (b - a))))
    start[s["id"]] = t + (lead if i == 0 else 0)
    t += (b - a) + segs[-1][2]
body_len = t
# One file per scene (tpad is ignored after a trim filter, so trim on the input side), then concat.
real = []
with open(f"{W}/scenes.txt", "w") as lst:
    for i, (a, b, pad) in enumerate(segs):
        run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", f"{W}/compact.mp4",
             "-vf", f"tpad=stop_mode=clone:stop_duration={pad:.3f}", "-r", str(FPS),
             "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", f"{W}/scene{i}.mp4"])
        lst.write(f"file '{W}/scene{i}.mp4'\n")
        got = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                    f"{W}/scene{i}.mp4"], capture_output=True, text=True, check=True).stdout)
        real.append(got)
# Scene starts from the rendered lengths (frame rounding), so captions and voice stay on the picture.
acc = 0.0
for i, s in enumerate(app):
    start[s["id"]] = acc + (lead if i == 0 else 0)
    acc += real[i]
run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", f"{W}/scenes.txt", "-c", "copy", f"{W}/scenes.mp4"])
body_len = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                 f"{W}/scenes.mp4"], capture_output=True, text=True, check=True).stdout)
print(f"body {body_len:.2f}s (planned {t:.2f}s)")
fc = []
ins, prev, n = [], "0:v", 0
for i, s in enumerate(app):
    if not s["caption"]:
        continue
    a = start[s["id"]] + 0.15
    b = (start[app[i + 1]["id"]] if i + 1 < len(app) else body_len) - 0.1
    png = f"{W}/pill-{s['id']}.png"
    pill(png, s["caption"])
    ins += ["-i", png]
    n += 1
    fc.append(f"[{prev}][{n}:v]overlay=x=(W-w)/2:y=26:enable='between(t,{a:.2f},{b:.2f})'[q{n}]")
    prev = f"q{n}"
run(["ffmpeg", "-loglevel", "error", "-y", "-i", f"{W}/scenes.mp4", *ins, "-filter_complex", ";".join(fc),
     "-map", f"[{prev}]", "-r", str(FPS), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", f"{W}/body.mp4"])

# Video: intro + body + outro, then black tail.
total = INTRO + body_len + OUTRO + TAIL
run(["ffmpeg", "-loglevel", "error", "-y", "-i", f"{W}/intro.mp4", "-i", f"{W}/body.mp4", "-i", f"{W}/outro.mp4",
     "-filter_complex", f"[0:v][1:v][2:v]concat=n=3:v=1:a=0,tpad=stop_mode=add:stop_duration={TAIL}:color=black[v]",
     "-map", "[v]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", f"{W}/video.mp4"])

# Voice: each line delayed to its scene start; intro line over the title card, outro line over the end card.
starts = {"intro": 0.3, "outro": INTRO + body_len + 0.3}
for s in app:
    starts[s["id"]] = INTRO + start[s["id"]] + 0.2
ins, chains = [], []
for i, s in enumerate(scenes):
    ins += ["-i", f"{W}/vo/{s['id']}.wav"]
    ms = int(starts[s["id"]] * 1000)
    chains.append(f"[{i + 1}:a]adelay={ms}|{ms}[a{i}]")
mix = "".join(f"[a{i}]" for i in range(len(scenes)))
fc = ";".join(chains) + f";{mix}amix=inputs={len(scenes)}:normalize=0,apad,atrim=0:{total:.3f},loudnorm=I=-16:TP=-1.5[a]"
run(["ffmpeg", "-loglevel", "error", "-y", "-i", f"{W}/video.mp4", *ins, "-filter_complex", fc,
     "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ar", "24000", "-ac", "1",
     "-movflags", "+faststart", "-t", f"{total:.3f}", OUT])
print(OUT, f"{total:.1f}s")
