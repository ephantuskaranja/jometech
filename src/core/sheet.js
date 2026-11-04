// Sheet sizes: plates are ordered in feet or millimetres, and priced per square foot.
//
//   sheetSize({ length: 12, width: 4, unit: 'ft', thicknessMm: 4 })
//     → { sqFt: 48, kg: 140.02 }

const MM_PER_FT = 304.8;
const SQ_M_PER_SQ_FT = 0.09290304;
const STEEL_KG_PER_SQ_M_PER_MM = 7.85;

export const SHEET_UNITS = ['ft', 'mm'];

/**
 * @param {{ length: number, width: number, unit: 'ft'|'mm', thicknessMm?: number|null }} size
 * @returns {{ sqFt: number, kg: number|null }} one sheet; the weight is approximate (mild steel)
 */
export function sheetSize({ length, width, unit, thicknessMm = null }) {
  // Feet multiply straight away, so 12 × 4 ft is exactly 48.
  const sqFt = unit === 'ft' ? length * width : (length * width) / (MM_PER_FT * MM_PER_FT);
  return {
    sqFt,
    kg: thicknessMm ? sqFt * SQ_M_PER_SQ_FT * thicknessMm * STEEL_KG_PER_SQ_M_PER_MM : null,
  };
}
