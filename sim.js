"use strict";
// ==========================================================================
// ROCKET TEMU 3D — simulation (physics, rules, TemuBot). No DOM, no rendering.
// Units are meters and seconds. x = side to side, y = up, z = goal to goal.
// Blue defends the -z goal and attacks +z; orange the opposite.
// ==========================================================================
const V3 = THREE.Vector3, QT = THREE.Quaternion;
const UP = new V3(0, 1, 0);

// ---- Arena ---------------------------------------------------------------
// Rocket League's Soccar field. Our unit is 2 Rocket League centimetres per... put simply: every
// length below is Rocket League's value in unreal units divided by 50, and speeds the same, so the
// car, ball and field have the real proportions.
const HW = 81.92, HL = 102.4, CEIL = 40.88;    // half width, half length, ceiling height
const RE = 5.12;                               // radius of the curve where the floor and ceiling meet the walls
const RC = 23;                                 // corner radius seen from above
const GW = 17.86, GH = 12.86, GD = 17.6;       // goal half-width, height, depth

// ---- Ball ----------------------------------------------------------------
const BALL_R = 1.855, BALL_G = 13, BALL_E = 0.6, BALL_DRAG = 0.03, BALL_MAX = 120, BALL_ROLL_FRICTION = 0.25;

// ---- Car (Octane hitbox) ------------------------------------------------------
const GRAVITY = 13;
const CAR_HX = 0.842, CAR_HY = 0.3616, CAR_HZ = 1.18;  // hitbox half extents (width, height, length)
const CAR_REST = 0.70;                                  // hitbox centre's distance from the surface when on its wheels
const WHEEL_DROP = CAR_REST - CAR_HY;                   // gap between the hitbox bottom and the ground
const CAR_BUMP_R = 1.5;                                 // sphere used car-vs-car
const MAX_DRIVE = 28.2, MAX_SPEED = 46, SUPERSONIC = 44;
const BOOST_ACCEL = 19.83, BOOST_ACCEL_AIR = 21.17, AIR_THROTTLE = 1.33;
const BRAKE = 70, COAST = 10.5, BOOST_USE = 33.3, STICKY = 6.5;
const JUMP_VEL = 5.83, JUMP_HOLD_ACCEL = 29.17, JUMP_HOLD_TIME = 0.2, DOUBLE_JUMP = 5.83;
const DODGE_IMPULSE = 10, DODGE_WINDOW = 1.25, FLIP_TIME = 0.65;
// Air control (Rocket League's measured torque and damping per axis, local frame)
const T_PITCH = 12.15, T_YAW = 8.92, T_ROLL = 36.08, D_PITCH = -2.80, D_YAW = -1.89, D_ROLL = -4.47, MAX_SPIN = 5.5;
const CAR_MASS = 180, BALL_MASS = 30;
const MATCH_TIME = 300, SUBSTEPS = 2, FPS = 60, RESPAWN_TIME = 3;
const GOAL_PAUSE = 8.5;                      // celebration, then the replay, then kickoff

const TEAM_NAMES = ["BLU", "ORANG"];
const GOAL_MSGS = ["GOAL! (DELIVERED)", "GOAL! LEFT AT THE NET", "GOAL! YOUR ORDER HAS ARRIVED",
  "GOOOAL! (SPELLING MAY VARY)", "GOAL! SHIPPED IN 2-3 BUSINESS DAYS", "GOAL! RETURNS NOT ACCEPTED"];
const GO_WORDS = ["GO!", "SHIPPED!", "GO! (ISH)", "OUT FOR DELIVERY!"];
const DEMO_MSGS = ["DEMOLISHED! REFUND PENDING", "DEMOLISHED! NOT COVERED BY WARRANTY", "DEMOLISHED! SOME ASSEMBLY REQUIRED"];
const OVER_LINES = ["Your victory has shipped. Arrives in 7-21 business days.", "Trophy may differ from picture.",
  "Congrats! You unlocked a coupon for 0.5% off.", "Winner winner, frozen dinner (shipping not included)."];

// TemuBot condition: label, re-plan interval (s), seconds between lag spikes, lag spike length (s),
// aim wobble (m), how willing it is to burn boost, and air skill
// (0 = single jumps only, 1 = double jumps and flips, 2 = also real aerials)
const BOT_SKILLS = [
  ["REFURBISHED", 0.15, [3, 5], [0.6, 1.0], 1.2, 0.8, 0],
  ["LIKE NEW", 0.15, [7, 11], [0.4, 0.7], 1.2, 0.8, 1],
  ["PREMIUM SELLER", 0.15, [40, 60], [0.2, 0.3], 1.2, 0.8, 2],
];

// ---- Helpers ---------------------------------------------------------------
const uniform = (a, b) => a + Math.random() * (b - a);
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mod = (a, n) => ((a % n) + n) % n;
const wrapAngle = (a) => mod(a + Math.PI, Math.PI * 2) - Math.PI;
const flat = (v) => new V3(v.x, 0, v.z);

class Controls {
  constructor() { this.throttle = 0; this.steer = 0; this.jump = false; this.boost = false; this.roll = 0; this.slide = false; }
  copy() { return Object.assign(new Controls(), this); }
}

// Steering curvature (1/m) by speed, from Rocket League's table.
const CURVE = [[0, 0.345], [10, 0.199], [20, 0.1175], [30, 0.06875], [35, 0.055], [46, 0.044]];
function curvature(s) {
  s = Math.abs(s);
  for (let i = 1; i < CURVE.length; i++) {
    if (s <= CURVE[i][0]) {
      const [s0, c0] = CURVE[i - 1], [s1, c1] = CURVE[i];
      return c0 + (c1 - c0) * (s - s0) / (s1 - s0);
    }
  }
  return CURVE[CURVE.length - 1][1];
}
// Throttle acceleration by speed (Rocket League: 1600 uu/s² at rest, falling to 160 at 1400 uu/s, none past 1410)
function throttleAccel(s) { return s < 28 ? 32 - 28.8 * (s / 28) : s < MAX_DRIVE ? 3.2 : 0; }

// ---- Arena shape as a signed distance field (negative inside) --------------------------
// A rounded box: rounded corners seen from above, and curved transitions from the floor and
// ceiling into the walls, so cars can drive up the walls. Each goal is a box joined onto it.
function sdRoundRect(x, z, hx, hz, r) {
  const qx = Math.abs(x) - hx + r, qz = Math.abs(z) - hz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - r;
}
function sdMain(x, y, z) {
  const wx = sdRoundRect(x, z, HW, HL, RC) + RE, wy = Math.abs(y - CEIL / 2) - (CEIL / 2 - RE);
  return Math.min(Math.max(wx, wy), 0) + Math.hypot(Math.max(wx, 0), Math.max(wy, 0)) - RE;
}
const GOAL_IN = 6;                               // the goal box starts this far in front of the goal line
function sdGoal(x, y, z) {
  const qx = Math.abs(x) - GW, qy = Math.abs(y - GH / 2) - GH / 2, qz = Math.abs(Math.abs(z) - (HL + (GD - GOAL_IN) / 2)) - (GD + GOAL_IN) / 2;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}
function sdArena(x, y, z) { return Math.min(sdMain(x, y, z), sdGoal(x, y, z)); }
// Inward-pointing surface normal (the direction "away from the nearest wall")
function arenaNormal(p, out = new V3()) {
  const e = 0.02;
  out.set(sdArena(p.x - e, p.y, p.z) - sdArena(p.x + e, p.y, p.z),
    sdArena(p.x, p.y - e, p.z) - sdArena(p.x, p.y + e, p.z),
    sdArena(p.x, p.y, p.z - e) - sdArena(p.x, p.y, p.z + e));
  const l = out.length();
  return l > 1e-9 ? out.multiplyScalar(1 / l) : out.set(0, 1, 0);
}
const _seg = new V3(), _cl = new V3(), _d = new V3(), _n = new V3();
function pushSegment(pos, vel, r, a, b, e) {
  _seg.subVectors(b, a);
  const t = clamp(_d.subVectors(pos, a).dot(_seg) / _seg.lengthSq(), 0, 1);
  _cl.copy(a).addScaledVector(_seg, t);
  _d.subVectors(pos, _cl);
  const dist = _d.length();
  if (dist >= r || dist < 1e-6) return;
  _d.multiplyScalar(1 / dist);
  pos.copy(_cl).addScaledVector(_d, r);
  const vn = vel.dot(_d);
  if (vn < 0) vel.addScaledVector(_d, -(1 + e) * vn);
}
const POSTS = [];
for (const s of [-1, 1]) {
  POSTS.push([new V3(-GW, 0, s * HL), new V3(-GW, GH, s * HL)], [new V3(GW, 0, s * HL), new V3(GW, GH, s * HL)],
    [new V3(-GW, GH, s * HL), new V3(GW, GH, s * HL)]);
}
// Keep a sphere inside the arena. Returns the contact normal, or null if it touched nothing.
function collideArena(pos, vel, r, e, fric = 0) {
  let hit = null;
  for (let it = 0; it < 3; it++) {
    const d = sdArena(pos.x, pos.y, pos.z);
    if (d <= -r) break;
    const n = arenaNormal(pos, new V3());
    pos.addScaledVector(n, d + r);
    const vn = vel.dot(n);
    if (vn < 0) {
      vel.addScaledVector(n, -vn);
      if (fric && vn < -3) vel.multiplyScalar(1 - fric);
      vel.addScaledVector(n, -vn * e);
    }
    hit = n;
  }
  if (Math.abs(pos.z) > HL - r - 0.5 && pos.y < GH + r) for (const [a, b] of POSTS) pushSegment(pos, vel, r, a, b, e);
  return hit;
}

// ---- Ball ------------------------------------------------------------------
class Ball {
  constructor() { this.pos = new V3(); this.vel = new V3(); this.spin = new V3(); this.r = BALL_R; this.reset(); }
  reset() { this.pos.set(0, BALL_R, 0); this.vel.set(0, 0, 0); this.spin.set(0, 0, 0); this.r = BALL_R; }
  step(dt, m) {
    this.r += (m.ballR - this.r) * Math.min(1, 4 * dt);
    this.vel.y -= BALL_G * m.grav * dt;
    this.vel.multiplyScalar(1 - BALL_DRAG * dt);
    const len = this.vel.length();
    if (len > BALL_MAX) this.vel.multiplyScalar(BALL_MAX / len);
    this.pos.addScaledVector(this.vel, dt);
    const n = collideArena(this.pos, this.vel, this.r, BALL_E * m.ballE, 0.04);
    if (n) {
      const vn = this.vel.dot(n);
      if (Math.abs(vn) < 1.2 && n.y > 0.7) {            // rolling on the floor
        this.vel.addScaledVector(n, -vn);
        this.vel.multiplyScalar(1 - BALL_ROLL_FRICTION * dt);
      }
      // spin to match rolling along whatever surface it touches
      this.spin.copy(n).cross(this.vel).multiplyScalar(-1 / this.r);
    }
  }
}

// Predict where the ball will be (no cars), sampled every `step` seconds.
const NEUTRAL = { grav: 1, unlimited: false, grip: 1, speed: 1, ballR: BALL_R, ballE: 1 };
function predictBall(ball, mods, secs = 3, step = 1 / 30) {
  const b = new Ball(); b.pos.copy(ball.pos); b.vel.copy(ball.vel); b.r = ball.r;
  const out = [];
  const sub = 2, dt = step / sub;
  for (let t = step; t <= secs + 1e-6; t += step) {
    for (let i = 0; i < sub; i++) b.step(dt, mods);
    out.push({ t, pos: b.pos.clone(), vel: b.vel.clone() });
  }
  return out;
}

// ---- Car loadouts (looks only; every body has the same hitbox) ----------------------------------
// [body, decal, wheels, boost trail, topper, accent colour]
const LOOK_SIZES = [4, 6, 5, 6, 6, 10];
const DEFAULT_LOOK = [0, 0, 0, 0, 0, 0];
function cleanLook(a) {
  if (!Array.isArray(a) || a.length !== LOOK_SIZES.length) return DEFAULT_LOOK.slice();
  return LOOK_SIZES.map((n, i) => (Number.isInteger(a[i]) && a[i] >= 0 && a[i] < n ? a[i] : 0));
}
function randomLook() { return LOOK_SIZES.map((n, i) => (i === 4 && Math.random() < 0.6 ? 0 : (Math.random() * n) | 0)); }

// ---- Car -------------------------------------------------------------------
const _m4 = new THREE.Matrix4();
function quatFromBasis(q, fwd, up) {           // car frame: x = left, y = up, z = forward
  const left = new V3().crossVectors(up, fwd).normalize();
  const f = new V3().crossVectors(left, up).normalize();
  _m4.makeBasis(left, up, f);
  return q.setFromRotationMatrix(_m4);
}
// Respawn spots after a demolition (Rocket League's, for blue; orange is mirrored)
const RESPAWNS = [[-46.08, -92.16], [-53.76, -92.16], [46.08, -92.16], [53.76, -92.16]];
class Car {
  constructor(team, name) {
    this.team = team; this.name = name; this.look = randomLook();
    this.pos = new V3(); this.vel = new V3(); this.quat = new QT(); this.angVel = new V3(); this.flipAxis = new V3();
    this.homeZ = team === 0 ? -(HL - 10) : HL - 10;
    this.boostUse = 1;                                   // premium sellers get premium shipping (boost lasts longer)
    this.spawn(new V3(0, CAR_REST, this.homeZ), team === 0 ? 0 : Math.PI);
    this.boost = 33;
  }
  spawn(pos, yaw) {
    this.pos.copy(pos); this.pos.y = CAR_REST; this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    this.yaw = yaw; this.quat.setFromAxisAngle(UP, yaw);
    this.onGround = true; this.boosting = false; this.jumpPrev = false; this.airTime = 0; this.jumpT = 0; this.jumpHeld = false;
    this.canDodge = false; this.hasDoubled = false; this.flipLeft = 0; this.flipAxis.set(0, 0, 0); this.contactT = 0;
    this.demolished = false; this.respawn = 0; this.supersonicT = 0;
  }
  forward() { return new V3(0, 0, 1).applyQuaternion(this.quat); }
  up() { return new V3(0, 1, 0).applyQuaternion(this.quat); }
  left() { return new V3(1, 0, 0).applyQuaternion(this.quat); }
  speed() { return this.vel.length(); }
  // Everything needed to continue this car's simulation exactly (used for online play)
  serialize() {
    const r = (v) => Math.round(v * 10000) / 10000;
    return [this.pos.x, this.pos.y, this.pos.z, this.vel.x, this.vel.y, this.vel.z, this.quat.x, this.quat.y, this.quat.z, this.quat.w,
      this.angVel.x, this.angVel.y, this.angVel.z, this.airTime, this.jumpT, this.flipLeft, this.flipAxis.x, this.flipAxis.y, this.flipAxis.z,
      this.respawn, this.supersonicT, this.boost, this.contactT].map(r).concat([
      (this.onGround ? 1 : 0) | (this.canDodge ? 2 : 0) | (this.hasDoubled ? 4 : 0) | (this.jumpPrev ? 8 : 0) | (this.demolished ? 16 : 0) | (this.boosting ? 32 : 0) | (this.jumpHeld ? 64 : 0)]);
  }
  deserialize(v) {
    this.pos.set(v[0], v[1], v[2]); this.vel.set(v[3], v[4], v[5]); this.quat.set(v[6], v[7], v[8], v[9]).normalize();
    this.angVel.set(v[10], v[11], v[12]); this.airTime = v[13]; this.jumpT = v[14]; this.flipLeft = v[15]; this.flipAxis.set(v[16], v[17], v[18]);
    this.respawn = v[19]; this.supersonicT = v[20]; this.boost = v[21]; this.contactT = v[22];
    const f = v[23];
    this.onGround = !!(f & 1); this.canDodge = !!(f & 2); this.hasDoubled = !!(f & 4); this.jumpPrev = !!(f & 8);
    this.demolished = !!(f & 16); this.boosting = !!(f & 32); this.jumpHeld = !!(f & 64);
    const fw = this.forward(); this.yaw = Math.atan2(fw.x, fw.z);
  }
  update(c, dt, m) {
    if (this.demolished) {
      this.respawn -= dt;
      if (this.respawn <= 0) {
        const boost = this.boost, [rx, rz] = choice(RESPAWNS), s = this.team === 0 ? 1 : -1;
        this.spawn(new V3(rx * s, CAR_REST, rz * s), this.team === 0 ? 0 : Math.PI);
        this.boost = Math.max(33, boost);
      }
      return;
    }
    const jumpPressed = c.jump && !this.jumpPrev;
    this.jumpPrev = c.jump; this.jumpNow = false;
    if (jumpPressed && !this.onGround && this.flipLeft <= 0) {     // turtled: jump rolls you back over
      const n = this.touching(0.3);
      if (n && this.up().dot(n) < 0.3) { this.selfRight(n); this.jumpNow = true; }
    }
    this.boosting = c.boost && (this.boost > 0 || m.unlimited);
    if (this.onGround) this.drive(c, dt, m, jumpPressed);
    else this.fly(c, dt, m, jumpPressed);
    if (this.boosting && !m.unlimited) this.boost = Math.max(0, this.boost - BOOST_USE * dt * this.boostUse);
    const top = MAX_SPEED * m.speed, s = this.vel.length();
    if (s > top) this.vel.multiplyScalar(top / s);
    this.supersonicT = s > SUPERSONIC ? this.supersonicT + dt : 0;
    this.pos.addScaledVector(this.vel, dt);
    if (this.onGround) this.stick(dt); else this.collideAir(dt);
    const dc = sdArena(this.pos.x, this.pos.y, this.pos.z);     // never let the car's centre end up inside a wall
    if (dc > -0.2) {
      const n = arenaNormal(this.pos, new V3());
      this.pos.addScaledVector(n, dc + 0.2);
      const vn = this.vel.dot(n); if (vn < 0) this.vel.addScaledVector(n, -vn);
    }
    const fw = this.forward(); this.yaw = Math.atan2(fw.x, fw.z);
  }
  // On the wheels: works the same on the floor, up the curved walls and on the ceiling.
  drive(c, dt, m, jumpPressed) {
    const n = this.up();
    let f = this.forward();
    let s = this.vel.dot(f);
    const vn = this.vel.dot(n);
    const lat = this.vel.clone().addScaledVector(f, -s).addScaledVector(n, -vn);
    const grip = m.grip * (c.slide ? 0.25 : 1);
    lat.multiplyScalar(Math.exp(-12 * grip * dt));
    const t = c.throttle;
    if (t !== 0 && t * s < -0.5) s += Math.sign(t) * BRAKE * dt;
    else if (t !== 0) {
      const lim = MAX_DRIVE * m.speed;
      if (Math.abs(s) < lim) s = clamp(s + t * throttleAccel(Math.abs(s)) * Math.max(grip, 0.35) * dt * m.speed, -lim, lim);
    } else if (!this.boosting) s -= Math.sign(s) * Math.min(Math.abs(s), COAST * dt);
    if (this.boosting) s += BOOST_ACCEL * dt;
    const turn = curvature(s) * s * c.steer * (c.slide ? 1.5 : 1);
    f = f.applyAxisAngle(n, -turn * dt);
    this.vel.copy(f).multiplyScalar(s).add(lat);
    // Gravity: the part along the surface slides you down a wall; the part into or out of it
    // decides whether you stay on. Walls hold you (with a little stickiness); the ceiling doesn't.
    const g = new V3(0, -GRAVITY * m.grav, 0), gn = g.dot(n);
    this.vel.addScaledVector(g, dt).addScaledVector(n, -gn * dt);
    this.quat.copy(quatFromBasis(new QT(), f, n));
    this.angVel.copy(n).multiplyScalar(-turn);
    if (gn - STICKY > 0 || (n.y < 0.25 && Math.abs(s) < 6 && !this.boosting)) {
      this.leaveGround(); this.vel.addScaledVector(n, Math.max(gn - STICKY, 2) * dt);
    }
    if (jumpPressed) {
      this.leaveGround(); this.vel.addScaledVector(n, JUMP_VEL); this.pos.addScaledVector(n, 0.05);
      this.jumpT = 0; this.jumpHeld = true; this.canDodge = true; this.hasDoubled = false;
    }
  }
  leaveGround() { this.onGround = false; this.airTime = 0; this.canDodge = true; this.contactT = 0; }
  fly(c, dt, m, jumpPressed) {
    this.airTime += dt; this.jumpT += dt;
    // Holding jump right after jumping makes it higher
    if (this.jumpHeld) {
      if (c.jump && this.jumpT < JUMP_HOLD_TIME) this.vel.addScaledVector(this.up(), JUMP_HOLD_ACCEL * dt);
      else this.jumpHeld = false;
    }
    const inv = this.quat.clone().invert();
    const w = this.angVel.clone().applyQuaternion(inv);   // local: x = pitch (nose down +), y = yaw (left +), z = roll
    if (this.flipLeft > 0) {
      this.flipLeft -= dt;
      w.copy(this.flipAxis);
      if (this.flipLeft <= 0) w.multiplyScalar(0.25);
    } else {
      const p = c.throttle, y = -c.steer, r = c.roll;
      w.x += (T_PITCH * p + D_PITCH * (1 - Math.abs(p)) * w.x) * dt;
      w.y += (T_YAW * y + D_YAW * (1 - Math.abs(y)) * w.y) * dt;
      w.z += (T_ROLL * r + D_ROLL * w.z) * dt;
      const l = w.length(); if (l > MAX_SPIN) w.multiplyScalar(MAX_SPIN / l);
    }
    if (jumpPressed && this.canDodge && this.airTime < DODGE_WINDOW && !this.jumpNow && !(this.contactT > 0)) {
      this.canDodge = false; this.jumpHeld = false;
      if (c.throttle !== 0 || c.steer !== 0) {      // dodge / flip in the pressed direction
        const fw = flat(this.forward()).normalize(), lf = new V3(fw.z, 0, -fw.x);
        const sp = flat(this.vel).length();
        const fwd = c.throttle * DODGE_IMPULSE, side = -c.steer * DODGE_IMPULSE * (1 + 0.9 * sp / MAX_SPEED);
        this.vel.addScaledVector(fw, fwd).addScaledVector(lf, side);
        this.vel.y = Math.max(this.vel.y * 0.35, 0);
        const fl = Math.hypot(c.throttle, c.steer) || 1;
        this.flipAxis.set((c.throttle / fl) * (Math.PI * 2) / FLIP_TIME, 0, (c.steer / fl) * (Math.PI * 2) / FLIP_TIME);
        this.flipLeft = FLIP_TIME;
      } else {
        this.vel.addScaledVector(this.up(), DOUBLE_JUMP);
        this.hasDoubled = true;
      }
    }
    this.angVel.copy(w).applyQuaternion(this.quat);
    const ang = this.angVel.length();
    if (ang > 1e-6) {
      const dq = new QT().setFromAxisAngle(this.angVel.clone().multiplyScalar(1 / ang), ang * dt);
      this.quat.premultiply(dq).normalize();
    }
    if (this.boosting) this.vel.addScaledVector(this.forward(), BOOST_ACCEL_AIR * dt);
    else if (c.throttle) this.vel.addScaledVector(this.forward(), AIR_THROTTLE * c.throttle * dt);
    this.vel.y -= GRAVITY * m.grav * dt;
  }
  // Keep a driving car on its surface; follow the curve of the walls; bump into anything else.
  stick(dt) {
    const up = this.up();
    const wheel = this.pos.clone().addScaledVector(up, -CAR_REST);
    const d = sdArena(wheel.x, wheel.y, wheel.z);
    if (d < -0.6) { this.leaveGround(); return; }          // the surface curved away: airborne
    const n = arenaNormal(wheel, new V3());
    if (n.dot(up) < 0.5) {                                  // the nearest surface is a wall in front of us, not under us
      n.copy(up);
    } else {
      wheel.addScaledVector(n, d);
      this.pos.copy(wheel).addScaledVector(n, CAR_REST);
      this.quat.copy(quatFromBasis(new QT(), this.forward(), n));
    }
    const vn = this.vel.dot(n);
    if (vn < 0) this.vel.addScaledVector(n, -vn);
    this.bumpCorners(n);
  }
  // Corners of the hitbox that poke into a wall get pushed out (e.g. driving into a goal post)
  bumpCorners(groundN) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const p = this.pos.clone().add(new V3(sx * CAR_HX, CAR_HY, sz * CAR_HZ).applyQuaternion(this.quat));
      const d = sdArena(p.x, p.y, p.z);
      if (d <= 0) continue;
      const n = arenaNormal(p, new V3());
      if (groundN && n.dot(groundN) > 0.5) continue;
      this.pos.addScaledVector(n, d);
      const vn = this.vel.dot(n);
      if (vn < 0) this.vel.addScaledVector(n, -1.15 * vn);
    }
  }
  // In the air: check the wheels and the corners against the arena.
  // Touching down at an angle tips the car onto its wheels (a quick, physical-looking roll instead of a
  // snap). Stuck on the roof or side ("turtled"), it rights itself after a moment, or straight away on jump.
  collideAir(dt) {
    const up = this.up();
    let worst = 0, wp = null;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const sy of [-1, 1]) {
      const local = new V3(sx * CAR_HX, sy * CAR_HY - (sy < 0 ? WHEEL_DROP : 0), sz * CAR_HZ);
      const p = this.pos.clone().add(local.applyQuaternion(this.quat));
      const d = sdArena(p.x, p.y, p.z);
      if (d > worst) { worst = d; wp = p; }
    }
    if (!wp) { this.contactT = 0; return; }
    const n = arenaNormal(wp, new V3());
    this.pos.addScaledVector(n, worst);
    const vn = this.vel.dot(n), un = up.dot(n);
    if (un > 0.985 && vn <= 2) { this.land(n); return; }
    this.contactT += dt;
    if (un > 0.3 && vn <= 2) {                         // on some wheels: tip over onto all four
      const axis = new V3().crossVectors(up, n), s = axis.length();
      if (s > 1e-4) this.angVel.copy(axis.multiplyScalar(Math.min(20 * Math.asin(Math.min(1, s)) / s, 12 / s)));
      // the body keeps coming down, pivoting on the touching wheel (the push-out above holds that wheel on the
      // surface), so it swings onto the other wheels instead of stopping dead
      if (vn > 0) this.vel.addScaledVector(n, -vn);
      this.flipLeft = 0;
      if (this.contactT > 0.4) this.land(n);           // safety net
      return;
    }
    if (vn < 0) this.vel.addScaledVector(n, -1.05 * vn);           // roof, side or nose: thud
    const vt = this.vel.clone().addScaledVector(n, -this.vel.dot(n));
    this.vel.addScaledVector(vt, -(1 - Math.exp(-2.5 * dt)));      // and scrape along
    if (this.contactT > 0.3 && Math.abs(vn) < 4 && this.flipLeft <= 0) this.selfRight(n);
  }
  // The arena surface within `margin` of the hitbox (its normal), or null
  touching(margin) {
    let best = -margin, bp = null;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const sy of [-1, 1]) {
      const p = this.pos.clone().add(new V3(sx * CAR_HX, sy * CAR_HY, sz * CAR_HZ).applyQuaternion(this.quat));
      const d = sdArena(p.x, p.y, p.z);
      if (d > best) { best = d; bp = p; }
    }
    return bp ? arenaNormal(bp, new V3()) : null;
  }
  // Roll back onto the wheels with a little hop (Rocket League's turtle recovery)
  selfRight(n) {
    const up = this.up();
    let axis = new V3().crossVectors(up, n);
    if (axis.lengthSq() < 1e-4) axis = this.forward();             // flat on the roof: roll over sideways
    axis.normalize();
    const ang = Math.acos(clamp(up.dot(n), -1, 1)), T = 0.38;
    this.flipAxis.copy(axis.applyQuaternion(this.quat.clone().invert())).multiplyScalar(ang / T);
    this.flipLeft = T;
    this.vel.addScaledVector(n, 3.8);
    this.pos.addScaledVector(n, 0.05);
    this.contactT = 0;
  }
  land(n) {
    let f = this.forward().addScaledVector(n, -this.forward().dot(n));
    if (f.lengthSq() < 1e-4) f = this.up().negate().addScaledVector(n, this.up().dot(n));
    if (f.lengthSq() < 1e-4) f = new V3(n.y, -n.x, 0);
    f.normalize();
    this.quat.copy(quatFromBasis(new QT(), f, n));
    this.onGround = true; this.flipLeft = 0; this.canDodge = false; this.jumpHeld = false; this.contactT = 0;
    const vn = this.vel.dot(n);
    if (vn < 0) this.vel.addScaledVector(n, -vn);
    this.angVel.set(0, 0, 0);
    const wheel = this.pos.clone().addScaledVector(n, -CAR_REST);
    const d = sdArena(wheel.x, wheel.y, wheel.z);
    this.pos.addScaledVector(n, d);
  }
}

// ---- Car vs ball -------------------------------------------------------------
const _inv = new QT(), _loc = new V3();
function carBallContact(car, ball) {
  _inv.copy(car.quat).invert();
  _loc.subVectors(ball.pos, car.pos).applyQuaternion(_inv);
  const cl = new V3(clamp(_loc.x, -CAR_HX, CAR_HX), clamp(_loc.y, -CAR_HY, CAR_HY), clamp(_loc.z, -CAR_HZ, CAR_HZ));
  const closest = cl.clone().applyQuaternion(car.quat).add(car.pos);
  const diff = new V3().subVectors(ball.pos, closest);
  const dist = diff.length();
  if (dist >= ball.r) return null;
  if (dist > 1e-6) return { n: diff.multiplyScalar(1 / dist), pen: ball.r - dist };
  // Ball center inside the hitbox: push out through the nearest face
  const faces = [[CAR_HX - _loc.x, new V3(1, 0, 0)], [CAR_HX + _loc.x, new V3(-1, 0, 0)], [CAR_HY - _loc.y, new V3(0, 1, 0)],
    [CAR_HY + _loc.y, new V3(0, -1, 0)], [CAR_HZ - _loc.z, new V3(0, 0, 1)], [CAR_HZ + _loc.z, new V3(0, 0, -1)]];
  faces.sort((a, b) => a[0] - b[0]);
  return { n: faces[0][1].applyQuaternion(car.quat), pen: ball.r + faces[0][0] };
}
// Every car touching the ball is resolved against the same ball state, so a true 50/50 is fair.
function collideCarsBall(cars, ball, events) {
  const hits = [];
  for (const car of cars) {
    if (car.demolished) continue;
    const ct = carBallContact(car, ball);
    if (ct) hits.push([car, ct]);
  }
  if (!hits.length) return;
  const bvel = ball.vel.clone(), push = new V3(), dv = new V3();
  for (const [car, { n, pen }] of hits) {
    push.addScaledVector(n, pen);
    const rel = new V3().subVectors(bvel, car.vel);
    const vn = rel.dot(n);
    if (vn < 0) {
      const j = -(1 + 0.3) * vn;
      dv.addScaledVector(n, j * CAR_MASS / (CAR_MASS + BALL_MASS));
      car.vel.addScaledVector(n, -Math.min(j * BALL_MASS / (CAR_MASS + BALL_MASS), 6));
      // The real game's extra "car hit" impulse: along car->ball, flattened, scaled by closing speed
      const dir = new V3().subVectors(ball.pos, car.pos); dir.y *= 0.35; dir.normalize();
      const rs = Math.min(rel.length(), 46);
      const scale = rs < 10 ? 0.65 : 0.65 - 0.1 * (rs - 10) / 36;
      dv.addScaledVector(dir, rs * scale);
      events.push({ type: "touch", team: car.team, car: car.idx, power: rs });
      car.lastTouch = performance.now ? performance.now() : 0;
    }
  }
  ball.pos.add(push);
  ball.vel.add(dv);
  if (ball.vel.length() > BALL_MAX) ball.vel.setLength(BALL_MAX);
}

// ---- TemuBot -------------------------------------------------------------------
class TemuBot {
  constructor(car, skill = 1) {
    this.car = car; this.a = car.team === 0 ? 1 : -1;    // direction we attack in z
    [, this.react, this.lag, this.lagLen, this.sloppy, this.boostWill, this.air] = BOT_SKILLS[skill];
    car.boostUse = this.air === 2 ? 0.75 : 1;
    this.bufferIn = uniform(...this.lag); this.buffering = 0; this.wake = 0;
    this.mode = "attack"; this.hold = 0; this.last = new Controls(); this.offset = new V3();
    this.planGround = true; this.planBallVel = new V3(); this.move = null; this.pred = null;
  }
  kickoff() {
    this.buffering = 0; this.mode = "kickoff"; this.hold = 0; this.move = null;
    this.wake = uniform(0, 0.12) + this.react * 0.5;
  }
  // match gives the bot every car on the field; car.role is set by Match.assignRoles each tick
  think(ball, match, mods, dt) {
    const car = this.car;
    const opps = match.cars.filter((c) => c.team !== car.team);
    let opp = opps[0], best = 1e9;
    for (const o of opps) { const e = o.demolished ? 99 : etaOf(o, ball.pos); if (e < best) { best = e; opp = o; } }
    if (car.demolished) return new Controls();
    if (this.wake > 0) { this.wake -= dt; return new Controls(); }
    if (this.buffering > 0) { this.buffering -= dt; return new Controls(); }
    this.bufferIn -= dt;
    if (this.bufferIn <= 0) { this.buffering = uniform(...this.lagLen); this.bufferIn = uniform(...this.lag); return new Controls(); }
    // Maneuvers (jump -> flip) run frame by frame once started
    if (this.move) return this.runMove(dt, ball);
    this.hold -= dt;
    if (car.onGround !== this.planGround || this.planBallVel.distanceTo(ball.vel) > 6) this.hold = 0;
    if (this.hold <= 0) {
      this.hold = this.react;
      this.planGround = car.onGround; this.planBallVel.copy(ball.vel);
      this.offset.set(uniform(-1, 1), 0, uniform(-1, 1)).multiplyScalar(this.sloppy);
      this.pred = predictBall(ball, mods, 3, 1 / 20);
      this.last = this.decide(ball, opp, match);
    }
    return this.reflexes(this.last, ball, opps);
  }
  startMove(kind, dir, T = 0) {
    if (this.air === 0 && (kind === "flip" || kind === "double")) kind = kind === "double" ? "jump" : null;
    if (kind === "aerial" && this.air < 2) kind = "double";
    if (kind) this.move = { kind, t: 0, dir, T };
  }
  runMove(dt, ball) {
    const mv = this.move, c = new Controls(), car = this.car;
    mv.t += dt;
    c.boost = mv.kind === "flip" && car.boost > 10 && mv.t < 0.15;
    c.throttle = 1;
    if (mv.kind === "flip") {                      // jump, release, then dodge toward the ball
      if (mv.t < 0.07) c.jump = true;
      else if (mv.t < 0.12) c.jump = false;
      else if (mv.t < 0.2) { c.jump = true; c.throttle = 1; c.steer = clamp(mv.dir, -1, 1); }
      else { this.move = mv.t > 0.9 || car.onGround ? null : mv; c.throttle = 0; }
    } else if (mv.kind === "jump" || mv.kind === "double") {
      c.jump = mv.t < (mv.kind === "double" ? 0.12 : 0.2);
      if (mv.kind === "double" && mv.t > 0.2 && mv.t < 0.27) c.jump = true;
      if (mv.t > 0.27 && mv.kind === "double") c.jump = false;
      // nose toward the ball while rising
      const toBall = new V3().subVectors(ball.pos, car.pos);
      const pitchErr = Math.atan2(toBall.y, flat(toBall).length()) - Math.asin(clamp(car.forward().y, -1, 1));
      c.throttle = clamp(-pitchErr * 2, -1, 1);
      if (car.onGround && mv.t > 0.3) this.move = null;
      if (mv.t > 1.6) this.move = null;
    } else if (mv.kind === "aerial") {
      // Jump twice, then point the nose at the intercept (aiming above it for gravity) and boost.
      const left = Math.max(mv.T - mv.t, 0.05);
      const aimPt = mv.dir.clone(); aimPt.y += 0.5 * GRAVITY * left * left * 0.6;
      const d = new V3().subVectors(aimPt, car.pos).applyQuaternion(car.quat.clone().invert());
      if (mv.t < 0.16) c.jump = true;
      else if (mv.t > 0.22 && mv.t < 0.28) c.jump = true;
      c.throttle = clamp(-Math.atan2(d.y, d.z) * 3, -1, 1);
      c.steer = clamp(-Math.atan2(d.x, d.z) * 3, -1, 1);
      c.roll = clamp(car.left().y * 3, -1, 1);
      const off = Math.acos(clamp(d.z / (d.length() || 1), -1, 1));
      c.boost = mv.t > 0.08 && off < 0.6 && car.boost > 0;
      if (mv.t > mv.T + 0.4 || (mv.t > 0.4 && car.onGround) || car.pos.distanceTo(ball.pos) < ball.r + 1.6) this.move = null;
    } else if (mv.kind === "hop") {
      c.jump = mv.t < 0.1; c.throttle = 0;
      if (mv.t > 0.15) this.move = null;
    }
    return c;
  }
  eta(target) {
    const car = this.car;
    const to = flat(new V3().subVectors(target, car.pos));
    const dist = to.length();
    const ang = Math.abs(wrapAngle(Math.atan2(to.x, to.z) - car.yaw));
    const v = Math.max(flat(car.vel).length(), 8);
    const top = car.boost > 15 ? 40 : MAX_DRIVE;
    return dist / ((v + top) / 2) + ang * 0.45;
  }
  // Earliest predicted ball position the car can get to (on the ground or with a jump)
  intercept(maxH) {
    for (const p of this.pred) {
      if (p.pos.y > maxH) continue;
      if (this.eta(p.pos) <= p.t + 0.05) return p;
    }
    return this.pred[this.pred.length - 1];
  }
  decide(ball, opp, match) {
    const car = this.car, a = this.a, c = new Controls(), role = car.role || "solo";
    const ownGoal = new V3(0, 0, -a * HL), oppGoal = new V3(0, 0, a * HL);
    const behind = (ball.pos.z - car.pos.z) * a > -1.5;
    const myEta = this.eta(ball.pos), oppEta = opp.demolished ? 99 : etaOf(opp, ball.pos);
    const oppCanShoot = (ball.pos.z - opp.pos.z) * -a > -1.5 && !opp.demolished;
    const towardNet = ball.vel.z * -a;
    const ballToGoal = ball.pos.distanceTo(ownGoal);
    const threat = oppCanShoot && (oppEta < 1.2 || towardNet > 18);
    const first = myEta + 0.35 < oppEta;
    let mode;
    const kickoffBall = ball.vel.lengthSq() < 0.01 && Math.abs(ball.pos.x) < 0.1 && Math.abs(ball.pos.z) < 0.1;
    if (role === "solo") {                         // 1v1: do everything yourself
      if (this.mode === "kickoff" && kickoffBall) mode = "kickoff";
      else if (!behind) mode = "retreat";
      else if (myEta < 0.45 && !(threat && oppEta < myEta)) mode = "attack";
      else if (threat && !first) mode = "keeper";
      else if (ballToGoal < 32 || !oppCanShoot || first || (this.mode === "attack" && myEta < oppEta + 0.25)) mode = "attack";
      else mode = "shadow";
    } else if (role === "attack") {                // first man: challenge the ball
      if (kickoffBall) mode = "kickoff";
      else mode = behind ? "attack" : "retreat";
    } else if (role === "support") {               // second man: back the attacker up, collect boost
      if (!behind && !kickoffBall) mode = "retreat";
      else if (!kickoffBall && myEta < 0.4 && myEta < oppEta) mode = "attack";
      else mode = "support";
    } else {                                       // last man: protect the net
      if (!behind && !kickoffBall) mode = "retreat";
      else if (!kickoffBall && ballToGoal < 40 && myEta + 0.2 < oppEta) mode = "attack";
      else mode = "keeper";
    }
    this.mode = mode;

    let target, arrive = false, wantBoost = false;
    if (mode === "kickoff") {
      target = ball.pos.clone(); wantBoost = true;
      const d = flat(new V3().subVectors(ball.pos, car.pos)).length();
      if (d < 9 && car.onGround && flat(car.vel).length() > 18) this.startMove("flip", 0);
    } else if (mode === "attack") {
      const reach = this.air === 0 ? 3.6 : this.air === 1 ? 6 : 6.5;
      const p = this.intercept(car.boost > 30 ? reach : Math.min(reach, 4.2));
      // Premium sellers go up for high balls they can reach first
      if (this.air === 2 && car.onGround && car.boost > 35) {
        for (const q of this.pred) {
          if (q.pos.y < 6.5 || q.pos.y > CEIL - 3 || q.t < 0.8) continue;
          const need = car.pos.distanceTo(q.pos) / 21 + 0.45;
          const facing = Math.abs(wrapAngle(Math.atan2(q.pos.x - car.pos.x, q.pos.z - car.pos.z) - car.yaw));
          if (need <= q.t && need > q.t - 0.6 && facing < 0.5 && (q.pos.z - car.pos.z) * a > -1 && q.t < oppEta + 0.6) {
            this.startMove("aerial", q.pos.clone(), q.t);
            break;
          }
        }
      }
      // Aim at the far side of the opponent's goal mouth, away from the opponent if possible
      const aimX = clamp(-opp.pos.x * 0.15 + this.offset.x, -GW + 2, GW - 2);
      const aim = new V3(aimX, 0, oppGoal.z);
      const shotDir = flat(new V3().subVectors(aim, p.pos)).normalize();
      const dist = flat(new V3().subVectors(p.pos, car.pos)).length();
      const back = clamp(dist * 0.3, p.pos.y > 3 ? 0.5 : 1.6, 7);
      target = p.pos.clone().addScaledVector(shotDir, -back);
      // Clearing near our own net: just hit it away from goal, don't go around
      if (ballToGoal < 30) target = p.pos.clone().addScaledVector(shotDir, -1);
      const toT = flat(new V3().subVectors(target, car.pos));
      const ang = Math.abs(wrapAngle(Math.atan2(toT.x, toT.z) - car.yaw));
      wantBoost = (dist > 18 && ang < 0.35) || (dist < 9 && ang < 0.25 && p.pos.y < 3 && p.t < 0.6);
      // Jump for high intercepts
      if (car.onGround && p.pos.y > 3.2 && dist < 4 + p.pos.y * 0.6 && p.t < 0.75) this.startMove(p.pos.y > 6 ? "double" : "jump");
      // Flip into a low ball for power when lined up
      else if (car.onGround && p.pos.y < 2.6 && dist < 6.5 && dist > 3.6 && ang < 0.2 && flat(car.vel).length() > 16 && p.t < 0.35)
        this.startMove("flip", 0);
    } else if (mode === "support") {
      let pad = null;
      if (car.boost < 35 && !threat) {
        let pd = 45;
        for (const pv of match.pads) {
          if (!pv.big || pv.timer > 0 || (pv.pos.z - ball.pos.z) * a > 0) continue;
          const d = flat(new V3().subVectors(pv.pos, car.pos)).length();
          if (d < pd) { pd = d; pad = pv; }
        }
      }
      if (pad) { target = pad.pos.clone(); wantBoost = false; }
      else {
        const toGoal = flat(new V3().subVectors(ownGoal, ball.pos));
        const back = Math.min(35, toGoal.length() * 0.5);
        target = ball.pos.clone().addScaledVector(toGoal.normalize(), back); target.y = 0;
        target.x *= 0.6; arrive = true;
        wantBoost = car.pos.distanceTo(target) > 30;
      }
    } else if (mode === "keeper") {
      const x = clamp(ball.pos.x * 0.35, -GW + 2.5, GW - 2.5);
      target = new V3(x, 0, ownGoal.z + a * 2.5); arrive = true;
    } else if (mode === "shadow") {
      const toBall = new V3().subVectors(ball.pos, ownGoal); toBall.y = 0;
      target = ownGoal.clone().addScaledVector(toBall, 0.42); target.z += a * 3; arrive = true;
    } else {                                       // retreat to the far post, around the ball
      const side = ball.pos.x > 0 ? -1 : 1;
      target = new V3(side * GW * 0.6, 0, ownGoal.z + a * 3);
      const lineDist = distToSegment2D(ball.pos, car.pos, target);
      if (lineDist < 4.5 && (ball.pos.z - car.pos.z) * -a > 0) target.x += side * 8;   // swing around the ball
      wantBoost = car.pos.distanceTo(target) > 20;
    }
    target.add(mode === "attack" ? new V3(0, 0, 0) : this.offset);
    this.steerTo(c, target, arrive, ball);
    c.boost = wantBoost && car.boost > 0 && Math.random() < this.boostWill + 0.2;
    this.lastTarget = target;
    return c;
  }
  steerTo(c, target, arrive, ball) {
    const car = this.car;
    // Angle to the target measured in the plane the car is driving on (floor or wall). + means to the left.
    const n = car.onGround ? car.up() : UP.clone();
    const to = new V3().subVectors(target, car.pos); to.addScaledVector(n, -to.dot(n));
    if (car.onGround && n.y < 0.8) to.addScaledVector(new V3(0, -1, 0).addScaledVector(n, n.y), 12);   // on a wall: head back down
    const dist = to.length();
    const fwd = car.forward();
    const ang = Math.atan2(new V3().crossVectors(fwd, to).dot(n), fwd.dot(to));
    const speed = car.vel.dot(fwd);
    if (car.onGround) {
      if (arrive && dist < 2.5) {
        // Parked: face the ball, creep if needed
        const tb = new V3().subVectors(ball.pos, car.pos); tb.addScaledVector(n, -tb.dot(n));
        const bang = Math.atan2(new V3().crossVectors(fwd, tb).dot(n), fwd.dot(tb));
        c.steer = clamp(-bang * 2, -1, 1);
        c.throttle = Math.abs(bang) > 0.4 ? (speed > 3 ? -1 : 0.6) : (Math.abs(speed) > 2 ? -Math.sign(speed) : 0);
        return;
      }
      if (Math.abs(ang) > 2.3 && dist < 12) {   // close and behind us: reverse into it
        c.throttle = -1; c.steer = clamp(wrapAngle(ang - Math.PI) * 2, -1, 1);
        return;
      }
      c.steer = clamp(-ang * 2.5, -1, 1);
      c.slide = Math.abs(ang) > 1.4 && speed > 12;
      const want = arrive ? clamp(dist * 1.6, 0, MAX_DRIVE) : MAX_DRIVE + 20;
      c.throttle = speed < want ? 1 : (speed > want + 4 ? -1 : 0);
    } else {
      // In the air: keep the nose level and point toward the target
      const f = car.forward();
      c.throttle = clamp(f.y * 3, -1, 1);
      c.steer = clamp(-ang, -1, 1);
      const u = car.up();
      c.roll = clamp(u.dot(car.left()) * -2, -1, 1);
    }
  }
  // Split-second reactions on top of the (slower) plan: dodge demolitions, block shots on goal
  reflexes(plan, ball, opps) {
    const car = this.car, a = this.a;
    if (!car.onGround || this.move) return plan;
    // A supersonic car is about to demolish us: hop
    for (const opp of opps) {
      if (opp.demolished || opp.speed() <= SUPERSONIC * 0.95) continue;
      const rel = new V3().subVectors(car.pos, opp.pos), d = rel.length();
      const closing = new V3().subVectors(opp.vel, car.vel).dot(rel.normalize());
      if (closing > 15 && d / closing < 0.3) { this.startMove("hop"); return this.runMove(0, ball); }
    }
    // Shot heading over us near our net: jump to block
    const towardNet = ball.vel.z * -a;
    const ownZ = -a * HL;
    if (towardNet > 8 && Math.abs(car.pos.z - ownZ) < 45 && (car.pos.z - ball.pos.z) * a < 0) {
      const t = Math.abs(car.pos.z - ball.pos.z) / towardNet;
      if (t < 0.5) {
        const y = ball.pos.y + ball.vel.y * t - 0.5 * BALL_G * t * t;
        const x = ball.pos.x + ball.vel.x * t;
        if (Math.abs(x - car.pos.x) < 3.2 && y > 2.4 && y < 8) {
          this.startMove(y > 5.5 ? "double" : "jump"); return this.runMove(0, ball);
        }
      }
    }
    return plan;
  }
}
function etaOf(car, target) {
  const to = flat(new V3().subVectors(target, car.pos));
  const ang = Math.abs(wrapAngle(Math.atan2(to.x, to.z) - (car.onGround ? car.yaw : Math.atan2(car.forward().x, car.forward().z))));
  const v = Math.max(flat(car.vel).length(), 8);
  return to.length() / ((v + (car.boost > 15 ? 40 : MAX_DRIVE)) / 2) + ang * 0.45;
}
function distToSegment2D(p, a, b) {
  const ax = b.x - a.x, az = b.z - a.z, L = ax * ax + az * az || 1;
  const t = clamp(((p.x - a.x) * ax + (p.z - a.z) * az) / L, 0, 1);
  return Math.hypot(p.x - (a.x + ax * t), p.z - (a.z + az * t));
}

// ---- Boost pads -----------------------------------------------------------------
class Pad {
  constructor(x, z, big) { this.pos = new V3(x, 0, z); this.big = big; this.amount = big ? 100 : 12; this.cooldown = big ? 10 : 4; this.timer = 0; }
}
function makePads() {
  // Rocket League's Soccar layout (unreal units / 50): 6 big pads, 28 small ones
  const big = [[-3584, 0], [3584, 0], [-3072, -4096], [3072, -4096], [-3072, 4096], [3072, 4096]];
  const half = [[0, -4240], [-1792, -4184], [1792, -4184], [-940, -3308], [940, -3308], [0, -2816], [-3584, -2484], [3584, -2484],
    [-1788, -2300], [1788, -2300], [-2048, -1036], [0, -1024], [2048, -1036]];
  const small = [...half, ...half.map(([x, y]) => [x, -y]), [-1024, 0], [1024, 0]];
  return [...big.map(([x, y]) => new Pad(x / 50, y / 50, true)), ...small.map(([x, y]) => new Pad(x / 50, y / 50, false))];
}

// ---- Match -------------------------------------------------------------------------
// Kickoff spots for blue as (x, z) fractions of the half width / half length. Orange is mirrored.
const KICK_SPOTS = [[-0.5, -0.5], [0.5, -0.5], [-0.0625, -0.75], [0.0625, -0.75], [0, -0.9]];
const PRESETS = {                    // used by the browser menus
  bot: { teamSize: 3, humans: [0] },
  duel: { teamSize: 1, humans: [0] },
  "2p": { teamSize: 3, humans: [0, 3] },
  watch: { teamSize: 3, humans: [] },
};
function shuffled(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
class Match {
  // opts: { mode, teamSize, humans: [car indices], skill, names: [...] }
  // Cars 0..n-1 are blue, n..2n-1 are orange.
  constructor(opts = {}) {
    if (typeof opts === "string") opts = Object.assign({ mode: opts }, PRESETS[opts]);
    this.mode = opts.mode || "bot"; this.skill = opts.skill ?? 1;
    this.teamSize = opts.teamSize || 3;
    const n = this.teamSize, humans = new Set(opts.humans || []);
    this.cars = [];
    let botNo = 1;
    for (let i = 0; i < 2 * n; i++) {
      const team = i < n ? 0 : 1;
      let name = opts.names && opts.names[i];
      if (!name) {
        if (humans.has(i)) name = this.mode === "2p" ? (i === 0 ? "P1" : "P2") : "YOU";
        else name = n === 1 ? "TEMUBOT" : "TEMUBOT " + botNo++;
      }
      const car = new Car(team, name); car.idx = i; car.human = humans.has(i);
      this.cars.push(car);
    }
    this.ball = new Ball();
    this.pads = makePads();
    this.bots = {};
    const humanTeams = new Set([...humans].map((i) => (i < n ? 0 : 1)));
    for (let i = 0; i < 2 * n; i++) {
      if (humans.has(i)) continue;
      // Bots on a human's team play at LIKE NEW; opponents use the chosen condition
      const team = i < n ? 0 : 1;
      const skill = humanTeams.size && !humanTeams.has(team) ? this.skill : 1;
      this.bots[i] = new TemuBot(this.cars[i], skill);
    }
    this.score = [0, 0]; this.timeLeft = MATCH_TIME; this.overtime = false; this.otTime = 0;
    this.toast = null; this.goalMsg = null; this.goalTimer = 0; this.events = [];
    this.goFlash = 0; this.winner = null; this.overT = 0; this.overLine = ""; this.clock = 0; this.lastTouch = -1;
    // Rocket League scoring: points per goal, assist, save, shot on goal and demolition
    this.stats = this.cars.map(() => ({ score: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0 }));
    this.touches = []; this.statCool = {}; this.lastShot = {};
    this.kickoff();
  }
  award(i, kind, pts) {
    const st = this.stats[i]; st[kind + "s"]++; st.score += pts;
    this.events.push({ type: "stat", car: i, kind, pts });
  }
  // Would this ball go into the goal at the `sign` end (+1 orange's net, -1 blue's) within 2.5 s?
  headedIn(b, sign) {
    for (const p of predictBall(b, NEUTRAL, 2.5, 1 / 20)) {
      if (Math.abs(p.pos.z) > HL) return Math.sign(p.pos.z) === sign;
    }
    return false;
  }
  onTouch(i, pre) {
    const car = this.cars[i], now = this.clock;
    this.touches.push({ car: i, team: car.team, t: now });
    if (this.touches.length > 30) this.touches.shift();
    if (this.state !== "play" || (this.statCool[i] || 0) > now) return;
    this.statCool[i] = now + 0.6;
    const ownEnd = car.team === 0 ? -1 : 1;
    if (this.headedIn(pre, ownEnd) && !this.headedIn(this.ball, ownEnd)) this.award(i, "save", 50);
    else if (this.headedIn(this.ball, -ownEnd)) { this.award(i, "shot", 20); this.lastShot[i] = now; }
  }
  team(t) { return this.cars.filter((c) => c.team === t); }
  setHuman(i, human, name) {          // used by the online server when people join or leave
    const car = this.cars[i];
    car.human = human; if (name) car.name = name;
    if (human) delete this.bots[i];
    else if (!this.bots[i]) { this.bots[i] = new TemuBot(car, 1); this.bots[i].mode = "attack"; }
  }
  kickoff() {
    const n = this.teamSize;
    const spots = shuffled(KICK_SPOTS).slice(0, n);
    for (let k = 0; k < n; k++) {
      const [kx, kz] = spots[k];
      const p0 = new V3(kx * HW, CAR_REST, kz * HL), p1 = new V3(-kx * HW, CAR_REST, -kz * HL);
      this.cars[k].spawn(p0, Math.atan2(-p0.x, -p0.z));
      this.cars[n + k].spawn(p1, Math.atan2(-p1.x, -p1.z));
    }
    for (const car of this.cars) { car.boost = 33; car.role = null; }
    for (const i in this.bots) this.bots[i].kickoff();
    this.ball.reset();
    this.touches = []; this.statCool = {};
    this.state = "countdown"; this.countdown = 3; this.goWord = choice(GO_WORDS); this.lastTouch = -1;
    this.events.push({ type: "kickoff" });
  }
  // Team rotation: closest car that is goal-side of the ball attacks, the car nearest our net
  // stays back, anyone else supports. Humans count too, so bot teammates play around you.
  assignRoles() {
    for (const t of [0, 1]) {
      const team = this.team(t);
      if (team.length === 1) { team[0].role = "solo"; continue; }
      const a = t === 0 ? 1 : -1, ownZ = -a * HL;
      const live = team.filter((c) => !c.demolished);
      if (!live.length) continue;
      const score = (c) => etaOf(c, this.ball.pos) + ((this.ball.pos.z - c.pos.z) * a > -1.5 ? 0 : 1.5);
      let att = live.reduce((x, y) => (score(y) < score(x) ? y : x));
      const prev = live.find((c) => c.role === "attack");
      if (prev && prev !== att && score(prev) < score(att) + 0.4) att = prev;   // don't swap roles every frame
      const rest = live.filter((c) => c !== att);
      let keep = rest.reduce((x, y) => (Math.abs(y.pos.z - ownZ) < Math.abs(x.pos.z - ownZ) ? y : x), rest[0]);
      const prevKeep = rest.find((c) => c.role === "keeper");
      if (prevKeep && prevKeep !== keep && Math.abs(prevKeep.pos.z - ownZ) < Math.abs(keep.pos.z - ownZ) + 5) keep = prevKeep;
      for (const c of team) c.role = c === att ? "attack" : c === keep ? "keeper" : c.demolished ? null : "support";
    }
  }
  say(msg, team, secs) { this.toast = [msg, team, secs]; }
  mods() { return NEUTRAL; }
  update(dt, inputs) {
    this.clock += dt;
    this.goFlash = Math.max(0, this.goFlash - dt);
    if (this.toast) { this.toast[2] -= dt; if (this.toast[2] <= 0) this.toast = null; }
    if (this.state === "countdown") {
      this.countdown -= dt;
      if (this.countdown <= 0) { this.state = "play"; this.goFlash = 0.9; }
      return;
    }
    if (this.state === "over") { this.overT += dt; return; }
    const m = this.mods();
    this.assignRoles();
    const controls = this.cars.map((car, i) => this.bots[i] ? this.bots[i].think(this.ball, this, m, dt) : (inputs && inputs[i]) || new Controls());
    const sdt = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) {
      this.cars.forEach((car, i) => car.update(controls[i], sdt, m));
      this.ball.step(sdt, m);
      const before = this.events.length, pre = { pos: this.ball.pos.clone(), vel: this.ball.vel.clone(), r: this.ball.r };
      collideCarsBall(this.cars, this.ball, this.events);
      const after = this.events.length;
      for (let k = before; k < after; k++) {
        const e = this.events[k];
        if (e.type === "touch") { this.lastTouch = e.team; this.onTouch(e.car, pre); }
      }
      this.collideCars();
      collideArena(this.ball.pos, this.ball.vel, this.ball.r, BALL_E * m.ballE, 0.04);
      this.sanity();
      if (this.state === "play") this.checkGoal();
    }
    this.updatePads(dt);
    if (this.state === "play") {
      if (this.overtime) this.otTime += dt;
      else {
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          this.timeLeft = 0;
          if (this.score[0] !== this.score[1]) this.finish();
          else { this.overtime = true; this.say("OVERTIME! BONUS TIME, NO REFUNDS", -1, 2.5); }
        }
      }
    } else if (this.state === "goal") {
      this.goalTimer -= dt;
      if (this.goalTimer <= 0) { if (this.overtime) this.finish(); else this.kickoff(); }
    }
  }
  updatePads(dt) {
    for (const pad of this.pads) {
      pad.timer = Math.max(0, pad.timer - dt);
      if (pad.timer > 0) continue;
      for (const car of this.cars) {
        if (car.demolished || car.boost >= 99.5 || car.pos.y > 3) continue;
        const d = Math.hypot(car.pos.x - pad.pos.x, car.pos.z - pad.pos.z);
        if (d < (pad.big ? 2.4 : 1.6)) {
          car.boost = Math.min(100, car.boost + pad.amount); pad.timer = pad.cooldown;
          this.events.push({ type: "pad", big: pad.big, team: car.team, car: car.idx });
          break;
        }
      }
    }
  }
  sanity() {
    const b = this.ball, bad = (v) => !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z);
    if (bad(b.pos) || bad(b.vel) || Math.abs(b.pos.x) > HW + 5 || Math.abs(b.pos.z) > HL + GD + 5 || b.pos.y < -2 || b.pos.y > CEIL + 5) b.reset();
    for (const car of this.cars) {
      if (bad(car.pos) || bad(car.vel) || Math.abs(car.pos.x) > HW + 5 || Math.abs(car.pos.z) > HL + GD + 5)
        car.spawn(new V3(0, CAR_REST, car.homeZ), car.team === 0 ? 0 : Math.PI);
    }
  }
  checkGoal() {
    const z = this.ball.pos.z, r = this.ball.r;
    if (z > HL + r) this.goal(0);          // into orange's net: blue scores
    else if (z < -HL - r) this.goal(1);
  }
  goal(team) {
    this.score[team]++;
    this.state = "goal"; this.goalTimer = GOAL_PAUSE;
    const own = this.lastTouch !== -1 && this.lastTouch !== team;
    this.goalMsg = [own ? "OWN GOAL! (NO REFUNDS)" : choice(GOAL_MSGS), team];
    // Scorer: the scoring team's last touch. Assist: a different teammate's touch shortly before it.
    let scorer = -1, assist = -1;
    if (!own) {
      for (let k = this.touches.length - 1; k >= 0; k--) {
        const tc = this.touches[k];
        if (scorer < 0) { if (tc.team === team) scorer = tc.car; continue; }
        if (tc.team !== team) break;
        if (tc.car !== scorer && this.clock - tc.t < 6) { assist = tc.car; break; }
      }
      if (scorer >= 0) {
        if (!(this.lastShot[scorer] > this.clock - 4)) this.award(scorer, "shot", 20);   // every goal counts as a shot
        this.award(scorer, "goal", 100);
      }
      if (assist >= 0) this.award(assist, "assist", 50);
    }
    this.events.push({ type: "goal", team, pos: this.ball.pos.clone(), msg: this.goalMsg[0], scorer, assist });
    for (const car of this.cars) {                       // goal explosion
      if (car.demolished) continue;
      const d = new V3().subVectors(car.pos, this.ball.pos), dist = d.length();
      if (dist < 25) {
        d.normalize(); d.y = Math.max(d.y, 0.5);
        car.vel.addScaledVector(d.normalize(), 22 * (1 - dist / 25) + 4);
        if (car.vel.y > 2) { car.leaveGround(); car.canDodge = false; car.airTime = 2; }
      }
    }
  }
  finish() {
    this.state = "over"; this.overT = 0;
    this.winner = this.score[0] > this.score[1] ? 0 : 1;
    const humanTeams = new Set(this.cars.filter((c) => c.human).map((c) => c.team));
    if ((this.mode === "bot" || this.mode === "duel") && humanTeams.size === 1 && !humanTeams.has(this.winner)) {
      const cond = BOT_SKILLS[this.skill][0].toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
      this.overLine = `TemuBots (${cond}) win. Better luck next order.`;
    } else this.overLine = choice(OVER_LINES);
    this.events.push({ type: "over", winner: this.winner, line: this.overLine });
  }
  collideCars() {
    const cars = this.cars, R = CAR_BUMP_R * 2;
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      if (a.demolished || b.demolished) continue;
      const d = new V3().subVectors(b.pos, a.pos), dist = d.length();
      if (dist >= R || dist < 1e-6) continue;
      const n = d.multiplyScalar(1 / dist);
      if (a.team !== b.team) {                         // no demolishing your own teammates
        const rams = (att, sgn) => { const sp = att.speed(); return sp > SUPERSONIC && att.vel.dot(n) * sgn > 0.7 * sp; };
        const aR = rams(a, 1), bR = rams(b, -1);
        if (aR !== bR) { if (aR) this.demolish(b, a); else this.demolish(a, b); continue; }
      }
      a.pos.addScaledVector(n, -(R - dist) / 2); b.pos.addScaledVector(n, (R - dist) / 2);
      const vn = new V3().subVectors(b.vel, a.vel).dot(n);
      if (vn < 0) {
        const imp = -(1 + 0.5) * vn / 2;
        a.vel.addScaledVector(n, -imp); b.vel.addScaledVector(n, imp);
        for (const car of [a, b]) {                    // a good bump knocks a car off its wheels
          if (car.onGround && imp > 6) { car.vel.addScaledVector(car.up(), Math.min(imp * 0.35, 6)); car.leaveGround(); car.canDodge = false; car.airTime = 2; }
        }
      }
    }
  }
  demolish(victim, attacker) {
    victim.demolished = true; victim.respawn = RESPAWN_TIME; victim.boosting = false;
    this.events.push({ type: "demo", pos: victim.pos.clone(), team: victim.team, car: victim.idx, by: attacker.idx });
    this.award(attacker.idx, "demo", 25);
    this.say(choice(DEMO_MSGS), attacker.team, 1.8);
  }
}

if (typeof module !== "undefined") {
  module.exports = { Match, Car, Ball, TemuBot, Controls, Pad, predictBall, collideArena, sdArena, arenaNormal, BOT_SKILLS, PRESETS, LOOK_SIZES, DEFAULT_LOOK, cleanLook, randomLook, SUBSTEPS, NEUTRAL, RE, GRAVITY, GOAL_PAUSE,
    HW, HL, CEIL, GW, GH, GD, BALL_R, CAR_REST, MAX_SPEED, SUPERSONIC, MATCH_TIME, FPS, TEAM_NAMES, CAR_HX, CAR_HY, CAR_HZ };
}
