"""Room-planning logic. Pure Python, standard library only.

All lengths are metres. The room is a rectangle with its origin at the
top-left corner; x runs right, y runs down. A furniture item is an
axis-aligned rectangle (w x d) whose `rot` is 0 or 90 (degrees).
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from typing import Iterator

GRID = 0.1            # raster cell, m
WALKER = 0.3          # half-width kept clear for walking, m
DOOR_SWING = 0.9      # clear square in front of the door, m
PAINT_COVERAGE = 10.0  # m2 per litre, per coat
FLOOR_BOX = 2.2       # m2 per box of flooring
FLOOR_WASTE = 0.10

PRICES = {"paint_litre": 14.0, "floor_box": 38.0}


class ValidationError(ValueError):
    pass


def _num(v, name, lo, hi):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValidationError(f"{name} must be a number")
    if not lo <= v <= hi:
        raise ValidationError(f"{name} must be between {lo} and {hi}")
    return float(v)


@dataclass(frozen=True)
class Item:
    id: str
    name: str
    w: float
    d: float
    x: float
    y: float
    rot: int = 0

    @property
    def fw(self) -> float:  # footprint width after rotation
        return self.d if self.rot == 90 else self.w

    @property
    def fd(self) -> float:
        return self.w if self.rot == 90 else self.d

    def rect(self):
        return (self.x, self.y, self.x + self.fw, self.y + self.fd)


@dataclass(frozen=True)
class Door:
    wall: str  # top | bottom | left | right
    pos: float  # centre offset along that wall
    width: float = 0.9


def parse(payload: dict):
    """Validate untrusted JSON into (width, length, height, door, windows, items)."""
    if not isinstance(payload, dict):
        raise ValidationError("body must be a JSON object")
    room = payload.get("room")
    if not isinstance(room, dict):
        raise ValidationError("room is required")
    W = _num(room.get("width"), "room.width", 1.5, 15)
    L = _num(room.get("length"), "room.length", 1.5, 15)
    H = _num(room.get("height", 2.5), "room.height", 2.0, 4.5)

    d = payload.get("door") or {"wall": "bottom", "pos": 0.8}
    if d.get("wall") not in ("top", "bottom", "left", "right"):
        raise ValidationError("door.wall must be top, bottom, left or right")
    span = W if d["wall"] in ("top", "bottom") else L
    dw = _num(d.get("width", 0.9), "door.width", 0.6, 2.0)
    door = Door(d["wall"], _num(d.get("pos"), "door.pos", dw / 2, span - dw / 2), dw)

    windows = []
    raw_w = payload.get("windows", [])
    if not isinstance(raw_w, list) or len(raw_w) > 12:
        raise ValidationError("windows must be a list of at most 12")
    for i, w in enumerate(raw_w):
        windows.append((_num(w.get("width", 1.2), f"windows[{i}].width", 0.3, 4),
                        _num(w.get("height", 1.2), f"windows[{i}].height", 0.3, 3)))

    raw = payload.get("items", [])
    if not isinstance(raw, list) or len(raw) > 40:
        raise ValidationError("items must be a list of at most 40")
    items, seen = [], set()
    for i, it in enumerate(raw):
        if not isinstance(it, dict):
            raise ValidationError(f"items[{i}] must be an object")
        iid = str(it.get("id", i))[:32]
        if iid in seen:
            raise ValidationError(f"duplicate item id {iid!r}")
        seen.add(iid)
        rot = it.get("rot", 0)
        if rot not in (0, 90):
            raise ValidationError(f"items[{i}].rot must be 0 or 90")
        items.append(Item(
            iid, str(it.get("name", "Item"))[:40],
            _num(it.get("w"), f"items[{i}].w", 0.1, 6),
            _num(it.get("d"), f"items[{i}].d", 0.1, 6),
            _num(it.get("x", 0), f"items[{i}].x", -50, 50),
            _num(it.get("y", 0), f"items[{i}].y", -50, 50), rot))
    return W, L, H, door, windows, items


def door_zone(door: Door, W: float, L: float):
    """Clear rectangle just inside the door."""
    h = door.width / 2
    if door.wall == "top":
        return (door.pos - h, 0, door.pos + h, DOOR_SWING)
    if door.wall == "bottom":
        return (door.pos - h, L - DOOR_SWING, door.pos + h, L)
    if door.wall == "left":
        return (0, door.pos - h, DOOR_SWING, door.pos + h)
    return (W - DOOR_SWING, door.pos - h, W, door.pos + h)


def _overlap(a, b, eps=1e-9):
    return a[0] < b[2] - eps and b[0] < a[2] - eps and a[1] < b[3] - eps and b[1] < a[3] - eps


def metrics(W, L, H, door, windows, coats=2):
    floor = W * L
    wall_gross = 2 * (W + L) * H
    openings = door.width * 2.05 + sum(w * h for w, h in windows)
    wall_net = max(wall_gross - openings, 0)
    paint_l = wall_net * coats / PAINT_COVERAGE
    boxes = math.ceil(floor * (1 + FLOOR_WASTE) / FLOOR_BOX)
    return {
        "floor_m2": round(floor, 2), "volume_m3": round(floor * H, 2),
        "wall_net_m2": round(wall_net, 2), "perimeter_m": round(2 * (W + L), 2),
        "paint_litres": math.ceil(paint_l * 2) / 2, "flooring_boxes": boxes,
        "cost": {
            "paint": round(math.ceil(paint_l * 2) / 2 * PRICES["paint_litre"], 2),
            "flooring": round(boxes * PRICES["floor_box"], 2),
        },
    }


def _grid(W, L):
    return int(math.ceil(W / GRID)), int(math.ceil(L / GRID))


def _blocked(W, L, items, inflate):
    nx, ny = _grid(W, L)
    blk = [[False] * nx for _ in range(ny)]
    for it in items:
        x0, y0, x1, y1 = it.rect()
        for j in range(max(int((y0 - inflate) / GRID), 0), min(int(math.ceil((y1 + inflate) / GRID)), ny)):
            for i in range(max(int((x0 - inflate) / GRID), 0), min(int(math.ceil((x1 + inflate) / GRID)), nx)):
                cx, cy = (i + .5) * GRID, (j + .5) * GRID
                if x0 - inflate < cx < x1 + inflate and y0 - inflate < cy < y1 + inflate:
                    blk[j][i] = True
    return blk


def reachability(W, L, door, items):
    """Flood-fill from the doorway through floor kept WALKER clear of furniture.

    Returns the set of reachable item ids plus the share of free floor reached.
    """
    nx, ny = _grid(W, L)
    blk = _blocked(W, L, items, WALKER)
    z = door_zone(door, W, L)
    sx, sy = int((z[0] + z[2]) / 2 / GRID), int((z[1] + z[3]) / 2 / GRID)
    sx, sy = min(max(sx, 0), nx - 1), min(max(sy, 0), ny - 1)
    seen = [[False] * nx for _ in range(ny)]
    if blk[sy][sx]:
        return set(), 0.0, seen
    q = deque([(sx, sy)])
    seen[sy][sx] = True
    n = 1
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = x + dx, y + dy
            if 0 <= a < nx and 0 <= b < ny and not seen[b][a] and not blk[b][a]:
                seen[b][a] = True
                n += 1
                q.append((a, b))
    free = sum(not c for row in blk for c in row) or 1
    ok = set()
    for it in items:
        x0, y0, x1, y1 = it.rect()
        m = WALKER + GRID
        for j in range(max(int((y0 - m) / GRID), 0), min(int((y1 + m) / GRID) + 1, ny)):
            for i in range(max(int((x0 - m) / GRID), 0), min(int((x1 + m) / GRID) + 1, nx)):
                if seen[j][i]:
                    ok.add(it.id)
    return ok, n / free, seen


def analyze(payload: dict) -> dict:
    W, L, H, door, windows, items = parse(payload)
    coats = int(_num(payload.get("coats", 2), "coats", 1, 4))
    issues = []
    for it in items:
        x0, y0, x1, y1 = it.rect()
        if x0 < -1e-9 or y0 < -1e-9 or x1 > W + 1e-9 or y1 > L + 1e-9:
            issues.append({"type": "out_of_bounds", "items": [it.id],
                           "msg": f"{it.name} sticks out of the room"})
    for a in range(len(items)):
        for b in range(a + 1, len(items)):
            if _overlap(items[a].rect(), items[b].rect()):
                issues.append({"type": "overlap", "items": [items[a].id, items[b].id],
                               "msg": f"{items[a].name} overlaps {items[b].name}"})
    z = door_zone(door, W, L)
    for it in items:
        if _overlap(it.rect(), z):
            issues.append({"type": "door_blocked", "items": [it.id],
                           "msg": f"{it.name} blocks the door swing"})
    reach, share, _ = reachability(W, L, door, items)
    for it in items:
        if it.id not in reach and not any(it.id in i["items"] for i in issues if i["type"] == "overlap"):
            issues.append({"type": "unreachable", "items": [it.id],
                           "msg": f"You cannot walk up to {it.name} from the door"})
    used = sum(i.w * i.d for i in items)
    fill = used / (W * L)
    score = 100 - 15 * len(issues) - max(0, fill - 0.4) * 100
    return {
        "metrics": metrics(W, L, H, door, windows, coats),
        "layout": {
            "furniture_m2": round(used, 2), "fill_pct": round(fill * 100, 1),
            "walkable_pct": round(share * 100, 1),
            "door_zone": [round(v, 3) for v in z],
            "score": max(0, min(100, round(score))),
            "issues": issues,
        },
    }


def arrange(payload: dict) -> Iterator[dict]:
    """Greedy auto-layout; yields one event per placement so a client can animate it.

    Largest items first, trying wall-hugging spots before interior ones, keeping
    the door zone clear and every placed item reachable on foot.
    """
    W, L, H, door, _w, items = parse(payload)
    z = door_zone(door, W, L)
    placed: list[Item] = []
    order = sorted(items, key=lambda i: i.w * i.d, reverse=True)
    step = 0.1  # search grid, m
    n = 0
    yield {"event": "start", "total": len(order)}
    for it in order:
        best = None
        for rot in (0, 90):
            cand = Item(it.id, it.name, it.w, it.d, 0, 0, rot)
            xs = [round(k * step, 2) for k in range(int((W - cand.fw) / step) + 1)] or [0]
            ys = [round(k * step, 2) for k in range(int((L - cand.fd) / step) + 1)] or [0]
            if cand.fw > W + 1e-9 or cand.fd > L + 1e-9:
                continue
            for x in xs:
                for y in ys:
                    c = Item(it.id, it.name, it.w, it.d, x, y, rot)
                    r = c.rect()
                    if _overlap(r, z) or any(_overlap(r, p.rect()) for p in placed):
                        continue
                    wall = min(x, y, W - r[2], L - r[3])  # distance to nearest wall
                    if best and wall >= best[0] - 1e-9:
                        continue
                    ok, _, _ = reachability(W, L, door, placed + [c])
                    if len(ok) == len(placed) + 1:
                        best = (wall, c)
                        if wall < 1e-9:
                            break
                if best and best[0] < 1e-9:
                    break
            if best and best[0] < 1e-9:
                break
        n += 1
        if best:
            c = best[1]
            placed.append(c)
            yield {"event": "place", "step": n, "item": {
                "id": c.id, "x": c.x, "y": c.y, "rot": c.rot}}
        else:
            yield {"event": "skip", "step": n, "id": it.id,
                   "msg": f"No room found for {it.name}"}
    yield {"event": "done", "placed": len(placed), "skipped": len(order) - len(placed)}


PRESETS = {
    "bedroom": {
        "room": {"width": 4.2, "length": 3.6, "height": 2.5},
        "door": {"wall": "bottom", "pos": 0.8, "width": 0.9},
        "windows": [{"width": 1.4, "height": 1.3}],
        "items": [
            {"id": "bed", "name": "Bed", "w": 1.6, "d": 2.0, "x": 2.5, "y": 0.1},
            {"id": "wardrobe", "name": "Wardrobe", "w": 1.2, "d": 0.6, "x": 0.1, "y": 0.1},
            {"id": "desk", "name": "Desk", "w": 1.2, "d": 0.6, "x": 2.9, "y": 2.8},
            {"id": "chair", "name": "Chair", "w": 0.5, "d": 0.5, "x": 3.1, "y": 2.2},
        ]},
    "cramped": {
        "room": {"width": 3.0, "length": 3.0, "height": 2.4},
        "door": {"wall": "bottom", "pos": 0.8, "width": 0.9},
        "windows": [{"width": 1.0, "height": 1.2}],
        "items": [
            {"id": "bed", "name": "Bed", "w": 1.4, "d": 2.0, "x": 0.5, "y": 1.6},
            {"id": "wardrobe", "name": "Wardrobe", "w": 1.2, "d": 0.6, "x": 1.2, "y": 1.0},
            {"id": "desk", "name": "Desk", "w": 1.2, "d": 0.6, "x": 2.4, "y": 0.2},
        ]},
    "studio": {
        "room": {"width": 5.5, "length": 4.0, "height": 2.6},
        "door": {"wall": "left", "pos": 3.2, "width": 0.9},
        "windows": [{"width": 1.6, "height": 1.4}, {"width": 1.2, "height": 1.4}],
        "items": [
            {"id": "sofa", "name": "Sofa", "w": 2.1, "d": 0.9, "x": 1.5, "y": 0.2},
            {"id": "table", "name": "Dining table", "w": 1.4, "d": 0.8, "x": 3.4, "y": 2.3},
            {"id": "shelf", "name": "Bookshelf", "w": 0.9, "d": 0.35, "x": 4.5, "y": 0.1},
            {"id": "tv", "name": "TV unit", "w": 1.5, "d": 0.4, "x": 2.0, "y": 3.5},
        ]},
}
