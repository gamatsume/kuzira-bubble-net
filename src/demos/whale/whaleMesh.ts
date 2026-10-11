/**
 * ザトウクジラのローポリゴン・メッシュ。立体の骨格（skeleton3D）から毎フレーム頂点を組み直す。
 * 面・線・点の 3 つで描く（ポリゴン + プレクサス表現）。
 */
import { JOINTS, v3, type Skeleton3, type V3 } from "./whaleModel";

const RING = 12;         // 胴の断面の頂点数。見えるお腹側に寄せて配置する
const FIN_ST = 10;       // 胸ビレの節の数（前縁のコブの数だけ細かく）
const FLUKE_ST = 9;      // 尾ビレの片翼の節の数（後縁のギザギザの数だけ細かく）

export type WhaleMesh = {
  pos: Float32Array;     // xyz
  info: Float32Array;    // x: 部位（0 胴 / 1 胸ビレ / 2 尾ビレ）, y: 乱数, z: 輪郭としての強さ（0〜1）
  tris: Uint16Array;
  edges: Uint16Array;
  count: number;
};

// 頂点ごとの決まった揺らぎ（毎フレーム同じ値。有機的なローポリにする）
const jitter = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * 胴のリングの並び。fi: 背骨の関節の位置（小数で関節の間）、sw/sh: 断面の幅/高さの倍率、fwd: 前への張り出し（半幅比）。
 * 先頭の 2 本は頭の前面: 吻端は尖らせず、幅広く平たい四角い面で終わる
 */
const RINGS: { fi: number; sw: number; sh: number; fwd: number }[] = [
  { fi: 0, sw: 0.7, sh: 0.55, fwd: 0.35 },  // 前面の縁（面取り）
  { fi: 0, sw: 1, sh: 1, fwd: 0 },
  { fi: 0.5, sw: 1, sh: 1, fwd: 0 },        // 頭のディテール用に 1 本足す
  ...Array.from({ length: JOINTS - 1 }, (_, i) => ({ fi: i + 1, sw: 1, sh: 1, fwd: 0 })),
];
const NR = RINGS.length;

// リング上の k 番目の角度。お腹側（sin > 0）ほど点が詰まる
const ringAngle = (i: number, k: number) => {
  const u = ((k + (i % 2) * 0.5) / RING) * Math.PI * 2;
  return u + 0.3 * Math.cos(u);
};
// 頭のあたりで 1、体の中ほどで 0
const headness = (s: number) => 1 - Math.min(Math.max((s - 0.02) / 0.2, 0), 1);

export function createWhaleMesh(): WhaleMesh {
  const bodyCount = NR * RING + 2;            // 胴のリング + 吻端 + 尾の端
  const finCount = 2 * FIN_ST * 3;
  const flukeCount = 2 * FLUKE_ST * 3;
  const count = bodyCount + finCount + flukeCount;
  const tris: number[] = [];

  // 胴: リング同士を三角形でつなぐ（リングごとに半分ずらして菱形の面にする）
  const ring = (i: number, k: number) => i * RING + ((k % RING) + RING) % RING;
  for (let i = 0; i < NR - 1; i++) {
    for (let k = 0; k < RING; k++) {
      if (i % 2 === 0) {
        tris.push(ring(i, k), ring(i + 1, k), ring(i, k + 1));
        tris.push(ring(i, k + 1), ring(i + 1, k), ring(i + 1, k + 1));
      } else {
        tris.push(ring(i, k), ring(i + 1, k - 1), ring(i + 1, k));
        tris.push(ring(i, k), ring(i + 1, k), ring(i, k + 1));
      }
    }
  }
  const nose = NR * RING, tailEnd = nose + 1;
  for (let k = 0; k < RING; k++) {
    tris.push(nose, ring(0, k + 1), ring(0, k));
    tris.push(tailEnd, ring(NR - 1, k), ring(NR - 1, k + 1));
  }

  // 胸ビレと尾ビレ: 節ごとに「前縁・中央の盛り上がり・後縁」の 3 点を結んだ帯（厚みのある板）
  const strip = (start: number, n: number) => {
    for (let j = 0; j < n - 1; j++) {
      const l0 = start + j * 3, m0 = l0 + 1, t0 = l0 + 2;
      const l1 = l0 + 3, m1 = l0 + 4, t1 = l0 + 5;
      tris.push(l0, m0, m1, l0, m1, l1);
      tris.push(m0, t0, t1, m0, t1, m1);
    }
  };
  let at = bodyCount;
  for (let f = 0; f < 2; f++) { strip(at, FIN_ST); at += FIN_ST * 3; }
  for (let f = 0; f < 2; f++) { strip(at, FLUKE_ST); at += FLUKE_ST * 3; }

  // 線: 三角形の辺（重複を除く）
  const seen = new Set<string>();
  const edges: number[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    for (const [a, b] of [[tris[t], tris[t + 1]], [tris[t + 1], tris[t + 2]], [tris[t + 2], tris[t]]]) {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!seen.has(key)) { seen.add(key); edges.push(a, b); }
    }
  }

  // 輪郭としての強さ: 顎・ヒレの前縁・尾ビレの後縁は強く、胴の途中は弱く
  const info = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let part = 0, accent = 0.35;
    if (i < bodyCount) {
      const ringIdx = Math.floor(i / RING), k = i % RING;
      if (i >= NR * RING) accent = i === nose ? 0.7 : 0.6;
      else {
        const sa = Math.sin(ringAngle(ringIdx, k));
        if (ringIdx <= 1) accent = 0.95;                                  // 頭の前面の輪郭
        else if (ringIdx <= 5 && Math.abs(sa) < 0.35) accent = 0.85;      // 口の線（顎の先から目の方へ）
        else if (ringIdx <= 4 && jitter(i * 7 + 3) > 0.62) accent = 1;    // 顎と吻のコブ
      }
    } else if (i < bodyCount + finCount) {
      part = 1;
      const row = (i - bodyCount) % 3;            // 0 前縁 / 1 中央 / 2 後縁
      accent = row === 0 ? 1 : row === 1 ? 0.25 : 0.6;
    } else {
      part = 2;
      const row = (i - bodyCount - finCount) % 3;
      accent = row === 2 ? 1 : row === 1 ? 0.2 : 0.5;
    }
    info[i * 3] = part;
    info[i * 3 + 1] = jitter(i);
    info[i * 3 + 2] = accent;
  }
  return { pos: new Float32Array(count * 3), info, tris: new Uint16Array(tris), edges: new Uint16Array(edges), count };
}

export function updateWhaleMesh(m: WhaleMesh, sk: Skeleton3) {
  const P = m.pos;
  let idx = 0;
  const put = (p: V3) => { P[idx * 3] = p[0]; P[idx * 3 + 1] = p[1]; P[idx * 3 + 2] = p[2]; idx++; };

  // 胴のリング。頭は幅広く平たい四角に近い断面、体の中ほどからは楕円へ。
  // 下顎は上顎より少し前へ張り出す。お腹側（見ている人の側）は少し平たい
  const J = sk.joints;
  RINGS.forEach((rg, i) => {
    const i0 = Math.floor(rg.fi), t = rg.fi - i0;
    const a0 = J[i0], a1 = J[Math.min(i0 + 1, JOINTS - 1)];
    const p = v3.add(v3.scale(a0.p, 1 - t), a1.p, t);
    const nn = v3.norm(v3.add(v3.scale(a0.n, 1 - t), a1.n, t));
    const vv = v3.norm(v3.add(v3.scale(a0.v, 1 - t), a1.v, t));
    const ff = v3.norm(v3.add(v3.scale(a0.f, 1 - t), a1.f, t));
    const sAt = a0.s + (a1.s - a0.s) * t;
    const hw = (a0.hw + (a1.hw - a0.hw) * t) * rg.sw;
    const head = headness(sAt);
    const hh = (a0.hh + (a1.hh - a0.hh) * t) * rg.sh * (1 - 0.15 * head);
    const nExp = 2 + 1.3 * head;             // 超楕円の指数: 大きいほど四角い（先端はわずかに角ばる程度）
    const base = v3.add(p, ff, a0.hw * rg.fwd);
    for (let k = 0; k < RING; k++) {
      const a = ringAngle(i, k);
      const ca = Math.cos(a), sa = Math.sin(a);
      const sq = Math.pow(Math.pow(Math.abs(ca), nExp) + Math.pow(Math.abs(sa), nExp), -1 / nExp);
      const vi = i * RING + k;
      const knob = i <= 4 && jitter(vi * 7 + 3) > 0.62 ? 1.06 : 1;   // コブはわずかに盛り上がる
      const r = (1 + (jitter(vi) - 0.5) * 0.1) * sq * knob;
      let q = v3.add(v3.add(base, nn, ca * hw * r), vv, sa * hh * r * (sa > 0 ? 0.85 : 1));
      if (sa > 0) q = v3.add(q, ff, a0.hw * 0.25 * head * sa);       // 下顎の張り出し
      put(q);
    }
  });
  const j0 = J[0], jl = J[JOINTS - 1];
  put(v3.add(v3.add(j0.p, j0.f, j0.hw * 0.45), j0.v, j0.hh * 0.08)); // 吻端（小さく、丸みのある先端）
  put(v3.add(jl.p, jl.f, -jl.hw * 0.8));                              // 尾の端

  // 胸ビレ: 先へ向かって後ろへ反り、ねじれる。前縁にコブ、中央は厚く盛り上がる
  for (const fin of sk.fins) {
    const nrm = v3.norm(v3.cross(fin.dir, fin.chordDir));
    for (let s = 0; s < FIN_ST; s++) {
      const t = s / (FIN_ST - 1);
      const chord = fin.chord * (1 - 0.7 * t) * Math.sqrt(Math.max(1 - t ** 8, 0));
      const tw = 0.35 * t;
      const cd = v3.add(v3.scale(fin.chordDir, Math.cos(tw)), nrm, Math.sin(tw));
      const c = v3.add(v3.add(fin.base, fin.dir, fin.len * t), fin.chordDir, -0.9 * t * t * fin.chord);
      const bump = s > 0 && s < FIN_ST - 1 ? (s % 2 ? 0.18 : -0.05) : 0;
      put(v3.add(c, cd, chord * 0.5 * (1 + bump)));                                  // 前縁
      put(v3.add(v3.add(c, cd, chord * 0.12), nrm, chord * 0.16 * (1 - t * 0.6)));   // 中央
      put(v3.add(c, cd, -chord * 0.5));                                              // 後縁
    }
  }

  // 尾ビレ: 先端が後ろへ流れる。中央の後縁に切れ込み
  const fl = sk.fluke;
  const fn = v3.norm(v3.cross(fl.side, fl.chordDir));
  for (const side of [1, -1]) {
    for (let s = 0; s < FLUKE_ST; s++) {
      const t = s / (FLUKE_ST - 1);
      // 先端へ向かってわずかにねじれ、反る
      const tw = 0.25 * t * side;
      const cd = v3.add(v3.scale(fl.chordDir, Math.cos(tw)), fn, Math.sin(tw));
      const c = v3.add(v3.add(v3.add(fl.root, fl.side, side * fl.span * t), fl.chordDir, fl.chord * (0.15 + 0.6 * t * t)), fn, fl.chord * 0.25 * t * t);
      const th = 0.5 * Math.pow(Math.max(1 - Math.pow(t, 2.2), 0), 0.55) * fl.chord;
      const notch = s === 0 ? 0.22 * fl.chord : 0;
      const serr = s > 0 && s < FLUKE_ST - 1 ? (s % 2 ? 0.04 : -0.02) * fl.chord : 0;
      put(v3.add(c, cd, -th * 0.8));                                   // 前縁
      put(v3.add(v3.add(c, cd, -th * 0.2), fn, th * 0.22));            // 中央
      put(v3.add(c, cd, th - notch + serr));                           // 後縁
    }
  }
}
