import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { loadDirectorModel } from "./directorModelAsset";
import { isDirectorBody } from "./directorCatalog";
import { addDirectorProp, makeDirectorRig } from "./directorGeometry";
import { directorPoseAt, transformAt, type DirectorObject, type DirectorScene, type DirectorTransform } from "./directorScene";

export type DirectorTransformMode = "translate" | "rotate" | "scale";
export const directorViewLabels = ["正面", "右前", "右侧", "右后", "背面", "左后", "左侧", "左前"] as const;

function applyTransform(mesh: THREE.Object3D, transform: DirectorTransform) {
  mesh.position.fromArray(transform.position);
  mesh.rotation.set(...transform.rotation.map(THREE.MathUtils.degToRad) as [number, number, number], "YXZ");
  mesh.scale.fromArray(transform.scale);
}

function makeObject(item: DirectorObject) {
  const mesh = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: item.color, roughness: 0.75 });
  const pose = isDirectorBody(item.kind) ? makeDirectorRig(mesh, item.kind, material) : null;
  let board: ReturnType<typeof addDirectorProp> = null;
  if (item.kind === "camera") {
    material.wireframe = true;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.29, 0.32), material);
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.19, 0.22), material);
    lens.position.z = -0.24;
    mesh.add(body, lens);
  } else if (item.kind === "model") {
    material.dispose();
  } else if (!isDirectorBody(item.kind)) {
    board = addDirectorProp(mesh, item.kind, material);
  }
  return { mesh, pose, board };
}

function disposeObject(root: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  root.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
    }
  });
  materials.forEach(material => {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
    material.dispose();
  });
}

export function createDirectorViewport(host: HTMLElement, callbacks: {
  select: (id: string | null) => void;
  commit: (id: string, transform: DirectorTransform) => void;
  panoramaFailed: () => void;
  contextLost: () => void;
  modelFailed: (name: string) => void;
}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 0.03, 400);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 0.75, 0);
  camera.position.set(4.4, 3.6, 6.6);
  orbit.update();
  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.8);
  const gizmoHelper = gizmo.getHelper();
  const objects = new THREE.Group();
  const grid = new THREE.GridHelper(160, 160, "#666a76", "#42444f");
  grid.position.y = 0.006;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: "#444651", roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const keyLight = new THREE.DirectionalLight("#fff0dc", 2.1);
  keyLight.position.set(-5, 10, 5);
  keyLight.castShadow = true;
  keyLight.shadow.camera.left = -18;
  keyLight.shadow.camera.right = 18;
  keyLight.shadow.camera.top = 18;
  keyLight.shadow.camera.bottom = -18;
  keyLight.shadow.mapSize.set(1024, 1024);
  scene.add(new THREE.HemisphereLight("#eaf0ff", "#666978", 2.2), keyLight, grid, floor, objects, gizmoHelper);
  host.append(renderer.domElement);

  const members = new Map<string, ReturnType<typeof makeObject> & {
    item: DirectorObject;
    ready: boolean;
    imageUrl: string | null;
  }>();
  const lens = new THREE.PerspectiveCamera(48, 1, 0.03, 400);
  const ray = new THREE.Raycaster();
  const cursor = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#68defa", depthTest: false }));
  pathLine.renderOrder = 10;
  scene.add(pathLine);
  let current: DirectorScene | null = null;
  let selectedId: string | null = null;
  let viewCameraId: string | null = null;
  let time: number | null = null;
  let panorama: THREE.Texture | null = null;
  let panoramaRequest = 0;
  let size = { width: 1, height: 1 };
  let mode: DirectorTransformMode = "translate";
  let start: { x: number; y: number } | null = null;
  let dragged = false;
  let disposed = false;
  let recording = false;
  let pathMode = false;
  let pathPoints: DirectorTransform["position"][] = [];

  const hideCamera = ({ item, mesh }: { item: DirectorObject; mesh: THREE.Group }) =>
    item.kind === "camera" && (viewCameraId ? item.id === viewCameraId : mesh.position.distanceToSquared(camera.position) < 0.64);
  const render = () => {
    if (disposed || recording) return;
    const view = viewCameraId ? cameraFor(viewCameraId, camera.aspect) : null;
    const blocked = [...members.values()].filter(member => member.mesh.visible && hideCamera(member));
    blocked.forEach(({ mesh }) => { mesh.visible = false; });
    try { renderer.render(scene, view ?? camera); }
    finally { blocked.forEach(({ mesh }) => { mesh.visible = true; }); }
  };
  const resize = () => {
    size = { width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight) };
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
    if (recording) return;
    renderer.setSize(size.width, size.height);
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  const refreshGizmo = () => {
    const member = selectedId ? members.get(selectedId) : null;
    if (member && !viewCameraId && time === null && !pathMode) gizmo.attach(member.mesh);
    else gizmo.detach();
    orbit.enabled = !viewCameraId && !gizmo.dragging && !pathMode;
    render();
  };
  const setTime = (next: number | null) => {
    time = next;
    if (current) for (const { item, mesh, pose } of members.values()) {
      applyTransform(mesh, time === null ? item : transformAt(current, item, time));
      if (pose) pose(time === null ? item.jointAngles : directorPoseAt(current, item, time));
    }
    refreshGizmo();
  };
  const cameraFor = (id: string, aspect: number) => {
    const member = members.get(id);
    if (!member || member.item.kind !== "camera") return null;
    lens.position.copy(member.mesh.position);
    lens.rotation.copy(member.mesh.rotation);
    lens.fov = member.item.fov;
    lens.aspect = aspect;
    lens.updateProjectionMatrix();
    return lens;
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || recording) return;
    start = { x: event.clientX, y: event.clientY };
    dragged = Boolean(gizmo.axis);
    if (pathMode) {
      renderer.domElement.setPointerCapture(event.pointerId);
      appendPathPoint(event);
    }
  };
  const pointRay = (event: PointerEvent) => {
    const bounds = renderer.domElement.getBoundingClientRect();
    cursor.set((event.clientX - bounds.left) / bounds.width * 2 - 1,
      -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    ray.setFromCamera(cursor, camera);
  };
  function appendPathPoint(event: PointerEvent) {
    if (pathPoints.length >= 120) return;
    pointRay(event);
    const point = ray.ray.intersectPlane(ground, new THREE.Vector3());
    if (!point || Math.abs(point.x) > 1000 || Math.abs(point.z) > 1000) return;
    const last = pathPoints.at(-1);
    if (last && Math.hypot(point.x - last[0], point.z - last[2]) < 0.12) return;
    pathPoints.push([point.x, 0.03, point.z]);
    pathLine.geometry.dispose();
    pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pathPoints.map(p => new THREE.Vector3(...p)));
    render();
  }
  const drawPath = (event: PointerEvent) => {
    if (pathMode && start && (event.buttons & 1)) appendPathPoint(event);
  };
  const pointerUp = (event: PointerEvent) => {
    if (!start || event.button !== 0) return;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    start = null;
    if (pathMode) { appendPathPoint(event); return; }
    if (dragged || distance > 4 || viewCameraId || time !== null) return;
    pointRay(event);
    const candidates = [...members.values()].filter(member => !hideCamera(member)).map(member => member.mesh);
    const hit = ray.intersectObjects(candidates, true)[0]?.object;
    let root = hit;
    while (root && root.parent !== objects) root = root.parent ?? undefined;
    callbacks.select((root?.userData["directorId"] as string | undefined) ?? null);
  };
  const captureTransform = () => {
    if (!selectedId || !gizmo.object) return;
    const mesh = gizmo.object;
    callbacks.commit(selectedId, {
      position: mesh.position.toArray().map(value => Math.min(1000, Math.max(-1000, value))) as DirectorTransform["position"],
      rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map(THREE.MathUtils.radToDeg) as DirectorTransform["rotation"],
      scale: mesh.scale.toArray().map(value => Math.min(100, Math.max(0.05, value))) as DirectorTransform["scale"],
    });
  };
  const contextLost = (event: Event) => { event.preventDefault(); callbacks.contextLost(); };
  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointermove", drawPath);
  renderer.domElement.addEventListener("pointerup", pointerUp);
  renderer.domElement.addEventListener("webglcontextlost", contextLost);
  orbit.addEventListener("change", render);
  gizmo.addEventListener("change", render);
  gizmo.addEventListener("mouseUp", captureTransform);
  gizmo.addEventListener("dragging-changed", () => { orbit.enabled = !viewCameraId && !gizmo.dragging && !pathMode; });
  resize();

  function shotSetup(): () => void {
    gizmoHelper.visible = false;
    grid.visible = false;
    pathLine.visible = false;
    for (const { item, mesh } of members.values()) if (item.kind === "camera") mesh.visible = false;
    return () => {
      grid.visible = true;
      pathLine.visible = pathMode;
      for (const { mesh } of members.values()) mesh.visible = true;
      gizmoHelper.visible = Boolean(gizmo.object);
      render();
    };
  }

  function shotSize(aspect: DirectorScene["aspect"], longEdge: number) {
    const [w, h] = aspect.split(":").map(Number) as [number, number];
    return w >= h ? [longEdge, Math.round(longEdge * h / w)] as const :
      [Math.round(longEdge * w / h), longEdge] as const;
  }

  return {
    update(next: DirectorScene, references: ReadonlyMap<string, string | null>) {
      current = next;
      if (!panorama) scene.background = new THREE.Color(next.background);
      const wanted = new Set(next.objects.map(item => item.id));
      for (const [id, { mesh }] of members) if (!wanted.has(id)) {
        objects.remove(mesh);
        disposeObject(mesh);
        members.delete(id);
      }
      for (const item of next.objects) {
        const prior = members.get(item.id);
        const imageUrl = item.kind === "image_board" && item.imageKey ? references.get(item.imageKey) ?? null : null;
        if (!prior || prior.imageUrl !== imageUrl || prior.item.color !== item.color || prior.item.kind !== item.kind || prior.item.modelId !== item.modelId) {
          if (prior) { objects.remove(prior.mesh); disposeObject(prior.mesh); }
          const graphics = makeObject(item);
          const { mesh, board } = graphics;
          mesh.userData["directorId"] = item.id;
          const member = { ...graphics, item, imageUrl, ready: item.kind !== "model" && !imageUrl };
          members.set(item.id, member);
          objects.add(mesh);
          if (item.kind === "model" && item.modelId) {
            void loadDirectorModel(item.modelId).then(model => {
              if (disposed || members.get(item.id)?.mesh !== mesh) { disposeObject(model); return; }
              mesh.add(model);
              member.ready = true;
              render();
            }).catch(() => {
              if (!disposed && members.get(item.id)?.mesh === mesh) callbacks.modelFailed(item.name);
            });
          }
          if (board && imageUrl) {
            void new THREE.TextureLoader().loadAsync(imageUrl).then(texture => {
              if (disposed || members.get(item.id) !== member) { texture.dispose(); return; }
              texture.colorSpace = THREE.SRGBColorSpace;
              board.material.map = texture;
              board.material.color.set("#ffffff");
              board.material.needsUpdate = true;
              const height = Math.min(1.6, 1.6 * texture.image.height / texture.image.width);
              const width = height * texture.image.width / texture.image.height;
              board.scale.set(width, height, 1);
              board.position.y = height / 2;
              member.ready = true;
              render();
            }).catch(() => {
              if (!disposed && members.get(item.id) === member) callbacks.modelFailed(item.name);
            });
          }
        } else {
          prior.item = item;
        }
      }
      setTime(time);
    },
    select(id: string | null) { selectedId = id; refreshGizmo(); },
    setMode(next: DirectorTransformMode, snap: boolean) {
      mode = next;
      gizmo.setMode(mode);
      gizmo.setTranslationSnap(snap ? 0.25 : null);
      gizmo.setRotationSnap(snap ? Math.PI / 12 : null);
      gizmo.setScaleSnap(snap ? 0.25 : null);
      render();
    },
    view(id: string | null) { viewCameraId = id; refreshGizmo(); },
    reset(view: "default" | "top" | "front") {
      orbit.target.set(0, 0.75, 0);
      camera.position.set(...(view === "top" ? [0, 10, 0.001] : view === "front" ? [0, 1.6, 8] : [4.4, 3.6, 6.6]) as [number, number, number]);
      orbit.update();
      render();
    },
    cameraPose(): Pick<DirectorTransform, "position" | "rotation"> {
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
      return { position: camera.position.toArray(), rotation: [e.x, e.y, e.z].map(THREE.MathUtils.radToDeg) as DirectorTransform["rotation"] };
    },
    panorama(src: string | null) {
      const request = ++panoramaRequest;
      panorama?.dispose();
      panorama = null;
      scene.background = new THREE.Color(current?.background ?? "#303136");
      floor.visible = true;
      render();
      if (!src) return;
      new THREE.TextureLoader().load(src, texture => {
        if (disposed || request !== panoramaRequest) { texture.dispose(); return; }
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        panorama = texture;
        scene.background = texture;
        floor.visible = false;
        render();
      }, undefined, () => { if (!disposed && request === panoramaRequest) callbacks.panoramaFailed(); });
    },
    setTime,
    beginPath() {
      pathMode = true;
      pathPoints = [];
      pathLine.geometry.dispose();
      pathLine.geometry = new THREE.BufferGeometry();
      pathLine.visible = true;
      refreshGizmo();
    },
    endPath() {
      pathMode = false;
      pathLine.visible = false;
      refreshGizmo();
      return pathPoints;
    },
    capture(aspect: DirectorScene["aspect"], count: 1 | 4 | 12): readonly HTMLCanvasElement[] {
      if ([...members.values()].some(member => !member.ready)) throw new Error("还有场景素材未载入，请检查后再导出。");
      const [width, height] = shotSize(aspect, count === 1 ? 1280 : 1024);
      const restore = shotSetup();
      const ratio = renderer.getPixelRatio();
      try {
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        const shot = (viewCameraId ? cameraFor(viewCameraId, width / height) : null)?.clone() ?? camera.clone();
        shot.aspect = width / height;
        shot.updateProjectionMatrix();
        return Array.from({ length: count }, (_, index) => {
          if (count > 1) {
            const angle = index * Math.PI * 2 / count;
            const distance = Math.max(2, camera.position.distanceTo(orbit.target));
            shot.position.copy(orbit.target).add(new THREE.Vector3(Math.sin(angle) * distance, distance * 0.25, Math.cos(angle) * distance));
            shot.lookAt(orbit.target);
          }
          renderer.render(scene, shot);
          const copy = document.createElement("canvas");
          copy.width = width;
          copy.height = height;
          const ctx = copy.getContext("2d");
          if (!ctx) throw new Error("无法创建截图画布。");
          ctx.drawImage(renderer.domElement, 0, 0);
          return copy;
        });
      } finally {
        renderer.setPixelRatio(ratio);
        renderer.setSize(size.width, size.height);
        restore();
      }
    },
    async record(aspect: DirectorScene["aspect"], duration: number, signal: AbortSignal): Promise<Blob> {
      if ([...members.values()].some(member => !member.ready)) throw new Error("还有场景素材未载入，请检查后再导出。");
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8"].find(value => MediaRecorder.isTypeSupported(value));
      if (!mimeType) throw new Error("当前 WebView 不支持本地视频录制。");
      const [width, height] = shotSize(aspect, 1280);
      const output = document.createElement("canvas");
      output.width = width;
      output.height = height;
      const ctx = output.getContext("2d");
      if (!ctx) throw new Error("无法创建视频画布。");
      const stream = output.captureStream(24);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
      const chunks: Blob[] = [];
      const done = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
        recorder.onerror = () => reject(new Error("录制场景动画失败。"));
      });
      void done.catch(() => {});
      const ratio = renderer.getPixelRatio();
      const previousTime = time;
      const restore = shotSetup();
      try {
        recording = true;
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        const shot = camera.clone();
        shot.aspect = width / height;
        shot.updateProjectionMatrix();
        recorder.start();
        const started = performance.now();
        for (let frame = 0; frame <= Math.ceil(duration * 24) + 1; frame++) {
          signal.throwIfAborted();
          if (disposed) throw new Error("导演台已关闭。");
          const at = Math.min(duration, frame / 24);
          if (current) for (const { item, mesh, pose } of members.values()) {
            applyTransform(mesh, transformAt(current, item, at));
            if (pose) pose(directorPoseAt(current, item, at));
          }
          renderer.render(scene, (viewCameraId ? cameraFor(viewCameraId, width / height) : null) ?? shot);
          ctx.drawImage(renderer.domElement, 0, 0);
          await new Promise<void>(resolve => window.setTimeout(resolve, Math.max(0, started + (frame + 1) * 1000 / 24 - performance.now())));
        }
        recorder.stop();
        return await done;
      } finally {
        recording = false;
        if (recorder.state !== "inactive") recorder.stop();
        stream.getTracks().forEach(track => track.stop());
        if (!disposed) {
          renderer.setPixelRatio(ratio);
          renderer.setSize(size.width, size.height);
          restore();
          setTime(previousTime);
        }
      }
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointermove", drawPath);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      orbit.dispose();
      gizmo.dispose();
      scene.remove(gizmoHelper);
      disposeObject(scene);
      panorama?.dispose();
      keyLight.shadow.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

export type DirectorViewport = ReturnType<typeof createDirectorViewport>;
