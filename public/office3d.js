// 3D office: a Three.js scene of the Boss's office, team cubicles and the lounge.
// Uses globals from index.html: TEAM_COLOR, SPR, PALS, avatarLook, go, render, office3dFailed.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const WALL_H = 2.6, SEAT_W = 2.3, CUBE_D = 3.2, BOSS_W = 7, LOUNGE_W = 9.5, WALK = 2.2;
const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- helpers ----------
const BOX = new THREE.BoxGeometry(1, 1, 1);
const mats = new Map();
function M(color, o = {}) {
  const key = color + JSON.stringify(o);
  if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...o }));
  return mats.get(key);
}
// Box with its bottom at y. `m` is a colour, a material, or an array of six materials.
function box(parent, w, h, d, m, x, y, z) {
  const mesh = new THREE.Mesh(BOX, typeof m === 'string' ? M(m) : m);
  mesh.scale.set(w, h, d); mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}
function cyl(parent, rt, rb, h, color, x, y, z, seg = 16) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), typeof color === 'string' ? M(color) : color);
  mesh.position.set(x, y + h / 2, z); mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}
function canvasTex(w, h, draw, { repeat, smooth } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (!smooth) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestMipmapLinearFilter; }
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  t.anisotropy = 4;
  return t;
}
// Pixel sprite from the 2D office (SPR/PALS) as a texture, so 3D props match the pixel art.
function spriteTex(name, pal = {}, bg) {
  const rows = SPR[name], p = { ...PALS[name], ...pal };
  return canvasTex(rows[0].length, rows.length, (g, w, h) => {
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
    rows.forEach((row, y) => [...row].forEach((ch, x) => { const f = p[ch]; if (f && f[0] !== '.') { g.fillStyle = f; g.fillRect(x, y, 1, 1); } }));
  });
}
const texMat = (t, o = {}) => new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, ...o });
const faces = (side, front) => [side, side, side, side, front, side]; // +z is the front face
function plane(parent, w, d, m, x, z, y = 0.01) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), m);
  mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, y, z); mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}
function label(text, bg, fg = '#fff', w = 256) {
  return canvasTex(w, 64, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, 64);
    g.fillStyle = fg; g.font = '700 30px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text.toUpperCase(), w / 2, 34, w - 16);
  }, { smooth: true });
}
const mix = (a, b, t) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();

// ---------- props ----------
function plant(parent, x, z, s = 1) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(s); parent.add(g);
  cyl(g, 0.22, 0.17, 0.38, '#c8673a', 0, 0, 0);
  cyl(g, 0.2, 0.2, 0.03, '#4a3020', 0, 0.36, 0);
  const leaf = M('#4a8c50', { flatShading: true }), leaf2 = M('#6aa86e', { flatShading: true });
  [[0, 0.75, 0, 0.3, leaf], [0.16, 0.6, 0.08, 0.22, leaf2], [-0.15, 0.62, -0.05, 0.22, leaf2], [0.02, 0.98, 0.04, 0.2, leaf2]].forEach(([lx, ly, lz, r, m]) => {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), m); b.position.set(lx, ly, lz); b.castShadow = true; g.add(b);
  });
  return g;
}
function chair(parent, x, z, rot, seat = '#4a4258', back = '#6a6080', tall = false) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; parent.add(g);
  cyl(g, 0.25, 0.25, 0.04, '#2a2438', 0, 0.02, 0, 5);
  cyl(g, 0.03, 0.03, 0.36, '#3a3346', 0, 0.06, 0, 8);
  box(g, 0.52, 0.09, 0.5, seat, 0, 0.42, 0);
  box(g, 0.52, tall ? 0.85 : 0.55, 0.08, back, 0, 0.5, -0.24);
  return g;
}
function desk(parent, x, z, w, wood) {
  const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
  box(g, w, 0.07, 0.8, wood.top, 0, 0.7, 0);
  box(g, 0.07, 0.7, 0.74, wood.side, -w / 2 + 0.06, 0, 0);
  box(g, 0.07, 0.7, 0.74, wood.side, w / 2 - 0.06, 0, 0);
  box(g, w - 0.2, 0.45, 0.04, wood.side, 0, 0.22, 0.34); // modesty panel facing the camera
  return g;
}
function monitor(parent, x, z, faceX, faceZ) {
  const g = new THREE.Group(); g.position.set(x, 0.77, z); g.rotation.y = Math.atan2(faceX - x, faceZ - z); parent.add(g);
  box(g, 0.26, 0.025, 0.18, '#2a2438', 0, 0, 0);
  box(g, 0.05, 0.22, 0.05, '#3a3346', 0, 0.02, -0.03);
  const screen = new THREE.MeshStandardMaterial({ color: '#1c1a2a', emissive: '#000000', roughness: 0.4 });
  box(g, 0.66, 0.42, 0.05, faces(M('#2a2438'), screen), 0, 0.2, 0);
  return screen;
}
// Food: on stall counters, in hands, and on desks.
function food(kind) {
  const g = new THREE.Group();
  if (kind === 'burger') {
    cyl(g, 0.12, 0.11, 0.05, '#e8a64a', 0, 0, 0);
    cyl(g, 0.13, 0.13, 0.04, '#6e3a1e', 0, 0.05, 0);
    cyl(g, 0.135, 0.135, 0.015, '#6aa86e', 0, 0.09, 0);
    box(g, 0.2, 0.012, 0.2, '#f2c94c', 0, 0.1, 0);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), M('#e8a64a'));
    top.scale.y = 0.7; top.position.y = 0.11; top.castShadow = true; g.add(top);
  } else if (kind === 'pizza') {
    const slice = cyl(g, 0.2, 0.2, 0.03, '#f2c36b', 0, 0, 0, 3); slice.rotation.y = Math.PI / 6;
    cyl(g, 0.03, 0.03, 0.035, '#c0392b', 0.05, 0.002, 0.02, 10); cyl(g, 0.025, 0.025, 0.035, '#c0392b', -0.06, 0.002, -0.02, 10);
  } else if (kind === 'noodles') {
    cyl(g, 0.14, 0.08, 0.11, '#fffdf8', 0, 0, 0);
    cyl(g, 0.141, 0.141, 0.025, '#c0392b', 0, 0.07, 0);
    cyl(g, 0.12, 0.12, 0.02, '#f2d27a', 0, 0.095, 0);
    const a = box(g, 0.012, 0.012, 0.3, '#8a5a33', 0.03, 0.12, 0); a.rotation.x = -0.5;
    const b = box(g, 0.012, 0.012, 0.3, '#8a5a33', 0.06, 0.12, 0); b.rotation.x = -0.5;
  } else {
    cyl(g, 0.05, 0.05, 0.15, '#d0473c', 0, 0, 0, 12);
    cyl(g, 0.051, 0.051, 0.04, '#fffdf8', 0, 0.06, 0, 12);
  }
  return g;
}

// ---------- people ----------
function faceTex(look) {
  return canvasTex(8, 8, (g) => {
    const px = (c, x, y, w = 1, h = 1) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
    px(look.skin, 0, 0, 8, 8);
    px(look.style === 2 ? new THREE.Color(look.shirt).multiplyScalar(0.85).getStyle() : look.hair, 0, 0, 8, look.style === 2 ? 2 : 1);
    if (look.style !== 2) { px(look.hair, 0, 1, 2, 1); px(look.hair, 6, 1, 2, 1); }
    px('#1c1420', 2, 3, 1, 2); px('#1c1420', 5, 3, 1, 2);
    if (look.glasses) { g.strokeStyle = '#3b6ea5'; g.lineWidth = 1; g.strokeRect(1.5, 2.5, 2, 3); g.strokeRect(4.5, 2.5, 2, 3); }
    px(mix('#e0705a', '#ffffff', 0.35), 1, 5); px(mix('#e0705a', '#ffffff', 0.35), 6, 5);
    px('#9c4436', 3, 6, 2, 1);
  });
}
function person(id) {
  const look = avatarLook(id);
  const root = new THREE.Group();
  const skin = M(look.skin), shirt = M(look.shirt), pants = M('#2f3046'), hair = M(look.style === 2 ? mix(look.shirt, '#000', 0.15) : look.hair);
  const leg = (sx) => {
    const p = new THREE.Group(); p.position.set(sx, 0.62, 0); root.add(p);
    box(p, 0.17, 0.56, 0.2, pants, 0, -0.56, 0);
    box(p, 0.18, 0.08, 0.26, '#1c1420', 0, -0.62, 0.03);
    return p;
  };
  const arm = (sx) => {
    const p = new THREE.Group(); p.position.set(sx, 1.08, 0); root.add(p);
    box(p, 0.13, 0.4, 0.15, shirt, 0, -0.4, 0);
    box(p, 0.12, 0.1, 0.13, skin, 0, -0.5, 0);
    return p;
  };
  const legL = leg(-0.11), legR = leg(0.11), armL = arm(-0.31), armR = arm(0.31);
  box(root, 0.46, 0.5, 0.28, shirt, 0, 0.6, 0);
  box(root, 0.47, 0.06, 0.29, '#1c1420', 0, 0.6, 0); // belt
  box(root, 0.16, 0.06, 0.02, '#fffdf8', 0, 1.04, 0.14); // collar
  const head = new THREE.Group(); head.position.y = 1.1; root.add(head);
  box(head, 0.44, 0.42, 0.4, faces(skin, texMat(faceTex(look))), 0, 0, 0);
  box(head, 0.48, 0.12, 0.44, hair, 0, 0.38, -0.01);
  box(head, 0.48, look.style === 1 ? 0.55 : 0.3, 0.08, hair, 0, look.style === 1 ? -0.15 : 0.1, -0.22);
  box(head, 0.06, look.style === 1 ? 0.45 : 0.18, 0.4, hair, -0.24, look.style === 1 ? -0.05 : 0.22, -0.01);
  box(head, 0.06, look.style === 1 ? 0.45 : 0.18, 0.4, hair, 0.24, look.style === 1 ? -0.05 : 0.22, -0.01);
  if (look.style === 2) box(head, 0.46, 0.04, 0.18, hair, 0, 0.38, 0.28); // cap brim
  const hand = new THREE.Group(); hand.position.set(0, -0.55, 0.12); armR.add(hand);
  return { root, legL, legR, armL, armR, head, hand };
}
function pose(p, sitting, t, typing) {
  if (sitting) {
    p.root.position.y = -0.17;
    p.legL.rotation.x = p.legR.rotation.x = -Math.PI / 2;
    const k = typing && !reduced ? Math.sin(t * 18) * 0.12 : 0;
    p.armL.rotation.x = -1.0 + k; p.armR.rotation.x = -1.0 - k;
  } else {
    p.root.position.y = 0;
    const s = Math.sin(t * 9) * 0.6;
    p.legL.rotation.x = s; p.legR.rotation.x = -s;
    p.armL.rotation.x = -s * 0.8; p.armR.rotation.x = p.carry ? -0.9 : s * 0.8;
    p.root.position.y = Math.abs(Math.cos(t * 9)) * 0.04;
  }
}
function standStill(p) {
  p.root.position.y = 0;
  p.legL.rotation.x = p.legR.rotation.x = 0;
  p.armL.rotation.x = 0; p.armR.rotation.x = p.carry ? -0.9 : 0;
}

// ---------- scene ----------
const webgl = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
if (!webgl) { office3dFailed = true; render(); throw new Error('3D office needs WebGL2; using the pixel office'); }
const el = document.createElement('div'); el.className = 'o3view';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
el.appendChild(renderer.domElement);
const tagsEl = document.createElement('div'); tagsEl.className = 'o3tags'; el.appendChild(tagsEl);
el.insertAdjacentHTML('beforeend', '<div class="o3hint">drag to rotate · right-drag to pan · click someone to see their work</div><div class="o3ctl"><button data-z="in" title="Zoom in">+</button><button data-z="out" title="Zoom out">−</button><button data-z="reset" title="Reset view">⟲</button></div>');

const scene = new THREE.Scene();
scene.background = new THREE.Color('#2a2438');
const camera = new THREE.PerspectiveCamera(35, 2, 0.1, 400);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.enableZoom = false;
controls.minPolarAngle = 0.35; controls.maxPolarAngle = 1.25;
controls.minAzimuthAngle = -1.1; controls.maxAzimuthAngle = 1.1;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

scene.add(new THREE.HemisphereLight('#fff4e0', '#6e5a48', 1.4));
const sun = new THREE.DirectionalLight('#fff1d6', 2.2);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

let office = null, size = { w: 30, d: 12 }, people = new Map(), roster = '', fit = null, userMoved = false, lastData = null;

function build(data) {
  if (office) { scene.remove(office); office.traverse((o) => { if (o.geometry && o.geometry !== BOX) o.geometry.dispose(); }); }
  for (const p of people.values()) p.tag.remove();
  people = new Map();
  office = new THREE.Group(); scene.add(office);

  // Cubicle layout: rows of up to four teams.
  const order = Object.keys(TEAM_COLOR);
  const teams = [...new Set(data.agents.map((a) => a.team))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const perRow = teams.length > 9 ? 4 : 3, rows = [];
  teams.forEach((t, i) => (rows[Math.floor(i / perRow)] ??= []).push(t));
  const cubeW = (t) => data.agents.filter((a) => a.team === t).length * SEAT_W + 0.8;
  const rowW = rows.map((r) => r.reduce((s, t) => s + cubeW(t), 0) + (r.length - 1) * 1.1);
  const openW = Math.max(12, ...rowW.map((w) => w + 2.4));
  const D = Math.max(10, 1.2 + rows.length * (CUBE_D + 1.4) + 2.8);
  const X0 = BOSS_W, X1 = BOSS_W + openW, W = X1 + LOUNGE_W, laneZ = D - 1.3;
  size = { w: W, d: D, laneZ };

  // floors
  const tile = canvasTex(32, 32, (g) => { g.fillStyle = '#ecd3a8'; g.fillRect(0, 0, 32, 32); g.fillStyle = '#e1c495'; g.fillRect(0, 0, 16, 16); g.fillRect(16, 16, 16, 16); }, { repeat: [openW / 2, D / 2] });
  plane(office, openW, D, texMat(tile), X0 + openW / 2, D / 2, 0);
  plane(office, openW, 2.3, M('#fff6e6', { transparent: true, opacity: 0.35 }), X0 + openW / 2, laneZ, 0.012);
  const carpet = canvasTex(16, 16, (g) => { g.fillStyle = '#5a4670'; g.fillRect(0, 0, 16, 16); g.fillStyle = '#65507c'; g.fillRect(0, 0, 1, 1); g.fillRect(8, 8, 1, 1); }, { repeat: [BOSS_W, D] });
  plane(office, BOSS_W, D, texMat(carpet), BOSS_W / 2, D / 2, 0);
  const planks = canvasTex(64, 64, (g) => {
    g.fillStyle = '#c98f55'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#a8703f';
    for (let y = 0; y < 64; y += 16) { g.fillRect(0, y, 64, 1); g.fillRect(((y / 16) % 2) * 32 + 10, y, 1, 16); }
  }, { repeat: [LOUNGE_W / 2, D / 2] });
  plane(office, LOUNGE_W, D, texMat(planks), X1 + LOUNGE_W / 2, D / 2, 0);

  // walls: back wall with windows, outer side walls, a glass wall for the Boss and a solid one for the lounge
  const wallM = M('#f3e3c7'), trim = M('#8a5a33');
  box(office, W + 0.4, WALL_H, 0.2, wallM, W / 2, 0, -0.1);
  box(office, W + 0.4, 0.14, 0.24, trim, W / 2, 0, -0.08);
  box(office, 0.2, WALL_H, D, wallM, -0.1, 0, D / 2);
  box(office, 0.2, WALL_H, D, wallM, W + 0.1, 0, D / 2);
  const glass = new THREE.MeshStandardMaterial({ color: '#bfe3f5', transparent: true, opacity: 0.28, roughness: 0.1 });
  const door = 2.4;
  box(office, 0.06, WALL_H - 0.1, D - door, glass, X0, 0, (D - door) / 2).castShadow = false;
  box(office, 0.12, 0.1, D - door, trim, X0, WALL_H - 0.1, (D - door) / 2);
  box(office, 0.12, WALL_H, 0.12, trim, X0, 0, D - door);
  box(office, 0.2, WALL_H, D - door, wallM, X1, 0, (D - door) / 2);
  box(office, 0.24, 0.14, D - door, trim, X1, 0, (D - door) / 2);
  const win = (x) => {
    box(office, 2.2, 1.3, 0.08, trim, x, 0.95, 0.02);
    box(office, 2.0, 1.1, 0.02, M('#bfe6fb', { emissive: '#9ed3f0', emissiveIntensity: 0.6 }), x, 1.05, 0.07);
    box(office, 0.06, 1.1, 0.03, trim, x, 1.05, 0.08);
  };
  [X0 + openW * 0.2, X0 + openW * 0.8, BOSS_W * 0.7].forEach(win);
  const sign = box(office, 4.2, 0.55, 0.06, faces(M('#1c1420'), texMat(label("Agentic office", '#1c1420', '#ffe9b8', 512))), X0 + openW / 2, 1.85, 0.05);
  sign.castShadow = false;
  const wallClock = new THREE.Mesh(new THREE.CircleGeometry(0.3, 24), texMat(spriteTex('clock', {}, '#fffdf8')));
  wallClock.position.set(X0 + openW / 2 + 2.8, 2.1, 0.03); office.add(wallClock);
  const poster = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.75), texMat(spriteTex('poster')));
  poster.position.set(X0 + openW / 2 - 2.8, 1.3, 0.03); office.add(poster);

  // Boss's office
  const bx = BOSS_W / 2, bz = D * 0.42;
  plane(office, 3.8, 2.8, M('#b4332c'), bx, bz + 0.2, 0.012);
  plane(office, 3.4, 2.4, M('#a12d27'), bx, bz + 0.2, 0.014);
  box(office, 2.2, 2.0, 0.4, faces(M('#6e4526'), texMat(spriteTex('shelf'))), 1.6, 0, 0.25);
  box(office, 1.6, 0.03, 0.3, '#e8b03a', 1.6, 2.0, 0.25);
  plant(office, 0.6, D - 0.6, 1.3); plant(office, BOSS_W - 0.6, 0.6, 1.1);
  const sofa = new THREE.Group(); sofa.position.set(0.55, 0, D * 0.75); sofa.rotation.y = Math.PI / 2; office.add(sofa);
  box(sofa, 1.9, 0.4, 0.8, '#6e4526', 0, 0, 0); box(sofa, 1.9, 0.5, 0.2, '#7a4a2a', 0, 0.4, -0.3); box(sofa, 0.2, 0.3, 0.8, '#7a4a2a', -0.95, 0.4, 0); box(sofa, 0.2, 0.3, 0.8, '#7a4a2a', 0.95, 0.4, 0);
  chair(office, bx - 0.55, bz + 1.35, Math.PI, '#4a4258', '#6a6080'); chair(office, bx + 0.55, bz + 1.35, Math.PI, '#4a4258', '#6a6080');

  // lounge: food stalls and a vending machine along the back wall
  const stalls = [['burger', '#c0392b', '#f2c94c'], ['pizza', '#c0392b', '#fffdf8'], ['noodles', '#d9731a', '#2a2438']];
  const spots = [];
  stalls.forEach(([kind, a, b], i) => {
    const x = X1 + 1.3 + i * 2.15, g = new THREE.Group(); g.position.set(x, 0, 0); office.add(g);
    const stripes = canvasTex(8, 1, (c) => { for (let k = 0; k < 8; k++) { c.fillStyle = k % 2 ? b : a; c.fillRect(k, 0, 1, 1); } });
    box(g, 1.7, 0.95, 0.65, faces(M(mix(a, '#000', 0.2)), texMat(stripes)), 0, 0, 1.05);
    box(g, 1.8, 0.06, 0.75, '#efe0c4', 0, 0.95, 1.05);
    box(g, 1.7, 1.6, 0.08, faces(M('#3a2a24'), texMat(spriteTex(kind, {}, '#3a2a24'))), 0, 0.95, 0.25);
    box(g, 0.08, 1.5, 0.08, '#8a5a33', -0.82, 0.95, 1.35); box(g, 0.08, 1.5, 0.08, '#8a5a33', 0.82, 0.95, 1.35);
    box(g, 1.95, 0.08, 1.3, texMat(stripes), 0, 2.4, 0.85).rotation.x = 0.28;
    const dish = food(kind); dish.scale.setScalar(1.8); dish.position.set(0.35, 1.01, 1.0); g.add(dish);
    spots.push({ kind, x, z: 2.0 });
  });
  const vx = X1 + LOUNGE_W - 1.0;
  box(office, 0.95, 1.95, 0.75, faces(M('#3b6ea5'), texMat(spriteTex('vending'))), vx, 0, 0.55);
  spots.push({ kind: 'soda', x: vx, z: 1.75 });
  // coffee counter and water cooler
  const cc = new THREE.Group(); cc.position.set(X1 + LOUNGE_W - 0.45, 0, D * 0.55); cc.rotation.y = -Math.PI / 2; office.add(cc);
  box(cc, 1.6, 0.9, 0.6, '#5f7d8c', 0, 0, 0); box(cc, 1.7, 0.06, 0.66, '#e8e0d0', 0, 0.9, 0);
  box(cc, 0.4, 0.5, 0.35, '#b4332c', -0.4, 0.96, -0.05); cyl(cc, 0.06, 0.05, 0.1, '#fffdf8', 0.3, 0.96, 0.05);
  const cooler = new THREE.Group(); cooler.position.set(X1 + LOUNGE_W - 0.5, 0, D * 0.55 + 1.4); office.add(cooler);
  box(cooler, 0.45, 1.0, 0.45, '#fffdf8', 0, 0, 0); cyl(cooler, 0.18, 0.18, 0.5, M('#9ed3f0', { transparent: true, opacity: 0.8 }), 0, 1.0, 0);
  // dining area: two rows of tables for four; diners use the back chairs so they face the camera
  const seats = [];
  [D * 0.42, D * 0.42 + 2.6].forEach((tz) => [0, 1, 2].forEach((i) => {
    const x = X1 + 2.0 + i * 2.75;
    box(office, 1.4, 0.06, 0.8, '#efe0c4', x, 0.72, tz);
    [-0.6, 0.6].forEach((dx) => [-0.3, 0.3].forEach((dz) => box(office, 0.07, 0.72, 0.07, '#8a5a33', x + dx, 0, tz + dz)));
    cyl(office, 0.05, 0.05, 0.12, '#d0473c', x, 0.78, tz, 8); // ketchup
    [-0.35, 0.35].forEach((dx) => {
      chair(office, x + dx, tz - 0.62, 0, '#2a9d8f', '#1f7a6f');
      chair(office, x + dx, tz + 0.62, Math.PI, '#2a9d8f', '#1f7a6f');
      seats.push({ x: x + dx, z: tz - 0.52, approachZ: tz - 1.25, plate: new THREE.Vector3(x + dx, 0.78, tz - 0.12), taken: null });
    });
  }));
  plant(office, X1 + 0.5, D - 0.5, 1.2); plant(office, X1 + LOUNGE_W - 0.6, D - 0.6, 1.2);
  size.spots = spots; size.dining = seats; size.loungeX = X1;

  // seats
  const wood = { top: '#d9a066', side: '#8a5a33' };
  const seatAt = (a, x, z, aisle, opts = {}) => {
    const p = person(a.id);
    p.root.position.set(x, 0, z - 0.62);
    office.add(p.root);
    chair(office, x, z - 0.72, 0, opts.chair?.[0], opts.chair?.[1], opts.boss);
    desk(office, x, z, opts.w ?? 1.6, opts.wood ?? wood);
    const side = aisle < x ? -1 : 1;
    const screen = monitor(office, x - side * 0.45, z - 0.05, x, z - 0.62);
    box(office, 0.48, 0.03, 0.16, '#2a2438', x - side * 0.05, 0.77, z + 0.05);
    cyl(office, 0.045, 0.04, 0.1, '#fffdf8', x + side * 0.65, 0.77, z + 0.15, 10);
    const tag = document.createElement('div'); tag.className = 'o3tag';
    tag.addEventListener('click', () => go('Live'));
    tagsEl.appendChild(tag);
    const st = { id: a.id, name: a.name, title: a.title || 'delegates', p, screen, tag, home: new THREE.Vector3(x, 0, z - 0.62), aisle, deskTop: new THREE.Vector3(x + side * 0.38, 0.77, z - 0.05), mode: 'sit', path: [], boss: opts.boss, t: Math.random() * 10 };
    p.root.traverse((o) => { o.userData.agentId = a.id; });
    people.set(a.id, st);
    return st;
  };
  seatAt({ id: 'boss', name: 'Boss' }, bx, bz, bx, { boss: true, w: 2.2, wood: { top: '#8a5a33', side: '#4a3020' }, chair: ['#a12d27', '#d0473c'] });
  box(office, 0.5, 0.1, 0.06, '#e8b03a', bx + 0.5, 0.77, bz + 0.25); // nameplate

  let z = 1.2;
  rows.forEach((row, ri) => {
    let x = X0 + (openW - rowW[ri]) / 2;
    row.forEach((team) => {
      const members = data.agents.filter((a) => a.team === team), cw = cubeW(team), pc = TEAM_COLOR[team] ?? TEAM_COLOR.Other;
      const fabric = M(mix(pc, '#fffdf8', 0.25)), cap = M(mix(pc, '#fffdf8', 0.6));
      plane(office, cw, CUBE_D, M(mix(pc, '#efe0c4', 0.82)), x + cw / 2, z + CUBE_D / 2, 0.011);
      box(office, cw, 1.15, 0.1, fabric, x + cw / 2, 0, z);
      box(office, cw + 0.04, 0.05, 0.14, cap, x + cw / 2, 1.15, z);
      [x, x + cw].forEach((sx) => { box(office, 0.1, 1.15, CUBE_D * 0.7, fabric, sx, 0, z + CUBE_D * 0.35); box(office, 0.14, 0.05, CUBE_D * 0.7, cap, sx, 1.15, z + CUBE_D * 0.35); });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(cw - 0.3, 2.2), 0.3), texMat(label(team, pc)));
      plate.position.set(x + cw / 2, 0.92, z + 0.06); office.add(plate);
      members.forEach((a, i) => {
        const sx = x + 0.4 + SEAT_W * (i + 0.5);
        seatAt(a, sx, z + 1.9, sx + (i % 2 ? 1 : -1) * 1.05);
      });
      x += cw + 1.1;
    });
    z += CUBE_D + 1.4;
  });

  // light + shadows sized to the office; default camera frames everything
  sun.position.set(W * 0.35, 18, D + 10); sun.target.position.set(W / 2, 0, D / 2);
  Object.assign(sun.shadow.camera, { left: -W * 0.75, right: W * 0.75, top: D * 1.4, bottom: -D * 1.4, near: 1, far: 80 });
  sun.shadow.camera.updateProjectionMatrix();
  fit = null; resize();
  if (!userMoved) resetView();
}

// ---------- camera ----------
// Closest camera distance (at the default angle) that keeps every corner of the office on screen.
const POLAR = 0.86;
function placeCamera(dist) {
  controls.target.set(size.w / 2, 0.6, size.d / 2);
  camera.position.set(size.w / 2, 0.6 + Math.cos(POLAR) * dist, size.d / 2 + Math.sin(POLAR) * dist);
  camera.lookAt(controls.target); camera.updateMatrixWorld();
}
function frameDistance() {
  const corners = [];
  for (const x of [-0.2, size.w + 0.2]) for (const y of [0, WALL_H]) for (const z of [-0.2, size.d]) corners.push(new THREE.Vector3(x, y, z));
  let lo = 2, hi = 300;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2; placeCamera(mid);
    const fits = corners.every((c) => { const p = c.clone().project(camera); return Math.abs(p.x) <= 0.97 && Math.abs(p.y) <= 0.94; });
    if (fits) hi = mid; else lo = mid;
  }
  return hi;
}
function resetView() {
  const dist = frameDistance();
  placeCamera(dist);
  controls.minDistance = dist * 0.3; controls.maxDistance = dist * 1.3;
  controls.update(); userMoved = false;
}
function zoom(f) {
  const off = camera.position.clone().sub(controls.target);
  off.setLength(THREE.MathUtils.clamp(off.length() * f, controls.minDistance, controls.maxDistance));
  camera.position.copy(controls.target).add(off); userMoved = true;
}
el.querySelector('.o3ctl').addEventListener('click', (e) => {
  const z = e.target.closest('button')?.dataset.z;
  if (z === 'in') zoom(0.8); else if (z === 'out') zoom(1.25); else if (z === 'reset') resetView();
});
controls.addEventListener('start', () => { userMoved = true; });
function resize() {
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  if (!userMoved && office) resetView();
}
new ResizeObserver(resize).observe(el);

// Click an agent in the scene to open the Live tab.
const ray = new THREE.Raycaster(), down = new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown', (e) => down.set(e.clientX, e.clientY));
renderer.domElement.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects([...people.values()].map((p) => p.p.root), true)[0];
  if (hit) go('Live');
});

// ---------- agents walking ----------
const lane = () => size.laneZ;
function walkTo(st, pts, done) {
  st.mode = 'walk'; st.path = pts.map(([x, z]) => new THREE.Vector3(x, 0, z)); st.done = done;
}
// Every trip gets a number; timers from an older trip (e.g. before work arrived) are ignored.
const later = (st, ms, fn) => { const trip = st.trip; setTimeout(() => st.trip === trip && fn(), ms); };
function leaveTable(st) {
  if (!st.seat) return [];
  const s = st.seat; st.seat = s.taken = null;
  if (st.plate) { office?.remove(st.plate); st.plate = null; }
  return [[s.x, s.approachZ], [size.loungeX + 0.9, s.approachZ]];
}
function headHome(st) {
  st.trip = (st.trip ?? 0) + 1; st.say = '';
  const pre = leaveTable(st), pos = pre.at(-1) ?? [st.p.root.position.x, st.p.root.position.z];
  // Leave the food court along the side wall instead of walking through the tables.
  const side = pos[0] > size.loungeX && pos[1] < lane() - 3 ? [[size.loungeX + 0.9, pos[1]], [size.loungeX + 0.9, lane()]] : [[pos[0], lane()]];
  walkTo(st, [...pre, ...side, [st.aisle, lane()], [st.aisle, st.home.z], [st.home.x, st.home.z]], () => sitDown(st));
}
// Take the food to a free dining seat and eat it there.
function eatAt(st, seat, from) {
  seat.taken = st; st.seat = seat;
  walkTo(st, [[size.loungeX + 0.9, from.z], [size.loungeX + 0.9, seat.approachZ], [seat.x, seat.approachZ], [seat.x, seat.z]], () => {
    st.mode = 'eat'; st.p.root.position.set(seat.x, 0, seat.z); st.p.root.rotation.y = 0; st.say = 'yum';
    st.p.hand.remove(st.food); st.p.carry = false;
    st.plate = st.food; st.food = null; st.plate.position.copy(seat.plate); office.add(st.plate);
    later(st, 8000 + Math.random() * 5000, () => headHome(st));
  });
}
function sitDown(st) {
  st.mode = 'sit'; st.returning = false; st.trip = (st.trip ?? 0) + 1; st.p.root.position.copy(st.home); st.p.root.rotation.y = 0;
  if (st.food) {
    st.p.hand.remove(st.food); st.p.carry = false;
    const f = st.food; f.position.copy(st.deskTop); office.add(f); st.food = null;
    setTimeout(() => office?.remove(f), 20000);
  }
}
function wander() {
  if (reduced || document.hidden || !office) return;
  const all = [...people.values()].filter((p) => !p.boss);
  const idle = all.filter((p) => p.state === 'idle' && p.mode === 'sit');
  if (!idle.length || all.filter((p) => p.mode !== 'sit').length >= 2 || Math.random() < 0.35) return;
  const st = idle[Math.floor(Math.random() * idle.length)];
  st.trip = (st.trip ?? 0) + 1;
  const others = all.filter((p) => p !== st);
  const out = [[st.aisle, st.home.z], [st.aisle, lane()]];
  if (!others.length || Math.random() < 0.6) {
    const spot = size.spots[Math.floor(Math.random() * size.spots.length)];
    const via = spot.kind ? [[size.loungeX + 0.9, lane()], [size.loungeX + 0.9, spot.z]] : [];
    walkTo(st, [...out, ...via, [spot.x, via.length ? spot.z : lane()], [spot.x, spot.z]], () => {
      st.mode = 'stand'; st.p.root.rotation.y = spot.kind ? Math.PI : 0;
      st.say = spot.kind ? spot.kind + '!' : 'coffee';
      later(st, 3000 + Math.random() * 3000, () => {
        st.say = '';
        if (!spot.kind) return headHome(st);
        st.food = food(spot.kind); st.p.hand.add(st.food); st.p.carry = true;
        const free = size.dining.filter((d) => !d.taken);
        if (free.length && Math.random() < 0.6) eatAt(st, free[Math.floor(Math.random() * free.length)], spot); else headHome(st);
      });
    });
  } else {
    const o = others[Math.floor(Math.random() * others.length)];
    walkTo(st, [...out, [o.aisle, lane()], [o.aisle, o.home.z + 0.3]], () => {
      st.mode = 'stand'; st.p.root.rotation.y = Math.atan2(o.home.x - o.aisle, 0); st.say = 'hi!';
      later(st, 3000 + Math.random() * 3000, () => headHome(st));
    });
  }
}
setInterval(wander, 3500);

// ---------- loop ----------
const timer = new THREE.Timer(), v = new THREE.Vector3();
const SCREEN = { on: ['#4fe08a', 1.4], ask: ['#f2b34c', 1.2], idle: ['#000000', 0] };
function tick() {
  requestAnimationFrame(tick);
  timer.update();
  if (!el.isConnected || document.hidden || !office) return;
  const dt = Math.min(timer.getDelta(), 0.05), now = timer.getElapsed();
  for (const st of people.values()) {
    st.t += dt;
    const p = st.p;
    if (st.mode === 'walk') {
      const target = st.path[0];
      if (!target) { st.mode = 'stand'; standStill(p); st.done?.(); continue; }
      v.subVectors(target, p.root.position).setY(0);
      const d = v.length(), step = WALK * dt;
      if (d <= step) { p.root.position.x = target.x; p.root.position.z = target.z; st.path.shift(); }
      else { v.multiplyScalar(step / d); p.root.position.add(v); p.root.rotation.y = Math.atan2(v.x, v.z); }
      pose(p, false, st.t, false);
    } else if (st.mode === 'sit') pose(p, true, st.t, st.state === 'on');
    else if (st.mode === 'eat') { pose(p, true, st.t, false); if (!reduced) p.armR.rotation.x = -1.3 - Math.max(0, Math.sin(st.t * 2.5)) * 0.6; }
    else standStill(p);
    const [col, k] = SCREEN[st.state] ?? SCREEN.idle;
    st.screen.emissive.set(col); st.screen.emissiveIntensity = st.state === 'on' && !reduced ? k * (0.8 + 0.2 * Math.sin(now * 12 + st.t)) : k;
    // tag above the head
    v.copy(p.root.position); v.y = 1.85; v.project(camera);
    const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    st.tag.style.display = vis ? '' : 'none';
    if (vis) st.tag.style.transform = `translate(${((v.x + 1) / 2) * el.clientWidth}px, ${((1 - v.y) / 2) * el.clientHeight}px) translate(-50%, -100%)`;
  }
  controls.update();
  renderer.render(scene, camera);
}

function update(data) {
  lastData = data;
  const sig = JSON.stringify([data.agents.map((a) => [a.id, a.team]), Object.keys(TEAM_COLOR)]);
  if (sig !== roster) { roster = sig; build(data); }
  const byId = new Map(data.agents.map((a) => [a.id, a]));
  for (const st of people.values()) {
    const a = st.boss ? { ...data.boss, name: 'Boss', title: 'delegates' } : byId.get(st.id);
    if (!a) continue;
    st.state = a.state; st.name = a.name; st.title = a.title;
    if (a.state !== 'idle' && st.mode !== 'sit' && !st.returning) { st.returning = true; headHome(st); }
    const say = st.mode === 'sit' ? a.say : st.say;
    const html = `${say ? `<div class="bub ${st.mode === 'sit' ? '' : 'say'}"><span>${esc(say)}${a.state === 'on' && st.mode === 'sit' ? '<i class="cur"></i>' : ''}</span></div>` : ''}<div class="pl">${esc(a.name)}</div>`;
    if (st.html !== html) { st.html = html; st.tag.innerHTML = html; }
    st.tag.className = `o3tag ${st.mode === 'sit' ? a.state : 'away'}`;
    st.tag.title = `${a.name} · ${a.title}${a.say ? ' — ' + a.say : ''}`;
  }
}
// Walking changes the bubble text, so refresh tags a few times a second.
setInterval(() => lastData && el.isConnected && update(lastData), 400);

try {
  if (!renderer.getContext()) throw new Error('no WebGL');
  window.Office3D = { el, update };
  tick();
  render();
} catch (e) {
  console.warn('3D office unavailable, using the pixel office', e);
  office3dFailed = true; render();
}
