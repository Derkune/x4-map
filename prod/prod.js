/** @typedef {{ id: string, name: string, kind: "ware" | "sink", group: string, column: string, ware?: string, method?: string, members?: string[], memberNames?: string[] }} ChartNode */
/** @typedef {{ from: string, to: string }} ChartEdge */
/** @typedef {{ version: string, nodes: ChartNode[], edges: ChartEdge[] }} ChartData */

const SVG_NS = "http://www.w3.org/2000/svg";
const COLUMN_RANK = {
  resources: 0,
  refined: 1,
  agriculture: 1,
  hightech: 2,
  hab: 2,
  shiptech: 3,
  sink: 4,
};
/** Horizontal gap between column centers beyond the uniform node width. */
const COLUMN_GAP_PAD = 48;
const NODE_GAP = 16;
/** Extra vertical space between different category blocks in a column. */
const CATEGORY_GAP = 28;
const NODE_HEIGHT = 28;
const NODE_WIDTH_CHAR = 7.4;
const NODE_WIDTH_PAD = 22;
const NODE_WIDTH_MIN = 88;
const REL_UPSTREAM = "#e8923a";
const REL_DOWNSTREAM = "#7ec8e8";
const REL_MUTED = "#8b9bb3";
const REL_MUTE_SPAN = 2;
const REL_HOT_OPACITY = 0.95;
const REL_MUTED_OPACITY = 0.22;

/**
 * Natural width for a label; layout uses the max across all nodes so boxes match.
 * @param {string} name
 */
function measureNodeWidth(name) {
  return Math.max(NODE_WIDTH_MIN, name.length * NODE_WIDTH_CHAR + NODE_WIDTH_PAD);
}

/**
 * @param {ChartNode[]} nodes
 * @param {ChartEdge[]} edges
 */
function layoutGraph(nodes, edges) {
  const dagreLib = globalThis.dagre;
  if (!dagreLib) {
    throw new Error("dagre failed to load");
  }
  let uniformWidth = NODE_WIDTH_MIN;
  for (const node of nodes) {
    uniformWidth = Math.max(uniformWidth, measureNodeWidth(node.name));
  }
  const columnGap = uniformWidth + COLUMN_GAP_PAD;
  const g = new dagreLib.graphlib.Graph({ directed: true });
  g.setGraph({
    rankdir: "LR",
    nodesep: 18,
    ranksep: 70,
    edgesep: 10,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, {
      width: uniformWidth,
      height: NODE_HEIGHT,
      column: node.column,
    });
  }
  for (const edge of edges) {
    if (g.hasNode(edge.from) && g.hasNode(edge.to)) {
      g.setEdge(edge.from, edge.to);
    }
  }
  dagreLib.layout(g);

  const placed = new Map();
  for (const node of nodes) {
    const layout = g.node(node.id);
    const rank = COLUMN_RANK[node.column] ?? 2;
    placed.set(node.id, {
      ...node,
      width: uniformWidth,
      height: NODE_HEIGHT,
      x: rank * columnGap,
      y: layout.y,
      rank,
    });
  }

  const byRank = new Map();
  for (const placedNode of placed.values()) {
    const list = byRank.get(placedNode.rank) || [];
    list.push(placedNode);
    byRank.set(placedNode.rank, list);
  }
  for (const list of byRank.values()) {
    packColumnByCategory(list, columnGap);
  }
  return placed;
}

/**
 * Category key used to keep related nodes contiguous within a column.
 * Shared visual ranks (refined/agriculture, hightech/hab) split on column
 * first; sinks and multi-group columns split on group/family.
 * @param {{ column: string, group: string }} node
 */
function categoryKey(node) {
  return `${node.column}\0${node.group || ""}`;
}

/**
 * Recipe variants of one ware share `ware`; plain wares and sinks use `id`.
 * @param {{ id: string, ware?: string }} node
 */
function wareClusterKey(node) {
  return node.ware || node.id;
}

/**
 * @param {Array<{ y: number, name: string }>} nodes
 */
function medianY(nodes) {
  const mid = nodes[Math.floor(nodes.length / 2)];
  return mid.y;
}

/**
 * Pack a column so categories stay contiguous, and within a category recipe
 * variants of the same ware stay contiguous. Block order follows dagre's
 * median Y (rough flow preserved).
 * @param {Array<{ x: number, y: number, rank: number, width: number, height: number, column: string, group: string, name: string, id: string, ware?: string }>} list
 * @param {number} columnGap
 */
function packColumnByCategory(list, columnGap) {
  /** @type {Map<string, typeof list>} */
  const categories = new Map();
  for (const node of list) {
    const key = categoryKey(node);
    const block = categories.get(key) || [];
    block.push(node);
    categories.set(key, block);
  }

  /** @type {{ key: string, medianY: number, clusters: typeof list[] }[]} */
  const orderedCategories = [];
  for (const [key, nodes] of categories) {
    /** @type {Map<string, typeof list>} */
    const byWare = new Map();
    for (const node of nodes) {
      const wareKey = wareClusterKey(node);
      const cluster = byWare.get(wareKey) || [];
      cluster.push(node);
      byWare.set(wareKey, cluster);
    }

    /** @type {{ key: string, medianY: number, nodes: typeof list }[]} */
    const clusters = [];
    for (const [wareKey, cluster] of byWare) {
      cluster.sort((a, b) => a.y - b.y || a.name.localeCompare(b.name));
      clusters.push({ key: wareKey, medianY: medianY(cluster), nodes: cluster });
    }
    clusters.sort((a, b) => a.medianY - b.medianY || a.key.localeCompare(b.key));

    const flat = clusters.flatMap((c) => c.nodes);
    orderedCategories.push({
      key,
      medianY: medianY(flat),
      clusters: clusters.map((c) => c.nodes),
    });
  }
  orderedCategories.sort(
    (a, b) => a.medianY - b.medianY || a.key.localeCompare(b.key),
  );

  let y = 0;
  for (let i = 0; i < orderedCategories.length; i++) {
    if (i > 0) y += CATEGORY_GAP;
    for (const cluster of orderedCategories[i].clusters) {
      for (const placedNode of cluster) {
        placedNode.x = placedNode.rank * columnGap;
        placedNode.y = y + placedNode.height / 2;
        y += placedNode.height + NODE_GAP;
      }
    }
  }
}

/**
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 */
function edgePath(x1, y1, x2, y2) {
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

/**
 * @param {SVGElement} parent
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 */
function svgEl(parent, tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  parent.appendChild(el);
  return el;
}

/**
 * Shortest hop distances along adj from start (start = 0).
 * @param {Map<string, string[]>} adj
 * @param {string} start
 * @returns {Map<string, number>}
 */
function distancesFrom(adj, start) {
  /** @type {Map<string, number>} */
  const dist = new Map();
  dist.set(start, 0);
  const queue = [start];
  let i = 0;
  while (i < queue.length) {
    const id = queue[i++];
    const d = dist.get(id) ?? 0;
    for (const next of adj.get(id) || []) {
      if (dist.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  return dist;
}

/**
 * @param {string} hex
 * @returns {[number, number, number]}
 */
function hexRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * @param {string} from
 * @param {string} to
 * @param {number} t
 */
function lerpHex(from, to, t) {
  const a = hexRgb(from);
  const b = hexRgb(to);
  const mix = (i) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `#${[mix(0), mix(1), mix(2)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * 0 at degree 1; 1 (fully muted) by degree 3+.
 * @param {number} degree
 */
function relatedMute(degree) {
  return Math.min(1, Math.max(0, (degree - 1) / REL_MUTE_SPAN));
}

/**
 * Full related color at degree 1; fully muted by degree 3+.
 * @param {string} base
 * @param {number} degree
 */
function relatedStroke(base, degree) {
  return lerpHex(base, REL_MUTED, relatedMute(degree));
}

/**
 * @param {number} degree
 */
function relatedOpacity(degree) {
  const t = relatedMute(degree);
  return REL_HOT_OPACITY + (REL_MUTED_OPACITY - REL_HOT_OPACITY) * t;
}

/**
 * @param {ChartData} data
 */
function renderChart(data) {
  const svg = document.querySelector("#chart");
  const clearBtn = document.querySelector("#clear-selection");
  const emptyEl = document.querySelector("#selection-empty");
  const detailEl = document.querySelector("#selection-detail");
  const nameEl = document.querySelector("#selection-name");
  const metaEl = document.querySelector("#selection-meta");
  const countsEl = document.querySelector("#selection-counts");
  const membersEl = document.querySelector("#selection-members");
  if (
    !(svg instanceof SVGSVGElement) ||
    !(clearBtn instanceof HTMLButtonElement) ||
    !(emptyEl instanceof HTMLElement) ||
    !(detailEl instanceof HTMLElement) ||
    !(nameEl instanceof HTMLElement) ||
    !(metaEl instanceof HTMLElement) ||
    !(countsEl instanceof HTMLElement) ||
    !(membersEl instanceof HTMLElement)
  ) {
    throw new Error("Production chart markup is missing");
  }

  const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
  const producers = new Map();
  const consumers = new Map();
  for (const edge of data.edges) {
    const ins = producers.get(edge.to) || [];
    ins.push(edge.from);
    producers.set(edge.to, ins);
    const outs = consumers.get(edge.from) || [];
    outs.push(edge.to);
    consumers.set(edge.from, outs);
  }

  const placed = layoutGraph(data.nodes, data.edges);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of placed.values()) {
    minX = Math.min(minX, node.x - node.width / 2);
    minY = Math.min(minY, node.y - node.height / 2);
    maxX = Math.max(maxX, node.x + node.width / 2);
    maxY = Math.max(maxY, node.y + node.height / 2);
  }
  const pad = 48;
  const world = {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };

  svg.replaceChildren();
  const defs = svgEl(svg, "defs");
  const marker = svgEl(defs, "marker", {
    id: "arrow",
    viewBox: "0 0 10 10",
    refX: 9,
    refY: 5,
    markerWidth: 6,
    markerHeight: 6,
    orient: "auto-start-reverse",
  });
  svgEl(marker, "path", { d: "M 0 0 L 10 5 L 0 10 z", fill: REL_MUTED });
  /** @type {Map<string, string>} */
  const relatedMarkerIds = new Map();
  let relatedMarkerSeq = 0;

  /**
   * @param {string} color
   */
  function markerFor(color) {
    const cached = relatedMarkerIds.get(color);
    if (cached) return cached;
    const id = `arrow-rel-${relatedMarkerSeq++}`;
    const relatedMarker = svgEl(defs, "marker", {
      id,
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: "auto-start-reverse",
    });
    svgEl(relatedMarker, "path", {
      d: "M 0 0 L 10 5 L 0 10 z",
      fill: color,
    });
    relatedMarkerIds.set(color, id);
    return id;
  }

  const root = svgEl(svg, "g", { class: "chart-root" });
  const edgeLayer = svgEl(root, "g", { class: "edges" });
  const nodeLayer = svgEl(root, "g", { class: "nodes" });

  /** @type {Map<string, SVGPathElement>} */
  const edgeEls = new Map();
  for (const edge of data.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + from.width / 2;
    const y1 = from.y;
    const x2 = to.x - to.width / 2;
    const y2 = to.y;
    const path = svgEl(edgeLayer, "path", {
      class: "edge",
      d: edgePath(x1, y1, x2, y2),
      "marker-end": "url(#arrow)",
    });
    if (path instanceof SVGPathElement) {
      edgeEls.set(`${edge.from}\t${edge.to}`, path);
    }
  }

  /** @type {Map<string, SVGGElement>} */
  const nodeEls = new Map();
  for (const node of placed.values()) {
    const group = svgEl(nodeLayer, "g", {
      class: `node col-${node.column}`,
      "data-id": node.id,
      transform: `translate(${node.x}, ${node.y})`,
    });
    const rx = node.kind === "sink" ? 4 : 12;
    svgEl(group, "rect", {
      class: "node-shape",
      x: -node.width / 2,
      y: -node.height / 2,
      width: node.width,
      height: node.height,
      rx,
      ry: rx,
    });
    const label = svgEl(group, "text", { class: "node-label" });
    label.textContent = node.name;
    if (group instanceof SVGGElement) {
      nodeEls.set(node.id, group);
    }
  }

  function clearHighlight() {
    root.classList.remove("is-filtered");
    for (const el of nodeEls.values()) {
      el.classList.remove("is-hot", "is-selected", "is-upstream", "is-downstream");
    }
    for (const el of edgeEls.values()) {
      el.classList.remove("is-hot", "is-upstream", "is-downstream");
      el.style.removeProperty("stroke");
      el.style.removeProperty("opacity");
      el.setAttribute("marker-end", "url(#arrow)");
    }
    clearBtn.disabled = true;
    emptyEl.hidden = false;
    detailEl.hidden = true;
    membersEl.hidden = true;
    membersEl.replaceChildren();
  }

  /**
   * @param {string} id
   */
  function selectNode(id) {
    const node = nodesById.get(id);
    if (!node) return;
    const upDist = distancesFrom(producers, id);
    const downDist = distancesFrom(consumers, id);
    const hotNodes = new Set([...upDist.keys(), ...downDist.keys()]);

    root.classList.add("is-filtered");
    for (const [nodeId, el] of nodeEls) {
      const isUpstream = upDist.has(nodeId) && nodeId !== id;
      const isDownstream =
        downDist.has(nodeId) && nodeId !== id && !isUpstream;
      el.classList.toggle("is-hot", hotNodes.has(nodeId));
      el.classList.toggle("is-selected", nodeId === id);
      el.classList.toggle("is-upstream", isUpstream);
      el.classList.toggle("is-downstream", isDownstream);
    }
    for (const [key, el] of edgeEls) {
      const [from, to] = key.split("\t");
      const upFrom = upDist.get(from);
      const upTo = upDist.get(to);
      const downFrom = downDist.get(from);
      const downTo = downDist.get(to);
      const upstream = upFrom !== undefined && upTo !== undefined;
      const downstream = downFrom !== undefined && downTo !== undefined;
      // Prefer upstream when an edge sits on both sides of the selection.
      const dir = upstream ? "upstream" : downstream ? "downstream" : null;
      el.classList.toggle("is-hot", Boolean(dir));
      el.classList.toggle("is-upstream", dir === "upstream");
      el.classList.toggle("is-downstream", dir === "downstream");
      if (!dir) {
        el.style.removeProperty("stroke");
        el.style.removeProperty("opacity");
        el.setAttribute("marker-end", "url(#arrow)");
        continue;
      }
      const degree =
        dir === "upstream"
          ? Math.max(upFrom ?? 0, upTo ?? 0)
          : Math.max(downFrom ?? 0, downTo ?? 0);
      const color = relatedStroke(
        dir === "upstream" ? REL_UPSTREAM : REL_DOWNSTREAM,
        degree,
      );
      el.style.stroke = color;
      el.style.opacity = String(relatedOpacity(degree));
      el.setAttribute("marker-end", `url(#${markerFor(color)})`);
    }

    clearBtn.disabled = false;
    emptyEl.hidden = true;
    detailEl.hidden = false;
    nameEl.textContent = node.name;
    const kindLabel = node.kind === "sink" ? "Category" : "Ware";
    const groupLabel = node.group || node.column;
    metaEl.textContent = `${kindLabel} · ${groupLabel}`;
    const up = Math.max(0, upDist.size - 1);
    const down = Math.max(0, downDist.size - 1);
    countsEl.textContent = `${up} upstream · ${down} downstream`;

    membersEl.replaceChildren();
    if (node.kind === "sink" && node.members?.length) {
      membersEl.hidden = false;
      const names = node.memberNames || node.members;
      const cap = 80;
      const shown = names.slice(0, cap);
      for (const label of shown) {
        const li = document.createElement("li");
        li.textContent = label;
        membersEl.appendChild(li);
      }
      if (names.length > cap) {
        const li = document.createElement("li");
        li.textContent = `…and ${names.length - cap} more`;
        membersEl.appendChild(li);
      }
    } else {
      membersEl.hidden = true;
    }
  }

  clearBtn.addEventListener("click", () => clearHighlight());

  const view = { x: world.x, y: world.y, w: world.w, h: world.h };
  function applyView() {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  }
  applyView();

  const stage = svg.parentElement;
  let dragging = false;
  let panning = false;
  let lastX = 0;
  let lastY = 0;
  let pinchDistance = 0;
  let touchActive = false;
  let touchPanning = false;
  const DRAG_THRESHOLD = 5;

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @returns {string | null}
   */
  function nodeIdAt(clientX, clientY) {
    const hit = document.elementFromPoint(clientX, clientY);
    if (!(hit instanceof Element)) return null;
    const group = hit.closest("[data-id]");
    return group?.getAttribute("data-id") ?? null;
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   */
  function selectOrClearAt(clientX, clientY) {
    const id = nodeIdAt(clientX, clientY);
    if (id) {
      selectNode(id);
      return;
    }
    clearHighlight();
  }

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
    view.w *= factor;
    view.h *= factor;
    view.x = anchor.x - fx * view.w;
    view.y = anchor.y - fy * view.h;
    applyView();
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
      zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 0.9 : 1.1);
    },
    { passive: false },
  );

  svg.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return;
    if (event.button !== 0) return;
    dragging = true;
    panning = false;
    lastX = event.clientX;
    lastY = event.clientY;
  });

  svg.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    if (!dragging) return;
    const dist = Math.hypot(event.clientX - lastX, event.clientY - lastY);
    if (!panning) {
      if (dist < DRAG_THRESHOLD) return;
      panning = true;
      svg.setPointerCapture(event.pointerId);
      stage?.classList.add("dragging");
    }
    panByClientDelta(event.clientX, event.clientY);
  });

  function endPointer(event) {
    if (event.pointerType === "touch") return;
    if (!dragging) return;
    const wasPanning = panning;
    dragging = false;
    panning = false;
    stage?.classList.remove("dragging");
    try {
      svg.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    if (!wasPanning) {
      selectOrClearAt(event.clientX, event.clientY);
    }
  }

  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);

  function touchDistance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function stopPan() {
    dragging = false;
    touchActive = false;
    touchPanning = false;
    stage?.classList.remove("dragging");
  }

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
      touchActive = true;
      touchPanning = false;
      lastX = touches[0].clientX;
      lastY = touches[0].clientY;
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
          zoomAt(
            (touches[0].clientX + touches[1].clientX) / 2,
            (touches[0].clientY + touches[1].clientY) / 2,
            pinchDistance / distance,
          );
        }
        pinchDistance = distance;
        return;
      }
      if (!touchActive || touches.length !== 1) return;
      const dist = Math.hypot(touches[0].clientX - lastX, touches[0].clientY - lastY);
      if (!touchPanning) {
        if (dist < DRAG_THRESHOLD) return;
        touchPanning = true;
        stage?.classList.add("dragging");
      }
      panByClientDelta(touches[0].clientX, touches[0].clientY);
    },
    { passive: false },
  );

  function endTouch(event) {
    event.preventDefault();
    const wasActive = touchActive;
    const wasPanning = touchPanning;
    const wasPinching = pinchDistance > 0;
    pinchDistance = 0;
    stopPan();
    if (event.type !== "touchend" || !wasActive || wasPanning || wasPinching) return;
    const touch = event.changedTouches[0];
    if (touch) selectOrClearAt(touch.clientX, touch.clientY);
  }
  svg.addEventListener("touchend", endTouch, { passive: false });
  svg.addEventListener("touchcancel", endTouch, { passive: false });
}

async function main() {
  const response = await fetch("prod/production_data.json");
  if (!response.ok) {
    throw new Error(`Failed to load production_data.json (${response.status})`);
  }
  /** @type {ChartData} */
  const data = await response.json();
  renderChart(data);
}

main().catch((err) => {
  console.error(err);
  const stage = document.querySelector(".map-stage");
  if (stage) {
    stage.textContent = `Failed to load production chart: ${err.message}`;
  }
});
