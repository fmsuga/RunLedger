import { initializeApp }                        from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js';
import { getFirestore, doc, setDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js';
import { getAuth, signInWithEmailAndPassword,
         onAuthStateChanged, signOut }            from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
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

// Referencias dinámicas — se asignan cuando el usuario se loguea
let REF_ALUMNOS = null;
let REF_CONFIG  = null;

let _alumnos = [];
let _config  = { precio: 0 };
let _listo   = false;

// ─── TIEMPO ──────────────────────────────────────────────────────────────────
function getMesActual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function getDia() { return new Date().getDate(); }

function formatMesLabel(ym) {
  if (!ym) return 'sin pagos';
  const [y, m] = ym.split('-');
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                 'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  return `${meses[+m-1]} ${y}`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ─── ESTADO ──────────────────────────────────────────────────────────────────
function getEstado(a) {
  if (a.ultimoMesPagado === getMesActual()) return 'verde';
  return getDia() <= 10 ? 'amarillo' : 'rojo';
}

// ─── FIRESTORE ───────────────────────────────────────────────────────────────
async function guardarAlumnos(lista) {
  await setDoc(REF_ALUMNOS, { lista });
}
async function guardarConfig(cfg) {
  _config = cfg;
  await setDoc(REF_CONFIG, cfg);
}

// ─── HELPER: renderizar nombre del grupo con colores ─────────────────────────
function renderNombreGrupo(cfg) {
  const nombre = cfg.nombreGrupo || 'Mi grupo';
  const split  = cfg.grupoSplit  != null ? cfg.grupoSplit : nombre.length;
  const color1 = cfg.grupoColor1 || '#60a5fa';
  const color2 = cfg.grupoColor2 || '#fb923c';
  const p1 = nombre.slice(0, split);
  const p2 = nombre.slice(split);
  if (p2) {
    return `<span style="color:${color1}">${p1}</span><span style="color:${color2}">${p2}</span>`;
  }
  return `<span style="color:${color1}">${p1}</span>`;
}

// ─── DATOS ───────────────────────────────────────────────────────────────────
async function agregarAlumno(nombre, fechaNac) {
  await guardarAlumnos([..._alumnos, {
    id:              Date.now(),
    nombre:          capitalizar(nombre.trim()),
    fechaAlta:       new Date().toISOString().slice(0, 10),
    fechaNacimiento: fechaNac || null,
    ultimoMesPagado: null,
    ultimoPlanMes:   null
  }]);
}
async function eliminarAlumno(id) {
  await guardarAlumnos(_alumnos.filter(a => a.id !== id));
}
async function pagarAlumno(id) {
  await guardarAlumnos(_alumnos.map(a =>
    a.id === id && a.ultimoMesPagado !== getMesActual()
      ? { ...a, ultimoMesPagado: getMesActual() } : a
  ));
}
async function enviarPlan(id) {
  await guardarAlumnos(_alumnos.map(a =>
    a.id === id && (a.ultimoPlanMes || null) !== getMesActual()
      ? { ...a, ultimoPlanMes: getMesActual() } : a
  ));
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
    const est         = getEstado(a);
    const pagado      = a.ultimoMesPagado === mes;
    const planEnviada = (a.ultimoPlanMes || null) === mes;

    const fnacLabel = a.fechaNacimiento
      ? (() => { const [y,m,d] = a.fechaNacimiento.split('-'); return `${d}/${m}/${y}`; })()
      : null;

    return `
      <div class="card">
        <div class="indicador ${est}"></div>
        <div class="card-inner">
          <div style="flex:1;min-width:0;">
            <div class="nombre">${esc(a.nombre)}</div>
            ${fnacLabel ? `<div style="font-size:.75rem;color:#555;margin-top:2px;">🎂 ${fnacLabel}</div>` : ''}
          </div>
          <div class="card-actions">
            <button class="card-btn pagar ${pagado ? 'done' : ''}"
              data-action="pagar" data-id="${a.id}" data-nombre="${esc(a.nombre)}">
              ${pagado ? 'Pagado' : 'Pago'}
            </button>
            <button class="card-btn plan ${planEnviada ? 'done' : ''}"
              data-action="plan" data-id="${a.id}" data-nombre="${esc(a.nombre)}">
              ${planEnviada ? 'Plan ✔' : 'Planificación'}
            </button>
            <button class="card-btn eliminar" style="color:#60a5fa;"
              data-action="perfil" data-id="${a.id}">
              Info
            </button>
            <button class="card-btn eliminar"
              data-action="eliminar" data-id="${a.id}" data-nombre="${esc(a.nombre)}">
              Eliminar
            </button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ─── RENDER RESUMEN ──────────────────────────────────────────────────────────
function renderResumen() {
  // Actualizar header con nombre y colores del grupo
  const elHeader = document.getElementById('header-grupo-nombre');
  if (elHeader) elHeader.innerHTML = renderNombreGrupo(_config);

  const precio = _config.precio || 0;
  const mes    = getMesActual();
  const data   = _alumnos;

  const total        = data.length;
  const pagaron      = data.filter(a => a.ultimoMesPagado === mes).length;
  const deben        = total - pagaron;
  const planEnviadas = data.filter(a => (a.ultimoPlanMes || null) === mes).length;
  const planPend     = total - planEnviadas;
  const esperado     = total * precio;
  const ingresado    = pagaron * precio;
  const pctPlan      = total ? Math.round((planEnviadas / total) * 100) : 0;
  const pctPago      = total ? Math.round((pagaron / total) * 100) : 0;
  const $fmt = n => precio > 0 ? '$' + n.toLocaleString('es-AR') : '—';

  // Donut pagos (verde)
  const r = 36, cx = 44, cy = 44, stroke = 10;
  const circ = 2 * Math.PI * r;
  const dash = total > 0 ? (pagaron / total) * circ : 0;

  const donut = `
    <svg width="88" height="88" viewBox="0 0 88 88">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="#2a2a2a" stroke-width="${stroke}"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="#4ade80" stroke-width="${stroke}"
        stroke-dasharray="${dash} ${circ}"
        stroke-dashoffset="${circ / 4}"
        stroke-linecap="round"/>
    </svg>`;

  // Donut planificaciones (violeta)
  const dashPlan = total > 0 ? (planEnviadas / total) * circ : 0;
  const donutPlan = `
    <svg width="88" height="88" viewBox="0 0 88 88">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="#2a2a2a" stroke-width="${stroke}"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="#a78bfa" stroke-width="${stroke}"
        stroke-dasharray="${dashPlan} ${circ}"
        stroke-dashoffset="${circ / 4}"
        stroke-linecap="round"/>
    </svg>`;

  document.getElementById('resumen-content').innerHTML = `
  <div id="resumen-inner">

    <!-- LOGO -->
    <div class="rs-logo-row">
      <div class="rs-logo-name">${renderNombreGrupo(_config)}</div>
      <div class="rs-logo-sub">Resumen mensual</div>
    </div>

    <!-- PERÍODO -->
    <div class="rs-hero">
      <div>
        <div class="rs-periodo-label">Período actual</div>
        <div class="rs-periodo-mes">${formatMesLabel(mes)}</div>
      </div>
    </div>

    <!-- TOTAL ALUMNOS -->
    <div class="rs-hero">
      <div>
        <div class="rs-periodo-label">Total alumnos</div>
        <div class="rs-total-num">${total}</div>
      </div>
    </div>

    <!-- INGRESOS + DONUT en dos columnas -->
    <div class="rs-dos-col">

      <!-- COL IZQUIERDA: ingresos -->
      <div class="rs-col-izq">
        <div class="rs-ingresos">
          <div class="rs-ingreso-row principal">
            <div class="rs-ingreso-label">Ingreso actual</div>
            <div class="rs-ingreso-valor">${$fmt(ingresado)}</div>
          </div>
          <div class="rs-ingreso-row">
            <div class="rs-ingreso-label">Ingreso esperado</div>
            <div class="rs-ingreso-valor">${$fmt(esperado)}</div>
          </div>
        </div>
      </div>

      <!-- COL DERECHA: donut pagos -->
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
            ${donut}
            <div class="rs-donut-center">
              <span class="rs-donut-pct">${pctPago}%</span>
              <span class="rs-donut-sub">pagó</span>
            </div>
          </div>
        </div>
      </div>

    </div>

    <!-- PLANIFICACIONES -->
    <div class="rs-plan-wrap">
      <div class="rs-plan-header">
        <div class="rs-plan-titulo">Planificaciones</div>
      </div>
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
          ${donutPlan}
          <div class="rs-donut-center">
            <span class="rs-donut-pct" style="color:#c4b5fd;">${pctPlan}%</span>
            <span class="rs-donut-sub">enviado</span>
          </div>
        </div>
      </div>
    </div>

  </div>
  `;
}

function render() { renderAlumnos(); renderResumen(); }

// ─── MODALES ─────────────────────────────────────────────────────────────────
function abrirModal() {
  document.getElementById('input-nombre').value = '';
  document.getElementById('input-fnac').value   = '';
  document.getElementById('overlay').classList.add('open');
  setTimeout(() => document.getElementById('input-nombre').focus(), 120);
}
function cerrarModal() {
  document.getElementById('overlay').classList.remove('open');
}
async function confirmarAgregar() {
  const nombre  = document.getElementById('input-nombre').value.trim();
  const fechaNac = document.getElementById('input-fnac').value || null;
  if (!nombre) { document.getElementById('input-nombre').focus(); return; }
  await agregarAlumno(nombre, fechaNac);
  cerrarModal();
}

const capitalizar = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
let _perfilId = null;
function abrirPerfil(id) {
  const a = _alumnos.find(x => x.id === id);
  if (!a) return;
  _perfilId = id;
  document.getElementById('perfil-titulo').textContent  = a.nombre;
  document.getElementById('perfil-nombre').value        = a.nombre;
  document.getElementById('perfil-fnac').value          = a.fechaNacimiento || '';
  document.getElementById('perfil-overlay').classList.add('open');
}
function cerrarPerfil() {
  _perfilId = null;
  document.getElementById('perfil-overlay').classList.remove('open');
}
async function guardarPerfil() {
  if (_perfilId === null) return;
  const nombre = capitalizar(document.getElementById('perfil-nombre').value.trim());
  const fnac   = document.getElementById('perfil-fnac').value || null;
  if (!nombre) { document.getElementById('perfil-nombre').focus(); return; }
  await guardarAlumnos(_alumnos.map(a =>
    a.id === _perfilId ? { ...a, nombre, fechaNacimiento: fnac } : a
  ));
  cerrarPerfil();
}
let _pagoId = null;
function abrirConfirmPago(id, nombre) {
  _pagoId = id;
  document.getElementById('confirm-nombre').textContent = nombre;
  document.getElementById('confirm-overlay').classList.add('open');
}
function cerrarConfirmPago() {
  _pagoId = null;
  document.getElementById('confirm-overlay').classList.remove('open');
}
async function ejecutarPago() {
  if (_pagoId !== null) await pagarAlumno(_pagoId);
  cerrarConfirmPago();
}

// ─── CONFIRM PLAN ────────────────────────────────────────────────────────────
let _planId = null;
function abrirConfirmPlan(id, nombre) {
  _planId = id;
  document.getElementById('plan-nombre').textContent = nombre;
  document.getElementById('plan-overlay').classList.add('open');
}
function cerrarConfirmPlan() {
  _planId = null;
  document.getElementById('plan-overlay').classList.remove('open');
}
async function ejecutarPlan() {
  if (_planId !== null) await enviarPlan(_planId);
  cerrarConfirmPlan();
}

// ─── ELIMINAR ────────────────────────────────────────────────────────────────
async function pedirEliminar(id, nombre) {
  if (confirm(`¿Eliminar a ${nombre}?`)) await eliminarAlumno(id);
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
  const nombre = document.getElementById('config-nombre').value || 'Mi grupo';
  document.getElementById('config-split').max = nombre.length;
  const split  = parseInt(document.getElementById('config-split').value);
  document.getElementById('config-split-val').textContent = isNaN(split) ? 0 : split;
  const color1 = document.getElementById('config-color1').value;
  const color2 = document.getElementById('config-color2').value;
  const cfg    = {
    nombreGrupo: nombre,
    grupoSplit:  isNaN(split) ? null : split,
    grupoColor1: color1,
    grupoColor2: color2
  };
  document.getElementById('config-preview').innerHTML = renderNombreGrupo(cfg);
}

function abrirConfig() {
  document.getElementById('config-precio').value = _config.precio       || '';
  document.getElementById('config-nombre').value = _config.nombreGrupo  || '';
  const splitVal = _config.grupoSplit != null ? _config.grupoSplit : 0;
  const nombreActual = document.getElementById('config-nombre').value || _config.nombreGrupo || '';
  document.getElementById('config-split').max = nombreActual.length || 20;
  document.getElementById('config-split').value = splitVal;
  document.getElementById('config-split-val').textContent = splitVal;
  document.getElementById('config-color1').value = _config.grupoColor1  || '#60a5fa';
  document.getElementById('config-color2').value = _config.grupoColor2  || '#fb923c';
  actualizarPreview();
  document.getElementById('config-overlay').classList.add('open');
}

function cerrarConfig() {
  document.getElementById('config-overlay').classList.remove('open');
}

async function guardarConfigModal() {
  const precio      = Number(document.getElementById('config-precio').value) || 0;
  const nombreGrupo = document.getElementById('config-nombre').value.trim() || 'Mi grupo';
  const splitVal    = parseInt(document.getElementById('config-split').value);
  const grupoSplit  = isNaN(splitVal) ? null : splitVal;
  const grupoColor1 = document.getElementById('config-color1').value;
  const grupoColor2 = document.getElementById('config-color2').value;
  await guardarConfig({ precio, nombreGrupo, grupoSplit, grupoColor1, grupoColor2 });
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

  // Login
  const doLogin = async () => {
    const email = document.getElementById('login-email').value.trim();
    const pass  = document.getElementById('login-pass').value;
    document.getElementById('login-error').textContent = '';
    try {
      await signInWithEmailAndPassword(auth, email, pass);
    } catch(e) {
      document.getElementById('login-error').textContent = 'Email o contraseña incorrectos.';
    }
  };
  document.getElementById('login-btn')?.addEventListener('click', doLogin);
  document.getElementById('login-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });

  // App
  document.getElementById('btn-agregar')    ?.addEventListener('click', abrirModal);
  document.getElementById('btn-cancelar')   ?.addEventListener('click', cerrarModal);
  document.getElementById('btn-confirmar')  ?.addEventListener('click', confirmarAgregar);
  document.getElementById('btn-config')     ?.addEventListener('click', abrirConfig);
  document.getElementById('config-cancelar')?.addEventListener('click', cerrarConfig);
  document.getElementById('config-guardar') ?.addEventListener('click', guardarConfigModal);
  document.getElementById('config-nombre')  ?.addEventListener('input', actualizarPreview);
  document.getElementById('config-split')   ?.addEventListener('input', actualizarPreview);
  document.getElementById('config-color1')  ?.addEventListener('input', actualizarPreview);
  document.getElementById('config-color2')  ?.addEventListener('input', actualizarPreview);
  document.getElementById('btn-exportar')   ?.addEventListener('click', exportar);
  document.getElementById('btn-importar')   ?.addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile')     ?.addEventListener('change', importar);
  document.getElementById('btn-salir')      ?.addEventListener('click', () => signOut(auth));
  document.getElementById('tab-alumnos')    ?.addEventListener('click', () => cambiarTab('alumnos'));
  document.getElementById('tab-resumen')    ?.addEventListener('click', () => cambiarTab('resumen'));
  document.getElementById('perfil-cancelar')?.addEventListener('click', cerrarPerfil);
  document.getElementById('perfil-guardar') ?.addEventListener('click', guardarPerfil);
  document.getElementById('confirm-si-pago')?.addEventListener('click', ejecutarPago);
  document.getElementById('confirm-no-pago')?.addEventListener('click', cerrarConfirmPago);
  document.getElementById('confirm-si-plan')?.addEventListener('click', ejecutarPlan);
  document.getElementById('confirm-no-plan')?.addEventListener('click', cerrarConfirmPlan);
  document.getElementById('input-nombre')   ?.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmarAgregar();
  });
  document.getElementById('overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('overlay')) cerrarModal();
  });
  document.getElementById('buscar')?.addEventListener('input', renderAlumnos);

  // Delegación para cards dinámicas
  document.getElementById('lista')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id, nombre } = btn.dataset;
    const numId = Number(id);
    if (action === 'pagar'    && !btn.classList.contains('done')) abrirConfirmPago(numId, nombre);
    if (action === 'plan'     && !btn.classList.contains('done')) abrirConfirmPlan(numId, nombre);
    if (action === 'perfil')   abrirPerfil(numId);
    if (action === 'eliminar') pedirEliminar(numId, nombre);
  });
});

// ─── AUTH STATE ──────────────────────────────────────────────────────────────
let _unsubAlumnos = null;
let _unsubConfig  = null;

onAuthStateChanged(auth, user => {
  const loginScreen = document.getElementById('login-screen');
  const appScreen   = document.getElementById('app-screen');
  
  if (user) {
    // Autenticado: mostrar app, ocultar login
    loginScreen.style.display = 'none';
    appScreen.style.display   = 'block';

    // Referencias dinámicas según el usuario logueado
    REF_ALUMNOS = doc(db, 'usuarios', user.uid, 'datos', 'alumnos');
    REF_CONFIG  = doc(db, 'usuarios', user.uid, 'datos', 'config');
    const logoEl = document.getElementById('logo-imagen');
    if (logoEl) {
      logoEl.src = `logos/logo_${user.uid}.png`;
      logoEl.onerror = () => { logoEl.src = 'logos/logo_default.png'; };
    }

    // Iniciar escucha en tiempo real
    _unsubAlumnos = onSnapshot(REF_ALUMNOS, snap => {
      _alumnos = snap.exists() ? (snap.data().lista || []) : [];
      _listo   = true;
      render();
    });
    _unsubConfig = onSnapshot(REF_CONFIG, snap => {
      _config = snap.exists() ? snap.data() : { precio: 0 };
      renderResumen();
    });

  } else {
    // No autenticado: mostrar login, ocultar app
    loginScreen.style.display = 'flex';
    appScreen.style.display   = 'none';
    _listo = false;

    // Cancelar escuchas activas
    if (_unsubAlumnos) { _unsubAlumnos(); _unsubAlumnos = null; }
    if (_unsubConfig)  { _unsubConfig();  _unsubConfig  = null; }
  }
});
