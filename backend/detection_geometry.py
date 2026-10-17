"""Bounded overlapping detection passes and geometric duplicate suppression."""
import numpy as np


def detection_windows(width, height):
    # Four extra passes at most. Large classroom faces retain more pixels at the
    # detector input; original pixels are still used for recognition and quality.
    def axis(size):
        if size <= 1280:
            return [(0, size)]
        span = int(size * .625)
        return [(0, span), (size - span, size)]
    windows = [(x1, y1, x2, y2) for x1, x2 in axis(width) for y1, y2 in axis(height)]
    return [] if len(windows) == 1 else windows


def merge_detections(candidates, iou_threshold=.4):
    """Keep one box per physical face, regardless of the number of tile hits."""
    kept = []
    for box, points in sorted(candidates, key=lambda item: -float(item[0][4])):
        box = np.asarray(box, dtype=float)
        if box.shape != (5,) or not np.isfinite(box).all() or box[2] <= box[0] or box[3] <= box[1]:
            continue
        area = (box[2] - box[0]) * (box[3] - box[1])
        duplicate = False
        for other, _ in kept:
            overlap = np.maximum(0, np.minimum(box[2:4], other[2:4]) - np.maximum(box[:2], other[:2]))
            intersection = float(np.prod(overlap))
            other_area = (other[2] - other[0]) * (other[3] - other[1])
            if intersection / (area + other_area - intersection) > iou_threshold:
                duplicate = True
                break
        if not duplicate:
            kept.append((box, points))
    return sorted(kept, key=lambda item: (item[0][0], item[0][1]))
