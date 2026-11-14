import os
from PIL import Image, ImageDraw

S = 512
SS = 4  # supersample
size = S * SS
img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

radius = int(size * 0.22)
# vertical gradient background
top = (22, 27, 34)
bottom = (11, 15, 21)
grad = Image.new("RGB", (1, size))
gp = grad.load()
for y in range(size):
    t = y / max(1, size - 1)
    gp[0, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
grad = grad.resize((size, size))
mask = Image.new("L", (size, size), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
# inner border highlight
d.rounded_rectangle([2 * SS, 2 * SS, size - 2 * SS, size - 2 * SS], radius=radius, outline=(255, 255, 255, 40), width=max(1, SS))

# waveform
pts = [(-0.06, 0.50), (0.13, 0.50), (0.21, 0.30), (0.30, 0.70), (0.39, 0.20),
       (0.48, 0.78), (0.57, 0.36), (0.66, 0.58), (0.75, 0.50), (1.06, 0.50)]
xy = [(x * size, y * size) for x, y in pts]

# glow layers
for w, a in ((int(SS * 9), 34), (int(SS * 6), 60), (int(SS * 4), 90)):
    d.line(xy, fill=(109, 168, 210, a), width=w, joint="curve")
d.line(xy, fill=(190, 224, 250, 255), width=max(2, int(SS * 2.0)), joint="curve")

# corner status dot
cx, cy, r = int(size * 0.795), int(size * 0.215), int(size * 0.058)
for w, a in ((int(SS * 8), 45), (int(SS * 4), 90)):
    d.ellipse([cx - r - w, cy - r - w, cx + r + w, cy + r + w], fill=(99, 169, 138, a))
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(99, 200, 155, 255))

img = img.resize((S, S), Image.LANCZOS)
os.makedirs("build", exist_ok=True)
img.save("build/icon.png")
img.save("build/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icon written", os.path.getsize("build/icon.png"), os.path.getsize("build/icon.ico"))
