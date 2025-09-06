
import express from 'express';
import session from 'express-session';
import { Resend } from 'resend';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Store <no-reply@example.com>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';
const PAYPAL_ME = process.env.PAYPAL_ME || '';
const REVOLUT_ME = process.env.REVOLUT_ME || '';
const EUR_RATE = parseFloat(process.env.EUR_RATE) || 1.95583;

const paymentSettings = { paypal:{enabled:true,label:'PayPal',type:'link'}, revolut:{enabled:true,label:'Revolut',type:'link'}, cod:{enabled:true,label:'Наложен платеж',type:'offline'}};
const products = [ { id:'p1', title:'Магнит — Рила', price:9.99 }, { id:'p2', title:'Магнит — Черно море', price:8.49 }, { id:'p3', title:'Магнит — Пловдив', price:7.99 } ];
const orders = [];

app.use(express.urlencoded({ extended:true }));
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET || 'secret', resave:false, saveUninitialized:false }));
app.use(express.static('public'));

function formatBGN(n){return `${n.toFixed(2)} лв.`;}
function formatEUR(n){return `(${(n/EUR_RATE).toFixed(2)} €)`;}
function makeOrderNumber(){return `ORD-BG-${dayjs().format('YYYYMMDD-HHmmss')}`;}
function isAuthenticated(req){return req.session && req.session.admin;}
function requireAdmin(req,res,next){if(!isAuthenticated(req)) return res.redirect('/admin/login'); next();}
function visiblePaymentMethods(){return Object.entries(paymentSettings).filter(([,cfg])=>cfg.enabled).map(([key,cfg])=>({key,...cfg}));}

async function sendReceiptEmail(order){if(!resend) return; const itemsHtml = order.items.map(i=>`<li>${i.title} — ${i.qty} бр.</li>`).join(''); const html=`<h2>Разписка за поръчка ${order.number}</h2><p>Метод: ${order.method}</p><p>Сума: ${formatBGN(order.total)} ${formatEUR(order.total)}</p><ul>${itemsHtml}</ul>`; try{await resend.emails.send({from:EMAIL_FROM,to:order.email,subject:`Разписка: ${order.number}`,html});}catch(e){console.error('Resend error:',e?.message||e);}}

// --- Storefront ---
app.get('/', (req,res)=>{
  const items = products.map(p=>`<div><b>${p.title}</b> — ${formatBGN(p.price)} ${formatEUR(p.price)}</div>`).join('');
  res.send(`<h1>Магазин</h1>${items}<a href='/checkout'>Към поръчка</a>`);
});

// --- Checkout ---
app.get('/checkout', (req,res)=>{
  const methods = visiblePaymentMethods().map(m=>`<label><input type='radio' name='method' value='${m.key}' required/> ${m.label}</label>`).join('<br/>');
  const productOptions = products.map(p=>`<div x-data='{qty:0}'><label>${p.title} — ${formatBGN(p.price)} ${formatEUR(p.price)}</label><input type='number' min='0' x-model='qty' @input='$dispatch("update-cart")' data-price='${p.price}' name='qty_${p.id}' /> бр.</div>`).join('');
  res.send(`
    <head>
      <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body>
    <h2>Поръчка</h2>
    <form id='orderForm' method='post' action='/api/orders' x-data='{cart:[], total:0}' @update-cart.window="total=0; cart=[]; [...$el.querySelectorAll('input[type=number]')].forEach(i=>{const q=parseInt(i.value)||0;if(q>0) cart.push({id:i.name,qty:q,price:parseFloat(i.dataset.price)}); total+=q*parseFloat(i.dataset.price);}); $refs.itemsInput.value=JSON.stringify(cart); $refs.totalInput.value=total; $refs.totalSpan.textContent=total.toFixed(2)+' лв. ('+(total/${EUR_RATE}).toFixed(2)+' €)';">
      <input name='name' placeholder='Име' required/><br/>
      <input name='email' placeholder='Имейл' required/><br/>
      <input name='phone' placeholder='Телефон' required/><br/>
      <input name='city' placeholder='Град' required/><br/>
      <input name='address' placeholder='Адрес' required/><br/>
      <textarea name='note' placeholder='Бележка'></textarea><br/>
      ${productOptions}<br/>
      ${methods}<br/>
      <p>Обща сума: <span x-ref='totalSpan'>0.00 лв. (0.00 €)</span></p>
      <input type='hidden' name='items' x-ref='itemsInput' />
      <input type='hidden' name='total' x-ref='totalInput' />
      <button type='submit'>Поръчай</button>
    </form>
    </body>
  `);
});

// --- Orders ---
app.post('/api/orders', async(req,res)=>{
  try{
    const {name,email,phone,city,address,note,items,total,method}=req.body;
    const order={id:uuidv4(),number:makeOrderNumber(),name,email,phone,shipping:{city,address,note},items:JSON.parse(items),total:Number(total),method,status:method==='cod'?'awaiting_shipment':'pending',createdAt:new Date().toISOString()};
    orders.push(order);
    await sendReceiptEmail(order);
    if(method==='cod') res.redirect(`/waybill/${order.id}`); else res.send({ok:true,orderId:order.id});
  }catch(e){console.error(e); res.status(500).send({error:'Invalid order data'});}
});

// --- Waybill ---
app.get('/waybill/:orderId', requireAdmin, (req,res)=>{
  const order=orders.find(o=>o.id===req.params.orderId);
  if(!order) return res.status(404).send('Not found');
  const itemsList = order.items.map(i=>`<li>${i.title} — ${i.qty} бр.</li>`).join('');
  res.send(`<h2>Товарителница</h2><p>Поръчка: ${order.number}</p><p>Клиент: ${order.name}</p><p>Телефон: ${order.phone}</p><p>Адрес: ${order.shipping.city}, ${order.shipping.address}</p><p>Сума за събиране: ${formatBGN(order.total)} ${formatEUR(order.total)}</p><ul>${itemsList}</ul><textarea>${order.shipping.note||''}</textarea><br/><button onclick='window.print()'>Печат</button>`);
});

// --- Admin ---
app.get('/admin/login',(req,res)=>{res.send(`<form method='post' action='/admin/login'><input name='email' placeholder='Имейл'/><br/><input name='password' type='password' placeholder='Парола'/><br/><button>Вход</button></form>`);});
app.post('/admin/login',(req,res)=>{const{email,password}=req.body;if(email===ADMIN_EMAIL&&password===ADMIN_PASSWORD){req.session.admin=true;res.redirect('/admin');}else{res.send('Грешни данни');}});
app.get('/admin',requireAdmin,(req,res)=>{const list=orders.map(o=>`<li>${o.number} — ${o.method} — ${o.status} — ${formatBGN(o.total)} ${formatEUR(o.total)} ${o.method==='cod'?`<a href='/waybill/${o.id}'>Товарителница</a>`:''}</li>`).join('');res.send(`<h2>Поръчки</h2><ul>${list}</ul>`);});

app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
// --- Storefront ---
app.get('/', (req,res)=>{
  const items = products.map(p=>`<div><b>${p.title}</b> — ${formatBGN(p.price)} ${formatEUR(p.price)}</div>`).join('');
  res.send(`<h1>Магазин</h1>${items}<a href='/checkout'>Към поръчка</a>`);
});

// --- Checkout ---
app.get('/checkout', (req,res)=>{
  const methods = visiblePaymentMethods().map(m=>`<label><input type='radio' name='method' value='${m.key}' required/> ${m.label}</label>`).join('<br/>');
  const productOptions = products.map(p=>`<div x-data='{qty:0}'><label>${p.title} — ${formatBGN(p.price)} ${formatEUR(p.price)}</label><input type='number' min='0' x-model='qty' @input='$dispatch("update-cart")' data-price='${p.price}' name='qty_${p.id}' /> бр.</div>`).join('');
  res.send(`
    <head>
      <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body>
    <h2>Поръчка</h2>
    <form id='orderForm' method='post' action='/api/orders' x-data='{cart:[], total:0}' @update-cart.window="total=0; cart=[]; [...$el.querySelectorAll('input[type=number]')].forEach(i=>{const q=parseInt(i.value)||0;if(q>0) cart.push({id:i.name,qty:q,price:parseFloat(i.dataset.price)}); total+=q*parseFloat(i.dataset.price);}); $refs.itemsInput.value=JSON.stringify(cart); $refs.totalInput.value=total; $refs.totalSpan.textContent=total.toFixed(2)+' лв. ('+(total/${EUR_RATE}).toFixed(2)+' €)';">
      <input name='name' placeholder='Име' required/><br/>
      <input name='email' placeholder='Имейл' required/><br/>
      <input name='phone' placeholder='Телефон' required/><br/>
      <input name='city' placeholder='Град' required/><br/>
      <input name='address' placeholder='Адрес' required/><br/>
      <textarea name='note' placeholder='Бележка'></textarea><br/>
      ${productOptions}<br/>
      ${methods}<br/>
      <p>Обща сума: <span x-ref='totalSpan'>0.00 лв. (0.00 €)</span></p>
      <input type='hidden' name='items' x-ref='itemsInput' />
      <input type='hidden' name='total' x-ref='totalInput' />
      <button type='submit'>Поръчай</button>
    </form>
    </body>
  `);
});

// --- Orders ---
app.post('/api/orders', async(req,res)=>{
  try{
    const {name,email,phone,city,address,note,items,total,method}=req.body;
    const order={id:uuidv4(),number:makeOrderNumber(),name,email,phone,shipping:{city,address,note},items:JSON.parse(items),total:Number(total),method,status:method==='cod'?'awaiting_shipment':'pending',createdAt:new Date().toISOString()};
    orders.push(order);
    await sendReceiptEmail(order);
    if(method==='cod') res.redirect(`/waybill/${order.id}`); else res.send({ok:true,orderId:order.id});
  }catch(e){console.error(e); res.status(500).send({error:'Invalid order data'});}
});

// --- Waybill ---
app.get('/waybill/:orderId', requireAdmin, (req,res)=>{
  const order=orders.find(o=>o.id===req.params.orderId);
  if(!order) return res.status(404).send('Not found');
  const itemsList = order.items.map(i=>`<li>${i.title} — ${i.qty} бр.</li>`).join('');
  res.send(`<h2>Товарителница</h2><p>Поръчка: ${order.number}</p><p>Клиент: ${order.name}</p><p>Телефон: ${order.phone}</p><p>Адрес: ${order.shipping.city}, ${order.shipping.address}</p><p>Сума за събиране: ${formatBGN(order.total)} ${formatEUR(order.total)}</p><ul>${itemsList}</ul><textarea>${order.shipping.note||''}</textarea><br/><button onclick='window.print()'>Печат</button>`);
});

// --- Admin ---
app.get('/admin/login',(req,res)=>{res.send(`<form method='post' action='/admin/login'><input name='email' placeholder='Имейл'/><br/><input name='password' type='password' placeholder='Парола'/><br/><button>Вход</button></form>`);});
app.post('/admin/login',(req,res)=>{const{email,password}=req.body;if(email===ADMIN_EMAIL&&password===ADMIN_PASSWORD){req.session.admin=true;res.redirect('/admin');}else{res.send('Грешни данни');}});
app.get('/admin',requireAdmin,(req,res)=>{const list=orders.map(o=>`<li>${o.number} — ${o.method} — ${o.status} — ${formatBGN(o.total)} ${formatEUR(o.total)} ${o.method==='cod'?`<a href='/waybill/${o.id}'>Товарителница</a>`:''}</li>`).join('');res.send(`<h2>Поръчки</h2><ul>${list}</ul>`);});

app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
