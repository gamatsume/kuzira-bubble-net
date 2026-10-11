/**
 * WhaleRipple — ザトウクジラのバブルネットの内側から、光の差す水面を見上げる。触れると波紋が広がる。
 *
 * 依存ゼロ（React + 素の WebGL2）。クジラは ./whale/ 以下のモジュールを使う。
 * Figma Make には App.tsx と whale/ フォルダを合わせて貼り付ける。
 *
 * - 波紋: GPU 上の高さ場で波動方程式を解いている（ping-pong FBO）
 * - 光: 水中から見上げた光の円、放射状の光の筋、揺らぐ水面
 * - 泡: らせん状に閉じていくバブルネット（4 層、大小の泡）
 * - クジラ: 骨格から組み立てた点と線のポリゴン。光源のまわりを奥行きのある八の字で泳ぐ
 * - クリックで大きな波紋。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createWhaleOnFigure8, skeleton3D, stepWhale, type WhaleParams } from "./whale/whaleModel";
import { createWhaleMesh, updateWhaleMesh } from "./whale/whaleMesh";
import { createWhaleRenderer } from "./whale/whaleMeshGL";
import { WHALE_LOOK, WHALE_SWIM } from "./whale/whaleDefaults";
import { createBubbleNet } from "./whale/bubbleNet";

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const MAX_DROPS = 16;
const MAX_PIXELS = 1920 * 1080;

const SIM = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uAspect;
uniform float uDamping;
uniform vec4 uDrops[${MAX_DROPS}];
uniform int uDropCount;
void main(){
  vec2 s = texture(uState, vUv).rg;
  float n = texture(uState, vUv + vec2(uTexel.x, 0.0)).r
          + texture(uState, vUv - vec2(uTexel.x, 0.0)).r
          + texture(uState, vUv + vec2(0.0, uTexel.y)).r
          + texture(uState, vUv - vec2(0.0, uTexel.y)).r;
  float h = (n * 0.5 - s.g) * uDamping;
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= uDropCount) break;
    vec2 d = vUv - uDrops[i].xy;
    d.x *= uAspect;
    float f = max(0.0, 1.0 - length(d) / uDrops[i].z);
    h += (0.5 - 0.5 * cos(f * 3.14159265)) * uDrops[i].w;
  }
  o = vec4(h, s.r, 0.0, 1.0);
}`;

const RENDER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uAspect;
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform sampler2D uWhaleTex; // ポリゴンのクジラを描いたレイヤー（色は光の足し算、アルファは面の覆い）
uniform sampler2D uBubbleTex; // クジラが吐いた泡のレイヤー（R: 光る量, G: 泡の濃さ）
uniform float uAmbient;      // 背景の泡の輪（クジラと無関係に、輪の上に散らばる泡）
uniform vec2 uPx;            // 1 ピクセル（uv）
uniform float uHalation;     // 光のにじみ（ハレーション）
uniform float uSunCore;      // 太陽の芯の強さ
uniform float uDirect;       // 直射光（太陽・光の筋）の移ろい
// コントローラーから調整する値（1.0 が標準）
uniform float uBubbleTime;   // 泡の時間（泡の速さを積算したもの）
uniform float uGrain;        // ノイズの強さ
uniform float uGrainSize;    // 粒の大きさ（px）
uniform float uBubbleAmount; // 泡の出方
uniform float uBubbleSize;   // 泡の大きさ
uniform float uBubbleContrast; // 大小の強弱
uniform float uLight;        // 光の強さ
uniform float uRays;         // 光の筋
uniform float uSurface;      // 水面の模様
uniform float uWindowSize;   // 光の円の大きさ
uniform float uMotes;        // 漂う微粒子
uniform float uContrast;     // コントラスト
uniform float uSaturation;   // 彩度（0 = モノクロ）
uniform vec3 uTint;          // 色
uniform vec2 uCenter;        // 光源（構図の中心）の位置
uniform float uSpiral;       // らせんの開き
uniform float uSpinAngle;    // らせんの回転角（回転の速さを積算したもの）
uniform float uVignette;     // 周辺減光
uniform float uShimmer;      // 光の揺らぎ
uniform float uShimmerTime;  // 揺らぎの時間（揺らぎの速さを積算したもの）
// 水深と太陽から決まる光（JS 側で計算して渡す。水深 8m を 1.0 とする）
uniform float uDepthLight;   // 届く光の量（深いほど減衰する）
uniform float uEdgeSoft;     // 光の円の縁のぼけ（深いほど散乱でぼける）
uniform float uSurfScale;    // 水面の模様の細かさ（深いほど遠く、細かく見える）
uniform float uSurfContrast; // 水面の模様の濃さ
uniform float uRayReach;     // 光の筋の届く長さ
uniform float uRayGain;      // 光の筋の強さ
uniform float uHaze;         // 水の霞
uniform float uSunSpread;    // 太陽のにじみの広がり（前方散乱）
uniform vec2 uSunOff;        // 光の円の中での太陽の位置（太陽の高さと方角から）

float H(vec2 uv){ return texture(uState, uv).r; }

// レイヤーを柔らかく読む（中心 + 周囲 8 方向）。線や泡の輪郭をフィルムに写ったように丸める
vec4 softTap(sampler2D t, vec2 uv, vec2 r){
  vec4 s = texture(t, uv) * 0.36;
  s += (texture(t, uv + vec2(r.x, 0.0)) + texture(t, uv - vec2(r.x, 0.0))
      + texture(t, uv + vec2(0.0, r.y)) + texture(t, uv - vec2(0.0, r.y))) * 0.1;
  s += (texture(t, uv + r * 0.7) + texture(t, uv - r * 0.7)
      + texture(t, uv + vec2(r.x, -r.y) * 0.7) + texture(t, uv + vec2(-r.x, r.y) * 0.7)) * 0.06;
  return s;
}
// 光のにじみ（明るいところのまわりに広がる）
vec4 haloTap(sampler2D t, vec2 uv, vec2 r){
  vec4 s = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982 + 0.39;
    s += texture(t, uv + vec2(cos(a), sin(a)) * r);
  }
  return s / 8.0;
}

vec2 rot(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c*v.x - s*v.y, s*v.x + c*v.y); }

float hash1(float x){ return fract(sin(x * 127.1) * 43758.5453); }
float noise1(float x){
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash1(i), hash1(i + 1.0), f);
}
float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise2(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}

// 見上げた水面の中心から、放射状に降りてくる光の筋。細い筋が束になり、奥で霞にほどける。
// 角度のノイズはすべて円周上の座標（cos, sin）で取り、角度の継ぎ目が出ないようにする
float rays(vec2 p, float t, float st){
  float dist = length(p);
  vec2 cs0 = p / max(dist, 1e-4);
  // 揺らぎ: 筋ごとに違うリズムでゆっくり左右に揺れ、根元から先へ向かってわずかにうねる
  float sway = (fbm(cs0 * 1.6 + vec2(st * 0.11, -st * 0.08)) - 0.5) * 0.07
             + (noise2(cs0 * 6.0 + vec2(dist * 2.2 - st * 0.5, st * 0.3)) - 0.5) * 0.04 * smoothstep(0.1, 0.7, dist);
  vec2 cs = rot(cs0, sway * uShimmer);
  float broad = fbm(cs * 3.0 + t * 0.03);
  float fine = fbm(cs * 18.0 - t * 0.06) * 0.6 + fbm(cs * 41.0 + t * 0.09) * 0.4;
  float r = smoothstep(0.35, 0.75, broad) * 0.55 + pow(smoothstep(0.4, 0.85, fine), 2.0) * 0.75;
  // ごく細い光の糸。根元ほどはっきりし、揺らぎに合わせてきらめく
  float thread = noise2(cs * 95.0 + vec2(st * 0.12, -st * 0.1)) * noise2(cs * 57.0 - vec2(st * 0.08, st * 0.14) + 3.0);
  r += pow(smoothstep(0.35, 0.8, thread), 2.5) * 0.5 * exp(-dist * 1.2 / uRayReach) * min(uShimmer, 1.5);
  // 明滅: 筋ごとに明るさがゆっくり呼吸する（規則的な点滅にはしない）
  float breathe = fbm(cs * 11.0 + vec2(st * 0.23, -st * 0.19));
  r *= mix(1.0, 0.35 + 1.3 * breathe, 0.7 * min(uShimmer, 1.5));
  r *= 0.55 + 0.45 * fbm(cs * 3.0 + vec2(dist * 3.5 - t * 0.3));
  return r * exp(-dist * 1.5 / uRayReach);
}

// 泡の輪 1 層ぶん。円周に K 個の泡が並び、浮き上がりながら（見上げているので中心へ寄りながら）
// 縮んで、揺れて、溶けて、また生まれる。
// sizeScale: 泡の大きさ, blurBias: 手前ほどボケる（被写界深度）, heroes: ごく稀な大きな泡を混ぜるか。
// out: 光る量 / 泡の濃さ
vec2 bubbleLayer(vec2 p, float K, float R0, float speed, float seed, float t, float sizeScale, float blurBias, float heroes){
  // 全層で同じ向きに回す（らせんの継ぎ目を揃える）
  vec2 pr = rot(p, -uSpinAngle - seed * 0.04);
  float cellF = atan(pr.y, pr.x) / 6.2831853 * K;
  float ci = floor(cellF);
  float glowSum = 0.0, body = 0.0;
  for (int k = -1; k <= 1; k++) {
    float idx = ci + float(k);
    float id = mod(idx, K);
    float h1 = hash1(id * 1.37 + seed * 11.0);
    float h2 = hash1(id * 2.91 + seed * 7.0);
    float h3 = hash1(id * 5.17 + seed * 3.0);
    float h4 = hash1(id * 8.03 + seed * 5.0);
    // 小さな泡が大半。大きな泡はわずかで、ごく稀にひときわ大きな泡が混ざる
    float big = pow(h4, 1.0 + 1.6 * uBubbleContrast);
    float hero = heroes * smoothstep(0.955, 0.975, h4 + (uBubbleContrast - 1.0) * 0.03) * min(uBubbleContrast, 1.5);
    // 大きな泡ほどゆっくり上る
    float life = fract(t * speed * (0.7 + 0.6 * h1) * (1.0 - 0.25 * big - 0.3 * hero) + h2);
    float a = (idx + 0.5 + (h3 - 0.5) * 0.8 * (1.0 - hero)) / K * 6.2831853;
    // らせん: 円周を一周するあいだに半径が広がる。外側の端がいま泡を吐いているところ
    float fr = id / K;
    float r = R0 * (1.0 + 0.38 * uSpiral * (fr - 0.5)) * (1.0 - 0.4 * life) + (h1 - 0.5) * 0.07;
    float size = mix(0.007, 0.05, big) * sizeScale * (1.0 - 0.45 * life) * (0.75 + 0.45 * fr);
    size *= (1.0 + hero * 0.6) * uBubbleSize;
    vec2 c = r * vec2(cos(a), sin(a));
    c += vec2(sin(t * 1.3 + h3 * 6.28), cos(t * 1.1 + h1 * 6.28)) * 0.006;
    vec2 q = pr - c;
    float d = length(q);
    // 大きな泡ほど、ぷるぷると歪む
    float th = atan(q.y, q.x);
    float jelly = big + hero * 0.5;
    d *= 1.0 + (sin(th * 2.0 + t * 1.9 + h1 * 6.28) * 0.04 * hero
              + sin(th * 3.0 + t * 2.7 + h1 * 6.28) * 0.06
              + sin(th * 5.0 - t * 3.3 + h3 * 6.28) * 0.03) * jelly;
    // 被写界深度: 大きい（手前の）泡ほど縁が太くボケて、暗くなる
    float blur = blurBias * (0.2 + big * 1.1) + hero * 0.3;
    float w0 = max(size * 0.18, 0.0024);
    float w = w0 + blur * 0.01;
    float energy = pow(w0 / w, 0.7) * (1.0 + hero * 0.35);
    // 輪の粗密: 泡の群れと隙間、ところどころに濃い泡の柱
    float clump = smoothstep(0.22, 0.55, noise1(fr * 9.0 + seed * 5.0 + t * 0.04) + (uBubbleAmount - 1.0) * 0.4);
    clump = max(clump, smoothstep(0.75, 0.95, noise1(fr * 23.0 + seed * 2.0)) * 1.4);
    // 吐いたばかりの外側の端は濃く、古い内側の端ほど薄れていく
    clump *= (0.3 + 0.7 * smoothstep(0.0, 0.55, fr)) * min(uBubbleAmount * 2.0, 1.0);
    // 膨らんで生まれ、上りきる前にほどける
    float env = smoothstep(0.0, 0.18, life) * (1.0 - smoothstep(0.5, 1.0, life)) * clump;
    // ほどけるほど、粒の穴があいていく
    float holes = smoothstep(0.35, 0.65, noise2(pr * 140.0 + id * 7.0 + t * 0.6) + env * 0.55);
    // 縁は光の来る側（中心向き）ほど明るい
    float facing = 0.35 + 0.65 * smoothstep(-0.4, 1.0, dot(q / max(d, 1e-4), -normalize(c)));
    float ring = exp(-pow((d - size) / w, 2.0)) * facing * energy;
    float fill = 1.0 - smoothstep(size * 0.55, size + blur * 0.01, d);
    vec2 hp = c - normalize(c) * size * 0.5;
    float spot = exp(-length(pr - hp) / (size * 0.12 + blur * 0.004)) * energy;
    // 小さな泡は輪郭より「光の点」として瞬く
    float tiny = 1.0 - smoothstep(0.006, 0.014, size);
    spot *= 1.0 + tiny * (0.8 + 0.6 * sin(t * 6.0 + h3 * 40.0)) * uBubbleContrast;
    // 大きな泡は、反対側の内縁にもう一つ淡い反射が入り、身体がうっすら透ける
    float facing2 = smoothstep(0.2, 1.0, dot(q / max(d, 1e-4), normalize(c)));
    float ring2 = exp(-pow((d - size * 0.8) / (w * 1.4), 2.0)) * facing2 * energy * hero;
    glowSum += (ring * 0.95 + ring2 * 0.35 + fill * (0.08 + hero * 0.1) + spot * 0.8) * env * holes;
    body += fill * env;
  }
  return vec2(glowSum, body);
}

vec2 hash22(vec2 p){
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// 水面を下から見上げた明るさ。
// 向きと波長の違う波をいくつも重ねた面（実際の海面と同じ考え方）。模様は流れず、波の重なりでその場できらめく。
// 波の面ごとに、空（太陽）が映るか、傾きすぎて水面の裏で反射する（暗い）かが決まり、
// 光が集まる凹みには細い光の線が出る
float surfaceLight(vec2 q, float t){
  vec2 grad = vec2(0.0);
  float lap = 0.0;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float ang = 0.6 + (hash1(fi * 3.17 + 1.0) - 0.5) * 2.6;        // 風向きのまわりに散らばる
    vec2 d = vec2(cos(ang), sin(ang));
    float lam = mix(0.28, 1.5, pow(hash1(fi * 7.73 + 2.0), 1.3));    // 波長
    float k = 6.2831853 / lam;
    float w = sqrt(9.8 * k) * 0.16;                                  // 深水波の分散関係（長い波ほど速い）
    float a = 0.085 / k;                                             // 波の険しさは波長によらずほぼ一定
    float ph0 = hash1(fi * 1.31) * 6.2831853;
    // 高さ方向（Z）の変化:
    // 1) うねりの群れ: 波の高さがゆっくり膨らんでは萎む（模様が生まれては消える）
    float grp = 0.45 + 0.55 * (0.5 + 0.5 * sin(t * (0.11 + 0.17 * hash1(fi * 5.9)) + ph0 * 2.0));
    // 2) 定在波: 逆向きの波と重なり、その場で山と谷が入れ替わる（流れずに上下する）
    float stand = 0.35 * hash1(fi * 9.13 + 4.0);
    float sx = dot(d, q) * k + ph0;
    float wt = w * t;
    // 進む波 (1 - stand) + その場で上下する波 stand
    float cx = cos(sx), sxn = sin(sx), cw = cos(wt), sw = sin(wt);
    float cP = cx * cw + sxn * sw, sP = sxn * cw - cx * sw;      // cos/sin(sx - wt)
    float cS = cx * cw, sS = sxn * cw;
    float A = a * grp;
    grad += d * (A * k * ((1.0 - stand) * cP + stand * cS));
    lap -= A * k * k * ((1.0 - stand) * sP + stand * sS);
  }
  // 屈折した視線の向き ≒ 面の傾き。傾きすぎた面は空ではなく水中が映る（全反射）
  vec2 dir = grad * 2.3;
  float tilt = length(dir);
  float sky = 1.0 - smoothstep(0.5, 0.58, tilt);
  vec2 sd = dir - vec2(0.08, 0.12);
  float bright = sky * (0.5 + 0.5 * exp(-dot(sd, sd) * 7.0));
  // 光が集まる凹み: つながった細い光の線（凹みの強さが一定の値を横切るところ）
  float cv = -lap * 0.32;
  float lines = (smoothstep(0.35, 0.6, cv) * 0.55 + exp(-pow((cv - 0.42) / 0.11, 2.0)) * 0.6) * sky;
  // 全反射との境目に出る、細い明るい縁
  float rim = exp(-pow((tilt - 0.54) / 0.035, 2.0)) * 0.7;
  return 0.04 + bright * 0.6 + lines * 0.6 + rim * 0.4;
}

// 水中に漂う微粒子（マリンスノー）。光の中でだけ瞬く
float motes(vec2 p, float t, float cell, float seed){
  vec2 q = p / cell + vec2(seed * 7.0, -t * 0.12 / cell * 0.02);
  vec2 i = floor(q), f = fract(q);
  vec2 h = hash22(i + seed);
  if (h.x > 0.35) return 0.0;
  vec2 c = 0.2 + 0.6 * hash22(i * 1.7 + seed + 3.0) + 0.12 * vec2(sin(t * 0.5 + h.y * 6.28), cos(t * 0.4 + h.x * 6.28));
  float d = length(f - c);
  float tw = 0.5 + 0.5 * sin(t * (1.0 + h.y * 2.0) + h.x * 30.0);
  return exp(-d * d / 0.004) * tw;
}

void main(){
  vec2 e = uTexel;
  float hc = H(vUv);
  float hx = H(vUv + vec2(e.x, 0.0)) - H(vUv - vec2(e.x, 0.0));
  float hy = H(vUv + vec2(0.0, e.y)) - H(vUv - vec2(0.0, e.y));
  vec3 n = normalize(vec3(-hx, -hy, 0.35));

  // 屈折: 水面の傾きぶん、上の世界をずらして見る
  vec2 uvR = vUv + n.xy * 0.045;
  // 短辺を基準にし、泡の輪の外周まで画面に収める
  vec2 p = (uvR - 0.5) * vec2(uAspect, 1.0) / min(uAspect, 1.0) * 1.06 - uCenter;
  float t = uTime;
  float rad = length(p);

  float st = uShimmerTime;
  // 光の筋は太陽の位置から放射状に降りてくる
  float c = rays(p - uSunOff, t, st) * uRays * uLight * uRayGain * uDepthLight * uDirect;
  float radS = length(p - uSunOff);

  // 頭上の光の円。硬い縁ではなく、太陽の芯から柔らかくにじむ光として描く。
  // 水面越しの景色は陽炎のようにかすかに揺らぐ
  vec2 pw = p + (vec2(noise2(p * 8.0 + st * 0.5), noise2(p * 8.0 - st * 0.45 + 7.0)) - 0.5) * 0.014 * uShimmer;
  float radW = length(pw);
  vec2 cs = pw / max(radW, 1e-4);
  float wob = (fbm(cs * 3.0 + t * 0.15) - 0.5) * 0.03
            + (noise2(cs * 14.0 + t * 1.1) - 0.5) * 0.012;
  float R = 0.27 * uWindowSize;
  float dw = radW - (R + wob);
  // 円の縁は光の筋に沿って溶け出し、水面と光の境目をなくす
  float window = 1.0 - smoothstep(-0.05 * uEdgeSoft, 0.03 * uEdgeSoft, dw - c * 0.07 * uShimmer);
  float outside = max(dw, 0.0);
  float glow = exp(-outside * 6.0 / uEdgeSoft);

  // 水面の裏側。円の縁へ行くほど水面が遠ざかり、模様が詰まって見える
  // 円の縁へ行くほど水面が遠ざかり、模様が細かく見える（渦を巻かないよう控えめに）
  float squeeze = 1.0 + 0.5 * pow(clamp(radW / R, 0.0, 1.6), 3.0);
  // 重い計算なので、光の円とそのすぐ外側だけで行う
  // 3) 大きなうねり（Z）: 水面全体がゆっくり上下し、見上げた水面までの距離が変わる。
  //    近づくと模様が大きく粗く、遠ざかると細かくなる（一定周期にならないよう 2 つの周期を重ねる）
  float heave = 1.0 + 0.07 * sin(t * 0.37) + 0.04 * sin(t * 0.83 + 1.7) + 0.03 * (noise1(t * 0.21) - 0.5) * 2.0;
  float net = radW < R + 0.2 ? surfaceLight(pw * 5.0 * squeeze * uSurfScale * heave, t) : 0.0;
  // 水面が近いときは光が強く、遠いときは淡い
  net *= 1.0 + (1.0 - heave) * 1.6;
  float surf = uSurface * uSurfContrast;
  // 太陽の芯と、そのまわりのにじみ（深いほど広く、淡くにじむ）
  // 太陽の芯は画面の主役にしない。さりげなく光る程度（芯は小さく、にじみは淡く）
  float sun = (exp(-radS * 18.0 / uSunSpread) * 0.32 / uSunSpread + exp(-radS * 4.5 / uSunSpread) * 0.1) * uLight * uDepthLight * uSunCore * uDirect;

  vec3 col = uDeep;
  col += window * uShallow * (0.3 + net * 0.4 * surf * (0.5 + 0.5 * exp(-radS * 5.0))) * uLight * uDepthLight;
  col += (1.0 - window) * net * 0.08 * surf * exp(-outside * 4.0) * smoothstep(R + 0.2, R + 0.08, rad) * uDepthLight;
  col += sun;                                            // 太陽の芯
  col += (1.0 - window) * exp(-outside * 3.0 / uEdgeSoft) * 0.12 * uLight * uDepthLight;    // 窓のまわりのにじみ

  // 光の筋も、水面のうねりに合わせて強まったり弱まったりする
  col += c * 0.8 * (1.0 - window * 0.6) * (1.0 + (1.0 - heave) * 1.2);
  col += exp(-rad * 1.6) * 0.06 * uHaze * (0.4 + 0.6 * uDepthLight);   // 水の霞

  // 漂う微粒子
  float lightField = 0.25 + glow + c * 1.5;
  col += (motes(p, t, 0.035, 1.0) * 0.5 + motes(p, t, 0.06, 2.0) * 0.35) * lightField * uMotes;

  // クジラ（点と線のポリゴン）。水面の揺らぎを少しだけ受けて、同じ水の中にいるように揺れる。
  // 泡の輪の奥にいるので、泡の濃いところでは隠れる
  // クジラと泡も背景と同じ強さで水の揺らぎを受け、輪郭はフィルムに写ったように柔らかく
  vec4 wl = softTap(uWhaleTex, uvR, uPx * 1.3);
  vec4 wHalo = haloTap(uWhaleTex, uvR, uPx * 7.0);

  // ザトウクジラのバブルリング。外側（手前）ほど大きくボケ、内側（奥）ほど細かくシャープ
  // クジラが噴気孔から吐き出した泡。水面の揺らぎで少し歪む
  vec4 bl = softTap(uBubbleTex, uvR, uPx * 1.2);
  vec4 bHalo = haloTap(uBubbleTex, uvR, uPx * 9.0);
  float bGlow = bl.r * 1.1;
  float bBody = bl.g;
  float ambBody = 0.0;   // 背景の泡の輪の濃さ（クジラより手前にあるもの）
  // 背景の泡の輪（任意）
  if (uAmbient > 0.001) {
    vec2 b2 = bubbleLayer(p, 34.0, 0.56, 0.065, 1.0, uBubbleTime, 1.35, 0.7, 1.0);
    vec2 b1 = bubbleLayer(p, 56.0, 0.48, 0.085, 0.0, uBubbleTime, 1.0, 0.5, 0.0);
    vec2 b3 = bubbleLayer(p, 96.0, 0.43, 0.11, 2.0, uBubbleTime, 0.6, 0.15, 0.0);
    vec2 b4 = bubbleLayer(p, 170.0, 0.40, 0.14, 3.0, uBubbleTime, 0.28, 0.0, 0.0);
    bGlow += (b2.x * 0.95 + b1.x * 0.9 + b3.x + b4.x * 1.1) * uAmbient;
    ambBody = (b1.y + b2.y + b3.y + b4.y) * uAmbient;
    bBody += ambBody;
  }
  bBody = clamp(bBody, 0.0, 1.0);
  // 泡は光の窓に近いほど光を受ける。窓の中では空を背にして翳る
  float light = 0.2 + (glow * 1.1 * uDepthLight + c * 1.2 + sun) * uLight;
  col *= 1.0 - window * bBody * 0.45;
  col += bGlow * light * 1.05;
  col += bHalo.r * light * 0.35 * uHalation;   // 泡のまわりの光のにじみ

  // 水面の揺れのきらめき（窓の中だけ）
  float spec = pow(clamp(length(vec2(hx, hy)) * 3.5, 0.0, 1.0), 2.0);
  col += spec * (0.12 + window * 0.3);
  // クジラが吐いた泡は水面へ上る（見上げた視点ではクジラの向こう側）ので、クジラを隠さない。
  // 背景の泡の輪だけが、手前で少しクジラを隠す
  float whaleVeil = 1.0 - clamp(ambBody * 0.35, 0.0, 0.45);

  vec2 v = vUv - 0.5;
  col *= max(1.0 - dot(v, v) * 1.3 * uVignette, 0.0);
  // 黒を締める
  col = pow(clamp(col, 0.0, 1.0), vec3(1.18 * uContrast));

  // クジラは黒を締めたあとに重ねる（細い線と点がつぶれないように）。
  // 泡と同じ光（太陽・光の筋・水深）を受けて光る。光の前では、泡と同じように逆光で翳る
  float whaleLight = clamp(0.35 + (glow * 0.9 * uDepthLight + c * 1.4 + sun * 0.8) * uLight, 0.25, 1.6);
  float whaleLum = clamp(dot(wl.rgb, vec3(0.333)) * 3.0, 0.0, 1.0) * whaleVeil;
  float behind = smoothstep(0.35, 0.85, dot(col, vec3(0.333)));
  col = col * (1.0 - wl.a * whaleVeil);
  col += (wl.rgb + wHalo.rgb * 0.6 * uHalation) * whaleVeil * (1.0 - behind) * whaleLight;
  col *= 1.0 - whaleLum * behind * 0.55;

  // フィルムの粒子。全レイヤーに同じルールで 1 回だけかける（網点ではなく、写真の粒状感）。
  // 粗い粒（粒の大きさ）と、1px の細かい粒を重ね、暗部にも明部にも均一に乗せる
  float lum = clamp(dot(col, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
  float t8 = floor(uTime * 24.0);
  vec2 fc = gl_FragCoord.xy;
  float coarse = noise2(fc / uGrainSize + vec2(t8 * 17.31, t8 * 9.73));
  float coarse2 = noise2(fc / (uGrainSize * 0.6) + vec2(t8 * 5.17 + 40.0, -t8 * 13.9));
  float fine = hash21(floor(fc) + t8 * 13.7);
  float grain = (coarse - 0.5) * 1.1 + (coarse2 - 0.5) * 0.6 + (fine - 0.5) * 0.55;
  lum += grain * 0.27 * uGrain * (0.5 + 1.3 * lum * (1.0 - lum)) * (0.55 + 0.45 * smoothstep(0.0, 0.25, lum));
  lum = clamp(lum, 0.0, 1.0);
  // 色: 暗部から中間調に色を差し、ハイライトは白に抜く
  vec3 tinted = mix(uTint * lum * 1.6, vec3(1.0), smoothstep(0.55, 1.0, lum));
  col = mix(vec3(lum), clamp(tinted, 0.0, 1.0), uSaturation);
  o = vec4(col, 1.0);
}`;

// --- コントローラーで調整できる値。default が現在の仕上がり
type ParamKey =
  | "grain" | "grainSize"
  | "bubbleAmount" | "bubbleSize" | "bubbleContrast" | "bubbleSpeed"
  | "light" | "rays" | "windowSize" | "surface" | "motes"
  | "contrast" | "saturation"
  | "speed" | "damping"
  | "centerX" | "centerY" | "vignette" | "spiral" | "spin" | "bubbleRhythm" | "ambient"
  | "depthM" | "sunElev" | "sunAzim"
  | "netWhales" | "netRadius" | "netDepth" | "netSpin" | "cursorBubbles" | "halation" | "sunCore"
  | "whale2" | "whale3" | "whale3Height" | "driftAmount" | "driftSpeed"
  | "shimmer" | "shimmerSpeed"
  | "whale" | "whaleLength" | "whaleSpeed" | "whaleF8w" | "whaleF8h" | "whaleF8d"
  | "whalePersp" | "whaleLine" | "whalePoint" | "whalePointSize" | "whaleBack" | "whaleFog";
type ParamDef = { key: ParamKey; label: string; min: number; max: number; step: number; def: number };

const GROUPS: { title: string; params: ParamDef[] }[] = [
  { title: "ノイズ", params: [
    { key: "grain", label: "強さ", min: 0, max: 2, step: 0.01, def: 1 },
    { key: "grainSize", label: "粒の大きさ", min: 1, max: 6, step: 0.1, def: 3.2 },
    { key: "halation", label: "光のにじみ", min: 0, max: 2, step: 0.01, def: 1 },
  ] },
  { title: "泡", params: [
    { key: "bubbleAmount", label: "吐き出す量", min: 0, max: 3, step: 0.01, def: 1 },
    { key: "bubbleRhythm", label: "吐き出しの間隔（秒）", min: 1, max: 10, step: 0.1, def: 3.5 },
    { key: "bubbleSize", label: "大きさ", min: 0.4, max: 2, step: 0.01, def: 1 },
    { key: "bubbleContrast", label: "大小の強弱", min: 0, max: 2, step: 0.01, def: 1 },
    { key: "bubbleSpeed", label: "浮かぶ速さ", min: 0, max: 3, step: 0.01, def: 1 },
    { key: "netWhales", label: "泡を吐くクジラの数（カメラの下）", min: 1, max: 4, step: 1, def: 2 },
    { key: "netRadius", label: "泡の輪の半径", min: 0.15, max: 1.2, step: 0.01, def: 0.55 },
    { key: "netDepth", label: "泡を吐くクジラの深さ（カメラより下）", min: 0.3, max: 4, step: 0.05, def: 1.5 },
    { key: "netSpin", label: "旋回の速さ", min: 0, max: 3, step: 0.01, def: 1 },
    { key: "cursorBubbles", label: "カーソルから生まれる泡", min: 0, max: 3, step: 0.01, def: 1 },
    { key: "ambient", label: "背景の泡の輪", min: 0, max: 1, step: 0.01, def: 0 },
    { key: "spiral", label: "背景の輪：らせんの開き", min: 0, max: 2.5, step: 0.01, def: 1 },
    { key: "spin", label: "背景の輪：回転", min: 0, max: 4, step: 0.01, def: 1 },
  ] },
  { title: "水深と太陽", params: [
    { key: "depthM", label: "水深（m）", min: 1, max: 40, step: 0.5, def: 8 },
    { key: "sunElev", label: "太陽の高さ（°）", min: 5, max: 90, step: 1, def: 90 },
    { key: "sunAzim", label: "太陽の方角（°）", min: -180, max: 180, step: 1, def: 135 },
  ] },
  { title: "光", params: [
    { key: "light", label: "強さ", min: 0, max: 2, step: 0.01, def: 1.2 },
    { key: "rays", label: "光の筋", min: 0, max: 2, step: 0.01, def: 0.37 },
    { key: "shimmer", label: "光の揺らぎ", min: 0, max: 2, step: 0.01, def: 1.86 },
    { key: "shimmerSpeed", label: "揺らぎの速さ", min: 0, max: 3, step: 0.01, def: 1 },
    { key: "driftAmount", label: "光の移ろい（雲の影）", min: 0, max: 2, step: 0.01, def: 1 },
    { key: "driftSpeed", label: "移ろいの速さ", min: 0.2, max: 4, step: 0.01, def: 1 },
    { key: "sunCore", label: "太陽の芯", min: 0, max: 3, step: 0.01, def: 1 },
    { key: "windowSize", label: "光の円の大きさ", min: 0.6, max: 1.5, step: 0.01, def: 0.67 },
    { key: "surface", label: "水面の模様", min: 0, max: 2, step: 0.01, def: 0.13 },
    { key: "motes", label: "漂う微粒子", min: 0, max: 3, step: 0.01, def: 0.33 },
  ] },
  { title: "色", params: [
    { key: "contrast", label: "コントラスト", min: 0.6, max: 1.8, step: 0.01, def: 1 },
    { key: "saturation", label: "彩度", min: 0, max: 1, step: 0.01, def: 0 },
  ] },
  { title: "クジラ", params: [
    { key: "whale", label: "濃さ（0 で消える）", min: 0, max: 1.5, step: 0.01, def: 1 },
    { key: "whale2", label: "2 頭目（同じ深さ）", min: 0, max: 1.5, step: 0.01, def: 1 },
    { key: "whale3", label: "3 頭目（水面寄り）", min: 0, max: 1.5, step: 0.01, def: 1 },
    { key: "whale3Height", label: "3 頭目の高さ（水面寄り）", min: 0.3, max: 3.5, step: 0.05, def: 1.6 },
    { key: "whaleLength", label: "体長", min: 0.15, max: 1.6, step: 0.01, def: WHALE_SWIM.length },
    { key: "whaleSpeed", label: "泳ぐ速さ", min: 0, max: 0.4, step: 0.01, def: WHALE_SWIM.speed },
    { key: "whaleF8w", label: "八の字の横幅", min: 0.2, max: 1.4, step: 0.01, def: WHALE_SWIM.f8w! },
    { key: "whaleF8h", label: "八の字の縦幅", min: 0.05, max: 0.8, step: 0.01, def: WHALE_SWIM.f8h! },
    { key: "whaleF8d", label: "八の字の奥行き", min: 0, max: 1, step: 0.01, def: WHALE_SWIM.f8d! },
    { key: "whalePersp", label: "遠近感", min: 0, max: 1.5, step: 0.01, def: WHALE_LOOK.persp },
    { key: "whaleLine", label: "線の強さ", min: 0, max: 2, step: 0.01, def: WHALE_LOOK.line },
    { key: "whalePoint", label: "点の強さ", min: 0, max: 2, step: 0.01, def: WHALE_LOOK.point },
    { key: "whalePointSize", label: "点の大きさ", min: 1, max: 8, step: 0.1, def: WHALE_LOOK.pointSize },
    { key: "whaleBack", label: "裏側の線", min: 0, max: 1, step: 0.01, def: WHALE_LOOK.backLine },
    { key: "whaleFog", label: "水の霞", min: 0, max: 0.9, step: 0.01, def: WHALE_LOOK.fog },
  ] },
  { title: "構図", params: [
    { key: "centerX", label: "光源の位置（横）", min: -0.6, max: 0.6, step: 0.01, def: 0 },
    { key: "centerY", label: "光源の位置（縦）", min: -0.4, max: 0.4, step: 0.01, def: 0 },
    { key: "vignette", label: "周辺減光", min: 0, max: 2.5, step: 0.01, def: 1 },
  ] },
  { title: "動き", params: [
    { key: "speed", label: "全体の速さ", min: 0, max: 2, step: 0.01, def: 1 },
    { key: "damping", label: "波紋の残り方", min: 0.95, max: 0.995, step: 0.001, def: 0.984 },
  ] },
];
const ALL_PARAMS = GROUPS.flatMap((g) => g.params);
type Settings = Record<ParamKey, number> & { tint: string; paused: boolean };
const DEFAULTS: Settings = {
  ...(Object.fromEntries(ALL_PARAMS.map((p) => [p.key, p.def])) as Record<ParamKey, number>),
  tint: "#3a8fbf",
  paused: false,
};

// プリセット。標準からの差分だけを持つ。切り替えるとなめらかに移り変わる
const PRESETS: { name: string; values: Partial<Settings> }[] = [
  { name: "標準", values: {} },
  { name: "静か", values: {
    grain: 0.8, bubbleAmount: 0.55, bubbleSpeed: 0.6, spin: 0.5, light: 0.85, rays: 0.6,
    motes: 0.6, contrast: 1.1, speed: 0.6, vignette: 1.2,
  } },
  { name: "華やか", values: {
    bubbleAmount: 1.6, bubbleContrast: 1.4, bubbleSpeed: 1.3, spin: 1.4, light: 1.1, rays: 1.5,
    motes: 1.8, vignette: 0.8,
  } },
  { name: "KV用", values: {
    centerX: 0.3, grain: 1.1, bubbleAmount: 1.15, contrast: 1.15, vignette: 1.35, speed: 0.5,
  } },
  { name: "MeSet1", values: {
    grain: 0.5, grainSize: 2, bubbleAmount: 1.86, bubbleRhythm: 3.7, netRadius: 0.36, netDepth: 2.95, netSpin: 1.48,
    cursorBubbles: 1.92, ambient: 0.06, spiral: 1.98, spin: 0.99, sunElev: 46, sunAzim: 12, saturation: 0.66,
    whale: 0.99, whale2: 0.82, centerX: 0.01, vignette: 0.46,
  } },
];

// クジラを本編に重ねるときの持ち上げ（WhaleLab の見え方に揃えるため）
const SCENE_GAIN = { line: 4.5, point: 2.2 };

// なめらかな 1 次元ノイズ（-1〜1）。光の移ろいに使う
const smoothNoise = (x: number, seed: number) => {
  const h = (i: number) => { const v = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return (v - Math.floor(v)) * 2 - 1; };
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
};
/**
 * 光の移ろい。水面の上を雲が流れて、日差しが強まったり翳ったりするイメージ。
 * 周期の違うゆっくりした揺らぎを重ね、ときどき雲がかかって深く翳る。規則的な明滅にはしない。
 * 戻り値 sun: 太陽と光の筋（直射）にかかる倍率 / sky: 全体の明るさ（散乱光）にかかる倍率
 */
const lightDrift = (t: number, amount: number) => {
  const slow = smoothNoise(t / 23, 1) * 0.6 + smoothNoise(t / 9, 2) * 0.3 + smoothNoise(t / 3.7, 3) * 0.1;
  const cloudRaw = smoothNoise(t / 31, 4);
  const cloud = Math.max(0, cloudRaw - 0.35) / 0.65;                     // たまにだけ雲がかかる
  const cloudEase = cloud * cloud * (3 - 2 * cloud);
  const sun = 1 + (slow * 0.18 - cloudEase * 0.45) * amount;
  const sky = 1 + (slow * 0.07 - cloudEase * 0.15) * amount;
  return { sun: Math.max(sun, 0.2), sky: Math.max(sky, 0.5) };
};

const hexToRgb = (hex: string) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

type Props = {
  /** 波の減衰。1 に近いほど長く残る */
  damping?: number;
  /** 何もしないときに降る小さな雨粒 */
  rain?: boolean;
  /** 操作の案内文。KV として使うときは false */
  hint?: boolean;
  /** ドラッグで太陽を動かせるか（マウス・タッチ共通） */
  sunDrag?: boolean;
  /** 調整パネル。H キーでも表示を切り替えられる */
  controls?: boolean;
  /** 初期値の上書き（「設定をコピー」で書き出した JSON をそのまま渡せる） */
  settings?: Partial<Settings>;
};

export default function WhaleRipple({ damping, rain = true, hint = true, controls = true, settings, sunDrag = true }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const initial: Settings = { ...DEFAULTS, ...(damping !== undefined ? { damping } : {}), ...settings };
  const [params, setParams] = useState<Settings>(initial);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const exportRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
    if (!gl) return;
    if (!gl.getExtension("EXT_color_buffer_float")) gl.getExtension("EXT_color_buffer_half_float");

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const program = (fs: string) => {
      const p = gl.createProgram()!;
      gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, "aPos");
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
      const u: Record<string, WebGLUniformLocation | null> = {};
      const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const name = gl.getActiveUniform(p, i)!.name.replace(/\[0\]$/, "");
        u[name] = gl.getUniformLocation(p, name);
      }
      return { p, u };
    };
    const sim = program(SIM);
    const ren = program(RENDER);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // --- 高さ場（R: 現在, G: 1 ステップ前）
    let simW = 1, simH = 1, aspect = 1, dpr = 1;
    // クジラのレイヤー（画面と同じ大きさのテクスチャ + 奥行き）
    const whaleTex = gl.createTexture()!;
    const whaleDepth = gl.createRenderbuffer()!;
    const whaleFbo = gl.createFramebuffer()!;
    const bubbleTex = gl.createTexture()!;
    const bubbleFbo = gl.createFramebuffer()!;
    const makeWhaleLayer = (w: number, h: number) => {
      gl.bindTexture(gl.TEXTURE_2D, whaleTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindRenderbuffer(gl.RENDERBUFFER, whaleDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, whaleFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, whaleTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, whaleDepth);
      gl.bindTexture(gl.TEXTURE_2D, bubbleTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bubbleFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bubbleTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
    let targets: { tex: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
    const makeTargets = () => {
      targets.forEach((t) => { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); });
      targets = [0, 1].map(() => {
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, simW, simH, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return { tex, fbo };
      });
    };

    const resize = () => {
      const w = Math.max(1, wrap.clientWidth), h = Math.max(1, wrap.clientHeight);
      // 描画の解像度に上限を設ける（フル HD 相当）。大画面・高精細でも重くならないように。
      // フィルムの粒子があるので、上限で描いて引き伸ばしても見た目はほぼ変わらない
      dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (w * h)));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      makeWhaleLayer(canvas.width, canvas.height);
      aspect = w / h;
      simH = 360;
      simW = Math.round(simH * aspect);
      makeTargets();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    // --- 入力
    const drops: number[][] = [];
    const addDrop = (u: number, v: number, radius: number, strength: number) => {
      if (drops.length < MAX_DROPS) drops.push([u, v, radius, strength]);
    };
    const pointer = { x: 0, y: 0, u: 0.5, v: 0.5, last: -1e9, has: false };
    let cursorCarry = 0;
    let cursorAt: [number, number] = [0, 0];
    let cursorFrom: [number, number] = [0, 0];
    const toUv = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
    };
    const hideHint = () => { if (hintRef.current) hintRef.current.style.opacity = "0"; };
    const onMove = (e: PointerEvent) => {
      const [u, v] = toUv(e);
      const dist = pointer.has ? Math.hypot((u - pointer.u) * aspect, v - pointer.v) : 0;
      pointer.u = u; pointer.v = v; pointer.has = true;
      pointer.x = (u - 0.5) * aspect; pointer.y = v - 0.5;
      pointer.last = performance.now();
      addDrop(u, v, 0.022, Math.min(dist * 6, 0.35));
      // カーソルの軌跡から泡が生まれる（動いた距離に比例）
      cursorCarry += Math.min(dist, 0.15) * 22 * paramsRef.current.cursorBubbles;
      cursorFrom = cursorAt;
      cursorAt = [(u - 0.5) * aspect, v - 0.5];
    };
    // --- ドラッグで太陽を動かす。ドラッグした場所に太陽の芯がついてくる。
    // 光の円の中心ほど太陽は高く、縁ほど低い。屈折のため、太陽は円の外には出ない
    let dragging = false;
    const TAN_EDGE = Math.tan((48.6 * Math.PI) / 180);
    const MIN_ELEV = 5;
    const maxRatio = Math.tan(Math.asin(Math.cos((MIN_ELEV * Math.PI) / 180) / 1.333)) / TAN_EDGE;
    const moveSun = (u: number, v: number) => {
      const P = paramsRef.current;
      // 画面の位置 → シェーダーの座標（光源の位置を差し引く）
      const sc = 1.06 / Math.min(aspect, 1);
      const px = (u - 0.5) * aspect * sc - P.centerX;
      const py = (v - 0.5) * sc - P.centerY;
      const ratio = Math.min(Math.hypot(px, py) / (0.27 * P.windowSize), maxRatio);
      const thW = Math.atan(ratio * TAN_EDGE);
      const elev = (Math.acos(Math.min(1.333 * Math.sin(thW), 1)) * 180) / Math.PI;
      const azim = (Math.atan2(py, px) * 180) / Math.PI;
      setParams((p) => ({ ...p, sunElev: Math.round(Math.max(elev, MIN_ELEV)), sunAzim: Math.round(azim) }));
    };
    const onDrag = (e: PointerEvent) => {
      // 離した通知を取りこぼしても、押していなければドラッグを終える（ホバーで太陽が動かないように）
      if (dragging && e.buttons === 0) dragging = false;
      if (!dragging) return;
      const [u, v] = toUv(e);
      moveSun(u, v);
    };
    const onDown = (e: PointerEvent) => {
      onMove(e);
      const [u, v] = toUv(e);
      addDrop(u, v, 0.045, 1.6);
      hideHint();
      if (sunDrag) {
        dragging = true;
        canvas.setPointerCapture(e.pointerId);
        moveSun(u, v);
      }
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointermove", onDrag);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    // --- クジラ（WhaleLab で作ったポリゴンのザトウクジラ）。光源のまわりを奥行きのある八の字で泳ぐ
    // 3 頭: 主役 / 同じ深さで反対側を泳ぐ 1 頭 / 水面に近い高いところを泳ぐ 1 頭
    const whaleSwim = (i: number, P: Record<ParamKey, number>): WhaleParams => {
      const base = {
        ...WHALE_SWIM, length: P.whaleLength, speed: P.whaleSpeed, f8w: P.whaleF8w, f8h: P.whaleF8h, f8d: P.whaleF8d,
      };
      // 2 頭目: 八の字の外側を、逆回りでゆったり周回する（1 頭目の道筋と交わらない）
      if (i === 1) return { ...base, length: base.length * 0.88, speed: base.speed * 0.85, f8mirror: -1, pathKind: 1 };
      if (i === 2) return {
        ...base, length: base.length * 1.1, speed: base.speed * 0.75, f8w: base.f8w! * 1.35, f8h: base.f8h! * 1.2,
        f8z: -P.whale3Height, f8d: base.f8d! * 0.6,
      };
      return base;
    };
    const P0 = paramsRef.current as unknown as Record<ParamKey, number>;
    const whales = [0, Math.PI * 0.9, Math.PI * 0.4].map((tau, i) => createWhaleOnFigure8(whaleSwim(i, P0), tau));
    const whaleMeshes = whales.map(() => createWhaleMesh());
    const whaleRenderers = whaleMeshes.map((m) => createWhaleRenderer(gl, m));
    const bubbleNet = createBubbleNet(gl);

    const palette = {
      deep: [0.025, 0.025, 0.025],
      shallow: [0.95, 0.95, 0.95],
    };

    let raf = 0;
    let prev = performance.now();
    let sceneTime = 0;
    let bubbleTime = 0;
    let spinAngle = 0;
    let shimmerTime = 0;
    let netAngle = 0;
    // 画面に効いている値。目標値（パネルの値）へなめらかに寄せる
    const live = Object.fromEntries(ALL_PARAMS.map((p) => [p.key, paramsRef.current[p.key]])) as Record<ParamKey, number>;
    let liveTint = hexToRgb(paramsRef.current.tint);
    let read = 0;
    let nextRain = 0;

    const frame = (now: number) => {
      const target = paramsRef.current;
      const realDt = Math.min((now - prev) / 1000, 1 / 20);
      prev = now;
      const ease = 1 - Math.exp(-realDt * 3.5);
      for (const p of ALL_PARAMS) live[p.key] += (target[p.key] - live[p.key]) * ease;
      const tintTarget = hexToRgb(target.tint);
      liveTint = liveTint.map((c, i) => c + (tintTarget[i] - c) * ease);
      const P = live;
      const paused = target.paused;
      const dt = paused ? 0 : realDt * P.speed;
      sceneTime += dt;
      bubbleTime += dt * P.bubbleSpeed;
      spinAngle += dt * 0.03 * P.spin;
      shimmerTime += dt * P.shimmerSpeed;
      const t = sceneTime;

      if (rain && t > nextRain) {
        nextRain = t + 0.4 + Math.random() * 1.2;
        addDrop(Math.random(), Math.random(), 0.012 + Math.random() * 0.01, 0.35);
      }

      // --- シミュレーション 2 ステップ（一時停止中は止める）
      gl.viewport(0, 0, simW, simH);
      gl.useProgram(sim.p);
      gl.uniform2f(sim.u.uTexel, 1 / simW, 1 / simH);
      gl.uniform1f(sim.u.uAspect, aspect);
      gl.uniform1f(sim.u.uDamping, P.damping);
      for (let step = 0; step < (paused ? 0 : 2); step++) {
        const count = step === 0 ? drops.length : 0;
        if (count) gl.uniform4fv(sim.u.uDrops, new Float32Array(drops.flat().concat(new Array((MAX_DROPS - count) * 4).fill(0))));
        gl.uniform1i(sim.u.uDropCount, count);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, targets[read].tex);
        gl.uniform1i(sim.u.uState, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets[1 - read].fbo);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        read = 1 - read;
      }
      if (!paused) drops.length = 0;

      // --- クジラをレイヤーに描く
      const drift = lightDrift(t * P.driftSpeed, P.driftAmount);
      const swims = whales.map((_, i) => whaleSwim(i, P));
      whales.forEach((w, i) => stepWhale(w, dt, swims[i], aspect));
      gl.bindFramebuffer(gl.FRAMEBUFFER, whaleFbo);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const k = Math.min(aspect, 1) / 1.06;     // 光源の位置（本編の座標 → 画面の座標）
      // 遠い（水面寄りの）クジラから先に描く
      const strength = [P.whale, P.whale * P.whale2, P.whale * P.whale3];
      [2, 1, 0].forEach((i) => {
        if (strength[i] <= 0.005) return;
        updateWhaleMesh(whaleMeshes[i], skeleton3D(whales[i], swims[i]));
        // 水面に近い（遠い）クジラほど、水の霞に溶ける
        const far = i === 2 ? Math.min(P.whale3Height / 3, 0.6) : 0;
        whaleRenderers[i].draw({
          ...WHALE_LOOK,
          aspect, time: t, offset: [P.centerX * k, P.centerY * k],
          persp: P.whalePersp, pointSize: P.whalePointSize * dpr,
          // 本編は WhaleLab の背景より明るく情報も多いので、線と点を少し持ち上げて合成する
          line: P.whaleLine * strength[i] * SCENE_GAIN.line, point: P.whalePoint * strength[i] * SCENE_GAIN.point,
          faceAlpha: WHALE_LOOK.faceAlpha * strength[i],
          backLine: P.whaleBack, fog: Math.min(P.whaleFog + far, 0.9), bgLight: P.light * drift.sky * (0.6 + 0.4 * drift.sun),
        });
      });

      // --- 泡: カメラより深いところを旋回するクジラたちが吐く（泳いでいるクジラは吐かない）
      const bPersp = Math.max(P.whalePersp, 0.08);
      const camZ = 1 / bPersp;                       // カメラの高さ（この面より下は画面に映らない）
      netAngle += dt * 0.22 * P.netSpin;
      const emitters: [number, number, number][] = [];
      const nWhales = Math.round(P.netWhales);
      for (let i = 0; i < nWhales; i++) {
        const a = netAngle + (i / nWhales) * Math.PI * 2;
        const rho = P.netRadius * (1 + 0.1 * Math.sin(t * 0.21 + i * 2.1));
        emitters.push([Math.cos(a) * rho, Math.sin(a) * rho, camZ + P.netDepth]);
      }
      bubbleNet.update(dt, emitters, -1.6, {
        amount: P.bubbleAmount, size: P.bubbleSize, contrast: P.bubbleContrast, rise: P.bubbleSpeed, rhythm: P.bubbleRhythm,
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, bubbleFbo);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const bubbleOffset: [number, number] = [P.centerX * k, P.centerY * k];
      if (cursorCarry >= 1 && !paused) {
        const n = Math.min(Math.floor(cursorCarry), 3);
        cursorCarry = 0;
        // 軌跡（前回の位置 → 今の位置）に沿ってばらまく
        for (let i = 0; i < n; i++) {
          const f = Math.random();
          bubbleNet.spawnAtScreen(
            cursorFrom[0] + (cursorAt[0] - cursorFrom[0]) * f, cursorFrom[1] + (cursorAt[1] - cursorFrom[1]) * f,
            bPersp, bubbleOffset,
            { amount: P.bubbleAmount, size: P.bubbleSize, contrast: P.bubbleContrast, rise: P.bubbleSpeed, rhythm: P.bubbleRhythm },
            1,
          );
        }
      }
      bubbleNet.draw({ aspect, persp: bPersp, offset: [P.centerX * k, P.centerY * k], height: canvas.height, time: t });

      // --- 描画
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(ren.p);
      gl.bindTexture(gl.TEXTURE_2D, targets[read].tex);
      gl.uniform1i(ren.u.uState, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, whaleTex);
      gl.uniform1i(ren.u.uWhaleTex, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, bubbleTex);
      gl.uniform1i(ren.u.uBubbleTex, 2);
      gl.uniform1f(ren.u.uAmbient, P.ambient);
      gl.uniform2f(ren.u.uPx, 1 / canvas.width, 1 / canvas.height);
      gl.uniform1f(ren.u.uHalation, P.halation);
      gl.uniform1f(ren.u.uSunCore, P.sunCore);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(ren.u.uTexel, 1 / simW, 1 / simH);
      gl.uniform1f(ren.u.uAspect, aspect);
      gl.uniform1f(ren.u.uTime, t);
      gl.uniform3fv(ren.u.uDeep, palette.deep);
      gl.uniform3fv(ren.u.uShallow, palette.shallow);
      gl.uniform1f(ren.u.uBubbleTime, bubbleTime);
      gl.uniform1f(ren.u.uGrain, P.grain);
      gl.uniform1f(ren.u.uGrainSize, P.grainSize);
      gl.uniform1f(ren.u.uBubbleAmount, P.bubbleAmount);
      gl.uniform1f(ren.u.uBubbleSize, P.bubbleSize);
      gl.uniform1f(ren.u.uBubbleContrast, P.bubbleContrast);
      gl.uniform1f(ren.u.uLight, P.light * drift.sky);
      gl.uniform1f(ren.u.uDirect, drift.sun);
      gl.uniform1f(ren.u.uRays, P.rays);
      gl.uniform1f(ren.u.uSurface, P.surface);
      gl.uniform1f(ren.u.uWindowSize, P.windowSize);
      gl.uniform1f(ren.u.uMotes, P.motes);
      gl.uniform1f(ren.u.uContrast, P.contrast);
      gl.uniform1f(ren.u.uSaturation, P.saturation);
      gl.uniform3fv(ren.u.uTint, liveTint);
      gl.uniform2f(ren.u.uCenter, P.centerX, P.centerY);
      gl.uniform1f(ren.u.uSpiral, P.spiral);
      gl.uniform1f(ren.u.uSpinAngle, spinAngle);
      gl.uniform1f(ren.u.uVignette, P.vignette);
      gl.uniform1f(ren.u.uShimmer, P.shimmer);
      gl.uniform1f(ren.u.uShimmerTime, shimmerTime);
      // 水深と太陽 → 光（8m を基準 1.0）
      const dm = Math.max(P.depthM, 0.5), rel = dm / 8;
      gl.uniform1f(ren.u.uDepthLight, Math.min(Math.exp(-0.045 * (dm - 8)), 1.35));
      gl.uniform1f(ren.u.uEdgeSoft, 0.6 + 0.05 * dm);
      gl.uniform1f(ren.u.uSurfScale, Math.pow(rel, 0.6));
      gl.uniform1f(ren.u.uSurfContrast, Math.min(Math.exp(-0.045 * (dm - 8)), 1.4));
      gl.uniform1f(ren.u.uRayReach, Math.pow(rel, 0.5));
      gl.uniform1f(ren.u.uRayGain, Math.min(Math.exp(-0.025 * (dm - 8)), 1.25));
      gl.uniform1f(ren.u.uHaze, rel);
      gl.uniform1f(ren.u.uSunSpread, Math.pow(rel, 0.45));
      // 太陽は屈折して光の円の中に入る。高度が低いほど円の縁へ寄る（真上で中心）
      const elev = (P.sunElev * Math.PI) / 180, az = (P.sunAzim * Math.PI) / 180;
      const thW = Math.asin(Math.cos(elev) / 1.333);
      const sunR = 0.27 * P.windowSize * (Math.tan(thW) / Math.tan((48.6 * Math.PI) / 180));
      gl.uniform2f(ren.u.uSunOff, Math.cos(az) * sunR, Math.sin(az) * sunR);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 静止画の書き出し（描いた直後のフレームを取り出す）
      if (exportRef.current) {
        exportRef.current = false;
        canvas.toBlob((blob) => {
          if (!blob) return;
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `bubble-net-${Date.now()}.png`;
          a.click();
          URL.revokeObjectURL(a.href);
        }, "image/png");
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointermove", onDrag);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      targets.forEach((t) => { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); });
      gl.deleteBuffer(vbo);
      gl.deleteProgram(sim.p);
      gl.deleteProgram(ren.p);
      whaleRenderers.forEach((r) => r.dispose());
      bubbleNet.dispose();
      gl.deleteTexture(bubbleTex);
      gl.deleteFramebuffer(bubbleFbo);
      gl.deleteTexture(whaleTex);
      gl.deleteRenderbuffer(whaleDepth);
      gl.deleteFramebuffer(whaleFbo);
    };
  }, [rain, sunDrag]);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "100vh", overflow: "hidden", background: "#050505" }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "none", cursor: "crosshair" }} />
      {hint && (
        <div
          ref={hintRef}
          style={{
            position: "absolute", left: 0, right: 0, bottom: 28, textAlign: "center",
            color: "rgba(255,255,255,0.55)", font: "500 11px/1 system-ui, sans-serif",
            letterSpacing: "0.3em", pointerEvents: "none", transition: "opacity 1.2s",
          }}
        >
          {sunDrag ? "DRAG TO MOVE THE SUN" : "TOUCH THE WATER"}
        </div>
      )}
      {controls && (
        <ControlPanel
          params={params}
          onChange={(patch) => setParams((p) => ({ ...p, ...patch }))}
          onReset={() => setParams(initial)}
          onExport={() => { exportRef.current = true; }}
        />
      )}
    </div>
  );
}

// --- 調整パネル（依存なし）。H キーで表示／非表示
function ControlPanel({ params, onChange, onReset, onExport }: {
  params: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onReset: () => void;
  onExport: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 色の入力中などはショートカットを効かせない（スライダーは対象外）
      if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
      if (e.key === "h" || e.key === "H") setHidden((v) => !v);
      if (e.key === " ") { e.preventDefault(); onChange({ paused: !params.paused }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [params.paused, onChange]);

  if (hidden) return null;

  const copy = async () => {
    const out: Record<string, number | string> = {};
    for (const p of ALL_PARAMS) if (params[p.key] !== p.def) out[p.key] = params[p.key];
    if (params.tint !== DEFAULTS.tint) out.tint = params.tint;
    try {
      await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* クリップボードが使えない環境では何もしない */ }
  };

  const text = "rgba(255,255,255,0.86)";
  const dim = "rgba(255,255,255,0.45)";
  const btn: CSSProperties = {
    flex: 1, padding: "7px 0", background: "rgba(255,255,255,0.08)", color: text,
    border: "1px solid rgba(255,255,255,0.14)", borderRadius: 6, font: "inherit", cursor: "pointer",
  };

  return (
    <div
      style={{
        position: "absolute", top: 16, right: 16, width: 264, maxHeight: "calc(100% - 32px)",
        overflowY: "auto", padding: open ? "12px 14px 14px" : "10px 14px",
        background: "rgba(12,12,12,0.72)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, color: text,
        font: "500 11px/1.4 system-ui, sans-serif", letterSpacing: "0.02em", userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ letterSpacing: "0.2em", color: dim }}>CONTROLS</span>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)} style={{ ...btn, flex: "none", padding: "2px 8px" }}>
          {open ? "閉じる" : "開く"}
        </button>
      </div>

      {open && (
        <>
          <div style={{ color: dim, margin: "14px 0 6px" }}>プリセット</div>
          <div style={{ display: "flex", gap: 4 }}>
            {PRESETS.map((pr) => (
              <button
                key={pr.name}
                style={{ ...btn, padding: "6px 0" }}
                onClick={() => onChange({ ...DEFAULTS, ...pr.values, tint: params.tint, paused: params.paused })}
              >
                {pr.name}
              </button>
            ))}
          </div>
          {GROUPS.map((g) => (
            <div key={g.title} style={{ marginTop: 14 }}>
              <div style={{ color: dim, marginBottom: 6 }}>{g.title}</div>
              {g.params.map((p) => (
                <label
                  key={p.key}
                  onDoubleClick={() => onChange({ [p.key]: p.def } as Partial<Settings>)}
                  title="ダブルクリックで初期値に戻す"
                  style={{ display: "block", marginBottom: 6 }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{p.label}</span>
                    <span style={{ color: params[p.key] === p.def ? dim : text, fontVariantNumeric: "tabular-nums" }}>
                      {params[p.key].toFixed(p.step >= 1 ? 0 : p.step < 0.01 ? 3 : 2)}
                    </span>
                  </div>
                  <input
                    type="range" min={p.min} max={p.max} step={p.step} value={params[p.key]}
                    onChange={(e) => onChange({ [p.key]: Number(e.target.value) } as Partial<Settings>)}
                    style={{ width: "100%", margin: "2px 0 0", accentColor: "#fff" }}
                  />
                </label>
              ))}
              {g.title === "色" && (
                <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>色味（彩度を上げると効く）</span>
                  <input
                    type="color" value={params.tint}
                    onChange={(e) => onChange({ tint: e.target.value })}
                    style={{ width: 36, height: 20, padding: 0, border: "none", background: "none", cursor: "pointer" }}
                  />
                </label>
              )}
            </div>
          ))}

          <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
            <button onMouseDown={(e) => e.preventDefault()} style={btn} onClick={() => onChange({ paused: !params.paused })}>{params.paused ? "再生" : "一時停止"}</button>
            <button onMouseDown={(e) => e.preventDefault()} style={btn} onClick={onExport}>PNG 書き出し</button>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button onMouseDown={(e) => e.preventDefault()} style={btn} onClick={copy}>{copied ? "コピーしました" : "設定をコピー"}</button>
            <button onMouseDown={(e) => e.preventDefault()} style={btn} onClick={onReset}>リセット</button>
          </div>
          <div style={{ color: dim, marginTop: 10, lineHeight: 1.6 }}>
            H: パネルを隠す ／ Space: 一時停止<br />項目をダブルクリックで初期値に戻す
          </div>
        </>
      )}
    </div>
  );
}
