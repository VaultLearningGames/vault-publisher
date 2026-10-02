// The essentials of the site's in-page player (site/themes/vault-squarespace/layouts/partials/vault-player.html):
// same class names and wiring, so the engine meets what it meets on the real site.
(function () {
  var LABEL = /^\s*(play( game| now)?|launch game)\s*$/i;
  var games = [], player, stage, frame;
  function open(i) {
    if (!player) {
      player = document.createElement('div');
      player.className = 'vault-player';
      player.style.cssText = 'position:fixed;inset:0;display:none;background:#000;z-index:99999';
      player.innerHTML = '<div class="vault-player__stage" style="position:absolute;inset:0"></div>';
      document.body.appendChild(player);
      stage = player.querySelector('.vault-player__stage');
    }
    frame = document.createElement('iframe');
    frame.className = 'vault-player__frame';
    frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0';
    frame.src = games[i];
    stage.appendChild(frame);
    player.classList.add('is-open');
    player.style.display = 'flex';
  }
  function wire() {
    var links = document.querySelectorAll('a[href]');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      if (a.hasAttribute('data-vault-play') || !LABEL.test(a.textContent)) continue;
      var url = new URL(a.getAttribute('href'), location.href);
      if (url.hash === '#noembed' || url.host === location.host || !/^https?:$/.test(url.protocol)) continue;
      a.setAttribute('data-vault-play', games.push(url.href) - 1);
      a.setAttribute('href', '#play');
    }
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-vault-play]');
    if (!a) return;
    e.preventDefault();
    open(+a.getAttribute('data-vault-play'));
  }, true);
  document.addEventListener('DOMContentLoaded', wire);
})();
