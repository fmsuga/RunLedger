import { initializeApp }                               from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js';
import { getFirestore, doc, setDoc, getDoc, collection,
         getDocs, onSnapshot, deleteDoc }              from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js';
import { getAuth, signInWithEmailAndPassword,
         onAuthStateChanged, signOut }                 from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js';

// ─── FIREBASE ────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyDD_BHObMSasVcUwFIUOm_M100uCakI498",
  authDomain:        "runledger.firebaseapp.com",
  projectId:         "runledger",
  storageBucket:     "runledger.firebasestorage.app",
  messagingSenderId: "465777579099",
  appId:             "1:465777579099:web:180da05212713cd0101b7e"
};
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// ─── ESTADO ───────────────────────────────────────────────────────────────────
// Estructura Firestore:
//   usuarios/{uid}                          ← config global
//   usuarios/{uid}/datos/alumnos            ← alumnos sin subgrupo
//   usuarios/{uid}/subgrupos/{sid}          ← { nombre, precio? }
//   usuarios/{uid}/subgrupos/{sid}/datos/alumnos
//   usuarios/{uid}/historial/{YYYY-MM}      ← snapshot mensual global
//   usuarios/{uid}/subgrupos/{sid}/historial/{YYYY-MM} ← snapshot mensual por subgrupo

let _uid            = null;
let _config         = { precio: 0 };
let _subgrupos      = [];
let _subActual      = '__general__';
let _alumnos        = [];
let _listo          = false;
let _unsubAlumnos   = null;
let _unsubConfig    = null;
let _historial      = {};   // { 'YYYY-MM': { alumnos, pagaron, ingreso, precio } }

// ─── REFERENCIAS ─────────────────────────────────────────────────────────────
const refConfig          = ()     => doc(db, 'usuarios', _uid);
const refAlumnosGen      = ()     => doc(db, 'usuarios', _uid, 'datos', 'alumnos');
const refSubgrupos       = ()     => collection(db, 'usuarios', _uid, 'subgrupos');
const refSubgrupo        = id     => doc(db, 'usuarios', _uid, 'subgrupos', id);
const refAlumnosSub      = id     => doc(db, 'usuarios', _uid, 'subgrupos', id, 'datos', 'alumnos');
const refHistorialGen    = ()     => collection(db, 'usuarios', _uid, 'historial');
const refSnapshotGen     = ym     => doc(db, 'usuarios', _uid, 'historial', ym);
const refHistorialSub    = sid    => collection(db, 'usuarios', _uid, 'subgrupos', sid, 'historial');
const refSnapshotSub     = (sid, ym) => doc(db, 'usuarios', _uid, 'subgrupos', sid, 'historial', ym);

// ─── TIEMPO ──────────────────────────────────────────────────────────────────
function getMesActual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function getDia() { return new Date().getDate(); }
function formatMesLabel(ym) {
  if (!ym) return '—';
  const [y, m] = ym.split('-');
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                 'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  return `${meses[+m-1]} ${y}`;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
const capitalizar = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
function getEstado(a) {
  if (a.ultimoMesPagado === getMesActual()) return 'verde';
  return getDia() <= 10 ? 'amarillo' : 'rojo';
}

// ─── PRECIO ACTIVO ───────────────────────────────────────────────────────────
function getPrecioActivo() {
  if (_subActual === '__general__') return _config.precio || 0;
  const sub = _subgrupos.find(s => s.id === _subActual);
  return (sub && sub.precio != null) ? sub.precio : (_config.precio || 0);
}

// ─── FIRESTORE WRITE ─────────────────────────────────────────────────────────
async function guardarAlumnos(lista) {
  const ref = _subActual === '__general__' ? refAlumnosGen() : refAlumnosSub(_subActual);
  await setDoc(ref, { lista });
}

async function guardarConfigGlobal(cfg) {
  _config = { ..._config, ...cfg };
  await setDoc(refConfig(), _config, { merge: true });
  renderHeader();
  renderDropdown();
}

// ─── HISTORIAL MENSUAL ───────────────────────────────────────────────────────
// Snapshot: foto del estado del mes. Se graba/actualiza cada vez que cambia
// el estado de pagos. El snapshot del mes actual se mantiene vivo.
// Los meses pasados quedan como registro permanente.

async function grabarSnapshot(lista, ym) {
  const precio   = getPrecioActivo();
  const pagaron  = lista.filter(a => a.ultimoMesPagado === ym).length;
  const ingreso  = pagaron * precio;

  const snap = {
    ym,
    alumnos : lista.length,
    pagaron,
    ingreso,
    precio,
    bajas   : 0,   // reservado para futuro
    altas   : lista.filter(a => (a.fechaAlta||'').slice(0,7) === ym).length,
  };

  if (_subActual === '__general__') {
    await setDoc(refSnapshotGen(ym), snap, { merge: true });
  } else {
    await setDoc(refSnapshotSub(_subActual, ym), snap, { merge: true });
  }
}

async function cargarHistorial() {
  try {
    let snaps;
    if (_subActual === '__general__') {
      snaps = await getDocs(refHistorialGen());
    } else {
      snaps = await getDocs(refHistorialSub(_subActual));
    }
    _historial = {};
    snaps.forEach(d => { _historial[d.id] = d.data(); });
  } catch(e) {
    _historial = {};
  }
}

// Fusiona los datos reales del mes actual al historial en memoria (sin Firebase)
function historialConMesActual() {
  const ym     = getMesActual();
  const precio = getPrecioActivo();
  const pagaron = _alumnos.filter(a => a.ultimoMesPagado === ym).length;
  const merged  = { ..._historial };
  merged[ym] = {
    ym,
    alumnos : _alumnos.length,
    pagaron,
    ingreso : pagaron * precio,
    precio,
    altas   : _alumnos.filter(a => (a.fechaAlta||'').slice(0,7) === ym).length,
    ...(merged[ym] || {}),   // no pisar si ya existe data más completa
    // pero sí actualizar alumnos/pagaron/ingreso del mes actual
    alumnos : _alumnos.length,
    pagaron,
    ingreso : pagaron * precio,
  };
  return merged;
}


// ─── SUBGRUPOS ───────────────────────────────────────────────────────────────
async function cargarSubgrupos() {
  const snap = await getDocs(refSubgrupos());
  _subgrupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function crearSubgrupo(nombre, precio) {
  const sid = 'sub_' + Date.now();
  await setDoc(refSubgrupo(sid), {
    nombre: nombre.trim() || 'Nuevo subgrupo',
    ...(precio != null ? { precio } : {})
  });
  await setDoc(refAlumnosSub(sid), { lista: [] });
  return sid;
}

async function eliminarSubgrupo(sid) {
  await deleteDoc(refAlumnosSub(sid)).catch(() => {});
  await deleteDoc(refSubgrupo(sid)).catch(() => {});
  _subgrupos = _subgrupos.filter(s => s.id !== sid);
}

// ─── ACTIVAR SUBGRUPO ────────────────────────────────────────────────────────
function activarSubgrupo(sid) {
  if (_unsubAlumnos) { _unsubAlumnos(); _unsubAlumnos = null; }

  _subActual = sid;
  _listo     = false;
  _alumnos   = [];
  _historial = {};
  renderAlumnos();
  renderDropdown();

  const ref = sid === '__general__' ? refAlumnosGen() : refAlumnosSub(sid);
  _unsubAlumnos = onSnapshot(ref, async snap => {
    _alumnos = snap.exists() ? (snap.data().lista || []) : [];
    _listo   = true;
    // Cargar historial la primera vez que llegan los alumnos
    if (Object.keys(_historial).length === 0) {
      await cargarHistorial();
    }
    render();
  });
}

// ─── RENDER HEADER ───────────────────────────────────────────────────────────
function renderNombreAgrupacion(cfg) {
  const nombre = cfg.nombreGrupo || 'Mi agrupación';
  const split  = cfg.grupoSplit  != null ? cfg.grupoSplit : nombre.length;
  const color1 = cfg.grupoColor1 || '#60a5fa';
  const color2 = cfg.grupoColor2 || '#fb923c';
  const p1 = nombre.slice(0, split);
  const p2 = nombre.slice(split);
  return p2
    ? `<span style="color:${color1}">${p1}</span><span style="color:${color2}">${p2}</span>`
    : `<span style="color:${color1}">${p1}</span>`;
}
function renderHeader() {
  const el = document.getElementById('header-grupo-nombre');
  if (el) el.innerHTML = renderNombreAgrupacion(_config);
}

// ─── RENDER PILLS ────────────────────────────────────────────────────────────
function renderDropdown() {
  const container = document.getElementById('subgrupo-pills');
  if (!container) return;

  const pillGeneral = `
    <div class="sub-pill ${_subActual === '__general__' ? 'active' : ''}" data-sub="__general__">
      <span class="sub-pill-label">General</span>
    </div>`;

  const pillsSub = _subgrupos.map(s => `
    <div class="sub-pill ${s.id === _subActual ? 'active' : ''}" data-sub="${s.id}">
      <span class="sub-pill-label">${esc(s.nombre)}</span>
      <button class="sub-pill-edit" data-edit="${s.id}" title="Editar subgrupo">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"/>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
      </button>
    </div>`).join('');

  const pillNuevo = `
    <button class="sub-pill-nuevo" id="btn-nuevo-subgrupo">＋ Subgrupo</button>`;

  container.innerHTML = pillGeneral + pillsSub + pillNuevo;

  // Clicks en pills
  container.querySelectorAll('.sub-pill').forEach(pill => {
    pill.querySelector('.sub-pill-label').addEventListener('click', () => {
      activarSubgrupo(pill.dataset.sub);
    });
  });

  // Clicks en editar
  container.querySelectorAll('.sub-pill-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      abrirEditSubgrupo(btn.dataset.edit);
    });
  });

  // Nuevo subgrupo
  document.getElementById('btn-nuevo-subgrupo')?.addEventListener('click', abrirModalNuevoSubgrupo);
}

// ─── RENDER ALUMNOS ──────────────────────────────────────────────────────────
function renderAlumnos() {
  const lista = document.getElementById('lista');
  const mes   = getMesActual();

  if (!_listo) {
    lista.innerHTML = `<div class="empty"><span class="empty-icon">⏳</span>Cargando...</div>`;
    return;
  }
  if (!_alumnos.length) {
    lista.innerHTML = `<div class="empty"><span class="empty-icon">📋</span>No hay alumnos todavía.<br>Agregá el primero abajo.</div>`;
    return;
  }

  const query  = (document.getElementById('buscar')?.value || '').toLowerCase().trim();
  const sorted = [..._alumnos]
    .filter(a => !query || a.nombre.toLowerCase().includes(query))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));

  if (!sorted.length) {
    lista.innerHTML = `<div class="empty"><span class="empty-icon">🔍</span>No se encontró "${esc(query)}"</div>`;
    return;
  }

  lista.innerHTML = sorted.map(a => {
    const est    = getEstado(a);
    const pagado = a.ultimoMesPagado === mes;
    return `
      <div class="card" data-action-card="perfil" data-id="${a.id}" style="cursor:pointer;">
        <div class="indicador ${est}"></div>
        <div class="card-inner">
          <div class="nombre">${esc(a.nombre)}</div>
          <div class="card-actions">
            <button class="card-btn pagar ${pagado ? 'done' : ''}"
              data-action="pagar" data-id="${a.id}" data-nombre="${esc(a.nombre)}">
              ${pagado ? 'Pagado' : 'Pago'}
            </button>
            <button class="card-btn plan ${(a.ultimoPlanMes||null) === mes ? 'done' : ''}"
              data-action="plan" data-id="${a.id}" data-nombre="${esc(a.nombre)}">
              ${(a.ultimoPlanMes||null) === mes ? 'Plan ✔' : 'Planificación'}
            </button>
            <button class="card-btn eliminar" style="color:#60a5fa;"
              data-action="perfil" data-id="${a.id}">Info</button>
            <button class="card-btn eliminar"
              data-action="eliminar" data-id="${a.id}" data-nombre="${esc(a.nombre)}">Eliminar</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ─── RENDER RESUMEN ──────────────────────────────────────────────────────────
function renderResumen() {
  renderHeader();
  const precio = getPrecioActivo();
  const mes    = getMesActual();
  const total        = _alumnos.length;
  const pagaron      = _alumnos.filter(a => a.ultimoMesPagado === mes).length;
  const deben        = total - pagaron;
  const planEnviadas = _alumnos.filter(a => (a.ultimoPlanMes || null) === mes).length;
  const planPend     = total - planEnviadas;
  const pctPago      = total ? Math.round((pagaron / total) * 100) : 0;
  const pctPlan      = total ? Math.round((planEnviadas / total) * 100) : 0;
  const $fmt         = n => precio > 0 ? '$' + n.toLocaleString('es-AR') : '—';

  function makeDonut(valor, tot, color) {
    const r = 36, cx = 44, cy = 44, sw = 10;
    const circ = 2 * Math.PI * r;
    const fill  = tot > 0 ? (valor / tot) * circ : 0;
    const empty = circ - fill;
    return `<svg width="88" height="88" viewBox="0 0 88 88">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#2a2a2a" stroke-width="${sw}"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"
        stroke-dasharray="${fill} ${empty}" stroke-dashoffset="0" stroke-linecap="round"
        transform="rotate(-90 ${cx} ${cy}) scale(1 -1) translate(0 -88)"/>
    </svg>`;
  }

  // Nombre del subgrupo activo para mostrar en resumen
  const subLabel = _subActual === '__general__'
    ? 'General'
    : (_subgrupos.find(s => s.id === _subActual)?.nombre || 'Subgrupo');

  document.getElementById('resumen-content').innerHTML = `
  <div id="resumen-inner">
    <div class="rs-logo-row">
      <div class="rs-logo-name">${renderNombreAgrupacion(_config)}</div>
      <div class="rs-logo-sub">${esc(subLabel)} · Resumen mensual</div>
    </div>
    <div class="rs-hero">
      <div>
        <div class="rs-periodo-label">Período actual</div>
        <div class="rs-periodo-mes">${formatMesLabel(mes)}</div>
      </div>
    </div>
    <div class="rs-hero">
      <div>
        <div class="rs-periodo-label">Total alumnos</div>
        <div class="rs-total-num">${total}</div>
      </div>
    </div>
    <div class="rs-dos-col">
      <div class="rs-col-izq">
        <div class="rs-ingresos">
          <div class="rs-ingreso-row principal">
            <div class="rs-ingreso-label">Ingreso actual</div>
            <div class="rs-ingreso-valor">${$fmt(pagaron * precio)}</div>
          </div>
          <div class="rs-ingreso-row">
            <div class="rs-ingreso-label">Ingreso esperado</div>
            <div class="rs-ingreso-valor">${$fmt(total * precio)}</div>
          </div>
        </div>
      </div>
      <div class="rs-col-der">
        <div class="rs-alumnos-wrap">
          <div class="rs-alumnos-legend">
            <div class="rs-legend-row">
              <div class="rs-legend-dot" style="background:#4ade80"></div>
              <div class="rs-legend-num">${pagaron}</div>
              <div class="rs-legend-label">Pagaron</div>
            </div>
            <div class="rs-legend-row">
              <div class="rs-legend-dot" style="background:#f87171"></div>
              <div class="rs-legend-num">${deben}</div>
              <div class="rs-legend-label">Deben</div>
            </div>
          </div>
          <div class="rs-donut-wrap">
            ${makeDonut(pagaron, total, '#4ade80')}
            <div class="rs-donut-center">
              <span class="rs-donut-pct">${pctPago}%</span>
              <span class="rs-donut-sub">pagó</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="rs-plan-wrap">
      <div class="rs-plan-header"><div class="rs-plan-titulo">Planificaciones</div></div>
      <div style="display:flex;align-items:center;gap:24px;">
        <div class="rs-alumnos-legend" style="flex:1;">
          <div class="rs-legend-row">
            <div class="rs-legend-dot" style="background:#c4b5fd"></div>
            <div class="rs-legend-num" style="color:#c4b5fd;">${planEnviadas}</div>
            <div class="rs-legend-label">Enviadas</div>
          </div>
          <div class="rs-legend-row">
            <div class="rs-legend-dot" style="background:#444"></div>
            <div class="rs-legend-num">${planPend}</div>
            <div class="rs-legend-label">Pendientes</div>
          </div>
        </div>
        <div class="rs-donut-wrap">
          ${makeDonut(planEnviadas, total, '#a78bfa')}
          <div class="rs-donut-center">
            <span class="rs-donut-pct" style="color:#c4b5fd;">${pctPlan}%</span>
            <span class="rs-donut-sub">enviado</span>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function render() { renderAlumnos(); renderResumen(); }

// ─── RENDER MÉTRICAS ─────────────────────────────────────────────────────────
function renderMetricas() {
  const el = document.getElementById('metricas-content');
  if (!el) return;

  const alumnos  = _alumnos;
  const hist     = historialConMesActual();
  const series   = Object.entries(hist).sort((a,b) => a[0].localeCompare(b[0]));
  const mesActual = getMesActual();
  const precio   = getPrecioActivo();

  if (!alumnos.length && !series.length) {
    el.innerHTML = `<div class="dash-empty"><div class="dash-empty-title">Sin datos aún</div>Agregá alumnos para ver las métricas del grupo.</div>`;
    return;
  }

  // ── Cobros mes actual ──
  const pagaron    = alumnos.filter(a => a.ultimoMesPagado === mesActual).length;
  const deben      = alumnos.length - pagaron;
  const pctPago    = alumnos.length ? Math.round((pagaron / alumnos.length) * 100) : 0;
  const $fmt       = n => precio > 0 ? '$' + n.toLocaleString('es-AR') : '—';

  // ── Tendencia ──
  let tendencia = null;
  if (series.length >= 2) tendencia = series[series.length-1][1].alumnos - series[series.length-2][1].alumnos;

  // ── Cobro histórico promedio ──
  const cobrosHist    = series.filter(([,s]) => s.alumnos > 0 && s.pagaron != null);
  const pctCobrosHist = cobrosHist.length ? Math.round(cobrosHist.reduce((a,[,s]) => a + (s.pagaron/s.alumnos)*100, 0) / cobrosHist.length) : null;

  // ── Nuevos inscriptos por mes ──
  const altasPorMes = {};
  alumnos.forEach(a => { const ym = (a.fechaAlta || a.fechaInscripcion || '').slice(0,7); if (ym) altasPorMes[ym] = (altasPorMes[ym]||0)+1; });
  series.forEach(([ym, s]) => { if (s.altas && !altasPorMes[ym]) altasPorMes[ym] = s.altas; });
  const altasSeries  = Object.entries(altasPorMes).sort((a,b)=>a[0].localeCompare(b[0]));
  const maxAltas     = altasSeries.length ? Math.max(...altasSeries.map(([,v])=>v)) : 0;
  const mesPicoAltas = altasSeries.find(([,v])=>v===maxAltas)?.[0];
  const altasMesAct  = altasPorMes[mesActual] || 0;

  // ── Alumnos por mes ──
  const conAlumnos      = series.filter(([,s])=>s.alumnos>0);
  const maxAlumnos      = conAlumnos.length ? Math.max(...conAlumnos.map(([,s])=>s.alumnos)) : 0;
  const minAlumnos      = conAlumnos.length ? Math.min(...conAlumnos.map(([,s])=>s.alumnos)) : 0;
  const mesMasAlumnos   = conAlumnos.find(([,s])=>s.alumnos===maxAlumnos)?.[0];
  const mesMenosAlumnos = [...conAlumnos].reverse().find(([,s])=>s.alumnos===minAlumnos)?.[0];

  // ── Edades ──
  const edades   = alumnos.map(a => calcularEdad(a.fechaNacimiento)).filter(e => e !== null);
  const edadProm = edades.length ? Math.round(edades.reduce((a,b)=>a+b,0)/edades.length) : null;
  const edadMax  = edades.length ? Math.max(...edades) : null;
  const edadMin  = edades.length ? Math.min(...edades) : null;
  const rangos   = { '<18': 0, '18-25': 0, '26-35': 0, '36-45': 0, '46-55': 0, '55+': 0 };
  edades.forEach(ed => {
    if      (ed < 18)  rangos['<18']++;
    else if (ed <= 25) rangos['18-25']++;
    else if (ed <= 35) rangos['26-35']++;
    else if (ed <= 45) rangos['36-45']++;
    else if (ed <= 55) rangos['46-55']++;
    else               rangos['55+']++;
  });
  const rangoEntries = Object.entries(rangos).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
  const rangoPred    = rangoEntries[0] || null;
  const edadMaxBar   = rangoEntries.length ? rangoEntries[0][1] : 1;

  // ── Sexo ──
  const sexo  = { M:0, F:0, O:0 };
  alumnos.forEach(a => { if (a.sexo) sexo[a.sexo]++; });
  const conSexo = sexo.M + sexo.F + sexo.O;
  const pctM = conSexo ? Math.round((sexo.M/conSexo)*100) : 0;
  const pctF = conSexo ? Math.round((sexo.F/conSexo)*100) : 0;
  const pctO = conSexo ? Math.round((sexo.O/conSexo)*100) : 0;
  const sexoPred = conSexo ? (sexo.M>=sexo.F&&sexo.M>=sexo.O ? `Masculino ${pctM}%` : sexo.F>=sexo.M&&sexo.F>=sexo.O ? `Femenino ${pctF}%` : `Otro ${pctO}%`) : null;

  // ── Nivel ──
  const niv = { Principiante:0, Intermedio:0, Avanzado:0 };
  alumnos.forEach(a => { if (a.nivel && niv[a.nivel] !== undefined) niv[a.nivel]++; });
  const conNivel  = niv.Principiante + niv.Intermedio + niv.Avanzado;
  const nivelPred = conNivel ? [['Principiante',niv.Principiante],['Intermedio',niv.Intermedio],['Avanzado',niv.Avanzado]].sort((a,b)=>b[1]-a[1])[0][0] : null;

  // ── Antigüedad ──
  const hoy = new Date();
  let diasAcum = 0, conFecha = 0;
  alumnos.forEach(a => { const f = a.fechaAlta || a.fechaInscripcion; if (!f) return; diasAcum += (hoy-new Date(f))/(1000*60*60*24); conFecha++; });
  const antigMeses = conFecha ? (diasAcum/conFecha/30.4).toFixed(1) : null;

  // ── Helper barras ──
  function bar(label, val, max, color, showPct) {
    const pct = max > 0 ? Math.round((val/max)*100) : 0;
    return `<div class="dash-bar-row"><div class="dash-bar-label">${label}</div><div class="dash-bar-track"><div class="dash-bar-fill" style="width:${pct}%;background:${color};"></div></div>${showPct ? `<div class="dash-bar-pct">${val} <span style="color:#333;">(${pct}%)</span></div>` : `<div class="dash-bar-val">${val}</div>`}</div>`;
  }

  // ── Filas historial alumnos ──
  const maxBar  = maxAlumnos || 1;
  const mesRows = series.slice(-12).map(([ym, s]) => {
    const isCur = ym === mesActual;
    const isMax = ym === mesMasAlumnos   && series.length > 1;
    const isMin = ym === mesMenosAlumnos && series.length > 1 && !isCur;
    const badge = isCur ? `<span class="dash-month-badge cur">Actual</span>` : isMax ? `<span class="dash-month-badge max">Pico</span>` : isMin ? `<span class="dash-month-badge min">Baja</span>` : '';
    return `<div class="dash-month-row"><div class="dash-month-name">${formatMesLabel(ym)}</div><div class="dash-month-bar-wrap"><div class="dash-month-bar ${isMax?'is-max':isMin?'is-min':''}" style="width:${Math.round((s.alumnos/maxBar)*100)}%;${isCur?'background:#60a5fa;':''}"></div></div><div class="dash-month-num">${s.alumnos}</div>${badge}</div>`;
  }).join('');

  // ── Filas nuevos inscriptos ──
  const maxAltasBar = maxAltas || 1;
  const altasRows   = altasSeries.slice(-12).map(([ym, v]) => {
    const isCur = ym === mesActual;
    const isMax = ym === mesPicoAltas && altasSeries.length > 1;
    const badge = isCur ? `<span class="dash-month-badge cur">Actual</span>` : isMax ? `<span class="dash-month-badge max">Pico</span>` : '';
    return `<div class="dash-month-row"><div class="dash-month-name">${formatMesLabel(ym)}</div><div class="dash-month-bar-wrap"><div class="dash-month-bar ${isMax?'is-max':''}" style="width:${Math.round((v/maxAltasBar)*100)}%;${isCur?'background:#60a5fa;':''}"></div></div><div class="dash-month-num">${v}</div>${badge}</div>`;
  }).join('');

  const subLabel = _subActual === '__general__' ? 'General' : (_subgrupos.find(s=>s.id===_subActual)?.nombre||'Subgrupo');

  el.innerHTML = `
    <div class="dash-header">
      <div class="dash-header-title">Análisis del grupo · ${subLabel}</div>
      <div class="dash-header-subtitle">${alumnos.length} alumno${alumnos.length!==1?'s':''} activos · ${series.length} mes${series.length!==1?'es':''} de historial</div>
    </div>

    <div class="dash-kpi-grid">
      <div class="dash-kpi">
        <div class="dash-kpi-label">Alumnos hoy</div>
        <div class="dash-kpi-value">${alumnos.length}</div>
        ${tendencia !== null && tendencia !== 0 ? `<div class="dash-kpi-delta ${tendencia>0?'up':'down'}">${tendencia>0?'▲':'▼'} ${Math.abs(tendencia)} vs mes ant.</div>` : tendencia === 0 ? `<div class="dash-kpi-delta">= igual que mes ant.</div>` : ''}
      </div>
      <div class="dash-kpi">
        <div class="dash-kpi-label">Cobrado este mes</div>
        <div class="dash-kpi-value accent-green">${pctPago}%</div>
        <div class="dash-kpi-progress"><div class="dash-kpi-progress-fill" style="width:${pctPago}%;background:#4ade80;"></div></div>
        <div class="dash-kpi-sub">${pagaron} pagaron · ${deben} deben</div>
      </div>
      <div class="dash-kpi">
        <div class="dash-kpi-label">Cobro prom. histórico</div>
        <div class="dash-kpi-value${pctCobrosHist!==null&&pctCobrosHist>=80?' accent-green':pctCobrosHist!==null&&pctCobrosHist<65?' accent-red':''}">${pctCobrosHist !== null ? pctCobrosHist+'%' : '—'}</div>
        <div class="dash-kpi-sub">Sobre ${cobrosHist.length} mes${cobrosHist.length!==1?'es':''}</div>
      </div>
      <div class="dash-kpi">
        <div class="dash-kpi-label">Nuevos este mes</div>
        <div class="dash-kpi-value accent-blue">${altasMesAct}</div>
        ${mesPicoAltas && mesPicoAltas !== mesActual ? `<div class="dash-kpi-sub">Pico: ${formatMesLabel(mesPicoAltas)} (${maxAltas})</div>` : ''}
      </div>
    </div>

    <div class="dash-two-col">
      <div class="dash-panel">
        <div class="dash-section-label">Rango etario${edadProm !== null ? `<span>Prom. ${edadProm} · Rango ${edadMin}–${edadMax}</span>` : ''}</div>
        ${rangoEntries.length
          ? rangoEntries.map(([l,v]) => bar(l, v, edadMaxBar, l === (rangoPred&&rangoPred[0]) ? '#60a5fa' : '#243040', true)).join('') +
            (rangoPred ? `<div class="dash-insight-pill" style="margin-top:10px;">Predomina <strong>${rangoPred[0]}</strong> con ${Math.round((rangoPred[1]/alumnos.length)*100)}% del grupo</div>` : '')
          : '<div class="dash-no-data">Cargá fechas de nacimiento en los perfiles</div>'}
      </div>
      <div class="dash-panel">
        <div class="dash-section-label">Sexo${conSexo>0?`<span>${conSexo} / ${alumnos.length} con dato</span>`:''}</div>
        ${conSexo > 0 ? `
          <div class="dash-sexo-bars">
            <div class="dash-sexo-bar-row">
              <div class="dash-sexo-label">M</div>
              <div class="dash-sexo-track"><div class="dash-sexo-fill" style="width:${pctM}%;background:#60a5fa;"></div></div>
              <div class="dash-sexo-stat"><strong>${sexo.M}</strong> <span>${pctM}%</span></div>
            </div>
            <div class="dash-sexo-bar-row">
              <div class="dash-sexo-label">F</div>
              <div class="dash-sexo-track"><div class="dash-sexo-fill" style="width:${pctF}%;background:#fb923c;"></div></div>
              <div class="dash-sexo-stat"><strong>${sexo.F}</strong> <span>${pctF}%</span></div>
            </div>
            ${sexo.O > 0 ? `<div class="dash-sexo-bar-row"><div class="dash-sexo-label">O</div><div class="dash-sexo-track"><div class="dash-sexo-fill" style="width:${pctO}%;background:#a78bfa;"></div></div><div class="dash-sexo-stat"><strong>${sexo.O}</strong> <span>${pctO}%</span></div></div>` : ''}
          </div>
          <div class="dash-insight-pill" style="margin-top:8px;">Predomina <strong>${sexoPred}</strong></div>
        ` : '<div class="dash-no-data">Cargá el sexo en los perfiles</div>'}

        <div class="dash-section-label" style="margin-top:18px;">Nivel${conNivel>0?`<span>${conNivel} / ${alumnos.length} con dato</span>`:''}</div>
        ${conNivel > 0 ? `
          ${bar('Principiante', niv.Principiante, conNivel, '#4ade80', true)}
          ${bar('Intermedio',   niv.Intermedio,   conNivel, '#fbbf24', true)}
          ${bar('Avanzado',     niv.Avanzado,     conNivel, '#f87171', true)}
          ${nivelPred ? `<div class="dash-insight-pill" style="margin-top:8px;">Nivel predominante: <strong>${nivelPred}</strong></div>` : ''}
        ` : '<div class="dash-no-data">Cargá el nivel en los perfiles</div>'}
      </div>
    </div>

    <div class="dash-full">
      <div class="dash-section-label">Alumnos por mes${mesMasAlumnos?`<span>Pico: ${formatMesLabel(mesMasAlumnos)} · ${maxAlumnos}</span>`:''}</div>
      ${series.length ? mesRows : '<div class="dash-no-data">Se acumula automáticamente cada mes.</div>'}
    </div>

    <div class="dash-full">
      <div class="dash-section-label">Nuevas incorporaciones por mes${mesPicoAltas?`<span>Mejor: ${formatMesLabel(mesPicoAltas)} · ${maxAltas}</span>`:''}</div>
      ${altasSeries.length ? altasRows : '<div class="dash-no-data">Se registra al agregar cada alumno.</div>'}
    </div>

    <div class="dash-two-col">
      <div class="dash-panel">
        <div class="dash-section-label">Cobros — ${formatMesLabel(mesActual)}</div>
        <div class="dash-stat-row"><div class="dash-stat-name">Pagaron</div><div class="dash-stat-val" style="color:#4ade80;">${pagaron}</div></div>
        <div class="dash-stat-row"><div class="dash-stat-name">Deben</div><div class="dash-stat-val" style="color:#f87171;">${deben}</div></div>
        <div class="dash-stat-row"><div class="dash-stat-name">Tasa de cobro</div><div class="dash-stat-val">${pctPago}%</div></div>
        ${precio>0?`<div class="dash-stat-row"><div class="dash-stat-name">Cobrado</div><div class="dash-stat-val">${$fmt(pagaron*precio)}</div></div><div class="dash-stat-row"><div class="dash-stat-name">Deuda pendiente</div><div class="dash-stat-val" style="color:#f87171;">${$fmt(deben*precio)}</div></div>`:''}
        ${pctCobrosHist !== null && pctCobrosHist < 75 ? `<div class="dash-insight-pill" style="margin-top:10px;border-color:rgba(251,191,36,.2);background:rgba(251,191,36,.06);color:#fbbf24;">Tasa histórica baja (${pctCobrosHist}%). Revisá alumnos morosos.</div>` : ''}
      </div>
      <div class="dash-panel">
        <div class="dash-section-label">Grupo</div>
        <div class="dash-stat-row"><div class="dash-stat-name">Antigüedad prom.</div><div class="dash-stat-val">${antigMeses !== null ? antigMeses+' meses' : '—'}</div></div>
        <div class="dash-stat-row"><div class="dash-stat-name">Rango etario ppal.</div><div class="dash-stat-val">${rangoPred ? rangoPred[0] : '—'}</div></div>
        <div class="dash-stat-row"><div class="dash-stat-name">Sexo predominante</div><div class="dash-stat-val">${sexoPred || '—'}</div></div>
        <div class="dash-stat-row"><div class="dash-stat-name">Nivel predominante</div><div class="dash-stat-val">${nivelPred || '—'}</div></div>
      </div>
    </div>
  `;
}

// ─── DATOS ALUMNOS ───────────────────────────────────────────────────────────
async function agregarAlumno(nombre, fechaNac) {
  const nuevaLista = [..._alumnos, {
    id: Date.now(), nombre: capitalizar(nombre.trim()),
    fechaAlta: new Date().toISOString().slice(0,10),
    fechaNacimiento: fechaNac || null,
    ultimoMesPagado: null, ultimoPlanMes: null
  }];
  await guardarAlumnos(nuevaLista);
  // Graba snapshot para registrar la alta
  await grabarSnapshot(nuevaLista, getMesActual());
}
async function eliminarAlumno(id) { await guardarAlumnos(_alumnos.filter(a => a.id !== id)); }
async function pagarAlumno(id) {
  const nuevaLista = _alumnos.map(a =>
    a.id === id && a.ultimoMesPagado !== getMesActual() ? { ...a, ultimoMesPagado: getMesActual() } : a
  );
  await guardarAlumnos(nuevaLista);
  // Graba snapshot para registrar el cobro
  await grabarSnapshot(nuevaLista, getMesActual());
}
async function enviarPlan(id) {
  await guardarAlumnos(_alumnos.map(a =>
    a.id === id && (a.ultimoPlanMes||null) !== getMesActual() ? { ...a, ultimoPlanMes: getMesActual() } : a
  ));
}

// ─── MODALES ALUMNOS ─────────────────────────────────────────────────────────
function abrirModal() {
  document.getElementById('input-nombre').value = '';
  document.getElementById('input-fnac').value   = '';
  document.getElementById('overlay').classList.add('open');
  setTimeout(() => document.getElementById('input-nombre').focus(), 120);
}
function cerrarModal() { document.getElementById('overlay').classList.remove('open'); }
async function confirmarAgregar() {
  const nombre   = document.getElementById('input-nombre').value.trim();
  const fechaNac = document.getElementById('input-fnac').value || null;
  if (!nombre) { document.getElementById('input-nombre').focus(); return; }
  await agregarAlumno(nombre, fechaNac);
  cerrarModal();
}

// ─── HELPERS PERFIL ──────────────────────────────────────────────────────────
function calcularEdad(fnac) {
  if (!fnac) return null;
  const hoy   = new Date();
  const nac   = new Date(fnac);
  let edad    = hoy.getFullYear() - nac.getFullYear();
  const m     = hoy.getMonth() - nac.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < nac.getDate())) edad--;
  return edad;
}

function perfilSetSexo(sexo) {
  document.querySelectorAll('.perfil-sexo-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.sexo === sexo);
  });
}

function perfilSetNivel(nivel) {
  document.querySelectorAll('.perfil-nivel-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.nivel === nivel);
  });
}

function perfilGetSexo() {
  const sel = document.querySelector('.perfil-sexo-btn.selected');
  return sel ? sel.dataset.sexo : null;
}

function perfilGetNivel() {
  const sel = document.querySelector('.perfil-nivel-btn.selected');
  return sel ? sel.dataset.nivel : null;
}

let _perfilId = null;

function abrirPerfil(id) {
  const a = _alumnos.find(x => x.id === id);
  if (!a) return;
  _perfilId = id;

  // Hero
  const inicial = (a.nombre || '?')[0].toUpperCase();
  document.getElementById('perfil-avatar').textContent      = inicial;
  document.getElementById('perfil-hero-nombre').textContent = a.nombre;

  // Meta badges (edad + sexo + nivel)
  const meta = document.getElementById('perfil-hero-meta');
  meta.innerHTML = '';
  const edad = calcularEdad(a.fechaNacimiento);
  if (edad !== null) { const s = document.createElement('span'); s.textContent = `${edad} años`; meta.appendChild(s); }
  if (a.sexo)        { const s = document.createElement('span'); s.textContent = a.sexo === 'M' ? '♂ Masc.' : a.sexo === 'F' ? '♀ Fem.' : '⊕ Otro'; meta.appendChild(s); }
  if (a.nivel)       { const s = document.createElement('span'); s.textContent = a.nivel; meta.appendChild(s); }

  // Campos tab Info
  document.getElementById('perfil-nombre').value  = a.nombre;
  document.getElementById('perfil-fnac').value    = a.fechaNacimiento || '';
  document.getElementById('perfil-notas').value   = a.notas || '';
  perfilSetSexo(a.sexo || null);

  // Badge edad
  const badge = document.getElementById('perfil-edad-badge');
  badge.textContent = edad !== null ? `${edad} años` : '';

  // Campos tab Deportivo
  document.getElementById('perfil-objetivos').value   = a.objetivos    || '';
  document.getElementById('perfil-marca').value       = a.mejorMarca   || '';
  document.getElementById('perfil-inscripcion').value = a.fechaInscripcion || '';
  perfilSetNivel(a.nivel || null);

  // Activar tab info por defecto
  perfilCambiarTab('info');

  document.getElementById('perfil-overlay').classList.add('open');
}

function cerrarPerfil() {
  _perfilId = null;
  document.getElementById('perfil-overlay').classList.remove('open');
}

function perfilCambiarTab(tab) {
  document.querySelectorAll('.perfil-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.ptab === tab));
  document.querySelectorAll('.perfil-panel').forEach(p =>
    p.classList.toggle('active', p.id === `ppanel-${tab}`));
}

async function guardarPerfil() {
  if (_perfilId === null) return;
  const nombre = capitalizar(document.getElementById('perfil-nombre').value.trim());
  if (!nombre) { document.getElementById('perfil-nombre').focus(); return; }
  const fnac           = document.getElementById('perfil-fnac').value || null;
  const notas          = document.getElementById('perfil-notas').value.trim() || null;
  const objetivos      = document.getElementById('perfil-objetivos').value.trim() || null;
  const mejorMarca     = document.getElementById('perfil-marca').value.trim() || null;
  const fechaInscripcion = document.getElementById('perfil-inscripcion').value || null;
  const sexo           = perfilGetSexo();
  const nivel          = perfilGetNivel();

  await guardarAlumnos(_alumnos.map(a =>
    a.id === _perfilId
      ? { ...a, nombre, fechaNacimiento: fnac, notas, objetivos, mejorMarca, fechaInscripcion, sexo, nivel }
      : a
  ));
  cerrarPerfil();
}

let _pagoId = null;
function abrirConfirmPago(id, nombre) {
  _pagoId = id;
  document.getElementById('confirm-nombre').textContent = nombre;
  document.getElementById('confirm-overlay').classList.add('open');
}
function cerrarConfirmPago() { _pagoId = null; document.getElementById('confirm-overlay').classList.remove('open'); }
async function ejecutarPago() { if (_pagoId !== null) await pagarAlumno(_pagoId); cerrarConfirmPago(); }

let _planId = null;
function abrirConfirmPlan(id, nombre) {
  _planId = id;
  document.getElementById('plan-nombre').textContent = nombre;
  document.getElementById('plan-overlay').classList.add('open');
}
function cerrarConfirmPlan() { _planId = null; document.getElementById('plan-overlay').classList.remove('open'); }
async function ejecutarPlan() { if (_planId !== null) await enviarPlan(_planId); cerrarConfirmPlan(); }
async function pedirEliminar(id, nombre) {
  if (confirm(`¿Eliminar a ${nombre}?`)) await eliminarAlumno(id);
}

// ─── MODAL NUEVO SUBGRUPO ────────────────────────────────────────────────────
function abrirModalNuevoSubgrupo() {
  document.getElementById('nuevo-sub-nombre').value = '';
  document.getElementById('nuevo-sub-precio').value = '';
  document.getElementById('nuevo-sub-precio-label').textContent =
    _config.precio ? `<svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><line x1='2' y1='12' x2='22' y2='12'/><path d='M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'/></svg> Precio global: $\${Number(_config.precio).toLocaleString('es-AR')}` : '';
  document.getElementById('nuevo-sub-overlay').classList.add('open');
  setTimeout(() => document.getElementById('nuevo-sub-nombre').focus(), 120);
}
function cerrarModalNuevoSubgrupo() {
  document.getElementById('nuevo-sub-overlay').classList.remove('open');
  // Resetear select al valor anterior
  renderDropdown();
}
async function confirmarNuevoSubgrupo() {
  const nombre = document.getElementById('nuevo-sub-nombre').value.trim();
  if (!nombre) { document.getElementById('nuevo-sub-nombre').focus(); return; }
  const precioVal = document.getElementById('nuevo-sub-precio').value;
  const precio    = precioVal !== '' ? Number(precioVal) : null;
  const sid = await crearSubgrupo(nombre, precio);
  await cargarSubgrupos();
  cerrarModalNuevoSubgrupo();
  activarSubgrupo(sid);
}

// ─── EDITAR SUBGRUPO ─────────────────────────────────────────────────────────
let _editSubId = null;

function abrirEditSubgrupo(sid) {
  const sub = _subgrupos.find(s => s.id === sid);
  if (!sub) return;
  _editSubId = sid;
  document.getElementById('edit-sub-nombre').value = sub.nombre || '';
  document.getElementById('edit-sub-precio').value = sub.precio != null ? sub.precio : '';
  document.getElementById('edit-sub-precio-hint').innerHTML =
    _config.precio ? `<svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><line x1='2' y1='12' x2='22' y2='12'/><path d='M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'/></svg> Precio global: $\${Number(_config.precio).toLocaleString('es-AR')}` : '';
  document.getElementById('edit-sub-overlay').classList.add('open');
  setTimeout(() => document.getElementById('edit-sub-nombre').focus(), 120);
}
function cerrarEditSubgrupo() {
  _editSubId = null;
  document.getElementById('edit-sub-overlay').classList.remove('open');
}
async function guardarEditSubgrupo() {
  if (!_editSubId) return;
  const nombre    = document.getElementById('edit-sub-nombre').value.trim();
  if (!nombre) { document.getElementById('edit-sub-nombre').focus(); return; }
  const precioVal = document.getElementById('edit-sub-precio').value;
  const precio    = precioVal !== '' ? Number(precioVal) : null;
  const datos     = precio != null ? { nombre, precio } : { nombre };
  await setDoc(refSubgrupo(_editSubId), datos);
  await cargarSubgrupos();
  cerrarEditSubgrupo();
  renderDropdown();
  renderResumen();
}
async function eliminarDesdeEdit() {
  if (!_editSubId) return;
  const sub = _subgrupos.find(s => s.id === _editSubId);
  if (!sub) return;
  const tieneAlumnos = _subActual === _editSubId && _alumnos.length > 0;
  const msg = tieneAlumnos
    ? `¿Eliminar "${sub.nombre}"? Tiene ${_alumnos.length} alumno(s) que se perderán.`
    : `¿Eliminar el subgrupo "${sub.nombre}"?`;
  if (!confirm(msg)) return;
  const sidAEliminar = _editSubId;
  cerrarEditSubgrupo();
  await eliminarSubgrupo(sidAEliminar);
  if (_subActual === sidAEliminar) activarSubgrupo('__general__');
  renderDropdown();
}

// ─── TABS ────────────────────────────────────────────────────────────────────
function cambiarTab(tab) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(tab)?.classList.add('active');
  document.getElementById('tab-' + tab)?.classList.add('active');
}

// ─── CONFIGURACIÓN ───────────────────────────────────────────────────────────
function actualizarPreview() {
  const nombre = document.getElementById('config-nombre').value || 'Mi agrupación';
  document.getElementById('config-split').max = nombre.length;
  const split  = parseInt(document.getElementById('config-split').value);
  document.getElementById('config-split-val').textContent = isNaN(split) ? 0 : split;
  const color1 = document.getElementById('config-color1').value;
  const color2 = document.getElementById('config-color2').value;
  document.getElementById('config-preview').innerHTML = renderNombreAgrupacion({
    nombreGrupo: nombre, grupoSplit: isNaN(split) ? null : split,
    grupoColor1: color1, grupoColor2: color2
  });
}
function abrirConfig() {
  document.getElementById('config-precio').value = _config.precio      || '';
  document.getElementById('config-nombre').value = _config.nombreGrupo || '';
  const splitVal = _config.grupoSplit != null ? _config.grupoSplit : 0;
  document.getElementById('config-split').max   = (_config.nombreGrupo || '').length || 20;
  document.getElementById('config-split').value = splitVal;
  document.getElementById('config-split-val').textContent = splitVal;
  document.getElementById('config-color1').value = _config.grupoColor1 || '#60a5fa';
  document.getElementById('config-color2').value = _config.grupoColor2 || '#fb923c';
  actualizarPreview();
  document.getElementById('config-overlay').classList.add('open');
}
function cerrarConfig() { document.getElementById('config-overlay').classList.remove('open'); }
async function guardarConfigModal() {
  const precio      = Number(document.getElementById('config-precio').value) || 0;
  const nombreGrupo = document.getElementById('config-nombre').value.trim() || 'Mi agrupación';
  const splitVal    = parseInt(document.getElementById('config-split').value);
  const grupoSplit  = isNaN(splitVal) ? null : splitVal;
  const grupoColor1 = document.getElementById('config-color1').value;
  const grupoColor2 = document.getElementById('config-color2').value;
  await guardarConfigGlobal({ precio, nombreGrupo, grupoSplit, grupoColor1, grupoColor2 });
  cerrarConfig();
  renderResumen();
}

// ─── EXPORT / IMPORT ─────────────────────────────────────────────────────────
function exportar() {
  const blob = new Blob([JSON.stringify(_alumnos, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `profetracker_backup_${getMesActual()}.json`;
  a.click();
}
function importar(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try { await guardarAlumnos(JSON.parse(reader.result)); }
    catch { alert('Archivo inválido.'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ─── EVENT LISTENERS ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  const doLogin = async () => {
    const email = document.getElementById('login-email').value.trim();
    const pass  = document.getElementById('login-pass').value;
    document.getElementById('login-error').textContent = '';
    try { await signInWithEmailAndPassword(auth, email, pass); }
    catch { document.getElementById('login-error').textContent = 'Email o contraseña incorrectos.'; }
  };
  document.getElementById('login-btn') ?.addEventListener('click', doLogin);
  document.getElementById('login-pass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // Dropdown subgrupos
  document.getElementById('subgrupo-select')?.addEventListener('change', e => {
    const val = e.target.value;
    if (val === '__nuevo__') {
      abrirModalNuevoSubgrupo();
    } else {
      activarSubgrupo(val);
    }
  });

  // Modal editar subgrupo
  document.getElementById('edit-sub-cerrar-x') ?.addEventListener('click', cerrarEditSubgrupo);
  document.getElementById('edit-sub-cancelar') ?.addEventListener('click', cerrarEditSubgrupo);
  document.getElementById('edit-sub-guardar')  ?.addEventListener('click', guardarEditSubgrupo);
  document.getElementById('edit-sub-eliminar') ?.addEventListener('click', eliminarDesdeEdit);
  document.getElementById('edit-sub-nombre')   ?.addEventListener('keydown', e => { if (e.key === 'Enter') guardarEditSubgrupo(); });
  document.getElementById('edit-sub-overlay')  ?.addEventListener('click', e => {
    if (e.target === document.getElementById('edit-sub-overlay')) cerrarEditSubgrupo();
  });

  // Modal nuevo subgrupo
  document.getElementById('nuevo-sub-cancelar')  ?.addEventListener('click', cerrarModalNuevoSubgrupo);
  document.getElementById('nuevo-sub-confirmar') ?.addEventListener('click', confirmarNuevoSubgrupo);
  document.getElementById('nuevo-sub-nombre')    ?.addEventListener('keydown', e => { if (e.key === 'Enter') confirmarNuevoSubgrupo(); });
  document.getElementById('nuevo-sub-overlay')   ?.addEventListener('click', e => {
    if (e.target === document.getElementById('nuevo-sub-overlay')) cerrarModalNuevoSubgrupo();
  });

  // App
  document.getElementById('btn-nuevo-subgrupo')  ?.addEventListener('click', abrirModalNuevoSubgrupo);
  document.getElementById('btn-agregar')         ?.addEventListener('click', abrirModal);
  document.getElementById('btn-cancelar')        ?.addEventListener('click', cerrarModal);
  document.getElementById('btn-cancelar-2')      ?.addEventListener('click', cerrarModal);
  document.getElementById('perfil-cancelar-x')   ?.addEventListener('click', cerrarPerfil);
  document.getElementById('nuevo-sub-cerrar-x')  ?.addEventListener('click', cerrarModalNuevoSubgrupo);
  document.getElementById('btn-confirmar')       ?.addEventListener('click', confirmarAgregar);
  document.getElementById('btn-config')          ?.addEventListener('click', abrirConfig);
  document.getElementById('config-cancelar')     ?.addEventListener('click', cerrarConfig);
  document.getElementById('config-cerrar-x')     ?.addEventListener('click', cerrarConfig);
  document.getElementById('config-guardar')      ?.addEventListener('click', guardarConfigModal);
  document.getElementById('config-nombre')       ?.addEventListener('input', actualizarPreview);
  document.getElementById('config-split')        ?.addEventListener('input', actualizarPreview);
  document.getElementById('config-color1')       ?.addEventListener('input', actualizarPreview);
  document.getElementById('config-color2')       ?.addEventListener('input', actualizarPreview);
  document.getElementById('btn-exportar')        ?.addEventListener('click', exportar);
  document.getElementById('btn-importar')        ?.addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile')          ?.addEventListener('change', importar);
  document.getElementById('btn-salir')           ?.addEventListener('click', () => signOut(auth));
  document.getElementById('tab-alumnos')         ?.addEventListener('click', () => cambiarTab('alumnos'));
  document.getElementById('tab-resumen')         ?.addEventListener('click', () => cambiarTab('resumen'));
  document.getElementById('perfil-cancelar')     ?.addEventListener('click', cerrarPerfil);
  document.getElementById('perfil-guardar')      ?.addEventListener('click', guardarPerfil);
  document.getElementById('confirm-si-pago')     ?.addEventListener('click', ejecutarPago);
  document.getElementById('confirm-no-pago')     ?.addEventListener('click', cerrarConfirmPago);
  document.getElementById('confirm-si-plan')     ?.addEventListener('click', ejecutarPlan);
  document.getElementById('confirm-no-plan')     ?.addEventListener('click', cerrarConfirmPlan);
  document.getElementById('input-nombre')        ?.addEventListener('keydown', e => { if (e.key === 'Enter') confirmarAgregar(); });
  document.getElementById('overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('overlay')) cerrarModal();
  });
  document.getElementById('buscar')?.addEventListener('input', renderAlumnos);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { cerrarConfig(); cerrarModalNuevoSubgrupo(); cerrarEditSubgrupo(); cerrarPerfil(); } });

  // Tabs internos del perfil
  document.querySelectorAll('.perfil-tab').forEach(tab => {
    tab.addEventListener('click', () => perfilCambiarTab(tab.dataset.ptab));
  });

  // Botones sexo
  document.querySelectorAll('.perfil-sexo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const yaSelec = btn.classList.contains('selected');
      perfilSetSexo(yaSelec ? null : btn.dataset.sexo);
    });
  });

  // Botones nivel
  document.querySelectorAll('.perfil-nivel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const yaSelec = btn.classList.contains('selected');
      perfilSetNivel(yaSelec ? null : btn.dataset.nivel);
    });
  });

  // Actualizar badge de edad al cambiar fecha
  document.getElementById('perfil-fnac')?.addEventListener('change', e => {
    const badge = document.getElementById('perfil-edad-badge');
    const edad  = calcularEdad(e.target.value);
    badge.textContent = edad !== null ? `${edad} años` : '';
  });

  // Sub-tabs del Resumen
  document.getElementById('rsubtab-mes')?.addEventListener('click', () => {
    document.getElementById('rsubtab-mes').classList.add('active');
    document.getElementById('rsubtab-metricas').classList.remove('active');
    document.getElementById('resumen-content').style.display = '';
    document.getElementById('metricas-content').style.display = 'none';
  });
  document.getElementById('rsubtab-metricas')?.addEventListener('click', () => {
    document.getElementById('rsubtab-metricas').classList.add('active');
    document.getElementById('rsubtab-mes').classList.remove('active');
    document.getElementById('resumen-content').style.display = 'none';
    document.getElementById('metricas-content').style.display = '';
    renderMetricas();
  });

  document.getElementById('lista')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id, nombre } = btn.dataset;
    const numId = Number(id);
    if (action === 'pagar'   && !btn.classList.contains('done')) abrirConfirmPago(numId, nombre);
    if (action === 'plan'    && !btn.classList.contains('done')) abrirConfirmPlan(numId, nombre);
    if (action === 'perfil')   abrirPerfil(numId);
    if (action === 'eliminar') pedirEliminar(numId, nombre);
  });
});

// ─── AUTH STATE ──────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  const loginScreen = document.getElementById('login-screen');
  const appScreen   = document.getElementById('app-screen');

  if (user) {
    _uid = user.uid;
    loginScreen.style.display = 'none';
    appScreen.style.display   = 'block';

    const logoEl = document.getElementById('logo-imagen');
    if (logoEl) {
      logoEl.src = `logos/logo_${user.uid}.png`;
      logoEl.onerror = () => { logoEl.src = 'logos/logo_default.png'; };
    }

    // Si no existe config, crearla con defaults
    const cfgSnap = await getDoc(refConfig());
    if (!cfgSnap.exists()) {
      await setDoc(refConfig(), {
        precio: 0, nombreGrupo: 'Mi agrupación',
        grupoSplit: null, grupoColor1: '#60a5fa', grupoColor2: '#fb923c'
      });
    }
    _config = (await getDoc(refConfig())).data();
    renderHeader();

    // Escuchar config en tiempo real
    if (_unsubConfig) _unsubConfig();
    _unsubConfig = onSnapshot(refConfig(), snap => {
      _config = snap.exists() ? snap.data() : { precio: 0 };
      renderHeader();
    });

    // Cargar subgrupos y activar General
    await cargarSubgrupos();
    renderDropdown();
    activarSubgrupo('__general__');

  } else {
    _uid = null; _subgrupos = []; _subActual = '__general__'; _listo = false;
    loginScreen.style.display = 'flex';
    appScreen.style.display   = 'none';
    if (_unsubAlumnos) { _unsubAlumnos(); _unsubAlumnos = null; }
    if (_unsubConfig)  { _unsubConfig();  _unsubConfig  = null; }
  }
});
