import { existsSync, readFileSync } from 'node:fs';

export const MODES = ['interactive', 'yolo', 'dry-run'];

export const DEFAULT_CONFIG = {
  /** Agent used by `xjergx run` when --agent is not given. */
  agent: 'manual',
  /** interactive | yolo | dry-run */
  mode: 'interactive',
  /** How many times a failed review sends the task back to the builder. */
  maxReviewRetries: 3,
  /** Thresholds used by the deterministic router (see src/router.js). */
  router: {
    oddMaxFiles: 2,
    oddExploreMaxFiles: 5,
    sddMinFiles: 9,
  },
  /** Per-agent overrides of the command line, e.g. { "claude": { "headless": ["-p", "{prompt}"] } } */
  adapters: {},
  /** Run the clean-working-tree check before a task starts. */
  preflight: true,
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function mergeDeep(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeDeep(base[key], value) : value;
  }
  return out;
}

/** @param {import('./paths.js').WorkspacePaths} paths */
export function loadConfig(paths) {
  if (!existsSync(paths.config)) return structuredClone(DEFAULT_CONFIG);
  let user;
  try {
    user = JSON.parse(readFileSync(paths.config, 'utf8'));
  } catch (err) {
    throw new Error(`No pude leer ${paths.config}: ${err.message}`);
  }
  return mergeDeep(DEFAULT_CONFIG, user);
}
