"""Build the self-contained browser demo (one HTML file, no server).

    for r in riyadh qassim hail jeddah; do
      DATABASE_URL=… python analysis/export_demo.py --region $r --min-upstream 5 demo/data/$r.json
    done
    python demo/build.py                       # → demo/flood-demo.html (+ demo/data/*.json beside it)

The page loads data/<region>.json on demand, so publish/serve the data folder next to it.

model.js is a line-for-line port of analysis/hydrology.py; keep them in sync.
"""
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def leaflet_css() -> str:
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["npm", "pack", "leaflet@1.9.4", "--silent"], cwd=tmp, check=True, capture_output=True)
        with tarfile.open(next(Path(tmp).glob("leaflet-*.tgz"))) as tf:
            css = tf.extractfile("package/dist/leaflet.css").read().decode()
    # image references are unused and would be blocked by the page's CSP
    return re.sub(r"[^;{}]*url\([^)]*\)[^;{}]*;", "", css)


def main():
    html = ((HERE / "template.html").read_text()
            .replace("/*LEAFLET_CSS*/", leaflet_css())
            .replace("/*MODEL*/", (HERE / "model.js").read_text()))
    out = HERE / "flood-demo.html"
    out.write_text(html)
    print(f"wrote {out} ({len(html) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
