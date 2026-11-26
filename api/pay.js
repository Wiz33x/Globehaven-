// Paiement + e-mails : une seule fonction pour /api/pay
const U=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_KEY,CUR=process.env.CURRENCY||"EUR";
const H=String(K).startsWith("sb_")?{apikey:K,"Content-Type":"application/json"}:{apikey:K,Authorization:"Bearer "+K,"Content-Type":"application/json"};
const esc=t=>String(t==null?"":t).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const db=async(p,o={})=>{const r=await fetch(U+"/rest/v1/"+p,{headers:H,...o});if(!r.ok)throw new Error(await r.text());const t=await r.text();return t?JSON.parse(t):null};
const getB=async id=>(await db("bookings?id=eq."+encodeURIComponent(id)+"&select=*,listings(*)"))[0];
const patch=(id,b)=>db("bookings?id=eq."+encodeURIComponent(id),{method:"PATCH",headers:{...H,Prefer:"return=minimal"},body:JSON.stringify(b)});
const emailOf=async id=>{const r=await fetch(U+"/auth/v1/admin/users/"+id,{headers:H});return r.ok?(await r.json()).email:null};
const mail=async(to,subject,html)=>{if(!process.env.RESEND_API_KEY||!to)return;
await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+process.env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:process.env.MAIL_FROM||"GLOBEHAVEN <onboarding@resend.dev>",to:[to],subject,html})})};
const notify=async b=>{const l=b.listings,[o,g]=await Promise.all([emailOf(l.owner),emailOf(b.user_id)]);
const info=esc(l.name)+" · "+esc(l.city)+", "+esc(l.country)+"<br>Du "+b.start_date+" au "+b.end_date+" · "+b.total+" €";
await mail(o,"Nouvelle réservation : "+l.name,"<p>Vous avez une nouvelle réservation.</p><p>"+info+"</p><p>Client : "+esc(g)+"</p>");
await mail(g,"Votre réservation GLOBEHAVEN","<p>Votre réservation est enregistrée.</p><p>"+info+"</p>")};

async function checkout(req,res){
const t=(req.headers.authorization||"").replace("Bearer ","");
const ur=await fetch(U+"/auth/v1/user",{headers:{apikey:K,Authorization:"Bearer "+t}});
if(!ur.ok)return res.status(401).json({error:"Connexion requise."});const u=await ur.json();
const b=await getB((req.body||{}).booking_id);
if(!b||b.user_id!==u.id)return res.status(404).json({error:"Réservation introuvable."});
if(b.status!=="pending")return res.json({url:null});
const n=Math.round((new Date(b.end_date)-new Date(b.start_date))/864e5);
if(!(n>0))return res.status(400).json({error:"Dates invalides."});
b.total=n*Number(b.listings.price);
if(!process.env.FLW_SECRET_KEY){await patch(b.id,{status:"confirmed",total:b.total});await notify(b);return res.json({url:null})}
await patch(b.id,{total:b.total});
const r=await fetch("https://api.flutterwave.com/v3/payments",{method:"POST",headers:{Authorization:"Bearer "+process.env.FLW_SECRET_KEY,"Content-Type":"application/json"},
body:JSON.stringify({tx_ref:b.id+"_"+Date.now(),amount:b.total,currency:CUR,redirect_url:(process.env.SITE_URL||"")+"/",customer:{email:u.email},customizations:{title:"GLOBEHAVEN",description:b.listings.name}})});
const j=await r.json();
if(j.status!=="success")return res.status(502).json({error:"Paiement indisponible : "+(j.message||"")});
res.json({url:j.data.link})}

async function hook(req,res){
if(!process.env.FLW_WEBHOOK_HASH||req.headers["verif-hash"]!==process.env.FLW_WEBHOOK_HASH)return res.status(401).end();
const d=((req.body||{}).data)||{};if(!d.id)return res.status(200).end();
const v=await fetch("https://api.flutterwave.com/v3/transactions/"+encodeURIComponent(d.id)+"/verify",{headers:{Authorization:"Bearer "+process.env.FLW_SECRET_KEY}});
const j=await v.json(),x=j.data;
if(j.status!=="success"||!x||x.status!=="successful")return res.status(200).end();
const b=await getB(String(x.tx_ref).split("_")[0]);
if(!b||b.status==="paid"||Number(x.amount)<Number(b.total)||x.currency!==CUR)return res.status(200).end();
await patch(b.id,{status:"paid",tx_ref:x.tx_ref});await notify(b);res.status(200).end()}

module.exports=async(req,res)=>{try{
if(req.method!=="POST")return res.status(405).json({error:"Méthode non autorisée."});
return req.headers["verif-hash"]?await hook(req,res):await checkout(req,res)}
catch(e){res.status(500).json({error:"Erreur serveur."})}};
