import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  JOINT_RADIUS,
  SEGMENTS,
  dollyCamera,
  evaluateActor,
  evaluateCamera,
  evaluateJoints,
  lookAroundCamera,
  orbitCamera,
  truckCamera,
  vec,
  verticalFovDegrees,
  yawFromDirection,
  type WhiteModelActorState,
  type WhiteModelCameraState,
  type WhiteModelObject,
  type WhiteModelScenePlan,
  type WhiteModelVector,
} from "../../lib/whiteModelScene";
import { dummyNumbers, isPanoramaAspect } from "../../lib/whiteModelBlocking";
import type { PlaybackClock } from "./whiteModelPlayback";

export type WhiteModelViewMode = "director" | "lens";

export interface WhiteModelViewportCallbacks {
  readonly onSelectActor: (actorId: string | null) => void;
  /** 在当前时间把角色拖到新位置（自动关键帧）。 */
  readonly onActorMove: (actorId: string, position: WhiteModelVector, time: number) => void;
  /** 拖动某个路径点。 */
  readonly onWaypointMove: (actorId: string, index: number, position: WhiteModelVector) => void;
  /** 在当前时间旋转角色（自动关键帧，仅手动朝向）。 */
  readonly onActorRotate: (actorId: string, yaw: number, time: number) => void;
  /** 在当前时间改写机位（自动关键帧）。 */
  readonly onCameraChange: (state: WhiteModelCameraState, time: number) => void;
}

/** 让 Three.js 与 Blender 同为 Z 轴向上；导演台是本项目唯一的 three 使用方。 */
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const GROUND = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const LINEAR = THREE.LinearSRGBColorSpace;

const unitSphere = new THREE.SphereGeometry(1, 16, 10);
const unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 16);
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const halfSphere = new THREE.SphereGeometry(0.5, 20, 12);
const halfCylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
const waypointDisc = new THREE.CircleGeometry(0.14, 24);
const selectionRing = new THREE.RingGeometry(0.42, 0.5, 40);
const yawHandleGeometry = new THREE.ConeGeometry(0.12, 0.3, 12);

type DragMode =
  | { kind: "actor"; actorId: string; grabOffset: THREE.Vector3 }
  | { kind: "waypoint"; actorId: string; index: number; grabOffset: THREE.Vector3 }
  | { kind: "rotate"; actorId: string; center: THREE.Vector3 }
  | { kind: "camera-body"; grabOffset: THREE.Vector3; start: WhiteModelCameraState }
  | {
      kind: "lens";
      operation: "orbit" | "look" | "truck";
      start: WhiteModelCameraState;
      pointer: { x: number; y: number };
    };

interface ActorVisual {
  actor: WhiteModelObject;
  group: THREE.Group;
  pickables: THREE.Mesh[];
  joints: THREE.Mesh[];
  bones: THREE.Mesh[];
  ring: THREE.Mesh;
  yawHandle: THREE.Mesh;
  label: THREE.Sprite | null;
  dummyNumber: number | null;
  material: THREE.MeshStandardMaterial;
  path: THREE.Line;
  pathKeyframes: WhiteModelObject["keyframes"] | null;
  waypoints: THREE.Mesh[];
  waypointGroup: THREE.Group;
}

function structureKey(actor: WhiteModelObject): string {
  return `${actor.shape}:${actor.size}:${actor.color}:${actor.keyframes.length}`;
}

function toVector3(value: WhiteModelVector): THREE.Vector3 {
  return new THREE.Vector3(value[0], value[1], value[2]);
}

function fromVector3(value: THREE.Vector3): WhiteModelVector {
  return [value.x, value.y, value.z];
}

function createNumberSprite(value: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, 128, 128);
    context.font = "bold 92px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 12;
    context.strokeStyle = "rgba(0, 0, 0, 0.78)";
    context.fillStyle = "#e23a28";
    context.strokeText(String(value), 64, 72);
    context.fillText(String(value), 64, 72);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      sizeAttenuation: true,
    }),
  );
  sprite.scale.set(0.46, 0.46, 0.46);
  sprite.renderOrder = 4;
  sprite.userData = { dummyNumber: value };
  return sprite;
}

function disposeSprite(sprite: THREE.Sprite | null): void {
  if (!sprite) return;
  const material = sprite.material;
  material.map?.dispose();
  material.dispose();
}

/**
 * 导演台视口：一个 WebGL 画布，两种视角（导演俯瞰 / 机位取景），所有可见运动都由
 * `whiteModelScene` 的求值函数在读取播放时钟后计算，与 Blender 渲染输入同源。
 */
export class WhiteModelViewportController {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly guides = new THREE.Group();
  private readonly actorsGroup = new THREE.Group();
  private readonly directorCamera: THREE.PerspectiveCamera;
  private readonly shotCamera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly cameraBody: THREE.Group;
  private readonly cameraPickable: THREE.Mesh;
  private readonly frustum: THREE.LineSegments;
  private readonly targetMarker: THREE.Mesh;
  private readonly aimLine: THREE.Line;
  private readonly actors = new Map<string, ActorVisual>();
  private readonly ground: THREE.Mesh;
  private readonly solidGroundMaterial: THREE.MeshStandardMaterial;
  private readonly shadowGroundMaterial: THREE.ShadowMaterial;
  private readonly defaultBackground: THREE.Color;
  private readonly backdrop: THREE.Mesh;
  private environmentSrc: string | null = null;
  private environmentTexture: THREE.Texture | null = null;
  private environmentLoad = 0;
  private showDummyLabels = false;
  private plan: WhiteModelScenePlan | null = null;
  private view: WhiteModelViewMode = "director";
  private selected: string | null = null;
  private width = 1;
  private height = 1;
  private frame: number | null = null;
  private drag: DragMode | null = null;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly clock: PlaybackClock,
    private readonly callbacks: WhiteModelViewportCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.defaultBackground = new THREE.Color().setRGB(0.055, 0.055, 0.055, LINEAR);
    this.scene.background = this.defaultBackground;

    this.directorCamera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    this.directorCamera.position.set(9, -11, 6.5);
    this.shotCamera = new THREE.PerspectiveCamera(40, 1, 0.05, 500);

    // 先注册自己的指针处理，再创建 OrbitControls：拖动角色/机位时要抢在环绕视角之前接管。
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerup", this.handlePointerUp);
    canvas.addEventListener("pointercancel", this.handlePointerUp);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.preventDefault);
    canvas.addEventListener("dblclick", this.handleDoubleClick);

    this.controls = new OrbitControls(this.directorCamera, canvas);
    this.controls.target.set(0, 0, 0.9);
    this.controls.enableDamping = false;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 120;
    this.controls.addEventListener("change", () => this.requestRender());

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 0.9);
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(6, -8, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -14;
    sun.shadow.camera.right = 14;
    sun.shadow.camera.top = 14;
    sun.shadow.camera.bottom = -14;
    sun.shadow.camera.far = 60;
    sun.shadow.bias = -0.0008;
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-8, 6, 5);
    this.scene.add(hemisphere, sun, fill, new THREE.AmbientLight(0xffffff, 0.15));

    this.solidGroundMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.16, 0.16, 0.16, LINEAR),
      roughness: 1,
    });
    this.shadowGroundMaterial = new THREE.ShadowMaterial({
      color: 0x000000,
      opacity: 0.38,
      transparent: true,
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), this.solidGroundMaterial);
    this.ground.position.z = -0.015;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
    );
    this.backdrop.rotation.x = Math.PI / 2;
    this.backdrop.position.set(0, 8, 2.2);
    this.backdrop.visible = false;
    this.scene.add(this.backdrop);

    const grid = new THREE.GridHelper(40, 40, 0x5a5a5a, 0x333333);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.002;
    this.guides.add(grid);

    this.cameraBody = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6 });
    this.cameraPickable = new THREE.Mesh(unitBox, bodyMaterial);
    this.cameraPickable.scale.set(0.34, 0.5, 0.26);
    this.cameraPickable.userData = { kind: "camera" };
    const lensMesh = new THREE.Mesh(halfCylinder, bodyMaterial);
    lensMesh.rotation.x = Math.PI / 2;
    lensMesh.scale.set(0.36, 0.36, 0.3);
    lensMesh.position.set(0, -0.35, 0);
    this.cameraBody.add(this.cameraPickable, lensMesh);
    this.frustum = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xf7d774 }),
    );
    this.targetMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xf7d774 }),
    );
    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: 0xf7d774, dashSize: 0.25, gapSize: 0.18 }),
    );
    this.guides.add(this.cameraBody, this.frustum, this.targetMarker, this.aimLine);
    this.scene.add(this.guides, this.actorsGroup);
    this.unsubscribe = clock.subscribe(() => this.requestRender());
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.renderer.setSize(this.width, this.height, false);
    this.directorCamera.aspect = this.width / this.height;
    this.directorCamera.updateProjectionMatrix();
    this.requestRender();
  }

  setView(view: WhiteModelViewMode): void {
    if (this.view === view) return;
    this.view = view;
    this.controls.enabled = view === "director" && this.drag == null;
    this.requestRender();
  }

  setSelected(actorId: string | null): void {
    this.selected = actorId;
    this.requestRender();
  }

  setPlan(plan: WhiteModelScenePlan): void {
    const previous = this.plan;
    this.plan = plan;
    const seen = new Set<string>();
    for (const actor of plan.objects) {
      seen.add(actor.id);
      const visual = this.actors.get(actor.id);
      if (!visual) this.actors.set(actor.id, this.createActorVisual(actor));
      else if (structureKey(visual.actor) !== structureKey(actor)) {
        this.destroyActorVisual(visual);
        this.actors.set(actor.id, this.createActorVisual(actor));
      } else visual.actor = actor;
    }
    for (const [id, visual] of this.actors) {
      if (!seen.has(id)) {
        this.destroyActorVisual(visual);
        this.actors.delete(id);
      }
    }
    const numbers = this.showDummyLabels ? dummyNumbers(plan.objects) : new Map<string, number>();
    for (const actor of plan.objects) {
      const visual = this.actors.get(actor.id);
      if (visual) this.syncDummyLabel(visual, numbers.get(actor.id) ?? null);
    }
    if (
      !previous ||
      previous.camera.lens !== plan.camera.lens ||
      previous.width !== plan.width ||
      previous.height !== plan.height
    ) {
      const aspect = plan.width / plan.height;
      this.shotCamera.fov = verticalFovDegrees(plan.camera.lens, aspect);
      this.shotCamera.aspect = aspect;
      this.shotCamera.updateProjectionMatrix();
      this.rebuildFrustum(aspect);
    }
    this.requestRender();
  }

  setShowDummyLabels(show: boolean): void {
    if (this.showDummyLabels === show) return;
    this.showDummyLabels = show;
    if (this.plan) this.setPlan(this.plan);
    else this.requestRender();
  }

  setEnvironmentSrc(src: string | null): void {
    if (this.environmentSrc === src) return;
    this.environmentSrc = src;
    this.clearEnvironment();
    if (!src) {
      this.requestRender();
      return;
    }
    const loadId = ++this.environmentLoad;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    loader.load(
      src,
      (texture) => {
        if (this.disposed || loadId !== this.environmentLoad) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        const image = texture.image as { width?: number; height?: number };
        const width = Number(image?.width) || 2;
        const height = Number(image?.height) || 1;
        this.environmentTexture = texture;
        this.ground.material = this.shadowGroundMaterial;
        if (isPanoramaAspect(width, height)) {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          this.scene.background = texture;
          this.backdrop.visible = false;
        } else {
          this.scene.background = this.defaultBackground;
          const material = this.backdrop.material as THREE.MeshBasicMaterial;
          material.map?.dispose();
          material.map = texture;
          material.needsUpdate = true;
          const worldHeight = 7.2;
          this.backdrop.scale.set(worldHeight * (width / Math.max(1, height)), worldHeight, 1);
          this.backdrop.visible = true;
        }
        this.requestRender();
      },
      undefined,
      () => {
        if (loadId === this.environmentLoad) this.requestRender();
      },
    );
  }

  /**
   * 按方案画幅从机位相机截一张 PNG。辅助线、选中环和路径不进入站位图，假人编号会留下。
   */
  captureStill(): string | null {
    if (this.disposed || !this.plan) return null;
    const width = Math.max(16, Math.round(this.plan.width));
    const height = Math.max(16, Math.round(this.plan.height));
    this.applyTime(this.clock.get());
    this.guides.visible = false;
    for (const visual of this.actors.values()) {
      visual.ring.visible = false;
      visual.yawHandle.visible = false;
      visual.path.visible = false;
      visual.waypointGroup.visible = false;
      if (visual.label) visual.label.visible = visual.dummyNumber != null;
    }
    const previousAspect = this.shotCamera.aspect;
    this.shotCamera.aspect = width / height;
    this.shotCamera.updateProjectionMatrix();
    const target = new THREE.WebGLRenderTarget(width, height, {
      colorSpace: THREE.SRGBColorSpace,
    });
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.setViewport(0, 0, width, height);
    this.renderer.setScissorTest(false);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.shotCamera);
    const pixels = new Uint8Array(width * height * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    this.renderer.setRenderTarget(previous);
    target.dispose();
    this.shotCamera.aspect = previousAspect;
    this.shotCamera.updateProjectionMatrix();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      this.requestRender();
      return null;
    }
    const image = context.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y += 1) {
      image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    context.putImageData(image, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    this.requestRender();
    return dataUrl.startsWith("data:image/png") ? dataUrl : null;
  }

  private clearEnvironment(): void {
    this.environmentLoad += 1;
    if (this.environmentTexture && this.scene.background === this.environmentTexture) {
      this.scene.background = this.defaultBackground;
    } else {
      this.scene.background = this.defaultBackground;
    }
    const backdropMaterial = this.backdrop.material as THREE.MeshBasicMaterial;
    if (backdropMaterial.map && backdropMaterial.map !== this.environmentTexture) {
      backdropMaterial.map.dispose();
    }
    backdropMaterial.map = null;
    this.backdrop.visible = false;
    this.environmentTexture?.dispose();
    this.environmentTexture = null;
    this.ground.material = this.solidGroundMaterial;
  }

  private syncDummyLabel(visual: ActorVisual, number: number | null): void {
    if (number == null) {
      if (visual.label) {
        visual.group.remove(visual.label);
        disposeSprite(visual.label);
        visual.label = null;
      }
      visual.dummyNumber = null;
      return;
    }
    if (visual.dummyNumber === number && visual.label) {
      visual.label.position.set(0, 0, visual.actor.size * 1.14);
      visual.label.visible = true;
      return;
    }
    if (visual.label) {
      visual.group.remove(visual.label);
      disposeSprite(visual.label);
    }
    visual.label = createNumberSprite(number);
    visual.label.position.set(0, 0, visual.actor.size * 1.14);
    visual.group.add(visual.label);
    visual.dummyNumber = number;
  }

  /** 导演视角回到能看全场的默认位置。 */
  resetDirectorView(): void {
    this.directorCamera.position.set(9, -11, 6.5);
    this.controls.target.set(0, 0, 0.9);
    this.controls.update();
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.frame != null) cancelAnimationFrame(this.frame);
    const { canvas } = this;
    canvas.removeEventListener("pointerdown", this.handlePointerDown);
    canvas.removeEventListener("pointermove", this.handlePointerMove);
    canvas.removeEventListener("pointerup", this.handlePointerUp);
    canvas.removeEventListener("pointercancel", this.handlePointerUp);
    canvas.removeEventListener("wheel", this.handleWheel);
    canvas.removeEventListener("contextmenu", this.preventDefault);
    canvas.removeEventListener("dblclick", this.handleDoubleClick);
    this.controls.dispose();
    for (const visual of this.actors.values()) this.destroyActorVisual(visual);
    this.actors.clear();
    this.clearEnvironment();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------------
  // 场景构建
  // ---------------------------------------------------------------------

  private createActorVisual(actor: WhiteModelObject): ActorVisual {
    const group = new THREE.Group();
    group.userData = { kind: "actor", actorId: actor.id };
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(actor.color),
      roughness: 0.75,
      metalness: 0,
    });
    const pickables: THREE.Mesh[] = [];
    const joints: THREE.Mesh[] = [];
    const bones: THREE.Mesh[] = [];
    const tag = (mesh: THREE.Mesh) => {
      mesh.userData = { kind: "actor", actorId: actor.id };
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      pickables.push(mesh);
      group.add(mesh);
      return mesh;
    };
    if (actor.shape === "person") {
      for (let index = 0; index < JOINT_RADIUS.length; index += 1) {
        const radius = JOINT_RADIUS[index]! * actor.size;
        const mesh = tag(new THREE.Mesh(unitSphere, material));
        mesh.scale.setScalar(radius);
        joints.push(mesh);
      }
      for (const [, , radiusRatio] of SEGMENTS) {
        const mesh = tag(new THREE.Mesh(unitCylinder, material));
        mesh.scale.set(radiusRatio * actor.size, 1, radiusRatio * actor.size);
        bones.push(mesh);
      }
    } else {
      const geometry =
        actor.shape === "box" ? unitBox : actor.shape === "sphere" ? halfSphere : halfCylinder;
      const mesh = tag(new THREE.Mesh(geometry, material));
      mesh.scale.setScalar(actor.size);
      if (actor.shape === "cylinder") mesh.rotation.x = Math.PI / 2;
      mesh.position.z = actor.size / 2;
    }
    const ring = new THREE.Mesh(
      selectionRing,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    );
    ring.position.z = 0.01;
    ring.scale.setScalar(Math.max(0.6, actor.size * 0.45));
    ring.visible = false;
    group.add(ring);
    const yawHandle = new THREE.Mesh(
      yawHandleGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    yawHandle.userData = { kind: "rotate", actorId: actor.id };
    yawHandle.visible = false;
    group.add(yawHandle);

    const path = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: new THREE.Color(actor.color), transparent: true, opacity: 0.9 }),
    );
    const waypointGroup = new THREE.Group();
    const waypoints: THREE.Mesh[] = [];
    const waypointMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(actor.color) });
    for (let index = 0; index < actor.keyframes.length; index += 1) {
      const disc = new THREE.Mesh(waypointDisc, waypointMaterial);
      disc.userData = { kind: "waypoint", actorId: actor.id, index };
      waypoints.push(disc);
      waypointGroup.add(disc);
    }
    this.guides.add(path, waypointGroup);
    this.actorsGroup.add(group);
    return {
      actor,
      group,
      pickables,
      joints,
      bones,
      ring,
      yawHandle,
      label: null,
      dummyNumber: null,
      material,
      path,
      pathKeyframes: null,
      waypoints,
      waypointGroup,
    };
  }

  private destroyActorVisual(visual: ActorVisual): void {
    this.actorsGroup.remove(visual.group);
    this.guides.remove(visual.path, visual.waypointGroup);
    visual.material.dispose();
    visual.path.geometry.dispose();
    (visual.path.material as THREE.Material).dispose();
    (visual.ring.material as THREE.Material).dispose();
    (visual.yawHandle.material as THREE.Material).dispose();
    if (visual.label) {
      visual.group.remove(visual.label);
      disposeSprite(visual.label);
    }
    const waypointMaterial = visual.waypoints[0]?.material as THREE.Material | undefined;
    waypointMaterial?.dispose();
  }

  private rebuildFrustum(aspect: number): void {
    const depth = 1.1;
    const halfHeight = Math.tan((this.shotCamera.fov / 2) * (Math.PI / 180)) * depth;
    const halfWidth = halfHeight * aspect;
    const apex = new THREE.Vector3(0, 0, 0);
    const corners = [
      new THREE.Vector3(-halfWidth, -halfHeight, -depth),
      new THREE.Vector3(halfWidth, -halfHeight, -depth),
      new THREE.Vector3(halfWidth, halfHeight, -depth),
      new THREE.Vector3(-halfWidth, halfHeight, -depth),
    ];
    const points: THREE.Vector3[] = [];
    for (let index = 0; index < 4; index += 1) {
      points.push(apex.clone(), corners[index]!.clone());
      points.push(corners[index]!.clone(), corners[(index + 1) % 4]!.clone());
    }
    // 顶部三角标记画面上方，便于辨认取景方向。
    points.push(
      corners[3]!.clone(),
      new THREE.Vector3(0, halfHeight * 1.45, -depth),
      new THREE.Vector3(0, halfHeight * 1.45, -depth),
      corners[2]!.clone(),
    );
    this.frustum.geometry.dispose();
    this.frustum.geometry = new THREE.BufferGeometry().setFromPoints(points);
  }

  // ---------------------------------------------------------------------
  // 逐帧更新与渲染
  // ---------------------------------------------------------------------

  private requestRender(): void {
    if (this.disposed || this.frame != null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  private applyTime(time: number): void {
    const { plan } = this;
    if (!plan) return;
    for (const actor of plan.objects) {
      const visual = this.actors.get(actor.id);
      if (!visual) continue;
      const state = evaluateActor(actor, time);
      visual.group.position.set(state.position[0], state.position[1], state.position[2]);
      visual.group.rotation.z = (state.yaw * Math.PI) / 180;
      if (actor.shape === "person") this.poseMannequin(visual, actor, state, time);
      const selected = this.selected === actor.id;
      visual.ring.visible = selected && this.view === "director";
      visual.yawHandle.visible = selected && this.view === "director" && actor.facing === "manual";
      if (visual.yawHandle.visible) {
        const reach = Math.max(0.6, actor.size * 0.45) + 0.3;
        visual.yawHandle.position.set(0, -reach, 0.03);
        visual.yawHandle.rotation.set(-Math.PI / 2, 0, 0);
      }
      this.updatePath(visual, actor, selected);
    }
    const shot = evaluateCamera(plan, time);
    const position = toVector3(shot.position);
    const target = toVector3(shot.target);
    this.shotCamera.position.copy(position);
    this.shotCamera.lookAt(target);
    this.cameraBody.position.copy(position);
    this.cameraBody.quaternion.copy(this.shotCamera.quaternion);
    // 机身沿 -Z 看向目标；把机身模型的 -Y 方向对齐到镜头方向。
    this.cameraBody.rotateX(Math.PI / 2);
    this.frustum.position.copy(position);
    this.frustum.quaternion.copy(this.shotCamera.quaternion);
    this.targetMarker.position.copy(target);
    const aimPositions = this.aimLine.geometry.getAttribute("position") as THREE.BufferAttribute;
    aimPositions.setXYZ(0, position.x, position.y, position.z);
    aimPositions.setXYZ(1, target.x, target.y, target.z);
    aimPositions.needsUpdate = true;
    this.aimLine.computeLineDistances();
  }

  private poseMannequin(
    visual: ActorVisual,
    actor: WhiteModelObject,
    state: WhiteModelActorState,
    time: number,
  ): void {
    const joints = evaluateJoints(actor, state, time);
    if (!joints) return;
    joints.forEach((joint, index) => {
      visual.joints[index]?.position.set(joint[0], joint[1], joint[2]);
    });
    const direction = new THREE.Vector3();
    SEGMENTS.forEach(([start, end, radiusRatio], index) => {
      const bone = visual.bones[index];
      if (!bone) return;
      const a = joints[start]!;
      const b = joints[end]!;
      direction.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const length = Math.max(1e-4, direction.length());
      bone.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      bone.quaternion.setFromUnitVectors(Y_AXIS, direction.divideScalar(length));
      bone.scale.set(radiusRatio * actor.size, length, radiusRatio * actor.size);
    });
  }

  private updatePath(visual: ActorVisual, actor: WhiteModelObject, selected: boolean): void {
    (visual.path.material as THREE.LineBasicMaterial).opacity = selected ? 1 : 0.45;
    visual.waypointGroup.visible = selected;
    // 截站位图会先把路径藏起来。关键帧数组引用没变时下面会提前返回，
    // 可见性必须在返回前按关键帧数量恢复，否则路径会一直消失。
    visual.path.visible = actor.keyframes.length > 1;
    if (visual.pathKeyframes === actor.keyframes) return;
    visual.pathKeyframes = actor.keyframes;
    const points = actor.keyframes.map((frame) =>
      new THREE.Vector3(frame.position[0], frame.position[1], frame.position[2] + 0.02),
    );
    visual.path.geometry.dispose();
    visual.path.geometry = new THREE.BufferGeometry().setFromPoints(points);
    visual.waypoints.forEach((disc, index) => {
      const frame = actor.keyframes[index];
      if (!frame) return;
      disc.position.set(frame.position[0], frame.position[1], frame.position[2] + 0.015);
    });
  }

  /** 机位视角里画面按输出画幅居中；返回像素矩形，供叠加取景框使用。 */
  lensRect(): { x: number; y: number; width: number; height: number } {
    const aspect = this.plan ? this.plan.width / this.plan.height : 16 / 9;
    let width = this.width;
    let height = Math.round(width / aspect);
    if (height > this.height) {
      height = this.height;
      width = Math.round(height * aspect);
    }
    return {
      x: Math.floor((this.width - width) / 2),
      y: Math.floor((this.height - height) / 2),
      width,
      height,
    };
  }

  private render(): void {
    if (this.disposed || !this.plan) return;
    this.applyTime(this.clock.get());
    this.guides.visible = this.view === "director";
    if (this.view === "director") {
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, this.width, this.height);
      this.renderer.render(this.scene, this.directorCamera);
      return;
    }
    const rect = this.lensRect();
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(rect.x, rect.y, rect.width, rect.height);
    this.renderer.setScissor(rect.x, rect.y, rect.width, rect.height);
    this.renderer.render(this.scene, this.shotCamera);
    this.renderer.setScissorTest(false);
  }

  // ---------------------------------------------------------------------
  // 交互
  // ---------------------------------------------------------------------

  private activeCamera(): THREE.PerspectiveCamera {
    return this.view === "director" ? this.directorCamera : this.shotCamera;
  }

  private pointerNdc(event: PointerEvent): THREE.Vector2 | null {
    const bounds = this.canvas.getBoundingClientRect();
    let x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    let y = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
    if (this.view === "lens") {
      // 机位视角只在居中的取景矩形内成像。
      const rect = this.lensRect();
      const px = ((event.clientX - bounds.left) / bounds.width) * this.width;
      const py = ((event.clientY - bounds.top) / bounds.height) * this.height;
      // WebGL 视口原点在左下角。
      const inside =
        px >= rect.x &&
        px <= rect.x + rect.width &&
        this.height - py >= rect.y &&
        this.height - py <= rect.y + rect.height;
      if (!inside) return null;
      x = ((px - rect.x) / rect.width) * 2 - 1;
      y = ((this.height - py - rect.y) / rect.height) * 2 - 1;
    }
    return new THREE.Vector2(x, y);
  }

  private groundPoint(ndc: THREE.Vector2): THREE.Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.activeCamera());
    const point = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(GROUND, point);
  }

  private pick(ndc: THREE.Vector2): THREE.Object3D | null {
    this.raycaster.setFromCamera(ndc, this.activeCamera());
    const candidates: THREE.Object3D[] = [];
    for (const visual of this.actors.values()) {
      candidates.push(...visual.pickables);
      if (this.view === "director" && this.selected === visual.actor.id) {
        candidates.push(...visual.waypoints);
        if (visual.yawHandle.visible) candidates.push(visual.yawHandle);
      }
    }
    if (this.view === "director") candidates.push(this.cameraPickable);
    const hits = this.raycaster.intersectObjects(candidates, false);
    // 路径点与旋转手柄优先于角色本体，避免被身体挡住。
    const priority = hits.find((hit) => hit.object.userData["kind"] !== "actor");
    return (priority ?? hits[0])?.object ?? null;
  }

  private readonly preventDefault = (event: Event) => {
    event.preventDefault();
  };

  private readonly handleDoubleClick = () => {
    if (this.view === "director") this.resetDirectorView();
  };

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (!this.plan) return;
    const ndc = this.pointerNdc(event);
    if (!ndc) return;
    const hit = this.pick(ndc);
    const time = this.clock.get();
    if (hit && event.button === 0) {
      const data = hit.userData as { kind: string; actorId?: string; index?: number };
      const ground = this.groundPoint(ndc) ?? new THREE.Vector3();
      if (data.kind === "actor" && data.actorId) {
        const actor = this.plan.objects.find((entry) => entry.id === data.actorId);
        if (!actor) return;
        const state = evaluateActor(actor, time);
        this.callbacks.onSelectActor(actor.id);
        this.beginDrag(event, {
          kind: "actor",
          actorId: actor.id,
          grabOffset: ground.clone().sub(toVector3(state.position)).setZ(0),
        });
        return;
      }
      if (data.kind === "waypoint" && data.actorId != null && data.index != null) {
        const actor = this.plan.objects.find((entry) => entry.id === data.actorId);
        const frame = actor?.keyframes[data.index];
        if (!actor || !frame) return;
        this.beginDrag(event, {
          kind: "waypoint",
          actorId: actor.id,
          index: data.index,
          grabOffset: ground.clone().sub(toVector3(frame.position)).setZ(0),
        });
        return;
      }
      if (data.kind === "rotate" && data.actorId) {
        const actor = this.plan.objects.find((entry) => entry.id === data.actorId);
        if (!actor) return;
        const state = evaluateActor(actor, time);
        this.beginDrag(event, {
          kind: "rotate",
          actorId: actor.id,
          center: toVector3(state.position).setZ(0),
        });
        return;
      }
      if (data.kind === "camera") {
        const state = evaluateCamera(this.plan, time);
        this.beginDrag(event, {
          kind: "camera-body",
          grabOffset: ground.clone().sub(toVector3(state.position)).setZ(0),
          start: state,
        });
        return;
      }
    }
    if (this.view === "lens") {
      const operation: "orbit" | "look" | "truck" =
        event.button === 2 ? "look" : event.button === 1 || event.shiftKey ? "truck" : "orbit";
      this.beginDrag(event, {
        kind: "lens",
        operation,
        start: evaluateCamera(this.plan, time),
        pointer: { x: event.clientX, y: event.clientY },
      });
      return;
    }
    if (event.button === 0 && !hit) this.callbacks.onSelectActor(null);
  };

  private beginDrag(event: PointerEvent, mode: DragMode): void {
    this.drag = mode;
    this.controls.enabled = false;
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    const { drag, plan } = this;
    if (!drag || !plan) return;
    const time = this.clock.get();
    if (drag.kind === "lens") {
      const dx = event.clientX - drag.pointer.x;
      const dy = event.clientY - drag.pointer.y;
      let next: WhiteModelCameraState;
      if (drag.operation === "orbit") {
        next = orbitCamera(drag.start, -dx * 0.3, dy * 0.3);
      } else if (drag.operation === "look") {
        if (plan.camera.follow?.mode === "aim") return;
        next = lookAroundCamera(drag.start, dx * 0.15, -dy * 0.15);
      } else {
        const distance = vec.distance(drag.start.position, drag.start.target);
        const scale = distance / Math.max(200, this.height);
        next = truckCamera(drag.start, -dx * scale, dy * scale);
      }
      this.callbacks.onCameraChange(next, time);
      return;
    }
    const ndc = this.pointerNdc(event);
    if (!ndc) return;
    const ground = this.groundPoint(ndc);
    if (!ground) return;
    if (drag.kind === "actor") {
      const actor = plan.objects.find((entry) => entry.id === drag.actorId);
      if (!actor) return;
      const current = evaluateActor(actor, time);
      const target = ground.clone().sub(drag.grabOffset);
      this.callbacks.onActorMove(
        actor.id,
        vec.round([target.x, target.y, current.position[2]], 3),
        time,
      );
      return;
    }
    if (drag.kind === "waypoint") {
      const actor = plan.objects.find((entry) => entry.id === drag.actorId);
      const frame = actor?.keyframes[drag.index];
      if (!actor || !frame) return;
      const target = ground.clone().sub(drag.grabOffset);
      this.callbacks.onWaypointMove(actor.id, drag.index, vec.round([target.x, target.y, frame.position[2]], 3));
      return;
    }
    if (drag.kind === "rotate") {
      const direction = fromVector3(ground.clone().sub(drag.center).setZ(0));
      this.callbacks.onActorRotate(drag.actorId, Math.round(yawFromDirection(direction)), time);
      return;
    }
    if (drag.kind === "camera-body") {
      const target = ground.clone().sub(drag.grabOffset);
      const shift: WhiteModelVector = [
        target.x - drag.start.position[0],
        target.y - drag.start.position[1],
        0,
      ];
      this.callbacks.onCameraChange(
        {
          position: vec.round(vec.add(drag.start.position, shift), 3),
          target:
            plan.camera.follow?.mode === "aim"
              ? drag.start.target
              : vec.round(vec.add(drag.start.target, shift), 3),
        },
        time,
      );
    }
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    if (this.drag) {
      if (this.canvas.hasPointerCapture(event.pointerId))
        this.canvas.releasePointerCapture(event.pointerId);
      this.drag = null;
    }
    this.controls.enabled = this.view === "director";
  };

  private readonly handleWheel = (event: WheelEvent) => {
    if (this.view !== "lens" || !this.plan) return;
    event.preventDefault();
    const time = this.clock.get();
    const factor = Math.exp(Math.sign(event.deltaY) * 0.08);
    this.callbacks.onCameraChange(dollyCamera(evaluateCamera(this.plan, time), factor), time);
  };
}
