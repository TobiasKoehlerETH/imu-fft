import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Tare tuning: adjust these values if the reset view needs a different angle.
const FRONT_CAMERA_POSITION = new THREE.Vector3(0, 0.6, 2.0);
const FRONT_CAMERA_TARGET = new THREE.Vector3(0, 0, 0);
const TARED_FRONT_ROTATION_DEGREES = new THREE.Vector3(0, 0, 0);

export type ModelSnapshot = {
  ax: number;
  ay: number;
  az: number;
  tiltX: number;
  tiltY: number;
  roll: number;
  pitch: number;
  yaw: number;
};

export class ModelView {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly controls: OrbitControls;
  private readonly modelRoot = new THREE.Group();
  private readonly resizeObserver: ResizeObserver;
  private readonly frontQuaternion = quaternionFromDegrees(TARED_FRONT_ROTATION_DEGREES);
  private readonly latestOrientation = new THREE.Quaternion();
  private readonly tareOffset = new THREE.Quaternion();
  private frames = 0;
  private rateStart = performance.now();
  private latestRate = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly onRate: (rate: number) => void,
  ) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xffffff, 1);
    this.host.appendChild(this.renderer.domElement);

    this.camera.position.copy(FRONT_CAMERA_POSITION);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.7;
    this.controls.maxDistance = 4;
    this.controls.target.copy(FRONT_CAMERA_TARGET);
    this.controls.saveState();

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(1.5, 2.0, 2.5);
    this.scene.add(key);
    this.scene.add(this.modelRoot);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.loadModel();
    this.animate();
  }

  applySnapshot(snapshot: ModelSnapshot): void {
    this.latestOrientation.copy(quaternionFromDegrees(
      new THREE.Vector3(snapshot.roll, snapshot.pitch, snapshot.yaw),
    ));
    this.applyModelOrientation();
  }

  tare(): void {
    this.controls.reset();
    this.tareOffset.copy(this.frontQuaternion).multiply(this.latestOrientation.clone().invert());
    this.applyModelOrientation();
  }

  private loadModel(): void {
    new GLTFLoader().load(
      "/Buffer_threads.glb",
      (gltf) => {
        this.modelRoot.clear();
        const object = gltf.scene;
        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        const scale = 1.2 / size;
        object.scale.setScalar(scale);
        object.position.copy(center).multiplyScalar(-scale);
        this.modelRoot.add(object);
      },
      undefined,
      () => this.addFallback(),
    );
  }

  private addFallback(): void {
    this.modelRoot.clear();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.18, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.55 }),
    );
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 1.1, 32),
      new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.6 }),
    );
    shaft.rotation.z = Math.PI / 2;
    this.modelRoot.add(body, shaft);
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(width, height, true);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frames += 1;
    const now = performance.now();
    if (now - this.rateStart >= 1000) {
      this.latestRate = (this.frames * 1000) / (now - this.rateStart);
      this.frames = 0;
      this.rateStart = now;
      this.onRate(this.latestRate);
    }
  };

  private applyModelOrientation(): void {
    this.modelRoot.quaternion.copy(this.tareOffset).multiply(this.latestOrientation);
  }
}

function quaternionFromDegrees(rotation: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(rotation.x),
    THREE.MathUtils.degToRad(rotation.y),
    THREE.MathUtils.degToRad(rotation.z),
    "ZYX",
  ));
}
