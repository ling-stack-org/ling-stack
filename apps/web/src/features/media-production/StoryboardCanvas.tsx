import { useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Clapperboard, ImageIcon, Play, Plus, Sparkles } from "lucide-react";
import { Button, EmptyState, IconButton } from "../../shared/ui/index.js";
import { useI18n, type Translate } from "../../i18n.js";
import type { MediaScene } from "../../types.js";
import type { StoryboardFocusRequest } from "./media-production-types.js";
import type { SceneReadiness } from "./media-production-view-models.js";
import {
  projectStoryboardScenes,
  storyboardFocusSceneIds,
  type StoryboardSceneProjection,
} from "./media-production-canvas-view-models.js";
import {
  shouldShowStoryboardMiniMap,
  storyboardBoundsFitSafeArea,
  storyboardCanvasSafeArea,
  storyboardFitViewPadding,
  storyboardFocusViewport,
  storyboardLayoutBounds,
  storyboardMotionDuration,
  storyboardNodeHeight,
  storyboardNodeWidth,
  type StoryboardFitViewPadding,
} from "./media-production-layout.js";

interface StoryboardCanvasProps {
  readonly scenes: readonly MediaScene[];
  readonly readiness: readonly SceneReadiness[];
  readonly selectedSceneId: string;
  readonly focusRequest: StoryboardFocusRequest;
  readonly leftDockOpen: boolean;
  readonly rightDockOpen: boolean;
  readonly isBusy: boolean;
  readonly onSelectScene: (sceneId: string) => void;
  readonly onPreviewResult: (sceneId: string) => void;
  readonly onMoveScene: (sceneId: string, position: { readonly x: number; readonly y: number }) => void;
  readonly onCreateScene: () => void;
}

interface StoryboardNodeData extends Record<string, unknown> {
  readonly scene: MediaScene;
  readonly order: number;
  readonly isSelected: boolean;
  readonly readiness?: SceneReadiness;
  readonly promptLabel: string;
  readonly durationLabel: string;
  readonly statusLabel: string;
  readonly previewLabel: string;
  readonly onSelect: (sceneId: string) => void;
  readonly onPreview: (sceneId: string) => void;
}

function StoryboardSceneNode({ data }: NodeProps<Node<StoryboardNodeData>>): JSX.Element {
  const { scene } = data;
  const fixedSize = { width: storyboardNodeWidth, height: storyboardNodeHeight };
  return (
    <div
      className={`storyboard-scene-node-frame${data.readiness?.currentArtifact ? " has-preview" : ""}`}
      style={fixedSize}
    >
      <Handle type="target" position={Position.Left} className="storyboard-node-handle" />
      <button
        type="button"
        className={`storyboard-scene-node${data.isSelected ? " selected" : ""}`}
        aria-label={scene.title}
        aria-pressed={data.isSelected}
        title={scene.title}
        style={{ ...fixedSize, minHeight: storyboardNodeHeight, maxHeight: storyboardNodeHeight }}
        onClick={(event) => {
          event.stopPropagation();
          data.onSelect(scene.id);
        }}
      >
        <span className="storyboard-scene-node-order">{String(data.order).padStart(2, "0")}</span>
        <span className="storyboard-scene-node-body">
          <strong>{scene.title}</strong>
          <small>{data.promptLabel}</small>
          <span className="storyboard-scene-node-meta">
            <span>{scene.ratio}</span>
            <span>{data.durationLabel}</span>
            {scene.referenceArtifactIds.length > 0 ? <ImageIcon aria-hidden="true" /> : null}
            <span className={`storyboard-node-status ${data.readiness?.state ?? "needs_model"}`}>{data.statusLabel}</span>
          </span>
          {data.readiness?.workflow || data.readiness?.provider ? (
            <span className="storyboard-scene-node-source">
              {data.readiness.workflow?.definition.name ?? data.readiness.provider?.displayName}
            </span>
          ) : null}
        </span>
      </button>
      {data.readiness?.currentArtifact ? (
        <IconButton
          className="storyboard-scene-preview nodrag nopan"
          icon={Play}
          label={data.previewLabel}
          size="sm"
          tooltip={data.previewLabel}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            data.onPreview(scene.id);
          }}
        />
      ) : null}
      <Handle type="source" position={Position.Right} className="storyboard-node-handle" />
    </div>
  );
}

const nodeTypes = { scene: StoryboardSceneNode };

export function StoryboardCanvas({
  scenes,
  readiness,
  selectedSceneId,
  focusRequest,
  leftDockOpen,
  rightDockOpen,
  isBusy,
  onSelectScene,
  onPreviewResult,
  onMoveScene,
  onCreateScene,
}: StoryboardCanvasProps): JSX.Element {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const motionDuration = storyboardMotionDuration(reducedMotion, 220);
  const projections = useMemo(
    () => projectStoryboardScenes(scenes, readiness),
    [readiness, scenes],
  );
  const orderedScenes = useMemo(() => projections.map((item) => item.scene), [projections]);
  const initialNodes = useMemo(
    () => sceneNodes(projections, selectedSceneId, onSelectScene, onPreviewResult, t),
    [onPreviewResult, onSelectScene, projections, selectedSceneId, t],
  );
  const [nodes, setNodes] = useState<Node<StoryboardNodeData>[]>(initialNodes);
  const flowInstance = useRef<ReactFlowInstance<Node<StoryboardNodeData>, Edge> | null>(null);
  const canvasElement = useRef<HTMLDivElement>(null);
  const lastFocusSequence = useRef(focusRequest.sequence);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const miniMapVisible = shouldShowStoryboardMiniMap({
    scenes: orderedScenes,
    canvasWidth: canvasSize.width,
    canvasHeight: canvasSize.height,
    leftDockOpen,
    rightDockOpen,
  });
  const fitViewPadding = useMemo(
    () => storyboardFitViewPadding({ leftDockOpen, rightDockOpen, miniMapVisible }),
    [leftDockOpen, miniMapVisible, rightDockOpen],
  );

  useEffect(() => {
    setNodes((current) => reconcileSceneNodes(current, initialNodes));
  }, [initialNodes]);

  useEffect(() => {
    const canvas = canvasElement.current;
    if (!canvas) return;
    const updateSize = (): void => setCanvasSize({ width: canvas.clientWidth, height: canvas.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [orderedScenes.length === 0]);

  useEffect(() => {
    const focusChanged = focusRequest.sequence !== lastFocusSequence.current;
    const visibleSceneIds = storyboardFocusSceneIds(projections, focusRequest.sceneId);
    lastFocusSequence.current = focusRequest.sequence;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      if (focusChanged && focusRequest.sceneId && focusScene(
        flowInstance.current,
        canvasElement.current,
        focusRequest.sceneId,
        visibleSceneIds,
        { leftDockOpen, rightDockOpen, miniMapVisible },
        motionDuration,
      )) {
        return;
      }
      secondFrame = window.requestAnimationFrame(() => {
        if (focusChanged && focusRequest.sceneId) {
          focusScene(
            flowInstance.current,
            canvasElement.current,
            focusRequest.sceneId,
            visibleSceneIds,
            { leftDockOpen, rightDockOpen, miniMapVisible },
            motionDuration,
          );
        } else {
          fitStoryboard(flowInstance.current, fitViewPadding, motionDuration);
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [
    canvasSize.height,
    canvasSize.width,
    fitViewPadding,
    focusRequest.sceneId,
    focusRequest.sequence,
    leftDockOpen,
    miniMapVisible,
    motionDuration,
    projections,
    rightDockOpen,
  ]);

  const edges = useMemo<Edge[]>(() => orderedScenes.slice(1).map((scene, index) => ({
    id: `sequence:${orderedScenes[index]?.id ?? "start"}:${scene.id}`,
    source: orderedScenes[index]?.id ?? "",
    target: scene.id,
    type: "smoothstep",
    animated: false,
    selectable: false,
    focusable: false,
    className: "storyboard-sequence-edge",
  })), [orderedScenes]);

  function handleNodesChange(changes: NodeChange<Node<StoryboardNodeData>>[]): void {
    setNodes((current) => applyNodeChanges(changes, current));
  }

  if (orderedScenes.length === 0) {
    return (
      <EmptyState
        className="storyboard-empty-canvas"
        icon={<Clapperboard />}
        title={t("Start with the first scene")}
        description={t("Add a scene, then define its visual and generation source.")}
        action={(
          <Button size="sm" variant="primary" leadingIcon={<Plus aria-hidden="true" />} onClick={onCreateScene}>
            {t("Add scene")}
          </Button>
        )}
      />
    );
  }

  return (
    <div
      ref={canvasElement}
      className={`storyboard-canvas${leftDockOpen ? " has-left-dock" : ""}${rightDockOpen ? " has-right-dock" : ""}${miniMapVisible ? " has-minimap" : ""}`}
      aria-label={t("Scenes")}
      data-minimap-visible={miniMapVisible ? "true" : "false"}
      data-motion-duration={motionDuration}
      data-scene-count={orderedScenes.length}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeClick={(_, node) => onSelectScene(node.id)}
        onNodeDragStop={(_, node) => onMoveScene(node.id, node.position)}
        onInit={(instance) => {
          flowInstance.current = instance;
          window.requestAnimationFrame(() => fitStoryboard(instance, fitViewPadding, motionDuration));
        }}
        nodesDraggable={!isBusy}
        nodesConnectable={false}
        elementsSelectable={!isBusy}
        fitView
        fitViewOptions={{ padding: fitViewPadding, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="var(--ling-border-default)" />
        {miniMapVisible ? (
          <MiniMap
            ariaLabel={t("Scenes")}
            pannable
            zoomable
            style={{ width: 180, height: 112 }}
            nodeColor={(node) => node.id === selectedSceneId ? "var(--media-minimap-node-selected)" : "var(--media-minimap-node)"}
            nodeStrokeColor={(node) => node.id === selectedSceneId ? "var(--media-minimap-node-selected-stroke)" : "var(--media-minimap-node-stroke)"}
            nodeStrokeWidth={2}
            bgColor="var(--media-minimap-bg)"
            maskColor="var(--media-minimap-mask)"
            maskStrokeColor="var(--media-minimap-mask-stroke)"
            maskStrokeWidth={1}
          />
        ) : null}
        <Controls
          position="bottom-center"
          showInteractive={false}
          fitViewOptions={{ padding: fitViewPadding, maxZoom: 1 }}
        />
      </ReactFlow>
      {orderedScenes.length > 1 ? (
        <div className="storyboard-canvas-legend">
          <Sparkles aria-hidden="true" />
          {t("Scenes follow production order")}
        </div>
      ) : null}
    </div>
  );
}

function focusScene(
  instance: ReactFlowInstance<Node<StoryboardNodeData>, Edge> | null,
  canvas: HTMLDivElement | null,
  sceneId: string,
  visibleSceneIds: readonly string[],
  layout: {
    readonly leftDockOpen: boolean;
    readonly rightDockOpen: boolean;
    readonly miniMapVisible: boolean;
  },
  duration: number,
): boolean {
  if (!instance?.viewportInitialized || !canvas) return false;
  const node = instance.getNode(sceneId);
  if (!node) return false;
  const visibleNodes = visibleSceneIds.flatMap((id) => {
    const visibleNode = instance.getNode(id);
    return visibleNode ? [visibleNode] : [];
  });
  const safeArea = storyboardCanvasSafeArea({
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    ...layout,
  });
  const visibleBounds = storyboardLayoutBounds(visibleNodes.map((visibleNode) => ({
    position: visibleNode.position,
    width: visibleNode.measured?.width ?? visibleNode.width ?? storyboardNodeWidth,
    height: visibleNode.measured?.height ?? visibleNode.height ?? storyboardNodeHeight,
  })));
  if (visibleNodes.length > 1 && storyboardBoundsFitSafeArea({
    bounds: visibleBounds,
    safeArea,
    minimumZoom: 0.25,
  })) {
    void instance.fitView({
      nodes: visibleNodes,
      padding: storyboardFitViewPadding(layout),
      maxZoom: Math.min(instance.getZoom(), 1),
      duration,
    });
    return true;
  }
  const target = storyboardFocusViewport({
    nodePosition: node.position,
    nodeWidth: node.measured?.width ?? node.width ?? storyboardNodeWidth,
    nodeHeight: node.measured?.height ?? node.height ?? storyboardNodeHeight,
    zoom: instance.getZoom(),
    safeArea,
  });
  void instance.setViewport(target, { duration });
  return true;
}

function fitStoryboard(
  instance: ReactFlowInstance<Node<StoryboardNodeData>, Edge> | null,
  padding: StoryboardFitViewPadding,
  duration: number,
): boolean {
  if (!instance?.viewportInitialized) return false;
  void instance.fitView({ padding, maxZoom: 1, duration });
  return true;
}

function sceneNodes(
  projections: readonly StoryboardSceneProjection[],
  selectedSceneId: string,
  onSelectScene: (sceneId: string) => void,
  onPreviewResult: (sceneId: string) => void,
  t: Translate,
): Node<StoryboardNodeData>[] {
  return projections.map((projection) => ({
    id: projection.scene.id,
    type: "scene",
    position: projection.scene.canvasPosition,
    width: storyboardNodeWidth,
    height: storyboardNodeHeight,
    style: { width: storyboardNodeWidth, height: storyboardNodeHeight },
    data: {
      scene: projection.scene,
      order: projection.order,
      isSelected: projection.scene.id === selectedSceneId,
      readiness: projection.readiness,
      promptLabel: projection.scene.prompt.trim() || t("Needs setup"),
      durationLabel: t("{count} seconds", { count: projection.scene.durationSeconds }),
      statusLabel: t(projection.statusLabel.key, projection.statusLabel.values),
      previewLabel: `${t("Preview")}: ${projection.scene.title}`,
      onSelect: onSelectScene,
      onPreview: onPreviewResult,
    },
  }));
}

function reconcileSceneNodes(
  current: readonly Node<StoryboardNodeData>[],
  next: readonly Node<StoryboardNodeData>[],
): Node<StoryboardNodeData>[] {
  const currentById = new Map(current.map((node) => [node.id, node]));
  return next.map((node) => {
    const existing = currentById.get(node.id);
    return existing ? { ...existing, ...node, data: node.data, position: node.position } : node;
  });
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(
    () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const query = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const update = (): void => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reducedMotion;
}
