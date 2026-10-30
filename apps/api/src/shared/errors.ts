/** Error de negocio con el formato único de la API interna (docs/03-api-interna.md §1). */
export class ErrorApp extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensaje: string,
    readonly campos?: Record<string, string>,
    readonly detalle?: unknown,
  ) {
    super(mensaje);
    this.name = 'ErrorApp';
  }
}

export const errores = {
  noEncontrado: (que = 'Recurso') => new ErrorApp(404, 'NO_ENCONTRADO', `${que} no encontrado`),
  validacion: (campos: Record<string, string>) =>
    new ErrorApp(422, 'VALIDACION', 'Hay datos inválidos', campos),
  conflicto: (codigo: string, mensaje: string, detalle?: unknown) =>
    new ErrorApp(409, codigo, mensaje, undefined, detalle),
  sinPermiso: () => new ErrorApp(403, 'SIN_PERMISO', 'No tienes permiso para esta acción'),
  noAutenticado: () => new ErrorApp(401, 'NO_AUTENTICADO', 'Inicia sesión para continuar'),
};
