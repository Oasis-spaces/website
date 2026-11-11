import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

os.environ["OASIS_QUIET"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import app  # noqa: E402
import planner  # noqa: E402


def room(items, **kw):
    p = {"room": {"width": 4, "length": 4, "height": 2.5},
         "door": {"wall": "bottom", "pos": 0.8, "width": 0.9}, "items": items}
    p.update(kw)
    return p


def item(i, x, y, w=1, d=1, rot=0):
    return {"id": i, "name": i, "w": w, "d": d, "x": x, "y": y, "rot": rot}


class Logic(unittest.TestCase):
    def test_metrics(self):
        a = planner.analyze(room([]))
        self.assertEqual(a["metrics"]["floor_m2"], 16)
        self.assertEqual(a["metrics"]["flooring_boxes"], 8)  # 16*1.1/2.2
        self.assertEqual(a["layout"]["score"], 100)

    def test_overlap_and_bounds(self):
        a = planner.analyze(room([item("a", 2, 0), item("b", 2.5, 0.5), item("c", 3.5, 3.5)]))
        kinds = {i["type"] for i in a["layout"]["issues"]}
        self.assertEqual(kinds, {"overlap", "out_of_bounds"})

    def test_touching_is_not_overlap(self):
        a = planner.analyze(room([item("a", 2, 0), item("b", 3, 0)]))
        self.assertFalse([i for i in a["layout"]["issues"] if i["type"] == "overlap"])

    def test_rotation_changes_footprint(self):
        a = planner.analyze(room([item("a", 3, 0, w=2, d=0.5, rot=90)]))  # 0.5 wide, 2 deep
        self.assertEqual(a["layout"]["issues"], [])
        b = planner.analyze(room([item("a", 3, 0, w=2, d=0.5, rot=0)]))
        self.assertEqual(b["layout"]["issues"][0]["type"], "out_of_bounds")

    def test_door_blocked(self):
        a = planner.analyze(room([item("a", 0.5, 3.2, w=1, d=0.8)]))
        self.assertIn("door_blocked", {i["type"] for i in a["layout"]["issues"]})

    def test_walled_in_item_is_unreachable(self):
        wall = [item("w1", 0, 1.5, w=4, d=0.2)]  # full-width wall splits the room
        a = planner.analyze(room(wall + [item("far", 1.5, 0.2, w=0.5, d=0.5)]))
        self.assertIn(("unreachable", ["far"]),
                      [(i["type"], i["items"]) for i in a["layout"]["issues"]])

    def test_arrange_resolves_problems(self):
        p = planner.PRESETS["cramped"]
        evs = list(planner.arrange(p))
        self.assertEqual(evs[0]["event"], "start")
        self.assertEqual(evs[-1]["event"], "done")
        placed = {e["item"]["id"]: e["item"] for e in evs if e["event"] == "place"}
        out = dict(p, items=[{**i, **placed.get(i["id"], {})} for i in p["items"]])
        self.assertEqual(planner.analyze(out)["layout"]["issues"], [])

    def test_validation(self):
        bad = [None, {}, {"room": {"width": "x", "length": 3}},
               room([], door={"wall": "roof", "pos": 1}),
               room([item("a", 0, 0, w=float("nan"))]),
               room([item("a", 0, 0, rot=45)]),
               room([item("a", 0, 0), item("a", 1, 1)]),
               room([item(str(i), 0, 0) for i in range(41)])]
        for payload in bad:
            with self.assertRaises(planner.ValidationError, msg=str(payload)[:60]):
                planner.analyze(payload)


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = app.make_server("127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        app.LIMIT.burst = 10_000

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, path, body=None, headers=None):
        r = urllib.request.Request(self.base + path, headers=headers or {},
                                   data=None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode()))
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def test_static_and_health(self):
        self.assertEqual(self.req("/health")[0], 200)
        s, body, h = self.req("/planner/")
        self.assertEqual(s, 200)
        self.assertIn(b"Room planner", body)
        self.assertIn("default-src", h["Content-Security-Policy"])
        s, _, h = self.req("/planner/planner.js")
        s2, _, _ = self.req("/planner/planner.js", headers={"If-None-Match": h["ETag"]})
        self.assertEqual(s2, 304)

    def test_blocked_paths(self):
        for p in ("/.git/config", "/server/app.py", "/tests/test_planner.py",
                  "/../etc/passwd", "/%2e%2e/etc/passwd", "/server/"):
            self.assertEqual(self.req(p)[0], 404, p)

    def test_analyze_api(self):
        s, body, _ = self.req("/api/analyze", planner.PRESETS["studio"])
        self.assertEqual(s, 200)
        self.assertEqual(json.loads(body)["layout"]["issues"], [])
        self.assertEqual(self.req("/api/analyze", b"{nope")[0], 400)
        self.assertEqual(self.req("/api/analyze", {"room": {}})[0], 400)

    def test_body_limit(self):
        self.assertEqual(self.req("/api/analyze", b" " * (app.MAX_BODY + 1))[0], 400)

    def test_arrange_stream(self):
        s, body, h = self.req("/api/arrange", planner.PRESETS["cramped"])
        self.assertEqual(s, 200)
        self.assertEqual(h["Content-Type"], "text/event-stream")
        evs = [json.loads(l[6:]) for l in body.decode().split("\n\n") if l.startswith("data: ")]
        self.assertEqual(evs[-1]["event"], "done")
        self.assertEqual(self.req("/api/arrange", {"room": {}})[0], 400)

    def test_rate_limit(self):
        lim = app.RateLimiter(rate=0.001, burst=3)
        self.assertEqual([lim.allow("x") for _ in range(5)], [True, True, True, False, False])


if __name__ == "__main__":
    unittest.main()
