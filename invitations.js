/* Flujo auxiliar de invitaciones para LTH IA Web.
   No guarda contrasenas ni PIN: solo conserva un token opaco de seguimiento. */
(() => {
  'use strict';

  const TRACK_KEY = 'lth_ia_web_invite_tracker_v1';
  const COMMON = new Set([
    'password123!', 'password1234!', 'qwerty123456!', 'admin123456!',
    'welcome12345!', 'contraseña123!', 'contrasena123!', 'lthia123456!'
  ]);

  function passwordError(password, email) {
    const value = String(password || '');
    const failures = [];
    if (value.length < 12) failures.push('12 caracteres');
    if (!/[a-z]/.test(value)) failures.push('una minúscula');
    if (!/[A-Z]/.test(value)) failures.push('una mayúscula');
    if (!/\d/.test(value)) failures.push('un número');
    if (!/[^A-Za-z0-9]/.test(value)) failures.push('un símbolo');
    const lower = value.toLowerCase();
    const emailName = String(email || '').split('@')[0].toLowerCase();
    if (emailName.length >= 4 && lower.includes(emailName)) failures.push('no contener tu correo');
    if (/(.)\1{3,}/.test(value) || /(?:123456|abcdef|qwerty|asdfgh)/i.test(value)) failures.push('no usar secuencias fáciles');
    if (COMMON.has(lower)) failures.push('no ser una contraseña común');
    return failures.length ? `La contraseña debe incluir ${failures.join(', ')}.` : '';
  }

  async function call(fnUrl, publishableKey, action, body, accessToken) {
    const headers = { apikey: publishableKey, 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    const res = await fetch(fnUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(Object.assign({ action }, body || {}))
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const error = new Error(data.error || 'No se pudo procesar la invitación.');
      error.status = data.status || res.status;
      throw error;
    }
    return data;
  }

  function saveTracker(invite, rawEmail) {
    if (!invite || !invite.requestToken) return;
    const value = { requestToken: invite.requestToken, email: String(rawEmail || '').trim().toLowerCase(), savedAt: Date.now() };
    try { localStorage.setItem(TRACK_KEY, JSON.stringify(value)); } catch (_) {}
  }

  function loadTracker() {
    try {
      const value = JSON.parse(localStorage.getItem(TRACK_KEY) || 'null');
      return value && value.requestToken ? value : null;
    } catch (_) { return null; }
  }

  function clearTracker() {
    try { localStorage.removeItem(TRACK_KEY); } catch (_) {}
  }

  function viewModel(invite) {
    const status = String(invite && invite.status || 'pending');
    const models = {
      pending: ['Solicitud pendiente', 'LTH Mady está en producción y los accesos nuevos se revisan manualmente. Si se aprueba, recibirás un PIN normalmente dentro de 24 horas.', '◌'],
      code_ready: ['Tu PIN está preparado', 'El administrador está preparando el envío manual. Esta pantalla cambiará cuando el correo haya sido enviado.', '◇'],
      code_sent: ['PIN enviado', 'Introduce el código de 6 dígitos enviado a tu correo. Caduca 24 horas después del envío.', '✉'],
      active: ['Cuenta verificada', 'Tu acceso fue aprobado. Inicia sesión nuevamente con tu contraseña.', '✓'],
      grandfathered: ['Cuenta autorizada', 'Esta cuenta conserva su acceso existente.', '✓'],
      rejected: ['Solicitud no aprobada', invite && invite.rejectionReason || 'Tu solicitud requiere revisión del administrador.', '×'],
      locked: ['Solicitud bloqueada', 'Se alcanzó el límite de intentos. El administrador debe reabrir la solicitud.', '!'],
      expired: ['PIN vencido', 'El PIN superó las 24 horas. Solicita al administrador que genere uno nuevo.', '⌛'],
      submitted: ['Solicitud recibida', 'Si el correo puede solicitar acceso, aparecerá en revisión. Si ya tienes cuenta, intenta iniciar sesión.', '◌']
    };
    const entry = models[status] || models.pending;
    return { status, title: entry[0], text: entry[1], icon: entry[2] };
  }

  async function renderTurnstile(containerId, siteKey) {
    if (!siteKey) throw new Error('Falta configurar TURNSTILE_SITE_KEY para activar nuevas solicitudes.');
    for (let i = 0; i < 40 && !(window.turnstile && window.turnstile.render); i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!(window.turnstile && window.turnstile.render)) throw new Error('No se pudo cargar la verificación anti-bot.');
    const container = document.getElementById(containerId);
    if (!container) throw new Error('No se encontró el contenedor de seguridad.');
    if (container.dataset.widgetId) return container.dataset.widgetId;
    const id = window.turnstile.render(container, { sitekey: siteKey, theme: document.body.classList.contains('light') ? 'light' : 'dark' });
    container.dataset.widgetId = String(id);
    return id;
  }

  function turnstileToken(containerId) {
    const container = document.getElementById(containerId);
    const id = container && container.dataset.widgetId;
    return id && window.turnstile ? String(window.turnstile.getResponse(id) || '') : '';
  }

  function resetTurnstile(containerId) {
    const container = document.getElementById(containerId);
    const id = container && container.dataset.widgetId;
    if (id && window.turnstile) window.turnstile.reset(id);
  }

  window.LTHInviteApi = {
    passwordError,
    call,
    saveTracker,
    loadTracker,
    clearTracker,
    viewModel,
    renderTurnstile,
    turnstileToken,
    resetTurnstile
  };
})();
