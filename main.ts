/**
 * main.ts — Sokoban solver untuk bounty make.fun "Build the best Sokoban solver"
 * (https://make.fun/bounty/sokoban-solver-01-run-20261121, hadiah $100).
 *
 * Dijalankan sebagai:  node /bot/main.ts
 *   Node 22, JavaScript/TypeScript saja, TANPA dependency, TANPA install.
 *   Input : /input/<id>/level.txt  (format XSB)
 *   Output: /output/<id>/solution.txt (UTF-8, huruf L/U/R/D; huruf kecil = push)
 *
 * Batasan grader: 60 detik untuk keseluruhan set, 1 CPU, 512 MB RAM,
 * tanpa network, HARUS deterministik (dua run -> byte identik).
 * Program ini selalu menulis solution.txt untuk SEMUA instance (kosong
 * kalau tidak ketemu solusi) supaya format selalu terpenuhi.
 *
 * Algoritma:
 *   - Push-based A* (state = posisi kotak + posisi pemain; langkah dicari
 *     per DORONGAN, pemain jalan kaki dihitung via flood-fill).
 *   - Heuristik admissible: minimum-cost matching kotak->target
 *     (Hungarian, jarak BFS mengabaikan kotak lain) untuk <=10 kotak,
 *     jumlah jarak minimum untuk yang lebih besar. A* admissible ->
 *     solusi dengan jumlah PUSH minimal (optimal).
 *   - Deadlock detection (sound): dead square statis (sudut + segmen
 *     dinding), blok 2x2, kotak beku (iteratif).
 *   - Transposition table dengan normalisasi posisi pemain ke petak
 *     kanonik region yang dicapainya.
 *   - Dua fase per instance: (1) weighted A* cepat untuk dapat solusi
 *     feasible dulu (fallback, partial credit), (2) A* optimal dengan
 *     branch-and-bound terhadap solusi incumbent. Kalau fase 2 kehabisan
 *     waktu/node, solusi fase 1 yang dipakai.
 *
 * Hanya sintaks TypeScript yang erasable (type stripping Node 22) yang
 * dipakai di file ini: tidak ada enum, namespace, atau parameter property.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Konstanta
// ---------------------------------------------------------------------------

const DIRS = ["U", "D", "L", "R"];
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const BIG = 10_000_000; // "tak terhingga" untuk Hungarian (>> total jarak legal mana pun)
const TOTAL_BUDGET_MS = 50_000; // margin 10 detik dari batas grader 60 detik
const PHASE1_WEIGHT = 2;
const PHASE1_NODES = 150_000;
const PHASE2_NODES = 500_000;
const HUNGARIAN_MAX_N = 10;
const MAX_SOLUTION_BYTES = 65_536;

// ---------------------------------------------------------------------------
// Level: parsing format XSB
// ---------------------------------------------------------------------------

export type Level = {
  w: number;
  h: number;
  walls: Set<number>;
  targets: Set<number>;
  boxes: number[]; // terurut naik
  player: number;
};

function sq(x: number, y: number, w: number): number {
  return y * w + x;
}

/** Parse teks level XSB. Kembalikan null kalau level rusak. */
export function parseLevel(text: string): Level | null {
  const rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (rawLines.length > 0 && rawLines[0].trim() === "") rawLines.shift();
  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") rawLines.pop();
  if (rawLines.length === 0) return null;

  const w = Math.max(...rawLines.map((l) => l.length));
  const h = rawLines.length;
  const walls = new Set<number>();
  const targets = new Set<number>();
  const boxes: number[] = [];
  let player = -1;

  for (let y = 0; y < h; y++) {
    const line = rawLines[y].padEnd(w, " ");
    for (let x = 0; x < w; x++) {
      const ch = line[x];
      const p = sq(x, y, w);
      if (ch === "#") walls.add(p);
      else if (ch === ".") targets.add(p);
      else if (ch === "$") boxes.push(p);
      else if (ch === "*") {
        boxes.push(p);
        targets.add(p);
      } else if (ch === "@") {
        if (player >= 0) return null;
        player = p;
      } else if (ch === "+") {
        if (player >= 0) return null;
        player = p;
        targets.add(p);
      } else if (ch === " " || ch === "-" || ch === "_") {
        // lantai
      } else {
        return null; // karakter tak dikenal
      }
    }
  }
  if (player < 0) return null;
  boxes.sort((a, b) => a - b);
  return { w, h, walls, targets, boxes, player };
}

// ---------------------------------------------------------------------------
// Precompute per level: jarak BFS, dead square
// ---------------------------------------------------------------------------

export type Prepared = {
  level: Level;
  targetsArr: number[]; // terurut naik
  distT: Int32Array[]; // distT[t][petak] = jarak dari target t (-1 = tak terjangkau)
  minDist: Int32Array; // minDist[petak] = jarak ke target terdekat (-1 = tak terjangkau)
  dead: Set<number>;
};

function isWall(prep: Prepared, p: number): boolean {
  const { level } = prep;
  const x = p % level.w;
  const y = Math.floor(p / level.w);
  return x < 0 || y < 0 || x >= level.w || y >= level.h || level.walls.has(p);
}

function bfsFromTarget(prep: Prepared, target: number): Int32Array {
  const { level } = prep;
  const dist = new Int32Array(level.w * level.h).fill(-1);
  const queue: number[] = [target];
  dist[target] = 0;
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const x = cur % level.w;
    const y = Math.floor(cur / level.w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= level.w || ny >= level.h) continue;
      const np = sq(nx, ny, level.w);
      if (dist[np] >= 0 || level.walls.has(np)) continue;
      dist[np] = dist[cur] + 1;
      queue.push(np);
    }
  }
  return dist;
}

function computeDeadSquares(prep: Prepared): Set<number> {
  const { level } = prep;
  const dead = new Set<number>();
  const wallAt = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= level.w || y >= level.h || level.walls.has(sq(x, y, level.w));

  for (let y = 0; y < level.h; y++) {
    for (let x = 0; x < level.w; x++) {
      const p = sq(x, y, level.w);
      if (level.walls.has(p) || level.targets.has(p)) continue;
      // Sudut: dua tetangga tegak lurus adalah dinding.
      const corner =
        (wallAt(x, y - 1) && wallAt(x - 1, y)) ||
        (wallAt(x, y - 1) && wallAt(x + 1, y)) ||
        (wallAt(x, y + 1) && wallAt(x - 1, y)) ||
        (wallAt(x, y + 1) && wallAt(x + 1, y));
      if (corner) {
        dead.add(p);
        continue;
      }
      // Segmen dinding: kalau ada dinding di arah d, kotak hanya bisa
      // meluncur tegak lurus d. Kotak baru dinyatakan mati kalau segmen
      // tempatnya meluncur TERTUTUP di kedua ujung (dibatasi dinding,
      // sehingga kotak terperangkap di segmen) DAN segmen tidak
      // mengandung target. Kalau salah satu ujung TERBUKA (dinding
      // habis), kotak bisa meluncur ke luar segmen lalu didorong menjauh
      // dari dinding — jadi TIDAK mati (aturan lama yang mengabaikan
      // ujung terbuka adalah false positive: contoh, kotak di (3,3)
      // level06 bisa meluncur ke (2,3) lalu turun).
      for (let d = 0; d < 4; d++) {
        const dx = DX[d];
        const dy = DY[d];
        if (!wallAt(x + dx, y + dy)) continue;
        const px = -dy;
        const py = dx;
        const run: number[] = [p];
        let closedEnds = 0;
        for (const step of [1, -1]) {
          let cx = x;
          let cy = y;
          for (;;) {
            cx += step * px;
            cy += step * py;
            if (wallAt(cx, cy)) {
              closedEnds++; // run dibatasi dinding -> ujung tertutup
              break;
            }
            if (!wallAt(cx + dx, cy + dy)) break; // dinding habis -> ujung terbuka
            run.push(sq(cx, cy, level.w));
          }
        }
        if (closedEnds === 2 && !run.some((r) => level.targets.has(r))) {
          dead.add(p);
          break;
        }
      }
    }
  }
  return dead;
}

export function prepare(level: Level): Prepared {
  const targetsArr = [...level.targets].sort((a, b) => a - b);
  const prep: Prepared = {
    level,
    targetsArr,
    distT: [],
    minDist: new Int32Array(level.w * level.h).fill(-1),
    dead: new Set<number>(),
  };
  for (const t of targetsArr) {
    const d = bfsFromTarget(prep, t);
    prep.distT.push(d);
    for (let i = 0; i < d.length; i++) {
      if (d[i] >= 0 && (prep.minDist[i] < 0 || d[i] < prep.minDist[i])) {
        prep.minDist[i] = d[i];
      }
    }
  }
  prep.dead = computeDeadSquares(prep);
  return prep;
}

// ---------------------------------------------------------------------------
// Deadlock dinamis: blok 2x2 dan kotak beku
// ---------------------------------------------------------------------------

function has2x2Deadlock(prep: Prepared, boxes: Set<number>): boolean {
  const { level } = prep;
  for (const b of boxes) {
    const x = b % level.w;
    const y = Math.floor(b / level.w);
    for (const [ox, oy] of [
      [0, 0],
      [-1, 0],
      [0, -1],
      [-1, -1],
    ]) {
      const cells = [
        sq(x + ox, y + oy, level.w),
        sq(x + ox + 1, y + oy, level.w),
        sq(x + ox, y + oy + 1, level.w),
        sq(x + ox + 1, y + oy + 1, level.w),
      ];
      let full = true;
      let hasUnplacedBox = false;
      for (const c of cells) {
        if (isWall(prep, c)) continue;
        if (boxes.has(c)) {
          if (!prep.level.targets.has(c)) hasUnplacedBox = true;
          continue;
        }
        full = false;
        break;
      }
      if (full && hasUnplacedBox) return true;
    }
  }
  return false;
}

function frozenBoxes(prep: Prepared, boxes: Set<number>): Set<number> {
  const { level } = prep;
  const frozen = new Set<number>();
  const blocked = (p: number): boolean => isWall(prep, p) || frozen.has(p);
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of boxes) {
      if (frozen.has(b) || level.targets.has(b)) continue;
      const x = b % level.w;
      const y = Math.floor(b / level.w);
      const hBlocked = blocked(sq(x - 1, y, level.w)) && blocked(sq(x + 1, y, level.w));
      const vBlocked = blocked(sq(x, y - 1, level.w)) && blocked(sq(x, y + 1, level.w));
      if (hBlocked && vBlocked) {
        frozen.add(b);
        changed = true;
      }
    }
  }
  return frozen;
}

function isDeadState(prep: Prepared, boxesArr: number[]): boolean {
  const boxes = new Set(boxesArr);
  if (has2x2Deadlock(prep, boxes)) return true;
  if (frozenBoxes(prep, boxes).size > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Hungarian: minimum-cost assignment (O(n^3), e-maxx). cost n x n, non-negatif.
// ---------------------------------------------------------------------------

export function hungarian(cost: number[][]): number {
  const n = cost.length;
  if (n === 0) return 0;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  return -v[0];
}

/** Heuristik admissible: min-cost matching (atau jumlah jarak minimum). */
function heuristic(prep: Prepared, boxes: number[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  for (const b of boxes) {
    if (prep.minDist[b] < 0) return Infinity; // kotak tak bisa capai target mana pun
  }
  if (n <= HUNGARIAN_MAX_N) {
    const cost: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < n; j++) {
        const d = prep.distT[j][boxes[i]];
        row.push(d < 0 ? BIG : d);
      }
      cost.push(row);
    }
    const total = hungarian(cost);
    if (total >= BIG / 2) return Infinity; // tidak ada perfect matching -> mati
    return total;
  }
  let s = 0;
  for (const b of boxes) s += prep.minDist[b];
  return s;
}

// ---------------------------------------------------------------------------
// Utilitas pencarian: flood fill, jalur jalan, binary heap deterministik
// ---------------------------------------------------------------------------

function reachableSquares(prep: Prepared, start: number, boxes: Set<number>): Set<number> {
  const { level } = prep;
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    const x = cur % level.w;
    const y = Math.floor(cur / level.w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= level.w || ny >= level.h) continue;
      const np = sq(nx, ny, level.w);
      if (seen.has(np) || level.walls.has(np) || boxes.has(np)) continue;
      seen.add(np);
      stack.push(np);
    }
  }
  return seen;
}

/** Jalur jalan pemain (huruf besar) dari start ke goal; null kalau tak ada. */
function walkPath(
  prep: Prepared,
  start: number,
  goal: number,
  boxes: Set<number>,
): string | null {
  if (start === goal) return "";
  const { level } = prep;
  const prev = new Map<number, [number, number]>(); // pos -> [prevPos, dir]
  const queue: number[] = [start];
  prev.set(start, [-1, -1]);
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const x = cur % level.w;
    const y = Math.floor(cur / level.w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= level.w || ny >= level.h) continue;
      const np = sq(nx, ny, level.w);
      if (prev.has(np) || level.walls.has(np) || boxes.has(np)) continue;
      prev.set(np, [cur, d]);
      if (np === goal) {
        const letters: string[] = [];
        let node = np;
        while (prev.get(node)![0] !== -1) {
          const [pr, dir] = prev.get(node)!;
          letters.push(DIRS[dir]);
          node = pr;
        }
        letters.reverse();
        return letters.join("");
      }
      queue.push(np);
    }
  }
  return null;
}

type HeapEntry = { f: number; h: number; neg: number; seq: number; key: string; g: number };

class Heap {
  private a: HeapEntry[] = [];
  get size(): number {
    return this.a.length;
  }
  private less(x: HeapEntry, y: HeapEntry): boolean {
    if (x.f !== y.f) return x.f < y.f;
    if (x.h !== y.h) return x.h < y.h;
    if (x.neg !== y.neg) return x.neg < y.neg;
    return x.seq < y.seq;
  }
  push(e: HeapEntry): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(a[i], a[parent])) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }
  pop(): HeapEntry | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as HeapEntry;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < a.length && this.less(a[left], a[smallest])) smallest = left;
        if (right < a.length && this.less(a[right], a[smallest])) smallest = right;
        if (smallest === i) break;
        [a[i], a[smallest]] = [a[smallest], a[i]];
        i = smallest;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// Pencarian push-based (A* optimal atau weighted A*)
// ---------------------------------------------------------------------------

export type SearchOpts = {
  weighted: boolean;
  weight: number;
  nodeLimit: number;
  deadlineMs: number; // epoch ms absolut
  upperBound: number; // hanya cari solusi dengan pushes < upperBound (Infinity = tanpa batas)
};

export type SearchOutcome = {
  status: "solved" | "unsolvable" | "timeout" | "node_limit" | "no_better";
  pushes: Array<{ box: number; dir: number }> | null;
  nodesExpanded: number;
  nodesGenerated: number;
};

type StateInfo = { boxes: number[]; player: number };

function stateKey(prep: Prepared, boxes: number[], player: number): string {
  const region = reachableSquares(prep, player, new Set(boxes));
  let canon = Infinity;
  for (const s of region) if (s < canon) canon = s;
  return boxes.join(",") + "|" + canon;
}

function boxesEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function search(prep: Prepared, opts: SearchOpts): SearchOutcome {
  const { level } = prep;
  const stats = { nodesExpanded: 0, nodesGenerated: 0 };
  const startBoxes = [...level.boxes];
  const startKey = stateKey(prep, startBoxes, level.player);

  const gScore = new Map<string, number>();
  const parent = new Map<string, { prev: string; box: number; dir: number } | null>();
  const states = new Map<string, StateInfo>();
  gScore.set(startKey, 0);
  parent.set(startKey, null);
  states.set(startKey, { boxes: startBoxes, player: level.player });

  let seq = 0;
  const heap = new Heap();
  const h0 = heuristic(prep, startBoxes);
  if (h0 === Infinity) {
    return { status: "unsolvable", pushes: null, nodesExpanded: 0, nodesGenerated: 0 };
  }
  const f0 = opts.weighted ? opts.weight * h0 : h0;
  heap.push({
    f: f0,
    h: h0,
    neg: -countOnTarget(prep, startBoxes),
    seq: seq++,
    key: startKey,
    g: 0,
  });

  let goalKey: string | null = null;
  while (heap.size > 0) {
    const entry = heap.pop() as HeapEntry;
    const state = states.get(entry.key);
    if (state === undefined) continue;
    // Entri basi (sudah ada jalur lebih pendek ke state ini)?
    if ((gScore.get(entry.key) as number) < entry.g) continue;
    const g = entry.g;
    stats.nodesExpanded++;

    if (stats.nodesExpanded % 1024 === 0) {
      if (Date.now() > opts.deadlineMs) {
        return { status: "timeout", pushes: null, ...stats };
      }
      if (stats.nodesExpanded > opts.nodeLimit) {
        return { status: "node_limit", pushes: null, ...stats };
      }
    }

    // Branch-and-bound: tidak ada state tersisa yang bisa mengalahkan incumbent.
    if (entry.f >= opts.upperBound) {
      return { status: "no_better", pushes: null, ...stats };
    }

    if (boxesEqual(state.boxes, prep.targetsArr)) {
      goalKey = entry.key;
      break;
    }

    const boxesSet = new Set(state.boxes);
    const reachable = reachableSquares(prep, state.player, boxesSet);
    for (const box of state.boxes) {
      const bx = box % level.w;
      const by = Math.floor(box / level.w);
      for (let d = 0; d < 4; d++) {
        const behindX = bx - DX[d];
        const behindY = by - DY[d];
        const aheadX = bx + DX[d];
        const aheadY = by + DY[d];
        if (behindX < 0 || behindY < 0 || behindX >= level.w || behindY >= level.h) continue;
        if (aheadX < 0 || aheadY < 0 || aheadX >= level.w || aheadY >= level.h) continue;
        const behind = sq(behindX, behindY, level.w);
        const ahead = sq(aheadX, aheadY, level.w);
        if (!reachable.has(behind)) continue;
        if (level.walls.has(ahead) || boxesSet.has(ahead)) continue;
        if (prep.dead.has(ahead) || prep.minDist[ahead] < 0) continue;
        const newBoxes = [...state.boxes];
        newBoxes[newBoxes.indexOf(box)] = ahead;
        newBoxes.sort((a, b) => a - b);
        if (isDeadState(prep, newBoxes)) continue;
        const newPlayer = box;
        const newKey = stateKey(prep, newBoxes, newPlayer);
        const newG = g + 1;
        const oldG = gScore.get(newKey);
        if (oldG !== undefined && oldG <= newG) continue;
        const h = heuristic(prep, newBoxes);
        if (h === Infinity) continue;
        if (newG + h >= opts.upperBound) continue; // tidak bisa mengalahkan incumbent
        stats.nodesGenerated++;
        gScore.set(newKey, newG);
        parent.set(newKey, { prev: entry.key, box, dir: d });
        states.set(newKey, { boxes: newBoxes, player: newPlayer });
        const f = opts.weighted ? newG + opts.weight * h : newG + h;
        heap.push({
          f,
          h,
          neg: -countOnTarget(prep, newBoxes),
          seq: seq++,
          key: newKey,
          g: newG,
        });
      }
    }
  }

  if (goalKey === null) {
    return { status: "unsolvable", pushes: null, ...stats };
  }
  const pushes: Array<{ box: number; dir: number }> = [];
  let key: string | null = goalKey;
  while (key !== null) {
    const par = parent.get(key);
    if (par === null || par === undefined) break;
    pushes.push({ box: par.box, dir: par.dir });
    key = par.prev;
  }
  pushes.reverse();
  return { status: "solved", pushes, ...stats };
}

function countOnTarget(prep: Prepared, boxes: number[]): number {
  let c = 0;
  for (const b of boxes) if (prep.level.targets.has(b)) c++;
  return c;
}

// ---------------------------------------------------------------------------
// Rekonstruksi solusi: dorongan -> string langkah (huruf kecil = push)
// ---------------------------------------------------------------------------

export function pushesToMoves(
  prep: Prepared,
  pushes: Array<{ box: number; dir: number }>,
): string | null {
  const { level } = prep;
  const boxes = new Set(level.boxes);
  let player = level.player;
  let out = "";
  for (const { box, dir } of pushes) {
    const bx = box % level.w;
    const by = Math.floor(box / level.w);
    const behind = sq(bx - DX[dir], by - DY[dir], level.w);
    const path = walkPath(prep, player, behind, boxes);
    if (path === null) return null;
    out += path; // huruf besar = jalan kaki
    out += DIRS[dir].toLowerCase(); // huruf kecil = dorongan
    boxes.delete(box);
    boxes.add(sq(bx + DX[dir], by + DY[dir], level.w));
    player = box;
  }
  return out;
}

/** Replay string solusi (konvensi huruf kecil = push). True kalau solved & legal. */
export function replayMoves(prep: Prepared, moves: string): boolean {
  const { level } = prep;
  const boxes = new Set(level.boxes);
  let player = level.player;
  for (const ch of moves) {
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") continue;
    const isPush = ch >= "a" && ch <= "z";
    const letter = ch.toUpperCase();
    const dir = DIRS.indexOf(letter);
    if (dir < 0) return false;
    const x = player % level.w;
    const y = Math.floor(player / level.w);
    const nx = x + DX[dir];
    const ny = y + DY[dir];
    if (nx < 0 || ny < 0 || nx >= level.w || ny >= level.h) return false;
    const np = sq(nx, ny, level.w);
    if (level.walls.has(np)) return false;
    if (boxes.has(np)) {
      if (!isPush) return false; // jalan kaki menabrak kotak = ilegal
      const bx = nx + DX[dir];
      const by = ny + DY[dir];
      if (bx < 0 || by < 0 || bx >= level.w || by >= level.h) return false;
      const bp = sq(bx, by, level.w);
      if (level.walls.has(bp) || boxes.has(bp)) return false;
      boxes.delete(np);
      boxes.add(bp);
    } else {
      if (isPush) return false; // push tanpa kotak di depan = ilegal
    }
    player = np;
  }
  if (boxes.size !== level.targets.size) return false;
  for (const b of boxes) if (!level.targets.has(b)) return false;
  return true;
}

export function countPushes(moves: string): number {
  let c = 0;
  for (const ch of moves) if (ch >= "a" && ch <= "z") c++;
  return c;
}

// ---------------------------------------------------------------------------
// Solve satu instance (dua fase) -> string solusi ("" kalau tidak ketemu)
// ---------------------------------------------------------------------------

export function solveInstance(level: Level, deadlineMs: number): string {
  const prep = prepare(level);
  if (level.boxes.length === 0) return ""; // sudah solved (0 kotak)
  if (level.boxes.length !== level.targets.size) return ""; // tidak mungkin
  const h0 = heuristic(prep, [...level.boxes]);
  if (h0 === Infinity) return "";

  const totalBudget = Math.max(0, deadlineMs - Date.now());
  const phase1Deadline = Math.min(
    deadlineMs,
    Date.now() + Math.max(1000, Math.floor(totalBudget * 0.25)),
  );

  let best: string | null = null;
  let bestPushes = Infinity;

  // Fase 1: weighted A* — cari solusi feasible dulu (fallback).
  const greedy = search(prep, {
    weighted: true,
    weight: PHASE1_WEIGHT,
    nodeLimit: PHASE1_NODES,
    deadlineMs: phase1Deadline,
    upperBound: Infinity,
  });
  if (greedy.status === "solved" && greedy.pushes !== null) {
    const moves = pushesToMoves(prep, greedy.pushes);
    if (moves !== null && replayMoves(prep, moves)) {
      best = moves;
      bestPushes = countPushes(moves);
      if (bestPushes === h0) return best; // sudah optimal (lower bound tercapai)
    }
  }

  // Fase 2: A* optimal, branch-and-bound terhadap incumbent.
  const optimal = search(prep, {
    weighted: false,
    weight: 1,
    nodeLimit: PHASE2_NODES,
    deadlineMs,
    upperBound: bestPushes,
  });
  if (optimal.status === "solved" && optimal.pushes !== null) {
    const moves = pushesToMoves(prep, optimal.pushes);
    if (moves !== null && replayMoves(prep, moves)) {
      return moves;
    }
  }
  return best ?? "";
}

// ---------------------------------------------------------------------------
// Main: baca /input/<id>/level.txt, tulis /output/<id>/solution.txt
// ---------------------------------------------------------------------------

function main(): void {
  const inputDir = process.env.INPUT_DIR ?? "/input";
  const outputDir = process.env.OUTPUT_DIR ?? "/output";
  const t0 = Date.now();
  const globalDeadline = t0 + TOTAL_BUDGET_MS;

  let ids: string[] = [];
  try {
    ids = fs
      .readdirSync(inputDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    ids = [];
  }

  const n = ids.length;
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const outDir = path.join(outputDir, id);
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch {
      continue;
    }

    let solution = "";
    const remainMs = globalDeadline - Date.now();
    if (remainMs > 0) {
      try {
        const levelText = fs.readFileSync(path.join(inputDir, id, "level.txt"), "utf8");
        const level = parseLevel(levelText);
        if (level !== null) {
          const remaining = n - i;
          const budgetMs = Math.min(remainMs, Math.max(2000, (remainMs / remaining) * 2));
          const deadline = Math.min(globalDeadline, Date.now() + budgetMs);
          solution = solveInstance(level, deadline);
        }
      } catch {
        solution = "";
      }
    }

    // Pengaman format: hanya huruf LURD (besar/kecil), maks 65.536 byte.
    if (solution.length > MAX_SOLUTION_BYTES || /[^UDLRudlr]/.test(solution)) {
      solution = "";
    }
    try {
      fs.writeFileSync(path.join(outDir, "solution.txt"), solution, "utf8");
    } catch {
      // tidak bisa tulis -> lanjut ke instance berikutnya
    }

    if (Date.now() > globalDeadline) {
      // Waktu habis: tulis file kosong untuk sisa instance supaya format terpenuhi.
      for (let j = i + 1; j < n; j++) {
        try {
          fs.mkdirSync(path.join(outputDir, ids[j]), { recursive: true });
          fs.writeFileSync(path.join(outputDir, ids[j], "solution.txt"), "", "utf8");
        } catch {
          // abaikan
        }
      }
      break;
    }
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main();
}
