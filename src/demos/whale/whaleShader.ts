/**
 * ザトウクジラの皮膚（下から見上げた姿）を描く GLSL。
 * 形は whaleModel.ts が出す骨格（関節・胸ビレ・尾ビレ）から作る。
 * 本編のシェーダーにもそのまま差し込めるよう、名前はすべて w / uW で始める。
 */
import { JOINTS } from "./whaleModel";

export const WHALE_GLSL = `
#define W_JOINTS ${JOINTS}
uniform vec4 uWJoint[W_JOINTS]; // xy: 位置, z: 半幅, w: 体の位置 s
uniform vec4 uWFinA[2];         // xy: 付け根, zw: 先端
uniform vec4 uWFinB[2];         // xy: 頭の向き, z: 付け根の幅
uniform vec4 uWFlukeA;          // xy: 付け根, zw: 後ろ向きの軸
uniform vec4 uWFlukeB;          // xy: 左右の軸, z: 片翼の長さ, w: 翼弦
uniform float uWRoll;
uniform float uWLen;            // 体長（画面の高さ比）
uniform float uWPx;             // 1 ピクセルの大きさ
uniform float uWBase;           // 体の暗さ
uniform float uWBelly;          // お腹の明るさ（下からの回り込みの光）
uniform float uWPleats;         // 喉の畝
uniform float uWFinWhite;       // 胸ビレの白さ
uniform float uWFlukeWhite;     // 尾ビレの裏の白い模様
uniform float uWRim;            // 逆光の縁
uniform float uWBlur;           // ボケ（遠さ）
uniform float uWFog;            // 水の霞

float wHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y);
}
float wSmin(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// x: 距離, y: 部位（0 体 / 1 胸ビレ / 2 尾ビレ）, z: 横方向の位置（-1〜1）, w: 体の位置 s
vec4 whaleSDF(vec2 p){
  // 胴: 関節をつなぐ、太さの変わるカプセル
  float body = 1e9, lat = 0.0, sAt = 0.0;
  for (int i = 0; i < W_JOINTS - 1; i++) {
    vec4 a = uWJoint[i], b = uWJoint[i + 1];
    vec2 pa = p - a.xy, ba = b.xy - a.xy;
    float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    vec2 q = pa - ba * t;
    float r = mix(a.z, b.z, t);
    float d = length(q) - r;
    if (d < body) {
      body = d;
      vec2 dir = normalize(ba);
      lat = (dir.x * q.y - dir.y * q.x) / max(r, 1e-4);
      sAt = mix(a.w, b.w, t);
    }
  }

  // 胸ビレ: 長く、先へ向かって後ろへ反る。前縁にはコブ（結節）が並ぶ
  float fin = 1e9, finLat = 0.0;
  for (int k = 0; k < 2; k++) {
    vec2 root = uWFinA[k].xy, tip = uWFinA[k].zw;
    vec2 ax = tip - root;
    float Lf = max(length(ax), 1e-4);
    ax /= Lf;
    vec2 pp = vec2(-ax.y, ax.x);
    if (dot(pp, uWFinB[k].xy) < 0.0) pp = -pp;   // pp は前縁側
    float cr = uWFinB[k].z;
    vec2 q = p - root;
    float w = dot(q, ax) / Lf;
    float c = dot(q, pp) / cr + 0.9 * w * w;
    float wc = clamp(w, 0.0, 1.0);
    float chord = (1.0 - 0.7 * wc) * sqrt(max(1.0 - pow(wc, 8.0), 0.0));
    float bumps = 0.09 * pow(abs(sin(wc * 3.14159 * 9.0)), 0.7) * smoothstep(0.12, 0.35, wc);
    float ef = (0.5 + bumps) * chord;
    float eb = 0.5 * chord;
    float d = max(max(c - ef, -c - eb) * cr, max(-w, w - 1.0) * Lf);
    if (d < fin) { fin = d; finLat = clamp(c / max(0.5 * chord, 0.05), -1.0, 1.0); }
  }

  // 尾ビレ: 先端が後ろへ流れ、後縁はギザギザで中央に切れ込み
  vec2 q = p - uWFlukeA.xy;
  float span = max(uWFlukeB.z, 1e-4), ch = max(uWFlukeB.w, 1e-4);
  float u = dot(q, uWFlukeA.zw) / ch;
  float v = dot(q, uWFlukeB.xy) / span;
  float av = abs(v);
  float uc = 0.15 + 0.6 * av * av;
  float th = 0.5 * pow(max(1.0 - pow(min(av, 1.0), 2.2), 0.0), 0.55);
  float uf = uc - th * 0.8;
  float ub = uc + th - 0.22 * exp(-pow(v / 0.07, 2.0)) + 0.035 * sin(av * 40.0) * smoothstep(0.25, 0.9, av);
  float fluke = max(max(uf - u, u - ub) * ch, (av - 1.0) * span);

  float k = 0.008 * uWLen;
  float d = wSmin(wSmin(body, fin, k), fluke, k * 0.6);
  float part = (fin < body && fin < fluke) ? 1.0 : (fluke < body ? 2.0 : 0.0);
  float l = part == 1.0 ? finLat : (part == 2.0 ? v : lat);
  return vec4(d, part, l, sAt);
}

// 戻り値 x: 明るさ, y: 不透明度, z: シルエットの外側ににじむ光
vec3 whaleShade(vec2 p, float bg){
  vec4 w = whaleSDF(p);
  float d = w.x;
  float soft = uWPx * 1.2 + uWBlur * 0.012 * uWLen;
  float alpha = 1.0 - smoothstep(-soft, soft, d);

  // 腹側の丸み: 下から回り込む弱い光。傾くと明るい面が横へずれる
  float lat = clamp(w.z - sin(uWRoll) * 0.45, -1.0, 1.0);
  float nz = sqrt(max(1.0 - lat * lat, 0.0));
  float lum = uWBase;

  if (w.y == 0.0) {
    // 下から回り込む光は弱い。周りが明るいところほど、お腹もわずかに明るい
    lum += uWBelly * 0.12 * nz * (0.35 + bg * 0.9);
    // 喉の畝: 顎から体の中ほどまで、体軸に沿って並ぶ溝。
    // 間隔は均一にせず、顎の先へ向かって寄り集まり、後ろの端はばらけて消える
    float s = w.w;
    float mask = smoothstep(0.03, 0.12, s) * (1.0 - smoothstep(0.34, 0.5 + 0.06 * wNoise(vec2(w.z * 9.0, 3.0)), s))
               * (1.0 - pow(abs(w.z), 2.5));
    float zz = w.z * (1.0 + 0.35 * (1.0 - smoothstep(0.03, 0.25, s)));
    zz += (wNoise(vec2(w.z * 6.0, s * 4.0)) - 0.5) * 0.06;
    float groove = pow(0.5 + 0.5 * cos(zz * 3.14159 * 12.0), 8.0);
    lum += mask * uWPleats * (0.01 - groove * 0.035) * (0.5 + bg);
  } else if (w.y == 1.0) {
    // 胸ビレの裏は白い。縁に向かってまだらに黒が混ざる
    float mott = smoothstep(0.35, 0.7, wNoise(p / uWLen * 40.0));
    lum += uWFinWhite * 0.4 * (0.65 + 0.35 * nz) * (1.0 - mott * 0.35 * abs(w.z));
  } else {
    // 尾ビレの裏の白黒の模様（個体ごとに違う）
    float pat = smoothstep(0.45, 0.62, wNoise(p / uWLen * 14.0) * 0.7 + wNoise(p / uWLen * 45.0) * 0.3);
    lum += uWFlukeWhite * 0.32 * pat;
  }

  // 薄い部分（ヒレと尾の縁）は、逆光が透ける
  float thin = exp(min(d, 0.0) / (0.006 * uWLen));
  lum += thin * uWRim * 0.22 * bg * (w.y > 0.5 ? 1.0 : 0.35);

  // 水の霞: 遠いほど背景に溶ける
  lum = mix(lum, bg, uWFog);

  // 逆光で、シルエットの外側に光がにじむ
  float halo = exp(-max(d, 0.0) / (0.012 * uWLen + uWBlur * 0.01)) * uWRim * 0.16 * bg * (1.0 - alpha);
  return vec3(lum, alpha, halo);
}
`;

/** 姿勢を uniform に流し込む */
export function setWhaleUniforms(
  gl: WebGL2RenderingContext,
  u: Record<string, WebGLUniformLocation | null>,
  pose: import("./whaleModel").WhalePose,
) {
  const j = new Float32Array(JOINTS * 4);
  pose.joints.forEach((p, i) => j.set([p.x, p.y, p.hw, p.s], i * 4));
  gl.uniform4fv(u.uWJoint, j);
  gl.uniform4fv(u.uWFinA, new Float32Array(pose.fins.flatMap((f) => [f.root.x, f.root.y, f.tip.x, f.tip.y])));
  gl.uniform4fv(u.uWFinB, new Float32Array(pose.fins.flatMap((f) => [f.fwd.x, f.fwd.y, f.chord, 0])));
  const fl = pose.fluke;
  gl.uniform4f(u.uWFlukeA, fl.root.x, fl.root.y, fl.back.x, fl.back.y);
  gl.uniform4f(u.uWFlukeB, fl.side.x, fl.side.y, fl.span, fl.chord);
  gl.uniform1f(u.uWRoll, pose.roll);
}
