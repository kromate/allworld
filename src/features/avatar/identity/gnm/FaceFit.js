// XR Blocks fitter, modified in the likeness lab for shared-frame identity,
// then limited here to the 468-point saved meshes and identity solve only.
/**
 * FaceFit.js — GNM parameters from MediaPipe face landmarks.
 *
 * `fitIdentity` aligns each tracked point cloud onto the model with a
 * closed-form similarity fit and projects the remaining shape onto a PCA
 * basis with ridge regularization. The optional frames share one identity.
 *
 * Ported from https://github.com/edualvarado/gnm-webcam-puppet (Apache-2.0),
 * whose comments record the measurements behind the constants. Three of those
 * findings carry the whole thing:
 *
 * - **The fit is differential.** Landmarks are compared against where the
 *   landmarker puts them on a neutral head (`FACE_CORRESPONDENCE.reference`),
 *   not against the GNM vertices they map to. The two differ by ~11 mm rms in
 *   z, because the landmarker carries its own idea of face shape. Against the
 *   template that constant bias is indistinguishable from a very deep face and
 *   lands in the coefficients; against the reference it cancels exactly.
 * - **Only leading components are solved for.** The normal matrix' eigenvalues
 *   span five orders of magnitude, so no single ridge both frees the head of
 *   the basis and restrains its tail. The basis is ordered by variance
 *   explained, so truncating is the honest cut.
 * - **Depth is damped, not trusted.** MediaPipe's z is not metric and is by far
 *   the noisiest axis, but it still carries real brow and nose projection.
 *
 * Adapted here for this demo's int8-quantized bases: every basis read folds in
 * the component's float32 scale, so solved coefficients come out in the same
 * units `GNMHeadModel.setIdentityVector` expects.
 *
 * Dependency-free (typed arrays only), so it runs in a browser worker.
 */

import {FACE_CORRESPONDENCE, REQUIRED_LANDMARKS} from './FaceCorrespondence.js';

/**
 * Tuned by the upstream project on synthetic raw frames with 2 px of landmark jitter
 * and depth error at 2% of face width, scored as whole-mesh rms against the
 * face that generated the frame: the template scores 5.7 mm there, these score
 * about 1.8 mm. That result has not been remeasured for saved 468-point meshes.
 */
const IDENTITY_DEFAULTS = {
  iterations: 4,
  // 24 leading components. Fewer cannot express the face; more chase noise,
  // and 64 doubles the error at the same ridge.
  components: 24,
  ridge: 0.06,
  // Low, but not zero: dropping depth entirely costs accuracy when z is good,
  // and trusting it costs far more when z is bad.
  depthWeight: 0.1,
  limit: 3,
  rigidOnly: true,
};

const RETARGET_DEFAULTS = {
  // Looser than the identity fit's: expression is what we *want* to move, and
  // it is re-solved every frame rather than committed to once.
  ridge: 0.02,
  depthWeight: 0.1,
  limit: 3,
  smoothing: 0.45,
  gain: 1,
  // The mouth's most important knob, and a *conditioning* limit rather than an
  // expressiveness one. Solving all 150 lower-face components against sparse
  // noisy landmarks spends them fitting noise, in combinations large enough to
  // hit the clamp and wrong enough to invert the gross shape — upstream
  // measured the mouth *closing* as the subject opened theirs. Four components
  // tracked the real aperture with nothing clamped.
  regionBudget: {lower_face_region: 4},
  // Corrects a measured, near-constant shortfall rather than exaggerating:
  // handed MediaPipe's landmarks the mouth solve returns 72–77% of the true
  // aperture over a 3x range of opening. Not licence to tune other regions by
  // eye — they have no equivalent measurement.
  regionGain: {lower_face_region: 1.35},
};

/**
 * Splits ordered PCA names like `lower_face_region_000` into contiguous
 * regions, matching the grouping the parameter sliders use.
 *
 * @param {!Array<string>} names Ordered component names.
 * @return {!Object<string, {start: number, count: number}>} Regions by name.
 */
export function expressionRegions(names) {
  const regions = {};
  let key = null;
  names.forEach((name, index) => {
    const next = name.replace(/_?\d+$/, '').replace(/_mean$/, '');
    if (next !== key) {
      key = next;
      regions[key] = {start: index, count: 0};
    }
    regions[key].count++;
  });
  return regions;
}

/**
 * Converts MediaPipe normalized landmarks into GNM's axis convention.
 *
 * MediaPipe normalizes x by image width and y by image height, so raw values
 * are anisotropic unless the frame is square; its y grows downward and its z
 * away from the camera, both opposite to GNM. The result is defined only up to
 * a global scale — which the similarity fit solves for — so all that matters is
 * that the three axes end up sharing one scale.
 *
 * @param {!Array<{x: number, y: number, z: number}>} landmarks Source frame.
 * @param {!ArrayLike<number>} indices Which of them to take, in order.
 * @param {number} aspect Frame width divided by height.
 * @param {!Float64Array} out Destination, length `indices.length * 3`.
 * @return {!Float64Array} `out`.
 */
export function landmarksToModelAxes(landmarks, indices, aspect, out) {
  for (let i = 0; i < indices.length; ++i) {
    const landmark = landmarks[indices[i]];
    out[i * 3] = landmark.x * aspect;
    out[i * 3 + 1] = -landmark.y;
    // z shares x's normalization, so it takes the same aspect scaling.
    out[i * 3 + 2] = -landmark.z * aspect;
  }
  return out;
}

/**
 * Eigen-decomposition of a small symmetric matrix, by cyclic Jacobi rotations.
 * Only ever called on the 4x4 of `fitSimilarity`.
 *
 * @param {!Float64Array} matrix Row-major symmetric matrix, overwritten.
 * @param {number} n Side length.
 * @return {{values: !Float64Array, vectors: !Float64Array}} Eigenvalues, and
 *     row-major eigenvectors in columns.
 */
function jacobiEigen(matrix, n) {
  const vectors = new Float64Array(n * n);
  for (let i = 0; i < n; ++i) vectors[i * n + i] = 1;

  for (let sweep = 0; sweep < 32; ++sweep) {
    let off = 0;
    for (let p = 0; p < n; ++p) {
      for (let q = p + 1; q < n; ++q) {
        off += matrix[p * n + q] * matrix[p * n + q];
      }
    }
    if (off < 1e-24) break;

    for (let p = 0; p < n; ++p) {
      for (let q = p + 1; q < n; ++q) {
        const apq = matrix[p * n + q];
        if (Math.abs(apq) < 1e-18) continue;

        const theta = (matrix[q * n + q] - matrix[p * n + p]) / (2 * apq);
        const t =
          Math.sign(theta || 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; ++k) {
          const akp = matrix[k * n + p];
          const akq = matrix[k * n + q];
          matrix[k * n + p] = c * akp - s * akq;
          matrix[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; ++k) {
          const apk = matrix[p * n + k];
          const aqk = matrix[q * n + k];
          matrix[p * n + k] = c * apk - s * aqk;
          matrix[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; ++k) {
          const vkp = vectors[k * n + p];
          const vkq = vectors[k * n + q];
          vectors[k * n + p] = c * vkp - s * vkq;
          vectors[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const values = new Float64Array(n);
  for (let i = 0; i < n; ++i) values[i] = matrix[i * n + i];
  return {values, vectors};
}

/**
 * Fits the similarity transform taking source onto target, minimizing
 * `|scale * rotation @ source + translation - target|^2` in closed form by
 * Horn's quaternion method. Going through a quaternion rather than an SVD means
 * no reflection case to guard — a unit quaternion is a rotation by
 * construction.
 *
 * @param {!Float64Array} source Points, interleaved xyz.
 * @param {!Float64Array} target Points, interleaved xyz, same length.
 * @return {{scale: number, rotation: !Float64Array, translation:
 *     !Float64Array}} The transform; rotation is row-major 3x3.
 */
export function fitSimilarity(source, target) {
  if (source.length !== target.length) {
    throw new Error(
      `source and target must be the same length, got ${source.length} and ` +
        `${target.length}.`
    );
  }
  const count = source.length / 3;
  if (count < 3)
    throw new Error(`Need at least 3 points to fit, got ${count}.`);

  let sx = 0;
  let sy = 0;
  let sz = 0;
  let tx = 0;
  let ty = 0;
  let tz = 0;
  for (let i = 0; i < count; ++i) {
    sx += source[i * 3];
    sy += source[i * 3 + 1];
    sz += source[i * 3 + 2];
    tx += target[i * 3];
    ty += target[i * 3 + 1];
    tz += target[i * 3 + 2];
  }
  sx /= count;
  sy /= count;
  sz /= count;
  tx /= count;
  ty /= count;
  tz /= count;

  // Cross-covariance of the centred clouds, m[a * 3 + b] = sum(a_source * b_target).
  const m = new Float64Array(9);
  let sourceVariance = 0;
  for (let i = 0; i < count; ++i) {
    const ax = source[i * 3] - sx;
    const ay = source[i * 3 + 1] - sy;
    const az = source[i * 3 + 2] - sz;
    const bx = target[i * 3] - tx;
    const by = target[i * 3 + 1] - ty;
    const bz = target[i * 3 + 2] - tz;
    m[0] += ax * bx;
    m[1] += ax * by;
    m[2] += ax * bz;
    m[3] += ay * bx;
    m[4] += ay * by;
    m[5] += ay * bz;
    m[6] += az * bx;
    m[7] += az * by;
    m[8] += az * bz;
    sourceVariance += ax * ax + ay * ay + az * az;
  }

  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = m;
  const n = Float64Array.from([
    xx + yy + zz,
    yz - zy,
    zx - xz,
    xy - yx,
    yz - zy,
    xx - yy - zz,
    xy + yx,
    zx + xz,
    zx - xz,
    xy + yx,
    -xx + yy - zz,
    yz + zy,
    xy - yx,
    zx + xz,
    yz + zy,
    -xx - yy + zz,
  ]);

  const {values, vectors} = jacobiEigen(n, 4);
  let best = 0;
  for (let i = 1; i < 4; ++i) if (values[i] > values[best]) best = i;
  const qw = vectors[best];
  const qx = vectors[4 + best];
  const qy = vectors[8 + best];
  const qz = vectors[12 + best];

  const rotation = Float64Array.from([
    1 - 2 * (qy * qy + qz * qz),
    2 * (qx * qy - qw * qz),
    2 * (qx * qz + qw * qy),
    2 * (qx * qy + qw * qz),
    1 - 2 * (qx * qx + qz * qz),
    2 * (qy * qz - qw * qx),
    2 * (qx * qz - qw * qy),
    2 * (qy * qz + qw * qx),
    1 - 2 * (qx * qx + qy * qy),
  ]);

  // With the rotation known, scale is the ratio of aligned covariance to source
  // spread.
  let aligned = 0;
  for (let i = 0; i < count; ++i) {
    const ax = source[i * 3] - sx;
    const ay = source[i * 3 + 1] - sy;
    const az = source[i * 3 + 2] - sz;
    aligned +=
      (target[i * 3] - tx) *
        (rotation[0] * ax + rotation[1] * ay + rotation[2] * az) +
      (target[i * 3 + 1] - ty) *
        (rotation[3] * ax + rotation[4] * ay + rotation[5] * az) +
      (target[i * 3 + 2] - tz) *
        (rotation[6] * ax + rotation[7] * ay + rotation[8] * az);
  }
  const scale = aligned / Math.max(sourceVariance, 1e-12);

  const translation = Float64Array.from([
    tx - scale * (rotation[0] * sx + rotation[1] * sy + rotation[2] * sz),
    ty - scale * (rotation[3] * sx + rotation[4] * sy + rotation[5] * sz),
    tz - scale * (rotation[6] * sx + rotation[7] * sy + rotation[8] * sz),
  ]);

  return {scale, rotation, translation};
}

/**
 * Applies a similarity transform to interleaved xyz points.
 *
 * @param {!Float64Array} points Source points.
 * @param {{scale: number, rotation: !Float64Array, translation:
 *     !Float64Array}} transform The transform to apply.
 * @param {!Float64Array} out Destination, same length as `points`.
 * @return {!Float64Array} `out`.
 */
export function applySimilarity(points, transform, out) {
  const {scale, rotation: r, translation: t} = transform;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    out[i] = scale * (r[0] * x + r[1] * y + r[2] * z) + t[0];
    out[i + 1] = scale * (r[3] * x + r[4] * y + r[5] * z) + t[1];
    out[i + 2] = scale * (r[6] * x + r[7] * y + r[8] * z) + t[2];
  }
  return out;
}

/**
 * Solves `matrix @ x = rhs` for a symmetric positive-definite matrix.
 *
 * @param {!Float64Array} matrix Row-major, n x n.
 * @param {!Float64Array} rhs Right-hand side, length n.
 * @param {number} n Side length.
 * @return {!Float64Array} The solution.
 */
export function choleskySolve(matrix, rhs, n) {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; ++i) {
    for (let j = 0; j <= i; ++j) {
      let sum = matrix[i * n + j];
      for (let k = 0; k < j; ++k) sum -= l[i * n + k] * l[j * n + k];
      if (i === j) {
        if (sum <= 0)
          throw new Error('Normal matrix is not positive definite.');
        l[i * n + j] = Math.sqrt(sum);
      } else {
        l[i * n + j] = sum / l[j * n + j];
      }
    }
  }

  const y = new Float64Array(n);
  for (let i = 0; i < n; ++i) {
    let sum = rhs[i];
    for (let k = 0; k < i; ++k) sum -= l[i * n + k] * y[k];
    y[i] = sum / l[i * n + i];
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; --i) {
    let sum = y[i];
    for (let k = i + 1; k < n; ++k) sum -= l[k * n + i] * x[k];
    x[i] = sum / l[i * n + i];
  }
  return x;
}

/** Row-major 3x3 rotation to axis-angle. */
function matrixToAxisAngle(r, out) {
  // The trace gives the angle; the antisymmetric part gives the axis. Both
  // degenerate near 0 and pi, and a head pose never reaches pi, so only the
  // small-angle case needs handling.
  const trace = r[0] + r[4] + r[8];
  const angle = Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2)));
  const sin = Math.sin(angle);
  if (Math.abs(sin) < 1e-6) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const scale = angle / (2 * sin);
  out[0] = (r[7] - r[5]) * scale;
  out[1] = (r[2] - r[6]) * scale;
  out[2] = (r[3] - r[1]) * scale;
  return out;
}

/**
 * Throws unless the frame is long enough for the correspondence to index it.
 *
 * @param {!Array<{x: number, y: number, z: number}>} landmarks One frame.
 */
function checkFrame(landmarks) {
  if (landmarks.length < REQUIRED_LANDMARKS) {
    throw new Error(
      `The correspondence indexes landmark ${REQUIRED_LANDMARKS - 1}, but the ` +
        `frame has ${landmarks.length}.`
    );
  }
}

/**
 * Fits identity coefficients to one frame of tracked landmarks.
 *
 * Fitting shape needs the head's pose in model space, and estimating that pose
 * needs the shape, so the two alternate: a closed-form similarity fit for the
 * pose, a ridge-regularized linear solve for the shape, repeat. Both halves are
 * exact given the other, and four rounds is well past where either stops
 * moving.
 *
 * Expression is deliberately not attempted — a single frame cannot separate
 * "this face has a wide mouth" from "this face is smiling" — so the solve runs
 * only on the skull-fixed landmarks.
 *
 * @param {!GNMHeadModel} model The loaded head model.
 * @param {!Array<{x: number, y: number, z: number}>} landmarks One frame,
 *     normalized.
 * @param {number} aspect Frame width divided by height.
 * @param {!Object=} options Solver knobs; the defaults are what the UI uses.
 * @return {{identity: !Float32Array, transform: !Object, points: number,
 *     components: number, rmsBefore: number, rmsAfter: number, peak: number}}
 *     The fit, with residuals in mm.
 */
export function fitIdentity(model, landmarks, aspect, options = {}) {
  const correspondence = FACE_CORRESPONDENCE;
  const {iterations, ridge, depthWeight, limit, rigidOnly, components} = {
    ...IDENTITY_DEFAULTS,
    ...options,
  };
  checkFrame(landmarks);

  // Only the skull-fixed landmarks, so an expression on the face at capture
  // time cannot be absorbed into identity.
  const active = [];
  for (let i = 0; i < correspondence.count; ++i) {
    if (correspondence.landmarks[i] < landmarks.length && (!rigidOnly || correspondence.rigid[i])) active.push(i);
  }
  const count = active.length;
  const dim = Math.max(1, Math.min(components, model.identityDim));
  const rows = count * 3;
  const stride = model.numVertices * 3;

  // Where the landmarker puts these points on a neutral face, and the identity
  // basis restricted to the vertices they map to. Both are constant across
  // iterations, so the normal matrix built from them is too — only the
  // right-hand side moves.
  const basePoints = new Float64Array(rows);
  const design = new Float64Array(rows * dim);
  for (let i = 0; i < count; ++i) {
    const vertex = correspondence.vertices[active[i]];
    for (let axis = 0; axis < 3; ++axis) {
      const row = i * 3 + axis;
      basePoints[row] = correspondence.reference[active[i] * 3 + axis];
      for (let k = 0; k < dim; ++k) {
        // int8 basis; the component's scale folds in here, once.
        design[row * dim + k] =
          model.identityBasis[k * stride + vertex * 3 + axis] *
          model.identityScales[k];
      }
    }
  }

  const weights = new Float64Array(rows);
  for (let i = 0; i < count; ++i) {
    weights[i * 3] = 1;
    weights[i * 3 + 1] = 1;
    weights[i * 3 + 2] = depthWeight;
  }

  const normal = new Float64Array(dim * dim);
  for (let row = 0; row < rows; ++row) {
    const w = weights[row];
    if (w === 0) continue;
    const base = row * dim;
    for (let a = 0; a < dim; ++a) {
      const wa = w * design[base + a];
      if (wa === 0) continue;
      for (let b = a; b < dim; ++b)
        normal[a * dim + b] += wa * design[base + b];
    }
  }
  for (let a = 0; a < dim; ++a) {
    for (let b = 0; b < a; ++b) normal[a * dim + b] = normal[b * dim + a];
  }
  let trace = 0;
  for (let a = 0; a < dim; ++a) trace += normal[a * dim + a];
  const lambda = (ridge * trace) / dim;
  for (let a = 0; a < dim; ++a) normal[a * dim + a] += lambda;

  const observed = new Float64Array(rows);
  const indices = new Uint16Array(count);
  for (let i = 0; i < count; ++i) {
    indices[i] = correspondence.landmarks[active[i]];
  }
  const observedFrames = (options.frames ?? [{landmarks, aspect}]).map(frame => {
    if (frame.landmarks.length < REQUIRED_LANDMARKS) throw new Error('Multi-frame fit needs 468 landmarks per frame');
    const cloud = new Float64Array(rows);
    landmarksToModelAxes(frame.landmarks, indices, frame.aspect, cloud);
    return cloud;
  });
  observed.set(observedFrames[0]);

  const identity = new Float64Array(dim);
  const current = new Float64Array(rows);
  const aligned = new Float64Array(rows);
  const rhs = new Float64Array(dim);

  const residualRms = (a, b) => {
    let sum = 0;
    for (let i = 0; i < a.length; ++i) {
      const d = (a[i] - b[i]) * 1000;
      sum += d * d;
    }
    // Per point, not per scalar: three squared axis errors make one point.
    return Math.sqrt((sum * 3) / a.length);
  };

  const shapeUnder = (coefficients) => {
    current.set(basePoints);
    for (let k = 0; k < dim; ++k) {
      const c = coefficients[k];
      if (c === 0) continue;
      for (let row = 0; row < rows; ++row)
        current[row] += c * design[row * dim + k];
    }
  };

  let transform = null;
  let rmsBefore = 0;

  for (let iteration = 0; iteration < iterations; ++iteration) {
    shapeUnder(identity);

    // Pose: the transform taking the observed cloud onto that shape.
    aligned.fill(0);
    const one = new Float64Array(rows);
    let before = 0;
    for (const cloud of observedFrames) {
      transform = fitSimilarity(cloud, current);
      applySimilarity(cloud, transform, one);
      before += residualRms(one, basePoints);
      for (let j = 0; j < rows; ++j) aligned[j] += one[j] / observedFrames.length;
    }
    if (iteration === 0) rmsBefore = before / observedFrames.length;

    // Shape: the ridge-regularized least squares step onto the aligned cloud.
    rhs.fill(0);
    for (let row = 0; row < rows; ++row) {
      const w = weights[row];
      if (w === 0) continue;
      const target = w * (aligned[row] - basePoints[row]);
      const base = row * dim;
      for (let a = 0; a < dim; ++a) rhs[a] += design[base + a] * target;
    }

    const solved = choleskySolve(normal, rhs, dim);
    for (let k = 0; k < dim; ++k) {
      identity[k] = Math.max(-limit, Math.min(limit, solved[k]));
    }
  }

  // Final residual, measured against the shape the returned coefficients give.
  shapeUnder(identity);
  const frameResiduals = observedFrames.map(cloud => {
    transform = fitSimilarity(cloud, current);
    applySimilarity(cloud, transform, aligned);
    return residualRms(aligned, current);
  });
  const rmsAfter = frameResiduals.reduce((a,b) => a+b, 0) / frameResiduals.length;

  // The untouched tail stays zero, so the result is always the model's full
  // identity vector regardless of how many components were solved for.
  let peak = 0;
  const result = new Float32Array(model.identityDim);
  for (let k = 0; k < dim; ++k) {
    result[k] = identity[k];
    peak = Math.max(peak, Math.abs(identity[k]));
  }

  return {
    identity: result,
    frameCount: observedFrames.length,
    frameResiduals,
    transform,
    points: count,
    components: dim,
    rmsBefore,
    rmsAfter,
    peak,
  };
}
