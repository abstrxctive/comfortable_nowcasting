function GifReader(buf){
  var p=0;
  if(buf[p++]!==0x47||buf[p++]!==0x49||buf[p++]!==0x46) throw 'Not a GIF';
  p+=3;
  var width=buf[p]|(buf[p+1]<<8);p+=2;
  var height=buf[p]|(buf[p+1]<<8);p+=2;
  var pf0=buf[p++];
  var gctFlag=(pf0>>7)&1,gctSize=1<<((pf0&7)+1);
  p+=2;
  var gct=null;
  if(gctFlag){gct=buf.subarray(p,p+gctSize*3);p+=gctSize*3;}
  this.width=width;this.height=height;
  var frames=[],gce={};
  while(p<buf.length){
    var s=buf[p++];
    if(s===0x3B) break;
    if(s===0x21){
      var label=buf[p++];
      if(label===0xF9){
        p++;var pk=buf[p++];
        gce.disposal=(pk>>2)&7;gce.transparent=pk&1;
        gce.delay=buf[p]|(buf[p+1]<<8);p+=2;
        gce.transIndex=buf[p++];p++;
      } else {
        var bsz=buf[p++];p+=bsz;
        while((bsz=buf[p++])!==0) p+=bsz;
      }
    } else if(s===0x2C){
      var ix=buf[p]|(buf[p+1]<<8);p+=2;
      var iy=buf[p]|(buf[p+1]<<8);p+=2;
      var iw=buf[p]|(buf[p+1]<<8);p+=2;
      var ih=buf[p]|(buf[p+1]<<8);p+=2;
      var pf1=buf[p++];
      var lctF=(pf1>>7)&1;
      var lctSz=1<<((pf1&7)+1);
      var ct=lctF?buf.subarray(p,p+lctSz*3):gct;
      if(lctF) p+=lctSz*3;
      var minCode=buf[p++],lzwArr=[],bsz2;
      while((bsz2=buf[p++])!==0){for(var i=0;i<bsz2;i++) lzwArr.push(buf[p++]);}
      frames.push({x:ix,y:iy,width:iw,height:ih,
        disposal:gce.disposal||0,delay:gce.delay||10,
        transIndex:gce.transparent?gce.transIndex:-1,
        ct:ct,lzwMinCode:minCode,lzwData:new Uint8Array(lzwArr)});
      gce={};
    }
  }
  this._frames=frames;
  this.numFrames=function(){return frames.length;};
  this.frameInfo=function(i){return frames[i];};
  this.decodeAndBlitFrameRGBA=function(fi,pixels){
    var f=frames[fi],ct=f.ct,W=this.width;
    var lzw=lzwDecode(f.lzwMinCode,f.lzwData);
    var iw=f.width,ih=f.height,ix=f.x,iy=f.y,ti=f.transIndex;
    var si=0;
    for(var row=0;row<ih;row++){
      var dstRow=iy+row;
      for(var col=0;col<iw;col++){
        var ci=lzw[si++];if(ci===ti) continue;
        var base=(dstRow*W+ix+col)*4,ct3=ci*3;
        pixels[base]=ct[ct3];pixels[base+1]=ct[ct3+1];pixels[base+2]=ct[ct3+2];pixels[base+3]=255;
      }
    }
  };
}
function lzwDecode(minCode,data){
  var cc=1<<minCode,eof=cc+1,cs=minCode+1,nc=eof+1;
  var dict=[];
  function init(){dict=[];for(var i=0;i<cc;i++)dict[i]=[i];dict[cc]=[];dict[eof]=[];cs=minCode+1;nc=eof+1;}
  init();
  var out=[],bits=0,bb=0,pos=0,prev=null;
  while(pos<data.length||bits>=cs){
    while(bits<cs&&pos<data.length){bb|=data[pos++]<<bits;bits+=8;}
    var code=bb&((1<<cs)-1);bb>>>=cs;bits-=cs;
    if(code===eof) break;
    if(code===cc){init();prev=null;continue;}
    var entry;
    if(code<nc) entry=dict[code];
    else if(code===nc) entry=prev.concat([prev[0]]);
    else break;
    for(var i=0;i<entry.length;i++) out.push(entry[i]);
    if(prev!==null&&nc<4096){dict[nc++]=prev.concat([entry[0]]);if(nc===(1<<cs)&&cs<12)cs++;}
    prev=entry;
  }
  return out;
}

// ═══════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════
var canvas=document.getElementById('radarCanvas');
var ctx=canvas.getContext('2d');
var frames=[],frameIndex=0,playing=false,rafId=null,lastTime=null,elapsed=0,speedMul=1;

// ── File handling ───────────────────────────────
document.getElementById('pickBtn').onclick=function(){document.getElementById('fileInput').click();};
document.getElementById('fileInput').onchange=function(e){if(e.target.files[0]) processFile(e.target.files[0]);};
var dz=document.getElementById('dropZone');
dz.addEventListener('dragover',function(e){e.preventDefault();dz.classList.add('drag-over');});
dz.addEventListener('dragleave',function(){dz.classList.remove('drag-over');});
dz.addEventListener('drop',function(e){e.preventDefault();dz.classList.remove('drag-over');var f=e.dataTransfer.files[0];if(f) processFile(f);});

document.getElementById('reloadBtn').onclick=function(){
  stopPlay();frames=[];
  dz.style.display='flex';
  document.getElementById('reloadBtn').style.display='none';
  ['btnFirst','btnPrev','btnPlay','btnNext','btnLast'].forEach(function(id){document.getElementById(id).disabled=true;});
  document.getElementById('timeline').disabled=true;
  document.getElementById('frameInfo').textContent='—/—';
  document.getElementById('totalFrames').textContent='—';
  document.getElementById('fpsLabel').textContent='—';
  document.getElementById('dimLabel').textContent='—';
  document.getElementById('srcLabel').textContent='—';
  document.getElementById('fileInput').value='';
};

async function processFile(file){
  if(!file.name.toLowerCase().endsWith('.gif')&&file.type!=='image/gif'){alert('Выберите GIF-файл.');return;}
  dz.style.display='none';
  var ov=document.getElementById('loadingOverlay');
  ov.style.display='flex';
  document.getElementById('loadingText').textContent='ЧТЕНИЕ ДАННЫХ…';
  document.getElementById('srcLabel').textContent=file.name.toUpperCase();
  var buf=await new Promise(function(res,rej){var r=new FileReader();r.onload=function(e){res(new Uint8Array(e.target.result));};r.onerror=rej;r.readAsArrayBuffer(file);});
  await parseGif(buf);
}

async function parseGif(buf){
  document.getElementById('loadingText').textContent='ДЕКОДИРОВАНИЕ КАДРОВ…';
  try{
    var reader=new GifReader(buf);
    var total=reader.numFrames(),W=reader.width,H=reader.height;
    canvas.width=W;canvas.height=H;
    document.getElementById('dimLabel').textContent=W+'×'+H;
    document.getElementById('totalFrames').textContent=total;

    var avgDelay=0;
    var off=document.createElement('canvas');off.width=W;off.height=H;
    var octx=off.getContext('2d');
    var saved=null;frames=[];

    for(var i=0;i<total;i++){
      var info=reader.frameInfo(i);
      if(i>0){
        var prev=reader.frameInfo(i-1);
        if(prev.disposal===2) octx.clearRect(prev.x,prev.y,prev.width,prev.height);
        else if(prev.disposal===3&&saved) octx.putImageData(saved,0,0);
      }
      if(info.disposal===3) saved=octx.getImageData(0,0,W,H);
      var pixels=new Uint8ClampedArray(W*H*4);
      reader.decodeAndBlitFrameRGBA(i,pixels);
      var tmp=document.createElement('canvas');tmp.width=W;tmp.height=H;
      tmp.getContext('2d').putImageData(new ImageData(pixels,W,H),0,0);
      octx.drawImage(tmp,0,0);
      var delay=Math.max(info.delay,2)*10;
      avgDelay+=delay;
      frames.push({imageData:octx.getImageData(0,0,W,H),delay:delay});
      if(i%5===0){document.getElementById('loadingText').textContent='ДЕКОДИРОВАНИЕ… '+(i+1)+'/'+total;await new Promise(function(r){setTimeout(r,0);});}
    }

    avgDelay/=total;
    document.getElementById('fpsLabel').textContent=(1000/avgDelay).toFixed(1)+' FPS';

    document.getElementById('loadingOverlay').style.display='none';
    document.getElementById('reloadBtn').style.display='inline-block';
    setupControls();showFrame(0);startPlay();
  }catch(e){document.getElementById('loadingText').textContent='ОШИБКА: '+e.message;console.error(e);}
}

// ── Playback ─────────────────────────────────────
function showFrame(i){
  frameIndex=((i%frames.length)+frames.length)%frames.length;
  ctx.putImageData(frames[frameIndex].imageData,0,0);
  document.getElementById('timeline').value=frameIndex;
  document.getElementById('frameInfo').textContent=(frameIndex+1)+'/'+frames.length;
  document.getElementById('frameTimestamp').textContent='КДР '+(frameIndex+1);
  document.getElementById('scaleLabel').textContent=Math.round(scale*100)+'%';
}
function startPlay(){playing=true;document.getElementById('btnPlay').textContent='⏸';elapsed=0;lastTime=null;rafId=requestAnimationFrame(tick);}
function stopPlay(){playing=false;document.getElementById('btnPlay').textContent='▶';if(rafId){cancelAnimationFrame(rafId);rafId=null;}}
function tick(ts){
  if(!lastTime) lastTime=ts;
  elapsed+=(ts-lastTime)*speedMul;lastTime=ts;
  if(frames.length&&elapsed>=frames[frameIndex].delay){elapsed-=frames[frameIndex].delay;showFrame(frameIndex+1);}
  if(playing) rafId=requestAnimationFrame(tick);
}
var controlsSetup=false;
function setupControls(){
  var sl=document.getElementById('timeline');
  sl.max=frames.length-1;sl.disabled=false;
  ['btnFirst','btnPrev','btnPlay','btnNext','btnLast'].forEach(function(id){document.getElementById(id).disabled=false;});
  if(controlsSetup) return;controlsSetup=true;
  sl.addEventListener('input',function(){stopPlay();showFrame(+sl.value);});
  document.getElementById('btnPlay').onclick=function(){if(playing)stopPlay();else{elapsed=0;startPlay();}};
  document.getElementById('btnPrev').onclick=function(){stopPlay();showFrame(frameIndex-1);};
  document.getElementById('btnNext').onclick=function(){stopPlay();showFrame(frameIndex+1);};
  document.getElementById('btnFirst').onclick=function(){stopPlay();showFrame(0);};
  document.getElementById('btnLast').onclick=function(){stopPlay();showFrame(frames.length-1);};
  document.getElementById('speedSelect').onchange=function(e){speedMul=parseFloat(e.target.value);};
}

// ── Zoom & Pan ────────────────────────────────────
var wrapper=document.getElementById('zoomWrapper');
var scale=1,originX=0,originY=0;
var MIN_SCALE=1,MAX_SCALE=6,STEP=0.25;
function clamp(x,y,s){var wW=wrapper.clientWidth,wH=wrapper.clientHeight,sW=canvas.width*s,sH=canvas.height*s;return{x:Math.max(Math.min(wW-sW,0),Math.min(0,x)),y:Math.max(Math.min(wH-sH,0),Math.min(0,y))};}
function applyT(){canvas.style.transform='translate('+originX+'px,'+originY+'px) scale('+scale+')';document.getElementById('zoomLabel').textContent=Math.round(scale*100)+'%';document.getElementById('scaleLabel').textContent=Math.round(scale*100)+'%';}
function zoomAt(cx,cy,ns){var r=wrapper.getBoundingClientRect(),mx=cx-r.left,my=cy-r.top,ix=(mx-originX)/scale,iy=(my-originY)/scale;scale=Math.max(MIN_SCALE,Math.min(MAX_SCALE,ns));var c=clamp(mx-ix*scale,my-iy*scale,scale);originX=c.x;originY=c.y;applyT();}
wrapper.addEventListener('wheel',function(e){e.preventDefault();zoomAt(e.clientX,e.clientY,scale+(e.deltaY<0?STEP:-STEP));},{passive:false});
var drag=false,dSX,dSY,dOX,dOY;
wrapper.addEventListener('mousedown',function(e){if(scale<=1)return;drag=true;dSX=e.clientX;dSY=e.clientY;dOX=originX;dOY=originY;e.preventDefault();});
window.addEventListener('mousemove',function(e){if(!drag)return;var c=clamp(dOX+e.clientX-dSX,dOY+e.clientY-dSY,scale);originX=c.x;originY=c.y;applyT();});
window.addEventListener('mouseup',function(){drag=false;});
var ltD=null;
wrapper.addEventListener('touchstart',function(e){if(e.touches.length===2){ltD=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);}else if(e.touches.length===1&&scale>1){drag=true;dSX=e.touches[0].clientX;dSY=e.touches[0].clientY;dOX=originX;dOY=originY;}},{passive:true});
wrapper.addEventListener('touchmove',function(e){if(e.touches.length===2&&ltD){var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);zoomAt((e.touches[0].clientX+e.touches[1].clientX)/2,(e.touches[0].clientY+e.touches[1].clientY)/2,scale*(d/ltD));ltD=d;e.preventDefault();}else if(e.touches.length===1&&drag){var c=clamp(dOX+e.touches[0].clientX-dSX,dOY+e.touches[0].clientY-dSY,scale);originX=c.x;originY=c.y;applyT();e.preventDefault();}},{passive:false});
wrapper.addEventListener('touchend',function(){drag=false;ltD=null;});
document.getElementById('zoomIn').onclick=function(){zoomAt(wrapper.clientWidth/2,wrapper.clientHeight/2,scale+STEP);};
document.getElementById('zoomOut').onclick=function(){zoomAt(wrapper.clientWidth/2,wrapper.clientHeight/2,scale-STEP);};
document.getElementById('zoomReset').onclick=function(){scale=1;originX=0;originY=0;applyT();};
applyT();

// ═══════════════════════════════════════════════
//  Декоративный мини-радар
// ═══════════════════════════════════════════════
var miniCtx=document.getElementById('miniRadar').getContext('2d');
var miniAngle=0;
function drawMiniRadar(){
  var c=miniCtx,W=130,H=130,cx=65,cy=65,R=58;
  c.clearRect(0,0,W,H);
  // Фон
  c.fillStyle='#050d08';c.beginPath();c.arc(cx,cy,R,0,Math.PI*2);c.fill();
  // Сетка
  c.strokeStyle='#0d2e16';c.lineWidth=1;
  [R*.33,R*.66,R].forEach(function(r){c.beginPath();c.arc(cx,cy,r,0,Math.PI*2);c.stroke();});
  [0,Math.PI/4,Math.PI/2,Math.PI*3/4].forEach(function(a){
    c.beginPath();c.moveTo(cx,cy);
    c.lineTo(cx+Math.cos(a)*R,cy+Math.sin(a)*R);
    c.lineTo(cx+Math.cos(a+Math.PI)*R,cy+Math.sin(a+Math.PI)*R);
    c.stroke();
  });
  // Sweep gradient
  var grad=c.createConicalGradient?null:null;
  // Ручной sweep
  for(var i=0;i<40;i++){
    var a=miniAngle-i*0.06;
    var alpha=Math.max(0,(40-i)/40*0.35);
    c.beginPath();
    c.moveTo(cx,cy);
    c.arc(cx,cy,R,a,a+0.06);
    c.closePath();
    c.fillStyle='rgba(0,255,136,'+alpha+')';
    c.fill();
  }
  // Линия развёртки
  c.beginPath();c.moveTo(cx,cy);
  c.lineTo(cx+Math.cos(miniAngle)*R,cy+Math.sin(miniAngle)*R);
  c.strokeStyle='rgba(0,255,136,.9)';c.lineWidth=1.5;c.stroke();
  // Случайные «отметки»
  if(frames.length&&frameIndex%3===0){
    c.fillStyle='rgba(0,255,136,.6)';
    [[cx-18,cy-22,3],[cx+25,cy+10,2],[cx-30,cy+15,2.5],[cx+10,cy-30,2]].forEach(function(p){
      c.beginPath();c.arc(p[0],p[1],p[2],0,Math.PI*2);c.fill();
    });
  }
  // Центр
  c.beginPath();c.arc(cx,cy,3,0,Math.PI*2);c.fillStyle='#00ff88';c.fill();
  // Маска-круг
  c.save();c.globalCompositeOperation='destination-in';
  c.beginPath();c.arc(cx,cy,R,0,Math.PI*2);c.fill();c.restore();
  miniAngle+=0.03;
  requestAnimationFrame(drawMiniRadar);
}
drawMiniRadar();

// ═══════════════════════════════════════════════
//  Декоративный осциллограф
// ═══════════════════════════════════════════════
var oscCtx=document.getElementById('oscCanvas').getContext('2d');
var oscPhase=0,oscData=new Array(172).fill(24);
function drawOsc(){
  var c=oscCtx,W=172,H=48;
  c.fillStyle='rgba(5,13,8,.4)';c.fillRect(0,0,W,H);
  oscData.shift();
  var v=frames.length
    ? 24+Math.sin(oscPhase)*10+Math.sin(oscPhase*2.3)*5+Math.random()*4
    : 24+Math.sin(oscPhase)*3+Math.random()*2;
  oscData.push(v);
  c.beginPath();c.moveTo(0,oscData[0]);
  for(var i=1;i<oscData.length;i++) c.lineTo(i,oscData[i]);
  c.strokeStyle='rgba(0,255,136,.7)';c.lineWidth=1.2;c.stroke();
  c.strokeStyle='rgba(0,255,136,.15)';c.lineWidth=1;
  c.beginPath();c.moveTo(0,H/2);c.lineTo(W,H/2);c.stroke();
  oscPhase+=0.12;
  requestAnimationFrame(drawOsc);
}
drawOsc();

// ═══════════════════════════════════════════════
//  Часы и CPS
// ═══════════════════════════════════════════════
var frameCount=0,lastFpsTime=Date.now();
setInterval(function(){
  var now=new Date();
  var pad=function(n){return n<10?'0'+n:n;};
  document.getElementById('clockEl').textContent=
    pad(now.getUTCHours())+':'+pad(now.getUTCMinutes())+':'+pad(now.getUTCSeconds())+' UTC';
  var dt=(Date.now()-lastFpsTime)/1000;
  document.getElementById('cpsLabel').textContent=(frameCount/dt).toFixed(1)+' КДР/С';
  frameCount=0;lastFpsTime=Date.now();
},1000);
// Подсчёт реальных смен кадров
var _origShowFrame=showFrame;
showFrame=function(i){_origShowFrame(i);frameCount++;};
