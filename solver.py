import json
import math
from typing import Dict, Iterable, List, Tuple

import numpy as np
from scipy.optimize import minimize

Point = Tuple[float, float]
IndexPair = Tuple[int, int]


def dist(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def signed_area(vertices: List[Point]) -> float:
    return 0.5 * sum(
        vertices[i][0] * vertices[(i + 1) % len(vertices)][1]
        - vertices[(i + 1) % len(vertices)][0] * vertices[i][1]
        for i in range(len(vertices))
    )


def cross(a: Point, b: Point, c: Point) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def interior_angle(vertices: List[Point], i: int) -> float:
    n = len(vertices)
    prev = np.asarray(vertices[(i - 1) % n], dtype=float)
    curr = np.asarray(vertices[i], dtype=float)
    nxt = np.asarray(vertices[(i + 1) % n], dtype=float)
    u = prev - curr
    v = nxt - curr
    cos_angle = np.dot(u, v) / (np.linalg.norm(u) * np.linalg.norm(v))
    base_angle = math.degrees(math.acos(np.clip(cos_angle, -1.0, 1.0)))
    turn = cross(vertices[(i - 1) % n], vertices[i], vertices[(i + 1) % n])
    ccw = signed_area(vertices) > 0
    reflex = turn < 0 if ccw else turn > 0
    return 360.0 - base_angle if reflex else base_angle


def _on_segment(a: Point, b: Point, p: Point, eps: float = 1e-8) -> bool:
    return (
        min(a[0], b[0]) - eps <= p[0] <= max(a[0], b[0]) + eps
        and min(a[1], b[1]) - eps <= p[1] <= max(a[1], b[1]) + eps
    )


def _segments_intersect(a: Point, b: Point, c: Point, d: Point, eps: float = 1e-8) -> bool:
    c1 = cross(a, b, c)
    c2 = cross(a, b, d)
    c3 = cross(c, d, a)
    c4 = cross(c, d, b)
    if (((c1 > eps and c2 < -eps) or (c1 < -eps and c2 > eps))
        and ((c3 > eps and c4 < -eps) or (c3 < -eps and c4 > eps))):
        return True
    if abs(c1) <= eps and _on_segment(a, b, c): return True
    if abs(c2) <= eps and _on_segment(a, b, d): return True
    if abs(c3) <= eps and _on_segment(c, d, a): return True
    if abs(c4) <= eps and _on_segment(c, d, b): return True
    return False


def is_simple_polygon(vertices: List[Point]) -> bool:
    n = len(vertices)
    for i in range(n):
        a = vertices[i]
        b = vertices[(i + 1) % n]
        for j in range(i + 1, n):
            if j == i or j == (i + 1) % n or i == (j + 1) % n:
                continue
            c = vertices[j]
            d = vertices[(j + 1) % n]
            if _segments_intersect(a, b, c, d):
                return False
    return True


def _reflect_across_origin_side(vertices: List[Point], p0: Point, p1: Point) -> List[Point]:
    a = np.asarray(p0, dtype=float)
    b = np.asarray(p1, dtype=float)
    direction = b - a
    direction /= np.linalg.norm(direction)
    reflected = [vertices[0], vertices[1]]
    for point in vertices[2:]:
        p = np.asarray(point, dtype=float)
        projection = a + direction * np.dot(p - a, direction)
        reflected_point = 2.0 * projection - p
        reflected.append(tuple(map(float, reflected_point)))
    return reflected


def origin_direction(direction: str) -> Point:
    unit = math.sqrt(0.5)
    directions = {
        "right": (1.0, 0.0),
        "up-right": (unit, unit),
        "up": (0.0, 1.0),
        "up-left": (-unit, unit),
        "left": (-1.0, 0.0),
        "down-left": (-unit, -unit),
        "down": (0.0, -1.0),
        "down-right": (unit, -unit),
    }
    if direction not in directions:
        raise ValueError(f"Unknown direction '{direction}'.")
    return directions[direction]


def solve_polygon(
    sides: List[float],
    side_tolerance_ratios: List[float],
    diagonals: List[Tuple[int, int, float, float]],
    direction: str,
    *,
    right_angles: Iterable[int] = (),
    orientation_ccw: bool = True,
    n_starts: int = 30,
    random_seed: int = 1234,
) -> Dict:
    n = len(sides)
    if n < 3:
        raise ValueError("Add at least three wall measurements.")
    if len(side_tolerance_ratios) != n:
        raise ValueError("Each wall must have one tolerance value.")
    if any(value <= 0 for value in sides):
        raise ValueError("All wall lengths must be positive.")
    if any(value <= 0 for value in side_tolerance_ratios):
        raise ValueError("All wall tolerances must be positive.")

    right_angles = set(int(i) for i in right_angles)
    if any(i < 0 or i >= n for i in right_angles):
        raise ValueError("A selected right-angle corner is outside the available range.")

    diag_items = []
    seen_pairs = set()
    for i, j, measured, tolerance_ratio in diagonals:
        i, j = int(i), int(j)
        measured = float(measured)
        tolerance_ratio = float(tolerance_ratio)
        if not (0 <= i < n and 0 <= j < n):
            raise ValueError(f"Diagonal Corner {i + 1} to Corner {j + 1} is outside the available range.")
        if i == j:
            raise ValueError("A diagonal cannot start and end at the same corner.")
        pair = tuple(sorted((i, j)))
        if pair in seen_pairs:
            raise ValueError(f"Diagonal Corner {pair[0] + 1} to Corner {pair[1] + 1} was entered more than once.")
        seen_pairs.add(pair)
        if (pair[1] - pair[0] == 1) or pair == (0, n - 1):
            raise ValueError(f"Corner {pair[0] + 1} to Corner {pair[1] + 1} is a wall, not a diagonal.")
        if measured <= 0:
            raise ValueError("All diagonal lengths must be positive.")
        if tolerance_ratio <= 0:
            raise ValueError("All diagonal tolerances must be positive.")
        diag_items.append((pair[0], pair[1], measured, tolerance_ratio))

    p0 = (0.0, 0.0)
    origin_unit = np.asarray(origin_direction(direction), dtype=float)
    p1 = tuple(origin_unit * sides[0])
    side_tolerances = np.asarray(sides, dtype=float) * np.asarray(side_tolerance_ratios, dtype=float)
    diag_tolerances = np.asarray([d[2] * d[3] for d in diag_items], dtype=float)

    initial = np.zeros((n, 2), dtype=float)
    initial[0] = p0
    initial[1] = p1
    edge_direction = initial[1] - initial[0]
    edge_direction /= np.linalg.norm(edge_direction)
    turn = (2.0 * math.pi / n) * (1.0 if orientation_ccw else -1.0)
    cos_t, sin_t = math.cos(turn), math.sin(turn)
    for i in range(1, n - 1):
        edge_direction = np.array([
            cos_t * edge_direction[0] - sin_t * edge_direction[1],
            sin_t * edge_direction[0] + cos_t * edge_direction[1],
        ])
        initial[i + 1] = initial[i] + sides[i] * edge_direction

    unknown_vertices = list(range(2, n))

    def pack(vertices: np.ndarray) -> np.ndarray:
        return np.concatenate([[sides[0]], *[vertices[i] for i in unknown_vertices]])

    def unpack(x: np.ndarray) -> np.ndarray:
        vertices = initial.copy()
        vertices[0] = p0
        vertices[1] = origin_unit * x[0]
        for k, vertex_index in enumerate(unknown_vertices):
            start = 1 + 2 * k
            vertices[vertex_index] = x[start:start + 2]
        return vertices

    def side_errors(x: np.ndarray) -> np.ndarray:
        vertices = unpack(x)
        return np.asarray([
            np.linalg.norm(vertices[(i + 1) % n] - vertices[i]) - sides[i]
            for i in range(n)
        ], dtype=float)

    def diagonal_errors(x: np.ndarray) -> np.ndarray:
        if not diag_items:
            return np.empty(0, dtype=float)
        vertices = unpack(x)
        return np.asarray([
            np.linalg.norm(vertices[j] - vertices[i]) - measured
            for i, j, measured, _ in diag_items
        ], dtype=float)

    def measurement_bounds(x: np.ndarray) -> np.ndarray:
        side_err = side_errors(x)
        values = [side_tolerances - side_err, side_tolerances + side_err]
        diag_err = diagonal_errors(x)
        if len(diag_err):
            values.extend([diag_tolerances - diag_err, diag_tolerances + diag_err])
        return np.concatenate(values)

    angle_constraints = sorted(right_angles)
    optimized_angle_constraints = angle_constraints[:3] if n == 4 and len(angle_constraints) == 4 else angle_constraints

    def angle_equations_for(x: np.ndarray, indices: Iterable[int]) -> np.ndarray:
        vertices = unpack(x)
        values = []
        for i in indices:
            prev_i = (i - 1) % n
            next_i = (i + 1) % n
            incoming = vertices[prev_i] - vertices[i]
            outgoing = vertices[next_i] - vertices[i]
            scale = sides[prev_i] * sides[i]
            values.append(float(np.dot(incoming, outgoing) / scale))
        return np.asarray(values, dtype=float)

    def right_angle_equations(x: np.ndarray) -> np.ndarray:
        return angle_equations_for(x, optimized_angle_constraints)

    def all_right_angle_equations(x: np.ndarray) -> np.ndarray:
        return angle_equations_for(x, angle_constraints)

    # Keep the requested 3:1 raw squared-error weighting.
    def total_objective(x: np.ndarray) -> float:
        side_err = side_errors(x)
        diag_err = diagonal_errors(x)
        return float(3.0 * np.dot(side_err, side_err) + np.dot(diag_err, diag_err))

    constraints = [{"type": "ineq", "fun": measurement_bounds}]
    if optimized_angle_constraints:
        constraints.append({"type": "eq", "fun": right_angle_equations})

    base_x = pack(initial)
    rng = np.random.default_rng(random_seed)
    scale = max(float(np.mean(sides)), 1.0)
    starts = [base_x]
    for _ in range(n_starts - 1):
        starts.append(base_x + rng.normal(loc=0.0, scale=0.35 * scale, size=base_x.shape))

    candidates = []
    for start in starts:
        result = minimize(
            total_objective,
            start,
            method="SLSQP",
            constraints=constraints,
            options={"ftol": 1e-12, "maxiter": 4000, "disp": False},
        )
        if not result.success:
            continue
        if np.min(measurement_bounds(result.x)) < -1e-5:
            continue
        if angle_constraints and np.max(np.abs(all_right_angle_equations(result.x))) > 1e-6:
            continue
        vertices = [tuple(map(float, point)) for point in unpack(result.x)]
        if not is_simple_polygon(vertices):
            continue
        candidates.append(result)

    if not candidates:
        raise ValueError(
            "No simple polygon satisfies the selected exact right angles and all per-measurement tolerance bounds. "
            "Check the measurements, increase one or more tolerances, or add an informative diagonal."
        )

    best = min(candidates, key=lambda result: result.fun)
    vertices = [tuple(map(float, point)) for point in unpack(best.x)]
    current_ccw = signed_area(vertices) > 0
    if current_ccw != orientation_ccw:
        vertices = _reflect_across_origin_side(vertices, vertices[0], vertices[1])

    side_report = []
    for i, measured in enumerate(sides):
        j = (i + 1) % n
        fitted = dist(vertices[i], vertices[j])
        side_report.append({
            "from": i,
            "to": j,
            "measured": measured,
            "fitted": fitted,
            "error": fitted - measured,
            "tolerance": side_tolerances[i],
        })

    diagonal_report = []
    for i, j, measured, tolerance_ratio in diag_items:
        fitted = dist(vertices[i], vertices[j])
        diagonal_report.append({
            "from": i,
            "to": j,
            "measured": measured,
            "fitted": fitted,
            "error": fitted - measured,
            "tolerance": measured * tolerance_ratio,
        })

    angles = [interior_angle(vertices, i) for i in range(n)]
    return {
        "vertices": vertices,
        "sides": side_report,
        "diagonals": diagonal_report,
        "angles": angles,
        "orientation": "ccw" if orientation_ccw else "cw",
        "objective": float(best.fun),
    }


def solve_from_json(payload_json: str) -> str:
    payload = json.loads(payload_json)
    result = solve_polygon(
        sides=[float(w["length"]) for w in payload["walls"]],
        side_tolerance_ratios=[float(w["tolerance"]) for w in payload["walls"]],
        diagonals=[
            (int(d["from"]), int(d["to"]), float(d["length"]), float(d["tolerance"]))
            for d in payload.get("diagonals", [])
        ],
        direction=payload.get("direction", "right"),
        right_angles=[int(i) for i in payload.get("right_angles", [])],
        orientation_ccw=payload.get("orientation", "cw") == "ccw",
    )
    return json.dumps(result)
