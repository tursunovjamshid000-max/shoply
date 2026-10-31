'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT || 10000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = 'shoply_data';
const ROOT = __dirname;
const ALLOWED = new Set([
  'mono_store_products_v2','mono_store_settings_v2','mono_store_slides_v2',
  'mono_store_cart_events_v1','shoply_orders_v1','shoply_reviews_v1',
  'mono_store_admin_profile_v1','shoply_site_builder_v1','shoply_promo_codes_v1'
]);
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};
function send(res,status,data,type='application/json; charset=utf-8') { res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(type.startsWith('application/json')?JSON.stringify(data):data); }
function readBody(req){return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>{raw+=c;if(raw.length>8*1024*1024){reject(new Error('Body too large'));req.destroy();}});req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});}
async function dbRequest(method, query='', body){
  if(!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase environment variables are missing');
  const response=await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}${query}`,{method,headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok){const detail=await response.text();throw new Error(`Supabase ${response.status}: ${detail.slice(0,300)}`);}
  if(response.status===204)return null;
  const text=await response.text();return text?JSON.parse(text):null;
}
async function getAll(){const rows=await dbRequest('GET','?select=key,value');const out={};for(const row of rows||[])if(ALLOWED.has(row.key))out[row.key]=row.value;return out;}
async function getOne(key){const rows=await dbRequest('GET',`?key=eq.${encodeURIComponent(key)}&select=value`);return rows&&rows.length?{exists:true,value:rows[0].value}:{exists:false,value:null};}
async function putOne(key,value){await dbRequest('POST','', [{key,value,updated_at:new Date().toISOString()}]);}
async function updateOrders(fn){const current=await getOne('shoply_orders_v1');const list=Array.isArray(current.value)?current.value:[];const next=fn(list);await putOne('shoply_orders_v1',next);return next;}
http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`); const p=u.pathname;
  try{
    if(p==='/api/health'&&req.method==='GET')return send(res,200,{ok:true,database:SUPABASE_URL&&SUPABASE_KEY?'configured':'missing'});
    if(p==='/api/admin/login'&&req.method==='POST'){
      const b=await readBody(req);const login=process.env.ADMIN_LOGIN||'shoply';const password=process.env.ADMIN_PASSWORD||'24001214';
      return send(res,200,{ok:String(b.login||'').trim()===login && String(b.password||'')===password});
    }
    if((p==='/api/state'||p==='/api/admin/state')&&req.method==='GET'){
      if(!SUPABASE_URL||!SUPABASE_KEY)return send(res,503,{error:'Supabase sozlanmagan'});
      return send(res,200,await getAll());
    }
    if(p.startsWith('/api/state/')){
      const key=decodeURIComponent(p.slice('/api/state/'.length));if(!ALLOWED.has(key))return send(res,400,{error:'Unknown key'});
      if(req.method==='GET'){const item=await getOne(key);return item.exists?send(res,200,{key,value:item.value}):send(res,404,{error:'Not found'});}
      if(req.method==='PUT'){const b=await readBody(req);if(!Object.prototype.hasOwnProperty.call(b,'value'))return send(res,400,{error:'Missing value'});await putOne(key,b.value);return send(res,200,{ok:true,key});}
      // No DELETE endpoint: protects stored catalog/orders/settings from accidental clearing.
      if(req.method==='DELETE')return send(res,405,{error:'Persistent records cannot be deleted through this endpoint. Save an updated value instead.'});
      return send(res,405,{error:'Method not allowed'});
    }
    if(p==='/api/orders'&&req.method==='GET'){const x=await getOne('shoply_orders_v1');return send(res,200,Array.isArray(x.value)?x.value:[]);}
    if(p==='/api/orders'&&req.method==='POST'){
      const b=await readBody(req);if(!b.name||!b.phone||!Array.isArray(b.items)||!b.items.length)return send(res,400,{error:'Order needs name, phone and items'});
      const order={...b,id:b.id||`ORD-${Date.now()}`,createdAt:b.createdAt||new Date().toISOString(),status:b.status||'Yangi'};
      await updateOrders(list=>[order,...list].slice(0,10000));return send(res,201,{ok:true,id:order.id});
    }
    if(p.startsWith('/api/orders/')&&req.method==='PATCH'){
      const id=decodeURIComponent(p.slice('/api/orders/'.length));const b=await readBody(req);let found=false;
      const list=await updateOrders(items=>items.map(o=>{if(String(o.id)===id){found=true;return {...o,status:String(b.status||o.status||'Yangi').slice(0,60)}}return o;}));
      const order=list.find(o=>String(o.id)===id);return found?send(res,200,{ok:true,order}):send(res,404,{error:'Order not found'});
    }
    if(p==='/api/reviews'&&req.method==='POST'){
      const b=await readBody(req);const id=String(b.productId||'');if(!id||!b.review)return send(res,400,{error:'Invalid review'});
      const item=await getOne('shoply_reviews_v1');const all=item.value&&typeof item.value==='object'?item.value:{};const rows=Array.isArray(all[id])?all[id]:[];all[id]=[...rows,b.review];await putOne('shoply_reviews_v1',all);return send(res,201,{ok:true});
    }
    let filePath=decodeURIComponent(p);if(filePath==='/')filePath='/index.html';const file=path.resolve(ROOT,'.'+filePath);
    if(!file.startsWith(ROOT+path.sep))return send(res,403,{error:'Forbidden'});
    fs.readFile(file,(err,buffer)=>{if(err)return send(res,404,'Not found','text/plain; charset=utf-8');send(res,200,buffer,mime[path.extname(file).toLowerCase()]||'application/octet-stream');});
  }catch(error){console.error(error);send(res,500,{error:'Server error',message:process.env.NODE_ENV==='production'?'Ma’lumotlar bazasi bilan aloqa xatosi':error.message});}
}).listen(PORT,'0.0.0.0',()=>console.log(`SHOPLY server ${PORT} portda ishga tushdi`));
