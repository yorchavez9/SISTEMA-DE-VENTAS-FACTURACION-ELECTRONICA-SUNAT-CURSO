/**
 * Token bucket que limita las llamadas a API-PRO (ADR-17).
 * El rate limit real verificado es 30 req/min; por defecto se usan 25.
 * Es por proceso: el worker es el único proceso que consume presupuesto de forma
 * sostenida; las consultas síncronas del servidor (probar conexión, descargas) son esporádicas.
 */
export class Presupuesto {
  private tokens: number;
  private ultimaRecarga: number;
  private readonly porMs: number;

  constructor(
    private readonly porMinuto: number,
    private readonly ahora: () => number = Date.now,
  ) {
    this.tokens = porMinuto;
    this.ultimaRecarga = ahora();
    this.porMs = porMinuto / 60_000;
  }

  private recargar(): void {
    const t = this.ahora();
    this.tokens = Math.min(this.porMinuto, this.tokens + (t - this.ultimaRecarga) * this.porMs);
    this.ultimaRecarga = t;
  }

  /** Milisegundos que hay que esperar para disponer de un token (0 = ya). */
  esperaMs(): number {
    this.recargar();
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.porMs);
  }

  /** Consume un token si hay; devuelve false si no hay disponible. */
  tomar(): boolean {
    this.recargar();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Reduce el presupuesto disponible tras un 429 (Retry-After en segundos). */
  penalizar(segundos: number): void {
    this.recargar();
    // Deja el saldo en negativo para que no haya tokens hasta pasados `segundos`.
    this.tokens = Math.min(this.tokens, -segundos * 1000 * this.porMs);
  }

  async esperarYTomar(): Promise<void> {
    for (;;) {
      const espera = this.esperaMs();
      if (espera === 0 && this.tomar()) return;
      await new Promise((r) => setTimeout(r, espera || 50));
    }
  }
}
