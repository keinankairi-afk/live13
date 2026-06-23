// LIVE13 Server Selector
(function(){
  var API='/api/servers';
  var bar=document.getElementById('serverBar');
  if(!bar)return;
  
  fetch(API).then(function(r){return r.json()}).then(function(d){
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
    
    // Auto-load first
    if(match.servers.length>0){
      loadServer(match.servers[0].url);
    }
  }).catch(function(e){console.log('Server error:',e)});
  
  function loadServer(url){
    var wrap=document.getElementById('playerWrap');
    if(!wrap)return;
    // Remove old player
    var old=wrap.querySelector('iframe,video');
    if(old)old.remove();
    // Create iframe
    var iframe=document.createElement('iframe');
    iframe.id='player';
    iframe.src=url;
    iframe.allow='autoplay;encrypted-media;picture-in-picture';
    iframe.allowFullscreen=true;
    iframe.style.cssText='width:100%;height:100%;border:none;position:absolute;inset:0';
    wrap.appendChild(iframe);
  }
})();
