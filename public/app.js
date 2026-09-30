let selectedClass=null, selectedStep=null, pollTimer=null;
const POSITION_LABELS=[
  'A1','A2','A3','A4','A5','A6',
  'B1','B2','B3','B4','B5','B6','B7',
  'C1','C2','C3','C4','C5','C6',
  'D1','D2','D3','D4','D5','D6','D7',
  'E1','E2','E3','E4','E5','E6',
  'F1','F2','F3','F4','F5','F6','F7',
  'G1','G2','G3','G4','G5','G6',
  'H1','H2','H3','H4','H5'
];
const POSITION_ROW_SIZES=[6,7,6,7,6,7,6,5];
const stepLabel=n=>POSITION_LABELS[Number(n)-1]||String(n);
const $=s=>document.querySelector(s);
const money=n=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Number(n));
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
async function api(url,opts){const r=await fetch(url,opts);const d=await r.json();if(!r.ok)throw new Error(d.error||'Something went wrong');return d}
function scrollToSection(id){document.getElementById(id).scrollIntoView({behavior:'smooth'})}
async function loadClasses(){const data=await api('/api/classes');$('#classGrid').innerHTML=data.map((c,i)=>`<article class="class-card" onclick="chooseClass('${c.slug}')"><span class="number">0${i+1}</span><h3>${esc(c.name)}</h3><p>${esc(c.description)}</p><div class="availability"><b>${c.available}</b> of ${c.total} positions available</div></article>`).join('')}
async function chooseClass(slug){selectedClass=slug;selectedStep=null;const [classes,steps]=await Promise.all([api('/api/classes'),api(`/api/classes/${slug}/steps`)]);const c=classes.find(x=>x.slug===slug);$('#selectedClassTitle').textContent=c.name;renderSteps(steps.steps);$('#positions').classList.remove('hidden');$('#selectedBar').classList.add('hidden');scrollToSection('positions')}
function renderSteps(steps){
  const byNumber=new Map(steps.map(s=>[Number(s.step_number),s]));
  let number=1;
  $('#stepGrid').innerHTML=POSITION_ROW_SIZES.map((count,rowIndex)=>{
    const row=Array.from({length:count},()=>{
      const s=byNumber.get(number);
      const html=`<button class="step ${s.status}" ${s.status!=='available'?'disabled':''} aria-label="Posisi ${stepLabel(number)}" title="${stepLabel(number)}" onclick="selectStep(${number},this)">${stepLabel(number)}</button>`;
      number++;
      return html;
    }).join('');
    return `<div class="step-row row-${rowIndex+1}">${row}</div>`;
  }).join('');
}
function selectStep(n,el){document.querySelectorAll('.step.selected').forEach(x=>x.classList.remove('selected'));el.classList.add('selected');selectedStep=n;$('#selectedNumber').textContent=stepLabel(n);$('#selectedBar').classList.remove('hidden')}
function openDetails(){if(!selectedClass||!selectedStep)return;$('#modalContent').innerHTML=`<div class="eyebrow">STEP 03</div><h3>Secure your position</h3><div class="sub">Complete your participant details. Your selected position will be held while the payment is created.</div><div class="pay-summary"><div><small>Class</small><strong>${esc(selectedClass)}</strong></div><div><small>Position</small><strong>${stepLabel(selectedStep)}</strong></div></div><form class="form-grid" onsubmit="createBooking(event)"><div class="field"><label>Full name</label><input name="fullName" required placeholder="Your full name" maxlength="120"></div><div class="field"><label>WhatsApp / phone</label><input name="phone" required placeholder="08xxxxxxxxxx" maxlength="40"></div><div class="field"><label>Email</label><input type="email" name="email" required placeholder="you@email.com" maxlength="180"></div><div class="field"><label>Virtual Account bank</label><select name="bank" required><option value="bca">BCA Virtual Account</option><option value="bni">BNI Virtual Account</option><option value="bri">BRI Virtual Account</option><option value="permata">Permata Virtual Account</option></select></div><button class="gold-btn full">Create Virtual Account <span>→</span></button></form>`;$('#modal').classList.remove('hidden')}
async function createBooking(e){e.preventDefault();const f=new FormData(e.target);const payload={classSlug:selectedClass,stepNumber:selectedStep,fullName:f.get('fullName'),phone:f.get('phone'),email:f.get('email'),bank:f.get('bank')};const btn=e.target.querySelector('button');btn.disabled=true;btn.textContent='Creating payment…';try{const b=await api('/api/bookings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});showPayment(b)}catch(err){btn.disabled=false;btn.innerHTML='Create Virtual Account <span>→</span>';toast(err.message)}}
function showPayment(b){const expiry=new Date(b.paymentExpiry);$('#modalContent').innerHTML=`<div class="eyebrow">PAYMENT</div><h3>Virtual Account created</h3><div class="sub">Please complete the transfer before the payment expiry time.</div><div class="pay-summary"><div><small>Order</small><strong>${esc(b.orderId)}</strong></div><div><small>Total</small><strong>${money(b.amount)}</strong></div></div><div class="va-box"><div class="va-bank">${esc((b.bank||'').toUpperCase())} VIRTUAL ACCOUNT</div><div class="va-number" id="vaNumber">${esc(b.vaNumber||'—')}</div><button class="copy-btn" onclick="copyVa()">Copy VA Number</button><p class="muted" style="font-size:11px;margin:15px 0 0">Payment deadline: ${expiry.toLocaleString('id-ID')}</p></div><button class="gold-btn full" onclick="checkBooking('${esc(b.orderId)}')">I have paid / Check status</button><p class="muted" style="font-size:11px;text-align:center;margin-top:12px">The position is locked only after Midtrans confirms the payment.</p>`;startPolling(b.orderId)}
function copyVa(){navigator.clipboard?.writeText($('#vaNumber').textContent);toast('VA number copied')}
function startPolling(order){clearInterval(pollTimer);pollTimer=setInterval(async()=>{try{const b=await api(`/api/bookings/${order}`);if(b.status==='paid'||b.status==='expired'||b.status==='cancelled'){clearInterval(pollTimer);showResult(b)}}catch(e){}},5000)}
async function checkBooking(order){try{const b=await api(`/api/bookings/${order}`);if(b.status==='paid')showResult(b);else toast(`Status: ${b.status}. Waiting for payment confirmation.`)}catch(e){toast(e.message)}}
function showResult(b){if(b.status==='paid'){const qrData=`${location.origin}/booking/${encodeURIComponent(b.order_id)}`;$('#modalContent').innerHTML=`<div class="success-icon">✓</div><div class="eyebrow">BOOKING CONFIRMED</div><h3>Your position is locked.</h3><div class="sub">Payment confirmed. Please save this proof for event day.</div><div class="receipt" id="receipt"><div style="text-align:center;font-family:Cinzel,serif;letter-spacing:.12em;color:#9d752c">AEROPARTY 2026</div><div class="receipt-step">${stepLabel(b.step_number)}</div><div class="receipt-row"><span>Participant</span><b>${esc(b.full_name)}</b></div><div class="receipt-row"><span>Class</span><b>${esc(b.class_name)}</b></div><div class="receipt-row"><span>Order ID</span><b>${esc(b.order_id)}</b></div><div class="receipt-row"><span>Payment</span><b>PAID</b></div><div class="receipt-note">Keep this page or take a screenshot. Bring the booking proof to the event.</div></div><button class="gold-btn full" onclick="window.print()">Print / Save as PDF</button>`}else if(b.status==='expired'||b.status==='cancelled'){clearInterval(pollTimer);$('#modalContent').innerHTML=`<div class="eyebrow">PAYMENT CLOSED</div><h3>This booking is no longer active.</h3><p class="muted">The position has been released. Please close this message and select another available position.</p><button class="gold-btn full" onclick="closeModal();chooseClass('${esc(selectedClass)}')">Choose another position</button>`}}
function closeModal(){clearInterval(pollTimer);$('#modal').classList.add('hidden')}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}
loadClasses().catch(e=>toast(e.message));
