/**
 * Deterministic lane router.
 *
 * The classifier agent only reports observable signals about the ticket
 * (classification.json). The lane is chosen here, by fixed rules, so the
 * decision is reproducible, testable and does not depend on the model's mood.
 */

export const CLARITY = ['clear', 'partial', 'unclear'];
export const DESIGN = ['obvious', 'some_options', 'unknown'];

/**
 * @typedef {object} Classification
 * @property {number} files_estimate      files/modules likely touched
 * @property {boolean} touches_contract   DB schema, public API, event/message format, cross-service contract
 * @property {boolean} sensitive_area     auth, permissions, payments, personal data, security
 * @property {boolean} multi_repo         change spans more than one repository
 * @property {'clear'|'partial'|'unclear'} requirements_clarity
 * @property {'obvious'|'some_options'|'unknown'} design_certainty
 * @property {string} summary
 * @property {string} [suggested_lane]    the agent's opinion, informational only
 */

/** @returns {{ ok: boolean, errors: string[] }} */
export function validateClassification(c) {
  const errors = [];
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return { ok: false, errors: ['debe ser un objeto JSON'] };
  if (!Number.isInteger(c.files_estimate) || c.files_estimate < 0) errors.push('files_estimate debe ser un entero >= 0');
  for (const key of ['touches_contract', 'sensitive_area', 'multi_repo']) {
    if (typeof c[key] !== 'boolean') errors.push(`${key} debe ser true o false`);
  }
  if (!CLARITY.includes(c.requirements_clarity)) errors.push(`requirements_clarity debe ser uno de: ${CLARITY.join(', ')}`);
  if (!DESIGN.includes(c.design_certainty)) errors.push(`design_certainty debe ser uno de: ${DESIGN.join(', ')}`);
  if (typeof c.summary !== 'string' || !c.summary.trim()) errors.push('summary debe ser un texto no vacío');
  return { ok: errors.length === 0, errors };
}

/**
 * @param {Classification} c
 * @param {{ oddMaxFiles: number, oddExploreMaxFiles: number, sddMinFiles: number }} t thresholds
 * @returns {{ lane: 'odd'|'rdd'|'sdd', reasons: string[] }}
 */
export function decideLane(c, t) {
  const sdd = [];
  if (c.touches_contract) sdd.push('cambia un contrato (schema, API pública o integración)');
  if (c.sensitive_area) sdd.push('toca un área sensible (auth, pagos, datos personales o seguridad)');
  if (c.multi_repo) sdd.push('abarca más de un repositorio');
  if (c.files_estimate >= t.sddMinFiles) sdd.push(`toca ~${c.files_estimate} archivos (umbral SDD: ${t.sddMinFiles})`);
  if (c.design_certainty === 'unknown' && c.files_estimate > t.oddExploreMaxFiles) {
    sdd.push(`el diseño es desconocido en un cambio amplio (~${c.files_estimate} archivos)`);
  }
  if (sdd.length) return { lane: 'sdd', reasons: sdd };

  if (c.requirements_clarity === 'unclear') {
    return { lane: 'rdd', reasons: ['los requisitos no están claros: hay que fijar casos de uso antes de construir'] };
  }
  if (c.files_estimate <= t.oddMaxFiles) {
    return { lane: 'odd', reasons: [`cambio chico (~${c.files_estimate} archivos, umbral ODD: ${t.oddMaxFiles})`] };
  }
  if (c.design_certainty === 'unknown') {
    return {
      lane: 'odd',
      reasons: [`el diseño hay que descubrirlo y el alcance es acotado (~${c.files_estimate} archivos): conviene explorar de forma orgánica`],
    };
  }
  return {
    lane: 'rdd',
    reasons: [`cambio mediano (~${c.files_estimate} archivos) con requisitos ${c.requirements_clarity === 'clear' ? 'claros' : 'parcialmente claros'} y sin contratos en juego`],
  };
}
