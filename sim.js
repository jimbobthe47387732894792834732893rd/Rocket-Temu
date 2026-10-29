"use strict";
// ==========================================================================
// ROCKET TEMU 3D — simulation (physics, rules, TemuBot). No DOM, no rendering.
// Units are meters and seconds. x = side to side, y = up, z = goal to goal.
// Blue defends the -z goal and attacks +z; orange the opposite.
// ==========================================================================
const V3 = THREE.Vector3, QT = THREE.Quaternion;
const UP = new V3(0, 1, 0);

// ---- Arena ---------------------------------------------------------------
const HW = 40, HL = 52, CEIL = 20, CH = 10;          // half width, half length, ceiling, corner chamfer
const GW = 9, GH = 8, GD = 8;                          // goal half-width, height, depth
const CHAMFER_D = (HW + HL - CH) / Math.SQRT2;

// ---- Ball ----------------------------------------------------------------
const BALL_R = 1.85, BALL_G = 13, BALL_E = 0.6, BALL_DRAG = 0.03, BALL_MAX = 80, BALL_ROLL_FRICTION = 0.3;

// ---- Car -----------------------------------------------------------------
const GRAVITY = 13;
const CAR_HX = 0.84, CAR_HY = 0.36, CAR_HZ = 1.18;   // hitbox half extents (width, height, length)
const CAR_REST = 0.70;                                 // hitbox center height when on its wheels
const CAR_WALL_R = 1.25;                               // sphere used against walls and goals
const CAR_BUMP_R = 1.5;                                // sphere used car-vs-car
const MAX_DRIVE = 26, MAX_SPEED = 44, SUPERSONIC = 41, BOOST_ACCEL = 19;
const BRAKE = 70, COAST = 10.5, BOOST_USE = 33.3;
const JUMP_VEL = 9.5, DOUBLE_JUMP = 7, DODGE_IMPULSE = 11, DODGE_WINDOW = 1.25, FLIP_TIME = 0.6;
const PITCH_RATE = 5.5, YAW_RATE = 4.5, ROLL_RATE = 5.5;
const CAR_MASS = 180, BALL_MASS = 30;
const MATCH_TIME = 180, SUBSTEPS = 2, FPS = 60;

const TEAM_NAMES = ["BLU", "ORANG"];
const GOAL_MSGS = ["GOAL! (DELIVERED)", "GOAL! LEFT AT THE NET", "GOAL! YOUR ORDER HAS ARRIVED",
  "GOOOAL! (SPELLING MAY VARY)", "GOAL! 5 STARS, WOULD SCORE AGAIN", "GOAL! RETURNS NOT ACCEPTED"];
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

// Steering curvature (1/m) as a function of speed, from the real game's table scaled to these units.
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
function throttleAccel(s) { return s < 25 ? 32 - 28.8 * (s / 25) : s < MAX_DRIVE ? 3.2 : 0; }

// ---- Arena collision for a sphere --------------------------------------------
// Pushes the sphere out of every surface it overlaps and reflects its velocity.
// Returns true when it is resting on / touching the floor.
function pushPlane(pos, vel, r, nx, ny, nz, d, e, fric) {
  const dist = nx * pos.x + ny * pos.y + nz * pos.z + r - d;
  if (dist <= 0) return false;
  pos.x -= nx * dist; pos.y -= ny * dist; pos.z -= nz * dist;
  const vn = vel.x * nx + vel.y * ny + vel.z * nz;
  if (vn > 0) {
    vel.x -= nx * vn; vel.y -= ny * vn; vel.z -= nz * vn;          // remove normal part
    if (fric && vn > 3) { vel.x *= 1 - fric; vel.y *= 1 - fric; vel.z *= 1 - fric; }   // only on real bounces
    vel.x -= nx * vn * e; vel.y -= ny * vn * e; vel.z -= nz * vn * e;   // bounce
  }
  return true;
}
const _seg = new V3(), _cl = new V3(), _d = new V3();
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
function collideArena(pos, vel, r, e, withFloor, fric = 0) {
  let floor = false;
  if (withFloor) floor = pushPlane(pos, vel, r, 0, -1, 0, 0, e, fric);
  pushPlane(pos, vel, r, 0, 1, 0, CEIL, e, 0);
  pushPlane(pos, vel, r, 1, 0, 0, HW, e, 0);
  pushPlane(pos, vel, r, -1, 0, 0, HW, e, 0);
  const k = Math.SQRT1_2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) pushPlane(pos, vel, r, sx * k, 0, sz * k, CHAMFER_D, e, 0);
  const sz = pos.z >= 0 ? 1 : -1;
  const inMouth = Math.abs(pos.x) <= GW && pos.y <= GH;
  if (Math.abs(pos.z) > HL) {                       // inside a goal
    pushPlane(pos, vel, r, 1, 0, 0, GW, 0.3, 0);
    pushPlane(pos, vel, r, -1, 0, 0, GW, 0.3, 0);
    pushPlane(pos, vel, r, 0, 1, 0, GH, 0.3, 0);
    pushPlane(pos, vel, r, 0, 0, sz, HL + GD, 0.25, 0);
  } else if (!inMouth) {
    pushPlane(pos, vel, r, 0, 0, sz, HL, e, 0);
  }
  if (Math.abs(pos.z) > HL - r - 0.5) for (const [a, b] of POSTS) pushSegment(pos, vel, r, a, b, e);
  return floor;
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
    const onFloor = collideArena(this.pos, this.vel, this.r, BALL_E * m.ballE, true, 0.04);
    if (onFloor && Math.abs(this.vel.y) < 1.2) {
      this.vel.y = 0;
      this.vel.x *= 1 - BALL_ROLL_FRICTION * dt; this.vel.z *= 1 - BALL_ROLL_FRICTION * dt;
      this.spin.set(this.vel.z / this.r, 0, -this.vel.x / this.r);     // rolling
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

// ---- Car -------------------------------------------------------------------
class Car {
  constructor(team, name) {
    this.team = team; this.name = name;
    this.pos = new V3(); this.vel = new V3(); this.quat = new QT(); this.angVel = new V3();
    this.homeZ = team === 0 ? -(HL - 4) : HL - 4;
    this.boostUse = 1;                                   // premium sellers get premium shipping (boost lasts longer)
    this.spawn(new V3(0, CAR_REST, this.homeZ), team === 0 ? 0 : Math.PI);
    this.boost = 33;
  }
  spawn(pos, yaw) {
    this.pos.copy(pos); this.pos.y = CAR_REST; this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    this.yaw = yaw; this.quat.setFromAxisAngle(UP, yaw);
    this.onGround = true; this.boosting = false; this.jumpPrev = false; this.airTime = 0;
    this.canDodge = false; this.hasDoubled = false; this.flipLeft = 0; this.flipAxis = new V3();
    this.demolished = false; this.respawn = 0; this.supersonicT = 0;
  }
  forward() { return new V3(0, 0, 1).applyQuaternion(this.quat); }
  up() { return new V3(0, 1, 0).applyQuaternion(this.quat); }
  left() { return new V3(1, 0, 0).applyQuaternion(this.quat); }
  speed() { return this.vel.length(); }
  update(c, dt, m) {
    if (this.demolished) {
      this.respawn -= dt;
      if (this.respawn <= 0) {                     // respawn in front of our own goal
        const boost = this.boost;
        this.spawn(new V3(uniform(-6, 6), CAR_REST, this.homeZ), this.team === 0 ? 0 : Math.PI);
        this.boost = Math.max(33, boost);
      }
      return;
    }
    const jumpPressed = c.jump && !this.jumpPrev;
    this.jumpPrev = c.jump;
    this.boosting = c.boost && (this.boost > 0 || m.unlimited);
    const top = MAX_SPEED * m.speed;
    if (this.onGround) this.drive(c, dt, m, jumpPressed);
    else this.fly(c, dt, m, jumpPressed);
    if (this.boosting && !m.unlimited) this.boost = Math.max(0, this.boost - BOOST_USE * dt * this.boostUse);
    const s = this.vel.length();
    if (s > top) this.vel.multiplyScalar(top / s);
    this.supersonicT = s > SUPERSONIC ? this.supersonicT + dt : 0;
    this.pos.addScaledVector(this.vel, dt);
    this.collide();
  }
  drive(c, dt, m, jumpPressed) {
    const f = new V3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    let s = this.vel.dot(f);
    const lat = this.vel.clone().addScaledVector(f, -s); lat.y = 0;
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
    this.yaw -= turn * dt;
    const f2 = new V3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.vel.copy(f2.multiplyScalar(s)).add(lat);
    this.vel.y = 0;
    this.quat.setFromAxisAngle(UP, this.yaw);
    this.angVel.set(0, -turn, 0);
    if (jumpPressed) {
      this.onGround = false; this.vel.y = JUMP_VEL; this.pos.y += 0.05;
      this.airTime = 0; this.canDodge = true; this.hasDoubled = false;
    }
  }
  fly(c, dt, m, jumpPressed) {
    this.airTime += dt;
    // Local angular velocity: x = pitch (nose down positive), y = yaw, z = roll
    const inv = this.quat.clone().invert();
    const w = this.angVel.clone().applyQuaternion(inv);
    if (this.flipLeft > 0) {
      this.flipLeft -= dt;
      w.copy(this.flipAxis);
      if (this.flipLeft <= 0) w.multiplyScalar(0.2);
    } else {
      const target = new V3(c.throttle * PITCH_RATE, -c.steer * YAW_RATE, c.roll * ROLL_RATE);
      w.lerp(target, Math.min(1, 9 * dt));
    }
    if (jumpPressed && this.canDodge && this.airTime < DODGE_WINDOW) {
      this.canDodge = false;
      if (c.throttle !== 0 || c.steer !== 0) {      // dodge / flip in the pressed direction
        const yawF = flat(this.forward()).normalize(), yawL = new V3(yawF.z, 0, -yawF.x).negate();
        const dir = yawF.clone().multiplyScalar(c.throttle).addScaledVector(yawL, -c.steer);
        if (dir.lengthSq() > 0) dir.normalize();
        this.vel.addScaledVector(dir, DODGE_IMPULSE);
        this.vel.y = Math.max(this.vel.y * 0.25, 0);
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
    if (this.boosting) this.vel.addScaledVector(this.forward(), BOOST_ACCEL * dt);
    this.vel.y -= GRAVITY * m.grav * dt;
  }
  land() {
    const f = flat(this.forward());
    if (f.lengthSq() < 1e-4) f.copy(flat(this.up().negate()));   // landed nose-down: use belly direction
    this.yaw = Math.atan2(f.x, f.z);
    this.quat.setFromAxisAngle(UP, this.yaw);                     // auto-landing (feature may vary)
    this.onGround = true; this.flipLeft = 0; this.canDodge = false;
    this.vel.y = 0; this.pos.y = CAR_REST; this.angVel.set(0, 0, 0);
  }
  collide() {
    collideArena(this.pos, this.vel, CAR_WALL_R, 0.2, false);
    if (this.onGround) { this.pos.y = CAR_REST; return; }
    if (this.pos.y <= CAR_REST) {
      if (this.vel.y <= 0) this.land();
      else this.pos.y = CAR_REST;
    }
    if (this.pos.y > CEIL - CAR_WALL_R) { this.pos.y = CEIL - CAR_WALL_R; if (this.vel.y > 0) this.vel.y *= -0.2; }
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
    const top = car.boost > 15 ? 36 : MAX_DRIVE;
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
      else if (ballToGoal < 22 || !oppCanShoot || first || (this.mode === "attack" && myEta < oppEta + 0.25)) mode = "attack";
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
      else if (!kickoffBall && ballToGoal < 28 && myEta + 0.2 < oppEta) mode = "attack";
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
      if (ballToGoal < 20) target = p.pos.clone().addScaledVector(shotDir, -1);
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
        let pd = 30;
        for (const pv of match.pads) {
          if (!pv.big || pv.timer > 0 || (pv.pos.z - ball.pos.z) * a > 0) continue;
          const d = flat(new V3().subVectors(pv.pos, car.pos)).length();
          if (d < pd) { pd = d; pad = pv; }
        }
      }
      if (pad) { target = pad.pos.clone(); wantBoost = false; }
      else {
        const toGoal = flat(new V3().subVectors(ownGoal, ball.pos));
        const back = Math.min(22, toGoal.length() * 0.5);
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
    const to = flat(new V3().subVectors(target, car.pos));
    const dist = to.length();
    const ang = wrapAngle(Math.atan2(to.x, to.z) - car.yaw);          // + means target is to the left
    const speed = car.vel.dot(new V3(Math.sin(car.yaw), 0, Math.cos(car.yaw)));
    if (car.onGround) {
      if (arrive && dist < 2.5) {
        // Parked: face the ball, creep if needed
        const tb = flat(new V3().subVectors(ball.pos, car.pos));
        const bang = wrapAngle(Math.atan2(tb.x, tb.z) - car.yaw);
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
    if (towardNet > 8 && Math.abs(car.pos.z - ownZ) < 30 && (car.pos.z - ball.pos.z) * a < 0) {
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
  return to.length() / ((v + (car.boost > 15 ? 36 : MAX_DRIVE)) / 2) + ang * 0.45;
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
  const pads = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) pads.push(new Pad(sx * (HW - 7), sz * (HL - 10), true));
  for (const sx of [-1, 1]) pads.push(new Pad(sx * (HW - 4), 0, true));
  const small = [[0, -HL + 12], [0, HL - 12], [-14, -30], [14, -30], [-14, 30], [14, 30], [-24, -12], [24, -12], [-24, 12], [24, 12],
    [0, -18], [0, 18], [-10, 0], [10, 0]];
  for (const [x, z] of small) pads.push(new Pad(x, z, false));
  return pads;
}

// ---- Match -------------------------------------------------------------------------
// Kickoff spots for blue as (x, z) fractions of the half width / half length. Orange is mirrored.
const KICK_SPOTS = [[-0.42, -0.5], [0.42, -0.5], [-0.08, -0.68], [0.08, -0.68], [0, -0.84]];
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
    this.kickoff();
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
      const before = this.events.length;
      collideCarsBall(this.cars, this.ball, this.events);
      for (let k = before; k < this.events.length; k++) if (this.events[k].type === "touch") this.lastTouch = this.events[k].team;
      this.collideCars();
      collideArena(this.ball.pos, this.ball.vel, this.ball.r, BALL_E * m.ballE, true, 0.04);
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
    this.state = "goal"; this.goalTimer = 3.4;
    const own = this.lastTouch !== -1 && this.lastTouch !== team;
    this.goalMsg = [own ? "OWN GOAL! (NO REFUNDS)" : choice(GOAL_MSGS), team];
    this.events.push({ type: "goal", team, pos: this.ball.pos.clone(), msg: this.goalMsg[0] });
    for (const car of this.cars) {                       // goal explosion
      if (car.demolished) continue;
      const d = new V3().subVectors(car.pos, this.ball.pos), dist = d.length();
      if (dist < 25) {
        d.normalize(); d.y = Math.max(d.y, 0.5);
        car.vel.addScaledVector(d.normalize(), 22 * (1 - dist / 25) + 4);
        if (car.vel.y > 2) { car.onGround = false; car.canDodge = false; car.airTime = 2; }
      }
    }
  }
  finish() {
    this.state = "over"; this.overT = 0;
    this.winner = this.score[0] > this.score[1] ? 0 : 1;
    const humanTeams = new Set(this.cars.filter((c) => c.human).map((c) => c.team));
    if ((this.mode === "bot" || this.mode === "duel") && humanTeams.size === 1 && !humanTeams.has(this.winner)) {
      const cond = BOT_SKILLS[this.skill][0].toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
      this.overLine = `TemuBots (${cond}) win. Please leave a 5-star review anyway.`;
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
      for (const car of [a, b]) if (car.pos.y < CAR_REST) car.pos.y = CAR_REST;
      const vn = new V3().subVectors(b.vel, a.vel).dot(n);
      if (vn < 0) {
        const imp = -(1 + 0.5) * vn / 2;
        a.vel.addScaledVector(n, -imp); b.vel.addScaledVector(n, imp);
        for (const car of [a, b]) {                    // a good bump knocks a car off its wheels
          if (car.onGround && imp > 6) { car.vel.y += Math.min(imp * 0.35, 6); car.onGround = false; car.canDodge = false; car.airTime = 2; }
        }
      }
    }
  }
  demolish(victim, attacker) {
    victim.demolished = true; victim.respawn = 2; victim.boosting = false;
    this.events.push({ type: "demo", pos: victim.pos.clone(), team: victim.team, car: victim.idx, by: attacker.idx });
    this.say(choice(DEMO_MSGS), attacker.team, 1.8);
  }
}

if (typeof module !== "undefined") {
  module.exports = { Match, Car, Ball, TemuBot, Controls, Pad, predictBall, collideArena, BOT_SKILLS, PRESETS, SUBSTEPS, NEUTRAL,
    HW, HL, CEIL, GW, GH, GD, BALL_R, CAR_REST, MAX_SPEED, SUPERSONIC, MATCH_TIME, FPS, TEAM_NAMES, CAR_HX, CAR_HY, CAR_HZ };
}
