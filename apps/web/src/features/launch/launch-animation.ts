import windmillReference from "./assets/windmill-reference.png";

export const LAUNCH_ANIMATION_DURATION = 10.966667;
export const LAUNCH_ANIMATION_FADE_DURATION = 420;

export interface LaunchAnimationOptions {
  readonly referenceImageUrl?: string;
  readonly onComplete?: () => void;
}

export interface LaunchAnimationController {
  readonly destroy: () => void;
  readonly setReferenceImageUrl: (url: string) => void;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface BladePoint extends Point {
  readonly angle: number;
}

interface Scene extends Point {
  readonly scale: number;
  readonly rotation: number;
}

interface AnimationPiece {
  readonly release: number;
  readonly originBlade?: number;
  readonly blade?: number;
  readonly originU?: number;
  readonly u?: number;
  readonly side?: number;
  readonly spreadX: number;
  readonly spreadY: number;
  readonly driftX: number;
  readonly driftY: number;
  readonly wobble?: number;
  readonly wobblePhase?: number;
}

interface AttachedPiece extends AnimationPiece {
  readonly blade: number;
  readonly u: number;
  readonly size: number;
  readonly color: string;
  readonly shape: number;
  readonly kind: "flower" | "piece";
  readonly rotation: number;
  readonly flowerVariant: number;
  readonly attach: number;
  readonly approachDistance: number;
  readonly approachAngleOffset: number;
  readonly approachArc: number;
  readonly approachSpin: number;
  readonly spin: number;
  readonly phase: number;
}

interface ReleasedPiece extends AnimationPiece {
  readonly size: number;
  readonly color: string;
  readonly shape: number;
  readonly rotation: number;
  readonly spin: number;
}

export function createLaunchAnimation(
  canvas: HTMLCanvasElement,
  options: LaunchAnimationOptions = {},
): LaunchAnimationController {
  const parent = canvas.parentElement;
  if (!parent) throw new Error("Launch animation canvas must have a parent stage.");
  const stage: HTMLElement = parent;
  const renderingContext = canvas.getContext("2d");
  if (!renderingContext) throw new Error("Canvas 2D context is unavailable.");
  const ctx: CanvasRenderingContext2D = renderingContext;

  const windmillImage = new Image();
  windmillImage.src = options.referenceImageUrl ?? windmillReference;
  let destroyed = false;
  let finished = false;
  const TAU = Math.PI * 2;
  const CANVAS_WIDTH = 576;
  const CANVAS_HEIGHT = 768;
  const BLADE_COUNT = 4;
  const BLADE_RADIUS = 110;
  const DURATION = LAUNCH_ANIMATION_DURATION;
  const SPIN_ANCHOR = 0.5;
  const DECELERATION_START = 10.25;
  const ANGULAR_SPEED = -2.02;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const palette = ["#16b993", "#f4c923", "#ed7d22", "#208fd0", "#df3a78", "#7749bd"];
  const lineColor = "rgba(104, 107, 178, 0.75)";

  let width = 0;
  let height = 0;
  let dpr = 1;
  let fit = 1;
  let offsetX = 0;
  let offsetY = 0;
  let startTime = performance.now();
  let animationFrame = 0;

  const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));
  const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;
  const smoothstep = (value: number): number => {
    const t = clamp(value);
    return t * t * (3 - 2 * t);
  };
  const easeOut = (value: number): number => 1 - Math.pow(1 - clamp(value), 3);
  const easeInOut = (value: number): number => {
    const t = clamp(value);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  const hermite = (p0: number, p1: number, m0: number, m1: number, amount: number): number => {
    const t = clamp(amount);
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
  };
  const seed = (value: number): number => {
    const x = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  const motionKeyframes = [
    { time: 0, x: 690, y: 510 },
    { time: 0.2, x: 520, y: 446 },
    { time: 0.25, x: 478, y: 416 },
    { time: 0.3, x: 444, y: 419 },
    { time: 0.5, x: 353, y: 378 },
    { time: 0.75, x: 292, y: 370 },
    { time: 1.0, x: 307, y: 350 },
    { time: 1.2, x: 330, y: 325 },
    { time: 1.5, x: 294, y: 278 },
    { time: 2.0, x: 237, y: 315 },
    { time: 3.0, x: 255, y: 278 },
    { time: 5.0, x: 287, y: 338 },
    { time: 8.0, x: 287, y: 278 },
    { time: 10.8, x: 288, y: 369 },
    { time: DURATION, x: 288, y: 369 },
  ];

  function motionAt(time: number) {
    if (time <= motionKeyframes[0].time) return motionKeyframes[0];
    for (let index = 1; index < motionKeyframes.length; index += 1) {
      const from = motionKeyframes[index - 1];
      const to = motionKeyframes[index];
      if (time <= to.time) {
        const previous = motionKeyframes[Math.max(0, index - 2)];
        const following = motionKeyframes[Math.min(motionKeyframes.length - 1, index + 1)];
        const span = to.time - from.time;
        const fromTangent = index === 1
          ? { x: (to.x - from.x) / span, y: (to.y - from.y) / span }
          : {
            x: (to.x - previous.x) / (to.time - previous.time),
            y: (to.y - previous.y) / (to.time - previous.time),
          };
        const toTangent = index === motionKeyframes.length - 1
          ? { x: (to.x - from.x) / span, y: (to.y - from.y) / span }
          : {
            x: (following.x - from.x) / (following.time - from.time),
            y: (following.y - from.y) / (following.time - from.time),
          };
        const progress = (time - from.time) / span;
        return {
          x: hermite(from.x, to.x, fromTangent.x * span, toTangent.x * span, progress),
          y: hermite(from.y, to.y, fromTangent.y * span, toTangent.y * span, progress),
        };
      }
    }
    return motionKeyframes[motionKeyframes.length - 1];
  }

  function resize(): void {
    const rect = stage.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fit = Math.min(width / CANVAS_WIDTH, height / CANVAS_HEIGHT);
    offsetX = (width - CANVAS_WIDTH * fit) / 2;
    offsetY = (height - CANVAS_HEIGHT * fit) / 2;
  }

  function sceneAt(time: number): Scene {
    const motion = motionAt(time);
    const x = motion.x;
    const y = motion.y;
    const scale = lerp(0.72, 1, easeOut(time / 0.92));
    return { x, y, scale, rotation: rotationAt(time) };
  }

  function rotationAt(time: number): number {
    const activeSpan = DECELERATION_START - SPIN_ANCHOR;
    const decelerationSpan = DURATION - DECELERATION_START;
    return time <= DECELERATION_START
      ? ANGULAR_SPEED * (time - SPIN_ANCHOR)
      : ANGULAR_SPEED * activeSpan
        + ANGULAR_SPEED * (
          (time - DECELERATION_START)
          - Math.pow(time - DECELERATION_START, 2) / (2 * decelerationSpan)
        );
  }

  const canonicalReferenceBlade = {
    outer: [
      { x: 150, y: 150 }, { x: 116, y: 127 }, { x: 107, y: 82 }, { x: 175, y: 29 },
    ],
    inner: [
      { x: 150, y: 150 }, { x: 158, y: 137 }, { x: 168, y: 105 }, { x: 175, y: 29 },
    ],
  };

  function referenceBoundaryPoint(boundary: "outer" | "inner", progress: number): Point {
    const t = clamp(progress);
    const path = boundary === "outer"
      ? canonicalReferenceBlade.outer
      : canonicalReferenceBlade.inner;
    return cubicPoint(
      path[0],
      path[1],
      path[2],
      path[3],
      t,
    );
  }

  function referenceBladePoint(bladeIndex: number, progress: number, side: number): BladePoint {
    const outer = referenceBoundaryPoint("outer", progress);
    const inner = referenceBoundaryPoint("inner", progress);
    const lane = clamp(0.5 + side * 0.46, 0.06, 0.94);
    const bladeRotation = bladeIndex * TAU / BLADE_COUNT;
    const rotate = (sourcePoint: Point): Point => {
      const dx = sourcePoint.x - 150;
      const dy = sourcePoint.y - 150;
      const cos = Math.cos(bladeRotation);
      const sin = Math.sin(bladeRotation);
      return {
        x: 150 + cos * dx - sin * dy,
        y: 150 + sin * dx + cos * dy,
      };
    };
    const point = {
      ...rotate({
        x: lerp(outer.x, inner.x, lane),
        y: lerp(outer.y, inner.y, lane),
      }),
    };
    const nextProgress = clamp(progress + 0.012);
    const nextOuter = referenceBoundaryPoint("outer", nextProgress);
    const nextInner = referenceBoundaryPoint("inner", nextProgress);
    const nextPoint = rotate({
      x: lerp(nextOuter.x, nextInner.x, lane),
      y: lerp(nextOuter.y, nextInner.y, lane),
    });
    return {
      x: point.x,
      y: point.y,
      angle: Math.atan2(nextPoint.y - point.y, nextPoint.x - point.x),
    };
  }

  function pointOnBlade(time: number, bladeIndex: number, progress: number, side = 0): BladePoint {
    const scene = sceneAt(time);
    const reference = referenceBladePoint(bladeIndex, clamp(progress), side);
    const imageRotation = scene.rotation - rotationAt(DURATION);
    const cos = Math.cos(imageRotation);
    const sin = Math.sin(imageRotation);
    const localX = (reference.x - 150) * scene.scale;
    const localY = (reference.y - 150) * scene.scale;
    return {
      x: scene.x + cos * localX - sin * localY,
      y: scene.y + sin * localX + cos * localY,
      angle: imageRotation + reference.angle,
    };
  }

  function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, progress: number): Point {
    const t = clamp(progress);
    const inverse = 1 - t;
    return {
      x: inverse * inverse * inverse * p0.x
        + 3 * inverse * inverse * t * p1.x
        + 3 * inverse * t * t * p2.x
        + t * t * t * p3.x,
      y: inverse * inverse * inverse * p0.y
        + 3 * inverse * inverse * t * p1.y
        + 3 * inverse * t * t * p2.y
        + t * t * t * p3.y,
    };
  }

  function drawStem(time: number, scene: Scene): void {
    const bottomX = scene.x - lerp(104, 50, easeOut(time / 2.2));
    const bottomY = CANVAS_HEIGHT + 32;
    const start = { x: scene.x, y: scene.y };
    const c1 = { x: scene.x - 7, y: scene.y + 104 };
    const c2 = { x: bottomX + 15, y: bottomY - 142 };

    ctx.save();
    ctx.strokeStyle = "rgba(91, 106, 179, 0.78)";
    ctx.lineWidth = 0.78;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, bottomX, bottomY);
    ctx.stroke();
    ctx.restore();

    const stemBuds = [
      { at: 0.23, size: 4.4, color: palette[2], rotation: 0.3 },
      { at: 0.42, size: 6.2, color: palette[4], rotation: -0.18 },
      { at: 0.58, size: 3.7, color: palette[1], rotation: 0.85 },
      { at: 0.73, size: 5.1, color: palette[5], rotation: -0.42 },
    ];
    const budsFade = 1 - easeInOut((time - 5.3) / 2.3);
    stemBuds.forEach((bud, index) => {
      const t = bud.at;
      const x = lerp(start.x, bottomX, t) + Math.sin(t * 9) * 4;
      const y = lerp(start.y, bottomY, t);
      const release = 1.8 + index * 0.75;
      const alpha = Math.max(0.08, budsFade * (time < release ? 0.94 : 0.3));
      drawFlower(x, y, bud.size, bud.color, bud.rotation + time * 0.08, alpha, index + 0.4);
    });
  }

  function bladePath(radius: number): void {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(
      -radius * 0.34, -radius * 0.12,
      -radius * 0.72, -radius * 0.54,
      -radius * 0.5, -radius * 0.84,
    );
    ctx.bezierCurveTo(
      -radius * 0.36, -radius * 1.06,
      -radius * 0.03, -radius * 1.14,
      radius * 0.22, -radius * 1.2,
    );
    ctx.lineTo(radius * 0.2, -radius * 0.68);
    ctx.bezierCurveTo(
      radius * 0.14, -radius * 0.52,
      radius * 0.05, -radius * 0.2,
      0, 0,
    );
    ctx.closePath();
  }

  function bladeFacetPath(radius: number): void {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(
      -radius * 0.03, -radius * 0.12,
      -radius * 0.17, -radius * 0.32,
      -radius * 0.3, -radius * 0.48,
    );
    ctx.bezierCurveTo(
      -radius * 0.11, -radius * 0.42,
      radius * 0.04, -radius * 0.5,
      radius * 0.2, -radius * 0.68,
    );
    ctx.lineTo(radius * 0.2, -radius * 0.2);
    ctx.bezierCurveTo(
      radius * 0.13, -radius * 0.12,
      radius * 0.05, -radius * 0.04,
      0, 0,
    );
    ctx.closePath();
  }

  function bladeFoldPath(radius: number): void {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(
      radius * 0.02, -radius * 0.14,
      radius * 0.08, -radius * 0.34,
      radius * 0.2, -radius * 0.68,
    );
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(
      -radius * 0.03, -radius * 0.12,
      -radius * 0.12, -radius * 0.28,
      -radius * 0.3, -radius * 0.48,
    );
  }

  function drawWindmillVector(time: number, scene: Scene): void {
    const reveal = smoothstep(time / 0.28);
    ctx.save();
    ctx.translate(scene.x, scene.y);
    ctx.rotate(scene.rotation - rotationAt(DURATION));
    ctx.globalAlpha = reveal;
    ctx.fillStyle = "rgba(229, 230, 237, 0.48)";
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 0.9;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const radius = BLADE_RADIUS * scene.scale;

    for (let index = 0; index < BLADE_COUNT; index += 1) {
      ctx.save();
      ctx.rotate(index * TAU / BLADE_COUNT);
      bladePath(radius);
      ctx.fill();
      ctx.restore();
    }

    for (let index = 0; index < BLADE_COUNT; index += 1) {
      ctx.save();
      ctx.rotate(index * TAU / BLADE_COUNT);
      ctx.fillStyle = "rgba(164, 166, 190, 0.36)";
      bladeFacetPath(radius);
      ctx.fill();
      ctx.restore();
    }

    for (let index = 0; index < BLADE_COUNT; index += 1) {
      ctx.save();
      ctx.rotate(index * TAU / BLADE_COUNT);
      ctx.fillStyle = "rgba(229, 230, 237, 0.48)";
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 0.9;
      bladePath(radius);
      ctx.stroke();
      ctx.strokeStyle = "rgba(83, 88, 161, 0.68)";
      ctx.lineWidth = 0.82;
      bladeFoldPath(radius);
      ctx.stroke();
      ctx.restore();
    }

    ctx.globalAlpha = reveal;
    ctx.fillStyle = "rgba(48, 79, 174, 0.96)";
    ctx.beginPath();
    ctx.ellipse(0, 0, 2.75 * scene.scale, 2.35 * scene.scale, -0.22, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(12, 116, 214, 0.78)";
    ctx.beginPath();
    ctx.ellipse(-0.58 * scene.scale, -0.62 * scene.scale, 0.72 * scene.scale, 0.52 * scene.scale, -0.22, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawWindmillReference(time: number, scene: Scene): void {
    const reveal = smoothstep(time / 0.28);
    const size = 300 * scene.scale;
    ctx.save();
    ctx.translate(scene.x, scene.y);
    ctx.rotate(scene.rotation - rotationAt(DURATION));
    ctx.globalAlpha = reveal;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(windmillImage, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  function drawWindmill(time: number, scene: Scene): void {
    if (windmillImage.complete && windmillImage.naturalWidth) {
      drawWindmillReference(time, scene);
    } else {
      drawWindmillVector(time, scene);
    }
  }

  function drawFlower(x: number, y: number, size: number, color: string, rotation: number, alpha = 1, variant = 0): void {
    if (alpha <= 0) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    for (let index = 0; index < 5; index += 1) {
      const petalSeed = seed(variant * 911 + index * 17.3 + 0.7);
      const angle = index * TAU / 5 + (petalSeed - 0.5) * 0.18;
      const length = size * (0.82 + petalSeed * 0.2);
      const width = size * (0.28 + petalSeed * 0.16);
      ctx.save();
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.08);
      ctx.bezierCurveTo(
        width * 0.34, -length * 0.5,
        width, -length * 0.9,
        width * 0.1, -length,
      );
      ctx.bezierCurveTo(
        -width * 0.56, -length * 0.82,
        -width * 0.72, -length * 0.3,
        0, size * 0.08,
      );
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    if (size > 6) {
      ctx.globalAlpha = alpha * 0.42;
      ctx.strokeStyle = "rgba(255, 250, 214, 0.86)";
      ctx.lineWidth = Math.max(0.35, size * 0.045);
      ctx.beginPath();
      for (let index = 0; index < 5; index += 1) {
        const angle = -Math.PI / 2 + index * TAU / 5;
        ctx.moveTo(Math.cos(angle) * size * 0.04, Math.sin(angle) * size * 0.04);
        ctx.lineTo(Math.cos(angle) * size * 0.58, Math.sin(angle) * size * 0.58);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgba(255, 246, 182, 0.95)";
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(0.55, size * 0.11), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawPetalPiece(x: number, y: number, size: number, color: string, rotation: number, shape: number, alpha: number, flip = 0): void {
    if (alpha <= 0 || size < 0.35) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(Math.max(0.18, Math.abs(Math.cos(flip))), 1);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();

    if (shape === 0) {
      ctx.moveTo(0, -size);
      ctx.bezierCurveTo(size * 0.74, -size * 0.7, size * 0.82, size * 0.22, size * 0.05, size * 0.78);
      ctx.bezierCurveTo(-size * 0.68, size * 0.45, -size * 0.5, -size * 0.54, 0, -size);
    } else if (shape === 1) {
      ctx.moveTo(-size * 0.1, -size);
      ctx.bezierCurveTo(size * 0.9, -size * 0.8, size * 0.72, -size * 0.08, -size * 0.2, size * 0.76);
      ctx.bezierCurveTo(-size * 0.56, size * 0.25, -size * 0.52, -size * 0.55, -size * 0.1, -size);
    } else if (shape === 2) {
      ctx.moveTo(0, -size);
      ctx.bezierCurveTo(size * 0.98, -size * 0.58, size * 0.7, size * 0.38, -size * 0.02, size * 0.76);
      ctx.bezierCurveTo(size * 0.02, size * 0.08, -size * 0.04, -size * 0.42, 0, -size);
    } else if (shape === 3) {
      ctx.moveTo(-size * 0.05, -size);
      ctx.bezierCurveTo(size * 0.25, -size * 0.35, size * 0.9, -size * 0.16, size * 0.78, size * 0.12);
      ctx.bezierCurveTo(size * 0.6, size * 0.58, -size * 0.12, size * 0.82, -size * 0.05, -size);
    } else {
      ctx.moveTo(0, -size * 0.95);
      ctx.bezierCurveTo(size * 0.75, -size * 0.5, size * 0.5, size * 0.48, 0, size * 0.82);
      ctx.bezierCurveTo(-size * 0.44, size * 0.24, -size * 0.45, -size * 0.5, 0, -size * 0.95);
    }
    ctx.closePath();
    ctx.fill();

    if (size > 8) {
      ctx.globalAlpha = alpha * 0.22;
      ctx.strokeStyle = "#fff8db";
      ctx.lineWidth = Math.max(0.35, size * 0.035);
      ctx.beginPath();
      ctx.moveTo(-size * 0.08, -size * 0.68);
      ctx.quadraticCurveTo(size * 0.18, -size * 0.02, size * 0.03, size * 0.52);
      ctx.stroke();
    }
    ctx.restore();
  }

  const attachedPieces: AttachedPiece[] = [];
  for (let blade = 0; blade < BLADE_COUNT; blade += 1) {
    for (let index = 0; index < 28; index += 1) {
      const n = blade * 28 + index + 1;
      const u = 0.16 + seed(n * 1.7) * 0.78;
      const sizeClass = seed(n * 2.1 + 31);
      const earlyPiece = index < 2 && blade >= 2;
      const size = earlyPiece
        ? 2.5 + seed(n + 61) * 4.8
        : sizeClass < 0.35
          ? 3.0 + seed(n + 61) * 3.8
          : sizeClass < 0.72
            ? 7.0 + seed(n + 83) * 6.0
            : 13.0 + seed(n + 97) * 9.0;
      attachedPieces.push({
        blade,
        u,
        side: seed(n + 111) < 0.72
          ? (seed(n + 111) < 0.36 ? -1 : 1) * (0.84 + seed(n + 112) * 0.2)
          : (seed(n + 113) - 0.5) * 1.2,
        size,
        color: palette[Math.floor(seed(n + 127) * palette.length)],
        shape: Math.floor(seed(n + 139) * 5),
        kind: seed(n + 151) < 0.38 ? "flower" : "piece",
        rotation: seed(n + 163) * TAU,
        flowerVariant: seed(n + 173),
        attach: earlyPiece
          ? 0.58 + seed(n + 241) * 0.16
          : 0.78 + u * 0.72 + seed(n + 241) * 0.16,
        approachDistance: 56 + seed(n + 251) * 82,
        approachAngleOffset: (seed(n + 263) - 0.5) * 1.35,
        approachArc: (seed(n + 271) - 0.5) * 68,
        approachSpin: (seed(n + 293) - 0.5) * 2.4,
        release: 2.2 + u * 2.0 + seed(n + 179) * 0.8,
        spreadX: (seed(n + 181) - 0.5) * 28,
        spreadY: (seed(n + 183) - 0.5) * 34,
        driftX: 22 + seed(n + 191) * 76,
        driftY: -58 + seed(n + 203) * 112,
        spin: (seed(n + 217) - 0.5) * 3.8,
        phase: seed(n + 229) * TAU,
      });
    }

    [0.36, 0.56, 0.76, 0.93].forEach((u, clusterIndex) => {
      const n = 700 + blade * 12 + clusterIndex;
      attachedPieces.push({
        blade,
        u: u + (seed(n + 3) - 0.5) * 0.06,
        side: seed(n + 7) < 0.72
          ? (seed(n + 7) < 0.36 ? -1 : 1) * (0.84 + seed(n + 8) * 0.2)
          : (seed(n + 9) - 0.5) * 1.2,
        size: blade === 1 && clusterIndex === 3
          ? 18.0 + seed(n + 13) * 4.0
          : 10.0 + seed(n + 13) * 9.0,
        color: palette[(blade * 2 + clusterIndex + 1) % palette.length],
        shape: clusterIndex % 3,
        kind: "flower",
        rotation: seed(n + 17) * TAU,
        flowerVariant: seed(n + 19),
        attach: 0.78 + clusterIndex * 0.22 + seed(n + 47) * 0.14,
        approachDistance: 48 + seed(n + 53) * 72,
        approachAngleOffset: (seed(n + 59) - 0.5) * 1.2,
        approachArc: (seed(n + 61) - 0.5) * 54,
        approachSpin: (seed(n + 71) - 0.5) * 2.2,
        release: 2.25 + clusterIndex * 0.5 + seed(n + 23) * 1.0,
        spreadX: (seed(n + 25) - 0.5) * 24,
        spreadY: (seed(n + 27) - 0.5) * 30,
        driftX: 30 + seed(n + 29) * 64,
        driftY: -48 + seed(n + 31) * 108,
        spin: (seed(n + 37) - 0.5) * 3.6,
        phase: seed(n + 41) * TAU,
      });
    });
  }

  const loosePieces: ReleasedPiece[] = Array.from({ length: 1080 }, (_, index) => {
    const n = index + 401;
    const sizeClass = seed(n + 17);
    const earlyPiece = index < 140;
    const middlePiece = index >= 140 && index < 560;
    return {
      release: earlyPiece
        ? 2.5 + seed(n + 23) * 2.2
        : middlePiece
          ? 4.0 + seed(n + 23) * 2.2
          : 5.2 + seed(n + 23) * 3.6,
      originBlade: Math.floor(seed(n + 37) * BLADE_COUNT),
      originU: 0.15 + seed(n + 41) * 0.96,
      spreadX: (seed(n + 47) - 0.27) * 360,
      spreadY: (seed(n + 53) - 0.5) * 380,
      driftX: -8 + seed(n + 59) * 52,
      driftY: -34 + seed(n + 67) * 74,
      wobble: 4 + seed(n + 71) * 22,
      wobblePhase: seed(n + 79) * TAU,
      size: sizeClass < 0.62
        ? 1.0 + seed(n + 83) * 4.0
        : sizeClass < 0.86
          ? 4.2 + seed(n + 89) * 6.8
          : 8.0 + seed(n + 91) * 10.5,
      color: palette[Math.floor(seed(n + 97) * palette.length)],
      shape: Math.floor(seed(n + 103) * 5),
      rotation: seed(n + 109) * TAU,
      spin: (seed(n + 113) - 0.5) * 5,
    };
  });

  const heroPieces: ReleasedPiece[] = Array.from({ length: 48 }, (_, index) => {
    const n = index + 901;
    return {
      release: 2.2 + seed(n + 7) * 3.2,
      originBlade: Math.floor(seed(n + 13) * BLADE_COUNT),
      originU: 0.35 + seed(n + 19) * 0.6,
      spreadX: (seed(n + 23) - 0.25) * 330,
      spreadY: (seed(n + 29) - 0.5) * 210,
      driftX: 12 + seed(n + 31) * 55,
      driftY: -35 + seed(n + 37) * 72,
      size: 8 + seed(n + 41) * 16,
      color: palette[Math.floor(seed(n + 47) * palette.length)],
      shape: Math.floor(seed(n + 53) * 4),
      rotation: seed(n + 59) * TAU,
      spin: (seed(n + 67) - 0.5) * 2.7,
    };
  });

  function releasedPosition(piece: AnimationPiece, time: number, hero = false): BladePoint {
    const dt = Math.max(0, time - piece.release);
    const origin = pointOnBlade(
      piece.release,
      piece.originBlade ?? piece.blade ?? 0,
      piece.originU ?? piece.u ?? 0.5,
      piece.side ?? 0,
    );
    const x = origin.x
      + (piece.spreadX || 0)
      + piece.driftX * Math.pow(dt, 1.05)
      + Math.sin(dt * 0.62 + (piece.wobblePhase || 0)) * (piece.wobble || 0);
    const y = origin.y
      + (piece.spreadY || 0)
      + piece.driftY * dt
      + Math.sin(dt * (0.8 + (hero ? 0.1 : 0.28)) + (piece.wobblePhase || 0)) * (piece.wobble || 0) * 0.55;
    return { x, y, angle: 0 };
  }

  function drawAttachedPieces(time: number): void {
    const entryAlpha = smoothstep(time / 0.5);
    attachedPieces.forEach((piece, index) => {
      const travelDuration = 0.34;
      const travelStart = Math.max(0.02, piece.attach - travelDuration);
      if (time < travelStart) return;

      if (time < piece.attach) {
        const landingTarget = pointOnBlade(piece.attach, piece.blade, piece.u, piece.side);
        const startTarget = pointOnBlade(travelStart, piece.blade, piece.u, piece.side);
        const target = pointOnBlade(time, piece.blade, piece.u, piece.side);
        const progress = easeInOut((time - travelStart) / travelDuration);
        const approachAngle = landingTarget.angle + piece.approachAngleOffset;
        const startX = startTarget.x + Math.cos(approachAngle) * piece.approachDistance;
        const startY = startTarget.y + Math.sin(approachAngle) * piece.approachDistance;
        const midX = (startX + target.x) * 0.5
          - Math.sin(approachAngle) * piece.approachArc;
        const midY = (startY + target.y) * 0.5
          + Math.cos(approachAngle) * piece.approachArc;
        const inverse = 1 - progress;
        const point = {
          x: inverse * inverse * startX + 2 * inverse * progress * midX + progress * progress * target.x,
          y: inverse * inverse * startY + 2 * inverse * progress * midY + progress * progress * target.y,
          angle: target.angle,
        };
        const alpha = entryAlpha * smoothstep(progress);
        const rotation = piece.rotation + target.angle + lerp(piece.approachSpin, 0, progress);
        const flip = time * 8 + piece.phase;
        if (piece.kind === "flower") {
          drawFlower(point.x, point.y, piece.size, piece.color, rotation, alpha, piece.flowerVariant);
        } else {
          drawPetalPiece(point.x, point.y, piece.size, piece.color, rotation, piece.shape, alpha, flip);
        }
        return;
      }

      const released = time >= piece.release;
      const attached = !released;
      const fade = attached ? 1 : Math.max(0, 1 - (time - piece.release) / 2.1);
      const point = attached
        ? pointOnBlade(time, piece.blade, piece.u, piece.side)
        : releasedPosition(piece, time);
      const movement = attached ? 0 : time - piece.release;
      const alpha = entryAlpha * (attached ? 0.92 : fade);
      const rotation = attached
        ? piece.rotation + point.angle + Math.sin(time * 0.6 + index) * 0.18
        : piece.rotation + movement * piece.spin;
      const flip = attached ? Math.sin(time * 1.5 + index) : movement * 7.2 + piece.phase;
      if (piece.kind === "flower" && attached) {
        drawFlower(point.x, point.y, piece.size, piece.color, rotation, alpha, piece.flowerVariant);
      } else {
        drawPetalPiece(point.x, point.y, piece.size, piece.color, rotation, piece.shape, alpha, flip);
      }
      if (attached && piece.size > 8 && seed(index + 981) > 0.45) {
        drawPetalPiece(
          point.x + Math.cos(point.angle + 0.8) * piece.size * 0.7,
          point.y + Math.sin(point.angle + 0.8) * piece.size * 0.7,
          piece.size * 0.35,
          palette[(index + 2) % palette.length],
          rotation + 0.7,
          1,
          alpha * 0.82,
          flip + 0.5,
        );
      }
    });
  }

  function drawReleasedPieces(time: number): void {
    loosePieces.forEach((piece) => {
      if (time <= piece.release) return;
      const dt = time - piece.release;
      const point = releasedPosition(piece, time);
      const alpha = Math.min(0.86, 0.38 + dt * 0.23) * (dt < 12 ? 1 : Math.max(0, 1 - (dt - 12) / 2));
      drawPetalPiece(
        point.x,
        point.y,
        piece.size,
        piece.color,
        piece.rotation + dt * piece.spin,
        piece.shape,
        alpha,
        dt * 5.2 + piece.rotation,
      );
    });

    heroPieces.forEach((piece) => {
      if (time <= piece.release) return;
      const dt = time - piece.release;
      const point = releasedPosition(piece, time, true);
      const endFade = 1 - 0.42 * easeInOut((time - 9.4) / 1.6);
      const alpha = Math.min(0.9, 0.74 + dt * 0.12)
        * (dt < 10.8 ? 1 : Math.max(0, 1 - (dt - 10.8) / 1.2))
        * Math.max(0.48, endFade);
      drawPetalPiece(
        point.x,
        point.y,
        piece.size,
        piece.color,
        piece.rotation + dt * piece.spin,
        piece.shape,
        alpha,
        dt * 2.7 + piece.rotation,
      );
    });
  }

  function drawScene(time: number): void {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(fit, fit);

    const scene = sceneAt(time);
    drawStem(time, scene);
    drawWindmill(time, scene);
    drawAttachedPieces(time);
    drawReleasedPieces(time);

    ctx.restore();
  }

  function currentTime(now: number): number {
    if (reducedMotion.matches) return DURATION;
    return Math.min(DURATION, (now - startTime) / 1000);
  }

  function render(now: number): void {
    if (destroyed) return;
    const time = currentTime(now);
    drawScene(time);
    if (!reducedMotion.matches && time < DURATION) {
      animationFrame = requestAnimationFrame(render);
    } else if (!finished) {
      finished = true;
      options.onComplete?.();
    }
  }

  const onResize = (): void => {
    resize();
    drawScene(currentTime(performance.now()));
  };
  const onImageLoad = (): void => {
    if (!destroyed) drawScene(currentTime(performance.now()));
  };
  const onImageError = (): void => {
    if (!destroyed) drawScene(currentTime(performance.now()));
  };

  resize();
  window.addEventListener("resize", onResize, { passive: true });
  windmillImage.addEventListener("load", onImageLoad);
  windmillImage.addEventListener("error", onImageError);
  startTime = performance.now();
  drawScene(reducedMotion.matches ? DURATION : 0);
  animationFrame = requestAnimationFrame(render);

  return {
    setReferenceImageUrl(url: string): void {
      if (destroyed || url.length === 0) return;
      windmillImage.src = url;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", onResize);
      windmillImage.removeEventListener("load", onImageLoad);
      windmillImage.removeEventListener("error", onImageError);
    },
  };
}
