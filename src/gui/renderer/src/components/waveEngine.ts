/**
 * Fake-3D dot wave. A flat grid of points is displaced by layered sine waves
 * and drawn through a tilted perspective camera. Everything runs in the vertex
 * shader, so the CPU only uploads a few uniforms per frame. The canvas is
 * transparent (premultiplied alpha) so the window's Mica material shows through.
 */

export type DotWaveMode = 'on' | 'reduced' | 'off';

const TIERS = [
  { cols: 150, rows: 84 },
  { cols: 110, rows: 62 },
  { cols: 76, rows: 44 },
];
const MAX_RIPPLES = 4;
/** Review hook: a hidden capture window is never focused, so allow measuring the focused path. */
const FORCE_FOCUS = new URLSearchParams(window.location.search).has('forcefocus');
const COBALT: [number, number, number] = [0.357, 0.549, 1.0];
const CYAN: [number, number, number] = [0.42, 0.84, 1.0];

const VERTEX = `
attribute vec2 a_g;
uniform float u_t;
uniform vec2 u_res;
uniform vec2 u_tilt;
uniform float u_amp;
uniform float u_pt;
uniform vec4 u_rip[${MAX_RIPPLES}];
uniform vec3 u_c0;
uniform vec3 u_c1;
varying float v_a;
varying vec3 v_c;

const float PITCH = 0.36;
const float CAM_Y = 2.7;
const float FOV = 0.62;

void main() {
  float x = a_g.x * 9.0;
  float z = a_g.y * 15.0;
  float h = sin(x * 0.55 + u_t * 0.70) * 0.55
          + sin(z * 0.70 - u_t * 0.90 + x * 0.20) * 0.45
          + sin((x + z) * 0.33 + u_t * 0.50) * 0.35
          + sin(x * 1.30 - z * 0.90 + u_t * 1.40) * 0.12;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    float age = u_t - u_rip[i].z;
    if (age > 0.0 && age < 4.5) {
      float d = distance(vec2(x, z), u_rip[i].xy);
      float r = age * 3.4;
      h += sin((d - r) * 2.3) * exp(-abs(d - r) * 1.15) * exp(-age * 0.85) * u_rip[i].w;
    }
  }
  h *= u_amp;

  vec3 q = vec3(x, h - CAM_Y, z);
  float cy = cos(u_tilt.x);
  float sy = sin(u_tilt.x);
  q = vec3(q.x * cy - q.z * sy, q.y, q.x * sy + q.z * cy);
  float cp = cos(PITCH + u_tilt.y);
  float sp = sin(PITCH + u_tilt.y);
  float vy = q.y * cp + q.z * sp;
  float vz = -q.y * sp + q.z * cp + 5.2;
  float t = tan(FOV);
  float aspect = u_res.x / u_res.y;
  vec2 ndc = vec2(q.x / (vz * t * aspect), vy / (vz * t)) * 1.55;
  gl_Position = vec4(ndc.x, ndc.y - 0.12, 0.0, 1.0);

  float size = clamp(u_pt * (u_res.y / 900.0) * 30.0 / vz, 1.4, 18.0);
  gl_PointSize = size;

  float far = 1.0 - smoothstep(0.62, 1.0, a_g.y);
  float near = smoothstep(0.0, 0.07, a_g.y);
  float side = 1.0 - smoothstep(0.72, 1.0, abs(a_g.x));
  v_a = far * near * side * (0.5 + 0.5 * clamp(h * 0.7 + 0.5, 0.0, 1.0));
  v_c = mix(u_c0, u_c1, clamp(h * 0.6 + 0.5, 0.0, 1.0));
}`;

const FRAGMENT = `
precision mediump float;
varying float v_a;
varying vec3 v_c;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d) * v_a;
  gl_FragColor = vec4(v_c * a, a);
}`;

interface Ripple {
  x: number;
  z: number;
  start: number;
  strength: number;
}

export interface DotWave {
  setMode(mode: DotWaveMode): void;
  ripple(clientX: number, clientY: number): void;
  dispose(): void;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Same camera maths as the shader, for the Canvas2D fallback. */
function project(x: number, z: number, t: number, tilt: [number, number], w: number, h: number) {
  let height = Math.sin(x * 0.55 + t * 0.7) * 0.55 + Math.sin(z * 0.7 - t * 0.9 + x * 0.2) * 0.45 + Math.sin((x + z) * 0.33 + t * 0.5) * 0.35;
  height *= 0.9;
  let qx = x;
  const qy = height - 2.7;
  let qz = z;
  const cy = Math.cos(tilt[0]);
  const sy = Math.sin(tilt[0]);
  [qx, qz] = [qx * cy - qz * sy, qx * sy + qz * cy];
  const cp = Math.cos(0.36 + tilt[1]);
  const sp = Math.sin(0.36 + tilt[1]);
  const vy = qy * cp + qz * sp;
  const vz = -qy * sp + qz * cp + 5.2;
  const tf = Math.tan(0.62);
  const nx = (qx / (vz * tf * (w / h))) * 1.55;
  const ny = (vy / (vz * tf)) * 1.55 - 0.12;
  return { sx: (nx * 0.5 + 0.5) * w, sy: (1 - (ny * 0.5 + 0.5)) * h, vz, height };
}

export function createDotWave(canvas: HTMLCanvasElement, initialMode: DotWaveMode): DotWave {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' }) as WebGLRenderingContext | null;

  let mode: DotWaveMode = initialMode;
  let raf = 0;
  let tier = 0;
  let width = 1;
  let height = 1;
  let dpr = 1;
  let lastDraw = 0;
  let frames = 0;
  let slowFrames = 0;
  let tilt: [number, number] = [0, 0];
  let tiltTarget: [number, number] = [0, 0];
  const ripples: Ripple[] = [];
  const start = performance.now();
  const clock = () => (performance.now() - start) / 1000;
  const STATIC_TIME = 2.4;

  // ---- WebGL path -----------------------------------------------------------
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let count = 0;
  const loc: Record<string, WebGLUniformLocation | null> = {};
  let aGrid = -1;

  function buildGrid() {
    if (!gl) return;
    const { cols, rows } = TIERS[tier];
    const data = new Float32Array(cols * rows * 2);
    let k = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Small deterministic jitter keeps the grid from looking mechanical.
        const jitter = ((r * 37 + c * 17) % 7) / 7 - 0.5;
        data[k++] = (c / (cols - 1)) * 2 - 1 + (jitter * 0.4) / cols;
        data[k++] = r / (rows - 1);
      }
    }
    count = cols * rows;
    if (!buffer) buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  }

  if (gl) {
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    program = gl.createProgram();
    if (vs && fs && program) {
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.useProgram(program);
        aGrid = gl.getAttribLocation(program, 'a_g');
        for (const name of ['u_t', 'u_res', 'u_tilt', 'u_amp', 'u_pt', 'u_rip', 'u_c0', 'u_c1']) loc[name] = gl.getUniformLocation(program, name);
        gl.uniform3f(loc.u_c0, ...COBALT);
        gl.uniform3f(loc.u_c1, ...CYAN);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0, 0, 0, 0);
        buildGrid();
      } else program = null;
    } else program = null;
  }
  const useGl = Boolean(gl && program);

  // ---- Canvas2D fallback ----------------------------------------------------
  const ctx2d = useGl ? null : canvas.getContext('2d');

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (gl && useGl) gl.viewport(0, 0, width, height);
  }

  function draw(time: number) {
    if (useGl && gl) {
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(loc.u_t, time);
      gl.uniform2f(loc.u_res, width, height);
      gl.uniform2f(loc.u_tilt, tilt[0], tilt[1]);
      gl.uniform1f(loc.u_amp, 1.55);
      gl.uniform1f(loc.u_pt, 1.0 + (TIERS[tier].cols < 100 ? 0.45 : 0));
      const flat = new Float32Array(MAX_RIPPLES * 4);
      ripples.forEach((rp, i) => flat.set([rp.x, rp.z, rp.start, rp.strength], i * 4));
      gl.uniform4fv(loc.u_rip, flat);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(aGrid);
      gl.vertexAttribPointer(aGrid, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, count);
    } else if (ctx2d) {
      ctx2d.clearRect(0, 0, width, height);
      const cols = 72;
      const rows = 40;
      for (let r = 0; r < rows; r++) {
        const gz = r / (rows - 1);
        const far = 1 - Math.min(1, Math.max(0, (gz - 0.35) / 0.65));
        for (let c = 0; c < cols; c++) {
          const gx = (c / (cols - 1)) * 2 - 1;
          const p = project(gx * 9, gz * 15, time, tilt, width, height);
          const side = 1 - Math.min(1, Math.max(0, (Math.abs(gx) - 0.72) / 0.28));
          const alpha = far * side * Math.min(1, gz / 0.07) * (0.45 + 0.55 * Math.min(1, Math.max(0, p.height * 0.9 + 0.5)));
          if (alpha < 0.02) continue;
          const mixAmount = Math.min(1, Math.max(0, p.height * 0.6 + 0.5));
          const col = COBALT.map((v, i) => Math.round((v + (CYAN[i] - v) * mixAmount) * 255));
          ctx2d.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha.toFixed(3)})`;
          const size = Math.min(7, Math.max(1.2, ((width / 1300) * 9) / p.vz));
          ctx2d.fillRect(p.sx - size / 2, p.sy - size / 2, size, size);
        }
      }
    }
  }

  function frame(now: number) {
    raf = 0;
    if (mode !== 'on' || reduceMotion.matches || document.hidden) return;
    const focused = document.hasFocus() || FORCE_FOCUS;
    const interval = 1000 / (focused ? (useGl ? 30 : 20) : 10);
    if (now - lastDraw >= interval - 1) {
      const dt = now - lastDraw;
      lastDraw = now;
      tilt = [tilt[0] + (tiltTarget[0] - tilt[0]) * 0.06, tilt[1] + (tiltTarget[1] - tilt[1]) * 0.06];
      const time = clock();
      for (let i = ripples.length - 1; i >= 0; i--) if (time - ripples[i].start > 4.5) ripples.splice(i, 1);
      draw(time);
      // Adaptive quality: step down a tier when frames keep running long.
      if (useGl && focused && ++frames > 40) {
        if (dt > interval * 1.7) slowFrames++;
        if (slowFrames > 24 && tier < TIERS.length - 1) {
          tier++;
          slowFrames = 0;
          frames = 0;
          buildGrid();
        }
      }
    }
    raf = requestAnimationFrame(frame);
  }

  function schedule() {
    cancelAnimationFrame(raf);
    raf = 0;
    canvas.style.display = mode === 'off' ? 'none' : 'block';
    if (mode === 'off') return;
    resize();
    if (mode === 'on' && !reduceMotion.matches && !document.hidden) {
      lastDraw = 0;
      raf = requestAnimationFrame(frame);
    } else {
      draw(STATIC_TIME);
    }
  }

  const onResize = () => {
    resize();
    if (mode === 'reduced' || reduceMotion.matches) draw(STATIC_TIME);
  };
  const onVisibility = () => schedule();
  const onMove = (event: PointerEvent) => {
    tiltTarget = [((event.clientX / window.innerWidth) * 2 - 1) * 0.07, ((event.clientY / window.innerHeight) * 2 - 1) * -0.04];
  };
  const api: DotWave = {
    setMode(next) {
      mode = next;
      schedule();
    },
    ripple(clientX, clientY) {
      if (mode !== 'on' || reduceMotion.matches) return;
      const wx = (clientX / window.innerWidth) * 2 - 1;
      const wy = clientY / window.innerHeight;
      ripples.push({ x: wx * 8, z: 2 + (1 - wy) * 9, start: clock(), strength: 0.9 });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVisibility);
      reduceMotion.removeEventListener('change', onVisibility);
    },
  };
  const onDown = (event: PointerEvent) => api.ripple(event.clientX, event.clientY);

  window.addEventListener('resize', onResize);
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onDown, { passive: true, capture: true });
  const baseDispose = api.dispose;
  api.dispose = () => {
    window.removeEventListener('pointerdown', onDown, true);
    baseDispose();
  };
  document.addEventListener('visibilitychange', onVisibility);
  reduceMotion.addEventListener('change', onVisibility);
  schedule();
  return api;
}
