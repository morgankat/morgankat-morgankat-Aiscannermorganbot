import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/* ═══════════════════════════════════════════════════════════
   MEGAN — REAL 3D ROBOT WITH SKELETON & ANIMATION
   ═══════════════════════════════════════════════════════════ */

let scene, camera, renderer, composer, controls;
let megan; // The robot group
let clock = new THREE.Clock();
let mouse = new THREE.Vector2();
let targetPos = new THREE.Vector3(0, 0, 0);
let currentState = 'idle';
let isWalking = false;
let walkTime = 0;
let soundOn = true;
let micOn = false;
let recognition = null;
let captionTimer = null;
// FIX (new feature — mood color, approach-on-reply, action commands): her
// resting spot, so approachCamera()/returnHome() below can always find their
// way back to wherever she actually starts, not a hardcoded guess.
let homePos = new THREE.Vector3(0, 0, 0);
let actionTimer = null;

// Robot parts (for animation)
const parts = {};

/* ── MATERIALS ── */
const matChrome = new THREE.MeshStandardMaterial({
  color: 0xc0c8d0,
  metalness: 0.95,
  roughness: 0.15,
  envMapIntensity: 1.5
});
const matDarkMetal = new THREE.MeshStandardMaterial({
  color: 0x1a2230,
  metalness: 0.9,
  roughness: 0.3
});
const matGold = new THREE.MeshStandardMaterial({
  color: 0xd4a520,
  metalness: 0.85,
  roughness: 0.2
});
const matCyanGlow = new THREE.MeshStandardMaterial({
  color: 0x00d4ff,
  emissive: 0x00d4ff,
  emissiveIntensity: 2.5,
  toneMapped: false
});
const matBlueGlow = new THREE.MeshStandardMaterial({
  color: 0x1a6fff,
  emissive: 0x1a6fff,
  emissiveIntensity: 1.5,
  toneMapped: false
});
const matEye = new THREE.MeshStandardMaterial({
  color: 0x00d4ff,
  emissive: 0x00d4ff,
  emissiveIntensity: 4,
  toneMapped: false
});
const matJoint = new THREE.MeshStandardMaterial({
  color: 0x0a1525,
  metalness: 0.8,
  roughness: 0.4
});
const matWire = new THREE.MeshBasicMaterial({
  color: 0x00d4ff,
  wireframe: true,
  transparent: true,
  opacity: 0.15
});

/* ── INIT ── */
function init() {
  // FIX (background robot not visible at all): this was looking for
  // 'canvas-container', an id that doesn't exist anywhere in index.html —
  // the actual element is #meganBodyContainer. getElementById returned
  // null, so container.appendChild() below threw immediately and the
  // entire module (scene/camera/lights/robot build/animation loop) never
  // ran — nothing after this line ever executed. That's why she wasn't
  // showing up: not a dimming/opacity issue, the 3D layer never started.
  const container = document.getElementById('meganBodyContainer');

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050a14);
  scene.fog = new THREE.FogExp2(0x050a14, 0.035);

  // Camera
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 2.5, 6);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  // Post-processing (Bloom)
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.6, 0.5, 0.85
  );
  composer.addPass(bloom);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 3;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI / 2 + 0.2;
  controls.target.set(0, 1.5, 0);

  // Lights
  const ambient = new THREE.AmbientLight(0x1a2a40, 0.8);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 2);
  keyLight.position.set(3, 6, 4);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.width = 2048;
  keyLight.shadow.mapSize.height = 2048;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x00d4ff, 0.6);
  fillLight.position.set(-3, 4, -2);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0x1a6fff, 1.2);
  rimLight.position.set(0, 3, -5);
  scene.add(rimLight);

  const underGlow = new THREE.PointLight(0x00d4ff, 1, 8);
  underGlow.position.set(0, 0.2, 0);
  scene.add(underGlow);

  // Floor
  const floorGeo = new THREE.PlaneGeometry(30, 30);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x080e18,
    metalness: 0.6,
    roughness: 0.25
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Grid
  const grid = new THREE.GridHelper(30, 60, 0x0d1830, 0x0a1220);
  grid.position.y = 0.01;
  scene.add(grid);

  // Hologram ring on floor
  const ringGeo = new THREE.RingGeometry(0.8, 1.0, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x00d4ff,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  scene.add(ring);
  parts.floorRing = ring;

  // Particles
  createParticles();

  // Build Megan
  buildMegan();
  homePos.copy(megan.position); // remember her real starting spot for returnHome()

  // Events
  window.addEventListener('resize', onResize);
  document.addEventListener('mousemove', onMouseMove);
  // FIX: click-to-walk removed — this app's screen is covered in real trading
  // buttons; raycasting every tap against the floor would fight with actually
  // using the app. She now wanders on her own instead (startAutoWander).

  // FIX (integration into TradePort EA): the standalone demo's own loading
  // overlay and intro speak() line don't apply here — this app has its own
  // connect/loading flow, and its own megan-brain.js already owns speech.
  animate();
  startAutoWander(); // she should always be visibly alive, not waiting for a click or voice command to move
}

/* ── BUILD MEGAN (SKELETAL ROBOT) ── */
function buildMegan() {
  megan = new THREE.Group();
  scene.add(megan);

  // ══ HIPS / PELVIS ══
  const hipsGeo = new THREE.CylinderGeometry(0.28, 0.22, 0.2, 16);
  const hips = new THREE.Mesh(hipsGeo, matDarkMetal);
  hips.position.y = 1.05;
  hips.castShadow = true;
  megan.add(hips);
  parts.hips = hips;

  // Hip glow strip
  const hipGlowGeo = new THREE.TorusGeometry(0.25, 0.02, 8, 32);
  const hipGlow = new THREE.Mesh(hipGlowGeo, matCyanGlow);
  hipGlow.rotation.x = Math.PI / 2;
  hipGlow.position.y = 1.05;
  megan.add(hipGlow);

  // ══ TORSO ══
  const torsoGroup = new THREE.Group();
  torsoGroup.position.y = 1.15;
  megan.add(torsoGroup);
  parts.torso = torsoGroup;

  // Main torso block
  const torsoGeo = new THREE.CylinderGeometry(0.32, 0.28, 0.7, 8);
  const torso = new THREE.Mesh(torsoGeo, matChrome);
  torso.position.y = 0.35;
  torso.castShadow = true;
  torsoGroup.add(torso);

  // Chest plate (gold accent like image)
  const chestGeo = new THREE.BoxGeometry(0.4, 0.25, 0.15);
  const chest = new THREE.Mesh(chestGeo, matGold);
  chest.position.set(0, 0.45, 0.18);
  chest.castShadow = true;
  torsoGroup.add(chest);

  // Chest label "SERIES X"
  // Core reactor (glowing)
  const coreGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.06, 16);
  const core = new THREE.Mesh(coreGeo, matCyanGlow);
  core.position.set(0, 0.45, 0.26);
  core.rotation.x = Math.PI / 2;
  torsoGroup.add(core);
  parts.core = core;

  // Side vents
  for(let side of [-1, 1]) {
    const ventGeo = new THREE.BoxGeometry(0.06, 0.3, 0.1);
    const vent = new THREE.Mesh(ventGeo, matDarkMetal);
    vent.position.set(side * 0.28, 0.35, 0.1);
    torsoGroup.add(vent);
  }

  // Ab section
  const abGeo = new THREE.CylinderGeometry(0.25, 0.28, 0.15, 8);
  const ab = new THREE.Mesh(abGeo, matDarkMetal);
  ab.position.y = 0.0;
  torsoGroup.add(ab);

  // ══ NECK ══
  const neckGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.15, 12);
  const neck = new THREE.Mesh(neckGeo, matJoint);
  neck.position.y = 0.78;
  torsoGroup.add(neck);

  // ══ HEAD GROUP (for rotation) ══
  const headGroup = new THREE.Group();
  headGroup.position.y = 0.9;
  torsoGroup.add(headGroup);
  parts.head = headGroup;

  // Head shape (helmet)
  const headGeo = new THREE.SphereGeometry(0.22, 24, 24);
  const head = new THREE.Mesh(headGeo, matChrome);
  head.scale.y = 1.15;
  head.castShadow = true;
  headGroup.add(head);

  // Face plate
  const faceGeo = new THREE.SphereGeometry(0.18, 24, 24, 0, Math.PI * 2, 0, Math.PI * 0.45);
  const face = new THREE.Mesh(faceGeo, matDarkMetal);
  face.position.z = 0.02;
  face.rotation.x = -Math.PI / 2;
  headGroup.add(face);

  // Eyes (glowing blue like image)
  const eyeGeo = new THREE.SphereGeometry(0.045, 16, 16);
  const leftEye = new THREE.Mesh(eyeGeo, matEye);
  leftEye.position.set(-0.08, 0.02, 0.18);
  headGroup.add(leftEye);
  const rightEye = new THREE.Mesh(eyeGeo, matEye);
  rightEye.position.set(0.08, 0.02, 0.18);
  headGroup.add(rightEye);
  parts.eyes = [leftEye, rightEye];

  // Eye lights (point lights for glow)
  const eyeLightL = new THREE.PointLight(0x00d4ff, 0.5, 1);
  eyeLightL.position.set(-0.08, 0.02, 0.22);
  headGroup.add(eyeLightL);
  const eyeLightR = new THREE.PointLight(0x00d4ff, 0.5, 1);
  eyeLightR.position.set(0.08, 0.02, 0.22);
  headGroup.add(eyeLightR);

  // Mouth (slit)
  const mouthGeo = new THREE.BoxGeometry(0.1, 0.015, 0.02);
  const mouth = new THREE.Mesh(mouthGeo, matCyanGlow);
  mouth.position.set(0, -0.08, 0.19);
  headGroup.add(mouth);
  parts.mouth = mouth;

  // Helmet crest (top ridge)
  const crestGeo = new THREE.BoxGeometry(0.06, 0.08, 0.3);
  const crest = new THREE.Mesh(crestGeo, matGold);
  crest.position.set(0, 0.22, 0);
  headGroup.add(crest);

  // Antenna
  const antStemGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.15, 8);
  const antStem = new THREE.Mesh(antStemGeo, matDarkMetal);
  antStem.position.set(0, 0.3, 0);
  headGroup.add(antStem);
  const antTipGeo = new THREE.SphereGeometry(0.025, 8, 8);
  const antTip = new THREE.Mesh(antTipGeo, matCyanGlow);
  antTip.position.set(0, 0.38, 0);
  headGroup.add(antTip);

  // ══ SHOULDERS ══
  for(let side of [-1, 1]) {
    const shoulderGeo = new THREE.SphereGeometry(0.14, 16, 16);
    const shoulder = new THREE.Mesh(shoulderGeo, matChrome);
    shoulder.position.set(side * 0.42, 0.6, 0);
    shoulder.castShadow = true;
    torsoGroup.add(shoulder);
  }

  // ══ ARMS ══
  parts.arms = { left: [], right: [] };

  function buildArm(side) {
    const dir = side === 'left' ? -1 : 1;
    const armGroup = new THREE.Group();
    armGroup.position.set(dir * 0.42, 0.55, 0);
    torsoGroup.add(armGroup);
    parts.arms[side].push(armGroup);

    // Upper arm
    const upperGeo = new THREE.CylinderGeometry(0.07, 0.06, 0.45, 12);
    const upper = new THREE.Mesh(upperGeo, matChrome);
    upper.position.y = -0.22;
    upper.castShadow = true;
    armGroup.add(upper);

    // Elbow joint
    const elbowGeo = new THREE.SphereGeometry(0.065, 12, 12);
    const elbow = new THREE.Mesh(elbowGeo, matJoint);
    elbow.position.y = -0.47;
    armGroup.add(elbow);

    // Forearm group (pivots at elbow)
    const forearmGroup = new THREE.Group();
    forearmGroup.position.y = -0.47;
    armGroup.add(forearmGroup);
    parts.arms[side].push(forearmGroup);

    // Forearm
    const foreGeo = new THREE.CylinderGeometry(0.055, 0.045, 0.4, 12);
    const fore = new THREE.Mesh(foreGeo, matChrome);
    fore.position.y = -0.2;
    fore.castShadow = true;
    forearmGroup.add(fore);

    // Wrist
    const wristGeo = new THREE.SphereGeometry(0.05, 10, 10);
    const wrist = new THREE.Mesh(wristGeo, matJoint);
    wrist.position.y = -0.42;
    forearmGroup.add(wrist);

    // Hand
    const handGeo = new THREE.BoxGeometry(0.08, 0.1, 0.06);
    const hand = new THREE.Mesh(handGeo, matDarkMetal);
    hand.position.y = -0.5;
    forearmGroup.add(hand);

    // Fingers
    for(let f = 0; f < 3; f++) {
      const fingerGeo = new THREE.BoxGeometry(0.015, 0.06, 0.015);
      const finger = new THREE.Mesh(fingerGeo, matChrome);
      finger.position.set((f - 1) * 0.025, -0.58, 0);
      forearmGroup.add(finger);
    }

    return armGroup;
  }

  parts.armL = buildArm('left');
  parts.armR = buildArm('right');

  // ══ LEGS ══
  parts.legs = { left: [], right: [] };

  function buildLeg(side) {
    const dir = side === 'left' ? -1 : 1;
    const legGroup = new THREE.Group();
    legGroup.position.set(dir * 0.18, 1.0, 0);
    megan.add(legGroup);
    parts.legs[side].push(legGroup);

    // Thigh
    const thighGeo = new THREE.CylinderGeometry(0.1, 0.08, 0.5, 12);
    const thigh = new THREE.Mesh(thighGeo, matChrome);
    thigh.position.y = -0.25;
    thigh.castShadow = true;
    legGroup.add(thigh);

    // Knee
    const kneeGeo = new THREE.SphereGeometry(0.085, 12, 12);
    const knee = new THREE.Mesh(kneeGeo, matJoint);
    knee.position.y = -0.52;
    legGroup.add(knee);

    // Shin group
    const shinGroup = new THREE.Group();
    shinGroup.position.y = -0.52;
    legGroup.add(shinGroup);
    parts.legs[side].push(shinGroup);

    // Shin
    const shinGeo = new THREE.CylinderGeometry(0.075, 0.06, 0.5, 12);
    const shin = new THREE.Mesh(shinGeo, matChrome);
    shin.position.y = -0.25;
    shin.castShadow = true;
    shinGroup.add(shin);

    // Ankle
    const ankleGeo = new THREE.SphereGeometry(0.055, 10, 10);
    const ankle = new THREE.Mesh(ankleGeo, matJoint);
    ankle.position.y = -0.52;
    shinGroup.add(ankle);

    // Foot
    const footGeo = new THREE.BoxGeometry(0.12, 0.06, 0.2);
    const foot = new THREE.Mesh(footGeo, matDarkMetal);
    foot.position.set(0, -0.58, 0.04);
    foot.castShadow = true;
    shinGroup.add(foot);

    return legGroup;
  }

  parts.legL = buildLeg('left');
  parts.legR = buildLeg('right');

  // ══ BACKPACK / POWER UNIT ══
  const packGeo = new THREE.BoxGeometry(0.3, 0.4, 0.15);
  const pack = new THREE.Mesh(packGeo, matDarkMetal);
  pack.position.set(0, 0.35, -0.22);
  torsoGroup.add(pack);

  // Pack vents (glowing)
  for(let i = 0; i < 3; i++) {
    const ventGeo = new THREE.BoxGeometry(0.2, 0.02, 0.02);
    const vent = new THREE.Mesh(ventGeo, matBlueGlow);
    vent.position.set(0, 0.25 + i * 0.08, -0.14);
    torsoGroup.add(vent);
  }

  // ══ WIRE FRAME OVERLAY ══
  const wireGroup = new THREE.Group();
  megan.traverse((child) => {
    if(child.isMesh) {
      const wire = new THREE.Mesh(child.geometry.clone(), matWire);
      wire.position.copy(child.position);
      wire.rotation.copy(child.rotation);
      wire.scale.copy(child.scale);
      // Need to match parent transforms - simpler to just add to same parent
      // Skip for now, add wireframe toggle instead
    }
  });

  // Store initial positions for animation
  parts.initial = {
    headY: headGroup.position.y,
    armLY: parts.armL.position.y,
    armRY: parts.armR.position.y,
    legLY: parts.legL.position.y,
    legRY: parts.legR.position.y,
  };
}

/* ── PARTICLES ── */
let particleSystem;
function createParticles() {
  const count = 300;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const velocities = [];

  for(let i = 0; i < count; i++) {
    positions[i*3] = (Math.random() - 0.5) * 15;
    positions[i*3+1] = Math.random() * 8;
    positions[i*3+2] = (Math.random() - 0.5) * 15;
    velocities.push({
      x: (Math.random() - 0.5) * 0.01,
      y: Math.random() * 0.01 + 0.005,
      z: (Math.random() - 0.5) * 0.01
    });
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const mat = new THREE.PointsMaterial({
    color: 0x00d4ff,
    size: 0.04,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending
  });

  particleSystem = new THREE.Points(geo, mat);
  particleSystem.userData.velocities = velocities;
  scene.add(particleSystem);
}

function updateParticles() {
  if(!particleSystem) return;
  const pos = particleSystem.geometry.attributes.position.array;
  const vels = particleSystem.userData.velocities;

  for(let i = 0; i < vels.length; i++) {
    pos[i*3] += vels[i].x;
    pos[i*3+1] += vels[i].y;
    pos[i*3+2] += vels[i].z;

    if(pos[i*3+1] > 8) {
      pos[i*3] = (Math.random() - 0.5) * 15;
      pos[i*3+1] = 0;
      pos[i*3+2] = (Math.random() - 0.5) * 15;
    }
  }
  particleSystem.geometry.attributes.position.needsUpdate = true;
}

/* ── ANIMATION ── */
let wireframeMode = false;

function animate() {
  requestAnimationFrame(animate);

  const dt = clock.getDelta();
  const time = clock.getElapsedTime();

  // Update controls
  controls.update();

  // Update particles
  updateParticles();

  // Floor ring rotation
  if(parts.floorRing) {
    parts.floorRing.rotation.z += dt * 0.5;
    parts.floorRing.material.opacity = 0.3 + Math.sin(time * 2) * 0.15;
  }

  // Core pulse
  if(parts.core) {
    const pulse = 1 + Math.sin(time * 3) * 0.3;
    parts.core.scale.setScalar(pulse);
    parts.core.material.emissiveIntensity = 2 + Math.sin(time * 3) * 1.5;
  }

  // Eye glow pulse
  if(parts.eyes) {
    parts.eyes.forEach(eye => {
      eye.material.emissiveIntensity = 3 + Math.sin(time * 4) * 1;
    });
  }

  // Head tracking (look at mouse)
  if(parts.head) {
    const targetYaw = -mouse.x * 0.6;
    const targetPitch = -mouse.y * 0.4;
    parts.head.rotation.y += (targetYaw - parts.head.rotation.y) * 0.08;
    parts.head.rotation.x += (targetPitch - parts.head.rotation.x) * 0.08;
  }

  // Torso breathing
  if(parts.torso) {
    const breathe = 1 + Math.sin(time * 1.5) * 0.008;
    parts.torso.scale.set(1, breathe, 1);
  }

  // Walk cycle
  if(isWalking) {
    walkTime += dt * 5;
    const walkSpeed = 1.5;

    // Leg swing
    if(parts.legL && parts.legR) {
      parts.legL.rotation.x = Math.sin(walkTime) * 0.5;
      parts.legR.rotation.x = Math.sin(walkTime + Math.PI) * 0.5;

      // Knee bend
      if(parts.legs.left[1]) {
        parts.legs.left[1].rotation.x = Math.max(0, Math.sin(walkTime + Math.PI/2)) * 0.6;
      }
      if(parts.legs.right[1]) {
        parts.legs.right[1].rotation.x = Math.max(0, Math.sin(walkTime + Math.PI * 1.5)) * 0.6;
      }
    }

    // Arm swing (opposite to legs)
    if(parts.armL && parts.armR) {
      parts.armL.rotation.x = Math.sin(walkTime + Math.PI) * 0.4;
      parts.armR.rotation.x = Math.sin(walkTime) * 0.4;

      // Elbow bend
      if(parts.arms.left[1]) {
        parts.arms.left[1].rotation.x = -Math.abs(Math.sin(walkTime)) * 0.3;
      }
      if(parts.arms.right[1]) {
        parts.arms.right[1].rotation.x = -Math.abs(Math.sin(walkTime + Math.PI)) * 0.3;
      }
    }

    // Body bob
    if(parts.hips) {
      parts.hips.position.y = 1.05 + Math.abs(Math.sin(walkTime * 2)) * 0.04;
    }
    if(parts.torso) {
      parts.torso.position.y = 0.35 + Math.abs(Math.sin(walkTime * 2)) * 0.04;
    }

    // Move toward target
    const dx = targetPos.x - megan.position.x;
    const dz = targetPos.z - megan.position.z;
    const dist = Math.sqrt(dx*dx + dz*dz);

    if(dist > 0.1) {
      const speed = 1.2 * dt;
      megan.position.x += (dx / dist) * speed;
      megan.position.z += (dz / dist) * speed;

      // Face direction of travel
      const targetRot = Math.atan2(dx, dz);
      let rotDiff = targetRot - megan.rotation.y;
      while(rotDiff > Math.PI) rotDiff -= Math.PI * 2;
      while(rotDiff < -Math.PI) rotDiff += Math.PI * 2;
      megan.rotation.y += rotDiff * 0.08;
    } else {
      isWalking = false;
      setState('idle');
      // Reset limbs
      resetLimbs();
    }
  } else {
    // Idle animation
    if(parts.armL) parts.armL.rotation.x += (0 - parts.armL.rotation.x) * 0.05;
    if(parts.armR) parts.armR.rotation.x += (0 - parts.armR.rotation.x) * 0.05;
    if(parts.legL) parts.legL.rotation.x += (0 - parts.legL.rotation.x) * 0.05;
    if(parts.legR) parts.legR.rotation.x += (0 - parts.legR.rotation.x) * 0.05;

    // Idle sway
    if(parts.hips) {
      parts.hips.position.y = 1.05 + Math.sin(time) * 0.015;
    }

    // Subtle arm idle
    if(parts.armL) parts.armL.rotation.z = 0.05 + Math.sin(time * 0.8) * 0.03;
    if(parts.armR) parts.armR.rotation.z = -0.05 - Math.sin(time * 0.8 + 1) * 0.03;
  }

  // Talking animation
  if(currentState === 'talking') {
    if(parts.armL) parts.armL.rotation.z = 0.3 + Math.sin(time * 8) * 0.15;
    if(parts.armR) parts.armR.rotation.z = -0.3 - Math.sin(time * 8 + 1) * 0.15;
    if(parts.head) parts.head.rotation.z = Math.sin(time * 6) * 0.05;
  }

  // Thinking animation
  if(currentState === 'thinking') {
    if(parts.armR) {
      parts.armR.rotation.x = -0.8;
      parts.armR.rotation.z = -0.2;
    }
    if(parts.arms.right[1]) {
      parts.arms.right[1].rotation.x = -1.2;
    }
    if(parts.head) parts.head.rotation.x = 0.3 + Math.sin(time) * 0.05;
  }

  // Listening animation
  if(currentState === 'listening') {
    if(parts.head) {
      parts.head.rotation.y += Math.sin(time * 3) * 0.005;
    }
    if(parts.torso) {
      parts.torso.rotation.y = Math.sin(time * 2) * 0.03;
    }
  }

  // Jump (new feature — a real up-and-down hop with a squash/stretch
  // landing, timed to match playAction('jump')'s 700ms window above)
  if(currentState === 'jumping') {
    const t = Math.min(1, walkTime / 0.5);
    walkTime += dt;
    const arc = Math.sin(Math.min(1, t) * Math.PI); // 0 -> 1 -> 0
    megan.position.y = arc * 0.9;
    if(parts.armL) parts.armL.rotation.x = -arc * 0.6;
    if(parts.armR) parts.armR.rotation.x = -arc * 0.6;
    if(parts.legL) parts.legL.rotation.x = arc * 0.3;
    if(parts.legR) parts.legR.rotation.x = arc * 0.3;
    if(parts.torso) parts.torso.scale.set(1 - arc * 0.08, 1 + arc * 0.12, 1 - arc * 0.08);
    if(t >= 1) megan.position.y = 0;
  } else if(megan.position.y !== 0 && currentState !== 'dancing') {
    megan.position.y += (0 - megan.position.y) * 0.2;
  }

  // Dance (new feature — playful bounce + spin + arm pump, no real dance
  // logic needed, just something clearly deliberate and fun on command)
  if(currentState === 'dancing') {
    megan.position.y = Math.abs(Math.sin(time * 6)) * 0.35;
    megan.rotation.y += dt * 2.4;
    if(parts.armL) parts.armL.rotation.z = 0.9 + Math.sin(time * 9) * 0.5;
    if(parts.armR) parts.armR.rotation.z = -0.9 - Math.sin(time * 9 + Math.PI) * 0.5;
    if(parts.legL) parts.legL.rotation.x = Math.sin(time * 9) * 0.4;
    if(parts.legR) parts.legR.rotation.x = Math.sin(time * 9 + Math.PI) * 0.4;
    if(parts.head) parts.head.rotation.z = Math.sin(time * 5) * 0.15;
  }

  // Wave (new feature — one raised arm greeting, on command)
  if(currentState === 'waving') {
    if(parts.armR) {
      parts.armR.rotation.x = -2.1;
      parts.armR.rotation.z = -0.4 + Math.sin(time * 10) * 0.35;
    }
    if(parts.arms.right[1]) parts.arms.right[1].rotation.x = -0.4;
    if(parts.head) parts.head.rotation.y = -0.2;
  }

  // Render
  composer.render();
}

function resetLimbs() {
  if(parts.arms.left[1]) parts.arms.left[1].rotation.x = 0;
  if(parts.arms.right[1]) parts.arms.right[1].rotation.x = 0;
  if(parts.legs.left[1]) parts.legs.left[1].rotation.x = 0;
  if(parts.legs.right[1]) parts.legs.right[1].rotation.x = 0;
}

/* ── STATE ── */
function setState(state) {
  if(currentState === state) return;
  currentState = state;
  // FIX: no HUD panel in this app (the demo's own #hud-dot/#hud-status
  // don't exist here) — state still fully drives her animation below,
  // it's just not also mirrored into a debug readout.
}

/* ── APPROACH / RETREAT (new feature) — "come closer to reply, then go
   back". Reuses the exact same walk-cycle animation as auto-wander/
   walkTo below (just a different target point), so this doesn't need its
   own movement code — she just walks to a spot nearer the camera, then
   walks back to where she actually started (homePos), same as any other
   walk. ── */
function approachCamera() {
  if(!camera) return;
  // A point on the line from her home spot toward the camera, stopping
  // well short of it so she's still fully in frame, just closer/bigger.
  const dir = new THREE.Vector3().subVectors(camera.position, homePos).normalize();
  const dist = homePos.distanceTo(camera.position) * 0.45;
  targetPos.set(homePos.x + dir.x * dist, 0, homePos.z + dir.z * dist);
  isWalking = true;
  setState('walking');
}
function returnHome() {
  targetPos.copy(homePos);
  isWalking = true;
  setState('walking');
}

/* ── ACTION COMMANDS (new feature) — "jump", "dance", etc. megan-brain.js
   calls window.MeganHologram.playAction(name) when it recognizes one of
   these in what you actually asked her to do. Each one is timed and always
   hands control back to idle/auto-wander on its own — nothing here can get
   her stuck in a pose. ── */
function playAction(name) {
  if(actionTimer){ clearTimeout(actionTimer); actionTimer = null; }
  if(name === 'jump') {
    isWalking = false;
    setState('jumping');
    walkTime = 0;
    actionTimer = setTimeout(() => { setState('idle'); resetLimbs(); }, 700);
  } else if(name === 'dance') {
    isWalking = false;
    setState('dancing');
    walkTime = 0;
    actionTimer = setTimeout(() => { setState('idle'); resetLimbs(); }, 3200);
  } else if(name === 'wave') {
    isWalking = false;
    setState('waving');
    actionTimer = setTimeout(() => { setState('idle'); resetLimbs(); }, 1800);
  }
}

/* ── INPUT ── */
function onMouseMove(e) {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
}

function onClick(e) {
  if(e.target.closest('.ctrl-panel') || e.target.closest('.speech-bubble') || e.target.closest('.hud')) return;

  // Raycast to floor
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(scene.children, true);

  for(let hit of intersects) {
    if(hit.object.geometry && hit.object.geometry.type === 'PlaneGeometry') {
      targetPos.set(hit.point.x, 0, hit.point.z);
      isWalking = true;
      setState('walking');
      return;
    }
  }
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

/* ── FIX (integration into TradePort EA) ──────────────────────────────────
   The standalone demo's own showCaption/speak/startListening/stopListening/
   handleVoice below all duplicated things this app's existing megan-brain.js
   already owns: captions, text-to-speech, and microphone/SpeechRecognition.
   Running both at once would mean two separate mic streams fighting for the
   same microphone and two separate speech-synthesis calls talking over each
   other. So this robot never listens or speaks on its own — it's a purely
   visual layer that reacts to state megan-brain.js is already tracking:
   setState('talking') while she's actually speaking (via the existing
   Megan.voice.speak below), back to 'idle' after — nothing here touches
   audio or the microphone directly.
   ────────────────────────────────────────────────────────────────────── */

/* ── AUTO-WANDER (she should always look alive, not wait for a command) ── */
let wanderTimer = null;
function startAutoWander() {
  if(wanderTimer) clearInterval(wanderTimer);
  wanderTimer = setInterval(() => {
    if(currentState === 'talking' || currentState === 'listening' || currentState === 'thinking' || currentState === 'jumping' || currentState === 'dancing' || currentState === 'waving' || isWalking) return; // don't wander mid-conversation, mid-action, or mid-approach/return walk
    if(Math.random() > 0.45) {
      targetPos.set((Math.random()-0.5)*3, 0, (Math.random()-0.5)*3); // small radius — she should stay visible, not wander off-frame on a phone screen
      isWalking = true; setState('walking');
    }
  }, 6000);
}

/* ── PUBLIC API ── */
window.MeganHologram = {
  setState,
  walkTo: (x, z) => { targetPos.set(x, 0, z); isWalking = true; setState('walking'); },
  getPos: () => ({ x: megan.position.x, z: megan.position.z }),
  getState: () => currentState,
  playAction,
  approachCamera,
  returnHome,
};

// Drive her "talking" animation from the app's ACTUAL speech, instead of
// generating a second, separate voice line of her own. Module scripts run
// AFTER the document (and any regular blocking <script>, like megan-brain.js)
// has already finished — so window.Megan very likely already exists by the
// time this line runs, meaning a plain event listener alone could miss a
// 'megan-ready' dispatch that already fired earlier. Wrap immediately if
// Megan's already there; otherwise fall back to the event for whichever
// script order actually happens to run.
function hookMeganSpeech(){
  if(window.Megan && window.Megan.voice && typeof window.Megan.voice.speak === 'function' && !window.Megan.voice.__meganBodyHooked){
    const originalSpeak = window.Megan.voice.speak;
    window.Megan.voice.speak = (text) => {
      setState('talking');
      approachCamera(); // FIX (new feature) — "come closer to reply, then go back"
      originalSpeak(text);
      const estMs = Math.max(2500, (text || '').length * 65);
      setTimeout(() => {
        if(currentState === 'talking') setState('idle');
        returnHome();
      }, estMs);
    };
    window.Megan.voice.__meganBodyHooked = true;
    return true;
  }
  return false;
}
if(!hookMeganSpeech()){
  window.addEventListener('megan-ready', hookMeganSpeech);
}

// Boot
init();
