import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

console.log("MODULE script.js running ✅");

// ====================== DOM ======================
const canvas = document.getElementById("c");

const modeText = document.getElementById("modeText");
const stageText = document.getElementById("stageText");
const goalText = document.getElementById("goalText");
const scoreEl = document.getElementById("score");
const hpText = document.getElementById("hpText");
const hpBarFill = document.getElementById("hpBarFill");

const btnSound = document.getElementById("btnSound");
const btnRestart = document.getElementById("btnRestart");
const btnToHub = document.getElementById("btnToHub");

const hubOverlay = document.getElementById("hubOverlay");
const loadHint = document.getElementById("loadHint");
const btnEnterHub = document.getElementById("btnEnterHub");

const resultScreen = document.getElementById("resultScreen");
const resultBadge = document.getElementById("resultBadge");
const resultTitle = document.getElementById("resultTitle");
const resultSub = document.getElementById("resultSub");
const btnNextStage = document.getElementById("btnNextStage");
const btnRetry = document.getElementById("btnRetry");
const btnBackToHub = document.getElementById("btnBackToHub");

const toast = document.getElementById("toast");

// ====================== Utils ======================
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
function showToast(text, ms = 900) {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), ms);
}

// ====================== Sound (WebAudio) ======================
let soundOn = true;
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx)
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}
function beep({ freq = 440, dur = 0.06, type = "sine", vol = 0.06 }) {
  if (!soundOn) return;
  ensureAudio();
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;

  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(t0);
  osc.stop(t0 + dur);
}
function shotSound() {
  beep({ freq: 820, dur: 0.05, type: "square", vol: 0.05 });
  beep({ freq: 540, dur: 0.06, type: "sine", vol: 0.035 });
}
function hitSound() {
  beep({ freq: 220, dur: 0.09, type: "sawtooth", vol: 0.06 });
}
function sparkleSound() {
  beep({ freq: 1200, dur: 0.05, type: "triangle", vol: 0.05 });
  beep({ freq: 900, dur: 0.06, type: "sine", vol: 0.03 });
}
function uiSound() {
  beep({ freq: 740, dur: 0.05, type: "triangle", vol: 0.04 });
}

btnSound.addEventListener("click", () => {
  soundOn = !soundOn;
  btnSound.textContent = `SOUND: ${soundOn ? "ON" : "OFF"}`;
  if (soundOn) ensureAudio();
  uiSound();
});

// ====================== Three.js Base ======================
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b1020, 10, 80);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  5000
);
camera.position.set(0, 2.3, 10);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

scene.add(new THREE.AmbientLight(0xffffff, 1.1));
const dl = new THREE.DirectionalLight(0xffffff, 1.4);
dl.position.set(3, 7, 5);
scene.add(dl);

const hubGroup = new THREE.Group();
const gameGroup = new THREE.Group();
scene.add(hubGroup);
scene.add(gameGroup);

// ====================== Stage / Difficulty ======================
const MODE = { HUB: "HUB", GAME: "GAME", RESULT: "RESULT" };
let mode = MODE.HUB;

let selectedStage = 1;
let stageLevel = 1;
let goalScore = 50;
let D = null;

function computeDifficulty(stage, level) {
  const base = stage === 999 ? 1 + (level - 1) * 0.18 : stage * 0.28;

  const spawnInterval = clamp(760 - base * 220, 320, 760);
  const enemySpeedMin = 0.07 + base * 0.02;
  const enemySpeedVar = 0.06 + base * 0.02;
  const damage = Math.round(clamp(12 + base * 6, 12, 28));
  const goal = stage === 999 ? 999999 : Math.round(50 + (stage - 1) * 60);
  const scorePerKill = Math.round(10 + base * 3);

  return {
    spawnInterval,
    enemySpeedMin,
    enemySpeedVar,
    damage,
    goal,
    scorePerKill,
  };
}
function applyStage(stage) {
  selectedStage = stage;
  stageLevel = stage === 999 ? 1 : stage;
  D = computeDifficulty(selectedStage, stageLevel);
  goalScore = D.goal;
  setHUD();
}
function setHUD() {
  modeText.textContent = mode;
  stageText.textContent = String(stageLevel);
  goalText.textContent = String(goalScore);
  scoreEl.textContent = String(score);
  hpText.textContent = String(hp);
  hpBarFill.style.width = `${clamp(hp, 0, 100)}%`;
}

// ====================== Player GLB + Animation ======================
let playerRoot = null;
let mixer = null;
let idleAction = null;
let walkAction = null;
let activeAction = null;

/* ===== ここが「どこに入れるか」問題の答え =====
   MODEL_YAW_OFFSET をやめて、
   HUB用オフセット と ステージ固定向きを分ける
   ※どっちも Math.PI が基本（あなたのモデルは0だと逆向きになったので）
*/
const HUB_YAW_OFFSET = 0; // HUBで進行方向に向かせるための補正
const GAME_YAW_FIXED = Math.PI; // ステージで固定して向かせたい方向（回転しない）
const TURN_LERP = 0.18; // HUB回転のなめらかさ
/* ===== ここまで ===== */

function pickAction(actions, keywords) {
  const lower = actions.map((a) => (a?.getClip?.()?.name || "").toLowerCase());
  for (const key of keywords) {
    const idx = lower.findIndex((n) => n.includes(key));
    if (idx >= 0) return actions[idx];
  }
  return null;
}
function setAction(next) {
  if (!next || activeAction === next) return;
  next.reset().play();
  if (activeAction) next.crossFadeFrom(activeAction, 0.15, true);
  activeAction = next;
}

async function loadPlayerGLB() {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      "./assets/player.glb",
      (gltf) => {
        const g = gltf.scene;

        g.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(g);
        if (box.isEmpty()) return reject(new Error("Empty GLB geometry"));

        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);

        g.position.sub(center);

        const maxSize = Math.max(size.x, size.y, size.z) || 1;
        const targetSize = 2.8;
        g.scale.setScalar(targetSize / maxSize);

        g.traverse((o) => {
          if (!o.isMesh) return;
          o.visible = true;
          o.frustumCulled = false;
          if (o.material) {
            o.material.side = THREE.DoubleSide;
            o.material.needsUpdate = true;
          }
        });

        mixer = null;
        idleAction = null;
        walkAction = null;
        activeAction = null;

        if (gltf.animations && gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(g);
          const actions = gltf.animations.map((clip) => mixer.clipAction(clip));
          walkAction = pickAction(actions, ["walk", "run", "move"]);
          idleAction = pickAction(actions, ["idle", "rest", "stand"]);
          if (!idleAction) idleAction = actions[0] || null;

          if (idleAction) {
            idleAction.play();
            activeAction = idleAction;
          }
        }

        resolve(g);
      },
      undefined,
      (err) => reject(err)
    );
  });
}

// ====================== HUB Map ======================
const playerColliderR = 0.65;

const hubFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(120, 120),
  new THREE.MeshStandardMaterial({
    color: 0x1a1f3a,
    roughness: 1,
    metalness: 0,
  })
);
hubFloor.rotation.x = -Math.PI / 2;
hubFloor.position.y = 0;
hubGroup.add(hubFloor);

const hubGrid = new THREE.GridHelper(120, 30, 0xff76b9, 0x61ffd6);
hubGrid.position.y = 0.01;
hubGrid.material.opacity = 0.18;
hubGrid.material.transparent = true;
hubGroup.add(hubGrid);

function addDecoration() {
  for (let i = 0; i < 18; i++) {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.24, 1.3, 10),
      new THREE.MeshStandardMaterial({ color: 0x6b4f3a, roughness: 1 })
    );
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 18, 14),
      new THREE.MeshStandardMaterial({
        color: 0x61ffd6,
        emissive: 0x61ffd6,
        emissiveIntensity: 0.05,
      })
    );
    const x = Math.random() * 100 - 50;
    const z = Math.random() * 100 - 50;
    if (Math.abs(x) < 12 && Math.abs(z) < 12) continue;
    trunk.position.set(x, 0.65, z);
    leaf.position.set(x, 1.55, z);
    hubGroup.add(trunk, leaf);
  }

  for (let i = 0; i < 10; i++) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 2.2, 10),
      new THREE.MeshStandardMaterial({ color: 0x8aa0ff, roughness: 0.8 })
    );
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 16, 12),
      new THREE.MeshStandardMaterial({
        color: 0xffe07a,
        emissive: 0xffe07a,
        emissiveIntensity: 0.55,
      })
    );
    const x = Math.random() * 80 - 40;
    const z = Math.random() * 80 - 40;
    pole.position.set(x, 1.1, z);
    bulb.position.set(x, 2.35, z);
    hubGroup.add(pole, bulb);
  }
}
addDecoration();

function makePortal(color, emissive, shape = "ring") {
  let geom;
  if (shape === "ring") geom = new THREE.TorusGeometry(1.2, 0.18, 18, 44);
  else geom = new THREE.CylinderGeometry(1.1, 1.1, 0.3, 24);

  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: 0.45,
    roughness: 0.35,
    metalness: 0.1,
  });
  return new THREE.Mesh(geom, mat);
}

const stageMarkers = [
  {
    id: 1,
    name: "Stage 1",
    pos: new THREE.Vector3(-18, 0.9, -12),
    color: 0x61ffd6,
    shape: "ring",
  },
  {
    id: 2,
    name: "Stage 2",
    pos: new THREE.Vector3(18, 0.9, -12),
    color: 0xffe07a,
    shape: "ring",
  },
  {
    id: 3,
    name: "Stage 3",
    pos: new THREE.Vector3(0, 0.9, -26),
    color: 0xff76b9,
    shape: "ring",
  },
  {
    id: 999,
    name: "Endless",
    pos: new THREE.Vector3(0, 0.9, 22),
    color: 0x9b7bff,
    shape: "disk",
  },
];

for (const m of stageMarkers) {
  const portal = makePortal(
    m.color,
    m.color,
    m.shape === "ring" ? "ring" : "disk"
  );
  portal.position.copy(m.pos);
  portal.rotation.x = Math.PI / 2;
  m.mesh = portal;

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.7, 0.22, 26),
    new THREE.MeshStandardMaterial({ color: 0x101a3a, roughness: 1 })
  );
  base.position.set(m.pos.x, 0.11, m.pos.z);

  hubGroup.add(base, portal);
}

let nearMarker = null;

// ====================== GAME Objects ======================
const gameFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(90, 140),
  new THREE.MeshStandardMaterial({
    color: 0x1a1f3a,
    roughness: 1,
    metalness: 0,
  })
);
gameFloor.rotation.x = -Math.PI / 2;
gameFloor.position.y = 0;
gameGroup.add(gameFloor);

const gameGrid = new THREE.GridHelper(90, 22, 0xff76b9, 0x61ffd6);
gameGrid.position.y = 0.01;
gameGrid.material.opacity = 0.25;
gameGrid.material.transparent = true;
gameGroup.add(gameGrid);

const bullets = [];
const enemies = [];
const particles = [];

let lastShotMs = 0;
let lastEnemySpawnMs = 0;

function clearGameObjects() {
  for (const b of bullets) gameGroup.remove(b.mesh);
  bullets.length = 0;
  for (const e of enemies) gameGroup.remove(e.mesh);
  enemies.length = 0;
  for (const p of particles) gameGroup.remove(p.mesh);
  particles.length = 0;
}

// ===== Cute enemies =====
function makeHeartShape2D() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.25);
  shape.bezierCurveTo(0, 0.55, -0.45, 0.55, -0.45, 0.2);
  shape.bezierCurveTo(-0.45, -0.1, -0.15, -0.25, 0, -0.45);
  shape.bezierCurveTo(0.15, -0.25, 0.45, -0.1, 0.45, 0.2);
  shape.bezierCurveTo(0.45, 0.55, 0, 0.55, 0, 0.25);
  return shape;
}
function makeStarShape2D() {
  const shape = new THREE.Shape();
  const spikes = 5;
  const outerR = 0.55;
  const innerR = 0.25;
  let rot = (Math.PI / 2) * 3;
  const step = Math.PI / spikes;

  shape.moveTo(0, outerR);
  for (let i = 0; i < spikes; i++) {
    shape.lineTo(Math.cos(rot) * outerR, Math.sin(rot) * outerR);
    rot += step;
    shape.lineTo(Math.cos(rot) * innerR, Math.sin(rot) * innerR);
    rot += step;
  }
  shape.closePath();
  return shape;
}
function makeEnemyMesh(type) {
  if (type === "heart") {
    const geom = new THREE.ExtrudeGeometry(makeHeartShape2D(), {
      depth: 0.35,
      bevelEnabled: true,
      bevelThickness: 0.06,
      bevelSize: 0.06,
      bevelSegments: 2,
    });
    geom.center();
    return new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color: 0xff76b9,
        emissive: 0xff76b9,
        emissiveIntensity: 0.18,
        roughness: 0.45,
      })
    );
  }
  if (type === "star") {
    const geom = new THREE.ExtrudeGeometry(makeStarShape2D(), {
      depth: 0.28,
      bevelEnabled: true,
      bevelThickness: 0.06,
      bevelSize: 0.06,
      bevelSegments: 2,
    });
    geom.center();
    return new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color: 0xffe07a,
        emissive: 0xffe07a,
        emissiveIntensity: 0.15,
        roughness: 0.5,
      })
    );
  }
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 20, 16),
    new THREE.MeshStandardMaterial({
      color: 0x9b7bff,
      emissive: 0x9b7bff,
      emissiveIntensity: 0.12,
      roughness: 0.65,
    })
  );
}
function spawnEnemy() {
  const types = ["heart", "star", "squishy"];
  const type = types[Math.floor(Math.random() * types.length)];
  const mesh = makeEnemyMesh(type);
  mesh.position.set((Math.random() * 12 - 6) * 0.9, 0.8, -22);

  const baseR = type === "squishy" ? 0.65 : 0.55;
  enemies.push({
    mesh,
    type,
    r: baseR,
    vz: D.enemySpeedMin + Math.random() * D.enemySpeedVar,
    rot: (Math.random() * 2 - 1) * 0.03,
    wobble: Math.random() * 10,
  });
  gameGroup.add(mesh);
}

// ===== Sparkles =====
function spawnSparkles(pos, color = 0xffffff) {
  sparkleSound();
  for (let i = 0; i < 14; i++) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 10, 10),
      new THREE.MeshBasicMaterial({ color })
    );
    mesh.position.copy(pos);
    const v = new THREE.Vector3(
      (Math.random() * 2 - 1) * 0.18,
      Math.random() * 0.22 + 0.05,
      (Math.random() * 2 - 1) * 0.18
    );
    particles.push({ mesh, v, life: 38 + Math.floor(Math.random() * 20) });
    gameGroup.add(mesh);
  }
}
function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.mesh.position.add(p.v);
    p.v.multiplyScalar(0.96);
    p.v.y -= 0.003;
    p.life -= 1;
    if (p.life <= 0) {
      gameGroup.remove(p.mesh);
      particles.splice(i, 1);
    }
  }
}

// ===== Bullets =====
function spawnBullet() {
  const now = performance.now();
  const cooldown = 120;
  if (now - lastShotMs < cooldown) return;
  lastShotMs = now;

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 14, 14),
    new THREE.MeshStandardMaterial({
      color: 0x61ffd6,
      emissive: 0x61ffd6,
      emissiveIntensity: 0.75,
      roughness: 0.35,
    })
  );
  const p = playerRoot.position;
  mesh.position.set(p.x, 1.05, p.z - 0.6);

  bullets.push({ mesh, r: 0.18, vz: -0.55 });
  gameGroup.add(mesh);
  shotSound();
}
function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.mesh.position.z += b.vz;
    if (b.mesh.position.z < -60) {
      gameGroup.remove(b.mesh);
      bullets.splice(i, 1);
    }
  }
}

// ====================== Input ======================
const keys = {
  left: false,
  right: false,
  forward: false,
  back: false,
  slow: false,
  shoot: false,
  interact: false,
};

window.addEventListener("keydown", (e) => {
  const k = e.key;
  if (k === "a" || k === "A" || k === "ArrowLeft") keys.left = true;
  if (k === "d" || k === "D" || k === "ArrowRight") keys.right = true;
  if (k === "w" || k === "W" || k === "ArrowUp") keys.forward = true;
  if (k === "s" || k === "S" || k === "ArrowDown") keys.back = true;

  if (k === "Shift") keys.slow = true;
  if (k === " " || e.code === "Space") keys.shoot = true;
  if (k === "e" || k === "E") keys.interact = true;

  if (k === " " || k === "ArrowUp" || k === "ArrowDown") e.preventDefault();
});

window.addEventListener("keyup", (e) => {
  const k = e.key;
  if (k === "a" || k === "A" || k === "ArrowLeft") keys.left = false;
  if (k === "d" || k === "D" || k === "ArrowRight") keys.right = false;
  if (k === "w" || k === "W" || k === "ArrowUp") keys.forward = false;
  if (k === "s" || k === "S" || k === "ArrowDown") keys.back = false;

  if (k === "Shift") keys.slow = false;
  if (k === " " || e.code === "Space") keys.shoot = false;
  if (k === "e" || k === "E") keys.interact = false;
});

// ====================== Game State ======================
let score = 0;
let hp = 100;

function enterHub() {
  mode = MODE.HUB;
  modeText.textContent = mode;

  resultScreen.style.display = "none";
  hubOverlay.style.display = "none";
  btnRestart.style.display = "none";

  hubGroup.visible = true;
  gameGroup.visible = false;

  if (playerRoot) {
    playerRoot.position.set(0, 0.2, 6);
    // ★HUBではこの向きを基準に回転させる
    playerRoot.rotation.set(0, HUB_YAW_OFFSET, 0);
  }

  showToast("HUB：ステージの場所へ歩いて行って、Eで決定✨", 1400);
}

function startStage(stageId) {
  ensureAudio();
  uiSound();

  applyStage(stageId);

  mode = MODE.GAME;
  modeText.textContent = mode;

  score = 0;
  hp = 100;
  lastShotMs = 0;
  lastEnemySpawnMs = 0;
  clearGameObjects();
  setHUD();

  hubGroup.visible = false;
  gameGroup.visible = true;

  playerRoot.position.set(0, 0.2, 6.5);
  // ★ステージでは固定向き（移動入力では回転しない）
  playerRoot.rotation.set(0, GAME_YAW_FIXED, 0);

  btnRestart.style.display = "inline-block";
  resultScreen.style.display = "none";

  showToast(`Stage ${stageLevel} START!`, 900);
}

function showResult({ clear }) {
  mode = MODE.RESULT;
  modeText.textContent = mode;

  resultScreen.style.display = "grid";
  btnRestart.style.display = "none";

  if (clear) {
    resultBadge.textContent = "✨ CLEAR";
    resultTitle.textContent = "STAGE CLEAR!";
    resultSub.textContent =
      selectedStage === 999
        ? `Level ${stageLevel} 達成！ 次は Level ${stageLevel + 1} に挑戦する？`
        : `Stage ${stageLevel} クリア！ 次のステージへ行こう！`;
    btnNextStage.style.display = "inline-block";
  } else {
    resultBadge.textContent = "💤 GAME OVER";
    resultTitle.textContent = "GAME OVER…";
    resultSub.textContent = "RETRYでやり直すか、HUBに戻ろう";
    btnNextStage.style.display =
      selectedStage === 999 ? "inline-block" : "none";
  }
}

btnRestart.addEventListener("click", () => {
  if (!playerRoot) return;
  if (mode !== MODE.GAME) return;

  ensureAudio();
  uiSound();

  score = 0;
  hp = 100;
  lastShotMs = 0;
  lastEnemySpawnMs = 0;
  clearGameObjects();
  setHUD();

  playerRoot.position.set(0, 0.2, 6.5);
  // ★リスタート時も固定向き
  playerRoot.rotation.set(0, GAME_YAW_FIXED, 0);

  showToast("RESTART!", 700);
});

btnToHub.addEventListener("click", () => {
  if (!playerRoot) return;
  ensureAudio();
  uiSound();
  enterHub();
});

btnRetry.addEventListener("click", () => {
  if (!playerRoot) return;
  ensureAudio();
  uiSound();
  resultScreen.style.display = "none";
  startStage(selectedStage);
});

btnBackToHub.addEventListener("click", () => {
  if (!playerRoot) return;
  ensureAudio();
  uiSound();
  enterHub();
});

btnNextStage.addEventListener("click", () => {
  if (!playerRoot) return;
  ensureAudio();
  uiSound();

  if (selectedStage === 999) {
    stageLevel += 1;
    D = computeDifficulty(999, stageLevel);
    goalScore = D.goal;
    setHUD();
    resultScreen.style.display = "none";
    startStage(999);
    return;
  }

  if (stageLevel >= 3) {
    enterHub();
    return;
  }
  startStage(stageLevel + 1);
});

// ====================== Movement + Camera Follow ======================
const camOffset = new THREE.Vector3(0, 2.4, 7.8);
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();

function updatePlayer(dt) {
  if (!playerRoot) return;

  const base = keys.slow ? 0.007 : 0.012;
  const step = base * dt;

  let dx = 0;
  let dz = 0;

  if (keys.left) dx -= step;
  if (keys.right) dx += step;
  if (keys.forward) dz -= step;
  if (keys.back) dz += step;

  const limX = mode === MODE.HUB ? 55 : 7.5;
  const limZmin = mode === MODE.HUB ? -55 : -2.0;
  const limZmax = mode === MODE.HUB ? 55 : 10.0;

  playerRoot.position.x = clamp(playerRoot.position.x + dx, -limX, limX);
  playerRoot.position.z = clamp(playerRoot.position.z + dz, limZmin, limZmax);

  const t = performance.now() * 0.002;
  playerRoot.position.y = 0.2 + Math.sin(t) * 0.05;

  const targetTilt = clamp(dx * 2.8, -0.25, 0.25);
  playerRoot.rotation.z = THREE.MathUtils.lerp(
    playerRoot.rotation.z,
    -targetTilt,
    0.15
  );

  const moving = Math.abs(dx) + Math.abs(dz) > 0.00001;

  // ✅ 要件：HUBでは回転、ステージでは回転しない
  if (mode === MODE.HUB && moving) {
    const yaw = Math.atan2(dx, dz) + HUB_YAW_OFFSET;
    const current = playerRoot.rotation.y;
    const target = yaw;
    const delta =
      THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) -
      Math.PI;
    playerRoot.rotation.y = current + delta * TURN_LERP;
  }

  if (mixer) {
    if (moving && walkAction) setAction(walkAction);
    else if (!moving && idleAction) setAction(idleAction);
  }

  if (mode === MODE.GAME && keys.shoot) spawnBullet();
}

function updateCamera() {
  if (!playerRoot) return;

  const desired = camPos.copy(playerRoot.position).add(camOffset);
  camera.position.lerp(desired, 0.08);

  camLook.copy(playerRoot.position).add(new THREE.Vector3(0, 1.2, 0));
  camera.lookAt(camLook);
}

// ====================== HUB Interaction ======================
function updateHubInteraction(now) {
  nearMarker = null;
  let bestD2 = Infinity;

  for (const m of stageMarkers) {
    m.mesh.rotation.z += 0.015;

    const d = dist2(playerRoot.position, m.pos);
    if (d < bestD2) {
      bestD2 = d;
      nearMarker = m;
    }
  }

  if (!nearMarker) return;

  const interactR = 3.2;
  if (bestD2 < interactR * interactR) {
    showToast(`${nearMarker.name}：Eで入る`, 250);

    if (keys.interact) {
      keys.interact = false;
      startStage(nearMarker.id);
    }
  }
}

// ====================== GAME Update ======================
function updateEnemies(now) {
  if (!D) return;

  if (now - lastEnemySpawnMs > D.spawnInterval) {
    lastEnemySpawnMs = now;
    spawnEnemy();
  }

  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];

    e.mesh.position.z += e.vz;
    e.mesh.rotation.y += e.rot;

    if (e.type === "squishy") {
      const s = 1 + Math.sin(now * 0.01 + e.wobble) * 0.12;
      e.mesh.scale.set(1.0 + (s - 1) * 0.6, s, 1.0 + (s - 1) * 0.6);
    }

    const d = dist2(playerRoot.position, e.mesh.position);
    if (d < (playerColliderR + e.r) * (playerColliderR + e.r)) {
      gameGroup.remove(e.mesh);
      enemies.splice(i, 1);

      hp -= D.damage;
      setHUD();
      hitSound();
      spawnSparkles(
        playerRoot.position.clone().add(new THREE.Vector3(0, 1.0, 0)),
        0xff76b9
      );

      if (hp <= 0) {
        showResult({ clear: false });
      }
      continue;
    }

    if (e.mesh.position.z > 26) {
      gameGroup.remove(e.mesh);
      enemies.splice(i, 1);
    }
  }
}

function bulletHits() {
  if (!D) return;

  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    for (let j = bullets.length - 1; j >= 0; j--) {
      const b = bullets[j];
      const d = dist2(e.mesh.position, b.mesh.position);

      if (d < (e.r + b.r) * (e.r + b.r)) {
        const pos = e.mesh.position.clone();
        gameGroup.remove(e.mesh);
        enemies.splice(i, 1);

        gameGroup.remove(b.mesh);
        bullets.splice(j, 1);

        score += D.scorePerKill;
        setHUD();

        const col =
          e.type === "heart"
            ? 0xff76b9
            : e.type === "star"
            ? 0xffe07a
            : 0x9b7bff;
        spawnSparkles(pos, col);

        if (selectedStage !== 999 && score >= goalScore) {
          showResult({ clear: true });
        }
        break;
      }
    }
  }

  if (selectedStage === 999) {
    const nextLevel = 1 + Math.floor(score / 100);
    if (nextLevel > stageLevel) {
      stageLevel = nextLevel;
      D = computeDifficulty(999, stageLevel);
      goalScore = D.goal;
      setHUD();
      sparkleSound();
      showToast(`Endless Level UP → ${stageLevel}!`, 900);
    }
  }
}

// ====================== Boot ======================
let glbReady = false;

btnRestart.style.display = "none";
btnToHub.style.display = "inline-block";
resultScreen.style.display = "none";
gameGroup.visible = false;
hubGroup.visible = true;

mode = MODE.HUB;
applyStage(1);
score = 0;
hp = 100;
setHUD();

(async () => {
  try {
    loadHint.textContent = "player.glb を読み込み中…";
    btnEnterHub.textContent = "LOADING…";
    btnEnterHub.disabled = true;

    const g = await loadPlayerGLB();
    playerRoot = g;
    scene.add(playerRoot);

    playerRoot.position.set(0, 0.2, 6);
    // ★最初はHUB基準向き
    playerRoot.rotation.set(0, HUB_YAW_OFFSET, 0);

    glbReady = true;
    loadHint.textContent = "準備OK  SATRTボタンでHUBへ！";
    btnEnterHub.textContent = "START";
    btnEnterHub.disabled = false;
  } catch (e) {
    console.error(e);
    loadHint.textContent =
      "player.glb が読み込めません（assets/player.glb を確認）";
    btnEnterHub.textContent = "ERROR";
  }
})();

btnEnterHub.addEventListener("click", () => {
  if (!glbReady) return;
  ensureAudio();
  uiSound();
  hubOverlay.style.display = "none";
  enterHub();
});

// ====================== Loop ======================
let last = performance.now();

function loop(now) {
  requestAnimationFrame(loop);
  const dt = now - last;
  last = now;

  if (playerRoot) {
    updatePlayer(dt);
    updateCamera();
  }

  if (mode === MODE.HUB && playerRoot) {
    updateHubInteraction(now);
  }

  if (mode === MODE.GAME && playerRoot) {
    updateBullets();
    updateEnemies(now);
    bulletHits();
    updateParticles();
  }

  if (mixer) mixer.update(dt / 1000);

  renderer.render(scene, camera);
}
requestAnimationFrame(loop);

// ====================== Resize ======================
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
