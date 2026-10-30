// Prueba de conexión de solo lectura: npm run apipro:probar -w @sv/api
import { clienteDesdeEnv, type RespuestaJson } from './cliente.js';

interface Envelope<T> {
  estado: string;
  mensaje?: string;
  datos: T;
}

async function main(): Promise<void> {
  const api = clienteDesdeEnv();

  const empresa = (await api.llamar('GET', '/empresa')) as RespuestaJson<Envelope<Record<string, unknown>>>;
  if (empresa.status !== 200) {
    console.error(`GET /empresa → HTTP ${empresa.status}:`, (empresa.cuerpo as unknown as { mensaje?: string })?.mensaje);
    process.exit(1);
  }
  const e = empresa.cuerpo.datos;
  console.log(`Empresa: ${e.razon_social} (RUC ${e.ruc}) · entorno ${e.entorno} · IGV ${e.tasa_igv_vigente}%`);
  console.log(`Rate limit: ${empresa.cabeceras.get('x-ratelimit-limit')} req/min · plan ${empresa.cabeceras.get('x-plan')}`);

  const suc = (await api.llamar('GET', '/sucursales')) as RespuestaJson<Envelope<Array<Record<string, unknown>>>>;
  for (const s of suc.cuerpo.datos) console.log(`Sucursal ${s.cod_local} · ${s.nombre} · id ${s.id} · ${s.total_series} series`);

  const series = (await api.llamar('GET', '/series')) as RespuestaJson<Envelope<Array<Record<string, unknown>>>>;
  console.log(`Series: ${series.cuerpo.datos.map((s) => `${s.serie}(${s.tipo_documento})`).join(' ')}`);

  const sunat = (await api.llamar('GET', '/sunat/estado')) as RespuestaJson<{ sunat: { disponible: boolean; entorno: string } }>;
  console.log(`SUNAT: ${sunat.cuerpo.sunat.disponible ? 'disponible' : 'NO disponible'} (${sunat.cuerpo.sunat.entorno})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
