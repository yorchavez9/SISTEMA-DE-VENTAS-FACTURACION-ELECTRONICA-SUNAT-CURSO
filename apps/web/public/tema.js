// Aplica el tema antes de pintar para evitar el parpadeo. Va en un archivo aparte (no en línea)
// para que la Content-Security-Policy de producción (script-src 'self') lo permita.
try {
  var t = localStorage.getItem('sv_tema');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
} catch (e) {}
