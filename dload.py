# скачать gif
import urllib.request
import os
import sys
from datetime import datetime


URL      = "https://meteoinfo.ru/hmc-output/rmap/phenomena.gif"
OUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phenomena.gif")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer":  "https://meteoinfo.ru/",
    "Accept":   "image/gif,image/*;q=0.8,*/*;q=0.5",
}


def download():
    req = urllib.request.Request(URL, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        with open(OUT_FILE, "wb") as f:
            f.write(data)
        size_kb = len(data) // 1024
        print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] Сохранено: {OUT_FILE} ({size_kb} КБ)")
    except Exception as e:
        print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] Ошибка: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    download()
