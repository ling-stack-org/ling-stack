// Pointer-driven sword-light trail for the "farbound journey" scene theme.
//
// Written for this project; no third-party source is vendored. The look is a
// hair-thin filament of warm light with a soft halo and a hot leading tip, and it
// is produced by a small GPU stable-fluids simulation:
//
//   capsule injection -> velocity self-advection -> divergence -> Jacobi pressure
//   -> gradient projection -> MacCormack dye advection -> 6-level bloom -> composite
//
// Two details carry most of the visual quality:
//
// 1. The dye target does not hold an RGB colour. It holds three physical
//    quantities, and the colour is reconstructed at composite time:
//      x = energy (amount of light)
//      y = heat   (freshness; decays far faster than energy)
//      z = halo   (same stroke, much wider and much dimmer)
//    Because heat drains first, the leading tip stays bright while the tail cools
//    into the darker secondary tone, which is what reads as "a blade passing".
//
// 2. Velocity is *blended* into the field along the stroke instead of added to
//    it. Adding force every frame builds a standing pressure wave that shows up
//    as a chain of beads along the path; blending cannot accumulate, so repeated
//    frames stay smooth no matter how fast the pointer moves.
import { useEffect, useRef, type CSSProperties, type HTMLAttributes } from "react";

export interface SwordLightTrailProps extends Omit<HTMLAttributes<HTMLDivElement>, "color"> {
  readonly color?: string;
  readonly secondaryColor?: string;
  readonly intensity?: number;
  readonly trailWidth?: number;
  readonly linger?: number;
  readonly glow?: number;
  readonly hotspot?: number;
  readonly followSpeed?: number;
  readonly clickBurst?: boolean;
  readonly maxDevicePixelRatio?: number;
  readonly enabled?: boolean;
}

interface Settings {
  color: string;
  secondaryColor: string;
  intensity: number;
  trailWidth: number;
  linger: number;
  glow: number;
  hotspot: number;
  followSpeed: number;
  clickBurst: boolean;
  maxDevicePixelRatio: number;
  enabled: boolean;
}

interface Target {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
}

interface Pair {
  readonly read: () => Target;
  readonly write: () => Target;
  readonly swap: () => void;
  readonly both: () => readonly Target[];
}

interface Program {
  readonly program: WebGLProgram;
  readonly uniform: Record<string, WebGLUniformLocation | null>;
}

const VERTEX = `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uTexel;

// Targets are NEAREST-filtered so the simulation needs no float-linear
// extension; interpolation is done by hand where it matters.
vec4 sampleBilinear(sampler2D source, vec2 uv, vec2 texel) {
  vec2 p = uv / texel - 0.5;
  vec2 cell = floor(p);
  vec2 f = p - cell;
  vec2 base = (cell + 0.5) * texel;
  vec4 a = texture(source, base);
  vec4 b = texture(source, base + vec2(texel.x, 0.0));
  vec4 c = texture(source, base + vec2(0.0, texel.y));
  vec4 d = texture(source, base + texel);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`;

const SPLAT = HEADER + `

uniform sampler2D uSource;
uniform vec2 uA;
uniform vec2 uB;
uniform float uAspect;
uniform float uRadius;
uniform float uWide;
uniform vec3 uValue;
uniform vec3 uCap;
uniform float uStrength;
uniform float uMode;

float erfApprox(float x) {
  float x2 = x * x;
  float k = 1.0 + 0.147 * x2;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + 0.147 * x2) / k));
}

// Round-capped capsule: constant weight along the stroke, feathered only across
// it and at the two caps. Constant weight is why a fast pointer still paints one
// even line instead of a row of dots.
float capsule(float along, float length, float across, float radius) {
  float across2 = across * across / max(radius * radius, 1e-8);
  return exp(-across2) * 0.5 * (erfApprox(along / radius) - erfApprox((along - length) / radius));
}

// Core profile. A flat-topped core keeps its full width however dim it gets,
// which reads as an even painted band; a peaked profile loses width as the dye
// dims, so the far end of a stroke narrows to a point the way a blade does.
float filament(float along, float length, float across, float radius) {
  float across2 = across * across / max(radius * radius, 1e-8);
  return exp(-across2 * 1.15) * 0.5 * (erfApprox(along / radius) - erfApprox((along - length) / radius));
}

void main() {
  vec3 base = texture(uSource, vUv).rgb;
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec2 a = vec2(uA.x * uAspect, uA.y);
  vec2 ab = vec2(uB.x * uAspect, uB.y) - a;
  float length2 = length(ab);
  vec2 dir = length2 > 1e-6 ? ab / max(length2, 1e-6) : vec2(1.0, 0.0);
  vec2 ap = p - a;
  float along = dot(ap, dir);
  float across = dot(ap, vec2(-dir.y, dir.x));
  // Keep a minimum span: for a nearly stationary pointer the two erf caps of a
  // collapsed capsule would cancel out and leave a gap in the stroke.
  float span = max(length2, uRadius * 1.5);
  if (uMode > 0.5) {
    // Velocity: pull the local field towards the stroke velocity. A blend cannot
    // stack up frame after frame, so no pressure ripple forms along the path.
    float weight = clamp(capsule(along, span, across, uRadius) * uStrength, 0.0, 1.0);
    fragColor = vec4(mix(base, uValue, weight), 1.0);
    return;
  }
  // Dye: energy and heat share the thin core radius, halo uses the wide one.
  float core = filament(along, span, across, uRadius);
  float halo = capsule(along, span, across, uWide);
  vec3 add = vec3(uValue.xy * core, uValue.z * halo) * uStrength;
  // Saturating injection. The deposit per frame is already close to the cap, so
  // a fast stroke paints evenly, while a slow or parked pointer converges on the
  // cap instead of stacking frame after frame into a blown-out white wedge.
  fragColor = vec4(uCap - (uCap - base) * exp(-add / uCap), 1.0);
}`;

const ADVECT = HEADER + `

uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uVelocityTexel;
uniform float uTimestep;
uniform vec3 uDecay;

void main() {
  vec2 coord = vUv - uTimestep * texture(uVelocity, vUv).xy * uVelocityTexel;
  fragColor = sampleBilinear(uSource, coord, uTexel) * vec4(uDecay, 1.0);
}`;

const MACCORMACK = HEADER + `

uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform sampler2D uForward;
uniform sampler2D uBack;
uniform vec2 uVelocityTexel;
uniform vec2 uSourceTexel;
uniform float uTimestep;
uniform vec3 uDecay;

void main() {
  vec2 coord = vUv - uTimestep * texture(uVelocity, vUv).xy * uVelocityTexel;
  vec4 forward = texture(uForward, vUv);
  vec4 corrected = forward + 0.5 * (texture(uSource, vUv) - texture(uBack, vUv));
  // Clamp the correction to the four source texels around the departure point.
  // Plain bilinear advection erases a one-texel filament within a few frames;
  // this keeps the edge of the stroke intact however far the light travels.
  vec2 base = (floor(coord / uSourceTexel - 0.5) + 0.5) * uSourceTexel;
  vec4 a = texture(uSource, base);
  vec4 b = texture(uSource, base + vec2(uSourceTexel.x, 0.0));
  vec4 c = texture(uSource, base + vec2(0.0, uSourceTexel.y));
  vec4 d = texture(uSource, base + uSourceTexel);
  vec4 low = min(min(a, b), min(c, d));
  vec4 high = max(max(a, b), max(c, d));
  fragColor = clamp(corrected, low, high) * vec4(uDecay, 1.0);
}`;

const DIVERGENCE = HEADER + `

uniform sampler2D uVelocity;

void main() {
  float left = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float right = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float bottom = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float top = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  fragColor = vec4(0.5 * (right - left + top - bottom), 0.0, 0.0, 1.0);
}`;

const SCALE = HEADER + `

uniform sampler2D uSource;
uniform float uAmount;

void main() {
  fragColor = vec4(texture(uSource, vUv).rgb * uAmount, 1.0);
}`;

const PRESSURE = HEADER + `

uniform sampler2D uPressure;
uniform sampler2D uDivergence;

void main() {
  float left = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float right = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float bottom = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float top = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float divergence = texture(uDivergence, vUv).x;
  fragColor = vec4((left + right + bottom + top - divergence) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT = HEADER + `

uniform sampler2D uPressure;
uniform sampler2D uVelocity;

void main() {
  float left = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float right = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float bottom = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float top = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  vec2 velocity = texture(uVelocity, vUv).xy - 0.5 * vec2(right - left, top - bottom);
  fragColor = vec4(velocity, 0.0, 1.0);
}`;

// Shared legend between the prefilter and the composite so the bloom chain is
// built from exactly the same light the composite shows.
const SHADE = `
uniform vec3 uColor;
uniform vec3 uSecondary;
uniform float uIntensity;
uniform float uHotspot;

vec3 shadeDye(vec3 dye) {
  float energy = max(dye.x, 0.0);
  float heat = clamp(dye.y, 0.0, energy);
  float halo = max(dye.z, 0.0);
  float fresh = heat / max(energy, 1e-4);
  vec3 tint = mix(uSecondary, uColor, fresh);
  return (tint * energy + uSecondary * halo + vec3(heat * heat * 0.45 * uHotspot)) * uIntensity;
}
`;

const PREFILTER = HEADER + SHADE + `

uniform sampler2D uDye;

void main() {
  vec2 offset = uTexel * 0.5;
  vec3 light = shadeDye(texture(uDye, vUv + vec2(-offset.x, -offset.y)).rgb);
  light += shadeDye(texture(uDye, vUv + vec2(offset.x, -offset.y)).rgb);
  light += shadeDye(texture(uDye, vUv + vec2(-offset.x, offset.y)).rgb);
  light += shadeDye(texture(uDye, vUv + vec2(offset.x, offset.y)).rgb);
  fragColor = vec4(light * 0.25, 1.0);
}`;

const DOWN = HEADER + `

uniform sampler2D uSource;

void main() {
  vec2 offset = uTexel;
  vec3 color = texture(uSource, vUv).rgb * 4.0;
  color += texture(uSource, vUv + vec2(-offset.x, -offset.y)).rgb;
  color += texture(uSource, vUv + vec2(offset.x, -offset.y)).rgb;
  color += texture(uSource, vUv + vec2(-offset.x, offset.y)).rgb;
  color += texture(uSource, vUv + vec2(offset.x, offset.y)).rgb;
  fragColor = vec4(color / 8.0, 1.0);
}`;

const UP = HEADER + `

uniform sampler2D uSource;

// Tent upsample, accumulated additively into the coarser level's parent.
void main() {
  vec2 offset = uTexel;
  vec3 color = texture(uSource, vUv + vec2(-offset.x * 2.0, 0.0)).rgb;
  color += texture(uSource, vUv + vec2(offset.x * 2.0, 0.0)).rgb;
  color += texture(uSource, vUv + vec2(0.0, -offset.y * 2.0)).rgb;
  color += texture(uSource, vUv + vec2(0.0, offset.y * 2.0)).rgb;
  color += texture(uSource, vUv + vec2(-offset.x, -offset.y)).rgb * 2.0;
  color += texture(uSource, vUv + vec2(offset.x, -offset.y)).rgb * 2.0;
  color += texture(uSource, vUv + vec2(-offset.x, offset.y)).rgb * 2.0;
  color += texture(uSource, vUv + vec2(offset.x, offset.y)).rgb * 2.0;
  fragColor = vec4(color / 12.0, 1.0);
}`;

const DISPLAY = HEADER + SHADE + `

uniform sampler2D uDye;
uniform sampler2D uBloom;
uniform vec2 uDyeTexel;
uniform vec2 uBloomTexel;
uniform float uGlow;

void main() {
  vec3 light = shadeDye(sampleBilinear(uDye, vUv, uDyeTexel).rgb);
  vec3 bloom = sampleBilinear(uBloom, vUv, uBloomTexel).rgb * uGlow;
  // Exponential tone-map: overlapping frames compress towards white instead of
  // clipping into hard beads, so the stroke keeps a smooth silhouette.
  vec3 color = 1.0 - exp(-(light + bloom));
  // Feather the layer edge so the trail never cuts a line at the canvas border.
  float edge = smoothstep(0.0, 0.02, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
  color *= edge;
  // Alpha tracks the brightest channel: untouched pixels stay transparent, so the
  // scene underneath is never covered even when the wrapper isolates blending.
  fragColor = vec4(color, clamp(max(max(color.r, color.g), color.b), 0.0, 1.0));
}`;

const SIM_SIZE = 160;
const DYE_SIZE = 1024;
const PRESSURE_ITERATIONS = 20;
const BLOOM_LEVELS = 6;

// Pointer follow is a critically damped spring. A high stiffness keeps the light
// under the hand instead of swimming behind it: at followSpeed 0.6 the settle
// constant is ~9 ms, well under a frame, so the tip reads as attached.
const FOLLOW_OMEGA = (followSpeed: number) => 18 + followSpeed * 150;
// A little force keeps the stroke from looking ruler-straight. Larger values
// push dye ahead of the pointer and make the light lead the hand.
const VELOCITY_BLEND = 0.18;
// A pointer that jumps (a synthetic move, a window switch, a very fast flick)
// would otherwise inject an enormous stroke velocity, and the solver turns that
// into a visible swirl. Clamp the injected speed to a fast-but-human flick.
const SPEED_LIMIT = 2600;
// Per-frame deposit. One frame already lands at roughly two thirds of the cap,
// so a moving stroke paints a mid-bright line and only overlapping frames (a
// slow or parked pointer) climb to full brightness.
const CORE_ENERGY = 5.4;
const HALO_ENERGY = 1.4;
const DYE_CAP: [number, number, number] = [5.4, 4.4, 2.3];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function toRgb(color: string): [number, number, number] {
  const match = /^#?([\da-f]{6})$/iu.exec(color.trim());
  if (!match) return [0.769, 0.604, 0.388];
  const value = Number.parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function createSim(canvas: HTMLCanvasElement, container: HTMLElement, readSettings: () => Settings) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;
  const floatExt = gl.getExtension("EXT_color_buffer_float");
  if (!floatExt) return null;

  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX);
  if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS)) return null;

  const programFor = (fragment: string): Program | null => {
    const shader = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    const uniform: Record<string, WebGLUniformLocation | null> = {};

    const total = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let index = 0; index < total; index += 1) {
      const info = gl.getActiveUniform(program, index);
      if (info) uniform[info.name] = gl.getUniformLocation(program, info.name);
    }
    return { program, uniform };
  };

  const splatProgram = programFor(SPLAT);
  const advectProgram = programFor(ADVECT);
  const maccormackProgram = programFor(MACCORMACK);
  const divergenceProgram = programFor(DIVERGENCE);
  const scaleProgram = programFor(SCALE);
  const pressureProgram = programFor(PRESSURE);
  const gradientProgram = programFor(GRADIENT);
  const prefilterProgram = programFor(PREFILTER);
  const downProgram = programFor(DOWN);
  const upProgram = programFor(UP);
  const displayProgram = programFor(DISPLAY);
  if (!splatProgram || !advectProgram || !maccormackProgram || !divergenceProgram || !scaleProgram
    || !pressureProgram || !gradientProgram || !prefilterProgram || !downProgram || !upProgram
    || !displayProgram) return null;

  const buffer = gl.createBuffer();
  const vao = gl.createVertexArray();
  if (!buffer || !vao) return null;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const target = (targetWidth: number, targetHeight: number): Target | null => {
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, targetWidth, targetHeight, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, targetWidth, targetHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture, framebuffer, width: targetWidth, height: targetHeight };
  };

  const pair = (pairWidth: number, pairHeight: number): Pair | null => {
    const first = target(pairWidth, pairHeight);
    const second = target(pairWidth, pairHeight);
    if (!first || !second) return null;
    let head: Target = first;
    return {
      read: () => head,
      write: () => (head === first ? second : first),
      swap: () => { head = head === first ? second : first; },
      both: () => [first, second],
    };
  };

  interface Surface {
    readonly sim: Pair;
    readonly dye: Pair;
    readonly pressure: Pair;
    readonly divergence: Target;
    readonly forward: Target;
    readonly back: Target;
    readonly bloom: readonly Target[];
  }

  let surface: Surface | null = null;
  let allocated = "";
  let width = 1;
  let height = 1;
  let alive = true;
  let visible = true;
  let frame = 0;
  let last = 0;
  let activeAt = 0;
  let colorCache = "";
  let dyeColor: [number, number, number] = [0.769, 0.604, 0.388];
  let dyeSecondary: [number, number, number] = [0.604, 0.455, 0.282];

  const pointer = { x: 0, y: 0, inside: false, ready: false };
  const emitter = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0 };
  const bursts: Array<[number, number]> = [];

  const surfaceTargets = (items: Surface): Target[] => [
    ...items.sim.both(),
    ...items.dye.both(),
    ...items.pressure.both(),
    items.divergence,
    items.forward,
    items.back,
    ...items.bloom,
  ];

  const disposeSurface = () => {
    if (!surface) return;
    for (const item of surfaceTargets(surface)) {
      gl.deleteTexture(item.texture);
      gl.deleteFramebuffer(item.framebuffer);
    }
    surface = null;
  };

  const allocate = () => {
    const key = width + "x" + height + ":" + canvas.width + "x" + canvas.height;
    if (key === allocated && surface) return;
    disposeSurface();
    allocated = key;
    const aspect = width / height;
    const dims = (base: number): [number, number] => (aspect >= 1
      ? [Math.round(base * aspect), base]
      : [base, Math.round(base / aspect)]);
    const [simWidth, simHeight] = dims(SIM_SIZE);
    let [dyeWidth, dyeHeight] = dims(DYE_SIZE);
    const shrink = Math.min(1, canvas.width / dyeWidth, canvas.height / dyeHeight);
    dyeWidth = Math.max(2, Math.round(dyeWidth * shrink));
    dyeHeight = Math.max(2, Math.round(dyeHeight * shrink));
    const sim = pair(simWidth, simHeight);
    const dye = pair(dyeWidth, dyeHeight);
    const pressure = pair(simWidth, simHeight);
    const divergence = target(simWidth, simHeight);
    const forward = target(dyeWidth, dyeHeight);
    const back = target(dyeWidth, dyeHeight);
    if (!sim || !dye || !pressure || !divergence || !forward || !back) return;
    const bloom: Target[] = [];
    let bloomWidth = dyeWidth >> 1;
    let bloomHeight = dyeHeight >> 1;
    for (let level = 0; level < BLOOM_LEVELS; level += 1) {
      const item = target(Math.max(1, bloomWidth), Math.max(1, bloomHeight));
      if (!item) return;
      bloom.push(item);
      bloomWidth >>= 1;
      bloomHeight >>= 1;
    }
    surface = { sim, dye, pressure, divergence, forward, back, bloom };
  };

  const resize = () => {
    const settings = readSettings();
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    const nextRatio = Math.min(window.devicePixelRatio || 1, Math.max(0.5, settings.maxDevicePixelRatio || 2));
    const pixelWidth = Math.max(1, Math.round(width * nextRatio));
    const pixelHeight = Math.max(1, Math.round(height * nextRatio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    allocate();
  };

  const use = (program: Program, texel: [number, number]) => {
    gl.useProgram(program.program);
    if (program.uniform.uTexel) gl.uniform2f(program.uniform.uTexel, texel[0], texel[1]);
    return program.uniform;
  };

  const bindTexture = (unit: number, texture: WebGLTexture) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    return unit;
  };

  const drawInto = (destination: Target | null) => {
    if (destination) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
      gl.viewport(0, 0, destination.width, destination.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const resolveColors = () => {
    const settings = readSettings();
    const key = settings.color + "|" + settings.secondaryColor;
    if (key === colorCache) return;
    colorCache = key;
    dyeColor = toRgb(settings.color);
    dyeSecondary = toRgb(settings.secondaryColor || settings.color);
  };

  const splat = (
    destination: Pair,
    from: [number, number],
    to: [number, number],
    radius: number,
    wide: number,
    value: [number, number, number],
    strength: number,
    mode: number,
    cap: [number, number, number] = [1, 1, 1],
  ) => {
    const uniforms = use(splatProgram, [1 / destination.read().width, 1 / destination.read().height]);
    gl.uniform1i(uniforms.uSource, bindTexture(0, destination.read().texture));
    gl.uniform1f(uniforms.uAspect, width / height);
    gl.uniform2f(uniforms.uA, from[0] / width, 1 - from[1] / height);
    gl.uniform2f(uniforms.uB, to[0] / width, 1 - to[1] / height);
    gl.uniform1f(uniforms.uRadius, radius / height);
    gl.uniform1f(uniforms.uWide, wide / height);
    gl.uniform3f(uniforms.uValue, value[0], value[1], value[2]);
    gl.uniform3f(uniforms.uCap, cap[0], cap[1], cap[2]);
    gl.uniform1f(uniforms.uStrength, strength);
    gl.uniform1f(uniforms.uMode, mode);
    drawInto(destination.write());
    destination.swap();
  };

  const lightRadius = (settings: Settings) => {
    const dyeTarget = surface ? surface.dye.read() : null;
    const cell = dyeTarget ? height / dyeTarget.height : 1;
    return Math.max(settings.trailWidth * 1.0, cell * 1.1);
  };

  const emit = (settings: Settings, dt: number, now: number) => {
    if (!surface) return;
    emitter.px = emitter.x;
    emitter.py = emitter.y;
    if (settings.followSpeed >= 1) {
      emitter.x = pointer.x;
      emitter.y = pointer.y;
      emitter.vx = 0;
      emitter.vy = 0;
    } else {
      // Exact critically damped solution x(t) = target + (A + B t) e^(-w t).
      // Integrating the spring in sub-steps over-shoots the cursor for one or
      // two frames at these stiffnesses, and the overshoot paints a bright blob
      // on the far side of the pointer. The closed form cannot overshoot.
      const omega = FOLLOW_OMEGA(settings.followSpeed);
      const decaySpring = Math.exp(-omega * dt);
      const ax = emitter.x - pointer.x;
      const ay = emitter.y - pointer.y;
      const bx = emitter.vx + omega * ax;
      const by = emitter.vy + omega * ay;
      emitter.x = pointer.x + (ax + bx * dt) * decaySpring;
      emitter.y = pointer.y + (ay + by * dt) * decaySpring;
      emitter.vx = (bx - omega * bx * dt - omega * ax) * decaySpring;
      emitter.vy = (by - omega * by * dt - omega * ay) * decaySpring;
    }
    const dx = emitter.x - emitter.px;
    const dy = emitter.y - emitter.py;
    if (!settings.enabled || Math.hypot(dx, dy) < 0.05) return;
    const radius = lightRadius(settings);
    const grid = surface.sim.read();
    const safeDt = Math.max(dt, 1e-3);
    const distance = Math.hypot(dx, dy);
    const speed = distance / safeDt;
    const gain = speed > SPEED_LIMIT ? SPEED_LIMIT / speed : 1;
    splat(
      surface.sim,
      [emitter.px, emitter.py],
      [emitter.x, emitter.y],
      radius * 3 + 12,
      radius,
      [
        (dx / safeDt) * gain * grid.width / width,
        (-dy / safeDt) * gain * grid.height / height,
        0,
      ],
      VELOCITY_BLEND,
      1,
    );
    splat(
      surface.dye,
      [emitter.px, emitter.py],
      [emitter.x, emitter.y],
      radius,
      radius * 8 + 12,
      [CORE_ENERGY, CORE_ENERGY, HALO_ENERGY],
      1,
      0,
      DYE_CAP,
    );
    activeAt = now;
  };

  // Click: six short rays fanning out from the point. They are painted as dye
  // only. Giving the burst velocity turns it into a rotating vortex ring, which
  // reads as a smoke bubble instead of a spark.
  const burst = (settings: Settings, x: number, y: number, now: number) => {
    if (!surface) return;
    const radius = lightRadius(settings);
    const base = Math.random() * Math.PI * 2;
    const jets = 6;
    const inner = radius * 0.6;
    for (let index = 0; index < jets; index += 1) {
      const angle = base + (index / jets) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const reach = 12 + Math.random() * 10;
      splat(
        surface.dye,
        [x + Math.cos(angle) * inner, y + Math.sin(angle) * inner],
        [x + Math.cos(angle) * reach, y + Math.sin(angle) * reach],
        radius * 0.75,
        radius * 2.6 + 4,
        [0.5, 0.8, 0.1],
        1,
        0,
        DYE_CAP,
      );
    }
    splat(surface.dye, [x, y], [x + 0.01, y], radius * 1.2, radius * 3 + 6, [0.35, 0.6, 0.1], 1, 0, DYE_CAP);
    activeAt = now;
  };

  const step = (settings: Settings, dt: number) => {
    if (!surface) return;
    const current = surface;
    const simTexel: [number, number] = [1 / current.sim.read().width, 1 / current.sim.read().height];

    // Velocity self-advection keeps the field fluid instead of a frozen smear.
    let uniforms = use(advectProgram, simTexel);
    gl.uniform1i(uniforms.uVelocity, bindTexture(0, current.sim.read().texture));
    gl.uniform1i(uniforms.uSource, bindTexture(0, current.sim.read().texture));
    gl.uniform2f(uniforms.uVelocityTexel, simTexel[0], simTexel[1]);
    gl.uniform1f(uniforms.uTimestep, dt);
    // The field has to die quickly: leftover momentum keeps pushing dye past
    // the pointer, which makes the light lead the hand instead of sitting on it.
    gl.uniform3f(uniforms.uDecay, Math.exp(-dt * 3.2), Math.exp(-dt * 3.2), Math.exp(-dt * 3.2));
    drawInto(current.sim.write());
    current.sim.swap();

    uniforms = use(divergenceProgram, simTexel);
    gl.uniform1i(uniforms.uVelocity, bindTexture(0, current.sim.read().texture));
    drawInto(current.divergence);

    uniforms = use(scaleProgram, simTexel);
    gl.uniform1i(uniforms.uSource, bindTexture(0, current.pressure.read().texture));
    gl.uniform1f(uniforms.uAmount, 0.8);
    drawInto(current.pressure.write());
    current.pressure.swap();

    gl.useProgram(pressureProgram.program);
    if (pressureProgram.uniform.uTexel) gl.uniform2f(pressureProgram.uniform.uTexel, simTexel[0], simTexel[1]);
    gl.uniform1i(pressureProgram.uniform.uDivergence, bindTexture(1, current.divergence.texture));
    for (let iteration = 0; iteration < PRESSURE_ITERATIONS; iteration += 1) {
      gl.uniform1i(pressureProgram.uniform.uPressure, bindTexture(0, current.pressure.read().texture));
      drawInto(current.pressure.write());
      current.pressure.swap();
    }

    uniforms = use(gradientProgram, simTexel);
    gl.uniform1i(uniforms.uPressure, bindTexture(0, current.pressure.read().texture));
    gl.uniform1i(uniforms.uVelocity, bindTexture(1, current.sim.read().texture));
    drawInto(current.sim.write());
    current.sim.swap();

    // Dye drifts with the projected field. Energy lingers, heat drains fast (that
    // is what turns the tail from warm gold into the darker secondary tone) and
    // the halo lingers longest so the glow outlives the filament.
    const spread = 4.6 / Math.max(settings.linger, 0.1);
    const dyeTexel: [number, number] = [1 / current.dye.read().width, 1 / current.dye.read().height];
    // Energy fades in roughly a quarter second, heat in a tenth: that split is
    // what keeps a white-hot tip on a cooling gold line instead of an even band.
    const decay: [number, number, number] = [
      Math.exp(-dt * spread / 1.25),
      Math.exp(-dt * spread / 0.45),
      Math.exp(-dt * spread / 1.55),
    ];
    uniforms = use(advectProgram, dyeTexel);
    gl.uniform2f(uniforms.uVelocityTexel, simTexel[0], simTexel[1]);
    gl.uniform3f(uniforms.uDecay, 1, 1, 1);
    gl.uniform1i(uniforms.uVelocity, bindTexture(0, current.sim.read().texture));
    gl.uniform1i(uniforms.uSource, bindTexture(1, current.dye.read().texture));
    gl.uniform1f(uniforms.uTimestep, dt);
    drawInto(current.forward);
    // Second half of the MacCormack pair: re-trace from the forward result.
    gl.uniform1i(uniforms.uSource, bindTexture(1, current.forward.texture));
    gl.uniform1f(uniforms.uTimestep, -dt);
    drawInto(current.back);

    uniforms = use(maccormackProgram, dyeTexel);
    gl.uniform2f(uniforms.uVelocityTexel, simTexel[0], simTexel[1]);
    gl.uniform2f(uniforms.uSourceTexel, dyeTexel[0], dyeTexel[1]);
    gl.uniform1i(uniforms.uVelocity, bindTexture(0, current.sim.read().texture));
    gl.uniform1i(uniforms.uSource, bindTexture(1, current.dye.read().texture));
    gl.uniform1i(uniforms.uForward, bindTexture(2, current.forward.texture));
    gl.uniform1i(uniforms.uBack, bindTexture(3, current.back.texture));
    gl.uniform1f(uniforms.uTimestep, dt);
    gl.uniform3f(uniforms.uDecay, decay[0], decay[1], decay[2]);
    drawInto(current.dye.write());
    current.dye.swap();

    // Bloom chain: prefilter straight from the dye, then box-down / tent-up.
    uniforms = use(prefilterProgram, [1 / current.bloom[0].width, 1 / current.bloom[0].height]);
    gl.uniform1i(uniforms.uDye, bindTexture(0, current.dye.read().texture));
    if (uniforms.uTexel) gl.uniform2f(uniforms.uTexel, 1 / current.dye.read().width, 1 / current.dye.read().height);
    gl.uniform3f(uniforms.uColor, dyeColor[0], dyeColor[1], dyeColor[2]);
    gl.uniform3f(uniforms.uSecondary, dyeSecondary[0], dyeSecondary[1], dyeSecondary[2]);
    gl.uniform1f(uniforms.uIntensity, Math.max(0, settings.intensity));
    gl.uniform1f(uniforms.uHotspot, Math.max(0, settings.hotspot));
    drawInto(current.bloom[0]);

    gl.useProgram(downProgram.program);
    for (let level = 1; level < current.bloom.length; level += 1) {
      const source = current.bloom[level - 1];
      if (downProgram.uniform.uTexel) {
        gl.uniform2f(downProgram.uniform.uTexel, 1 / source.width, 1 / source.height);
      }
      gl.uniform1i(downProgram.uniform.uSource, bindTexture(0, source.texture));
      drawInto(current.bloom[level]);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(upProgram.program);
    for (let level = current.bloom.length - 1; level > 0; level -= 1) {
      const source = current.bloom[level];
      if (upProgram.uniform.uTexel) {
        gl.uniform2f(upProgram.uniform.uTexel, 1 / source.width, 1 / source.height);
      }
      gl.uniform1i(upProgram.uniform.uSource, bindTexture(0, source.texture));
      drawInto(current.bloom[level - 1]);
    }
    gl.disable(gl.BLEND);
  };

  const display = (settings: Settings) => {
    if (!surface) return;
    gl.useProgram(displayProgram.program);
    if (displayProgram.uniform.uTexel) gl.uniform2f(displayProgram.uniform.uTexel, 1 / canvas.width, 1 / canvas.height);
    gl.uniform1i(displayProgram.uniform.uDye, bindTexture(0, surface.dye.read().texture));
    gl.uniform1i(displayProgram.uniform.uBloom, bindTexture(1, surface.bloom[0].texture));
    gl.uniform2f(displayProgram.uniform.uDyeTexel, 1 / surface.dye.read().width, 1 / surface.dye.read().height);
    gl.uniform2f(displayProgram.uniform.uBloomTexel, 1 / surface.bloom[0].width, 1 / surface.bloom[0].height);
    gl.uniform3f(displayProgram.uniform.uColor, dyeColor[0], dyeColor[1], dyeColor[2]);
    gl.uniform3f(displayProgram.uniform.uSecondary, dyeSecondary[0], dyeSecondary[1], dyeSecondary[2]);
    gl.uniform1f(displayProgram.uniform.uIntensity, Math.max(0, settings.intensity));
    gl.uniform1f(displayProgram.uniform.uHotspot, Math.max(0, settings.hotspot));
    gl.uniform1f(
      displayProgram.uniform.uGlow,
      settings.glow > 0 ? (settings.glow * 0.78) / BLOOM_LEVELS : 0,
    );
    drawInto(null);
  };

  const clearTargets = () => {
    if (!surface) return;
    for (const item of surfaceTargets(surface)) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, item.framebuffer);
      gl.viewport(0, 0, item.width, item.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  const tick = (now: number) => {
    frame = 0;
    if (!alive || !visible || document.hidden) return;
    const settings = readSettings();
    const dt = last ? Math.min(1 / 30, (now - last) / 1000) : 1 / 60;
    last = now;
    resize();
    if (!surface) return;
    resolveColors();
    gl.disable(gl.BLEND);
    gl.bindVertexArray(vao);

    if (pointer.ready) emit(settings, dt, now);
    while (bursts.length) {
      const next = bursts.shift();
      if (next) burst(settings, next[0], next[1], now);
    }
    step(settings, dt);
    display(settings);
    const quiet = now - activeAt > settings.linger * 1200 + 900;
    const resting = Math.hypot(emitter.vx, emitter.vy) < 1;
    if (quiet && resting) {
      clearTargets();
      last = 0;
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  const wake = () => {
    if (!frame && alive && visible && !document.hidden) frame = requestAnimationFrame(tick);
  };

  const onPointerMove = (event: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      pointer.inside = false;
      pointer.ready = false;
      return;
    }
    if (!pointer.ready) {
      pointer.ready = true;
      emitter.x = x;
      emitter.y = y;
      emitter.px = x;
      emitter.py = y;
      emitter.vx = 0;
      emitter.vy = 0;
    }
    pointer.inside = true;
    pointer.x = x;
    pointer.y = y;
    wake();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!readSettings().clickBurst) return;
    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    bursts.push([x, y]);
    wake();
  };

  const onPointerLeave = () => {
    pointer.inside = false;
    pointer.ready = false;
  };

  const onVisibility = () => {
    if (document.hidden) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    } else {
      wake();
    }
  };

  const resizeObserver = new ResizeObserver(() => {
    resize();
    wake();
  });
  resizeObserver.observe(container);

  const intersection = new IntersectionObserver((entries) => {
    visible = Boolean(entries[0]?.isIntersecting);
    if (visible) {
      wake();
    } else if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  });
  intersection.observe(container);

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave);
  document.addEventListener("visibilitychange", onVisibility);
  resize();

  return {
    dispose: () => {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      resizeObserver.disconnect();
      intersection.disconnect();
      disposeSurface();
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteShader(vertex);
      for (const program of [
        splatProgram, advectProgram, maccormackProgram, divergenceProgram, scaleProgram, pressureProgram,
        gradientProgram, prefilterProgram, downProgram, upProgram, displayProgram,
      ]) {
        gl.deleteProgram(program.program);
      }
    },
  };
}

export function SwordLightTrail({
  color = "#c49a63",
  secondaryColor = "#9a7448",
  intensity = 1.3,
  trailWidth = 3,
  linger = 1.4,
  glow = 1.2,
  hotspot = 0.8,
  followSpeed = 0.6,
  clickBurst = true,
  maxDevicePixelRatio = 2,
  enabled = true,
  className = "",
  style,
  ...rest
}: SwordLightTrailProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef<Settings>({
    color,
    secondaryColor,
    intensity,
    trailWidth,
    linger,
    glow,
    hotspot,
    followSpeed: clamp(followSpeed, 0, 1),
    clickBurst,
    maxDevicePixelRatio,
    enabled,
  });
  settingsRef.current = {
    color: String(color),
    secondaryColor: String(secondaryColor),
    intensity: Math.max(0, intensity),
    trailWidth: clamp(trailWidth, 0.5, 40),
    linger: clamp(linger, 0.1, 10),
    glow: Math.max(0, glow),
    hotspot: Math.max(0, hotspot),
    followSpeed: clamp(followSpeed, 0, 1),
    clickBurst,
    maxDevicePixelRatio,
    enabled,
  };

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return undefined;
    const sim = createSim(canvas, container, () => settingsRef.current);
    if (!sim) return undefined;
    return () => sim.dispose();
  }, []);

  return (
    <div ref={containerRef} className={className} style={{ position: "absolute", inset: 0, overflow: "hidden", ...style }} {...rest}>
      <canvas ref={canvasRef} className="sword-light-canvas" aria-hidden="true" style={{ mixBlendMode: "screen" } as CSSProperties} />
    </div>
  );
}
