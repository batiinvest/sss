(function () {
  if (window.location.protocol === 'capacitor:') return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (error) {
      console.warn('Service worker registration failed:', error);
    });
  });
})();
