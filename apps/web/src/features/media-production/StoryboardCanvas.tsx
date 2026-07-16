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
import type { MediaScene } from "../../types.js";
import type { StoryboardFocusRequest } from "./media-production-types.js";
import type { SceneReadiness } from "./media-production-view-models.js";

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
  readonly onSelect: (sceneId: string) => void;
  readonly onPreview: (sceneId: string) => void;
}

function StoryboardSceneNode({ data }: NodeProps<Node<StoryboardNodeData>>): JSX.Element {
  const { scene } = data;
  return (
    <div className={`storyboard-scene-node-frame${data.readiness?.currentArtifact ? " has-preview" : ""}`}>
      <Handle type="target" position={Position.Left} className="storyboard-node-handle" />
      <button
        type="button"
        className={`storyboard-scene-node${data.isSelected ? " selected" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          data.onSelect(scene.id);
        }}
      >
        <span className="storyboard-scene-node-order">{String(data.order).padStart(2, "0")}</span>
        <span className="storyboard-scene-node-body">
          <strong>{scene.title}</strong>
          <small>{scene.prompt.trim() || "等待填写画面提示"}</small>
          <span className="storyboard-scene-node-meta">
            <span>{scene.ratio}</span>
            <span>{scene.durationSeconds} 秒</span>
            {scene.referenceArtifactIds.length > 0 ? <ImageIcon size={12} aria-label="已关联参考图" /> : null}
            <span className={`storyboard-node-status ${data.readiness?.state ?? "needs_model"}`}>{data.readiness?.label ?? "待完善"}</span>
          </span>
          {data.readiness?.workflow || data.readiness?.provider ? (
            <span className="storyboard-scene-node-source">{data.readiness.workflow?.definition.name ?? data.readiness.provider?.displayName}</span>
          ) : null}
        </span>
      </button>
      {data.readiness?.currentArtifact ? (
        <button
          type="button"
          className="storyboard-scene-preview nodrag nopan"
          title="预览当前视频"
          aria-label={`预览当前视频：${scene.title}`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            data.onPreview(scene.id);
          }}
        >
          <Play size={14} fill="currentColor" aria-hidden="true" />
        </button>
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
  const initialNodes = useMemo(
    () => sceneNodes(scenes, selectedSceneId, readiness, onSelectScene, onPreviewResult),
    [onPreviewResult, onSelectScene, readiness, scenes, selectedSceneId],
  );
  const [nodes, setNodes] = useState<Node<StoryboardNodeData>[]>(initialNodes);
  const flowInstance = useRef<ReactFlowInstance<Node<StoryboardNodeData>, Edge> | null>(null);
  const canvasElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNodes((current) => reconcileSceneNodes(current, initialNodes));
  }, [initialNodes]);

  useEffect(() => {
    if (!focusRequest.sceneId) {
      return;
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      if (focusScene(flowInstance.current, canvasElement.current, focusRequest.sceneId, {
        leftDockOpen,
        rightDockOpen,
        miniMapVisible: scenes.length >= 2,
      })) {
        return;
      }
      secondFrame = window.requestAnimationFrame(() => {
        focusScene(flowInstance.current, canvasElement.current, focusRequest.sceneId, {
          leftDockOpen,
          rightDockOpen,
          miniMapVisible: scenes.length >= 2,
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [focusRequest.sceneId, focusRequest.sequence]);

  const edges = useMemo<Edge[]>(() => scenes.slice(1).map((scene, index) => ({
    id: `sequence:${scenes[index]?.id ?? "start"}:${scene.id}`,
    source: scenes[index]?.id ?? "",
    target: scene.id,
    type: "smoothstep",
    animated: false,
    selectable: false,
    focusable: false,
    className: "storyboard-sequence-edge",
  })), [scenes]);

  function handleNodesChange(changes: NodeChange<Node<StoryboardNodeData>>[]): void {
    setNodes((current) => applyNodeChanges(changes, current));
  }

  if (scenes.length === 0) {
    return (
      <div className="storyboard-empty-canvas">
        <Clapperboard size={26} strokeWidth={1.7} />
        <strong>从第一个场景开始</strong>
        <span>每个场景独立生成，顺序由场景编号决定。</span>
        <button className="primary-button compact-button" type="button" onClick={onCreateScene}><Plus size={15} /> 添加第一个场景</button>
      </div>
    );
  }

  return (
    <div
      ref={canvasElement}
      className={`storyboard-canvas${leftDockOpen ? " has-left-dock" : ""}${rightDockOpen ? " has-right-dock" : ""}${scenes.length >= 2 ? " has-minimap" : ""}`}
      aria-label="分镜画布"
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
          if (focusRequest.sceneId) {
            window.requestAnimationFrame(() => focusScene(instance, canvasElement.current, focusRequest.sceneId, {
              leftDockOpen,
              rightDockOpen,
              miniMapVisible: scenes.length >= 2,
            }));
          }
        }}
        nodesDraggable={!isBusy}
        nodesConnectable={false}
        elementsSelectable={!isBusy}
        fitView
        fitViewOptions={{ padding: 0.28, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="var(--border-subtle, #e7e7e7)" />
        {scenes.length >= 2 ? (
          <MiniMap
            ariaLabel="分镜缩略图"
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
          fitViewOptions={{ padding: 0.28, maxZoom: 1 }}
        />
      </ReactFlow>
      {scenes.length > 1 ? <div className="storyboard-canvas-legend">
        <Sparkles size={14} />
        场景位置只用于排布，生成顺序以编号为准。
      </div> : null}
    </div>
  );
}

function focusScene(
  instance: ReactFlowInstance<Node<StoryboardNodeData>, Edge> | null,
  canvas: HTMLDivElement | null,
  sceneId: string,
  layout: {
    readonly leftDockOpen: boolean;
    readonly rightDockOpen: boolean;
    readonly miniMapVisible: boolean;
  },
): boolean {
  if (!instance?.viewportInitialized || !canvas) {
    return false;
  }
  const node = instance.getNode(sceneId);
  if (!node) {
    return false;
  }
  const width = node.measured?.width ?? node.width ?? 218;
  const height = node.measured?.height ?? node.height ?? 104;
  const zoom = instance.getZoom();
  const leftInset = layout.leftDockOpen ? 320 : 16;
  const rightInset = layout.rightDockOpen ? 392 : 16;
  const topInset = 72;
  const bottomInset = layout.miniMapVisible ? 144 : 56;
  const safeWidth = Math.max(0, canvas.clientWidth - leftInset - rightInset);
  const safeHeight = Math.max(0, canvas.clientHeight - topInset - bottomInset);
  const targetX = leftInset + safeWidth / 2;
  const targetY = topInset + safeHeight / 2;
  void instance.setViewport({
    x: targetX - (node.position.x + width / 2) * zoom,
    y: targetY - (node.position.y + height / 2) * zoom,
    zoom,
  }, { duration: 250 });
  return true;
}

function sceneNodes(
  scenes: readonly MediaScene[],
  selectedSceneId: string,
  readiness: readonly SceneReadiness[],
  onSelectScene: (sceneId: string) => void,
  onPreviewResult: (sceneId: string) => void,
): Node<StoryboardNodeData>[] {
  const readinessByScene = new Map(readiness.map((item) => [item.sceneId, item]));
  return scenes.map((scene, index) => ({
    id: scene.id,
    type: "scene",
    position: scene.canvasPosition,
    width: 218,
    height: 104,
    data: {
      scene,
      order: index + 1,
      isSelected: scene.id === selectedSceneId,
      readiness: readinessByScene.get(scene.id),
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
