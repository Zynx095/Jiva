"""Render every slide of a .pptx to PNG (and optionally a PDF) with Microsoft PowerPoint via COM.

Opens the file read-only and never saves it. Quits PowerPoint afterwards only if this script started it.
usage: python -I render.py <deck.pptx> <out_dir> [width_px] [--pdf <out.pdf>]
"""
import os
import subprocess
import sys

import pythoncom
import win32com.client

sys.stdout.reconfigure(encoding="utf-8")
src = os.path.abspath(sys.argv[1])
out_dir = os.path.abspath(sys.argv[2])
width = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 1920
pdf = None
if '--pdf' in sys.argv:
    pdf = os.path.abspath(sys.argv[sys.argv.index('--pdf') + 1])
os.makedirs(out_dir, exist_ok=True)

running = b'POWERPNT.EXE' in subprocess.run(['tasklist', '/FI', 'IMAGENAME eq POWERPNT.EXE'], capture_output=True).stdout
pythoncom.CoInitialize()
app = win32com.client.Dispatch('PowerPoint.Application')
pres = None
try:
    # Open(FileName, ReadOnly, Untitled, WithWindow)
    pres = app.Presentations.Open(src, True, False, False)
    w_in = pres.PageSetup.SlideWidth / 72
    h_in = pres.PageSetup.SlideHeight / 72
    height = round(width * h_in / w_in)
    n = pres.Slides.Count
    for i in range(1, n + 1):
        target = os.path.join(out_dir, f'slide_{i:02d}.png')
        if os.path.exists(target):
            os.remove(target)
        pres.Slides(i).Export(target, 'PNG', width, height)
    if pdf:
        if os.path.exists(pdf):
            os.remove(pdf)
        pres.SaveAs(pdf, 32)  # ppSaveAsPDF; writes a PDF copy, the .pptx is untouched
    print(f'rendered {n} slides ({w_in:.2f} x {h_in:.2f} in) to {out_dir} at {width}x{height}' + (f'; pdf {pdf}' if pdf else ''))
finally:
    if pres is not None:
        pres.Close()
    if not running:
        app.Quit()
    pythoncom.CoUninitialize()
