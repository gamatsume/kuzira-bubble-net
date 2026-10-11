/**
 * ザトウクジラの骨格と泳ぎ（下から見上げた画面に投影する）。
 *
 * 座標は画面の高さを 1 とした平面（中心 0、上が +y）。
 * 体の上下方向（深さ）は z で扱い、+z が見ている人（下）に近づく向き。
 *
 * 参考にした実際の特徴
 * - 体型: ずんぐりした胴。最大幅は吻端から 3〜4 割、尾柄に向かって強く細る
 * - 胸ビレ: 体長の約 1/3。吻端から約 3 割の位置から後ろへ流れる
 * - 尾ビレ: 幅は体長の約 1/3
 * - 推進: 上下（背腹方向）のうねり。頭はほぼ動かず、尾に向かって振幅が増す。
 *   1 回の尾の振りは数秒（巡航で 0.3〜0.4 Hz 前後）、うねりの波長は体長程度
 * - 旋回: 体を傾け（バンク）、胸ビレで曲がる
 */

export const JOINTS = 14;

export type WhaleParams = {
  length: number;     // 体長（画面の高さ比）
  girth: number;      // 体の太さ（倍率）
  finLength: number;  // 胸ビレの長さ（倍率）
  flukeSpan: number;  // 尾ビレの幅（倍率）
  speed: number;      // 泳ぐ速さ（体長/秒）
  tailAmp: number;    // 尾の振り幅（倍率）
  turn: number;       // 旋回の強さ（rad/秒。0 で巡航）
  bank: number;       // 旋回時の傾き（倍率）
  depth: number;      // 上下動による遠近（倍率）
  orbit?: number;     // 旋回の半径（画面の高さ比）。省略時は速さと旋回の強さから決める
  figure8?: number;   // 1: 奥行きのある八の字を泳ぐ
  f8w?: number;       // 八の字の横幅（片側）
  f8h?: number;       // 八の字の縦幅
  f8d?: number;       // 八の字の奥行き（+ が見ている人に近い側）
  f8z?: number;       // 八の字全体の深さのずれ（- で水面寄り）
  f8mirror?: number;  // -1 で左右反転した八の字
  pathKind?: number;  // 0: 八の字 / 1: 八の字の外側を回る楕円（浮き沈みしながら）
};

export type Vec2 = { x: number; y: number };

export type WhalePose = {
  /** 背骨の関節: 位置, 半幅, 体の位置 s（0 吻端〜1 尾の付け根） */
  joints: { x: number; y: number; hw: number; s: number }[];
  /** 胸ビレ（左, 右）: 付け根, 先端, 頭の向き, 付け根の幅 */
  fins: { root: Vec2; tip: Vec2; fwd: Vec2; chord: number }[];
  /** 尾ビレ: 付け根, 後ろ向きの軸, 左右の軸, 片翼の長さ, 翼弦 */
  fluke: { root: Vec2; back: Vec2; side: Vec2; span: number; chord: number };
  roll: number;
};

// 腹側から見た半幅（体長比）。s = 0 吻端 → 1 尾ビレの付け根
const PROFILE: [number, number][] = [
  [0.0, 0.026], [0.04, 0.042], [0.1, 0.062], [0.2, 0.086], [0.3, 0.106], [0.4, 0.114],
  [0.5, 0.1], [0.6, 0.082], [0.7, 0.058], [0.8, 0.036], [0.88, 0.022], [0.94, 0.016], [1.0, 0.018],
];
const BODY = 0.9;        // 吻端〜尾ビレの付け根（体長比）
const FIN_AT = 0.29;     // 胸ビレの付け根の位置
const FIN_LEN = 0.31;    // 胸ビレの長さ（体長比）
const FIN_CHORD = 0.062; // 胸ビレの付け根の幅（体長比）
const FLUKE_HALF = 0.155;
const FLUKE_CHORD = 0.1;
const WAVELENGTH = 1.0;  // うねりの波長（体長比）

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

const profile = (s: number) => {
  for (let i = 1; i < PROFILE.length; i++) {
    const [s1, w1] = PROFILE[i];
    if (s <= s1) {
      const [s0, w0] = PROFILE[i - 1];
      const k = (s - s0) / (s1 - s0);
      const e = k * k * (3 - 2 * k);
      return w0 + (w1 - w0) * e;
    }
  }
  return PROFILE[PROFILE.length - 1][1];
};

// 振幅の分布: 頭はわずか、胸ビレのあたりが最小、尾に向かって急に増える
const envelope = (s: number) => 0.12 - 0.35 * s + 1.25 * s * s;

export type WhaleState = {
  x: number; y: number; heading: number;
  phase: number;   // 尾の振りの位相
  roll: number;
  turnRate: number;
  arc: number;
  z: number;
  tau: number;     // 八の字の上の位置
  trail: { x: number; y: number; z: number; arc: number }[];
  wander: number;
};

export function createWhale(x: number, y: number, heading: number, length: number): WhaleState {
  const trail = [];
  // 体の後ろに、まっすぐ来た道筋を用意しておく
  const n = 60;
  for (let i = n; i >= 0; i--) {
    const d = (i / n) * length * 1.4;
    trail.push({ x: x - Math.cos(heading) * d, y: y - Math.sin(heading) * d, z: 0, arc: -d });
  }
  return { x, y, z: 0, tau: 0, heading, phase: 0, roll: 0, turnRate: 0, arc: 0, trail, wander: Math.random() * 100 };
}

/** 1 フレーム進める。aspect は画面の横/縦 */
export function stepWhale(w: WhaleState, dt: number, P: WhaleParams, aspect: number) {
  if ((P.figure8 ?? 0) > 0.5) {
    stepFigure8(w, dt, P);
  } else {
    stepPlanar(w, dt, P, aspect);
  }

  // 尾の振り: 速いほど速く振る（巡航で 0.35 Hz 前後）
  const freq = 0.2 + 1.3 * P.speed;
  w.phase += dt * freq * Math.PI * 2;

  // 傾き: 旋回の向心加速度に比例して内側へ倒れる
  const target = Math.max(-1.2, Math.min(1.2, w.turnRate * P.speed * 9 * P.bank));
  w.roll += (target - w.roll) * (1 - Math.exp(-dt * 0.9));
}

/**
 * 奥行きのある八の字。左右の輪の一方は手前（見ている人に近い）、もう一方は奥を通る。
 * 頭は曲線の上を一定の速さで進み、体は通ってきた道筋をなぞる。
 */
function stepFigure8(w: WhaleState, dt: number, P: WhaleParams) {
  const L = P.length;
  const v = P.speed * L;
  const at = (t: number) => pathPos(P, t);
  const p0 = at(w.tau), p1 = at(w.tau + 1e-3);
  const speed = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) / 1e-3 || 1;
  w.tau += (v * dt) / speed;
  const p = at(w.tau);
  const step = Math.hypot(p.x - w.x, p.y - w.y, p.z - w.z);
  const heading = Math.atan2(p.y - w.y, p.x - w.x);
  if (step > 1e-6 && dt > 0) {
    let dh = heading - w.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    w.turnRate += (dh / dt - w.turnRate) * (1 - Math.exp(-dt * 2));
    w.heading = heading;
  }
  w.x = p.x; w.y = p.y; w.z = p.z;
  w.arc += step;
  w.trail.push({ x: w.x, y: w.y, z: w.z, arc: w.arc });
  while (w.trail.length > 2 && w.trail[1].arc < w.arc - L * 1.5) w.trail.shift();
}

function stepPlanar(w: WhaleState, dt: number, P: WhaleParams, aspect: number) {
  const L = P.length;
  const v = P.speed * L;
  // 進路: 旋回の強さが 0 に近ければ、ゆっくりさまよう巡航
  w.wander += dt;
  let omega = P.turn;
  if (Math.abs(P.turn) >= 0.02) {
    // 旋回: 画面の中心（光の真下）をまわる円に乗る。半径は速さと旋回の強さで決まる
    const sign = Math.sign(P.turn);
    const Rt = P.orbit ?? Math.min(Math.abs(v / P.turn), 0.34);
    const r = Math.hypot(w.x, w.y);
    const want = Math.atan2(w.y, w.x) + sign * (Math.PI / 2 + Math.max(-0.8, Math.min(0.8, (r - Rt) * 4)));
    let diff = want - w.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    omega = Math.max(-Math.abs(P.turn) * 1.8, Math.min(Math.abs(P.turn) * 1.8, diff * 1.2 + P.turn * 0.6));
  } else {
    const tx = Math.sin(w.wander * 0.05) * aspect * 0.25;
    const ty = Math.sin(w.wander * 0.083 + 1.1) * 0.2;
    let diff = Math.atan2(ty - w.y, tx - w.x) - w.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    omega = Math.max(-0.3, Math.min(0.3, diff * 0.5));
  }
  // 画面の外へ出そうなら中心へ戻る
  const dist = Math.hypot(w.x / Math.max(aspect, 1), w.y);
  const limit = Math.max(0.42, (P.orbit ?? 0) + 0.15);
  if (dist > limit) {
    let diff = Math.atan2(-w.y, -w.x) - w.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    omega += diff * (dist - limit) * 6;
  }
  // 旋回の角速度はなめらかに変わる（巨体なので急には曲がれない）
  w.turnRate += (omega - w.turnRate) * (1 - Math.exp(-dt * 1.2));
  w.heading += w.turnRate * dt;
  w.x += Math.cos(w.heading) * v * dt;
  w.y += Math.sin(w.heading) * v * dt;
  w.arc += v * dt;
  // 平面の泳ぎでは奥行きを 0 へ戻す
  w.z += (0 - w.z) * (1 - Math.exp(-dt * 0.5));
  w.trail.push({ x: w.x, y: w.y, z: w.z, arc: w.arc });
  while (w.trail.length > 2 && w.trail[1].arc < w.arc - L * 1.5) w.trail.shift();
}

const sampleTrail = (w: WhaleState, arc: number) => {
  const t = w.trail;
  for (let i = t.length - 1; i > 0; i--) {
    if (t[i - 1].arc <= arc) {
      const a = t[i - 1], b = t[i];
      const k = b.arc === a.arc ? 0 : (arc - a.arc) / (b.arc - a.arc);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, dx: b.x - a.x, dy: b.y - a.y, dz: b.z - a.z };
    }
  }
  const a = t[0], b = t[1];
  return { x: a.x, y: a.y, z: a.z, dx: b.x - a.x, dy: b.y - a.y, dz: b.z - a.z };
};

/** 現在の姿勢を、画面に写した形で返す */
export function poseWhale(w: WhaleState, P: WhaleParams): WhalePose {
  const L = P.length;
  const A = 0.1 * P.tailAmp; // 尾の先の振幅（体長比）
  const k = (Math.PI * 2) / WAVELENGTH;
  const height = (s: number) => A * envelope(s) * Math.sin(w.phase - k * s * BODY);
  const slope = (s: number) => A * (envelope(s) * -k * BODY * Math.cos(w.phase - k * s * BODY) + (-0.35 + 2.5 * s) * Math.sin(w.phase - k * s * BODY)) / BODY;

  const roll = w.roll;
  const rollWidth = Math.sqrt(Math.cos(roll) ** 2 + (0.85 * Math.sin(roll)) ** 2);

  // 背骨: 泳いできた道筋に沿わせる。ただし頭から胸までは硬く、曲がるのは主に体の後ろ半分。
  // 上下に傾いた分だけ、画面上では体が縮んで見える
  const joints: WhalePose["joints"] = [];
  const head = sampleTrail(w, w.arc);
  const hl = Math.hypot(head.dx, head.dy) || 1;
  const hd = { x: head.dx / hl, y: head.dy / hl };
  let projected = 0;
  let prevS = 0;
  for (let i = 0; i < JOINTS; i++) {
    const s = i / (JOINTS - 1);
    if (i > 0) {
      const mid = (s + prevS) / 2;
      projected += (s - prevS) * Math.cos(Math.atan(slope(mid)));
    }
    prevS = s;
    const back = projected * BODY * L;
    const at = sampleTrail(w, w.arc - back);
    const rigid = 0.8 * (1 - smooth(0.25, 0.75, s));
    const x = at.x + (head.x - hd.x * back - at.x) * rigid;
    const y = at.y + (head.y - hd.y * back - at.y) * rigid;
    const persp = 1 + height(s) * P.depth * 1.5;
    joints.push({ x, y, hw: profile(s) * L * P.girth * rollWidth * persp, s });
  }
  // 各関節の向き（頭の方向）
  const tangents: Vec2[] = joints.map((_, i) => {
    const a = joints[Math.max(i - 1, 0)], b = joints[Math.min(i + 1, JOINTS - 1)];
    const dx = a.x - b.x, dy = a.y - b.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  });

  // 胸ビレ: 付け根の向きから、後ろへ約 37° 流れ、少し下へ垂れる。傾くと左右で見え方が変わる
  const fi = FIN_AT * (JOINTS - 1);
  const i0 = Math.floor(fi), fk = fi - i0;
  const ja = joints[i0], jb = joints[i0 + 1];
  const root = { x: ja.x + (jb.x - ja.x) * fk, y: ja.y + (jb.y - ja.y) * fk };
  const hwAt = ja.hw + (jb.hw - ja.hw) * fk;
  const f = tangents[i0];
  const n = { x: -f.y, y: f.x }; // 左
  const finSway = Math.sin(w.phase + 1.2) * 0.04;
  const fins = [1, -1].map((side) => {
    const sweep = 0.65 + finSway - side * w.turnRate * 0.25;
    const droop = 0.28;
    const back = Math.sin(sweep), lat = Math.cos(sweep);
    // 背骨まわりに傾ける（+z が見ている人に近い）
    const latR = side * lat * Math.cos(roll) - droop * Math.sin(roll) * side * side;
    const vert = side * lat * Math.sin(roll) + droop * Math.cos(roll);
    const finL = FIN_LEN * L * P.finLength * (1 + vert * FIN_LEN * P.depth * 1.5);
    const base = { x: root.x + n.x * side * hwAt * 0.7, y: root.y + n.y * side * hwAt * 0.7 };
    const dir = { x: -f.x * back + n.x * latR, y: -f.y * back + n.y * latR };
    return {
      root: base,
      tip: { x: base.x + dir.x * finL, y: base.y + dir.y * finL },
      fwd: f,
      chord: FIN_CHORD * L * P.finLength,
    };
  });

  // 尾ビレ: 尾柄の傾きより少し先行して迎え角をとる。迎え角が大きいほど、下からは翼弦が縮んで見える
  const tail = joints[JOINTS - 1];
  const tb = tangents[JOINTS - 1];
  const pitch = Math.atan(slope(1)) + 0.45 * Math.cos(w.phase - k * BODY);
  const chordScale = Math.max(Math.abs(Math.cos(pitch)), 0.18);
  const persp = 1 + height(1) * P.depth * 1.5;
  const fluke = {
    root: { x: tail.x, y: tail.y },
    back: { x: -tb.x, y: -tb.y },
    side: { x: -tb.y, y: tb.x },
    span: FLUKE_HALF * L * P.flukeSpan * Math.abs(Math.cos(roll) * 0.9 + 0.1) * persp,
    chord: FLUKE_CHORD * L * chordScale * persp,
  };

  return { joints, fins, fluke, roll };
}

// ---------------------------------------------------------------------------
// 立体の骨格（ポリゴン表現用）。z は見ている人（下）に近づく向きが +

export type V3 = [number, number, number];
export type Joint3 = { p: V3; f: V3; n: V3; v: V3; hw: number; hh: number; s: number };
export type Skeleton3 = {
  joints: Joint3[];
  fins: { base: V3; dir: V3; chordDir: V3; len: number; chord: number }[];
  fluke: { root: V3; side: V3; chordDir: V3; span: number; chord: number };
};

const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const v3 = { norm, add, scale, dot, cross };

export function skeleton3D(w: WhaleState, P: WhaleParams): Skeleton3 {
  const L = P.length;
  const A = 0.1 * P.tailAmp;
  const k = (Math.PI * 2) / WAVELENGTH;
  const height = (s: number) => A * envelope(s) * Math.sin(w.phase - k * s * BODY);
  const slope = (s: number) => A * (envelope(s) * -k * BODY * Math.cos(w.phase - k * s * BODY) + (-0.35 + 2.5 * s) * Math.sin(w.phase - k * s * BODY)) / BODY;

  // 背骨（頭から胸までは硬い）。道筋は奥行きも持つ
  const head = sampleTrail(w, w.arc);
  const hl = Math.hypot(head.dx, head.dy, head.dz) || 1;
  const hd = { x: head.dx / hl, y: head.dy / hl, z: head.dz / hl };
  const pts: { x: number; y: number; z: number; s: number }[] = [];
  let projected = 0, prevS = 0;
  for (let i = 0; i < JOINTS; i++) {
    const s = i / (JOINTS - 1);
    if (i > 0) projected += (s - prevS) * Math.cos(Math.atan(slope((s + prevS) / 2) * P.depth));
    prevS = s;
    const back = projected * BODY * L;
    const at = sampleTrail(w, w.arc - back);
    const rigid = 0.8 * (1 - smooth(0.25, 0.75, s));
    pts.push({
      x: at.x + (head.x - hd.x * back - at.x) * rigid,
      y: at.y + (head.y - hd.y * back - at.y) * rigid,
      z: at.z + (head.z - hd.z * back - at.z) * rigid + height(s) * L * P.depth,
      s,
    });
  }

  const roll = w.roll;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const joints: Joint3[] = pts.map((pt, i) => {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, JOINTS - 1)];
    const f = norm([a.x - b.x, a.y - b.y, a.z - b.z]);
    // お腹の向き（傾いていなければ見ている人の方）
    const v0 = norm(add([0, 0, 1], f, -f[2]));
    const n0 = cross(v0, f); // 左
    const n = norm(add(scale(n0, cr), v0, sr));
    const v = norm(add(scale(v0, cr), n0, -sr));
    const hw = profile(pt.s) * L * P.girth;
    return { p: [pt.x, pt.y, pt.z], f, n, v, hw, hh: hw * 0.88, s: pt.s };
  });

  // 胸ビレ
  const fi = FIN_AT * (JOINTS - 1);
  const i0 = Math.floor(fi), fk = fi - i0;
  const ja = joints[i0], jb = joints[i0 + 1];
  const lerp3 = (a: V3, b: V3) => add(scale(a, 1 - fk), b, fk);
  const jp = lerp3(ja.p, jb.p), jf = ja.f, jn = ja.n, jv = ja.v;
  const jhw = ja.hw + (jb.hw - ja.hw) * fk;
  const finSway = Math.sin(w.phase + 1.2) * 0.04;
  const fins = [1, -1].map((side) => {
    const sweep = 0.65 + finSway - side * w.turnRate * 0.25;
    const droop = 0.28;
    const base = add(add(jp, jn, side * jhw * 0.62), jv, jhw * 0.88 * 0.45);
    const dir = norm(add(add(scale(jf, -Math.sin(sweep)), jn, side * Math.cos(sweep)), jv, droop));
    const chordDir = norm(add(jf, dir, -dot(jf, dir)));
    return { base, dir, chordDir, len: FIN_LEN * L * P.finLength, chord: FIN_CHORD * L * P.finLength };
  });

  // 尾ビレ: 尾柄の傾きより少し先行して迎え角をとる
  const tail = joints[JOINTS - 1];
  const pitch = 0.45 * Math.cos(w.phase - k * BODY);
  const chordDir = norm(add(scale(tail.f, -Math.cos(pitch)), tail.v, Math.sin(pitch)));
  const fluke = { root: tail.p, side: tail.n, chordDir, span: FLUKE_HALF * L * P.flukeSpan, chord: FLUKE_CHORD * L };

  return { joints, fins, fluke };
}

/** 泳ぐ道筋の上の位置 */
export function pathPos(P: WhaleParams, t: number) {
  const a = (P.f8w ?? 0.8) * (P.f8mirror ?? 1), b = P.f8h ?? 0.4, c = P.f8d ?? 0.35, z0 = P.f8z ?? 0;
  if ((P.pathKind ?? 0) === 1) {
    // 八の字（横 ±a, 縦 ±b）の外側を回る楕円。八の字とは画面上で交わらない
    return { x: a * 1.3 * Math.cos(t), y: b * 1.7 * Math.sin(t), z: z0 + c * 0.8 * Math.sin(2 * t) };
  }
  return { x: a * Math.sin(t), y: b * Math.sin(2 * t), z: z0 + c * Math.cos(t) };
}

/** 道筋の途中（tau）から泳ぎ始めるクジラを作る */
export function createWhaleOnFigure8(P: WhaleParams, tau: number): WhaleState {
  const pos = (t: number) => pathPos(P, t);
  const w = createWhale(0, 0, 0, P.length);
  // 体の後ろに、八の字に沿って来た道筋を用意しておく
  w.trail = [];
  let arc = 0;
  let prev = pos(tau - 1.2);
  for (let i = 0; i <= 80; i++) {
    const p = pos(tau - 1.2 + (i / 80) * 1.2);
    arc += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
    w.trail.push({ ...p, arc });
    prev = p;
  }
  const last = w.trail[w.trail.length - 1], before = w.trail[w.trail.length - 2];
  Object.assign(w, { x: last.x, y: last.y, z: last.z, arc, tau, heading: Math.atan2(last.y - before.y, last.x - before.x) });
  w.phase = tau * 3;
  return w;
}
