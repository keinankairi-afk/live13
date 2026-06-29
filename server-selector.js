// LIVE13 Server Selector
// v4: One-tap-anywhere unlocks audio for the whole page.
// iOS Safari requires at least one user gesture per page load for cross-origin
// iframe audio. After first tap, ALL server switches play audio immediately —
// no per-switch overlay. Persists across reloads via sessionStorage.
(function(){
  var bar = document.getElementById('serverBar');
  if (!bar) return;

  var unlocked = false;
  var pendingLoad = null;  // {url, container} waiting for unlock

  function setUnlocked() {
    if (unlocked) return;
    unlocked = true;
    try { sessionStorage.setItem('live13-unlocked', '1'); } catch(e) {}
    var hint = document.getElementById('audioHint');
    if (hint) hint.remove();
    if (pendingLoad) {
      pendingLoad.container.appendChild(buildIframe(pendingLoad.url));
      pendingLoad = null;
    }
  }

  // Check if already unlocked this session
  try {
    if (sessionStorage.getItem('live13-unlocked') === '1') unlocked = true;
  } catch(e) {}

  // Listen for first tap anywhere on the page (not just overlay)
  ['click', 'touchstart', 'keydown'].forEach(function(ev){
    document.addEventListener(ev, setUnlocked, { once: true, passive: true, capture: true });
  });

  function buildIframe(url) {
    var iframe = document.createElement('iframe');
    iframe.id = 'player';
    iframe.src = url;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; allow-same-origin; clipboard-read; clipboard-write; accelerometer; gyroscope';
    iframe.allowFullscreen = true;
    iframe.style.cssText = 'width:100%;height:100%;border:none;position:absolute;inset:0;z-index:1;max-width:100%';
    return iframe;
  }

  function loadServer(url, hasGesture){
      var wrap=document.getElementById('playerWrap');
      if(!wrap)return;

      // Kill competing audio sources — iframe is now primary player.
      // 1) Stop HLS player (index.html) so it doesn't play alongside iframe.
      // 2) Pause bg-music so it doesn't layer on top of iframe audio.
      try {
        if (window.hlsInstance) { window.hlsInstance.destroy(); window.hlsInstance = null; }
      } catch(e) {}
      var oldVid = document.getElementById('player');
      if (oldVid && oldVid.tagName === 'VIDEO') {
        try { oldVid.pause(); oldVid.removeAttribute('src'); oldVid.load(); } catch(e) {}
        oldVid.remove();
      }
      try {
        if (window.bgMusic) {
          window.bgMusic.pause();
          window.bgMusic.volume = 0;
          window.__iframePlayerActive = true;
        }
      } catch(e) {}

      var old=wrap.querySelector('.server-player-container');
      if(old)old.remove();

    var container = document.createElement('div');
    container.className = 'server-player-container';
    container.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';

    if (unlocked || hasGesture) {
      // Already unlocked OR direct chip click → create iframe immediately
      container.appendChild(buildIframe(url));
    } else {
      // No gesture yet — stash URL, show subtle hint, wait for first tap anywhere
      pendingLoad = { url: url, container: container };
      var hint = document.createElement('div');
      hint.id = 'audioHint';
      hint.style.cssText = [
        'position:absolute', 'inset:0', 'z-index:10',
        'display:flex', 'align-items:center', 'justify-content:center',
        'color:rgba(255,255,255,0.9)', 'cursor:pointer',
        'font-family:Geist,system-ui,sans-serif',
        'font-size:14px', 'font-weight:500', 'letter-spacing:0.02em',
        'background:rgba(0,0,0,0.25)', 'backdrop-filter:blur(2px)',
        'user-select:none', 'transition:opacity 0.2s ease'
      ].join(';');
      hint.textContent = 'Tap untuk nyalain suara';
      container.appendChild(hint);
    }

    wrap.appendChild(container);
    var playBtn = document.getElementById('playBtn');
    var errEl = document.getElementById('err');
    if (playBtn) playBtn.style.display = 'none';
    if (errEl) errEl.style.display = 'none';
  }

  fetch('/api/servers').then(function(r){ return r.json(); }).then(function(d){
    if (!d.matches || d.matches.length === 0) return;
    var match = d.matches[0];
    bar.innerHTML = '';
    match.servers.forEach(function(s, i){
      var chip = document.createElement('div');
      chip.className = 'server-chip' + (i === 0 ? ' active' : '');
      chip.innerHTML = '<span class="dot"></span>' + s.name;
      chip.onclick = function(){
        document.querySelectorAll('.server-chip').forEach(function(c){ c.classList.remove('active'); });
        chip.classList.add('active');
        loadServer(s.url, true);  // chip click is a user gesture
      };
      bar.appendChild(chip);
    });
    if (match.servers.length > 0) {
      loadServer(match.servers[0].url, false);
    }
  }).catch(function(e){ console.log('Server list error:', e); });
})();