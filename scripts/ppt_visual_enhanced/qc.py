"""Layout QC through PowerPoint itself: text that does not fit its shape, shapes outside the slide, and overlapping
text-bearing shapes. Opens the deck read-only; quits PowerPoint only if this script started it.

usage: python -I qc.py <deck.pptx> [--skip-original <original.pptx>]
"""
import subprocess
import sys

import pythoncom
import win32com.client

sys.stdout.reconfigure(encoding='utf-8')
path = sys.argv[1]
running = b'POWERPNT.EXE' in subprocess.run(['tasklist', '/FI', 'IMAGENAME eq POWERPNT.EXE'], capture_output=True).stdout
pythoncom.CoInitialize()
app = win32com.client.Dispatch('PowerPoint.Application')
pres = None
TOL = 1.5  # points


def walk(shapes, prefix=''):
    for i in range(1, shapes.Count + 1):
        sh = shapes.Item(i)
        yield sh, prefix
        if sh.Type == 6:  # msoGroup
            items = sh.GroupItems
            for j in range(1, items.Count + 1):
                yield items.Item(j), prefix + sh.Name + ' > '


try:
    pres = app.Presentations.Open(path, True, False, False)
    SW, SH = pres.PageSetup.SlideWidth, pres.PageSetup.SlideHeight
    problems = 0
    for si in range(1, pres.Slides.Count + 1):
        slide = pres.Slides(si)
        texts = []
        for sh, prefix in walk(slide.Shapes):
            name = prefix + sh.Name
            L, T, W, H = sh.Left, sh.Top, sh.Width, sh.Height
            is_line = sh.Type in (9,) or sh.Connector
            if not is_line and (L < -TOL or T < -TOL or L + W > SW + TOL or T + H > SH + TOL):
                print(f'slide {si}: OUT OF SLIDE {name!r} L={L:.1f} T={T:.1f} R={L + W:.1f} B={T + H:.1f}')
                problems += 1
            try:
                has = sh.HasTextFrame and sh.TextFrame.HasText
            except Exception:
                has = False
            if not has:
                continue
            tf = sh.TextFrame
            tr = tf.TextRange
            if not tr.Text.strip():
                continue
            avail_h = H - tf.MarginTop - tf.MarginBottom
            avail_w = W - tf.MarginLeft - tf.MarginRight
            bh, bw = tr.BoundHeight, tr.BoundWidth
            geom = sh.AutoShapeType if sh.Type == 1 else 0
            special = geom in (4, 10, 63)  # diamond/hexagon-ish text rects are smaller than the box: report separately
            if bh > avail_h + TOL or (not tf.WordWrap and bw > avail_w + TOL):
                tag = 'CHECK (non-rect shape)' if special else 'TEXT OVERFLOW'
                print(f'slide {si}: {tag} {name!r} text {bw:.1f}x{bh:.1f}pt in {avail_w:.1f}x{avail_h:.1f}pt :: {tr.Text[:70]!r}')
                problems += 0 if special else 1
            texts.append((name, L, T, L + W, T + H, tr.Text[:40]))
        # overlapping text-bearing shapes (neither contains the other)
        for a in range(len(texts)):
            for b in range(a + 1, len(texts)):
                n1, l1, t1, r1, b1, x1 = texts[a]
                n2, l2, t2, r2, b2, x2 = texts[b]
                ix = min(r1, r2) - max(l1, l2)
                iy = min(b1, b2) - max(t1, t2)
                if ix <= 0.5 or iy <= 0.5:
                    continue
                c1 = l1 <= l2 and t1 <= t2 and r1 >= r2 and b1 >= b2
                c2 = l2 <= l1 and t2 <= t1 and r2 >= r1 and b2 >= b1
                if not (c1 or c2):
                    print(f'slide {si}: OVERLAP {n1!r} [{x1!r}] x {n2!r} [{x2!r}] ({ix:.1f}x{iy:.1f}pt)')
    print(f'{pres.Slides.Count} slides checked; {problems} problem(s) flagged (overlaps listed separately)')
finally:
    if pres is not None:
        pres.Close()
    if not running:
        app.Quit()
    pythoncom.CoUninitialize()
