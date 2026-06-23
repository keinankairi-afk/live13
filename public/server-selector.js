// LIVE13 Server Selector
(function(){
  var bar=document.getElementById('serverBar');
  if(!bar)return;
  fetch('/api/servers').then(function(r){return r.json()}).then(function(d){
    if(!d.matches||d.matches.length===0)return;
    var match=d.matches[0];
    bar.innerHTML='';
    match.servers.forEach(function(s,i){
      var chip=document.createElement('div');
      chip.className='server-chip'+(i===0?' active':'');
      chip.innerHTML='<span class="dot"></span>'+s.name;
      chip.setAttribute('data-url',s.url);
      chip.onclick=function(){
        document.querySelectorAll('.server-chip').forEach(function(c){c.classList.remove('active')});
        chip.classList.add('active');
        loadServer(s.url);
      };
      bar.appendChild(chip);
    });
    // Auto-load first server
    if(match.servers.length>0){
      loadServer(match.servers[0].url);
    }
  }).catch(function(e){console.log('Server list error:',e)});
  
  function loadServer(url){
    var wrap=document.getElementById('playerWrap');
    if(!wrap)return;
    // Remove old player (video or iframe)
    var oldPlayer=wrap.querySelector('#player');
    if(oldPlayer)oldPlayer.remove();
    // Create iframe
    var iframe=document.createElement('iframe');
    iframe.id='player';
    iframe.src=url;
    iframe.allow='autoplay;encrypted-media;picture-in-picture;allow-same-origin';
    iframe.allowFullscreen=true;
    iframe.style.cssText='width:100%;height:100%;border:none;position:absolute;inset:0;z-index:1;max-width:100%';
    wrap.appendChild(iframe);
    // Hide play button and error overlay
    var playBtn=document.getElementById('playBtn');
    var errEl=document.getElementById('err');
    if(playBtn)playBtn.style.display='none';
    if(errEl)errEl.style.display='none';
  }
})();
