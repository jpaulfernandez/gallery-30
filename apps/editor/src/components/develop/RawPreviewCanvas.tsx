import { useEffect, useRef } from 'react';
import { devLog } from '../../lib/log';
import { painted } from './previewTiming';
import type { RawFrame } from './rawPreview';

/**
 * Workflow plan 36: draws a raw preview frame (`rawPreview.ts`) into a WebGL2 canvas, one texture upload and one quad
 * per frame, scaled by CSS like the `<img>` it stands in for. Dev builds with `photobook.rawPreview` only.
 */

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) * 2 - 1), float((gl_VertexID >> 1) * 2 - 1));
  uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D tex;
in vec2 uv;
out vec4 color;
void main() {
  color = texture(tex, uv);
}`;

interface Gl {
  gl: WebGL2RenderingContext;
  texture: WebGLTexture;
  size: { width: number; height: number } | null;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function setup(canvas: HTMLCanvasElement): Gl | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false });
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  const texture = gl.createTexture();
  if (!vs || !fs || !program || !texture) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
  gl.useProgram(program);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  return { gl, texture, size: null };
}

/** Upload `frame` and draw it; returns the time the calls took (the GPU finishes them before the composite). */
function draw(state: Gl, canvas: HTMLCanvasElement, frame: RawFrame): number {
  const start = performance.now();
  const { gl } = state;
  const space = frame.profile === 'display-p3' ? 'display-p3' : 'srgb';
  if ('drawingBufferColorSpace' in gl && gl.drawingBufferColorSpace !== space) gl.drawingBufferColorSpace = space;
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  gl.viewport(0, 0, frame.width, frame.height);
  gl.bindTexture(gl.TEXTURE_2D, state.texture);
  const { width, height } = frame;
  if (state.size?.width === width && state.size.height === height) {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, frame.pixels);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.pixels);
    state.size = { width, height };
  }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return performance.now() - start;
}

export function RawPreviewCanvas({ frame, hidden }: { frame: RawFrame; hidden: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<Gl | null>(null);

  // No `loseContext()` on unmount: StrictMode's simulated unmount would lose the context the remounted effect reuses
  // (`getContext` returns the same, lost, context). The context goes with the canvas.
  useEffect(
    () => () => {
      glRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!glRef.current || glRef.current.gl.isContextLost()) glRef.current = setup(canvas);
    const state = glRef.current;
    if (!state) {
      devLog('develop', 'raw preview: no WebGL2 context');
      return;
    }
    const ms = draw(state, canvas, frame);
    painted(`raw:${frame.job}`, ms);
  }, [frame]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="develop-raw-preview"
      className={`absolute inset-0 h-full w-full object-contain ${hidden ? 'invisible' : ''}`}
    />
  );
}
