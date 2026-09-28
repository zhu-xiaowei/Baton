export const LANE_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f778ba', '#a371f7', '#39c5cf', '#ff7b72', '#e3b341'];

export function createGraphLayout() {
  return { lanes: [], nextColor: 0 };
}

function allocate(lanes, lane) {
  var index = lanes.indexOf(null);
  if (index < 0) index = lanes.push(lane) - 1;
  else lanes[index] = lane;
  return index;
}

// Incremental lane layout over topo-ordered commits; `layout` carries lanes across pages.
export function layoutCommits(layout, commits) {
  return commits.map(function (commit) {
    var before = layout.lanes;
    var col = before.findIndex(function (lane) { return lane?.oid === commit.oid; });
    var lanes = before.slice();
    var color;
    if (col < 0) {
      color = layout.nextColor++ % LANE_COLORS.length;
      col = allocate(lanes, { oid: commit.oid, color: color });
    } else {
      color = before[col].color;
    }
    var converging = [];
    lanes.forEach(function (lane, index) {
      if (lane?.oid === commit.oid) {
        if (index !== col) converging.push({ from: index, color: lane.color });
        lanes[index] = null;
      }
    });
    var parents = commit.parents || [];
    var parentEdges = [];
    if (parents[0]) {
      var waiting = lanes.findIndex(function (lane) { return lane?.oid === parents[0]; });
      if (waiting < 0) {
        lanes[col] = { oid: parents[0], color: color };
        waiting = col;
      }
      parentEdges.push(waiting);
    }
    for (var index = 1; index < parents.length; index++) {
      var existing = lanes.findIndex(function (lane) { return lane?.oid === parents[index]; });
      if (existing < 0) {
        existing = allocate(lanes, { oid: parents[index], color: layout.nextColor++ % LANE_COLORS.length });
      }
      parentEdges.push(existing);
    }
    var mapping = [];
    var compacted = [];
    lanes.forEach(function (lane, index) {
      if (lane) mapping[index] = compacted.push(lane) - 1;
    });
    layout.lanes = compacted;
    var through = [];
    before.forEach(function (lane, index) {
      if (lane && lane.oid !== commit.oid) {
        through.push({ from: index, to: mapping[index], color: lane.color });
      }
    });
    var bottom = parentEdges.map(function (index) {
      return { to: mapping[index], color: lanes[index].color };
    });
    var width = Math.max(before.length, compacted.length, col + 1);
    return {
      commit: commit,
      col: col,
      color: color,
      hasTop: before[col]?.oid === commit.oid,
      converging: converging,
      through: through,
      bottom: bottom,
      after: compacted.map(function (lane) { return lane.color; }),
      width: width,
    };
  });
}
