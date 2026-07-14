/* =====================================================================
   ClearSky-OMEGA · VDC Exchange
   Single-file ES5 app logic. Firebase compat v8.
   Namespace: vdc_*  (shared clearsky-portal project)
   Roles: buyer | operator (org: clearsky | molecule | lightsmith)
   Sellers = buyers who list assets (they own vdc_assets docs).
   Products: on-demand | reserved | forward
   ===================================================================== */
(function () {
  'use strict';

  /* ---------- operator org resolution by email domain ---------- */
  var OPERATOR_ORGS = {
    'clearsky-usa.com':    { org: 'clearsky',   label: 'ClearSky Energy' },
    'csebuilders.com':     { org: 'clearsky',   label: 'ClearSky Energy' },
    'moleculesystems.com': { org: 'molecule',   label: 'Molecule Systems' },
    'molecule.io':         { org: 'molecule',   label: 'Molecule Systems' },
    'lightsmithenergy.com':{ org: 'lightsmith', label: 'Lightsmith Energy' },
    'lightsmith.energy':   { org: 'lightsmith', label: 'Lightsmith Energy' }
  };
  function domainOf(email){ return (email||'').split('@')[1] ? email.split('@')[1].toLowerCase() : ''; }
  function operatorForEmail(email){ return OPERATOR_ORGS[domainOf(email)] || null; }

  /* ---------- firebase ---------- */
  var auth = firebase.auth();
  var db   = firebase.firestore();
  var COL = {
    profiles:  'vdc_profiles',
    assets:    'vdc_assets',      // powered data assets + compute[] SKUs
    rfqs:      'vdc_rfqs',        // buyer quote requests
    quotes:    'vdc_quotes',      // responses to an RFQ
    connectors:'vdc_connectors',
    events:    'vdc_events'
  };

  /* ---------- reference data ---------- */
  var GPU_CLASSES = ['H200','H100','B200','A100','L40S','RTX 5090','MI300X','Other'];
  var REGIONS = ['US-Central','US-East','US-West','US-Mountain','Canada','EU','Other'];
  var PRODUCTS = {
    ondemand: { name:'On-Demand', num:'01', desc:'Spot colocation capacity, hourly. Deploy now, no term.', eq:'≈ spot energy', unit:'/GPU-hr' },
    reserved: { name:'Reserved',  num:'02', desc:'Term-locked capacity, 1–36 months at guaranteed rate.', eq:'≈ PPA / offtake', unit:'/kW-mo' },
    forward:  { name:'Forward',   num:'03', desc:'Lock delivery + price for future capacity, hedged to the energy curve.', eq:'≈ futures', unit:'/GPU-hr fwd' }
  };
  var TERMS = [1,3,6,12,24,36];

  /* ---------- state ---------- */
  var S = {
    user:null, profile:null, role:null, org:null,
    regRole:'buyer', nav:'floor', product:'reserved',
    assets:[], myRfqs:[], allRfqs:[], quotes:[], connectors:[],
    selectedAsset:null, selectedRfq:null,
    filter:{ gpu:'', region:'', q:'' }
  };

  /* ---------- dom helpers ---------- */
  function $(id){ return document.getElementById(id); }
  function el(tag,cls,html){ var e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function toast(msg,isErr){ var t=$('toast'); t.textContent=msg; t.className=isErr?'err show':'show'; setTimeout(function(){t.className=isErr?'err':'';},2600); }
  function money(n,dp){ if(n==null||n===''||isNaN(n))return '—'; return '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:dp||0,maximumFractionDigits:dp==null?0:dp}); }
  function ts(){ return firebase.firestore.FieldValue.serverTimestamp(); }
  function nowMs(){ return Date.now(); }
  function numOrNull(v){ if(v===''||v==null)return null; var n=Number(v); return isNaN(n)?null:n; }

  /* ---------- status meta ---------- */
  var STATUS = {
    draft:{label:'Draft',cls:'st-draft'}, submitted:{label:'Submitted',cls:'st-submitted'},
    review:{label:'In Review',cls:'st-review'}, connecting:{label:'Connecting',cls:'st-connecting'},
    live:{label:'Live on Exchange',cls:'st-live'}, matched:{label:'Matched',cls:'st-matched'},
    suspended:{label:'Suspended',cls:'st-suspended'}
  };
  function statusPill(st){ var m=STATUS[st]||STATUS.draft; return '<span class="status-pill '+m.cls+'">'+m.label+'</span>'; }
  var RFQ_STATUS = {
    open:{label:'Open',cls:'st-submitted'}, quoted:{label:'Quoted',cls:'st-connecting'},
    locked:{label:'Locked',cls:'st-live'}, expired:{label:'Expired',cls:'st-draft'}, cancelled:{label:'Cancelled',cls:'st-suspended'}
  };
  function rfqPill(st){ var m=RFQ_STATUS[st]||RFQ_STATUS.open; return '<span class="status-pill '+m.cls+'">'+m.label+'</span>'; }

  /* ---------- trust badges ---------- */
  function trustRow(a){
    var h='<div class="trust-row">';
    h+= a.meteringConnected
      ? '<span class="trust metered"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>Molecule-metered</span>'
      : '<span class="trust"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>Metering pending</span>';
    h+='<span class="trust backed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5z"/></svg>Operator-backed</span>';
    if(a.status==='matched') h+='<span class="trust verified"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>Verified match</span>';
    return h+'</div>';
  }

  /* =====================================================================
     AUTH
     ===================================================================== */
  function showAuthErr(m){ var e=$('authErr'); e.textContent=m; e.className='auth-err show'; }
  function clearAuthErr(){ $('authErr').className='auth-err'; }
  function setRegRole(r){ S.regRole=r; $('roleBuyer').className='role-opt'+(r==='buyer'?' sel':''); $('roleOperator').className='role-opt'+(r==='operator'?' sel':''); }

  function wireAuth(){
    $('toRegister').onclick=function(){ $('loginForm').style.display='none'; $('registerForm').style.display='block'; clearAuthErr(); };
    $('toLogin').onclick=function(){ $('registerForm').style.display='none'; $('loginForm').style.display='block'; clearAuthErr(); };
    $('roleBuyer').onclick=function(){ setRegRole('buyer'); };
    $('roleOperator').onclick=function(){ setRegRole('operator'); };

    $('loginBtn').onclick=function(){
      clearAuthErr();
      var email=$('loginEmail').value.trim(), pass=$('loginPass').value;
      if(!email||!pass){ showAuthErr('Enter email and password.'); return; }
      $('loginBtn').disabled=true;
      auth.signInWithEmailAndPassword(email,pass)
        .catch(function(e){ showAuthErr(friendlyAuthErr(e)); })
        .then(function(){ $('loginBtn').disabled=false; });
    };
    $('googleLoginBtn').onclick=function(){
      clearAuthErr();
      auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(function(e){ showAuthErr(friendlyAuthErr(e)); });
    };
    $('registerBtn').onclick=function(){
      clearAuthErr();
      var name=$('regName').value.trim(), org=$('regOrg').value.trim(), email=$('regEmail').value.trim(), pass=$('regPass').value;
      if(!name||!org||!email||!pass){ showAuthErr('All fields are required.'); return; }
      if(pass.length<6){ showAuthErr('Password must be at least 6 characters.'); return; }
      var opMeta=operatorForEmail(email);
      if(S.regRole==='operator' && !opMeta){ showAuthErr('Operator access is limited to ClearSky, Molecule Systems, and Lightsmith Energy domains.'); return; }
      $('registerBtn').disabled=true;
      auth.createUserWithEmailAndPassword(email,pass).then(function(cred){
        var doc={ uid:cred.user.uid, name:name, org:org, email:email,
          role: opMeta?'operator':'buyer', operatorOrg: opMeta?opMeta.org:null, isSeller:false, createdAt:ts() };
        return db.collection(COL.profiles).doc(cred.user.uid).set(doc);
      }).catch(function(e){ showAuthErr(friendlyAuthErr(e)); }).then(function(){ $('registerBtn').disabled=false; });
    };
    $('signOutBtn').onclick=function(){ auth.signOut(); };
  }
  function friendlyAuthErr(e){
    var m=(e&&e.code)||'';
    if(m.indexOf('wrong-password')>=0||m.indexOf('user-not-found')>=0||m.indexOf('invalid-credential')>=0) return 'Incorrect email or password.';
    if(m.indexOf('email-already-in-use')>=0) return 'That email is already registered. Try logging in.';
    if(m.indexOf('invalid-email')>=0) return 'That email address looks invalid.';
    if(m.indexOf('popup-closed')>=0) return 'Google sign-in was cancelled.';
    return (e&&e.message)||'Something went wrong. Try again.';
  }

  auth.onAuthStateChanged(function(user){
    if(!user){ S.user=null; S.profile=null; $('authView').style.display='flex'; $('appView').style.display='none'; return; }
    S.user=user;
    db.collection(COL.profiles).doc(user.uid).get().then(function(snap){
      if(!snap.exists){
        var opMeta=operatorForEmail(user.email);
        var doc={ uid:user.uid, name:user.displayName||user.email.split('@')[0], org:(user.email.split('@')[1]||''), email:user.email,
          role: opMeta?'operator':'buyer', operatorOrg: opMeta?opMeta.org:null, isSeller:false, createdAt:ts() };
        return db.collection(COL.profiles).doc(user.uid).set(doc).then(function(){ return doc; });
      }
      return snap.data();
    }).then(function(p){ S.profile=p; S.role=p.role; S.org=p.operatorOrg||null; enterApp(); })
      .catch(function(e){ console.error(e); toast('Failed to load profile.',true); });
  });

  function enterApp(){
    $('authView').style.display='none'; $('appView').style.display='block';
    $('userName').textContent=S.profile.name||'';
    $('userAvatar').textContent=(S.profile.name||'?').charAt(0).toUpperCase();
    var chip=$('roleChip');
    if(S.role==='operator'){ chip.className='role-chip admin'; chip.textContent=orgLabel(S.org); }
    else { chip.className='role-chip buyer'; chip.textContent= S.profile.isSeller?'Buyer · Seller':'Buyer'; }
    S.nav = (S.role==='operator') ? 'console' : 'floor';
    buildNav(); subscribeData(); render();
  }
  function orgLabel(org){ return org==='clearsky'?'ClearSky':org==='molecule'?'Molecule':org==='lightsmith'?'Lightsmith':'Operator'; }

  function buildNav(){
    var nav=$('mainNav'); nav.innerHTML='';
    var items = S.role==='operator'
      ? [['console','Exchange Console'],['floor','Market Floor'],['rfqs','RFQ Inbox'],['assets','Assets'],['connectors','API Connectors']]
      : [['floor','Market Floor'],['myrfqs','My Requests'],['myassets','My Assets']];
    items.forEach(function(it){
      var b=el('button','nav-item'+(S.nav===it[0]?' active':''),it[1]);
      b.onclick=function(){ S.nav=it[0]; S.selectedAsset=null; S.selectedRfq=null; buildNav(); render(); };
      nav.appendChild(b);
    });
  }

  /* =====================================================================
     DATA SUBSCRIPTIONS
     ===================================================================== */
  function subscribeData(){
    // assets: sellers see own; operators + buyers-shopping see live ones. We subscribe broadly and filter in views.
    var aq = db.collection(COL.assets);
    aq.onSnapshot(function(qs){
      S.assets=[]; qs.forEach(function(d){ var o=d.data(); o.id=d.id; S.assets.push(o); });
      S.assets.sort(function(a,b){ return (b.updatedMs||0)-(a.updatedMs||0); });
      if(S.selectedAsset){ var f=byId(S.assets,S.selectedAsset.id); if(f)S.selectedAsset=f; }
      render();
    }, function(e){ console.error('assets',e); });

    // my RFQs (buyer)
    if(S.role==='buyer'){
      db.collection(COL.rfqs).where('buyerUid','==',S.user.uid).onSnapshot(function(qs){
        S.myRfqs=[]; qs.forEach(function(d){ var o=d.data(); o.id=d.id; S.myRfqs.push(o); });
        S.myRfqs.sort(function(a,b){ return (b.createdMs||0)-(a.createdMs||0); });
        if(S.selectedRfq){ var f=byId(S.myRfqs,S.selectedRfq.id); if(f)S.selectedRfq=f; }
        render();
      }, function(e){ console.error('myRfqs',e); });
    } else {
      db.collection(COL.rfqs).onSnapshot(function(qs){
        S.allRfqs=[]; qs.forEach(function(d){ var o=d.data(); o.id=d.id; S.allRfqs.push(o); });
        S.allRfqs.sort(function(a,b){ return (b.createdMs||0)-(a.createdMs||0); });
        if(S.selectedRfq){ var f=byId(S.allRfqs,S.selectedRfq.id); if(f)S.selectedRfq=f; }
        render();
      }, function(e){ console.error('allRfqs',e); });
      db.collection(COL.connectors).onSnapshot(function(qs){
        S.connectors=[]; qs.forEach(function(d){ var o=d.data(); o.id=d.id; S.connectors.push(o); });
        render();
      }, function(e){ console.error('connectors',e); });
    }
  }
  function byId(arr,id){ for(var i=0;i<arr.length;i++){ if(arr[i].id===id)return arr[i]; } return null; }

  /* quotes for a specific RFQ, loaded on demand */
  function subscribeQuotes(rfqId){
    if(S._quotesUnsub) S._quotesUnsub();
    S._quotesUnsub = db.collection(COL.quotes).where('rfqId','==',rfqId).onSnapshot(function(qs){
      S.quotes=[]; qs.forEach(function(d){ var o=d.data(); o.id=d.id; S.quotes.push(o); });
      S.quotes.sort(function(a,b){ return (a.pricePerUnit||1e9)-(b.pricePerUnit||1e9); });
      render();
    }, function(e){ console.error('quotes',e); });
  }

  /* =====================================================================
     RENDER ROUTER
     ===================================================================== */
  function render(){
    var main=$('mainArea');
    if(S.selectedRfq){ main.innerHTML=''; main.appendChild(viewRfqDetail(S.selectedRfq)); return; }
    if(S.selectedAsset){ main.innerHTML=''; main.appendChild(viewAssetDetail(S.selectedAsset)); return; }
    main.innerHTML='';
    if(S.role==='buyer'){
      if(S.nav==='floor') main.appendChild(viewMarketFloor());
      else if(S.nav==='myrfqs') main.appendChild(viewMyRfqs());
      else main.appendChild(viewMyAssets());
    } else {
      if(S.nav==='console') main.appendChild(viewConsole());
      else if(S.nav==='floor') main.appendChild(viewMarketFloor());
      else if(S.nav==='rfqs') main.appendChild(viewRfqInbox());
      else if(S.nav==='assets') main.appendChild(viewOperatorAssets());
      else main.appendChild(viewConnectors());
    }
  }

  /* =====================================================================
     MARKET FLOOR — compute-unit tape with 3 products + filters
     ===================================================================== */
  function liveAssets(){ return S.assets.filter(function(a){ return a.status==='live'||a.status==='matched'; }); }

  // flatten live assets into sellable compute rows for the chosen product
  function tapeRows(){
    var rows=[]; var f=S.filter; var prod=S.product;
    liveAssets().forEach(function(a){
      (a.compute||[]).forEach(function(sku,idx){
        if(!sku.products || sku.products.indexOf(prod)<0) return;
        if(f.gpu && sku.gpuClass!==f.gpu) return;
        if(f.region && (a.region||sku.region)!==f.region) return;
        var price = prod==='reserved' ? sku.priceKWmo : (prod==='forward' ? (sku.priceFwd||sku.priceHr) : sku.priceHr);
        if(f.q){ var hay=((sku.gpuClass||'')+' '+(a.name||'')+' '+(a.ownerOrg||'')).toLowerCase(); if(hay.indexOf(f.q.toLowerCase())<0) return; }
        rows.push({ asset:a, sku:sku, idx:idx, price:price });
      });
    });
    rows.sort(function(x,y){ return (x.price||1e9)-(y.price||1e9); });
    return rows;
  }

  function viewMarketFloor(){
    var wrap=el('div');
    var head=el('div','page-head');
    head.innerHTML='<div><h1>Market Floor</h1><p class="ph-sub">Live GPU capacity across the exchange — every SKU Molecule-metered and operator-backed by ClearSky. Pick a market, filter, and request a quote to lock the numbers behind your VDC proposal.</p></div>';
    wrap.appendChild(head);

    // product selector
    var pt=el('div','prod-tabs');
    ['ondemand','reserved','forward'].forEach(function(k){
      var p=PRODUCTS[k];
      var b=el('button','prod-tab'+(S.product===k?' active':''));
      b.innerHTML='<div class="pt-num">'+p.num+'</div><div class="pt-name">'+p.name+'</div><div class="pt-desc">'+p.desc+'</div><div class="pt-eq">'+p.eq+'</div>';
      b.onclick=function(){ S.product=k; render(); };
      pt.appendChild(b);
    });
    wrap.appendChild(pt);

    // KPIs for this product
    var rows=tapeRows();
    var provSet={}; rows.forEach(function(r){ provSet[r.asset.id]=1; });
    var metered=rows.filter(function(r){ return r.asset.meteringConnected; }).length;
    var prices=rows.map(function(r){ return r.price; }).filter(function(x){ return x!=null; });
    var lo = prices.length?Math.min.apply(null,prices):null;
    var unit=PRODUCTS[S.product].unit;
    var kpis=el('div','kpi-row');
    kpis.appendChild(kpi('Live SKUs', rows.length, PRODUCTS[S.product].name+' market'));
    kpis.appendChild(kpi('Providers', Object.keys(provSet).length, 'operator-backed assets'));
    kpis.appendChild(kpi('Best price', lo!=null?money(lo, S.product==='reserved'?0:2):'—', unit));
    kpis.appendChild(kpi('Metered', metered+'/'+rows.length, 'Molecule-connected'));
    wrap.appendChild(kpis);

    // filters
    var fb=el('div','filter-bar');
    fb.appendChild(filterSelect('gpu','GPU class', GPU_CLASSES));
    fb.appendChild(filterSelect('region','Region', REGIONS));
    var srch=el('input','fb-search'); srch.type='text'; srch.placeholder='Search assets, GPU, provider…'; srch.value=S.filter.q;
    srch.oninput=function(){ S.filter.q=srch.value; refreshTape(); };
    fb.appendChild(srch);
    if(S.role==='buyer'){
      var rfqBtn=el('button','btn btn-primary btn-sm','+ Request a quote');
      rfqBtn.onclick=function(){ openRfqModal(); };
      fb.appendChild(rfqBtn);
    }
    wrap.appendChild(fb);

    // tape
    if(!rows.length){
      wrap.appendChild(emptyState('No live SKUs in this market','Once sellers list compute SKUs on connected assets and operators publish them, they appear here on the tape.', S.role==='buyer'?'Request a quote anyway':null, S.role==='buyer'?function(){openRfqModal();}:null));
      return wrap;
    }
    var tape=el('div','tape'); tape.id='tapeEl';
    tape.appendChild(tapeHeader());
    rows.forEach(function(r){ tape.appendChild(tapeRow(r)); });
    wrap.appendChild(tape);
    return wrap;
  }

  function refreshTape(){
    var t=$('tapeEl'); if(!t) return;
    t.innerHTML=''; t.appendChild(tapeHeader());
    var rows=tapeRows();
    if(!rows.length){ t.appendChild(el('div','tape-row','<span class="tr-sub">No SKUs match your filters.</span>')); return; }
    rows.forEach(function(r){ t.appendChild(tapeRow(r)); });
  }

  function tapeHeader(){
    var h=el('div','tape-head');
    var priceLbl = S.product==='reserved'?'$ / kW-mo':(S.product==='forward'?'$ / GPU-hr (fwd)':'$ / GPU-hr');
    h.innerHTML='<span>GPU / Asset</span><span>Provider</span><span>Region</span><span>Available</span><span>Terms</span><span>'+priceLbl+'</span><span></span>';
    return h;
  }
  function tapeRow(r){
    var a=r.asset, sku=r.sku;
    var row=el('div','tape-row');
    var terms = (sku.terms&&sku.terms.length)?sku.terms.join('/')+' mo':'—';
    var avail = sku.qty!=null?(sku.qty+' GPUs'):'—';
    var dp = S.product==='reserved'?0:2;
    row.innerHTML=
      '<div><div class="tr-gpu">'+esc(sku.gpuClass||'GPU')+'</div><div class="tr-sub">'+esc(a.name||'')+'</div></div>'+
      '<div class="tr-mono">'+esc(a.ownerOrg||'—')+'</div>'+
      '<div class="tr-mono">'+esc(a.region||sku.region||'—')+'</div>'+
      '<div class="tr-mono">'+esc(avail)+'</div>'+
      '<div class="tr-mono">'+esc(terms)+'</div>'+
      '<div class="tr-price">'+money(r.price,dp)+'</div>';
    var act=el('div');
    var meter = a.meteringConnected?'<span class="tr-meter"><span class="d on"></span></span>':'<span class="tr-meter"><span class="d off"></span></span>';
    if(S.role==='buyer'){
      var b=el('button','btn btn-ghost btn-sm','Quote');
      b.onclick=function(ev){ ev.stopPropagation(); openRfqModal({ gpu:sku.gpuClass, region:(a.region||sku.region), qty:sku.qty, assetId:a.id }); };
      act.appendChild(b);
    } else {
      var v=el('button','btn btn-ghost btn-sm','View');
      v.onclick=function(){ S.selectedAsset=a; render(); };
      act.appendChild(v);
    }
    row.appendChild(act);
    row.onclick=function(){ S.selectedAsset=a; render(); };
    return row;
  }

  function filterSelect(key,label,opts){
    var s=el('select');
    s.innerHTML='<option value="">'+label+': All</option>'+opts.map(function(o){ return '<option value="'+esc(o)+'"'+(S.filter[key]===o?' selected':'')+'>'+esc(o)+'</option>'; }).join('');
    s.onchange=function(){ S.filter[key]=s.value; refreshTape(); };
    return s;
  }

  /* =====================================================================
     RFQ — buyer request flow (the "lock your numbers" mechanism)
     ===================================================================== */
  function openRfqModal(seed){
    seed=seed||{};
    var m=$('modalEl');
    m.innerHTML=
      '<h2>Request a quote</h2>'+
      '<p class="msub">Define the capacity you need. Operators and matching assets return priced quotes you can compare and lock — securing the numbers behind your VDC proposal.</p>'+
      sel('Market / product','rq_prod',[['ondemand','On-Demand ($/GPU-hr)'],['reserved','Reserved ($/kW-mo)'],['forward','Forward (hedged)']],seed.product||S.product)+
      row(
        sel('GPU class','rq_gpu',GPU_CLASSES.map(function(g){return [g,g];}),seed.gpu),
        fld('Quantity (GPUs)','rq_qty',seed.qty,'e.g. 256','number')
      )+
      row(
        sel('Region','rq_region',REGIONS.map(function(r){return [r,r];}),seed.region),
        sel('Term (months)','rq_term',TERMS.map(function(t){return [String(t),t+' mo'];}),seed.term)
      )+
      row(
        fld('Target price (optional)','rq_target',seed.target,'your ceiling','number'),
        fld('Ready by','rq_ready',seed.ready,'2026-Q3')
      )+
      fldArea('Workload notes (optional)','rq_notes',seed.notes,'Interconnect needs, power draw, SLA, tenancy, anything providers should price against.')+
      '<div class="info-note" style="margin-top:12px;">Your RFQ routes to ClearSky and matching assets. Lightsmith coordinates responses; quotes come back on standardized terms.</div>'+
      '<div class="modal-foot"><button class="btn btn-ghost" id="rq_cancel">Cancel</button><button class="btn btn-primary" id="rq_send">Send RFQ</button></div>';
    openModal();
    $('rq_cancel').onclick=closeModal;
    $('rq_send').onclick=function(){
      var gpu=$('rq_gpu').value, qty=numOrNull($('rq_qty').value);
      if(!gpu){ toast('Pick a GPU class.',true); return; }
      var data={
        buyerUid:S.user.uid, buyerOrg:S.profile.org, buyerEmail:S.profile.email, buyerName:S.profile.name,
        product:$('rq_prod').value, gpuClass:gpu, qty:qty,
        region:$('rq_region').value, termMonths:numOrNull($('rq_term').value),
        targetPrice:numOrNull($('rq_target').value), readyBy:$('rq_ready').value.trim(),
        notes:$('rq_notes').value.trim(),
        seedAssetId: seed.assetId||null,
        status:'open', quoteCount:0, createdMs:nowMs(), createdAt:ts()
      };
      $('rq_send').disabled=true;
      db.collection(COL.rfqs).add(data).then(function(ref){
        LightsmithAPI.route(ref.id, data);
        logEvent(null,'rfq','open',ref.id);
        closeModal(); toast('RFQ sent. Watch My Requests for quotes.');
        S.nav='myrfqs'; buildNav(); render();
      }).catch(function(e){ $('rq_send').disabled=false; toast('Failed: '+(e.message||e.code),true); });
    };
  }

  function viewMyRfqs(){
    var wrap=el('div');
    var head=el('div','page-head');
    head.innerHTML='<div><h1>My Requests</h1><p class="ph-sub">Your quote requests and their responses. Compare quotes side-by-side and lock the one that secures your proposal.</p></div>';
    var b=el('button','btn btn-primary','+ Request a quote'); b.onclick=function(){ openRfqModal(); };
    head.appendChild(b); wrap.appendChild(head);
    if(!S.myRfqs.length){ wrap.appendChild(emptyState('No requests yet','Request a quote from the Market Floor to source capacity for your VDC proposal.','Request a quote',function(){openRfqModal();})); return wrap; }
    var grid=el('div','grid'); S.myRfqs.forEach(function(r){ grid.appendChild(rfqCard(r)); }); wrap.appendChild(grid);
    return wrap;
  }

  function viewRfqInbox(){
    var wrap=el('div');
    var head=el('div','page-head');
    head.innerHTML='<div><h1>RFQ Inbox</h1><p class="ph-sub">Incoming buyer quote requests. Respond with a priced quote against a live asset SKU — '+orgLabel(S.org)+' operator view.</p></div>';
    wrap.appendChild(head);
    var open=S.allRfqs.filter(function(r){ return r.status==='open'||r.status==='quoted'; });
    if(!open.length){ wrap.appendChild(emptyState('No open RFQs','New buyer requests appear here for quoting.',null,null)); return wrap; }
    var grid=el('div','grid'); open.forEach(function(r){ grid.appendChild(rfqCard(r,true)); }); wrap.appendChild(grid);
    return wrap;
  }

  function rfqCard(r, operator){
    var c=el('div','card');
    c.onclick=function(){ S.selectedRfq=r; subscribeQuotes(r.id); render(); };
    var p=PRODUCTS[r.product]||PRODUCTS.reserved;
    c.appendChild(elFrom('<div class="c-top"><div><div class="c-name">'+esc(r.gpuClass)+' × '+(r.qty||'?')+'</div><div class="c-meta">'+p.name+' · '+esc(r.region||'any region')+(r.termMonths?(' · '+r.termMonths+' mo'):'')+'</div></div>'+rfqPill(r.status)+'</div>'));
    c.appendChild(elFrom('<div class="c-stats">'+
      cstat('Product',p.name)+
      cstat('Quantity',(r.qty!=null?r.qty+' GPUs':'—'))+
      cstat('Target',(r.targetPrice!=null?money(r.targetPrice,2):'—'))+
      cstat('Quotes',String(r.quoteCount||0))+
    '</div>'));
    var footTxt = operator ? esc(r.buyerOrg||'Buyer') : ((r.quoteCount||0)+' quote'+((r.quoteCount===1)?'':'s'));
    c.appendChild(elFrom('<div class="c-foot"><span style="font-size:12px;color:var(--cs-muted);">'+footTxt+'</span><span style="font-size:12px;color:var(--cs-blue);font-weight:600;">'+(operator?'Respond →':'Compare →')+'</span></div>'));
    return c;
  }

  function viewRfqDetail(r){
    var wrap=el('div');
    var back=el('button','link-back','← Back'); back.onclick=function(){ S.selectedRfq=null; if(S._quotesUnsub){S._quotesUnsub(); S._quotesUnsub=null;} S.quotes=[]; render(); };
    wrap.appendChild(back);
    var p=PRODUCTS[r.product]||PRODUCTS.reserved;
    var head=el('div','page-head');
    head.innerHTML='<div><h1>'+esc(r.gpuClass)+' × '+(r.qty||'?')+'</h1><p class="ph-sub">'+p.name+' market · requested by '+esc(r.buyerOrg||'—')+'</p></div>'+rfqPill(r.status);
    wrap.appendChild(head);

    var grid=el('div','detail-grid'); var left=el('div');
    var spec=el('div','panel');
    spec.innerHTML='<h3>Request Spec</h3>'+kvList([
      ['Market',p.name],['GPU class',r.gpuClass],['Quantity',r.qty!=null?r.qty+' GPUs':'—'],
      ['Region',r.region||'Any'],['Term',r.termMonths?r.termMonths+' months':'—'],
      ['Target price',r.targetPrice!=null?money(r.targetPrice,2)+' '+p.unit:'—'],['Ready by',r.readyBy||'—']
    ]);
    if(r.notes){ spec.innerHTML+='<div class="info-note" style="margin-top:12px;"><b>Workload:</b> '+esc(r.notes)+'</div>'; }
    left.appendChild(spec);

    // quotes compare
    var qp=el('div','panel');
    qp.innerHTML='<h3>Quotes ('+S.quotes.length+')</h3>';
    if(!S.quotes.length){ qp.appendChild(elFrom('<p style="font-size:13px;color:var(--cs-muted);">No quotes yet. '+(S.role==='operator'?'Submit one from the panel on the right.':'Operators are pricing your request.')+'</p>')); }
    else {
      S.quotes.forEach(function(q,i){
        var best=(i===0 && r.status!=='locked');
        var locked=(r.lockedQuoteId===q.id);
        var card=el('div','quote-card'+((best||locked)?' best':''));
        var tag = locked?'<div class="best-tag">Locked</div>':(best?'<div class="best-tag">Best price</div>':'');
        card.innerHTML='<div class="qc-left">'+tag+'<div class="qc-provider">'+esc(q.providerOrg||'Provider')+'</div>'+
          '<div class="qc-meta">'+esc(q.assetName||'')+' · '+esc(q.region||'—')+(q.termMonths?(' · '+q.termMonths+' mo'):'')+(q.leadTime?(' · '+esc(q.leadTime)):'')+'</div></div>'+
          '<div class="qc-price"><div class="p">'+money(q.pricePerUnit, r.product==='reserved'?0:2)+'</div><div class="u">'+p.unit+'</div></div>';
        // buyer lock action
        if(S.role==='buyer' && r.status!=='locked'){
          var lk=el('button','btn btn-green btn-sm','Lock'); lk.style.marginLeft='12px';
          lk.onclick=function(ev){ ev.stopPropagation(); lockQuote(r,q); };
          card.appendChild(lk);
        }
        qp.appendChild(card);
      });
    }
    left.appendChild(qp);
    grid.appendChild(left);

    // right action panel
    var right=el('div'); right.appendChild(rfqActionPanel(r)); grid.appendChild(right);
    wrap.appendChild(grid);
    return wrap;
  }

  function rfqActionPanel(r){
    var ap=el('div','action-panel');
    if(S.role==='operator' && r.status!=='locked' && r.status!=='cancelled'){
      ap.innerHTML='<div class="ap-title">Submit a Quote · '+orgLabel(S.org)+'</div>';
      // eligible live assets to quote from
      var mine=liveAssets();
      var opts=mine.map(function(a){ return [a.id, a.name+' ('+(a.ownerOrg||'')+')']; });
      ap.appendChild(elFrom(sel('Quote from asset','q_asset',opts,r.seedAssetId||'')));
      ap.appendChild(elFrom(fld('Price ('+(PRODUCTS[r.product]||PRODUCTS.reserved).unit+')','q_price','','','number')));
      ap.appendChild(elFrom(fld('Lead time','q_lead','','e.g. 2 weeks')));
      ap.appendChild(elFrom(fldArea('Note (optional)','q_note','','SLA, tenancy, ramp schedule.')));
      var send=el('button','btn btn-primary btn-block','Submit quote');
      send.onclick=function(){ submitQuote(r); };
      ap.appendChild(send);
      return ap;
    }
    ap.innerHTML='<div class="ap-title">Request Status</div>';
    var note=el('div','ap-note');
    note.innerHTML = r.status==='locked'
      ? 'Locked. Capacity is secured against your VDC proposal. Lightsmith and ClearSky will coordinate contracting.'
      : r.status==='cancelled' ? 'This request was cancelled.'
      : (S.role==='buyer' ? 'Open. Operators are returning quotes — compare and lock the one that fits.' : 'This request is '+r.status+'.');
    ap.appendChild(note);
    if(S.role==='buyer' && r.status!=='locked' && r.status!=='cancelled'){
      var cancel=el('button','btn btn-danger btn-block','Cancel request'); cancel.style.marginTop='12px';
      cancel.onclick=function(){ db.collection(COL.rfqs).doc(r.id).update({status:'cancelled',updatedMs:nowMs()}).then(function(){ toast('Request cancelled.'); }); };
      ap.appendChild(cancel);
    }
    return ap;
  }

  function submitQuote(r){
    var assetId=$('q_asset').value, price=numOrNull($('q_price').value);
    if(!assetId){ toast('Pick an asset to quote from.',true); return; }
    if(price==null){ toast('Enter a price.',true); return; }
    var a=byId(S.assets,assetId)||{};
    var q={
      rfqId:r.id, product:r.product,
      providerUid:S.user.uid, providerOrg:orgLabel(S.org),
      assetId:assetId, assetName:a.name||'', region:a.region||r.region||'',
      termMonths:r.termMonths||null, pricePerUnit:price,
      leadTime:$('q_lead').value.trim(), note:$('q_note').value.trim(),
      createdMs:nowMs(), createdAt:ts()
    };
    db.collection(COL.quotes).add(q).then(function(){
      return db.collection(COL.rfqs).doc(r.id).update({ status:'quoted', quoteCount:(r.quoteCount||0)+1, updatedMs:nowMs() });
    }).then(function(){ logEvent(assetId,'quote','submitted',r.id); toast('Quote submitted.'); $('q_price').value=''; })
      .catch(function(e){ toast('Failed: '+(e.message||e.code),true); });
  }

  function lockQuote(r,q){
    db.collection(COL.rfqs).doc(r.id).update({ status:'locked', lockedQuoteId:q.id, lockedPrice:q.pricePerUnit, lockedAssetId:q.assetId, updatedMs:nowMs() })
      .then(function(){
        // mark asset matched
        if(q.assetId) db.collection(COL.assets).doc(q.assetId).update({ status:'matched', updatedMs:nowMs() }).catch(function(){});
        LightsmithAPI.match(r.id, q);
        logEvent(q.assetId,'lock',q.pricePerUnit,r.id);
        toast('Quote locked. Numbers secured.');
      }).catch(function(e){ toast('Failed: '+(e.message||e.code),true); });
  }

  /* =====================================================================
     SELLER · MY ASSETS (asset onboarding + compute SKUs)
     ===================================================================== */
  function viewMyAssets(){
    var wrap=el('div');
    var head=el('div','page-head');
    head.innerHTML='<div><h1>My Data Assets</h1><p class="ph-sub">List a powered data asset, then define the compute SKUs that run on it. Provide the interconnection + metering detail we need to connect and meter it via Molecule.</p></div>';
    var addBtn=el('button','btn btn-primary','+ List a data asset'); addBtn.onclick=function(){ openAssetModal(); };
    head.appendChild(addBtn); wrap.appendChild(head);
    var mine=S.assets.filter(function(a){ return a.ownerUid===S.user.uid; });
    if(!mine.length){ wrap.appendChild(emptyState('No assets yet','List your first powered asset. Add power, site, interconnection, and the compute SKUs buyers can source from it.','List a data asset',function(){openAssetModal();})); return wrap; }
    var grid=el('div','grid'); mine.forEach(function(a){ grid.appendChild(assetCard(a)); }); wrap.appendChild(grid);
    return wrap;
  }

  function assetCard(a){
    var c=el('div','card'); c.onclick=function(){ S.selectedAsset=a; render(); };
    c.appendChild(elFrom('<div class="c-top"><div><div class="c-name">'+esc(a.name||'Untitled asset')+'</div><div class="c-meta">'+esc(a.location||'—')+(a.ownerOrg&&S.role==='operator'?(' · '+esc(a.ownerOrg)):'')+'</div></div>'+statusPill(a.status)+'</div>'));
    var skuCount=(a.compute||[]).length;
    c.appendChild(elFrom('<div class="c-stats">'+
      cstat('Power',(a.powerMW!=null?a.powerMW+' MW':'—'))+
      cstat('IT Load',(a.itLoadKW!=null?a.itLoadKW+' kW':'—'))+
      cstat('Compute SKUs',String(skuCount))+
      cstat('Region',esc(a.region||'—'))+
    '</div>'));
    c.appendChild(elFrom('<div style="margin-bottom:12px;">'+trustRow(a)+'</div>'));
    c.appendChild(elFrom('<div class="c-foot"><span style="font-size:12px;color:var(--cs-muted);">'+(a.meteringConnected?'<span style="color:var(--cs-green);font-weight:600;">● Metering live</span>':'<span style="color:var(--cs-muted-2);">○ Not metered</span>')+'</span><span style="font-size:12px;color:var(--cs-blue);font-weight:600;">Details →</span></div>'));
    return c;
  }
  function cstat(k,v){ return '<div class="c-stat"><div class="k">'+k+'</div><div class="v">'+esc(v)+'</div></div>'; }

  /* =====================================================================
     ASSET DETAIL
     ===================================================================== */
  function viewAssetDetail(a){
    var wrap=el('div');
    var back=el('button','link-back','← Back'); back.onclick=function(){ S.selectedAsset=null; render(); };
    wrap.appendChild(back);
    var head=el('div','page-head');
    head.innerHTML='<div><h1>'+esc(a.name)+'</h1><p class="ph-sub">'+esc(a.location||'')+' · listed by '+esc(a.ownerOrg||'—')+'</p></div>'+statusPill(a.status);
    wrap.appendChild(head);
    wrap.appendChild(elFrom('<div style="margin:-8px 0 18px;">'+trustRow(a)+'</div>'));

    var grid=el('div','detail-grid'); var left=el('div');

    // compute SKUs — the sellable units
    var skuP=el('div','panel');
    skuP.innerHTML='<h3>Compute SKUs</h3>';
    var skus=a.compute||[];
    if(!skus.length){ skuP.appendChild(elFrom('<p style="font-size:13px;color:var(--cs-muted);">No SKUs defined yet.</p>')); }
    else {
      var t=el('table','admin-table');
      t.innerHTML='<thead><tr><th>GPU</th><th class="num">Qty</th><th>Markets</th><th class="num">$/GPU-hr</th><th class="num">$/kW-mo</th></tr></thead>';
      var tb=el('tbody');
      skus.forEach(function(s){
        var mk=(s.products||[]).map(function(p){ return (PRODUCTS[p]||{}).name||p; }).join(', ');
        tb.appendChild(elFrom('<tr><td><b>'+esc(s.gpuClass)+'</b></td><td class="num">'+(s.qty!=null?s.qty:'—')+'</td><td>'+esc(mk||'—')+'</td><td class="num">'+money(s.priceHr,2)+'</td><td class="num">'+money(s.priceKWmo,0)+'</td></tr>'));
      });
      t.appendChild(tb); skuP.appendChild(t);
    }
    left.appendChild(skuP);

    left.appendChild(panelKV('Power & Compute Profile',[
      ['Asset type',assetTypeLabel(a.assetType)],['Nameplate power',a.powerMW!=null?a.powerMW+' MW':'—'],
      ['IT / critical load',a.itLoadKW!=null?a.itLoadKW+' kW':'—'],['Design PUE',a.pue!=null?a.pue:'—'],
      ['Redundancy tier',a.tier||'—'],['Behind the meter',a.btm?'Yes':'No']
    ]));
    left.appendChild(panelKV('Site & Interconnection',[
      ['Site address',a.siteAddress||'—'],['Utility / ISO',a.utility||'—'],['Service voltage',a.voltage||'—'],
      ['Interconnection',a.interconnect||'—'],['On-site generation',a.onsiteGen||'—'],['BESS paired',a.bessKWh?(a.bessKWh+' kWh'):'None']
    ]));
    var connP=panelKV('Connectivity & Metering',[
      ['Metering protocol',a.meterProtocol||'—'],['Data endpoint',a.meterEndpoint||'—'],['Telemetry cadence',a.telemetryHz||'—'],
      ['EMS / SCADA',a.emsVendor||'—'],['Molecule connector',a.meteringConnected?'Connected':'Pending'],
      ['Technical contact',(a.techContactName?esc(a.techContactName):'—')+(a.techContactEmail?(' · '+esc(a.techContactEmail)):'')]
    ]);
    if(a.integrationNotes){ connP.innerHTML+='<div class="info-note" style="margin-top:14px;"><b>Integration notes:</b> '+esc(a.integrationNotes)+'</div>'; }
    left.appendChild(connP);
    grid.appendChild(left);

    var right=el('div'); right.appendChild(assetActionPanel(a)); grid.appendChild(right);
    wrap.appendChild(grid);
    return wrap;
  }

  function assetActionPanel(a){
    var ap=el('div','action-panel');
    var isOwner=a.ownerUid===S.user.uid;
    if(S.role==='buyer' && isOwner){
      ap.innerHTML='<div class="ap-title">Your Asset</div>';
      var edit=el('button','btn btn-ghost btn-block','Edit details & SKUs'); edit.style.marginBottom='10px'; edit.onclick=function(){ openAssetModal(a); };
      ap.appendChild(edit);
      if(a.status==='draft'){
        var sub=el('button','btn btn-primary btn-block','Submit for review');
        sub.onclick=function(){ setAssetStatus(a,'submitted','Submitted. ClearSky will begin the connection workflow.'); };
        ap.appendChild(sub);
      }
      ap.appendChild(elFrom('<div class="ap-note" style="margin-top:12px;">'+statusExplainer(a.status,'buyer')+'</div>'));
      return ap;
    }
    if(S.role==='operator'){
      ap.innerHTML='<div class="ap-title">Operator Actions · '+orgLabel(S.org)+'</div>';
      operatorActionsFor(a.status).forEach(function(act){
        var b=el('button','btn '+act.cls+' btn-block',act.label); b.style.marginBottom='10px';
        b.onclick=function(){ setAssetStatus(a,act.to,act.toast); }; ap.appendChild(b);
      });
      var connBtn=el('button','btn '+(a.meteringConnected?'btn-ghost':'btn-green')+' btn-block', a.meteringConnected?'Metering connected ✓':'Connect Molecule metering');
      connBtn.style.marginBottom='10px';
      if(!a.meteringConnected){ connBtn.onclick=function(){ openMeteringModal(a); }; } else { connBtn.disabled=true; }
      ap.appendChild(connBtn);
      if(a.status!=='suspended'){ var s=el('button','btn btn-danger btn-block','Suspend from exchange'); s.onclick=function(){ setAssetStatus(a,'suspended','Asset suspended.'); }; ap.appendChild(s); }
      else { var re=el('button','btn btn-amber btn-block','Reinstate'); re.onclick=function(){ setAssetStatus(a,'review','Reinstated to review.'); }; ap.appendChild(re); }
      ap.appendChild(elFrom('<div class="ap-note" style="margin-top:12px;">'+statusExplainer(a.status,'operator')+'</div>'));
      return ap;
    }
    ap.innerHTML='<div class="ap-title">Source From This Asset</div><div class="ap-note">Live on the exchange. Request a quote to secure capacity against your VDC proposal.</div>';
    var q=el('button','btn btn-primary btn-block','Request a quote'); q.style.marginTop='12px';
    q.onclick=function(){ var s=(a.compute||[])[0]||{}; openRfqModal({ gpu:s.gpuClass, region:a.region, qty:s.qty, assetId:a.id }); };
    ap.appendChild(q);
    return ap;
  }
  function operatorActionsFor(status){
    switch(status){
      case 'submitted': return [{label:'Begin review',to:'review',cls:'btn-primary',toast:'Moved to review.'}];
      case 'review':    return [{label:'Approve → start connection',to:'connecting',cls:'btn-primary',toast:'Connection started.'}];
      case 'connecting':return [{label:'Publish live to floor',to:'live',cls:'btn-green',toast:'Asset is live.'}];
      default: return [];
    }
  }
  function statusExplainer(st){
    var b={ draft:'Not yet submitted. Add SKUs and submit for review.', submitted:'Awaiting ClearSky review.',
      review:'ClearSky is validating site, power, and interconnection.', connecting:'Approved. Molecule is establishing metering; Lightsmith is preparing the listing.',
      live:'Live on the floor. SKUs are visible and quotable.', matched:'Offtake secured against a VDC proposal.', suspended:'Removed from the floor.' };
    return b[st]||'';
  }

  /* =====================================================================
     ASSET CREATE / EDIT MODAL — includes compute SKU editor
     ===================================================================== */
  var _skuDraft = [];
  function openAssetModal(existing){
    var a=(existing&&existing.id)?existing:{};
    _skuDraft = (a.compute||[]).map(function(s){ return JSON.parse(JSON.stringify(s)); });
    if(!_skuDraft.length) _skuDraft=[ blankSku() ];
    var m=$('modalEl');
    m.innerHTML=
      '<h2>'+(a.id?'Edit data asset':'List a powered data asset')+'</h2>'+
      '<p class="msub">Everything we need to connect, meter, and list this asset. Connectivity fields feed the Molecule integration; SKUs are what buyers source.</p>'+
      '<div class="step-head">1 · Asset basics</div>'+
      fld('Asset name','am_name',a.name,'e.g. Clinton GPU Hall A')+
      row(sel('Asset type','am_type',[['gpu','GPU Cluster'],['hpc','HPC'],['crypto','Crypto / ASIC'],['mixed','Mixed Compute'],['colo','Colocation']],a.assetType),
          fld('Location (city, state)','am_loc',a.location,'Clinton, IA'))+
      sel('Region','am_region',REGIONS.map(function(r){return [r,r];}),a.region)+
      '<div class="step-head">2 · Power &amp; compute</div>'+
      row(fld('Nameplate power (MW)','am_mw',a.powerMW,'5','number'),fld('IT / critical load (kW)','am_it',a.itLoadKW,'3500','number'))+
      row(fld('Design PUE','am_pue',a.pue,'1.25','number'),sel('Redundancy tier','am_tier',[['N','N'],['N+1','N+1'],['2N','2N'],['2N+1','2N+1']],a.tier))+
      chk('Behind-the-meter (BTM) load','am_btm',a.btm)+
      '<div class="step-head">3 · Compute SKUs — what buyers source</div>'+
      '<div id="skuList"></div>'+
      '<button class="btn btn-ghost btn-sm" id="am_addsku" style="margin-bottom:6px;">+ Add SKU</button>'+
      '<div class="step-head">4 · Site &amp; interconnection</div>'+
      fld('Site address','am_addr',a.siteAddress,'Full street address')+
      row(fld('Utility / ISO','am_util',a.utility,'MidAmerican / MISO'),fld('Service voltage','am_volt',a.voltage,'13.8 kV'))+
      row(sel('Interconnection status','am_ic',[['study','In study'],['approved','Approved'],['energized','Energized'],['none','Not started']],a.interconnect),
          fld('On-site generation','am_gen',a.onsiteGen,'Grid / solar / gas'))+
      fld('Paired BESS (kWh, optional)','am_bess',a.bessKWh,'0','number')+
      '<div class="step-head">5 · Connectivity &amp; metering — how we connect you</div>'+
      row(sel('Metering protocol','am_proto',[['modbus','Modbus TCP'],['dnp3','DNP3'],['mqtt','MQTT'],['rest','REST/JSON API'],['ocpp','OCPP'],['other','Other']],a.meterProtocol),
          fld('Telemetry cadence','am_hz',a.telemetryHz,'1s / 15s / 1min'))+
      fld('Data endpoint / gateway','am_ep',a.meterEndpoint,'IP:port, hostname, or API base URL')+
      fld('EMS / SCADA vendor','am_ems',a.emsVendor,'e.g. Molecule, Ampere, custom')+
      row(fld('Technical contact name','am_tcn',a.techContactName,'Site engineer'),fld('Technical contact email','am_tce',a.techContactEmail,'eng@company.com'))+
      fldArea('Integration notes','am_notes',a.integrationNotes,'VPN, firewall rules, register maps, auth method — anything we need to connect.')+
      '<div class="modal-foot"><button class="btn btn-ghost" id="am_cancel">Cancel</button><button class="btn btn-primary" id="am_save">'+(a.id?'Save changes':'Save asset')+'</button></div>';
    openModal();
    renderSkuEditor();
    $('am_addsku').onclick=function(){ _skuDraft.push(blankSku()); renderSkuEditor(); };
    $('am_cancel').onclick=closeModal;
    $('am_save').onclick=function(){ saveAsset(a); };
  }
  function blankSku(){ return { gpuClass:'H100', qty:null, priceHr:null, priceKWmo:null, priceFwd:null, products:['reserved'], region:'' }; }

  function renderSkuEditor(){
    var box=$('skuList'); if(!box) return;
    box.innerHTML='';
    _skuDraft.forEach(function(s,i){
      var rowEl=el('div','sku-row');
      rowEl.innerHTML=
        sel2('GPU','sku_gpu_'+i,GPU_CLASSES.map(function(g){return [g,g];}),s.gpuClass)+
        fld2('Qty','sku_qty_'+i,s.qty,'256','number')+
        fld2('$/GPU-hr','sku_hr_'+i,s.priceHr,'1.90','number')+
        '<button class="sku-del" data-i="'+i+'">✕</button>';
      box.appendChild(rowEl);
      // second row of the SKU for reserved/forward + markets
      var row2=el('div','sku-row');
      row2.innerHTML=
        fld2('$/kW-mo','sku_kw_'+i,s.priceKWmo,'95','number')+
        fld2('$/GPU-hr fwd','sku_fwd_'+i,s.priceFwd,'1.75','number')+
        marketChecks(i,s.products)+
        '<div></div>';
      box.appendChild(row2);
      syncSku(i);
    });
    // wire deletes + inputs
    var dels=box.querySelectorAll('.sku-del');
    for(var d=0; d<dels.length; d++){ dels[d].onclick=function(){ var idx=Number(this.getAttribute('data-i')); _skuDraft.splice(idx,1); if(!_skuDraft.length)_skuDraft=[blankSku()]; renderSkuEditor(); }; }
    _skuDraft.forEach(function(s,i){ wireSkuInputs(i); });
  }
  function marketChecks(i,products){
    products=products||[];
    function ck(k,lbl){ return '<label style="font-size:11px;display:inline-flex;align-items:center;gap:4px;margin-right:8px;"><input type="checkbox" id="sku_p_'+k+'_'+i+'"'+(products.indexOf(k)>=0?' checked':'')+' style="width:14px;height:14px;accent-color:var(--cs-blue);">'+lbl+'</label>'; }
    return '<div class="field"><label>Markets</label><div>'+ck('ondemand','On-Dmd')+ck('reserved','Rsvd')+ck('forward','Fwd')+'</div></div>';
  }
  function wireSkuInputs(i){
    ['gpu','qty','hr','kw','fwd'].forEach(function(f){ var e=$('sku_'+f+'_'+i); if(e) e.onchange=function(){ syncSku(i); }; });
    ['ondemand','reserved','forward'].forEach(function(p){ var e=$('sku_p_'+p+'_'+i); if(e) e.onchange=function(){ syncSku(i); }; });
  }
  function syncSku(i){
    var s=_skuDraft[i]; if(!s) return;
    if($('sku_gpu_'+i)) s.gpuClass=$('sku_gpu_'+i).value;
    if($('sku_qty_'+i)) s.qty=numOrNull($('sku_qty_'+i).value);
    if($('sku_hr_'+i)) s.priceHr=numOrNull($('sku_hr_'+i).value);
    if($('sku_kw_'+i)) s.priceKWmo=numOrNull($('sku_kw_'+i).value);
    if($('sku_fwd_'+i)) s.priceFwd=numOrNull($('sku_fwd_'+i).value);
    var ps=[]; ['ondemand','reserved','forward'].forEach(function(p){ var e=$('sku_p_'+p+'_'+i); if(e&&e.checked)ps.push(p); });
    s.products=ps;
  }

  function saveAsset(a){
    _skuDraft.forEach(function(s,i){ syncSku(i); });
    var name=$('am_name').value.trim();
    if(!name){ toast('Asset name is required.',true); return; }
    var skus=_skuDraft.filter(function(s){ return s.gpuClass && (s.priceHr!=null||s.priceKWmo!=null||s.priceFwd!=null); });
    var data={
      name:name, assetType:$('am_type').value, location:$('am_loc').value.trim(), region:$('am_region').value,
      powerMW:numOrNull($('am_mw').value), itLoadKW:numOrNull($('am_it').value), pue:numOrNull($('am_pue').value),
      tier:$('am_tier').value, btm:$('am_btm').checked,
      compute:skus,
      siteAddress:$('am_addr').value.trim(), utility:$('am_util').value.trim(), voltage:$('am_volt').value.trim(),
      interconnect:$('am_ic').value, onsiteGen:$('am_gen').value.trim(), bessKWh:numOrNull($('am_bess').value),
      meterProtocol:$('am_proto').value, telemetryHz:$('am_hz').value.trim(), meterEndpoint:$('am_ep').value.trim(),
      emsVendor:$('am_ems').value.trim(), techContactName:$('am_tcn').value.trim(), techContactEmail:$('am_tce').value.trim(),
      integrationNotes:$('am_notes').value.trim(), updatedMs:nowMs()
    };
    var save;
    if(a.id){ save=db.collection(COL.assets).doc(a.id).update(data); }
    else {
      data.ownerUid=S.user.uid; data.ownerOrg=S.profile.org; data.ownerEmail=S.profile.email;
      data.status='draft'; data.meteringConnected=false; data.createdMs=nowMs(); data.createdAt=ts();
      save=db.collection(COL.assets).add(data);
      // upgrade profile to seller
      if(!S.profile.isSeller){ db.collection(COL.profiles).doc(S.user.uid).update({isSeller:true}).then(function(){ S.profile.isSeller=true; }); }
    }
    save.then(function(){ closeModal(); toast(a.id?'Asset updated.':'Asset saved as draft.'); })
        .catch(function(e){ console.error(e); toast('Save failed: '+(e.message||e.code),true); });
  }

  function setAssetStatus(a,status,msg){
    db.collection(COL.assets).doc(a.id).update({ status:status, updatedMs:nowMs(), statusBy:S.profile.email, statusByOrg:S.org||S.profile.org })
      .then(function(){ logEvent(a.id,'status',status); toast(msg||('Status: '+status)); })
      .catch(function(e){ toast('Failed: '+(e.message||e.code),true); });
  }

  /* =====================================================================
     MOLECULE METERING CONNECT MODAL
     ===================================================================== */
  function openMeteringModal(a){
    var m=$('modalEl');
    m.innerHTML=
      '<h2>Connect Molecule metering</h2>'+
      '<p class="msub">Establish the metering feed for <b>'+esc(a.name)+'</b> via the Molecule Systems API. Registers the asset for real-time telemetry and dispatch settlement.</p>'+
      fld('Molecule site ID','mm_site',a.moleculeSiteId,'auto if blank')+
      fld('API base URL','mm_url',a.moleculeApiUrl||'https://api.moleculesystems.com/v1','')+
      sel('Auth method','mm_auth',[['apikey','API Key'],['oauth','OAuth 2.0'],['mtls','mTLS']],a.moleculeAuth)+
      fld('Registered endpoint','mm_ep',a.meterEndpoint,'from asset connectivity details')+
      '<div class="info-note" style="margin-top:12px;">On connect, OMEGA registers the asset with Molecule and polls telemetry at the asset cadence. Settlement flows back for Lightsmith matching.</div>'+
      '<div class="modal-foot"><button class="btn btn-ghost" id="mm_cancel">Cancel</button><button class="btn btn-green" id="mm_connect">Connect &amp; register</button></div>';
    openModal();
    $('mm_cancel').onclick=closeModal;
    $('mm_connect').onclick=function(){
      var payload={ moleculeSiteId:$('mm_site').value.trim()||('MOL-'+a.id.slice(0,8).toUpperCase()),
        moleculeApiUrl:$('mm_url').value.trim(), moleculeAuth:$('mm_auth').value, meterEndpoint:$('mm_ep').value.trim(),
        meteringConnected:true, meteringConnectedBy:S.profile.email, meteringConnectedMs:nowMs(), updatedMs:nowMs() };
      $('mm_connect').disabled=true;
      MoleculeAPI.register(a,payload).then(function(res){
        payload.moleculeConnectorId=res.connectorId;
        return db.collection(COL.assets).doc(a.id).update(payload);
      }).then(function(){ logEvent(a.id,'metering','connected'); closeModal(); toast('Molecule metering connected.'); })
        .catch(function(e){ $('mm_connect').disabled=false; toast('Connect failed: '+(e.message||e),true); });
    };
  }

  /* =====================================================================
     OPERATOR · CONSOLE
     ===================================================================== */
  function viewConsole(){
    var wrap=el('div');
    var head=el('div','page-head');
    head.innerHTML='<div><h1>Exchange Console</h1><p class="ph-sub">'+orgLabel(S.org)+' operator view. Review assets, run the connection workflow, quote RFQs, and manage the floor. Shared backend across ClearSky, Molecule, and Lightsmith.</p></div>';
    wrap.appendChild(head);
    var byStatus={}; S.assets.forEach(function(a){ byStatus[a.status]=(byStatus[a.status]||0)+1; });
    var openRfqs=S.allRfqs.filter(function(r){return r.status==='open'||r.status==='quoted';}).length;
    var locked=S.allRfqs.filter(function(r){return r.status==='locked';}).length;
    var metered=S.assets.filter(function(a){return a.meteringConnected;}).length;
    var kpis=el('div','kpi-row');
    kpis.appendChild(kpi('Total Assets',S.assets.length,'all statuses'));
    kpis.appendChild(kpi('Pipeline',(byStatus.submitted||0)+(byStatus.review||0)+(byStatus.connecting||0),'submitted → connecting'));
    kpis.appendChild(kpi('Live',byStatus.live||0,'on the floor'));
    kpis.appendChild(kpi('Open RFQs',openRfqs,'awaiting quotes'));
    kpis.appendChild(kpi('Locked',locked,'offtake secured'));
    kpis.appendChild(kpi('Metered',metered,'Molecule connected'));
    wrap.appendChild(kpis);
    var pipeline=S.assets.filter(function(a){ return a.status!=='matched'; });
    var panel=el('div','panel'); panel.innerHTML='<h3>Asset Pipeline</h3>';
    if(!pipeline.length){ panel.appendChild(emptyState('Nothing in the pipeline','Buyer submissions appear here for review and connection.',null,null)); }
    else { panel.appendChild(assetTable(pipeline)); }
    wrap.appendChild(panel);
    return wrap;
  }
  function viewOperatorAssets(){
    var wrap=el('div');
    var head=el('div','page-head'); head.innerHTML='<div><h1>All Assets</h1><p class="ph-sub">Every listed asset across all sellers.</p></div>';
    wrap.appendChild(head);
    var panel=el('div','panel'); panel.innerHTML='<h3>'+S.assets.length+' assets</h3>'; panel.appendChild(assetTable(S.assets));
    wrap.appendChild(panel); return wrap;
  }
  function assetTable(list){
    var t=el('table','admin-table');
    t.innerHTML='<thead><tr><th>Asset</th><th>Owner</th><th class="num">Power</th><th class="num">SKUs</th><th>Metering</th><th>Status</th></tr></thead>';
    var tb=el('tbody');
    list.forEach(function(a){
      var tr=el('tr','clickable'); tr.onclick=function(){ S.selectedAsset=a; render(); };
      tr.innerHTML='<td><b>'+esc(a.name)+'</b><div style="font-size:11px;color:var(--cs-muted)">'+esc(a.location||'')+'</div></td>'+
        '<td>'+esc(a.ownerOrg||'—')+'</td>'+
        '<td class="num">'+(a.powerMW!=null?a.powerMW+' MW':'—')+'</td>'+
        '<td class="num">'+((a.compute||[]).length)+'</td>'+
        '<td>'+(a.meteringConnected?'<span class="tr-meter"><span class="d on"></span>Live</span>':'<span class="tr-meter"><span class="d off"></span>Pending</span>')+'</td>'+
        '<td>'+statusPill(a.status)+'</td>';
      tb.appendChild(tr);
    });
    t.appendChild(tb); return t;
  }

  /* =====================================================================
     OPERATOR · API CONNECTORS
     ===================================================================== */
  function viewConnectors(){
    var wrap=el('div');
    var head=el('div','page-head');
    head.innerHTML='<div><h1>API Connectors</h1><p class="ph-sub">Backend integrations powering the exchange. Molecule provides metering &amp; dispatch; Lightsmith drives marketplace matching &amp; VPP. Configure the connection each operator owns.</p></div>';
    wrap.appendChild(head);
    var defaults=[
      {key:'molecule',name:'Molecule Systems',sub:'Metering, dispatch & settlement API',owner:'molecule',icon:'M'},
      {key:'lightsmith',name:'Lightsmith Energy',sub:'Marketplace matching & VPP (Flowsmith)',owner:'lightsmith',icon:'L'},
      {key:'omega',name:'OMEGA Platform',sub:'ClearSky orchestration & VDC proposals',owner:'clearsky',icon:'Ω'},
      {key:'voltus',name:'Voltus / CPower',sub:'VPP aggregation (optional)',owner:'clearsky',icon:'V'}
    ];
    var byKey={}; S.connectors.forEach(function(c){ byKey[c.key]=c; });
    var panel=el('div','panel'); panel.innerHTML='<h3>Registered Connectors</h3>';
    defaults.forEach(function(d){
      var c=byKey[d.key]||{}; var connected=!!c.connected; var canEdit=(S.org===d.owner)||(S.org==='clearsky');
      var rowEl=el('div','conn-row');
      var status=connected?'<span class="conn-dot"><span class="dot dot-on"></span>Connected</span>':(c.error?'<span class="conn-dot"><span class="dot dot-err"></span>Error</span>':'<span class="conn-dot"><span class="dot dot-off"></span>Not connected</span>');
      rowEl.innerHTML='<div class="conn-left"><div class="conn-ic">'+d.icon+'</div><div><div class="conn-name">'+esc(d.name)+'</div><div class="conn-sub">'+esc(d.sub)+' · owner: '+orgLabel(d.owner)+'</div></div></div><div style="display:flex;align-items:center;gap:14px;">'+status+'</div>';
      var btn=el('button','btn btn-ghost btn-sm',canEdit?(connected?'Manage':'Configure'):'View'); btn.style.marginLeft='12px';
      btn.onclick=function(){ openConnectorModal(d,c,canEdit); };
      rowEl.querySelector('div:last-child').appendChild(btn); panel.appendChild(rowEl);
    });
    wrap.appendChild(panel);
    wrap.appendChild(elFrom('<div class="info-note">Credentials live in the shared <code>vdc_connectors</code> collection. ClearSky admins all; Molecule and Lightsmith manage their own. Live calls run through the integration layer (MoleculeAPI / LightsmithAPI) — swap stubs for production endpoints.</div>'));
    return wrap;
  }
  function openConnectorModal(d,c,canEdit){
    var m=$('modalEl');
    m.innerHTML='<h2>'+esc(d.name)+' connector</h2><p class="msub">'+esc(d.sub)+'. Owner: '+orgLabel(d.owner)+'.</p>'+
      fld('API base URL','cc_url',c.apiUrl,'https://api…')+
      sel('Auth method','cc_auth',[['apikey','API Key'],['oauth','OAuth 2.0'],['mtls','mTLS']],c.authMethod)+
      fld('Key / Client ID','cc_key',c.publicKey,'')+
      fld('Environment','cc_env',c.env||'production','production / sandbox')+
      chk('Mark connector as connected','cc_conn',c.connected)+
      '<div class="info-note" style="margin-top:12px;">Secrets are not stored in plaintext in production — wire to your secrets manager. This records connection state + public config for the shared operator view.</div>'+
      '<div class="modal-foot"><button class="btn btn-ghost" id="cc_cancel">Close</button>'+(canEdit?'<button class="btn btn-primary" id="cc_save">Save connector</button>':'')+'</div>';
    openModal(); $('cc_cancel').onclick=closeModal;
    if(canEdit){ $('cc_save').onclick=function(){
      var data={ key:d.key,name:d.name,owner:d.owner,apiUrl:$('cc_url').value.trim(),authMethod:$('cc_auth').value,
        publicKey:$('cc_key').value.trim(),env:$('cc_env').value.trim(),connected:$('cc_conn').checked,updatedBy:S.profile.email,updatedMs:nowMs() };
      db.collection(COL.connectors).doc(d.key).set(data,{merge:true}).then(function(){ closeModal(); toast(d.name+' connector saved.'); })
        .catch(function(e){ toast('Save failed: '+(e.message||e.code),true); });
    }; }
  }

  /* =====================================================================
     INTEGRATION LAYER — Molecule / Lightsmith seams
     ===================================================================== */
  var MoleculeAPI = {
    register: function(asset,payload){ return new Promise(function(resolve){ setTimeout(function(){ resolve({ connectorId:'mol_'+asset.id.slice(0,10) }); },400); }); },
    telemetry: function(siteId){ return Promise.resolve(null); }
  };
  var LightsmithAPI = {
    route: function(rfqId,rfq){ return Promise.resolve({ok:true}); },   // route an RFQ to matching assets
    match: function(rfqId,quote){ return Promise.resolve({ok:true}); }  // confirm a locked match
  };

  function logEvent(assetId,type,value,rfqId){
    db.collection(COL.events).add({ assetId:assetId||null, rfqId:rfqId||null, type:type, value:value,
      byUid:S.user.uid, byEmail:S.profile.email, byOrg:S.org||S.profile.org, ms:nowMs(), at:ts() }).catch(function(){});
  }

  /* =====================================================================
     UI BUILDERS
     ===================================================================== */
  function kpi(k,v,d){ var e=el('div','kpi'); e.innerHTML='<div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div><div class="d">'+esc(d||'')+'</div>'; return e; }
  function kvList(rows){ var h='<div class="kv-list">'; rows.forEach(function(r){ h+='<div class="kv-row"><span class="kv-k">'+esc(r[0])+'</span><span class="kv-v">'+esc(r[1])+'</span></div>'; }); return h+'</div>'; }
  function panelKV(title,rows){ var p=el('div','panel'); p.innerHTML='<h3>'+esc(title)+'</h3>'+kvList(rows); return p; }
  function emptyState(title,body,btnLabel,onClick){
    var e=el('div','empty');
    e.innerHTML='<div class="e-ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></div><h3>'+esc(title)+'</h3><p>'+esc(body)+'</p>';
    if(btnLabel){ var b=el('button','btn btn-primary',esc(btnLabel)); b.onclick=onClick; e.appendChild(b); }
    return e;
  }
  function fld(label,id,val,ph,type){ return '<div class="field"><label>'+esc(label)+'</label><input type="'+(type||'text')+'" id="'+id+'" value="'+esc(val==null?'':val)+'" placeholder="'+esc(ph||'')+'"></div>'; }
  function fld2(label,id,val,ph,type){ return fld(label,id,val,ph,type); }
  function fldArea(label,id,val,ph){ return '<div class="field"><label>'+esc(label)+'</label><textarea id="'+id+'" placeholder="'+esc(ph||'')+'">'+esc(val==null?'':val)+'</textarea></div>'; }
  function sel(label,id,opts,val){
    var h='<div class="field"><label>'+esc(label)+'</label><select id="'+id+'"><option value="">Select…</option>';
    opts.forEach(function(o){ h+='<option value="'+esc(o[0])+'"'+(String(val)===String(o[0])?' selected':'')+'>'+esc(o[1])+'</option>'; });
    return h+'</select></div>';
  }
  function sel2(label,id,opts,val){ // compact, no "select..." blank
    var h='<div class="field"><label>'+esc(label)+'</label><select id="'+id+'">';
    opts.forEach(function(o){ h+='<option value="'+esc(o[0])+'"'+(String(val)===String(o[0])?' selected':'')+'>'+esc(o[1])+'</option>'; });
    return h+'</select></div>';
  }
  function chk(label,id,val){ return '<div class="field" style="display:flex;align-items:center;gap:9px;"><input type="checkbox" id="'+id+'"'+(val?' checked':'')+' style="width:16px;height:16px;accent-color:var(--cs-blue);"><label style="margin:0;">'+esc(label)+'</label></div>'; }
  function row(a,b){ return '<div class="field-row">'+a+b+'</div>'; }
  function elFrom(html){ var d=document.createElement('div'); d.innerHTML=html; return d.firstChild; }
  function assetTypeLabel(t){ return t==='gpu'?'GPU Cluster':t==='hpc'?'HPC':t==='crypto'?'Crypto/ASIC':t==='mixed'?'Mixed Compute':t==='colo'?'Colocation':'Data Asset'; }

  function openModal(){ $('modalBackdrop').className='modal-backdrop show'; $('modalEl').scrollTop=0; }
  function closeModal(){ $('modalBackdrop').className='modal-backdrop'; }
  $('modalBackdrop').addEventListener('click',function(e){ if(e.target===$('modalBackdrop'))closeModal(); });

  wireAuth();
})();
