// Three.js viewer for the segmentation meshes: rotate/zoom, show/hide, click to select, preset views.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { describe } from "./anatomy.js";

// Mesh positions are RAS millimetres (x = patient right, y = anterior, z = superior).
// Display frame: x = patient's left (viewer's right when facing them), y = up, z = toward the viewer.
const RAS_TO_DISPLAY = new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

// Camera directions for the preset views, in the display frame.
const VIEWS = {
  front: new THREE.Vector3(0, 0, 1),
  // From the patient's left, the way a lateral X-ray is usually shown (face to the left).
  side: new THREE.Vector3(1, 0, 0),
  // From above. The small -z tilt keeps OrbitControls' "up" well-defined and puts the face at the top.
  top: new THREE.Vector3(0, 1, -0.001).normalize(),
};

const HIGHLIGHT = new THREE.Color(0x3a8fd6);
const CLICK_SLOP_PX = 5;
const VIEW_ANIMATION_MS = 450;
const OCCLUSION_CHECK_MS = 150;
const OCCLUSION_SAMPLES = 12;

export class Viewer {
  /** @param onSelect called with the selected label value, or null when the selection clears. */
  constructor(container, { onSelect = () => {} } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.structures = new Map(); // label -> {mesh, info, anchor}
    this.selected = null;
    this.animation = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x101418);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.scene.add(this.camera);

    // Soft ambient fill plus a light that moves with the camera, so the side
    // facing the viewer is always lit while rotating.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404850, 1.2));
    const headlight = new THREE.DirectionalLight(0xffffff, 2.2);
    headlight.position.set(0.3, 0.6, 1);
    this.camera.add(headlight);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener("start", () => (this.animation = null));

    this.raycaster = new THREE.Raycaster();
    this._setUpPicking();
    this._createTag();

    this.model = null;
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
    this.renderer.setAnimationLoop((time) => this._frame(time));
  }

  // --- Model ----------------------------------------------------------------------

  setModel({ meshes }) {
    this._clearModel();

    const model = new THREE.Group();
    model.matrixAutoUpdate = false;
    model.matrix.copy(RAS_TO_DISPLAY);

    for (const m of meshes) {
      const info = describe(m.name);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();

      const transparent = info.opacity !== undefined;
      const material = new THREE.MeshStandardMaterial({
        color: info.color,
        roughness: 0.65,
        metalness: 0,
        transparent,
        opacity: info.opacity ?? 1,
        depthWrite: !transparent,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = m.name;
      mesh.userData.label = m.label;
      mesh.renderOrder = transparent ? 1 : 0;
      model.add(mesh);

      const anchor = geometry.boundingBox.getCenter(new THREE.Vector3());
      this.structures.set(m.label, { mesh, info, anchor });
    }

    // Centre the model at the origin.
    const pivot = new THREE.Group();
    pivot.add(model);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    pivot.position.copy(box.getCenter(new THREE.Vector3()).negate());
    this.scene.add(pivot);
    this.model = pivot;
    this.size = box.getSize(new THREE.Vector3());

    this.setView("front", { animate: false });
  }

  /** [{label, info, visible}] for every structure in the model. */
  listStructures() {
    return [...this.structures].map(([label, s]) => ({ label, info: s.info, visible: s.mesh.visible }));
  }

  setVisible(label, visible) {
    const s = this.structures.get(label);
    if (!s) return;
    s.mesh.visible = visible;
    this._occlusionPose = null;
    if (!visible && this.selected === label) this.select(null);
  }

  // --- Selection ---------------------------------------------------------------------

  select(label) {
    if (label !== null && !this.structures.get(label)?.mesh.visible) label = null;
    if (label === this.selected) return;

    if (this.selected !== null) {
      this.structures.get(this.selected)?.mesh.material.emissive.setHex(0x000000);
    }
    this.selected = label;

    if (label === null) {
      this.tag.hidden = true;
    } else {
      const { mesh, info } = this.structures.get(label);
      mesh.material.emissive.copy(HIGHLIGHT);
      mesh.material.emissiveIntensity = 0.6;
      this.tagCode.textContent = info.tag;
      this.tagDetail.textContent = info.detail ?? "";
      this.tagDetail.hidden = !info.detail;
      this.tag.classList.toggle("tag-vertebra", info.isVertebra);
      this._occlusionPose = null;
      this.tag.hidden = false;
    }
    this.onSelect(label);
  }

  /** Label of the structure under a viewport pixel, preferring solid structures over see-through ones. */
  pickAt(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const visible = [...this.structures.values()].map((s) => s.mesh).filter((m) => m.visible);
    const hits = this.raycaster.intersectObjects(visible, false);
    const hit = hits.find((h) => !h.object.material.transparent) ?? hits[0];
    return hit ? hit.object.userData.label : null;
  }

  /** Screen position (client px) of a structure's centre; used by tests to click on it. */
  screenPositionOf(label) {
    const s = this.structures.get(label);
    if (!s) return null;
    const p = s.anchor.clone().applyMatrix4(s.mesh.matrixWorld).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  _setUpPicking() {
    const canvas = this.renderer.domElement;
    let down = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointerup", (e) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved <= CLICK_SLOP_PX) this.select(this.pickAt(e.clientX, e.clientY));
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.select(null);
    });
  }

  _createTag() {
    this.tag = document.createElement("div");
    this.tag.className = "tag";
    this.tag.hidden = true;
    this.tag.setAttribute("role", "status");
    this.tag.innerHTML = '<span class="tag-dot"></span><span class="tag-box"><span class="tag-code"></span><span class="tag-detail"></span></span>';
    this.tagCode = this.tag.querySelector(".tag-code");
    this.tagDetail = this.tag.querySelector(".tag-detail");
    this.container.appendChild(this.tag);
  }

  _positionTag(now) {
    if (this.selected === null) return;
    const s = this.structures.get(this.selected);
    const world = s.anchor.clone().applyMatrix4(s.mesh.matrixWorld);
    // Re-check occlusion when the camera has moved (or the selection/visibility changed).
    const pose = this.camera.matrixWorld.elements.join();
    if (pose !== this._occlusionPose && now - (this._lastOcclusionCheck ?? 0) > OCCLUSION_CHECK_MS) {
      this._occlusionPose = pose;
      this._lastOcclusionCheck = now;
      this.tag.classList.toggle("tag-behind", this._isBehindSomething(s.mesh));
    }
    const p = world.project(this.camera);
    const offscreen = p.z > 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05;
    this.tag.style.visibility = offscreen ? "hidden" : "visible";
    const { clientWidth: w, clientHeight: h } = this.container;
    this.tag.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px)`;
  }

  /**
   * True when no part of the selected structure can be seen past solid structures.
   * Casts rays at a handful of points spread over its surface and stops at the first
   * one that reaches it, so the usual (visible) case costs a single ray.
   */
  _isBehindSomething(selectedMesh) {
    const targets = [...this.structures.values()]
      .map((s) => s.mesh)
      .filter((m) => m.visible && (m === selectedMesh || !m.material.transparent));
    const positions = selectedMesh.geometry.attributes.position;
    const point = new THREE.Vector3();
    for (let k = 0; k < OCCLUSION_SAMPLES; k++) {
      const i = Math.floor(((k + 0.5) / OCCLUSION_SAMPLES) * positions.count);
      point.fromBufferAttribute(positions, i).applyMatrix4(selectedMesh.matrixWorld);
      this.raycaster.set(this.camera.position, point.sub(this.camera.position).normalize());
      const first = this.raycaster.intersectObjects(targets, false)[0];
      if (first?.object === selectedMesh) return false;
    }
    return true;
  }

  // --- Camera ------------------------------------------------------------------------

  /**
   * Frame the visible structures from a preset direction ("front" | "side" | "top"),
   * or from the current direction when `name` is null (used after a quick filter).
   */
  setView(name, { animate = true } = {}) {
    // Drop any leftover rotation momentum from a recent drag, which would otherwise keep
    // nudging the camera off the preset direction. (A non-damped update applies and clears it.)
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;

    this.scene.updateMatrixWorld(true); // the model may have just been re-centred
    const box = new THREE.Box3();
    for (const { mesh } of this.structures.values()) if (mesh.visible) box.expandByObject(mesh);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 0.9;
    this.camera.near = distance / 100;
    this.camera.far = distance * 10;
    this.camera.updateProjectionMatrix();

    const direction = name ? VIEWS[name] : this.camera.position.clone().sub(this.controls.target).normalize();
    const toOffset = direction.clone().multiplyScalar(distance);
    if (!animate) {
      this.animation = null;
      this.controls.target.copy(center);
      this.camera.position.copy(center).add(toOffset);
      this.controls.update();
      return;
    }
    this.animation = {
      start: performance.now(),
      fromOffset: this.camera.position.clone().sub(this.controls.target),
      fromTarget: this.controls.target.clone(),
      toOffset,
      toTarget: center,
    };
  }

  _animate(now) {
    const a = this.animation;
    const t = Math.min((now - a.start) / VIEW_ANIMATION_MS, 1);
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    // Swing around the target (interpolate direction, then distance) rather than cut through the model.
    const offset = a.fromOffset.clone().lerp(a.toOffset, ease);
    if (offset.lengthSq() < 1e-6) offset.copy(a.toOffset); // opposite views: avoid a zero vector
    const fromLen = a.fromOffset.length();
    offset.setLength(fromLen + (a.toOffset.length() - fromLen) * ease);
    this.controls.target.copy(a.fromTarget).lerp(a.toTarget, ease);
    this.camera.position.copy(this.controls.target).add(offset);
    if (t === 1) this.animation = null;
  }

  // --- Internals ----------------------------------------------------------------------

  _frame(now) {
    if (this.animation) this._animate(now);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._positionTag(now);
  }

  _clearModel() {
    this.select(null);
    if (!this.model) return;
    this.model.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry.dispose();
        obj.material.dispose();
      }
    });
    this.scene.remove(this.model);
    this.model = null;
    this.structures.clear();
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
