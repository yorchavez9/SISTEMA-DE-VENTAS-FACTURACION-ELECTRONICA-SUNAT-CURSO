// API-PRO simulada en memoria para las pruebas: reproduce el contrato verificado
// (envelope, include_inactive, reactivación de series inactivas con correlativo reiniciado).
import { ClienteApiPro } from '../integrations/apiPro/cliente.js';
import { Presupuesto } from '../integrations/apiPro/presupuesto.js';
import { fijarFabricaClienteParaPruebas } from '../integrations/apiPro/proveedor.js';

interface Serie { id: number; tipo_documento: string; serie: string; correlativo: number; activo: boolean; sucursal_id: number }
interface Sucursal { id: number; nombre: string; cod_local: string; activo: boolean }

const TIPOS: Record<string, string> = { factura: '01', boleta: '03', nota_credito: '07', nota_debito: '08', guia_remision: '09' };

export class ApiProFalsa {
  ruc = '20161515648';
  llamadas: Array<{ metodo: string; ruta: string; cuerpo?: unknown; apiKey: string | null }> = [];
  sucursales: Sucursal[] = [
    { id: 46, nombre: 'Sucursal Principal', cod_local: '0000', activo: true },
    { id: 14, nombre: 'Sucursal Principal', cod_local: '0001', activo: true },
  ];
  series: Serie[] = [
    { id: 47, tipo_documento: '01', serie: 'F001', correlativo: 719, activo: true, sucursal_id: 14 },
    { id: 48, tipo_documento: '03', serie: 'B001', correlativo: 240, activo: true, sucursal_id: 14 },
    { id: 105, tipo_documento: '07', serie: 'BC01', correlativo: 5, activo: true, sucursal_id: 14 },
    { id: 200, tipo_documento: '03', serie: 'B099', correlativo: 30, activo: false, sucursal_id: 14 },
    { id: 300, tipo_documento: '20', serie: 'R001', correlativo: 5, activo: true, sucursal_id: 14 },
  ];
  /** Comprobantes emitidos (facturas, boletas). */
  emitidos: Array<{ id: number; recurso: string; serie: string; correlativo: number; payload: Record<string, unknown>; sunat: { estado: string; codigo: string | number | null; descripcion: string | null; notas: unknown } }> = [];
  private porClave = new Map<string, number>();
  /** Fallos a inyectar en los próximos POST de emisión (se consumen en orden). */
  fallos: Array<'red' | 'red_tras_crear' | 500 | 422 | 401 | 'cupo'> = [];
  /** Estado SUNAT que devolverá el próximo GET de un comprobante en "enviado". */
  resultadoSunat: { estado: string; codigo: string | number | null; descripcion: string | null; notas: unknown } = { estado: 'aceptado', codigo: 0, descripcion: 'La Boleta ha sido aceptada', notas: [] };

  resumenes: Array<{ id: number; clave: string | null; fecha: string; boletas: number[]; consultas: number; anulacion?: boolean }> = [];
  bajas: Array<{ id: number; clave: string | null; docs: number[]; consultas: number; rechazar: boolean }> = [];
  guias: Array<{ id: number; clave: string | null; serie: string; correlativo: number; payload: Record<string, unknown>; estado: string; consultas: number; codigo: string | null; descripcion: string | null }> = [];
  /** Resultado SUNAT de las próximas guías (se resuelve en la 2.ª consulta). */
  resultadoGuia: 'aceptado' | 'rechazado' = 'aceptado';
  private datosGuia(g: ApiProFalsa['guias'][number]) {
    return { id: g.id, serie: g.serie, correlativo: g.correlativo, numero_completo: `${g.serie}-${g.correlativo}`, sunat: { estado: g.estado, codigo: g.codigo, descripcion: g.descripcion, ticket: g.estado === 'pendiente' ? null : `TK-${g.id}` } };
  }
  /** Si es true, la próxima comunicación de baja será rechazada por SUNAT. */
  rechazarAnulacion = false;

  private datosResumen(r: ApiProFalsa['resumenes'][number]) {
    return {
      id_resumen: r.id,
      identifier: `RC-${r.fecha.replaceAll('-', '')}-${r.id}`,
      estado_sunat: 'enviado',
      documentos: this.emitidos.filter((e) => r.boletas.includes(e.id)).map((e) => ({ id: e.id, tipo_documento: '03', serie_nro: `${e.serie}-${e.correlativo}`, estado: '1', estado_sunat: e.sunat.estado })),
    };
  }

  /** Simula una boleta pendiente creada en API-PRO por otro sistema del mismo RUC. */
  agregarBoletaAjena(fecha: string): number {
    const e = {
      id: this.siguienteId++,
      recurso: 'boletas',
      serie: 'B001',
      correlativo: 900 + this.emitidos.length,
      payload: { serie: 'B001', fecha_emision: fecha, cliente: { razon_social: 'OTRO SISTEMA' }, items: [{ cantidad: 1, precio_unitario: 10 }] },
      sunat: { estado: 'pendiente', codigo: null, descripcion: null, notas: null },
    };
    this.emitidos.push(e);
    return e.id;
  }

  private documento(e: ApiProFalsa['emitidos'][number]) {
    const total = (e.payload.items as Array<{ cantidad: number; precio_unitario: number }>).reduce((a, i) => a + Math.round(i.cantidad * i.precio_unitario * 100) / 100, 0);
    return { id: e.id, serie: e.serie, correlativo: e.correlativo, numero_completo: `${e.serie}-${String(e.correlativo).padStart(6, '0')}`, totales: { total }, sunat: { ...e.sunat, hash_cpe: e.sunat.estado === 'aceptado' ? 'HASH' : null } };
  }

  private emitir(recurso: string, cuerpo: Record<string, unknown>, clave: string | null): Response {
    if (clave && this.porClave.has(clave)) {
      const previo = this.emitidos.find((x) => x.id === this.porClave.get(clave))!;
      return this.json(201, { estado: 'exito', datos: this.documento(previo) }, { 'Idempotency-Replayed': 'true' });
    }
    const correlativo = 1 + this.emitidos.filter((x) => x.serie === cuerpo.serie).length;
    const e = {
      id: this.siguienteId++,
      recurso,
      serie: String(cuerpo.serie),
      correlativo,
      payload: cuerpo,
      sunat: cuerpo.solo_registro ? { estado: 'pendiente', codigo: null, descripcion: null, notas: null } : { estado: 'enviado', codigo: null, descripcion: null, notas: null },
    };
    this.emitidos.push(e);
    if (clave) this.porClave.set(clave, e.id);
    return this.json(201, { estado: 'exito', mensaje: 'Creada y encolada', datos: this.documento(e) });
  }

  /** Reglas de StoreDispatchGuideRequest que importan en las pruebas. */
  private validarGuia(c: Record<string, unknown>): Record<string, string[]> | null {
    const e: Record<string, string[]> = {};
    const m1l = Array.isArray(c.indicadores) && (c.indicadores as string[]).some((i) => i.includes('M1L'));
    if (c.mod_traslado === '01' && !m1l && !c.transportista) e.transportista = ['El transportista es requerido para transporte público.'];
    if (c.mod_traslado === '02' && !m1l && (!c.vehiculo || !(c.conductor || c.conductores))) e.vehiculo = ['El vehículo es requerido para transporte privado.'];
    if (!/^\d{6}$/.test(String(c.partida_ubigeo)) || !/^\d{6}$/.test(String(c.llegada_ubigeo))) e.partida_ubigeo = ['El ubigeo debe tener 6 caracteres.'];
    for (const k of ['mto_imp_venta', 'total']) if (k in c) e[k] = ['campo no permitido'];
    return Object.keys(e).length ? e : null;
  }

  /** Documentos que "conocen" SUNAT/RENIEC en la simulación. */
  documentos = new Map<string, { razon_social: string; direccion?: string; estado?: string; condicion?: string }>();
  documentoQueFalla = '';
  private siguienteId = 1000;
  /** api_key aceptada → RUC al que pertenece. */
  claves = new Map<string, string>();

  constructor(apiKeyValida: string) {
    this.claves.set(apiKeyValida, this.ruc);
  }

  instalar(): void {
    fijarFabricaClienteParaPruebas((cred) => new ClienteApiPro(cred, new Presupuesto(10_000), this.fetch));
  }

  desinstalar(): void {
    fijarFabricaClienteParaPruebas(null);
  }

  private json(status: number, cuerpo: unknown, cabeceras: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json', ...cabeceras } });
  }

  private formatoSerie(s: Serie) {
    const suc = this.sucursales.find((x) => x.id === s.sucursal_id)!;
    return { ...s, tipo: Object.keys(TIPOS).find((k) => TIPOS[k] === s.tipo_documento) ?? 'otro', sucursal: { id: suc.id, nombre: suc.nombre, cod_local: suc.cod_local } };
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const ruta = u.pathname.replace(/^\/api\/v1/, '');
    const metodo = init?.method ?? 'GET';
    const cab = new Headers(init?.headers);
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : undefined;
    const apiKey = cab.get('X-Api-Key');
    this.llamadas.push({ metodo, ruta: `${ruta}${u.search}`, cuerpo, apiKey });

    const ruc = apiKey ? this.claves.get(apiKey) : undefined;
    if (!ruc) return this.json(401, { estado: 'error', mensaje: 'Credenciales de API inválidas.' });

    if (metodo === 'GET' && ruta === '/empresa') {
      return this.json(200, {
        estado: 'exito', mensaje: 'OK',
        datos: { ruc, razon_social: `EMPRESA ${ruc}`, nombre_comercial: 'CMA STORE', direccion: 'AV CENTRAL 425', entorno: 'beta', tax_regime: 'mype', tasa_igv_vigente: 18, tiene_certificado: true, tiene_sol_pass: true, tiene_client_secret: true, activo: true, sol_user: 'USUARIOSOL' },
      }, { 'x-ratelimit-limit': '30' });
    }
    // ---------- Resumen diario ----------
    if (metodo === 'GET' && ruta === '/boletas') {
      const f = u.searchParams.get('fecha_desde');
      const estado = u.searchParams.get('sunat_status');
      const todas = this.emitidos.filter((e) => e.recurso === 'boletas' && (!f || e.payload.fecha_emision === f) && (!estado || e.sunat.estado === estado));
      const porPagina = Number(u.searchParams.get('por_pagina') ?? 15);
      const pagina = Number(u.searchParams.get('page') ?? 1);
      const datos = todas.slice((pagina - 1) * porPagina, pagina * porPagina).map((e) => ({ ...this.documento(e), cliente: { razon_social: (e.payload.cliente as { razon_social: string }).razon_social } }));
      return this.json(200, { estado: 'exito', datos: { datos, paginacion: { pagina_actual: pagina, ultima_pagina: Math.max(1, Math.ceil(todas.length / porPagina)), por_pagina: porPagina, total: todas.length } } });
    }
    // ---------- Comunicación de baja (RA) ----------
    if (metodo === 'POST' && ruta === '/anulaciones') {
      const clave = cab.get('Idempotency-Key');
      const previa = this.bajas.find((b) => b.clave === clave);
      if (previa) return this.json(201, { estado: 'exito', datos: { id_anulacion: previa.id, identifier: `RA-${previa.id}` } });
      const detalles = cuerpo.detalles as Array<{ tipo_documento: string; serie: string; correlativo: string }>;
      if (detalles.some((d) => d.tipo_documento === '03')) return this.json(422, { estado: 'error', mensaje: 'Las boletas no se anulan por comunicación de baja', codigo_error: 'boletas_no_soportadas_en_ra' });
      const docs = detalles.map((d) => this.emitidos.find((e) => e.serie === d.serie && e.correlativo === Number(d.correlativo))!);
      for (const d of docs) d.sunat = { ...d.sunat, estado: 'anulacion_en_proceso' };
      const b = { id: this.siguienteId++, clave, docs: docs.map((d) => d.id), consultas: 0, rechazar: this.rechazarAnulacion };
      this.bajas.push(b);
      return this.json(201, { estado: 'exito', datos: { id_anulacion: b.id, identifier: `RA-${b.id}`, estado_sunat: 'enviado' } });
    }
    const baja = ruta.match(/^\/anulaciones\/(\d+)$/);
    if (metodo === 'GET' && baja) {
      const b = this.bajas.find((x) => x.id === Number(baja[1]));
      if (!b) return this.json(404, { estado: 'error', mensaje: 'Recurso no encontrado.' });
      b.consultas++;
      const listo = b.consultas >= 2;
      if (listo) for (const d of this.emitidos.filter((e) => b.docs.includes(e.id))) d.sunat = { ...d.sunat, estado: b.rechazar ? 'aceptado' : 'anulado' };
      return this.json(200, { estado: 'exito', datos: { id_anulacion: b.id, identifier: `RA-${b.id}`, estado_sunat: listo ? (b.rechazar ? 'rechazado' : 'aceptado') : 'enviado', codigo_sunat: listo ? (b.rechazar ? '2105' : '0') : null, descripcion_sunat: listo ? (b.rechazar ? 'Baja rechazada' : 'La Comunicación de baja ha sido aceptada') : null } });
    }

    if (metodo === 'POST' && ruta === '/resumenes') {
      const clave = cab.get('Idempotency-Key');
      const previo = this.resumenes.find((r) => r.clave === clave);
      if (previo) return this.json(201, { estado: 'exito', datos: this.datosResumen(previo) });
      if (Array.isArray(cuerpo.anular)) {
        // Resumen de anulación: boletas aceptadas indicadas por id interno de API-PRO.
        const anular = cuerpo.anular as Array<{ id: number }>;
        const boletas = this.emitidos.filter((e) => anular.some((a) => a.id === e.id) && e.sunat.estado === 'aceptado');
        if (!boletas.length) return this.json(422, { estado: 'error', mensaje: 'No se encontraron boletas aceptadas por SUNAT para anular.' });
        for (const b of boletas) b.sunat = { ...b.sunat, estado: 'anulacion_en_proceso' };
        const r = { id: this.siguienteId++, clave, fecha: String(cuerpo.fecha_resumen), boletas: boletas.map((b) => b.id), consultas: 0, anulacion: true };
        this.resumenes.push(r);
        return this.json(201, { estado: 'exito', datos: this.datosResumen(r) });
      }
      const boletas = this.emitidos.filter((e) => e.recurso === 'boletas' && e.payload.fecha_emision === cuerpo.fecha_resumen && e.sunat.estado === 'pendiente');
      for (const b of boletas) b.sunat = { estado: 'enviado', codigo: null, descripcion: null, notas: null };
      const r = { id: this.siguienteId++, clave, fecha: String(cuerpo.fecha_resumen), boletas: boletas.map((b) => b.id), consultas: 0 };
      this.resumenes.push(r);
      return this.json(201, { estado: 'exito', datos: this.datosResumen(r) });
    }
    const resumen = ruta.match(/^\/resumenes\/(\d+)\/estado$/);
    if (metodo === 'GET' && resumen) {
      const r = this.resumenes.find((x) => x.id === Number(resumen[1]));
      if (!r) return this.json(404, { estado: 'error', mensaje: 'Recurso no encontrado.' });
      r.consultas++;
      // La primera consulta aún "en proceso"; desde la segunda, aceptado.
      const aceptado = r.consultas >= 2;
      if (aceptado) for (const b of this.emitidos.filter((e) => r.boletas.includes(e.id))) b.sunat = { estado: r.anulacion ? 'anulado' : 'aceptado', codigo: 0, descripcion: 'Aceptada', notas: [] };
      return this.json(200, {
        estado: 'exito',
        datos: { ...this.datosResumen(r), estado_sunat: aceptado ? 'aceptado' : 'enviado', codigo_sunat: aceptado ? '0' : null, descripcion_sunat: aceptado ? 'El Resumen diario ha sido aceptado' : null },
      });
    }

    // ---------- Guías de remisión ----------
    if (metodo === 'POST' && ruta === '/guias-remision') {
      const fallo = this.fallos.shift();
      if (fallo === 'red') throw new TypeError('fetch failed');
      if (fallo === 500) return this.json(500, { estado: 'error', mensaje: 'Error al crear guía: SQLSTATE' });
      const clave = cab.get('Idempotency-Key');
      const previa = this.guias.find((g) => g.clave === clave);
      if (previa) return this.json(201, { estado: 'exito', datos: this.datosGuia(previa) }, { 'Idempotency-Replayed': 'true' });
      const errores = this.validarGuia(cuerpo);
      if (fallo === 422 || errores) return this.json(422, { estado: 'error', mensaje: 'Error de validación', errores: errores ?? { 'llegada_ubigeo': ['El ubigeo no existe'] } });
      const g = { id: this.siguienteId++, clave, serie: String(cuerpo.serie), correlativo: 1 + this.guias.filter((x) => x.serie === cuerpo.serie).length, payload: cuerpo, estado: 'enviado', consultas: 0, codigo: null, descripcion: null };
      this.guias.push(g);
      const respuesta = this.json(201, { estado: 'exito', mensaje: 'Guía de remisión creada y encolada para envío a SUNAT.', datos: this.datosGuia(g) });
      if (fallo === 'red_tras_crear') throw new TypeError('socket hang up');
      return respuesta;
    }
    const guiaRuta = ruta.match(/^\/guias-remision\/(\d+)(\/(enviar|pdf|xml|cdr))?$/);
    if (guiaRuta) {
      const g = this.guias.find((x) => x.id === Number(guiaRuta[1]));
      if (!g) return this.json(404, { estado: 'error', mensaje: 'Recurso no encontrado.' });
      const accion = guiaRuta[3];
      if (metodo === 'GET' && !accion) {
        if (g.estado === 'enviado' && ++g.consultas >= 2) {
          g.estado = this.resultadoGuia;
          g.codigo = this.resultadoGuia === 'aceptado' ? '0' : '2554';
          g.descripcion = this.resultadoGuia === 'aceptado' ? 'La Guia ha sido aceptada' : 'El destinatario no corresponde al motivo';
        }
        return this.json(200, { estado: 'exito', datos: this.datosGuia(g) });
      }
      if (metodo === 'PUT' && !accion) {
        if (!['pendiente', 'rechazado'].includes(g.estado)) return this.json(422, { estado: 'error', mensaje: 'Solo guías pendientes o rechazadas pueden editarse.' });
        const errores = this.validarGuia(cuerpo);
        if (errores) return this.json(422, { estado: 'error', mensaje: 'Error de validación', errores });
        Object.assign(g, { payload: cuerpo, estado: 'enviado', consultas: 0, codigo: null, descripcion: null });
        return this.json(200, { estado: 'exito', mensaje: 'Guía actualizada y reenviada a SUNAT.', datos: this.datosGuia(g) });
      }
      if (metodo === 'POST' && accion === 'enviar') {
        if (g.estado === 'aceptado') return this.json(422, { estado: 'error', mensaje: 'Esta guía de remisión ya fue aceptada por SUNAT.' });
        Object.assign(g, { estado: 'enviado', consultas: 0, codigo: null, descripcion: null });
        return this.json(200, { estado: 'exito', datos: this.datosGuia(g) });
      }
      if (metodo === 'GET' && accion) {
        if (accion === 'cdr' && g.estado !== 'aceptado') return this.json(404, { estado: 'error', mensaje: 'CDR no disponible' });
        const tipo = accion === 'pdf' ? 'application/pdf' : accion === 'xml' ? 'application/xml' : 'application/zip';
        return new Response(`guia-${accion}:${g.id}:${u.searchParams.get('format') ?? ''}`, { status: 200, headers: { 'content-type': tipo } });
      }
    }
    if (metodo === 'GET' && ruta.startsWith('/catalogos/ubigeo/')) {
      const nivel = ruta.split('/').pop();
      const datos =
        nivel === 'regiones' ? [{ id: '15', nombre: 'LIMA' }, { id: '04', nombre: 'AREQUIPA' }]
        : nivel === 'provincias' ? (u.searchParams.get('region_id') === '15' ? [{ id: '1501', nombre: 'LIMA', region_id: '15' }] : [])
        : u.searchParams.get('provincia_id') === '1501' ? [{ id: '150101', nombre: 'LIMA', provincia_id: '1501' }, { id: '150128', nombre: 'RIMAC', provincia_id: '1501' }] : [];
      return this.json(200, { estado: 'exito', datos });
    }

    // ---------- Facturas y boletas ----------
    const emision = ruta.match(/^\/(facturas|boletas|notas-credito|notas-debito)$/);
    if (metodo === 'POST' && emision) {
      const fallo = this.fallos.shift();
      if (fallo === 'red') throw new TypeError('fetch failed');
      if (fallo === 500) return this.json(500, { estado: 'error', mensaje: 'Error al crear boleta: SQLSTATE' });
      if (fallo === 422) return this.json(422, { estado: 'error', mensaje: 'Error de validación', errores: { 'cliente.num_doc': ['El RUC no es válido'] } });
      if (fallo === 401) return this.json(401, { estado: 'error', mensaje: 'Credenciales de API inválidas.' });
      if (fallo === 'cupo') return this.json(429, { estado: 'error', mensaje: 'Has alcanzado el limite de documentos SUNAT (600/600 por mes).', codigo_error: 'limit_reached' });
      const respuesta = this.emitir(emision[1]!, cuerpo, cab.get('Idempotency-Key'));
      if (fallo === 'red_tras_crear') throw new TypeError('socket hang up'); // API-PRO lo creó pero la respuesta se perdió
      return respuesta;
    }
    const docRuta = ruta.match(/^\/(facturas|boletas|notas-credito|notas-debito)\/(\d+)(\/(enviar|pdf|xml|cdr))?$/);
    if (docRuta) {
      const e = this.emitidos.find((x) => x.id === Number(docRuta[2]));
      if (!e) return this.json(404, { estado: 'error', mensaje: 'Recurso no encontrado.' });
      const accion = docRuta[4];
      if (metodo === 'GET' && !accion) {
        if (e.sunat.estado === 'enviado') e.sunat = { ...this.resultadoSunat };
        return this.json(200, { estado: 'exito', datos: this.documento(e) });
      }
      if (metodo === 'PUT' && !accion) {
        e.payload = cuerpo;
        e.sunat = { estado: 'enviado', codigo: null, descripcion: null, notas: null };
        return this.json(200, { estado: 'exito', datos: this.documento(e) });
      }
      if (metodo === 'POST' && accion === 'enviar') {
        e.sunat = { estado: 'enviado', codigo: null, descripcion: null, notas: null };
        return this.json(200, { estado: 'exito', datos: this.documento(e) });
      }
      if (metodo === 'GET' && (accion === 'pdf' || accion === 'xml' || accion === 'cdr')) {
        const tipo = accion === 'pdf' ? 'application/pdf' : accion === 'xml' ? 'application/xml' : 'application/zip';
        return new Response(`${accion}:${e.id}:${u.searchParams.get('format') ?? ''}`, { status: 200, headers: { 'content-type': tipo } });
      }
    }

    if (metodo === 'GET' && ruta === '/buscar-documento') {
      const numero = u.searchParams.get('numero') ?? '';
      if (numero === this.documentoQueFalla) return this.json(500, { estado: 'error', mensaje: 'Servicio externo caído' });
      const doc = this.documentos.get(numero);
      if (!doc) return this.json(404, { estado: 'error', mensaje: 'No se encontró información para el documento ingresado' });
      return this.json(200, { estado: 'exito', datos: { tipo_doc: u.searchParams.get('tipo'), num_doc: numero, ...doc } });
    }
    if (metodo === 'GET' && ruta === '/sunat/estado') return this.json(200, { estado: 'exito', sunat: { disponible: true, entorno: 'beta' } });
    if (metodo === 'GET' && ruta === '/sucursales') {
      return this.json(200, { estado: 'exito', datos: this.sucursales.map((s) => ({ ...s, total_series: this.series.filter((x) => x.sucursal_id === s.id).length })) });
    }
    if (metodo === 'POST' && ruta === '/sucursales') {
      const s = { id: this.siguienteId++, nombre: cuerpo.nombre, cod_local: cuerpo.cod_local, activo: true };
      this.sucursales.push(s);
      return this.json(201, { estado: 'exito', datos: s });
    }
    if (metodo === 'GET' && ruta === '/series') {
      const todas = u.searchParams.get('include_inactive') === '1';
      return this.json(200, { estado: 'exito', datos: this.series.filter((s) => todas || s.activo).map((s) => this.formatoSerie(s)) });
    }
    if (metodo === 'POST' && ruta === '/series') {
      const tipo = TIPOS[cuerpo.tipo as string]!;
      const existente = this.series.find((s) => s.tipo_documento === tipo && s.serie === cuerpo.serie);
      if (existente?.activo) return this.json(422, { estado: 'error', mensaje: 'No se pudo crear ninguna serie.', errores: [`${cuerpo.serie}: ya existe`] });
      if (existente) {
        // Comportamiento real de API-PRO: reactiva y reinicia el correlativo.
        Object.assign(existente, { activo: true, correlativo: cuerpo.correlativo_inicial ?? 0, sucursal_id: cuerpo.sucursal_id });
        return this.json(201, { estado: 'exito', datos: { creadas: [this.formatoSerie(existente)] } });
      }
      const s = { id: this.siguienteId++, tipo_documento: tipo, serie: cuerpo.serie, correlativo: cuerpo.correlativo_inicial ?? 0, activo: true, sucursal_id: cuerpo.sucursal_id };
      this.series.push(s);
      return this.json(201, { estado: 'exito', datos: { creadas: [this.formatoSerie(s)] } });
    }
    const put = ruta.match(/^\/series\/(\d+)$/);
    if (metodo === 'PUT' && put) {
      const s = this.series.find((x) => x.id === Number(put[1]));
      if (!s) return this.json(404, { estado: 'error', mensaje: 'Recurso no encontrado.' });
      if (cuerpo.correlativo !== undefined) s.correlativo = cuerpo.correlativo;
      if (cuerpo.activo !== undefined) s.activo = cuerpo.activo;
      if (cuerpo.sucursal_id !== undefined) s.sucursal_id = cuerpo.sucursal_id;
      return this.json(200, { estado: 'exito', mensaje: 'Serie actualizada.', datos: this.formatoSerie(s) });
    }
    return this.json(404, { estado: 'error', mensaje: `Ruta simulada no implementada: ${metodo} ${ruta}` });
  };
}
