/**
 * クジラが吐き出す泡（バブルネット）。
 *
 * 位置関係（真横から見て、上から）: 水面 / 泳ぐクジラ / カメラ（真上を見上げる）/ 泡を吐くクジラたち。
 * - 泡を吐くクジラはカメラより深いところで輪を描いて旋回し、数秒おきにまとめて泡を吐く
 * - 泡はカメラの後ろ（下）から上ってくるので、画面の外側から大きくボケた状態で現れ、
 *   水面へ上るにつれて光の中心へ寄り、小さく、くっきりしていく
 * - 大きな泡ほど速く浮かび、ぷるぷると歪む。浮かぶにつれて少し膨らみ、水面の手前で溶けて消える
 *
 * 描いた結果は「R: 光る量 / G: 泡の濃さ」のレイヤーになる。明るさ（光の当たり方）は本編側で掛ける。
 */
import type { V3 } from "./whaleModel";

const MAX = 1600;
const STRIDE = 7; // x, y, z, 半径, 乱数, 濃さ(生き死に), 大粒か

type Bubble = { p: V3; vel: V3; r0: number; seed: number; hero: number; age: number; vz: number; s: number };

const smooth01 = (x: number) => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };

export type BubbleParams = {
  amount: number;    // 吐き出す量（倍率）
  size: number;      // 大きさ（倍率）
  contrast: number;  // 大小の強弱
  rise: number;      // 浮かぶ速さ（倍率）
  rhythm: number;    // 吐き出しの間隔（秒）
};

const VS = `#version 300 es
in vec3 aPos;
in vec4 aB;               // x: 半径, y: 乱数, z: 濃さ, w: 大粒か
uniform float uAspect;
uniform float uPersp;
uniform vec2 uOffset;     // 光源の位置
uniform float uH;         // 画面の高さ（px）
uniform float uMaxPt;
out vec4 vB;
out vec2 vDir;            // 光の中心へ向かう向き
out float vRadPx;
out float vPad;
out float vNear;          // カメラに近いほど 1 に近づく（被写界深度のボケ）
void main(){
  float denom = 1.0 - aPos.z * uPersp;
  // カメラより後ろ（下）にある泡と、レンズにくっつくほど近い泡は描かない
  if (denom < 0.3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vNear = 0.0; return; }
  float k = 1.0 / denom;
  vNear = clamp((k - 1.3) * 0.3, 0.0, 0.6);
  vec2 s = aPos.xy * k + uOffset;
  gl_Position = vec4(s.x / uAspect * 2.0, s.y * 2.0, 0.0, 1.0);
  float rad = aB.x * k;
  // ボケの広がりのぶん、点の描画領域を大きめにとる（ボケが強いほど広く）
  vPad = 1.45 + 1.4 * vNear + 0.3 * aB.w;
  // 描画領域の上限を超えるときは、四角く切れないよう泡のほうを小さくする
  vRadPx = min(rad * uH, (uMaxPt - 2.0) / (2.0 * vPad));
  gl_PointSize = max(2.0 * vRadPx * vPad + 2.0, 5.0);
  vec2 d = uOffset - s;
  vDir = length(d) > 1e-4 ? normalize(d) : vec2(0.0, 1.0);
  vB = aB;
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vB;
in vec2 vDir;
in float vRadPx;
in float vPad;
in float vNear;
out vec4 o;
uniform float uTime;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main(){
  float seed = vB.y, env = vB.z, hero = vB.w;
  vec2 q = (gl_PointCoord * 2.0 - 1.0) * vec2(1.0, -1.0) * vPad;   // 1.0 が泡の縁
  float d = length(q);
  // 描画領域（四角）の端に届く前に、必ず丸く消えるようにする
  float edgeFade = 1.0 - smoothstep(vPad * 0.78, vPad * 0.97, d);
  float big = smoothstep(4.0, 22.0, vRadPx);
  // 大きな泡ほど、ぷるぷると歪む
  float th = atan(q.y, q.x);
  float jelly = big + hero * 0.5;
  d *= 1.0 + (sin(th * 2.0 + uTime * 1.9 + seed * 6.28) * 0.04 * hero
            + sin(th * 3.0 + uTime * 2.7 + seed * 6.28) * 0.06
            + sin(th * 5.0 - uTime * 3.3 + seed * 17.0) * 0.03) * jelly;
  // 被写界深度: 大きい（手前の）泡ほど縁が太くボケる。細すぎる縁は 1px 以上に保つ
  float blur = 0.12 * big + hero * 0.14 + vNear;
  float w0 = max(0.18, 1.2 / max(vRadPx, 1.0));
  float w = w0 + blur;
  float energy = pow(w0 / w, 0.7) * (1.0 + hero * 0.35);
  // 縁は光の来る側ほど明るい
  vec2 nq = d > 1e-4 ? q / d : vec2(0.0);
  float facing = 0.35 + 0.65 * smoothstep(-0.4, 1.0, dot(nq, vDir));
  float ring = exp(-pow((d - 1.0) / w, 2.0)) * facing * energy;
  float fill = 1.0 - smoothstep(0.55, 1.0 + blur, d);
  float spot = exp(-length(q - vDir * 0.5) / (0.12 + blur * 0.4)) * energy;
  // 小さな泡は輪郭より「光の点」として瞬く
  float tiny = 1.0 - smoothstep(2.0, 5.0, vRadPx);
  spot *= 1.0 + tiny * (0.8 + 0.6 * sin(uTime * 6.0 + seed * 40.0));
  // 大きな泡は、反対側の内縁にもう一つ淡い反射
  float ring2 = exp(-pow((d - 0.8) / (w * 1.4), 2.0)) * smoothstep(0.2, 1.0, dot(nq, -vDir)) * energy * hero;
  // ほどけるほど、粒の穴があいていく
  float holes = smoothstep(0.35, 0.65, noise(gl_FragCoord.xy * 0.35 + seed * 91.0 + uTime * 0.6) + env * 0.55);
  env *= 1.0 - vNear * 0.55;   // 手前の大きくボケた泡は淡い
  float glow = (ring * 0.95 + ring2 * 0.35 + fill * (0.08 + hero * 0.1) + spot * 0.8) * env * holes;
  // ごく小さな泡は輪郭を描かず、光の点にする
  float dotMode = 1.0 - smoothstep(1.4, 2.6, vRadPx);
  // 点は最低でも 1.5px ほどの光の粒として見えるように（粒子に埋もれない明るさ）
  vec2 qp = (gl_PointCoord * 2.0 - 1.0) * (vRadPx * vPad + 1.0);
  float dotGlow = exp(-dot(qp, qp) / 1.6) * (2.4 + 0.9 * sin(uTime * 5.0 + seed * 40.0)) * env;
  glow = mix(glow, dotGlow, dotMode);
  glow *= edgeFade;
  fill *= edgeFade;
  if (glow < 0.002 && fill * env < 0.002) discard;
  o = vec4(glow, fill * env, 0.0, 1.0);
}`;

export function createBubbleNet(gl: WebGL2RenderingContext) {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.bindAttribLocation(prog, 1, "aB");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const n of ["uAspect", "uPersp", "uOffset", "uH", "uMaxPt", "uTime"]) u[n] = gl.getUniformLocation(prog, n);
  const maxPt = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1] || 64;

  const data = new Float32Array(MAX * STRIDE);
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE * 4, 12);
  gl.bindVertexArray(null);

  const bubbles: Bubble[] = [];
  let clock = 0;
  let nextBurst = 1.5;
  let burstEnd = 0;
  let carry = 0;
  let surface = -1.5;

  const spawn = (at: V3, P: BubbleParams, spread: number, sizeMul = 1) => {
    if (bubbles.length >= MAX) bubbles.shift();
    // 大きさは 3 段階から選ぶ（大 1 : 中 3 : 小 8）。
    // 小はさらに 3 つに分ける（小の中で 大きめ 2 : 中くらい 4 : 小さめ 10）。段階の中でもばらつかせる。
    // 大小の強弱（contrast）を下げるほど段階どうしが近づき、上げるほど差が開く
    const roll = Math.random() * 12;
    const tier = roll < 1 ? 2 : roll < 4 ? 1 : 0;
    let c0: number;
    if (tier === 2) c0 = 0.95 + (Math.random() - 0.5) * 0.5;
    else if (tier === 1) c0 = 0.32 + (Math.random() - 0.5) * 0.24;
    else {
      const sub = Math.random() * 16;
      c0 = sub < 2 ? 0.13 + (Math.random() - 0.5) * 0.04      // 小の大きめ
         : sub < 6 ? 0.065 + (Math.random() - 0.5) * 0.03    // 小の中くらい
         : 0.022 + (Math.random() - 0.5) * 0.02;             // 小の小さめ
    }
    const big = Math.max(0, 0.32 + (c0 - 0.32) * P.contrast) * sizeMul;
    const hero = tier === 2 && Math.random() < 0.35 * Math.min(P.contrast, 1.5) ? 1 : 0;
    const r = (Math.random() - 0.5) * 2;
    const a = Math.random() * Math.PI * 2;
    bubbles.push({
      p: [at[0] + Math.cos(a) * spread * r, at[1] + Math.sin(a) * spread * r, at[2]],
      // 吐き出された勢いで横へ広がり、泡のカーテンになる
      vel: [Math.cos(a) * 0.03 * Math.random(), Math.sin(a) * 0.03 * Math.random(), 0],
      // 一番小さな泡はほぼ点（半径の下限を小さく）
      r0: (0.0012 + 0.039 * big) * P.size * (1 + hero * 0.4),
      vz: 0,
      s: big,
      seed: Math.random(),
      hero,
      age: 0,
    });
  };

  return {
    /**
     * 泡を吐き出し、浮かばせる。
     * emitters: 泡を吐くクジラの噴気孔の位置（カメラより深い = z が大きい）, surfaceZ: 水面の高さ
     */
    update(dt: number, emitters: V3[], surfaceZ: number, P: BubbleParams) {
      if (dt <= 0) return;
      clock += dt;
      if (clock > nextBurst) {
        burstEnd = clock + 1.0 + Math.random() * 0.8;
        nextBurst = clock + P.rhythm * (0.7 + Math.random() * 0.6);
      }
      const bursting = clock < burstEnd;
      const rate = (bursting ? 32 : 3) * P.amount * emitters.length;
      carry += rate * dt;
      while (carry >= 1 && emitters.length) {
        carry -= 1;
        spawn(emitters[Math.floor(Math.random() * emitters.length)], P, bursting ? 0.11 : 0.05);
      }

      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        b.age += dt;
        if (b.p[2] < surfaceZ || b.age > 38) { bubbles.splice(i, 1); continue; }
        // 浮上速度は泡の大きさで決まる（終端速度）。
        // 小さな泡: 水の粘りに負けてゆっくり（ストークスの法則, 速さ ∝ 半径²）
        // 中くらい: いちばん速い / 大きな泡: 形が潰れて揺れ、少し遅くなって頭打ち
        const sz = b.s;
        // 実際の速さの比を、画面の時間に収まるよう圧縮している（小 : 中 : 大 ≒ 1 : 3 : 2.5）
        let vt = 0.32 + 0.72 * (1 - Math.exp(-Math.pow(sz / 0.28, 2))) - 0.18 * smooth01((sz - 0.5) / 0.5);
        vt *= 0.88 + 0.24 * b.seed;                                   // 泡ごとの個体差
        // 大きな泡は揺れながら上るので、速さにも緩急がつく
        const wobbleF = 2.0 + 3.0 * b.seed;
        vt *= 1 + 0.18 * smooth01((sz - 0.25) / 0.6) * Math.sin(b.age * wobbleF + b.seed * 9);
        // 生まれた直後は止まっていて、だんだん加速する（小さな泡ほど早く終端速度に達する）
        const tau = 0.15 + 0.6 * sz;
        b.vz += (vt - b.vz) * (1 - Math.exp(-dt / tau));
        // 横の動き: 大きな泡はジグザグ・らせんに揺れる。小さな泡は水の流れに流される
        const zig = Math.sin(b.age * wobbleF + b.seed * 6.28) * 0.016 * smooth01((sz - 0.2) / 0.6);
        const drift = 0.02 * (1 - smooth01(sz / 0.3));
        const fx = Math.sin(b.p[1] * 3.1 + clock * 0.23) + 0.5 * Math.sin(b.p[2] * 1.7 - clock * 0.17);
        const fy = Math.cos(b.p[0] * 2.7 - clock * 0.19) + 0.5 * Math.cos(b.p[2] * 1.3 + clock * 0.21);
        b.vel[0] *= 1 - dt * 0.35;
        b.vel[1] *= 1 - dt * 0.35;
        b.p[0] += (b.vel[0] + zig * Math.cos(b.seed * 9 + b.age * 0.7) + fx * drift) * dt;
        b.p[1] += (b.vel[1] + zig * Math.sin(b.seed * 9 + b.age * 0.7) + fy * drift) * dt;
        b.p[2] -= b.vz * 0.95 * P.rise * dt;
      }
      surface = surfaceZ;
    },
    draw(style: { aspect: number; persp: number; offset: [number, number]; height: number; time: number }) {
      const n = bubbles.length;
      for (let i = 0; i < n; i++) {
        const b = bubbles[i], o = i * STRIDE;
        // 水面の手前で、粒の穴があいて溶けていく
        const toSurface = Math.min(Math.max((b.p[2] - surface) / 1.2, 0), 1);
        const t = Math.min(b.age / 14, 1);
        const env = Math.min(b.age / 0.35, 1) * toSurface * (1 - smooth01((b.age - 32) / 6));
        data[o] = b.p[0]; data[o + 1] = b.p[1]; data[o + 2] = b.p[2];
        data[o + 3] = b.r0 * (1 + 0.4 * t);           // 浮かぶにつれて少し膨らむ
        data[o + 4] = b.seed; data[o + 5] = env; data[o + 6] = b.hero;
      }
      if (!n) return;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * STRIDE);
      gl.useProgram(prog);
      gl.uniform1f(u.uAspect, style.aspect);
      gl.uniform1f(u.uPersp, style.persp);
      gl.uniform2f(u.uOffset, style.offset[0], style.offset[1]);
      gl.uniform1f(u.uH, style.height);
      gl.uniform1f(u.uMaxPt, maxPt);
      gl.uniform1f(u.uTime, style.time);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    },
    /**
     * 画面上の位置（中心 0、高さ 1 の座標）に泡を生む。カーソルやタッチの軌跡用。
     * 泡はカメラのすぐ上（手前）で生まれ、そこから水面へ上っていく
     */
    spawnAtScreen(sx: number, sy: number, persp: number, offset: [number, number], P: BubbleParams, n: number) {
      const denom = 0.42;                          // 生まれる深さ: カメラのすぐ上
      const z = (1 - denom) / Math.max(persp, 0.01);
      const k = 1 / denom;
      for (let i = 0; i < n; i++) {
        spawn([(sx - offset[0]) / k, (sy - offset[1]) / k, z], P, 0.006, 0.3);
        bubbles[bubbles.length - 1].r0 *= 0.45;   // 手前で生まれるので、元の大きさは小さめ
        const b = bubbles[bubbles.length - 1];
        b.vel = [(Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02, 0];
      }
    },
    count: () => bubbles.length,
    dispose() {
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog);
    },
  };
}
