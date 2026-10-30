// Catálogos SUNAT usados en la fase 3. Solo se incluyen los códigos que
// API-PRO valida para la emisión (StoreInvoiceRequest / StoreBoletaRequest).
// Los catálogos 09 y 10 (motivos de NC/ND) se agregan en la fase 7c,
// verificados contra las reglas de API-PRO.

/** Catálogo 06: tipo de documento de identidad. */
export const TIPOS_DOC_IDENTIDAD = {
  '0': 'Sin documento',
  '1': 'DNI',
  '4': 'Carnet de extranjería',
  '6': 'RUC',
  '7': 'Pasaporte',
  A: 'Cédula diplomática',
} as const;
export type TipoDocIdentidad = keyof typeof TIPOS_DOC_IDENTIDAD;

/** Catálogo 07: afectaciones habituales en una tienda (subconjunto). */
export const AFECTACIONES_IGV = {
  '10': 'Gravado - Operación onerosa',
  '20': 'Exonerado - Operación onerosa',
  '30': 'Inafecto - Operación onerosa',
} as const;
export type AfectacionIgv = keyof typeof AFECTACIONES_IGV;
