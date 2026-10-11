/**
 * ローポリゴンのクジラを WebGL2 で描く（面・線・点）。
 * 背景の上にそのまま重ねても、透明なレイヤーに描いて後から合成してもよい
 * （色は「光の足し算」、アルファは面が覆った割合として書き込む）。
 */
import type { WhaleMesh } from "./whaleMesh";

const VS = `#version 300 es
in vec3 aPos;
in vec3 aInfo;
in vec3 aOther;           // 線のもう一方の端（線のときだけ使う）
uniform float uAspect;
uniform float uPersp;     // 遠近の強さ（+z が見ている人に近い）
uniform float uZBias;
uniform float uPointSize;
uniform vec2 uOffset;     // 画面上の中心（光源）からのずれ
out vec3 vW;
out vec3 vInfo;
out vec2 vScreen;
out float vNear;          // 手前ほど 1 に近づく（奥行きの手がかり）
out float vLen;           // 線の画面上の長さ
flat out float vFace;     // 三角形ごとの乱数（最後の頂点の値を使う）
void main(){
  vFace = aInfo.y;
  float k = 1.0 / max(1.0 - aPos.z * uPersp, 0.25);
  vec2 sp = aPos.xy * k;
  float ko = 1.0 / max(1.0 - aOther.z * uPersp, 0.25);
  vLen = length(sp - aOther.xy * ko);
  vNear = smoothstep(0.8, 1.4, k);
  vW = vec3(sp, aPos.z);
  vInfo = aInfo;
  vScreen = sp;
  vec2 s = sp + uOffset;
  gl_Position = vec4(s.x / uAspect * 2.0, s.y * 2.0, clamp(-aPos.z * 0.6 + uZBias, -1.0, 1.0), 1.0);
  // 輪郭の点ほど大きく、手前ほど大きい
  gl_PointSize = uPointSize * (0.55 + aInfo.y * 0.4) * mix(0.6, 1.35, aInfo.z) * k;
}`;

const COMMON = `#version 300 es
precision highp float;
in vec3 vW;
in vec3 vInfo;
in vec2 vScreen;
in float vNear;
in float vLen;
flat in float vFace;
out vec4 o;
uniform float uBgLight;
uniform float uFog;
// 背景の光（見上げた水面）。霞や逆光の強さに使う
float wBg(vec2 p){
  float r = length(p);
  return 0.035 + (exp(-r * 2.6) * 0.55 + exp(-r * 9.0) * 0.45) * uBgLight;
}
`;

const FACE_FS = `${COMMON}
uniform float uBase;
uniform float uBelly;
uniform float uFinWhite;
uniform float uRim;
uniform float uFaceAlpha;
void main(){
  float bg = wBg(vScreen);
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  if (n.z < 0.0) n = -n;
  float part = vInfo.x;
  // 下から回り込む弱い光が、面の向きごとに違う明るさをつくる（ローポリの面が立つ）
  float key = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.6, -0.2, 0.75))), 0.0);
  float lum = uBase + (key * 0.16 + fill * 0.05) * uBelly * (0.4 + bg);
  lum *= 0.82 + vFace * 0.36;   // 面ごとのわずかな明暗のばらつき
  if (part > 0.5 && part < 1.5) lum += uFinWhite * (0.1 + 0.3 * key);   // 胸ビレの裏は白い
  if (part > 1.5) lum += uFinWhite * 0.06 * key;
  // 逆光: 光に対して寝ている面ほど、縁が明るく透ける
  lum += pow(1.0 - n.z, 2.0) * uRim * 0.35 * bg;
  lum = mix(lum, bg, uFog);
  o = vec4(vec3(lum), uFaceAlpha);
}`;

const LINE_FS = `${COMMON}
uniform float uLine;
uniform float uLenRef;    // この長さより短い線ははっきり、長い線ほど淡く
void main(){
  float bg = wBg(vScreen);
  float byLen = clamp(pow(uLenRef / max(vLen, 1e-4), 0.8), 0.12, 1.0);
  float a = uLine * (0.2 + 0.8 * bg) * (1.0 - uFog * 0.6) * byLen * mix(0.55, 1.15, vNear) * mix(0.6, 1.1, vInfo.z);
  o = vec4(vec3(0.82), a);
}`;

const POINT_FS = `${COMMON}
uniform float uPoint;
uniform float uTime;
void main(){
  // 胴の途中の点は一部を間引いて、まばらにする
  if (vInfo.x < 0.5 && vInfo.z < 0.5 && vInfo.y < 0.35) discard;
  vec2 c = gl_PointCoord - 0.5;
  float m = smoothstep(0.5, 0.15, length(c));
  float bg = wBg(vScreen);
  float tw = 0.75 + 0.25 * sin(uTime * (1.0 + vInfo.y * 2.0) + vInfo.y * 40.0);
  float a = uPoint * (0.3 + 0.7 * bg) * tw * (1.0 - uFog * 0.6) * mix(0.25, 1.0, vInfo.z) * mix(0.55, 1.2, vNear);
  o = vec4(vec3(0.95), m * a);
}`;

export type MeshStyle = {
  aspect: number; persp: number; pointSize: number; offset: [number, number];
  bgLight: number; fog: number; base: number; belly: number; finWhite: number; rim: number;
  faceAlpha: number; line: number; point: number; time: number;
  /** この長さ（画面の高さ比）より短い線ははっきり、長い線ほど淡く */
  lenRef: number;
  /** 体の裏側（隠れている側）の線と点の濃さ。0 で隠す */
  backLine: number;
};

export function createWhaleRenderer(gl: WebGL2RenderingContext, mesh: WhaleMesh) {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const program = (fs: string) => {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "aPos");
    gl.bindAttribLocation(p, 1, "aInfo");
    gl.bindAttribLocation(p, 2, "aOther");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    const u: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i)!.name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  };
  const face = program(FACE_FS), line = program(LINE_FS), point = program(POINT_FS);

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const posBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.pos.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const infoBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, infoBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.info, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  // 面と点では「もう一方の端」は自分自身
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
  const triBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.tris, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  // 線: 辺ごとに両端を展開した頂点（位置, もう一方の端, 情報）。長さで濃さを変えるため
  const nEdgeVerts = mesh.edges.length;
  const lineData = new Float32Array(nEdgeVerts * 9);
  const lineVao = gl.createVertexArray()!;
  gl.bindVertexArray(lineVao);
  const lineBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
  gl.bufferData(gl.ARRAY_BUFFER, lineData.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 36, 12);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 24);
  gl.bindVertexArray(null);
  const fillLines = () => {
    const E = mesh.edges, P = mesh.pos, I = mesh.info;
    for (let e = 0; e < E.length; e += 2) {
      for (let side = 0; side < 2; side++) {
        const a = E[e + side], b = E[e + 1 - side];
        const o = (e + side) * 9;
        lineData[o] = P[a * 3]; lineData[o + 1] = P[a * 3 + 1]; lineData[o + 2] = P[a * 3 + 2];
        lineData[o + 3] = P[b * 3]; lineData[o + 4] = P[b * 3 + 1]; lineData[o + 5] = P[b * 3 + 2];
        lineData[o + 6] = I[a * 3]; lineData[o + 7] = I[a * 3 + 1]; lineData[o + 8] = I[a * 3 + 2];
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, lineData);
  };
  const drawLines = (st: MeshStyle, strength: number, zBias: number) => {
    gl.bindVertexArray(lineVao);
    gl.useProgram(line.p);
    setCommon(line.u, st, zBias);
    gl.uniform1f(line.u.uLine, strength);
    gl.uniform1f(line.u.uLenRef, st.lenRef);
    gl.drawArrays(gl.LINES, 0, nEdgeVerts);
    gl.bindVertexArray(vao);
  };

  const setCommon = (u: Record<string, WebGLUniformLocation | null>, st: MeshStyle, zBias: number) => {
    gl.uniform1f(u.uAspect, st.aspect);
    gl.uniform1f(u.uPersp, st.persp);
    gl.uniform1f(u.uZBias, zBias);
    gl.uniform1f(u.uPointSize, st.pointSize);
    gl.uniform2f(u.uOffset, st.offset[0], st.offset[1]);
    gl.uniform1f(u.uBgLight, st.bgLight);
    gl.uniform1f(u.uFog, st.fog);
  };

  return {
    draw(st: MeshStyle) {
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.pos);
      fillLines();
      gl.bindVertexArray(vao);

      gl.enable(gl.BLEND);
      gl.clear(gl.DEPTH_BUFFER_BIT);

      // 裏側の線と点: 奥行きを無視して薄く描く（体の向こう側が透けて見える）
      if (st.backLine > 0.001) {
        gl.disable(gl.DEPTH_TEST);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
        drawLines(st, st.line * st.backLine, 0);
        gl.useProgram(point.p);
        setCommon(point.u, st, 0);
        gl.uniform1f(point.u.uPoint, st.point * st.backLine);
        gl.uniform1f(point.u.uTime, st.time);
        gl.drawArrays(gl.POINTS, 0, mesh.count);
      }

      gl.enable(gl.DEPTH_TEST);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      // 面（面を消しているときも、奥行きだけは書いて手前の線の前後関係に使う）
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      const facesVisible = st.faceAlpha > 0.005;
      if (!facesVisible) gl.colorMask(false, false, false, false);
      gl.useProgram(face.p);
      setCommon(face.u, st, 0);
      gl.uniform1f(face.u.uBase, st.base);
      gl.uniform1f(face.u.uBelly, st.belly);
      gl.uniform1f(face.u.uFinWhite, st.finWhite);
      gl.uniform1f(face.u.uRim, st.rim);
      gl.uniform1f(face.u.uFaceAlpha, st.faceAlpha);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuf);
      gl.drawElements(gl.TRIANGLES, mesh.tris.length, gl.UNSIGNED_SHORT, 0);
      gl.colorMask(true, true, true, true);

      // 線と点（面より少し手前に寄せ、隠れた裏側は描かない）
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
      drawLines(st, st.line, -0.004);

      gl.useProgram(point.p);
      setCommon(point.u, st, -0.006);
      gl.uniform1f(point.u.uPoint, st.point);
      gl.uniform1f(point.u.uTime, st.time);
      gl.drawArrays(gl.POINTS, 0, mesh.count);

      gl.depthMask(true);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuf);
      gl.bindVertexArray(null);
    },
    dispose() {
      [posBuf, infoBuf, triBuf, lineBuf].forEach((b) => gl.deleteBuffer(b));
      gl.deleteVertexArray(vao);
      gl.deleteVertexArray(lineVao);
      [face, line, point].forEach((x) => gl.deleteProgram(x.p));
    },
  };
}
