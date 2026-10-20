// Basic Three.js viewer for the segmentation meshes.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Mesh positions are RAS millimetres (x = patient right, y = anterior, z = superior).
// Display frame: x = patient's left (viewer's right when facing them), y = up, z = toward the viewer.
const RAS_TO_DISPLAY = new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

const BONE = 0xe9dfc9;

/** Default look per structure. Bones and the spinal cord are solid; soft tissue is see-through. */
function styleFor(name) {
  if (/^(vertebrae_|skull|rib_|sternum|clavicula|scapula|humerus|hip|sacrum|femur)/.test(name)) return { color: BONE };
  if (name === "costal_cartilages") return { color: 0xc9d6df };
  if (name === "spinal_cord") return { color: 0xf2c14e };
  if (/artery|aorta|brachiocephalic_trunk/.test(name)) return { color: 0xd0453a, opacity: 0.55 };
  if (/vein|vena_cava/.test(name)) return { color: 0x4a7fc9, opacity: 0.55 };
  if (/autochthon|iliopsoas|gluteus/.test(name)) return { color: 0xb0645a, opacity: 0.22 };
  if (/lung/.test(name)) return { color: 0xe8a0a8, opacity: 0.1 };
  return { color: 0xc49a6c, opacity: 0.3 };
}

export class Viewer {
  constructor(container) {
    this.container = container;

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

    this.model = null;

    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  setModel({ meshes }) {
    this._clearModel();

    const model = new THREE.Group();
    model.matrixAutoUpdate = false;
    model.matrix.copy(RAS_TO_DISPLAY);

    for (const m of meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
      geometry.computeVertexNormals();

      const style = styleFor(m.name);
      const transparent = style.opacity !== undefined;
      const material = new THREE.MeshStandardMaterial({
        color: style.color,
        roughness: 0.65,
        metalness: 0,
        transparent,
        opacity: style.opacity ?? 1,
        depthWrite: !transparent,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = m.name;
      mesh.userData.label = m.label;
      mesh.renderOrder = transparent ? 1 : 0;
      model.add(mesh);
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

    this.viewFront();
  }

  /** Face the patient from the front, framing the whole model. */
  viewFront() {
    const radius = this.size.length() / 2;
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.set(0, 0, distance * 0.9);
    this.camera.near = distance / 100;
    this.camera.far = distance * 10;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  _clearModel() {
    if (!this.model) return;
    this.model.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry.dispose();
        obj.material.dispose();
      }
    });
    this.scene.remove(this.model);
    this.model = null;
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
