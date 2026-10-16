# 녹화 프레임 + 자막 띠 + 인트로/엔딩 카드 → MP4 (30fps, H.264)
# python tools/guide/compose.py <작업 폴더>/v docs/guide.mp4  (pip install imageio-ffmpeg pillow, 맑은 고딕 글꼴 사용)
import json, bisect, subprocess, sys
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

V, OUT = sys.argv[1], sys.argv[2]
FPS, W, PH, CAP = 30, 780, 1688, 200
H = PH + CAP
F = lambda s, b=False: ImageFont.truetype("C:/Windows/Fonts/malgunbd.ttf" if b else "C:/Windows/Fonts/malgun.ttf", s)
INK, BG, VOLT, MUTED = (14, 20, 18), (247, 246, 241), (214, 255, 0), (110, 118, 114)

tl = json.load(open(f"{V}/timeline.json", encoding="utf-8"))
frames, caps = tl["frames"], [c for c in tl["caps"] if "text" in c]
ts = [f["t"] for f in frames]
t0 = next(c["t"] for c in tl["caps"] if c.get("mark") == "start")
t1 = next(c["t"] for c in tl["caps"] if c.get("mark") == "end") + 0.8
order = []
for c in caps:
    if c["scene"] not in order: order.append(c["scene"])

def caption_strip(scene, text):
    im = Image.new("RGB", (W, CAP), INK); d = ImageDraw.Draw(im)
    n = order.index(scene) + 1
    d.rounded_rectangle((36, 30, 36 + 52, 30 + 52), 14, fill=VOLT)
    d.text((62, 56), str(n), font=F(34, True), fill=INK, anchor="mm")
    d.text((106, 56), scene, font=F(34, True), fill="white", anchor="lm")
    d.text((W - 36, 56), f"{n} / {len(order)}", font=F(24), fill=(150, 160, 155), anchor="rm")
    for i, line in enumerate(text.split("\n")):
        d.text((36, 104 + i * 42), line, font=F(30), fill=(225, 232, 228))
    return im

def card(title, sub, foot):
    im = Image.new("RGB", (W, H), INK); d = ImageDraw.Draw(im)
    d.rounded_rectangle((W // 2 - 70, 620, W // 2 + 70, 760), 36, fill=VOLT)
    d.text((W // 2, 690), "R&W", font=F(48, True), fill=INK, anchor="mm")
    d.text((W // 2, 860), title, font=F(56, True), fill="white", anchor="mm")
    for i, line in enumerate(sub.split("\n")):
        d.text((W // 2, 950 + i * 52), line, font=F(34), fill=(200, 210, 205), anchor="mm")
    d.text((W // 2, 1200), foot, font=F(30, True), fill=VOLT, anchor="mm")
    return im

intro = card("Run & Walk 송도", "사용 가이드\n가입부터 기록 공유까지 1분 40초", "모바일 화면 기준")
outro = card("지금 시작해 보세요", "송도 지도에서 출발지를 고르고\n오늘의 코스를 달려 보세요", "songdorun2.vercel.app")

ff = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT],
    stdin=subprocess.PIPE)
def put(im): ff.stdin.write(im.tobytes())

def fade(a, b, n):
    for k in range(n): put(Image.blend(a, b, (k + 1) / n))

for _ in range(int(FPS * 2.2)): put(intro)
cache, strips, last = {}, {}, None
nfr = int((t1 - t0) * FPS)
first = None
for k in range(nfr):
    t = t0 + k / FPS
    i = max(0, bisect.bisect_right(ts, t) - 1); fn = frames[i]["f"]
    ci = max(0, bisect.bisect_right([c["t"] for c in caps], t) - 1); c = caps[ci]
    key = (fn, ci)
    if key != last:
        if (c["scene"], c["text"]) not in strips: strips[(c["scene"], c["text"])] = caption_strip(c["scene"], c["text"])
        im = Image.new("RGB", (W, H), BG)
        im.paste(strips[(c["scene"], c["text"])], (0, 0))
        shot = Image.open(f"{V}/frames/{fn}").convert("RGB")
        if shot.size != (W, PH): shot = shot.resize((W, PH))
        im.paste(shot, (0, CAP)); last, cur = key, im
    if first is None: first = cur; fade(intro, cur, 10)
    put(cur)
fade(cur, outro, 12)
for _ in range(int(FPS * 3)): put(outro)
ff.stdin.close(); ff.wait()
print("done", OUT, f"{2.2 + nfr / FPS + 0.4 + 0.33 + 3:.1f}s")
