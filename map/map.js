const HEX_PIXEL_SIZE = 56;
/** Flat-top adjacent-hex center distance is size * √3 (same convention as axialToPixel). */
const HEX_NEIGHBOR_FACTOR = Math.sqrt(3);
const BASE_PACK_CODE = "0";
const SQRT3 = Math.sqrt(3);

/** @typedef {{ code: string, id: string, label: string, color: string }} DlcPack */
/** @typedef {{ macro: string, name: string, dlc: string|null, x: number, z: number }} Sector */
/** @typedef {{ id: string, macro: string, x: number, z: number, q: number, r: number, sectors: Sector[] }} Cluster */
/** @typedef {{ a: string, b: string, type: string, oneWay: boolean }} Link */
/** @typedef {{ hexSize: number, dlcPacks: DlcPack[], clusters: Cluster[], links: Link[] }} MapData */
/** @typedef {Record<string, number>} SectorResources */
/** @typedef {{ sectors: Record<string, SectorResources> }} SectorResourcesData */
/** @typedef {{ category: string, owner: string }} StationFacility */
/** @typedef {{ factions: Record<string, string>, sectors: Record<string, StationFacility[]> }} SectorStationsData */

const RESOURCE_LABELS = {
  helium: "Helium",
  hydrogen: "Hydrogen",
  ice: "Ice",
  methane: "Methane",
  nividium: "Nividium",
  ore: "Ore",
  rawkhaakscrap: "Raw Khaak Scrap",
  rawscrap: "Raw Scrap",
  silicon: "Silicon",
};

/** @type {Record<string, string>} */
const RESOURCE_COLORS = {
  helium: "#7ec8e8",
  hydrogen: "#4a7fd4",
  ice: "#e8f0f8",
  methane: "#3dbf6a",
  nividium: "#c45ad4",
  ore: "#e8a040",
  rawkhaakscrap: "#d4453a",
  rawscrap: "#a08060",
  silicon: "#2eb8a0",
};

/**
 * @param {string} ware
 * @returns {string}
 */
function resourceColor(ware) {
  const known = RESOURCE_COLORS[ware];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < ware.length; i += 1) {
    hash = (hash * 31 + ware.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 55% 58%)`;
}

/**
 * Flat-top hex center in pixel space from axial coords.
 * @param {number} q
 * @param {number} r
 * @param {number} size
 */
function axialToPixel(q, r, size = HEX_PIXEL_SIZE) {
  const x = size * (1.5 * q);
  const y = size * ((SQRT3 / 2) * q + SQRT3 * r);
  // Game Z grows "north"; SVG Y grows down — flip Z.
  return { x, y: -y };
}

/**
 * @param {number} cx
 * @param {number} cy
 * @param {number} size
 */
function flatTopHexPoints(cx, cy, size = HEX_PIXEL_SIZE) {
  const points = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 180) * (60 * i);
    points.push(`${cx + size * Math.cos(angle)},${cy + size * Math.sin(angle)}`);
  }
  return points.join(" ");
}

/** Fraction of hex size to inset link endpoints toward the border. */
const LINK_INSET_FACTOR = 0.6;
/** Minimum visible stub length when insets would collapse a neighbor link. */
const LINK_MIN_STUB = 14;

/**
 * Shorten a center-to-center link so it sits near hex borders (visible for
 * neighbors when drawn above fills) without crossing sector labels.
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} insetA
 * @param {number} insetB
 * @returns {{ x1: number, y1: number, x2: number, y2: number }|null}
 */
function shortenLinkEndpoints(ax, ay, bx, by, insetA, insetB) {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return null;
  const ux = dx / dist;
  const uy = dy / dist;
  if (insetA + insetB >= dist) {
    const half = Math.min(LINK_MIN_STUB / 2, dist * 0.2);
    const mid = dist / 2;
    return {
      x1: ax + ux * (mid - half),
      y1: ay + uy * (mid - half),
      x2: ax + ux * (mid + half),
      y2: ay + uy * (mid + half),
    };
  }
  return {
    x1: ax + ux * insetA,
    y1: ay + uy * insetA,
    x2: bx - ux * insetB,
    y2: by - uy * insetB,
  };
}

/** Chord-length fraction for quadratic bulge (clamped by min/max). */
const LINK_CURVE_FACTOR = 0.11;
/** Min perpendicular control-point offset so short links still separate. */
const LINK_CURVE_MIN = 8;
/** Max perpendicular control-point offset in pixels. */
const LINK_CURVE_MAX = HEX_PIXEL_SIZE * 0.35;

/**
 * Deterministic hash → signed unit in (-1, 1], stable across reloads.
 * @param {string} a
 * @param {string} b
 * @param {string} type
 * @returns {number}
 */
function linkCurveSign(a, b, type) {
  const key = `${a}\0${b}\0${type}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Map to odd-ish range away from zero so curves stay visible.
  const u = ((hash >>> 0) % 2001) / 1000 - 1; // [-1, 1]
  return u >= 0 ? Math.max(0.35, u) : Math.min(-0.35, u);
}

/**
 * Quadratic control point offset perpendicular to the chord.
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {string} a
 * @param {string} b
 * @param {string} type
 * @returns {{ cx: number, cy: number }|null}
 */
function linkCurveControl(x1, y1, x2, y2, a, b, type) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return null;
  const amp = Math.min(
    LINK_CURVE_MAX,
    Math.max(LINK_CURVE_MIN, dist * LINK_CURVE_FACTOR),
  );
  const offset = amp * linkCurveSign(a, b, type);
  const px = -dy / dist;
  const py = dx / dist;
  return {
    cx: (x1 + x2) / 2 + px * offset,
    cy: (y1 + y2) / 2 + py * offset,
  };
}

/**
 * SVG path `d` for a curved link (quadratic Bézier).
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {number} cx
 * @param {number} cy
 * @returns {string}
 */
function linkCurvePathD(x1, y1, x2, y2, cx, cy) {
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}

/**
 * @param {string|null|undefined} dlc
 */
function packCode(dlc) {
  return dlc || BASE_PACK_CODE;
}

/** Inset parent size so sub strokes sit just inside the parent outline. */
const PARENT_PACK_INSET = 1;

/**
 * Circular mean of angles (radians).
 * @param {number[]} angles
 */
function circularMean(angles) {
  let sx = 0;
  let sy = 0;
  for (const a of angles) {
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  if (sx * sx + sy * sy < 1e-12) return angles[0] || 0;
  return Math.atan2(sy, sx);
}

/**
 * True if (x, y) lies inside a flat-top hex of circumradius R at the origin.
 * Flats face 30° + 60°·k (vertices at 0° + 60°·k).
 * @param {number} x
 * @param {number} y
 * @param {number} R
 */
function pointInFlatTopHex(x, y, R) {
  const limit = (R * SQRT3) / 2;
  for (let i = 0; i < 6; i += 1) {
    const n = (Math.PI / 180) * (30 + 60 * i);
    if (x * Math.cos(n) + y * Math.sin(n) > limit + 1e-9) return false;
  }
  return true;
}

/**
 * Largest sub-hex circumradius such that mutually touching sub-hexes at the
 * given pack angles stay inside the parent (ring = ringFactor · subSize).
 * @param {number[]} packAngles
 * @param {number} ringFactor
 * @param {number} parentR
 */
function maxSubSizeInParent(packAngles, ringFactor, parentR) {
  let lo = 0;
  let hi = parentR;
  for (let iter = 0; iter < 40; iter += 1) {
    const mid = (lo + hi) / 2;
    const ring = mid * ringFactor;
    let fits = true;
    outer: for (const angle of packAngles) {
      const ox = ring * Math.cos(angle);
      const oy = ring * Math.sin(angle);
      for (let i = 0; i < 6; i += 1) {
        const a = (Math.PI / 180) * (60 * i);
        const vx = ox + mid * Math.cos(a);
        const vy = oy + mid * Math.sin(a);
        if (!pointInFlatTopHex(vx, vy, parentR)) {
          fits = false;
          break outer;
        }
      }
    }
    if (fits) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Snap a pack rotation onto the parent flat-top vertex lattice (0° + 60°·k)
 * so outer sub-hex tips meet parent vertices. Preserves nearest game orientation.
 * @param {number} alphaGame
 * @param {number} n
 */
function snapPackAlphaToVertices(alphaGame, n) {
  const lattice = Math.PI / 3; // 60°
  if (n === 2) {
    // Opposite-vertex axes are undirected; unique axes at 0°, 60°, 120°.
    let a = ((alphaGame % Math.PI) + Math.PI) % Math.PI;
    const k = Math.round(a / lattice) % 3;
    return k * lattice;
  }
  // n≥3: rotating by 60° walks the vertex-aimed placements.
  return Math.round(alphaGame / lattice) * lattice;
}

/**
 * Pack multi-sector offsets into the parent hex.
 * Doubles: opposite, tips meet vertex-to-vertex at the center, outer tips on
 * parent vertices. Triples: equilateral edge-touch, outer tips on parent vertices.
 * Game bearings set circular order; rotation snaps to the vertex lattice.
 * @param {Sector[]} sectors
 * @returns {{ offsets: Map<string, {x:number,y:number}>, subSize: number }}
 */
function layoutClusterSectors(sectors) {
  /** @type {Map<string, {x:number,y:number}>} */
  const offsets = new Map();
  if (sectors.length === 0) {
    return { offsets, subSize: HEX_PIXEL_SIZE };
  }
  if (sectors.length === 1) {
    offsets.set(sectors[0].name, { x: 0, y: 0 });
    return { offsets, subSize: HEX_PIXEL_SIZE };
  }

  const n = sectors.length;
  const raw = sectors.map((s) => ({
    name: s.name,
    x: s.x || 0,
    // Flip Z for SVG Y-down (same convention as axialToPixel).
    y: -(s.z || 0),
  }));

  const cx = raw.reduce((sum, p) => sum + p.x, 0) / n;
  const cy = raw.reduce((sum, p) => sum + p.y, 0) / n;

  /** @type {{ name: string, angle: number }[]} */
  const angled = [];
  let fallback = 0;
  for (const p of raw) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    if (Math.hypot(dx, dy) < 1e-6) {
      angled.push({
        name: p.name,
        angle: -Math.PI / 2 + (fallback * 2 * Math.PI) / n,
      });
      fallback += 1;
    } else {
      angled.push({ name: p.name, angle: Math.atan2(dy, dx) });
    }
  }

  const sorted = [...angled].sort((a, b) => a.angle - b.angle);
  const step = (2 * Math.PI) / n;
  const alphaGame = circularMean(sorted.map((s, i) => s.angle - i * step));
  const alpha = snapPackAlphaToVertices(alphaGame, n);
  /** @type {{ name: string, packAngle: number }[]} */
  const packed = sorted.map((s, i) => ({
    name: s.name,
    packAngle: alpha + i * step,
  }));

  // n=2: ring = s → centers 2s apart → vertex-to-vertex at the origin.
  // n=3: ring = s → centers s·√3 apart → shared edges; outer tips on vertices.
  // n>3 (none in data): equal-angle ring with neighbor edge-touch.
  const ringFactor =
    n === 2 || n === 3
      ? 1
      : HEX_NEIGHBOR_FACTOR / (2 * Math.sin(Math.PI / n));

  const parentR = HEX_PIXEL_SIZE - PARENT_PACK_INSET;
  const subSize = maxSubSizeInParent(
    packed.map((p) => p.packAngle),
    ringFactor,
    parentR,
  );
  const ring = subSize * ringFactor;

  for (const { name, packAngle } of packed) {
    offsets.set(name, {
      x: ring * Math.cos(packAngle),
      y: ring * Math.sin(packAngle),
    });
  }
  return { offsets, subSize };
}

/**
 * @param {MapData} data
 */
function buildLookups(data) {
  /** @type {Map<string, Cluster>} */
  const sectorToCluster = new Map();
  /** @type {Map<string, {x:number,y:number}>} */
  const clusterPixels = new Map();
  /** @type {Map<string, {x:number,y:number}>} */
  const sectorPixels = new Map();
  /** @type {Map<string, number>} */
  const clusterSubSize = new Map();

  for (const cluster of data.clusters) {
    const px = axialToPixel(cluster.q, cluster.r);
    clusterPixels.set(cluster.id, px);
    const { offsets, subSize } = layoutClusterSectors(cluster.sectors);
    clusterSubSize.set(cluster.id, subSize);
    for (const sector of cluster.sectors) {
      sectorToCluster.set(sector.name, cluster);
      const local = offsets.get(sector.name) || { x: 0, y: 0 };
      sectorPixels.set(sector.name, {
        x: px.x + local.x,
        y: px.y + local.y,
      });
    }
  }
  return { sectorToCluster, clusterPixels, sectorPixels, clusterSubSize };
}

/**
 * @param {SectorResourcesData} resourcesData
 * @returns {{ byName: Map<string, SectorResources>, sunlightLevels: number[], presenceWares: string[] }}
 */
function buildResourceLookups(resourcesData) {
  /** @type {Map<string, SectorResources>} */
  const byName = new Map(Object.entries(resourcesData.sectors || {}));
  /** @type {Set<number>} */
  const sunSet = new Set();
  /** @type {Set<string>} */
  const wareSet = new Set();
  for (const resources of byName.values()) {
    for (const [ware, value] of Object.entries(resources)) {
      if (ware === "sunlight") {
        if (typeof value === "number") sunSet.add(value);
      } else {
        wareSet.add(ware);
      }
    }
  }
  const presenceWares = Object.keys(RESOURCE_LABELS).filter((w) =>
    wareSet.has(w),
  );
  for (const ware of [...wareSet].sort()) {
    if (!presenceWares.includes(ware)) presenceWares.push(ware);
  }
  const sunlightLevels = [...sunSet].sort((a, b) => a - b);
  return { byName, sunlightLevels, presenceWares };
}

/**
 * Format a sunlight rating for the slider readout.
 * @param {number} value
 */
function formatSunlight(value) {
  return `${Math.round(value * 100)}%`;
}

/** Slider steps: self-only, SH-only (budget 0), then gate budgets 1–5. */
const RESOURCE_DISTANCE_STEPS = [
  { label: "0", selfOnly: true, budget: 0 },
  { label: "0+", selfOnly: false, budget: 0 },
  { label: "1", selfOnly: false, budget: 1 },
  { label: "2", selfOnly: false, budget: 2 },
  { label: "3", selfOnly: false, budget: 3 },
  { label: "4", selfOnly: false, budget: 4 },
  { label: "5", selfOnly: false, budget: 5 },
];

/** @typedef {{ to: string, cost: 0|1 }} TravelEdge */

/**
 * Directed travel graph: superhighway cost 0, gate/accelerator cost 1.
 * @param {Link[]} links
 * @returns {Map<string, TravelEdge[]>}
 */
function buildTravelGraph(links) {
  /** @type {Map<string, TravelEdge[]>} */
  const adjacency = new Map();
  /**
   * @param {string} from
   * @param {string} to
   * @param {0|1} cost
   */
  function addEdge(from, to, cost) {
    let edges = adjacency.get(from);
    if (!edges) {
      edges = [];
      adjacency.set(from, edges);
    }
    edges.push({ to, cost });
  }
  for (const link of links) {
    const cost = /** @type {0|1} */ (link.type === "superhighway" ? 0 : 1);
    addEdge(link.a, link.b, cost);
    if (!link.oneWay) addEdge(link.b, link.a, cost);
  }
  return adjacency;
}

/**
 * Shortest travel distances via 0-1 BFS. Only visits allowedNodes.
 * @param {string} source
 * @param {Map<string, TravelEdge[]>} adjacency
 * @param {Set<string>} allowedNodes
 * @returns {Map<string, number>}
 */
function distancesFrom(source, adjacency, allowedNodes) {
  /** @type {Map<string, number>} */
  const dist = new Map();
  if (!allowedNodes.has(source)) return dist;
  dist.set(source, 0);
  /** @type {string[]} */
  const deque = [source];
  while (deque.length > 0) {
    const u = deque.shift();
    if (u === undefined) break;
    const du = dist.get(u) ?? 0;
    for (const { to, cost } of adjacency.get(u) || []) {
      if (!allowedNodes.has(to) || dist.has(to)) continue;
      dist.set(to, du + cost);
      if (cost === 0) deque.unshift(to);
      else deque.push(to);
    }
  }
  return dist;
}

/**
 * Place small resource presence dots below the sector label center.
 * @param {number} cx
 * @param {number} cy
 * @param {number} hexSize
 * @param {string[]} wares
 * @returns {{ x: number, y: number, r: number }[]}
 */
function layoutResourceDots(cx, cy, hexSize, wares) {
  if (wares.length === 0) return [];
  const r = Math.min(Math.max(hexSize * 0.08, 2.2), 4.5);
  const gap = r * 2.4;
  const maxPerRow = 5;
  const rows = [];
  for (let i = 0; i < wares.length; i += maxPerRow) {
    rows.push(wares.slice(i, i + maxPerRow));
  }
  const rowGap = r * 2.6;
  const baseY = cy + hexSize * 0.28;
  /** @type {{ x: number, y: number, r: number }[]} */
  const positions = [];
  rows.forEach((row, rowIndex) => {
    const width = (row.length - 1) * gap;
    const startX = cx - width / 2;
    const y = baseY + rowIndex * rowGap;
    row.forEach((_, colIndex) => {
      positions.push({ x: startX + colIndex * gap, y, r });
    });
  });
  return positions;
}

/**
 * Place facility icons above the sector label center.
 * @param {number} cx
 * @param {number} cy
 * @param {number} hexSize
 * @param {string[]} categories
 * @param {{ spreadForLabels?: boolean }} [options]
 * @returns {{ category: string, x: number, y: number, size: number }[]}
 */
function layoutStationIcons(cx, cy, hexSize, categories, options = {}) {
  if (categories.length === 0) return [];
  const size = Math.min(Math.max(hexSize * 0.11, 3.2), 5.5);
  // Multi-owner shortnames (~3 chars at 7px) need a floor gap; sub-hexes are
  // too small for a hexSize-relative gap alone (e.g. Savage Spur).
  const gap = options.spreadForLabels
    ? Math.max(size * 2.35, hexSize * 0.36, 18)
    : size * 2.35;
  const width = (categories.length - 1) * gap;
  const startX = cx - width / 2;
  const y = cy - hexSize * 0.34;
  return categories.map((category, i) => ({
    category,
    x: startX + i * gap,
    y,
    size,
  }));
}

/**
 * @param {string} owner
 * @param {Record<string, string>} factionShortnames
 * @returns {string}
 */
function factionShortname(owner, factionShortnames) {
  return factionShortnames[owner] || owner.slice(0, 3).toUpperCase() || "?";
}

/**
 * @param {string} shortname
 * @param {number} x
 * @param {number} y
 * @returns {SVGTextElement}
 */
function createFactionLabel(shortname, x, y) {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", String(x));
  text.setAttribute("y", String(y));
  text.setAttribute("dominant-baseline", "auto");
  text.classList.add("faction-label");
  text.textContent = shortname;
  return text;
}

/**
 * @param {string} category
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @returns {SVGGElement}
 */
function createStationIcon(category, x, y, size) {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.classList.add("station-icon", category);
  g.setAttribute("transform", `translate(${x} ${y})`);

  /**
   * @param {string} name
   * @param {Record<string, string>} attrs
   */
  function el(name, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
    g.append(node);
    return node;
  }

  const s = size;
  switch (category) {
    case "shipyard":
      el("rect", {
        x: String(-s * 0.7),
        y: String(-s * 0.55),
        width: String(s * 1.4),
        height: String(s * 1.1),
        rx: "0.6",
      });
      break;
    case "wharf":
      el("polygon", {
        points: `0,${-s} ${s * 0.85},${s * 0.7} ${-s * 0.85},${s * 0.7}`,
      });
      break;
    case "equipmentdock":
      el("polygon", {
        points: `0,${-s} ${s},0 0,${s} ${-s},0`,
      });
      break;
    case "tradestation":
      el("circle", { r: String(s * 0.72) });
      el("line", {
        x1: String(-s * 0.45),
        y1: "0",
        x2: String(s * 0.45),
        y2: "0",
      });
      el("line", {
        x1: "0",
        y1: String(-s * 0.45),
        x2: "0",
        y2: String(s * 0.45),
      });
      break;
    case "freeport": {
      const pts = [];
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 180) * (60 * i - 30);
        pts.push(`${s * Math.cos(angle)},${s * Math.sin(angle)}`);
      }
      el("polygon", { points: pts.join(" ") });
      break;
    }
    case "piratebase":
      el("line", {
        x1: String(-s * 0.75),
        y1: String(-s * 0.75),
        x2: String(s * 0.75),
        y2: String(s * 0.75),
      });
      el("line", {
        x1: String(s * 0.75),
        y1: String(-s * 0.75),
        x2: String(-s * 0.75),
        y2: String(s * 0.75),
      });
      break;
    case "khaak_hive":
      el("polygon", {
        points: `0,${-s} ${s * 0.35},0 0,${s} ${-s * 0.35},0`,
      });
      el("polygon", {
        points: `${-s},0 0,${-s * 0.35} ${s},0 0,${s * 0.35}`,
      });
      break;
    default:
      el("circle", { r: String(s * 0.55) });
      break;
  }
  return g;
}

/**
 * @param {MapData} data
 * @param {SectorResourcesData} resourcesData
 * @param {SectorStationsData} stationsData
 */
function renderMap(data, resourcesData, stationsData) {
  const svg = document.getElementById("map");
  const filtersRoot = document.getElementById("dlc-filters");
  const resourceFiltersRoot = document.getElementById("resource-filters");
  const sunlightSlider = document.getElementById("sunlight-slider");
  const sunlightValue = document.getElementById("sunlight-value");
  const distanceSlider = document.getElementById("resource-distance-slider");
  const distanceValue = document.getElementById("resource-distance-value");
  if (
    !(svg instanceof SVGSVGElement) ||
    !filtersRoot ||
    !resourceFiltersRoot ||
    !(sunlightSlider instanceof HTMLInputElement) ||
    !(sunlightValue instanceof HTMLOutputElement) ||
    !(distanceSlider instanceof HTMLInputElement) ||
    !(distanceValue instanceof HTMLOutputElement)
  ) {
    throw new Error("Map DOM nodes missing");
  }

  const { sectorToCluster, clusterPixels, sectorPixels, clusterSubSize } =
    buildLookups(data);
  const { byName: resourcesByName, sunlightLevels, presenceWares } =
    buildResourceLookups(resourcesData);
  /** @type {Record<string, string>} */
  const factionShortnames = stationsData.factions || {};
  /** @type {Map<string, StationFacility[]>} */
  const stationsByName = new Map(
    Object.entries(stationsData.sectors || {}).map(([name, facilities]) => [
      name,
      Array.isArray(facilities) ? facilities : [],
    ]),
  );
  const travelGraph = buildTravelGraph(data.links);
  /** @type {Set<string>} */
  const enabledDlc = new Set(data.dlcPacks.map((p) => p.code));
  /** @type {Set<string>} */
  const requiredResources = new Set();
  /** @type {Map<string, string>} */
  const packColor = new Map(data.dlcPacks.map((p) => [p.code, p.color]));
  let sunlightThreshold =
    sunlightLevels.length > 0 ? sunlightLevels[0] : 0;
  let resourceDistanceIndex = 0;

  filtersRoot.replaceChildren();
  for (const pack of data.dlcPacks) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.dataset.code = pack.code;
    const dot = document.createElement("span");
    dot.className = "dlc-dot";
    dot.style.background = pack.color;
    label.append(input, dot, document.createTextNode(pack.label));
    filtersRoot.append(label);
    input.addEventListener("change", () => {
      if (input.checked) enabledDlc.add(pack.code);
      else enabledDlc.delete(pack.code);
      applyDimming();
    });
  }

  resourceFiltersRoot.replaceChildren();
  for (const ware of presenceWares) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = false;
    input.dataset.ware = ware;
    const display =
      RESOURCE_LABELS[/** @type {keyof typeof RESOURCE_LABELS} */ (ware)] ||
      ware;
    const dot = document.createElement("span");
    dot.className = "dlc-dot";
    dot.style.background = resourceColor(ware);
    label.append(
      input,
      dot,
      document.createTextNode(`Filter by ${display}`),
    );
    resourceFiltersRoot.append(label);
    input.addEventListener("change", () => {
      if (input.checked) requiredResources.add(ware);
      else requiredResources.delete(ware);
      applyDimming();
    });
  }

  if (sunlightLevels.length > 0) {
    sunlightSlider.disabled = false;
    sunlightSlider.min = "0";
    sunlightSlider.max = String(sunlightLevels.length - 1);
    sunlightSlider.step = "1";
    sunlightSlider.value = "0";
    sunlightThreshold = sunlightLevels[0];
    sunlightValue.textContent = formatSunlight(sunlightThreshold);
    sunlightSlider.addEventListener("input", () => {
      const index = Number(sunlightSlider.value);
      sunlightThreshold =
        sunlightLevels[index] ?? sunlightLevels[0] ?? 0;
      sunlightValue.textContent = formatSunlight(sunlightThreshold);
      applyDimming();
    });
  } else {
    sunlightSlider.disabled = true;
    sunlightValue.textContent = "—";
  }

  distanceSlider.min = "0";
  distanceSlider.max = String(RESOURCE_DISTANCE_STEPS.length - 1);
  distanceSlider.step = "1";
  distanceSlider.value = "0";
  distanceValue.textContent = RESOURCE_DISTANCE_STEPS[0].label;
  distanceSlider.addEventListener("input", () => {
    const index = Number(distanceSlider.value);
    resourceDistanceIndex = Math.max(
      0,
      Math.min(RESOURCE_DISTANCE_STEPS.length - 1, index),
    );
    distanceValue.textContent =
      RESOURCE_DISTANCE_STEPS[resourceDistanceIndex].label;
    applyDimming();
  });

  svg.replaceChildren();
  const root = document.createElementNS("http://www.w3.org/2000/svg", "g");
  root.setAttribute("id", "world");
  svg.append(root);

  const linksLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  linksLayer.setAttribute("id", "links");
  const hexesLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  hexesLayer.setAttribute("id", "hexes");
  const resourceDotsLayer = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "g",
  );
  resourceDotsLayer.setAttribute("id", "resource-dots");
  const stationIconsLayer = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "g",
  );
  stationIconsLayer.setAttribute("id", "station-icons");
  const labelsLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  labelsLayer.setAttribute("id", "labels");
  // Links above hex fills so neighbor bridges stay visible; below icons/labels.
  root.append(
    hexesLayer,
    linksLayer,
    resourceDotsLayer,
    stationIconsLayer,
    labelsLayer,
  );

  /** @type {SVGElement[]} */
  const linkEls = [];
  for (const link of data.links) {
    const aPx = sectorPixels.get(link.a);
    const bPx = sectorPixels.get(link.b);
    const aCluster = sectorToCluster.get(link.a);
    const bCluster = sectorToCluster.get(link.b);
    if (!aPx || !bPx || !aCluster || !bCluster) continue;

    const sizeA = clusterSubSize.get(aCluster.id) || HEX_PIXEL_SIZE;
    const sizeB = clusterSubSize.get(bCluster.id) || HEX_PIXEL_SIZE;
    const shortened = shortenLinkEndpoints(
      aPx.x,
      aPx.y,
      bPx.x,
      bPx.y,
      sizeA * LINK_INSET_FACTOR,
      sizeB * LINK_INSET_FACTOR,
    );
    if (!shortened) continue;

    const control = linkCurveControl(
      shortened.x1,
      shortened.y1,
      shortened.x2,
      shortened.y2,
      link.a,
      link.b,
      link.type,
    );
    if (!control) continue;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.classList.add("link", link.type);
    if (link.oneWay) line.classList.add("one-way");
    line.dataset.a = link.a;
    line.dataset.b = link.b;
    line.setAttribute(
      "d",
      linkCurvePathD(
        shortened.x1,
        shortened.y1,
        shortened.x2,
        shortened.y2,
        control.cx,
        control.cy,
      ),
    );
    linksLayer.append(line);
    linkEls.push(line);
  }

  /**
   * @typedef {{
   *   cluster: Cluster,
   *   parentHex: SVGPolygonElement|null,
   *   sectorHexes: SVGPolygonElement[],
   *   sectorTexts: SVGTextElement[],
   *   sectorResourceDots: SVGGElement[],
   *   sectorStationIcons: SVGGElement[],
   * }} ClusterEls
   */
  /** @type {ClusterEls[]} */
  const clusterEls = [];

  for (const cluster of data.clusters) {
    const px = clusterPixels.get(cluster.id);
    if (!px) continue;

    const sectors = cluster.sectors;
    const multi = sectors.length > 1;
    const hexSize = clusterSubSize.get(cluster.id) || HEX_PIXEL_SIZE;
    /** @type {SVGPolygonElement|null} */
    let parentHex = null;

    if (multi) {
      parentHex = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polygon",
      );
      parentHex.setAttribute("points", flatTopHexPoints(px.x, px.y));
      parentHex.classList.add("hex", "parent");
      parentHex.dataset.clusterId = cluster.id;
      hexesLayer.append(parentHex);
    }

    /** @type {SVGPolygonElement[]} */
    const sectorHexes = [];
    /** @type {SVGTextElement[]} */
    const sectorTexts = [];
    /** @type {SVGGElement[]} */
    const sectorResourceDots = [];
    /** @type {SVGGElement[]} */
    const sectorStationIcons = [];

    for (const sector of sectors) {
      const sp = sectorPixels.get(sector.name) || px;
      const hex = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polygon",
      );
      hex.setAttribute("points", flatTopHexPoints(sp.x, sp.y, hexSize));
      hex.classList.add("hex");
      if (multi) hex.classList.add("sub");
      hex.dataset.clusterId = cluster.id;
      hex.dataset.name = sector.name;
      hex.dataset.dlc = packCode(sector.dlc);
      hexesLayer.append(hex);
      sectorHexes.push(hex);

      const resources = resourcesByName.get(sector.name) || {};
      const presentWares = presenceWares.filter((ware) => ware in resources);
      const dotsGroup = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "g",
      );
      dotsGroup.classList.add("resource-dots");
      dotsGroup.dataset.name = sector.name;
      const positions = layoutResourceDots(
        sp.x,
        sp.y,
        hexSize,
        presentWares,
      );
      presentWares.forEach((ware, i) => {
        const pos = positions[i];
        if (!pos) return;
        const circle = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        );
        circle.classList.add("resource-map-dot");
        circle.setAttribute("cx", String(pos.x));
        circle.setAttribute("cy", String(pos.y));
        circle.setAttribute("r", String(pos.r));
        circle.style.fill = resourceColor(ware);
        dotsGroup.append(circle);
      });
      resourceDotsLayer.append(dotsGroup);
      sectorResourceDots.push(dotsGroup);

      const facilities = stationsByName.get(sector.name) || [];
      const uniqueOwners = [
        ...new Set(facilities.map((f) => f.owner).filter(Boolean)),
      ];
      const multiOwner = uniqueOwners.length > 1;
      const iconsGroup = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "g",
      );
      iconsGroup.classList.add("station-icons");
      iconsGroup.dataset.name = sector.name;
      const icons = layoutStationIcons(
        sp.x,
        sp.y,
        hexSize,
        facilities.map((f) => f.category),
        { spreadForLabels: multiOwner },
      );
      for (const icon of icons) {
        iconsGroup.append(
          createStationIcon(icon.category, icon.x, icon.y, icon.size),
        );
      }
      if (uniqueOwners.length === 1) {
        iconsGroup.append(
          createFactionLabel(
            factionShortname(uniqueOwners[0], factionShortnames),
            sp.x,
            sp.y - hexSize * 0.48,
          ),
        );
      } else if (multiOwner) {
        facilities.forEach((facility, i) => {
          const icon = icons[i];
          if (!icon) return;
          iconsGroup.append(
            createFactionLabel(
              factionShortname(facility.owner, factionShortnames),
              icon.x,
              icon.y - icon.size * 1.75,
            ),
          );
        });
      }
      stationIconsLayer.append(iconsGroup);
      sectorStationIcons.push(iconsGroup);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(sp.x));
      text.setAttribute("y", String(sp.y));
      text.setAttribute("dominant-baseline", "middle");
      text.classList.add("sector-label");
      if (multi) text.classList.add("sub");
      text.dataset.dlc = packCode(sector.dlc);
      text.dataset.name = sector.name;
      text.textContent = sector.name;
      const color = packColor.get(packCode(sector.dlc));
      if (color) text.style.fill = color;
      labelsLayer.append(text);
      sectorTexts.push(text);
    }

    clusterEls.push({
      cluster,
      parentHex,
      sectorHexes,
      sectorTexts,
      sectorResourceDots,
      sectorStationIcons,
    });
  }

  /**
   * Whether a single sector's own resources satisfy current filters.
   * @param {SectorResources} resources
   */
  function sectorMeetsLocal(resources) {
    for (const ware of requiredResources) {
      if (!(ware in resources)) return false;
    }
    const sunlight = resources.sunlight;
    return typeof sunlight === "number" && sunlight >= sunlightThreshold;
  }

  /**
   * Whether the hub's travel neighborhood covers all required wares + sunlight.
   * @param {string} hubName
   * @param {number} budget
   * @param {Set<string>} allowedNodes
   */
  function neighborhoodCovers(hubName, budget, allowedNodes) {
    const dist = distancesFrom(hubName, travelGraph, allowedNodes);
    /** @type {Set<string>} */
    const covered = new Set();
    let hasSunlight = false;
    for (const [name, d] of dist) {
      if (d > budget) continue;
      const resources = resourcesByName.get(name) || {};
      for (const ware of requiredResources) {
        if (ware in resources) covered.add(ware);
      }
      const sunlight = resources.sunlight;
      if (typeof sunlight === "number" && sunlight >= sunlightThreshold) {
        hasSunlight = true;
      }
    }
    if (!hasSunlight) return false;
    for (const ware of requiredResources) {
      if (!covered.has(ware)) return false;
    }
    return true;
  }

  /** @type {Map<string, Sector>} */
  const sectorByName = new Map();
  for (const cluster of data.clusters) {
    for (const sector of cluster.sectors) {
      sectorByName.set(sector.name, sector);
    }
  }

  /** @type {Map<string, boolean>} */
  let dimByName = new Map();

  function rebuildDimCache() {
    /** @type {Map<string, boolean>} */
    const next = new Map();
    /** @type {Set<string>} */
    const allowedNodes = new Set();
    for (const sector of sectorByName.values()) {
      if (enabledDlc.has(packCode(sector.dlc))) {
        allowedNodes.add(sector.name);
      }
    }
    const step =
      RESOURCE_DISTANCE_STEPS[resourceDistanceIndex] ??
      RESOURCE_DISTANCE_STEPS[0];
    for (const sector of sectorByName.values()) {
      if (!allowedNodes.has(sector.name)) {
        next.set(sector.name, true);
        continue;
      }
      const ok = step.selfOnly
        ? sectorMeetsLocal(resourcesByName.get(sector.name) || {})
        : neighborhoodCovers(sector.name, step.budget, allowedNodes);
      next.set(sector.name, !ok);
    }
    dimByName = next;
  }

  /**
   * @param {Sector} sector
   */
  function sectorDimmed(sector) {
    return dimByName.get(sector.name) ?? true;
  }

  function applyDimming() {
    rebuildDimCache();
    for (const {
      cluster,
      parentHex,
      sectorHexes,
      sectorTexts,
      sectorResourceDots,
      sectorStationIcons,
    } of clusterEls) {
      let dimmedCount = 0;
      sectorTexts.forEach((text, i) => {
        const sector = cluster.sectors[i];
        const dim = sectorDimmed(sector);
        text.classList.toggle("dimmed", dim);
        sectorHexes[i]?.classList.toggle("dimmed", dim);
        sectorResourceDots[i]?.classList.toggle("dimmed", dim);
        sectorStationIcons[i]?.classList.toggle("dimmed", dim);
        if (dim) dimmedCount += 1;
      });
      const allDimmed =
        cluster.sectors.length > 0 && dimmedCount === cluster.sectors.length;
      parentHex?.classList.toggle("dimmed", allDimmed);
    }

    for (const line of linkEls) {
      const sectorA = sectorByName.get(line.dataset.a || "");
      const sectorB = sectorByName.get(line.dataset.b || "");
      const dimA = sectorA ? sectorDimmed(sectorA) : true;
      const dimB = sectorB ? sectorDimmed(sectorB) : true;
      line.classList.toggle("dimmed", dimA || dimB);
    }
  }

  applyDimming();
  setupViewport(svg, root, data.clusters);
}

/**
 * @param {SVGSVGElement} svg
 * @param {SVGGElement} world
 * @param {Cluster[]} clusters
 */
function setupViewport(svg, world, clusters) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cluster of clusters) {
    const px = axialToPixel(cluster.q, cluster.r);
    minX = Math.min(minX, px.x);
    maxX = Math.max(maxX, px.x);
    minY = Math.min(minY, px.y);
    maxY = Math.max(maxY, px.y);
  }
  const pad = HEX_PIXEL_SIZE * 2.5;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;

  let view = {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };

  function applyView() {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  }
  applyView();

  const stage = svg.parentElement;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let pinchDistance = 0;
  let touchPanning = false;

  function clientToSvg(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const local = pt.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  }

  function zoomAt(clientX, clientY, factor) {
    const anchor = clientToSvg(clientX, clientY);
    const fx = (anchor.x - view.x) / view.w;
    const fy = (anchor.y - view.y) / view.h;
    const newW = view.w * factor;
    const newH = view.h * factor;
    view.x = anchor.x - fx * newW;
    view.y = anchor.y - fy * newH;
    view.w = newW;
    view.h = newH;
    applyView();
  }

  function touchDistance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function stopPan() {
    dragging = false;
    touchPanning = false;
    stage?.classList.remove("dragging");
  }

  function panByClientDelta(clientX, clientY) {
    const prev = clientToSvg(lastX, lastY);
    const next = clientToSvg(clientX, clientY);
    view.x -= next.x - prev.x;
    view.y -= next.y - prev.y;
    lastX = clientX;
    lastY = clientY;
    applyView();
  }

  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 0.9 : 1.1;
      zoomAt(event.clientX, event.clientY, factor);
    },
    { passive: false },
  );

  // Mouse/pen only — touch is handled via Touch Events for Firefox multi-touch.
  svg.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return;
    if (event.button !== 0) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    svg.setPointerCapture(event.pointerId);
    stage?.classList.add("dragging");
  });

  svg.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    if (!dragging) return;
    panByClientDelta(event.clientX, event.clientY);
  });

  function endPointer(event) {
    if (event.pointerType === "touch") return;
    if (!dragging) return;
    stopPan();
    try {
      svg.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  }

  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);

  svg.addEventListener(
    "touchstart",
    (event) => {
      event.preventDefault();
      const touches = event.touches;
      if (touches.length === 2) {
        stopPan();
        pinchDistance = touchDistance(touches[0], touches[1]);
        return;
      }
      if (touches.length !== 1) {
        stopPan();
        pinchDistance = 0;
        return;
      }
      touchPanning = true;
      lastX = touches[0].clientX;
      lastY = touches[0].clientY;
      stage?.classList.add("dragging");
    },
    { passive: false },
  );

  svg.addEventListener(
    "touchmove",
    (event) => {
      event.preventDefault();
      const touches = event.touches;
      if (touches.length === 2) {
        const distance = touchDistance(touches[0], touches[1]);
        if (pinchDistance > 0 && distance > 0) {
          const factor = pinchDistance / distance;
          zoomAt(
            (touches[0].clientX + touches[1].clientX) / 2,
            (touches[0].clientY + touches[1].clientY) / 2,
            factor,
          );
        }
        pinchDistance = distance;
        return;
      }
      if (!touchPanning || touches.length !== 1) return;
      panByClientDelta(touches[0].clientX, touches[0].clientY);
    },
    { passive: false },
  );

  function endTouch(event) {
    event.preventDefault();
    pinchDistance = 0;
    // Do not auto-resume pan if a finger remains after pinch/lift.
    stopPan();
  }

  svg.addEventListener("touchend", endTouch, { passive: false });
  svg.addEventListener("touchcancel", endTouch, { passive: false });

  // Keep unused param referenced for future transforms.
  void world;
}

async function main() {
  const [mapResponse, resourcesResponse, stationsResponse] = await Promise.all([
    fetch("map/map_data.json"),
    fetch("map/sector_resources.json"),
    fetch("map/sector_stations.json"),
  ]);
  if (!mapResponse.ok) {
    throw new Error(`Failed to load map_data.json (${mapResponse.status})`);
  }
  if (!resourcesResponse.ok) {
    throw new Error(
      `Failed to load sector_resources.json (${resourcesResponse.status})`,
    );
  }
  if (!stationsResponse.ok) {
    throw new Error(
      `Failed to load sector_stations.json (${stationsResponse.status})`,
    );
  }
  /** @type {MapData} */
  const data = await mapResponse.json();
  /** @type {SectorResourcesData} */
  const resourcesData = await resourcesResponse.json();
  /** @type {SectorStationsData} */
  const stationsData = await stationsResponse.json();
  renderMap(data, resourcesData, stationsData);
}

main().catch((err) => {
  console.error(err);
  const stage = document.querySelector(".map-stage");
  if (stage) {
    stage.textContent = `Failed to load map: ${err.message}`;
  }
});
