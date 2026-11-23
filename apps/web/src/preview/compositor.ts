/**
 * Preview compositor on WebGL2: layers bottom to top over opaque black, each a textured quad with the engine's transform
 * (centre and scale in sequence pixels, rotation clockwise, opacity) plus the media's display rotation. Mirrors `app_render::Layer`
 * semantics so the preview and the export agree. The Rust wgpu compositor is not bound to the web build yet: docs/features/preview.md.
 */
import { displaySize, placeLayer, textureMatrix } from "./layout";

export interface RenderLayer {
  /** Pixels: a decoded `VideoFrame` (GPU frame) or RGBA bytes. */
  source: VideoFrame | { rgba: Uint8Array };
  /** Coded size of the pixels. */
  width: number;
  height: number;
  /** Probe rotation, clockwise degrees. */
  rotation: number;
  center: [number, number];
  scale: [number, number];
  /** Transform rotation, radians clockwise. */
  angle: number;
  opacity: number;
}

export interface Renderer {
  /** Draw the layers into the canvas; `seq` is the sequence size the layer coordinates are in. */
  render(layers: readonly RenderLayer[], seq: { width: number; height: number }): void;
  resize(width: number, height: number): void;
  /** Pixels of the last frame at (x, y) in canvas pixels, for tests and A/V measurement. */
  probe(x: number, y: number): [number, number, number];
  dispose(): void;
}

const VS = `#version 300 es
in vec2 q;
uniform vec2 u_seq; uniform vec2 u_center; uniform vec2 u_half; uniform vec2 u_rot; uniform vec4 u_tex;
out vec2 v_uv;
void main() {
  vec2 p = q * u_half * 2.0;
  vec2 r = vec2(p.x * u_rot.x - p.y * u_rot.y, p.x * u_rot.y + p.y * u_rot.x) + u_center;
  gl_Position = vec4(r.x / u_seq.x * 2.0 - 1.0, 1.0 - r.y / u_seq.y * 2.0, 0.0, 1.0);
  v_uv = vec2(u_tex.x * q.x + u_tex.y * q.y, u_tex.z * q.x + u_tex.w * q.y) + 0.5;
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 v_uv; uniform sampler2D u_img; uniform float u_opacity; out vec4 o;
void main() { o = vec4(texture(u_img, v_uv).rgb, u_opacity); }`;

/** WebGL2 renderer. Throws if the context cannot be created; callers fall back to `createCanvas2dRenderer`. */
export function createGlRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  if (!gl) throw new Error("WebGL2 is not available");
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "program");
  gl.useProgram(prog);
  const u = (n: string) => gl.getUniformLocation(prog, n);
  const loc = { seq: u("u_seq"), center: u("u_center"), half: u("u_half"), rot: u("u_rot"), tex: u("u_tex"), opacity: u("u_opacity"), img: u("u_img") };
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
  const qLoc = gl.getAttribLocation(prog, "q");
  gl.enableVertexAttribArray(qLoc);
  gl.vertexAttribPointer(qLoc, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(loc.img, 0);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
  // One texture per layer slot, reused every frame (no per-frame GPU allocation in steady state).
  const slots: WebGLTexture[] = [];
  const slotSize: [number, number][] = [];
  const slot = (i: number) => {
    if (!slots[i]) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      slots[i] = t;
      slotSize[i] = [0, 0];
    }
    return slots[i]!;
  };

  return {
    resize(width, height) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    },
    render(layers, seq) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(loc.seq, seq.width, seq.height);
      layers.forEach((l, i) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, slot(i));
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        if ("rgba" in l.source) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, l.width, l.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, l.source.rgba);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, l.source);
        const d = placeLayer(displaySize(l.width, l.height, l.rotation), l.center, l.scale);
        gl.uniform2f(loc.center, d.cx, d.cy);
        gl.uniform2f(loc.half, d.hw, d.hh);
        gl.uniform2f(loc.rot, Math.cos(l.angle), Math.sin(l.angle));
        gl.uniform4fv(loc.tex, textureMatrix(l.rotation));
        gl.uniform1f(loc.opacity, Math.min(1, Math.max(0, l.opacity)));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      });
    },
    probe(x, y) {
      const px = new Uint8Array(4);
      gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [px[0]!, px[1]!, px[2]!];
    },
    dispose() {
      for (const t of slots) gl.deleteTexture(t);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    },
  };
}
