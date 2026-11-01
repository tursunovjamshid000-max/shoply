'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const PORT = Number(process.env.PORT || 10000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = 'shoply_data';
const ROOT = __dirname;
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'SHOPLY-CHANGE-THIS-SESSION-SECRET';
const loginAttempts = new Map();
const emailOtps = new Map();
const verifiedEmailTokens = new Map();
const emailSendAttempts = new Map();
const emailIpAttempts = new Map();
const nasiyaLoginAttempts = new Map();
const reminderSent = new Set();
function hasNasiyaSession(req){try{const raw=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('shoply_nasiya='));if(!raw)return false;const token=decodeURIComponent(raw.slice('shoply_nasiya='.length));const [stamp,sig]=token.split('.');if(!stamp||!sig||Date.now()-Number(stamp)>8*60*60*1000)return false;const expected=crypto.createHmac('sha256',process.env.NASIYA_SESSION_SECRET||SESSION_SECRET).update(stamp).digest('hex');return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected));}catch{return false}}
function signNasiyaSession(stamp){return crypto.createHmac('sha256',process.env.NASIYA_SESSION_SECRET||SESSION_SECRET).update(stamp).digest('hex')}
function phoneDigits(value){return String(value||'').replace(/\D/g,'')}
async function sendEskizSms(phone,message){if(!process.env.ESKIZ_EMAIL||!process.env.ESKIZ_PASSWORD||!process.env.ESKIZ_FROM)throw new Error('SMS xizmati sozlanmagan');let token=process.env.ESKIZ_TOKEN||'';if(!token){const a=await fetch('https://notify.eskiz.uz/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:process.env.ESKIZ_EMAIL,password:process.env.ESKIZ_PASSWORD})});const ad=await a.json();if(!a.ok||!ad.data?.token)throw new Error('Eskiz autentifikatsiyasi muvaffaqiyatsiz');token=ad.data.token;}const r=await fetch('https://notify.eskiz.uz/api/message/sms/send',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:new URLSearchParams({mobile_phone:phoneDigits(phone),message,from:process.env.ESKIZ_FROM})});const d=await r.json();if(!r.ok)throw new Error('SMS yuborilmadi');return d;}
function makeSchedule(price,weeks){const n=Number(weeks);const total=Math.max(0,Number(price)||0);return Array.from({length:n},(_,i)=>({number:i+1,amount:i===n-1?total-Math.floor(total/n)*(n-1):Math.floor(total/n),dueAt:new Date(Date.now()+(i+1)*7*86400000).toISOString(),paid:false}));}
function normalizeEmail(value){return String(value||'').trim().toLowerCase().slice(0,254)}
function validEmail(value){return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)}
function smtpReady(){return Boolean(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS&&process.env.SMTP_FROM)}
function signSession(value){return crypto.createHmac('sha256',SESSION_SECRET).update(value).digest('hex')}
function hasAdminSession(req){try{const raw=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('shoply_admin='));if(!raw)return false;const token=decodeURIComponent(raw.slice('shoply_admin='.length));const [stamp,sig]=token.split('.');if(!stamp||!sig||Date.now()-Number(stamp)>12*60*60*1000)return false;return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(signSession(stamp)))}catch{return false}}
async function getInstallmentRequests(){const item=await getOne('shoply_installment_requests_v1');return Array.isArray(item.value)?item.value:[]}
async function saveInstallmentRequests(rows){await putOne('shoply_installment_requests_v1',rows.slice(0,2000))}

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
    if(p==='/api/health'&&req.method==='GET')return send(res,200,{ok:true,database:SUPABASE_URL&&SUPABASE_KEY?'configured':'missing',emailVerification:smtpReady()?'configured':'not_configured'});
    if(p==='/api/admin/login'&&req.method==='POST'){
      const b=await readBody(req);const login=process.env.ADMIN_LOGIN||'shoply';const password=process.env.ADMIN_PASSWORD||'24001214';
      const ip=String(req.socket.remoteAddress||'unknown');const now=Date.now();const prev=loginAttempts.get(ip)||{count:0,at:now};if(now-prev.at>10*60*1000){prev.count=0;prev.at=now}if(prev.count>=10)return send(res,429,{ok:false,error:'Too many attempts'});
      const ok=String(b.login||'').trim()===login && String(b.password||'')===password; if(!ok){prev.count++;loginAttempts.set(ip,prev);return send(res,200,{ok:false})}loginAttempts.delete(ip);
      const stamp=String(Date.now()),token=stamp+'.'+signSession(stamp);res.setHeader('Set-Cookie',`shoply_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV==='production'?'; Secure':''}`);
      return send(res,200,{ok:true});
    }
    if(p==='/api/installment-email/send'&&req.method==='POST'){
      const b=await readBody(req),email=normalizeEmail(b.email),now=Date.now(),ip=String(req.socket.remoteAddress||'unknown');
      const ipState=emailIpAttempts.get(ip)||{count:0,startedAt:now};if(now-ipState.startedAt>15*60_000){ipState.count=0;ipState.startedAt=now}if(ipState.count>=5)return send(res,429,{ok:false,error:'Juda ko‘p kod so‘raldi. 15 daqiqadan keyin urinib ko‘ring.'});
      if(!validEmail(email))return send(res,400,{ok:false,error:'Email manzilini to‘g‘ri kiriting.'});
      if(!smtpReady())return send(res,503,{ok:false,error:'Email tasdiqlash hali sozlanmagan. Admin SMTP xizmatini ulashi kerak.'});
      const last=emailSendAttempts.get(email)||0;if(now-last<60_000)return send(res,429,{ok:false,error:'Yangi kodni 1 daqiqadan keyin so‘rang.'});
      ipState.count++;emailIpAttempts.set(ip,ipState);
      const code=String(crypto.randomInt(100000,1000000));const codeHash=crypto.createHash('sha256').update(code).digest('hex');
      emailOtps.set(email,{codeHash,expiresAt:now+10*60_000,attempts:0});emailSendAttempts.set(email,now);
      try{
        const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE||'false')==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
        await transporter.sendMail({from:process.env.SMTP_FROM,to:email,subject:'SHOPLY email tasdiqlash kodi',text:`SHOPLY arizangiz uchun tasdiqlash kodi: ${code}. Kod 10 daqiqa amal qiladi. Agar bu siz bo‘lmasangiz, xabarni e’tiborsiz qoldiring.`,html:`<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px"><h2>SHOPLY</h2><p>Email manzilingizni tasdiqlash kodi:</p><div style="font-size:32px;font-weight:800;letter-spacing:8px;padding:16px;background:#f4f4f5;border-radius:12px;text-align:center">${code}</div><p>Kod 10 daqiqa amal qiladi. Uni hech kimga bermang.</p></div>`});
        return send(res,200,{ok:true,message:'Tasdiqlash kodi emailingizga yuborildi.'});
      }catch(err){emailOtps.delete(email);return send(res,502,{ok:false,error:'Email yuborilmadi. SMTP sozlamalarini tekshiring.'});}
    }
    if(p==='/api/installment-email/verify'&&req.method==='POST'){
      const b=await readBody(req),email=normalizeEmail(b.email),code=String(b.code||'').trim(),entry=emailOtps.get(email);
      if(!entry||Date.now()>entry.expiresAt)return send(res,400,{ok:false,error:'Kod topilmadi yoki muddati tugagan. Yangi kod so‘rang.'});
      if(!/^\d{6}$/.test(code)||entry.attempts>=5){emailOtps.delete(email);return send(res,429,{ok:false,error:'Urinishlar tugadi. Yangi kod so‘rang.'});}
      const supplied=crypto.createHash('sha256').update(code).digest('hex');entry.attempts++;
      if(!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(entry.codeHash)))return send(res,400,{ok:false,error:'Tasdiqlash kodi noto‘g‘ri.'});
      emailOtps.delete(email);const token=crypto.randomBytes(32).toString('hex');verifiedEmailTokens.set(token,{email,expiresAt:Date.now()+20*60_000});
      return send(res,200,{ok:true,verificationToken:token,message:'Email tasdiqlandi.'});
    }
    if(p==='/api/installment-requests'&&req.method==='POST'){
      const b=await readBody(req);const name=String(b.name||'').trim().slice(0,100),phone=String(b.phone||'').trim().slice(0,20),email=normalizeEmail(b.email),address=String(b.address||'').trim().slice(0,300),productName=String(b.productName||'').trim().slice(0,120),weeks=Number(b.weeks),price=Number(b.price),weeklyEstimate=Number(b.weeklyEstimate);
      if(name.length<3||!/^[+]?([0-9 ()-]){9,20}$/.test(phone)||!validEmail(email)||address.length<8||!productName||![2,3].includes(weeks)||!Number.isFinite(price)||price<0||!Number.isFinite(weeklyEstimate))return send(res,400,{error:'Ariza ma’lumotlari noto‘g‘ri'});
      const accessToken=crypto.randomBytes(32).toString('hex');
      const selfie=String(b.selfieDataUrl||'');if(selfie && (!/^data:image\/(jpeg|png|webp);base64,/.test(selfie)||selfie.length>700000))return send(res,400,{error:'Rasm hajmi yoki formati noto‘g‘ri (JPEG/PNG/WEBP, 500 KB gacha).'});
      const rows=await getInstallmentRequests();const item={id:'NSY-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex'),name,phone,email,emailVerified:true,address,location:{lat:Number.isFinite(Number(b.lat))?Number(b.lat):null,lng:Number.isFinite(Number(b.lng))?Number(b.lng):null},selfieDataUrl:selfie||'',telegram:{id:String(b.telegramId||'').slice(0,40),firstName:String(b.telegramFirstName||'').slice(0,80),username:String(b.telegramUsername||'').slice(0,80),verified:false},productId:String(b.productId||'').slice(0,80),productName,price,originalPrice:Number(b.originalPrice)||Math.max(0,price-5000),serviceFee:5000,weeks,weeklyEstimate,status:'Yangi ariza',createdAt:new Date().toISOString(),channel:String(b.channel||'Web').slice(0,30),schedule:[],accessTokenHash:crypto.createHash('sha256').update(accessToken).digest('hex'),notifications:[]};
      await saveInstallmentRequests([item,...rows]);return send(res,201,{ok:true,id:item.id,accessToken});
    }
    if(p==='/api/my/installments'&&req.method==='GET'){
      const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(token.length<32)return send(res,401,{error:'Kirish tokeni topilmadi'});const hash=crypto.createHash('sha256').update(token).digest('hex');const rows=await getInstallmentRequests();const mine=rows.filter(x=>x.accessTokenHash===hash).map(({accessTokenHash,selfieDataUrl,...x})=>x);return send(res,200,mine);
    }
    if(p==='/api/admin/nasiya-login'&&req.method==='POST'){
      const b=await readBody(req),ip=String(req.socket.remoteAddress||'unknown'),now=Date.now(),prev=nasiyaLoginAttempts.get(ip)||{count:0,at:now};if(now-prev.at>15*60_000){prev.count=0;prev.at=now}if(prev.count>=5)return send(res,429,{ok:false,error:'Urinishlar ko‘p. 15 daqiqadan keyin urinib ko‘ring.'});const expected=process.env.INSTALLMENT_ADMIN_PASSWORD||'';if(!expected){return send(res,503,{ok:false,error:'INSTALLMENT_ADMIN_PASSWORD serverda sozlanmagan.'})}if(String(b.password||'')!==expected){prev.count++;nasiyaLoginAttempts.set(ip,prev);return send(res,401,{ok:false,error:'Parol noto‘g‘ri'})}nasiyaLoginAttempts.delete(ip);const stamp=String(Date.now()),sig=signNasiyaSession(stamp);res.setHeader('Set-Cookie',`shoply_nasiya=${encodeURIComponent(stamp+'.'+sig)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV==='production'?'; Secure':''}`);return send(res,200,{ok:true});
    }
    if(p==='/api/admin/nasiya-logout'&&req.method==='POST'){res.setHeader('Set-Cookie','shoply_nasiya=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(res,200,{ok:true})}
    if(p==='/api/admin/nasiya-requests'&&req.method==='GET'){if(!hasNasiyaSession(req))return send(res,401,{error:'Nasiya paroli talab qilinadi'});const rows=await getInstallmentRequests();return send(res,200,rows.map(({accessTokenHash,...x})=>x));}
    if(p.startsWith('/api/admin/nasiya-requests/')&&req.method==='PATCH'){if(!hasNasiyaSession(req))return send(res,401,{error:'Nasiya paroli talab qilinadi'});const id=decodeURIComponent(p.slice('/api/admin/nasiya-requests/'.length));const b=await readBody(req);const allowed=['Yangi ariza','Ko‘rib chiqilmoqda','Tasdiqlandi','Rad etildi','To‘lovda','Yopildi'];if(!allowed.includes(String(b.status)))return send(res,400,{error:'Holat noto‘g‘ri'});const rows=await getInstallmentRequests();let found=false;const next=rows.map(x=>{if(x.id===id){found=true;const updated={...x,status:b.status,updatedAt:new Date().toISOString()};if(b.status==='Tasdiqlandi'&&!Array.isArray(x.schedule||[]))updated.schedule=makeSchedule(x.price,x.weeks);if(b.status==='Tasdiqlandi'&&!(x.schedule||[]).length)updated.schedule=makeSchedule(x.price,x.weeks);return updated}return x});if(!found)return send(res,404,{error:'Ariza topilmadi'});await saveInstallmentRequests(next);return send(res,200,{ok:true});}
    if(p.startsWith('/api/admin/nasiya-sms/')&&req.method==='POST'){if(!hasNasiyaSession(req))return send(res,401,{error:'Nasiya paroli talab qilinadi'});const id=decodeURIComponent(p.slice('/api/admin/nasiya-sms/'.length));const rows=await getInstallmentRequests();const item=rows.find(x=>x.id===id);if(!item)return send(res,404,{error:'Ariza topilmadi'});const b=await readBody(req);const message=String(b.message||'').trim().slice(0,500);if(message.length<5)return send(res,400,{error:'SMS matni kiriting'});const result=await sendEskizSms(item.phone,message);item.notifications=[...(item.notifications||[]),{type:'sms',at:new Date().toISOString(),message:message.slice(0,160)}].slice(-30);await saveInstallmentRequests(rows);return send(res,200,{ok:true,result});}
    if(p==='/api/admin/installment-requests'&&req.method==='GET'){
      if(!hasAdminSession(req))return send(res,401,{error:'Admin login talab qilinadi'});return send(res,200,await getInstallmentRequests());
    }
    if(p.startsWith('/api/admin/installment-requests/')&&req.method==='PATCH'){
      if(!hasAdminSession(req))return send(res,401,{error:'Admin login talab qilinadi'});const id=decodeURIComponent(p.slice('/api/admin/installment-requests/'.length));const b=await readBody(req);const allowed=['Yangi ariza','Ko‘rib chiqilmoqda','Qo‘shimcha ma’lumot kerak','Yopildi','Rad etildi'];if(!allowed.includes(String(b.status)))return send(res,400,{error:'Invalid status'});const rows=await getInstallmentRequests();let found=false;const next=rows.map(x=>{if(x.id===id){found=true;return {...x,status:b.status,updatedAt:new Date().toISOString()}}return x});if(!found)return send(res,404,{error:'Not found'});await saveInstallmentRequests(next);return send(res,200,{ok:true});
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
async function runNasiyaEmailReminders(){if(!smtpReady())return;try{const rows=await getInstallmentRequests();let changed=false;const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE||'false')==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});for(const item of rows){if(item.status!=='Tasdiqlandi'||!item.email||!Array.isArray(item.schedule))continue;for(const due of item.schedule){if(due.paid)continue;const diff=new Date(due.dueAt).getTime()-Date.now();const kind=diff<0?'overdue':diff<=24*3600000?'soon':'';if(!kind)continue;const key=`${item.id}:${due.number}:${kind}:${new Date().toISOString().slice(0,10)}`;if(reminderSent.has(key))continue;await transporter.sendMail({from:process.env.SMTP_FROM,to:item.email,subject:kind==='soon'?'SHOPLY — to‘lov muddati yaqin':'SHOPLY — to‘lov muddati o‘tgan',text:`Assalomu alaykum, ${item.name}. ${item.productName} uchun ${due.amount} so‘m to‘lovi ${new Date(due.dueAt).toLocaleDateString('uz-UZ')} sanasida ${kind==='soon'?'to‘lanishi kerak.':'muddati o‘tgan.'} Savollaringiz bo‘lsa SHOPLY bilan bog‘laning.`});reminderSent.add(key);item.notifications=[...(item.notifications||[]),{type:'email',kind,at:new Date().toISOString(),dueNumber:due.number}].slice(-30);changed=true;}}if(changed)await saveInstallmentRequests(rows);}catch(e){console.error('Nasiya email reminder:',e.message)}}
setInterval(runNasiyaEmailReminders,10*60*1000);setTimeout(runNasiyaEmailReminders,15000);
