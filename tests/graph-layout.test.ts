import { test } from "node:test";
import assert from "node:assert/strict";
import { layeredLayout, type LayoutEdge } from "../src/graph-layout.ts";

type Rect = { x: number; y: number; width: number; height: number };

function toRect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

test("empty input returns an empty layout", () => {
  assert.deepEqual(layeredLayout([], []), {});
  assert.deepEqual(layeredLayout([], [{ source: "a", target: "b" }]), {});
});

test("a single node sits at the origin", () => {
  assert.deepEqual(layeredLayout(["a"], []), { a: { x: 0, y: 0 } });
});

test("a chain lays out top to bottom with a shared centered x", () => {
  const layout = layeredLayout(
    ["a", "b", "c"],
    [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ],
  );
  assert.deepEqual(layout, {
    a: { x: 0, y: 0 },
    b: { x: 0, y: 96 },
    c: { x: 0, y: 192 },
  });
  assert.equal(layout.a.x, layout.b.x);
  assert.equal(layout.b.x, layout.c.x);
  assert.ok(layout.a.y < layout.b.y && layout.b.y < layout.c.y);
});

test("a layer of 3 nodes with maxColumns 2 splits into 2 non-overlapping rows", () => {
  const layout = layeredLayout(["a", "b", "c"], []);
  assert.deepEqual(layout, {
    a: { x: 0, y: 0 },
    b: { x: 204, y: 0 },
    c: { x: 102, y: 96 },
  });
  assert.equal(layout.a.y, layout.b.y);
  assert.ok(layout.c.y > layout.a.y);

  const entries = Object.entries(layout);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = toRect(entries[i][1].x, entries[i][1].y, 180, 56);
      const b = toRect(entries[j][1].x, entries[j][1].y, 180, 56);
      assert.ok(!overlaps(a, b), `${entries[i][0]} overlaps ${entries[j][0]}`);
    }
  }
});

test("a cycle terminates and gives every node a position", () => {
  const layout = layeredLayout(
    ["a", "b"],
    [
      { source: "a", target: "b" },
      { source: "b", target: "a" },
    ],
  );
  assert.deepEqual(Object.keys(layout).sort(), ["a", "b"]);
  for (const point of Object.values(layout)) {
    assert.equal(typeof point.x, "number");
    assert.equal(typeof point.y, "number");
  }
});

test("edges referencing unknown ids are ignored", () => {
  const layout = layeredLayout(
    ["a"],
    [
      { source: "a", target: "z" },
      { source: "z", target: "a" },
    ],
  );
  assert.deepEqual(layout, { a: { x: 0, y: 0 } });
  assert.ok(!("z" in layout));
});

test("self loops are ignored", () => {
  const layout = layeredLayout(
    ["a", "b"],
    [
      { source: "a", target: "a" },
      { source: "a", target: "b" },
    ],
  );
  assert.deepEqual(layout, {
    a: { x: 0, y: 0 },
    b: { x: 0, y: 96 },
  });
});

test("duplicate ids and edges do not change the result", () => {
  const edges: LayoutEdge[] = [
    { source: "a", target: "b" },
    { source: "a", target: "b" },
  ];
  assert.deepEqual(
    layeredLayout(["a", "a", "b"], edges),
    layeredLayout(["a", "b"], [{ source: "a", target: "b" }]),
  );
});

test("layout is deterministic for the same input", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const edges: LayoutEdge[] = [
    { source: "a", target: "b" },
    { source: "a", target: "c" },
    { source: "b", target: "d" },
    { source: "c", target: "e" },
  ];
  const first = layeredLayout(ids, edges);
  const second = layeredLayout(ids, edges);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("a fixed 20-node sample graph has no overlapping node boxes", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `n${i}`);
  const edges: LayoutEdge[] = [];
  const connect = (from: string, targets: string[]) => {
    for (const target of targets) edges.push({ source: from, target });
  };
  connect("n0", ["n1", "n2", "n3"]);
  connect("n1", ["n4", "n5"]);
  connect("n2", ["n6", "n7"]);
  connect("n3", ["n8", "n9"]);
  connect("n4", ["n10", "n11"]);
  connect("n5", ["n12", "n13"]);
  connect("n6", ["n14", "n15"]);
  connect("n7", ["n16", "n17"]);
  connect("n8", ["n18", "n19"]);

  const layout = layeredLayout(ids, edges);
  assert.equal(Object.keys(layout).length, 20);

  const boxes = ids.map((id) => {
    const point = layout[id];
    return toRect(point.x, point.y, 180, 56);
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(
        !overlaps(boxes[i], boxes[j]),
        `node ${ids[i]} overlaps node ${ids[j]}`,
      );
    }
  }
});

test("options change spacing between nodes", () => {
  const ids = ["a", "b"];
  const byDefault = layeredLayout(ids, []);
  assert.equal(byDefault.b.x, 204);

  const wider = layeredLayout(ids, [], { nodeWidth: 100 });
  assert.equal(wider.b.x, 124);
  assert.ok(wider.b.x < byDefault.b.x);

  const gapped = layeredLayout(ids, [], { xGap: 10 });
  assert.equal(gapped.b.x, 190);

  const longer = layeredLayout(["a", "b"], [{ source: "a", target: "b" }], {
    nodeHeight: 30,
    yGap: 10,
  });
  assert.equal(longer.b.y, 40);
});

test("maxColumns below 1 is treated as 1", () => {
  const layout = layeredLayout(["a", "b"], [], { maxColumns: 0 });
  assert.deepEqual(layout, {
    a: { x: 0, y: 0 },
    b: { x: 0, y: 96 },
  });
});
