"""Проверка детектора и счёта машин на реальном размеченном видео UA-DETRAC.

    cd vision && python -m smartflow_cv.detrac_eval --out ../public/data/cv/cv-real-results.json

UA-DETRAC (Wen et al., 2015, https://arxiv.org/abs/1511.04136) — 100 видео с неподвижных камер над дорогами
Пекина и Тяньцзиня, 960×540, 25 кадров/с, рамка каждой машины в каждом кадре и «игнорируемые» области
(дальние или неразмеченные машины). Используется копия обучающей части на Hugging Face
(abhineet123/ua_detrac): из большого архива по HTTP Range скачиваются только нужные кадры, они кэшируются
вне репозитория и в проект не попадают; в результаты пишутся только числа.

Что проверяется (то, что можно проверить без калибровки камеры):
  * детекция по кадрам: точность (precision), полнота (recall), F1 при IoU ≥ 0,5 и ≥ 0,3; детекции, центр
    которых в игнорируемой области, не считаются ни верными, ни ложными (как в протоколе DETRAC);
  * «слипание»: ложная рамка, накрывающая две и больше настоящих машин;
  * счёт машин, пересёкших виртуальную линию (трекер проекта), против размеченных треков.
Скорость и пересечение сплошной здесь не проверяются: у видео нет калибровки и разметки скорости.
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import io
import json
import statistics
import struct
import time
import urllib.error
import urllib.request
import zipfile
import zlib
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

from .vehicle_detection import BackgroundDetector
from .vehicle_tracking import Tracker, iou

ZIP_URL = "https://huggingface.co/datasets/abhineet123/ua_detrac/resolve/main/ua_detrac_training_set.zip"
#: 10 последовательностей, взятых равномерно по списку из 60 обучающих (каждая шестая)
SEQUENCES = ("MVI_20011", "MVI_20051", "MVI_20065", "MVI_39821", "MVI_40152", "MVI_40191", "MVI_40213", "MVI_40752",
             "MVI_40992", "MVI_63554")
FRAMES = 300  # 12 с видео с начала каждой последовательности
FPS = 25.0
LINE_FRAC = 0.6  # линия счёта — горизонталь на 60 % высоты кадра
WARMUP = 10  # кадры, по которым детектор строит фон (детекций в них нет — они не оцениваются)


class RangeFile(io.RawIOBase):
    """Файл по HTTP с произвольным доступом (заголовок Range) — чтобы читать оглавление zip без скачивания."""

    def __init__(self, url: str, attempts: int = 4):
        self.pos = 0
        for k in range(attempts):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"Range": "bytes=0-0"}), timeout=60) as r:
                    self.size = int(r.headers["Content-Range"].split("/")[1])
                    self.url = r.geturl()
                return
            except (OSError, urllib.error.URLError):
                if k == attempts - 1:
                    raise
                time.sleep(2 * (k + 1))

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, off: int, whence: int = 0) -> int:
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def get(self, a: int, b: int, attempts: int = 4) -> bytes:
        """Байты [a, b); сетевые сбои повторяются с паузой, неполный ответ считается сбоем."""
        for k in range(attempts):
            try:
                with urllib.request.urlopen(urllib.request.Request(self.url, headers={"Range": f"bytes={a}-{b - 1}"}), timeout=300) as r:
                    data = r.read()
                if len(data) == b - a:
                    return data
                err: Exception = IOError(f"получено {len(data)} байт из {b - a}")
            except (OSError, urllib.error.URLError) as e:
                err = e
            time.sleep(2 * (k + 1))
        raise IOError(f"не удалось скачать байты {a}–{b} после {attempts} попыток: {err}")

    def readinto(self, buf) -> int:
        n = min(len(buf), self.size - self.pos)
        if n <= 0:
            return 0
        d = self.get(self.pos, self.pos + n)
        buf[:len(d)] = d
        self.pos += len(d)
        return len(d)


def is_cached(cache: Path, seq: str, frames: int) -> bool:
    out = cache / seq
    return (out / "annotations.csv").exists() and all((out / f"image{i:06d}.jpg").exists() for i in range(1, frames + 1))


def fetch_sequence(zf: zipfile.ZipFile, rf: RangeFile, seq: str, frames: int, cache: Path) -> Path:
    """Скачать первые frames кадров и разметку последовательности одним диапазоном байтов; вернуть папку кэша."""
    out = cache / seq
    if is_cached(cache, seq, frames):
        return out
    folder = next(n.split("/")[0] for n in zf.namelist() if n.endswith(f"_{seq}/annotations.csv"))
    want = [f"{folder}/image{i:06d}.jpg" for i in range(1, frames + 1)]
    out.mkdir(parents=True, exist_ok=True)
    (out / "annotations.csv").write_bytes(zf.read(f"{folder}/annotations.csv"))
    infos = [zf.getinfo(w) for w in want]
    a = min(i.header_offset for i in infos)
    b = max(i.header_offset + 30 + len(i.filename.encode()) + 1024 + i.compress_size for i in infos)
    blob = rf.get(a, min(b, rf.size))
    for i in infos:
        p = i.header_offset - a
        sig, *_ = struct.unpack("<I", blob[p:p + 4])
        if sig != 0x04034B50:
            raise IOError(f"{i.filename}: неверный локальный заголовок zip")
        n_len, e_len = struct.unpack("<HH", blob[p + 26:p + 30])
        s = p + 30 + n_len + e_len
        data = blob[s:s + i.compress_size]
        if i.compress_type == zipfile.ZIP_DEFLATED:
            data = zlib.decompress(data, -15)
        elif i.compress_type != zipfile.ZIP_STORED:
            raise IOError(f"{i.filename}: неизвестное сжатие {i.compress_type}")
        if zlib.crc32(data) != i.CRC:
            raise IOError(f"{i.filename}: контрольная сумма не совпала")
        (out / Path(i.filename).name).write_bytes(data)
    return out


def load_gt(path: Path, frames: int) -> tuple[dict[int, list], dict[int, list]]:
    """Разметка: кадр → [(box, target_id)] машин и кадр → [box] игнорируемых областей."""
    cars, ign = defaultdict(list), defaultdict(list)
    with path.open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            k = int(r["filename"][5:11])
            if k > frames:
                continue
            box = (float(r["xmin"]), float(r["ymin"]), float(r["xmax"]), float(r["ymax"]))
            (ign[k].append(box) if r["class"] == "ignored" else cars[k].append((box, int(r["target_id"]))))
    return cars, ign


def _inside(pt, box) -> bool:
    return box[0] <= pt[0] <= box[2] and box[1] <= pt[1] <= box[3]


def match(dets: list, gts: list, thr: float) -> tuple[int, int, int, list[int]]:
    """Жадное сопоставление по убыванию IoU. Возвращает TP, FP, FN и индексы несопоставленных детекций."""
    pairs = sorted(((iou(d, g), i, j) for i, d in enumerate(dets) for j, g in enumerate(gts)), reverse=True)
    used_d, used_g = set(), set()
    for v, i, j in pairs:
        if v < thr:
            break
        if i in used_d or j in used_g:
            continue
        used_d.add(i)
        used_g.add(j)
    fp_idx = [i for i in range(len(dets)) if i not in used_d]
    return len(used_d), len(fp_idx), len(gts) - len(used_g), fp_idx


def crossings(tracks: dict[int, list[tuple[int, float]]], y_line: float) -> int:
    """Сколько треков пересекли горизонталь y_line (по нижней середине рамки, в любую сторону)."""
    n = 0
    for pts in tracks.values():
        pts = sorted(pts)
        if any((y0 - y_line) * (y1 - y_line) < 0 or (y1 == y_line and y0 != y_line) for (_, y0), (_, y1) in zip(pts, pts[1:])):
            n += 1
    return n


def road_mask(path: Path, size: tuple[int, int], grow: int = 15) -> np.ndarray:
    """Маска дороги камеры: где по разметке всей последовательности ездят машины (с запасом grow px).

    Заменяет многоугольник дороги, который оператор один раз рисует для каждой камеры; по кадрам не меняется.
    """
    w, h = size
    m = np.zeros((h, w), np.uint8)
    with path.open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["class"] != "ignored":
                cv2.rectangle(m, (int(float(r["xmin"])), int(float(r["ymin"]))), (int(float(r["xmax"])), int(float(r["ymax"]))), 255, -1)
    return cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_RECT, (2 * grow + 1, 2 * grow + 1)))


PRIME_EVERY = 10  # классическому детектору фон задаётся медианой каждого 10-го кадра отрезка


def run_detector(folder: Path, frames: int, det) -> tuple[list[list], float, list[float]]:
    """Детекции по кадрам, среднее время на кадр (мс) и яркость кадров.

    Классическому детектору заранее задаётся фон — медиана кадров через 0,4 с по всему отрезку: так работает камера,
    которая уже давно смотрит на дорогу (иначе фон строится за первые 0,4 с вместе со стоящими машинами).
    """
    if hasattr(det, "prime"):
        det.prime([cv2.imread(str(folder / f"image{k:06d}.jpg")) for k in range(1, frames + 1, PRIME_EVERY)])
    out, lum, t0 = [], [], time.time()
    for k in range(1, frames + 1):
        img = cv2.imread(str(folder / f"image{k:06d}.jpg"))
        if k % 20 == 1:
            lum.append(float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean()))
        out.append(det.detect(img))
    return out, (time.time() - t0) / frames * 1000, lum


def score(dets: list[list], cars: dict, ign: dict, mask: np.ndarray | None, h: int, frames: int) -> dict:
    """Точность и полнота детекции, «слипание» и счёт машин на линии для одной последовательности."""
    def center(b):
        return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)

    def in_mask(b):
        if mask is None:
            return True
        x, y = center(b)
        return mask[min(mask.shape[0] - 1, max(0, int(y))), min(mask.shape[1] - 1, max(0, int(x)))] > 0

    acc = {0.5: [0, 0, 0], 0.3: [0, 0, 0]}
    merged = 0
    tracker = Tracker()
    gt_tracks: dict[int, list] = defaultdict(list)
    our_tracks: dict[int, list] = defaultdict(list)
    for k in range(1, frames + 1):
        ds = [d for d in dets[k - 1] if in_mask(d.box)]
        for tr in tracker.update(k / FPS, ds):
            our_tracks[tr.tid].append((k, tr.history[-1][2]))
        for box, tid in cars.get(k, []):
            gt_tracks[tid].append((k, box[3]))
        if k <= WARMUP:
            continue
        # детекции с центром в игнорируемой области не оцениваются (протокол DETRAC)
        boxes = [d.box for d in ds if not any(_inside(center(d.box), g) for g in ign.get(k, []))]
        gts = [b for b, _ in cars.get(k, [])]
        for thr, a in acc.items():
            tp, fp, fn, fp_idx = match(boxes, gts, thr)
            a[0] += tp
            a[1] += fp
            a[2] += fn
            if thr == 0.5:
                for i in fp_idx:  # ложная рамка, накрывающая центры двух и больше настоящих машин — «слипание»
                    merged += sum(1 for g in gts if _inside(center(g), boxes[i])) >= 2
    res = {}
    for thr, (tp, fp, fn) in acc.items():
        res[f"iou{int(thr * 10):02d}"] = _prf(tp, fp, fn)
    res["merged_fp"] = merged
    y_line = LINE_FRAC * h
    gt_n, our_n = crossings(gt_tracks, y_line), crossings(our_tracks, y_line)
    res.update(count_gt=gt_n, count_ours=our_n, count_error_pct=_r((our_n - gt_n) / gt_n * 100, 1) if gt_n else None)
    return res


def _prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    return {"tp": tp, "fp": fp, "fn": fn, "precision": _r(p), "recall": _r(r), "f1": _r(2 * p * r / (p + r)) if p and r else None}


YOLOX_URL = "https://huggingface.co/hr16/yolox-onnx/resolve/main/yolox_tiny.onnx"
YOLOX_SHA256 = "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7"


def fetch_weights(cache: Path) -> Path:
    """Веса YOLOX-tiny (Apache-2.0, официальный экспорт Megvii) — в кэш, с проверкой SHA-256."""
    import hashlib
    p = cache / "yolox_tiny.onnx"
    if not p.exists():
        cache.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(YOLOX_URL, timeout=600) as r:
            p.write_bytes(r.read())
    if hashlib.sha256(p.read_bytes()).hexdigest() != YOLOX_SHA256:
        raise IOError(f"{p}: SHA-256 не совпал — файл весов не тот")
    return p


def _r(x, d: int = 3):
    return None if x is None else round(float(x), d)


CONFIGS = (("background", False), ("background", True), ("yolox_tiny", False), ("yolox_tiny", True))


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=Path("cv-real-results.json"))
    ap.add_argument("--cache", type=Path, default=Path.home() / ".cache" / "smartflow-detrac")
    ap.add_argument("--sequences", nargs="*", default=list(SEQUENCES))
    ap.add_argument("--frames", type=int, default=FRAMES)
    ap.add_argument("--no-yolo", action="store_true", help="только классический детектор")
    a = ap.parse_args(argv)
    from .vehicle_detection import YoloxOnnxDetector
    rf = zf = None
    if not all(is_cached(a.cache, q, a.frames) for q in a.sequences):  # сеть нужна, только если кадров ещё нет в кэше
        rf = RangeFile(ZIP_URL)
        zf = zipfile.ZipFile(io.BufferedReader(rf, buffer_size=1 << 20))
    weights = None if a.no_yolo else fetch_weights(a.cache)
    rows = []
    for seq in a.sequences:
        t0 = time.time()
        folder = fetch_sequence(zf, rf, seq, a.frames, a.cache)
        cars, ign = load_gt(folder / "annotations.csv", a.frames)
        h, w = cv2.imread(str(folder / "image000001.jpg")).shape[:2]
        mask = road_mask(folder / "annotations.csv", (w, h))
        row = {"sequence": seq, "frames": a.frames, "size": [w, h],
               "gt_vehicles_per_frame": round(sum(len(cars.get(k, [])) for k in range(WARMUP + 1, a.frames + 1)) / (a.frames - WARMUP), 2),
               "road_mask_share": round(float((mask > 0).mean()), 3), "results": {}}
        cache_dets = {}
        for name, masked in CONFIGS:
            if name == "yolox_tiny" and weights is None:
                continue
            if name == "background":
                dets, ms, lum = run_detector(folder, a.frames, BackgroundDetector(roi=mask if masked else None))
            else:
                if "yolo" not in cache_dets:
                    cache_dets["yolo"] = run_detector(folder, a.frames, YoloxOnnxDetector(str(weights)))
                dets, ms, lum = cache_dets["yolo"]
            row["mean_luminance"] = round(statistics.fmean(lum), 1)
            key = f"{name}{'+mask' if masked else ''}"
            row["results"][key] = {**score(dets, cars, ign, mask if masked else None, h, a.frames), "ms_per_frame": round(ms, 1)}
        rows.append(row)
        print(seq, f"машин в кадре {row['gt_vehicles_per_frame']}, яркость {row['mean_luminance']}, {time.time() - t0:.0f} с", flush=True)
        for key, r in row["results"].items():
            print(f"   {key:18} P {r['iou05']['precision']} R {r['iou05']['recall']} F1 {r['iou05']['f1']} · IoU0.3 F1 {r['iou03']['f1']} · "
                  f"слипаний {r['merged_fp']} · счёт {r['count_ours']}/{r['count_gt']} · {r['ms_per_frame']} мс/кадр", flush=True)
    total = {}
    for key in rows[0]["results"]:
        rs = [r["results"][key] for r in rows]
        t = {}
        for iou_key in ("iou05", "iou03"):
            t[iou_key] = _prf(*(sum(x[iou_key][f] for x in rs) for f in ("tp", "fp", "fn")))
        gt_c, our_c = sum(x["count_gt"] for x in rs), sum(x["count_ours"] for x in rs)
        errs = [abs(x["count_error_pct"]) for x in rs if x["count_error_pct"] is not None]
        t.update(merged_fp=sum(x["merged_fp"] for x in rs), count_gt=gt_c, count_ours=our_c,
                 count_error_pct=_r((our_c - gt_c) / gt_c * 100, 1) if gt_c else None,
                 count_abs_error_pct_mean=_r(statistics.fmean(errs), 1) if errs else None,
                 ms_per_frame=_r(statistics.fmean(x["ms_per_frame"] for x in rs), 1))
        total[key] = t
    result = {
        "format": "smartflow-cv-real/1",
        "generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "dataset": {"name": "UA-DETRAC (обучающая часть)", "paper": "https://arxiv.org/abs/1511.04136",
                    "copy": "https://huggingface.co/datasets/abhineet123/ua_detrac", "sequences": a.sequences, "frames_per_sequence": a.frames,
                    "fps": FPS, "note": "Кадры в проект не копируются и не публикуются; сохранены только метрики."},
        "detectors": {"background": BackgroundDetector.name,
                      "yolox_tiny": "YOLOX-tiny (COCO, Apache-2.0), OpenCV DNN, вход 416×416, порог 0,3; без дообучения"},
        "protocol": {"iou": [0.5, 0.3], "ignored_regions": "детекции с центром в игнорируемой области не оцениваются",
                     "warmup_frames": WARMUP, "background_prime": f"фон классического детектора — медиана каждого {PRIME_EVERY}-го кадра отрезка",
                     "road_mask": "+mask — учитываются только детекции с центром в маске дороги (где по разметке ездят машины; заменяет многоугольник, который рисуют один раз на камеру)",
                     "count_line": f"горизонталь на {int(LINE_FRAC * 100)} % высоты кадра; трек считается, если нижняя середина рамки пересекла линию",
                     "cpu_note": "время на кадр — на облачном сервере с 2 ядрами при параллельной нагрузке, ориентир, а не замер для ноутбука"},
        "total": total,
        "sequences": rows,
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    for k, t in total.items():
        print(f"ИТОГО {k:18} P {t['iou05']['precision']} R {t['iou05']['recall']} F1 {t['iou05']['f1']} · счёт {t['count_ours']}/{t['count_gt']} ({t['count_error_pct']} %)")


if __name__ == "__main__":
    main()
