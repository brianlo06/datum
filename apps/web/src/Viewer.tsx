import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

/**
 * Renders the compiled STL.
 *
 * The build already returns a server-rendered PNG, but a static image cannot
 * answer "does this actually fit my thing" -- people need to turn the part over.
 * The camera is only reset when the geometry's size changes materially, so
 * nudging a parameter does not throw away the view you were inspecting from.
 */
export function Viewer({ url, className }: { url: string | null; className?: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    mesh: THREE.Mesh | null;
    lastSpan: number;
    frame: number;
  } | null>(null);

  // Scene setup, once.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 5000);
    camera.position.set(90, -120, 80);
    camera.up.set(0, 0, 1); // Z-up, as CAD expects

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(1, -1.4, 1.6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1.2, 0.8, -0.4);
    scene.add(fill);

    const grid = new THREE.GridHelper(400, 40, 0x4b5a55, 0x2b3733);
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    scene.add(grid);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const state = { renderer, scene, camera, controls, mesh: null as THREE.Mesh | null, lastSpan: 0, frame: 0 };
    stateRef.current = state;

    const tick = () => {
      state.frame = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(state.frame);
      observer.disconnect();
      controls.dispose();
      state.mesh?.geometry.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      stateRef.current = null;
    };
  }, []);

  // Load geometry whenever the build changes.
  useEffect(() => {
    const state = stateRef.current;
    if (!state || !url) return;
    let cancelled = false;

    (async () => {
      const res = await fetch(url);
      if (!res.ok) return;
      const buffer = await res.arrayBuffer();
      if (cancelled || !stateRef.current) return;

      const geometry = new STLLoader().parse(buffer);
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const bb = geometry.boundingBox!;
      const centre = new THREE.Vector3();
      bb.getCenter(centre);
      // Centre in X/Y but keep the part sitting on the grid, as it would print.
      geometry.translate(-centre.x, -centre.y, -bb.min.z);

      if (state.mesh) {
        state.scene.remove(state.mesh);
        state.mesh.geometry.dispose();
      }

      const material = new THREE.MeshStandardMaterial({
        color: 0x4a8f7e,
        roughness: 0.55,
        metalness: 0.08,
        flatShading: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      state.scene.add(mesh);
      state.mesh = mesh;

      const size = new THREE.Vector3();
      bb.getSize(size);
      const span = Math.max(size.x, size.y, size.z);

      // Only re-frame when the part's scale has changed noticeably.
      if (state.lastSpan === 0 || Math.abs(span - state.lastSpan) / Math.max(span, 1) > 0.25) {
        const d = span * 2.1 + 20;
        state.camera.position.set(d * 0.6, -d * 0.75, d * 0.55);
        state.controls.target.set(0, 0, size.z / 2);
        state.controls.update();
      }
      state.lastSpan = span;
    })().catch(() => {
      /* a failed load leaves the previous geometry on screen */
    });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return <div ref={mountRef} className={className} />;
}
