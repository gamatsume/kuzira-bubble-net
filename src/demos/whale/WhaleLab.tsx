/**
 * WhaleLab — ザトウクジラだけを作り込むための制作スペース。
 * 背景は本編と同じく「水中から見上げた光」を簡素にしたもの。泡やノイズは入れない。
 */
import { useEffect, useRef, useState } from "react";
import { createWhale, poseWhale, skeleton3D, stepWhale, type Skeleton3, type WhaleParams } from "./whaleModel";
import { createWhaleMesh, updateWhaleMesh } from "./whaleMesh";
import { createWhaleRenderer } from "./whaleMeshGL";
import { WHALE_GLSL, setWhaleUniforms } from "./whaleShader";
import { Panel, PanelButton } from "../ui/Panel";
import { defaultsOf, type Group, type Values } from "../ui/panelTypes";

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform float uAspect;
uniform float uTime;
uniform float uBgLight;
uniform float uGrain;
uniform float uSDF;       // 1: なめらかな皮膚で描く / 0: 背景だけ（ポリゴンは別に重ねる）
${WHALE_GLSL}

void main(){
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  // 見上げた水面の光（簡素版）
  float r = length(p);
  float bg = 0.035 + (exp(-r * 2.6) * 0.55 + exp(-r * 9.0) * 0.45) * uBgLight;
  float lum = bg;
  if (uSDF > 0.5) {
    vec3 w = whaleShade(p, bg);
    lum = mix(bg + w.z, w.x, w.y);
  }
  vec2 v = vUv - 0.5;
  lum *= 1.0 - dot(v, v) * 1.1;
  float g = wHash(floor(gl_FragCoord.xy / 2.0) + floor(uTime * 24.0) * 13.7) - 0.5;
  lum += g * 0.12 * uGrain;
  o = vec4(vec3(clamp(lum, 0.0, 1.0)), 1.0);
}`;

const GROUPS: Group[] = [
  { title: "表現", items: [
    { key: "polygon", label: "ポリゴン表現", def: true, toggle: true },
    { key: "faceAlpha", label: "面の濃さ", min: 0, max: 1, step: 0.01, def: 0 },
    { key: "line", label: "線の強さ", min: 0, max: 2, step: 0.01, def: 0.13 },
    { key: "point", label: "点の強さ", min: 0, max: 2, step: 0.01, def: 1.3 },
    { key: "backLine", label: "裏側の線", min: 0, max: 1, step: 0.01, def: 0.22 },
    { key: "lenRef", label: "線の濃淡（短い線ほど濃く）", min: 0.01, max: 0.2, step: 0.005, def: 0.045 },
    { key: "pointSize", label: "点の大きさ", min: 1, max: 8, step: 0.1, def: 3.7 },
    { key: "persp", label: "遠近感", min: 0, max: 1.5, step: 0.01, def: 0.22 },
  ] },
  { title: "形", items: [
    { key: "length", label: "体長", min: 0.2, max: 2.2, step: 0.01, def: 0.4 },
    { key: "girth", label: "体の太さ", min: 0.7, max: 1.4, step: 0.01, def: 0.99 },
    { key: "finLength", label: "胸ビレの長さ", min: 0.6, max: 1.4, step: 0.01, def: 1.11 },
    { key: "flukeSpan", label: "尾ビレの幅", min: 0.6, max: 1.4, step: 0.01, def: 1.17 },
  ] },
  { title: "八の字", items: [
    { key: "figure8", label: "八の字で泳ぐ", def: true, toggle: true },
    { key: "f8w", label: "横幅", min: 0.2, max: 1.4, step: 0.01, def: 0.63 },
    { key: "f8h", label: "縦幅", min: 0.05, max: 0.8, step: 0.01, def: 0.48 },
    { key: "f8d", label: "奥行き", min: 0, max: 1, step: 0.01, def: 0.19 },
  ] },
  { title: "泳ぎ", items: [
    { key: "speed", label: "速さ（体長/秒）", min: 0.03, max: 0.4, step: 0.01, def: 0.12 },
    { key: "tailAmp", label: "尾の振り幅", min: 0, max: 2, step: 0.01, def: 0 },
    { key: "turn", label: "旋回（0 で巡航）", min: -0.8, max: 0.8, step: 0.01, def: -0.8 },
    { key: "orbit", label: "旋回の半径", min: 0.2, max: 1.4, step: 0.01, def: 0.2 },
    { key: "bank", label: "旋回時の傾き", min: 0, max: 2, step: 0.01, def: 1 },
    { key: "depth", label: "上下動の遠近", min: 0, max: 3, step: 0.01, def: 1.94 },
  ] },
  { title: "見え方", items: [
    { key: "base", label: "体の暗さ", min: 0, max: 0.3, step: 0.01, def: 0.05 },
    { key: "belly", label: "お腹の明るさ", min: 0, max: 3, step: 0.01, def: 1.49 },
    { key: "pleats", label: "喉の畝", min: 0, max: 3, step: 0.01, def: 0.63 },
    { key: "finWhite", label: "胸ビレの白さ", min: 0, max: 2, step: 0.01, def: 1 },
    { key: "flukeWhite", label: "尾ビレの模様", min: 0, max: 2, step: 0.01, def: 1 },
    { key: "rim", label: "逆光の縁", min: 0, max: 3, step: 0.01, def: 2.44 },
    { key: "blur", label: "ボケ（遠さ）", min: 0, max: 2, step: 0.01, def: 0 },
    { key: "fog", label: "水の霞", min: 0, max: 0.9, step: 0.01, def: 0.46 },
  ] },
  { title: "背景・表示", items: [
    { key: "bgLight", label: "背景の光", min: 0, max: 1.5, step: 0.01, def: 1 },
    { key: "grain", label: "ノイズ", min: 0, max: 2, step: 0.01, def: 0 },
    { key: "skeleton", label: "骨格を表示", def: false, toggle: true },
  ] },
];
const DEFAULTS = defaultsOf(GROUPS);

// 泳ぎ方のプリセット（実際の行動を参考にした代表的な泳ぎ）
const SWIMS: { name: string; values: Values }[] = [
  { name: "八の字", values: { figure8: true, speed: 0.12, tailAmp: 1, bank: 1 } },
  { name: "巡航", values: { figure8: false, speed: 0.12, tailAmp: 1, turn: 0, bank: 1 } },
  { name: "旋回", values: { figure8: false, speed: 0.12, tailAmp: 1, turn: 0.2, bank: 1 } },
  { name: "バブルネット", values: { figure8: false, speed: 0.1, tailAmp: 1.1, turn: 0.3, bank: 1.6 } },
  { name: "滑空", values: { figure8: false, speed: 0.07, tailAmp: 0.15, turn: 0.08, bank: 0.6 } },
];

export default function WhaleLab() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [values, setValues] = useState<Values>(DEFAULTS);
  const [paused, setPaused] = useState(false);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") { e.preventDefault(); setPaused((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const overlay = overlayRef.current!;
    const wrap = wrapRef.current!;
    const gl = canvas.getContext("webgl2", { antialias: true, depth: true });
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    const u: Record<string, WebGLUniformLocation | null> = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(prog, i)!.name.replace(/\[0\]$/, "");
      u[name] = gl.getUniformLocation(prog, name);
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    let aspect = 1, dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, wrap.clientWidth), h = Math.max(1, wrap.clientHeight);
      canvas.width = overlay.width = Math.round(w * dpr);
      canvas.height = overlay.height = Math.round(h * dpr);
      aspect = w / h;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const mesh = createWhaleMesh();
    const renderer = createWhaleRenderer(gl, mesh);

    const P0 = valuesRef.current;
    const whale = createWhale(0.2, -0.22, 0.5, P0.length as number);
    // 画面に効いている値（パネルの値へなめらかに寄せる）
    const live: Record<string, number> = {};
    for (const [k, v] of Object.entries(P0)) if (typeof v === "number") live[k] = v;

    const drawSkeleton = (sk: Skeleton3, persp: number) => {
      const ctx = overlay.getContext("2d")!;
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (!valuesRef.current.skeleton) return;
      const prj = (p: [number, number, number]) => {
        const k = 1 / Math.max(1 - p[2] * persp, 0.25);
        return { x: p[0] * k, y: p[1] * k };
      };
      const X = (x: number) => (x / aspect + 0.5) * overlay.width;
      const Y = (y: number) => (0.5 - y) * overlay.height;
      const pose = {
        joints: sk.joints.map((j) => prj(j.p)),
        fins: sk.fins.map((f) => ({ root: prj(f.base), tip: prj([f.base[0] + f.dir[0] * f.len, f.base[1] + f.dir[1] * f.len, f.base[2] + f.dir[2] * f.len]) })),
        fluke: (() => {
          const fl = sk.fluke;
          const a = prj([fl.root[0] + fl.side[0] * fl.span, fl.root[1] + fl.side[1] * fl.span, fl.root[2] + fl.side[2] * fl.span]);
          const b = prj([fl.root[0] - fl.side[0] * fl.span, fl.root[1] - fl.side[1] * fl.span, fl.root[2] - fl.side[2] * fl.span]);
          return { a, b };
        })(),
      };
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = "rgba(255,80,80,0.9)";
      ctx.fillStyle = "rgba(255,80,80,0.9)";
      ctx.beginPath();
      pose.joints.forEach((j, i) => (i ? ctx.lineTo(X(j.x), Y(j.y)) : ctx.moveTo(X(j.x), Y(j.y))));
      ctx.stroke();
      pose.joints.forEach((j) => { ctx.beginPath(); ctx.arc(X(j.x), Y(j.y), 2.5 * dpr, 0, Math.PI * 2); ctx.fill(); });
      ctx.strokeStyle = "rgba(80,200,255,0.9)";
      for (const f of pose.fins) {
        ctx.beginPath(); ctx.moveTo(X(f.root.x), Y(f.root.y)); ctx.lineTo(X(f.tip.x), Y(f.tip.y)); ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(X(pose.fluke.a.x), Y(pose.fluke.a.y));
      ctx.lineTo(X(pose.fluke.b.x), Y(pose.fluke.b.y));
      ctx.stroke();
    };

    let raf = 0;
    let prev = performance.now();
    let time = 0;
    const frame = (now: number) => {
      const realDt = Math.min((now - prev) / 1000, 1 / 20);
      prev = now;
      const target = valuesRef.current;
      const ease = 1 - Math.exp(-realDt * 3.5);
      for (const k of Object.keys(live)) live[k] += ((target[k] as number) - live[k]) * ease;
      const dt = pausedRef.current ? 0 : realDt;
      time += dt;

      const P = { ...live, figure8: target.figure8 ? 1 : 0 } as unknown as WhaleParams;
      stepWhale(whale, dt, P, aspect);
      const pose = poseWhale(whale, P);

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.useProgram(prog);
      gl.uniform1f(u.uSDF, target.polygon ? 0 : 1);
      gl.uniform1f(u.uAspect, aspect);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uBgLight, live.bgLight);
      gl.uniform1f(u.uGrain, live.grain);
      gl.uniform1f(u.uWLen, live.length);
      gl.uniform1f(u.uWPx, 1 / canvas.height);
      gl.uniform1f(u.uWBase, live.base);
      gl.uniform1f(u.uWBelly, live.belly);
      gl.uniform1f(u.uWPleats, live.pleats);
      gl.uniform1f(u.uWFinWhite, live.finWhite);
      gl.uniform1f(u.uWFlukeWhite, live.flukeWhite);
      gl.uniform1f(u.uWRim, live.rim);
      gl.uniform1f(u.uWBlur, live.blur);
      gl.uniform1f(u.uWFog, live.fog);
      setWhaleUniforms(gl, u, pose);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      const sk = skeleton3D(whale, P);
      if (target.polygon) {
        updateWhaleMesh(mesh, sk);
        renderer.draw({
          aspect, persp: live.persp, pointSize: live.pointSize * dpr, offset: [0, 0],
          bgLight: live.bgLight, fog: live.fog, base: live.base, belly: live.belly, finWhite: live.finWhite,
          rim: live.rim, faceAlpha: live.faceAlpha, line: live.line, point: live.point, time,
          backLine: live.backLine, lenRef: live.lenRef,
        });
      }
      drawSkeleton(sk, live.persp);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      gl.deleteBuffer(vbo);
      gl.deleteProgram(prog);
    };
  }, []);

  const set = (patch: Values) => setValues((v) => ({ ...v, ...patch }));

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "100vh", overflow: "hidden", background: "#050505" }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />
      <canvas ref={overlayRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", pointerEvents: "none" }} />
      <Panel title="WHALE LAB" groups={GROUPS} values={values} onChange={set}>
        {{
          top: (
            <>
              <div style={{ color: "rgba(255,255,255,0.45)", margin: "14px 0 6px" }}>泳ぎ方</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {SWIMS.map((s) => (
                  <PanelButton key={s.name} onClick={() => set(s.values)} style={{ flex: "1 0 40%", padding: "6px 0" }}>
                    {s.name}
                  </PanelButton>
                ))}
              </div>
            </>
          ),
          bottom: (
            <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
              <PanelButton onClick={() => setPaused((v) => !v)}>{paused ? "再生" : "一時停止"}</PanelButton>
              <PanelButton onClick={() => setValues(DEFAULTS)}>リセット</PanelButton>
            </div>
          ),
        }}
      </Panel>
    </div>
  );
}
