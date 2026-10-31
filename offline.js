/* SHOPLY offline mode: no backend/server required. Data is saved on this device/browser. */
(function(){
  const nativeFetch=window.fetch.bind(window);
  const read=(k,d)=>{try{const v=localStorage.getItem(k);return v===null?d:JSON.parse(v)}catch{return d}};
  const write=(k,v)=>{localStorage.setItem(k,JSON.stringify(v));};
  const json=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data,text:async()=>JSON.stringify(data)});
  const keys=['mono_store_products_v2','mono_store_settings_v2','mono_store_slides_v2','shoply_reviews_v1','mono_store_admin_profile_v1','shoply_site_builder_v1','mono_store_cart_events_v1','shoply_orders_v1'];
  window.fetch=async function(input,init={}){
    const url=typeof input==='string'?input:input.url;
    if(!url || !url.includes('/api/')) return nativeFetch(input,init);
    const path=url.split('?')[0], method=(init.method||'GET').toUpperCase();
    let body={}; try{body=init.body?JSON.parse(init.body):{}}catch{}
    if(path==='/api/admin/login'&&method==='POST'){
      const cfg=read('shoply_site_builder_v1',{});
      const enteredLogin=String(body.login||'').trim();
      const enteredPassword=String(body.password||'');
      // The original credentials remain as a recovery option if old saved settings are incorrect.
      const savedLogin=String(cfg.adminLogin||'shoply');
      const savedPassword=String(cfg.adminPassword||'2400');
      const matchesSaved=enteredLogin===savedLogin && enteredPassword===savedPassword;
      const matchesRecovery=enteredLogin==='shoply' && enteredPassword==='2400';
      return json({ok:matchesSaved||matchesRecovery},200);
    }
    if(path==='/api/state'&&method==='GET'){
      const out={}; keys.forEach(k=>{const v=read(k, k==='shoply_reviews_v1'||k==='shoply_site_builder_v1'||k==='mono_store_settings_v2'||k==='mono_store_admin_profile_v1'?{}:[]);out[k]=v});
      return json(out);
    }
    if(path==='/api/admin/state'&&method==='GET'){
      const out={}; keys.forEach(k=>out[k]=read(k,k==='shoply_reviews_v1'||k==='shoply_site_builder_v1'||k==='mono_store_settings_v2'||k==='mono_store_admin_profile_v1'?{}:[]));return json(out);
    }
    const m=path.match(/^\/api\/state\/([^/]+)$/);
    if(m){const key=decodeURIComponent(m[1]);if(method==='GET')return json({value:read(key, key==='shoply_reviews_v1'||key==='shoply_site_builder_v1'||key==='mono_store_settings_v2'?{}:[])});if(method==='PUT'){write(key,body.value);return json({ok:true})}if(method==='DELETE'){localStorage.removeItem(key);return json({ok:true})}}
    if(path==='/api/orders'&&method==='POST'){
      const orders=read('shoply_orders_v1',[]);const order={...body,id:'S'+Date.now(),status:'Yangi',createdAt:new Date().toLocaleString('uz-UZ')};orders.push(order);write('shoply_orders_v1',orders);return json({ok:true,id:order.id});
    }
    if(path==='/api/orders'&&method==='GET')return json(read('shoply_orders_v1',[]));
    if(path==='/api/reviews'&&method==='POST'){
      const all=read('shoply_reviews_v1',{}),id=String(body.productId||'');all[id]=Array.isArray(all[id])?all[id]:[];all[id].push(body.review||{});write('shoply_reviews_v1',all);return json({ok:true});
    }
    return json({ok:false,error:'Offline mode'},404);
  };
})();

/* Durable local backup: mirror SHOPLY records into IndexedDB as well as localStorage. */
(function(){
  const DB='shoply_local_backup_v1', STORE='records';
  const tracked=['mono_store_products_v2','mono_store_settings_v2','mono_store_slides_v2','shoply_reviews_v1','mono_store_admin_profile_v1','shoply_site_builder_v1','mono_store_cart_events_v1','shoply_orders_v1','shoply_cart_v1','shoply_favorites_v1','shoply_theme','shoply_profile_v1','shoply_promo_codes_v1','shoply_applied_promo_v1'];
  function openDB(){return new Promise((resolve,reject)=>{if(!('indexedDB' in window))return reject(Error('IndexedDB mavjud emas'));const req=indexedDB.open(DB,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE)};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
  let dbPromise=openDB().catch(()=>null);
  window.shoplyBackupWrite=async function(key,value){if(!tracked.includes(String(key)))return;try{const db=await dbPromise;if(!db)return;await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(String(value),String(key));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}catch(e){console.warn('SHOPLY zaxira nusxasi yozilmadi',e)}};
  window.shoplyBackupDelete=async function(key){try{const db=await dbPromise;if(!db)return;db.transaction(STORE,'readwrite').objectStore(STORE).delete(String(key))}catch(e){}};
  const originalSet=Storage.prototype.setItem, originalRemove=Storage.prototype.removeItem;
  Storage.prototype.setItem=function(key,value){originalSet.call(this,key,value);if(this===localStorage)window.shoplyBackupWrite(key,String(value))};
  Storage.prototype.removeItem=function(key){originalRemove.call(this,key);if(this===localStorage)window.shoplyBackupDelete(key)};
  window.shoplyOfflineReady=(async()=>{const db=await dbPromise;if(!db)return;await new Promise(resolve=>{const tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).getAllKeys();req.onsuccess=async()=>{const keys=req.result||[];for(const key of keys){if(localStorage.getItem(key)!==null)continue;const get=db.transaction(STORE,'readonly').objectStore(STORE).get(key);await new Promise(done=>{get.onsuccess=()=>{if(get.result!==undefined){try{originalSet.call(localStorage,key,get.result);window.dispatchEvent(new StorageEvent('storage',{key,newValue:get.result,storageArea:localStorage}))}catch(e){}}done()};get.onerror=done})}resolve()};req.onerror=resolve})})();
  window.shoplyOfflineReady.then(()=>tracked.forEach(k=>{const v=localStorage.getItem(k);if(v!==null)window.shoplyBackupWrite(k,v)}));
})();
