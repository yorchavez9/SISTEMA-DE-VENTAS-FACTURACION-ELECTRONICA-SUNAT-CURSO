/** Fecha calendario (AAAA-MM-DD) en America/Lima, que es la que vale para SUNAT (ADR-13). */
export function fechaLima(fecha: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);
}
