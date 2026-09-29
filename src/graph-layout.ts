export type LayoutEdge = { source: string; target: string };
export type LayoutOptions = {
  nodeWidth?: number;
  nodeHeight?: number;
  xGap?: number;
  yGap?: number;
  maxColumns?: number;
};

/**
 * 파일 import 그래프를 위(source)에서 아래(target)로 흐르는 계층 레이아웃으로
 * 배치한다. React에 의존하지 않는 순수 함수다.
 *
 * - ids는 첫 등장 순서를 유지한 채 중복을 제거한다.
 * - source·target이 모두 ids에 있고 source !== target인 엣지만 사용한다.
 * - depth는 target = max(target, source + 1)을 최대 ids.length번 반복해 구하므로
 *   사이클이 있어도 반복 상한으로 종료된다.
 * - 같은 depth의 노드는 ids 순서를 유지하며, maxColumns개씩 끊어 행으로 만든다.
 *   짧은 행은 전체 열 수 기준으로 가운데 정렬한다.
 */
export function layeredLayout(
  ids: string[],
  edges: LayoutEdge[],
  options?: LayoutOptions,
): Record<string, { x: number; y: number }> {
  const nodeWidth = options?.nodeWidth ?? 180;
  const nodeHeight = options?.nodeHeight ?? 56;
  const xGap = options?.xGap ?? 24;
  const yGap = options?.yGap ?? 40;
  const rawMaxColumns = options?.maxColumns;
  const maxColumns =
    typeof rawMaxColumns === "number" && Number.isFinite(rawMaxColumns)
      ? Math.max(1, Math.floor(rawMaxColumns))
      : 2;

  // 1) ids 중복 제거(첫 등장 순서 유지) + 사용할 엣지 정규화.
  const unique: string[] = [];
  const known = new Set<string>();
  for (const id of ids) {
    if (!known.has(id)) {
      known.add(id);
      unique.push(id);
    }
  }

  if (unique.length === 0) return {};

  const seenEdges = new Set<string>();
  const validEdges: LayoutEdge[] = [];
  for (const edge of edges) {
    const { source, target } = edge;
    if (source === target) continue;
    if (!known.has(source) || !known.has(target)) continue;
    const key = `${source}\u0000${target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    validEdges.push({ source, target });
  }

  // 2) depth 계산: 변화가 없거나 ids.length번 반복하면 종료.
  const depth = new Map<string, number>();
  for (const id of unique) depth.set(id, 0);
  for (let i = 0; i < unique.length; i++) {
    let changed = false;
    for (const { source, target } of validEdges) {
      const candidate = (depth.get(source) as number) + 1;
      if (candidate > (depth.get(target) as number)) {
        depth.set(target, candidate);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const id of unique) {
    depth.set(id, Math.min(depth.get(id) as number, unique.length - 1));
  }

  // 3) depth 오름차순 층 구성(층 안은 ids 순서).
  const layers: string[][] = [];
  for (const id of unique) {
    const level = depth.get(id) as number;
    const layer = layers[level];
    if (layer) layer.push(id);
    else layers[level] = [id];
  }

  // 4) 층을 maxColumns개씩 끊어 위에서 아래로 쌓이는 행으로 만든다.
  const rows: string[][] = [];
  for (const layer of layers) {
    if (!layer || layer.length === 0) continue;
    for (let i = 0; i < layer.length; i += maxColumns) {
      rows.push(layer.slice(i, i + maxColumns));
    }
  }

  // 5) 전체 열 수 = 가장 긴 행의 노드 수(단, maxColumns 이하).
  const longestRow = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const columns = Math.min(maxColumns, longestRow);

  const result: Record<string, { x: number; y: number }> = {};
  rows.forEach((row, rowIndex) => {
    const count = row.length;
    const y = rowIndex * (nodeHeight + yGap);
    row.forEach((id, columnIndex) => {
      const x =
        ((columns - count) * (nodeWidth + xGap)) / 2 +
        columnIndex * (nodeWidth + xGap);
      result[id] = { x, y };
    });
  });

  return result;
}
