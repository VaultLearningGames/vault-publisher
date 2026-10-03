// Analytics pages: refresh the realtime card every minute while the page is on screen (src/portal/analytics.ts).
(function () {
  var box = document.querySelector('[data-realtime]');
  if (!box || !window.fetch) return;
  var url = box.getAttribute('data-realtime');
  function refresh() {
    if (document.visibilityState === 'hidden') return;
    fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'vault-portal' } })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (h) { if (h !== null) box.innerHTML = h; })
      .catch(function () {});
  }
  setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(); });
})();
