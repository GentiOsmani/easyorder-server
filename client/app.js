// ─── State ──────────────────────────────────────────────────────────────────
const tableId = parseInt(location.pathname.split('/').pop()) || 1
let categories = [], menuItems = [], cart = {}
let currentOrderId = null, activeCatId = null, socket = null
let restaurant = { id: null, name: 'Restaurant', logoUrl: '' }
let statusPollInterval = null
let currentClientStatus = null

// ─── Helpers ────────────────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  const el = document.getElementById(id)
  if (el) el.classList.add('active')
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
function cartTotal() {
  return Object.entries(cart).reduce((sum,[id,qty]) => {
    const it = menuItems.find(i => i.id === parseInt(id))
    return sum + (it ? it.price * qty : 0)
  }, 0)
}
function cartCount() { return Object.values(cart).reduce((s,q) => s+q, 0) }

function renderCartBadge() {
  const count = cartCount()
  const badge = document.getElementById('cart-count')
  badge.textContent = count
  count === 0 ? badge.classList.add('hidden') : badge.classList.remove('hidden')
}

function updateItemQtyUI(itemId) {
  const item = menuItems.find(i => i.id === itemId)
  if (!item || item.categoryId !== activeCatId) return false

  const card = document.getElementById(`item-${itemId}`)
  if (!card) return false

  const qty = cart[itemId] || 0
  card.classList.toggle('in-cart', qty > 0)
  const ctrl = card.querySelector('.qty-ctrl')
  if (!ctrl) return false

  ctrl.innerHTML = `
    ${qty > 0 ? `<button class="qty-btn remove" onclick="changeQty(${item.id},-1)" ${!item.available ? 'disabled' : ''}>−</button><span class="qty-badge">${qty}</span>` : ''}
    <button class="qty-btn add" onclick="changeQty(${item.id},1)" ${!item.available ? 'disabled' : ''}>+</button>`
  return true
}

function clearStatusPoll() {
  if (!statusPollInterval) return
  clearInterval(statusPollInterval)
  statusPollInterval = null
}

// ─── Render Menu ────────────────────────────────────────────────────────────
function renderMenu() {
  const tabsEl = document.getElementById('cat-tabs')
  tabsEl.innerHTML = ''
  const visibleCategories = categories.filter(cat => menuItems.some(i => i.categoryId === cat.id && i.available))

  if (!visibleCategories.some(c => c.id === activeCatId)) {
    activeCatId = visibleCategories[0]?.id || null
  }

  visibleCategories.forEach(cat => {
    const btn = document.createElement('button')
    btn.className = 'cat-tab' + (cat.id === activeCatId ? ' active' : '')
    btn.textContent = cat.name
    btn.onclick = () => {
      activeCatId = cat.id
      renderMenu()
    }
    tabsEl.appendChild(btn)
  })

  const listEl = document.getElementById('menu-list')
  listEl.innerHTML = ''
  const activeCategory = categories.find(c => c.id === activeCatId)
  const visibleItems = menuItems.filter(i => i.available && i.categoryId === activeCatId)
  if (!activeCategory || visibleItems.length === 0) {
    listEl.innerHTML = '<p style="text-align:center;color:#94a3b8;padding:40px 16px;font-size:14px">No items in this category yet.</p>'
  } else {
    const section = document.createElement('div')
    section.className = 'cat-section'
    section.innerHTML = `<p class="cat-heading">${esc(activeCategory.name)}</p>`
    visibleItems.forEach(item => {
      const qty = cart[item.id] || 0
      const div = document.createElement('div')
      div.className = 'menu-item' + (qty > 0 ? ' in-cart' : '') + (!item.available ? ' menu-item-unavailable' : '')
      div.id = `item-${item.id}`
      div.innerHTML = `
        <div class="menu-item-info">
          <p class="menu-item-name">${esc(item.name)}</p>
          ${item.description ? `<p class="menu-item-desc">${esc(item.description)}</p>` : ''}
          <p class="menu-item-price">$${parseFloat(item.price).toFixed(2)}</p>
        </div>
        <div class="qty-ctrl">
          ${qty > 0 ? `<button class="qty-btn remove" onclick="changeQty(${item.id},-1)" ${!item.available?'disabled':''}>−</button><span class="qty-badge">${qty}</span>` : ''}
          <button class="qty-btn add" onclick="changeQty(${item.id},1)" ${!item.available?'disabled':''}>+</button>
        </div>`
      section.appendChild(div)
    })
    listEl.appendChild(section)
  }

  renderCartBadge()
}

function changeQty(itemId, delta) {
  const next = Math.max(0, (cart[itemId] || 0) + delta)
  if (next === 0) delete cart[itemId]; else cart[itemId] = next

  const isMenuVisible = document.getElementById('menu-screen')?.classList.contains('active')
  const patched = isMenuVisible ? updateItemQtyUI(itemId) : false
  if (!patched) renderMenu()
  else renderCartBadge()
}

// ─── Cart Screen ────────────────────────────────────────────────────────────
function showCart() {
  const listEl = document.getElementById('cart-list')
  listEl.innerHTML = ''
  const entries = Object.entries(cart)

  if (!entries.length) {
    listEl.innerHTML = `<div class="cart-empty"><div class="cart-empty-icon">🛒</div><p>Your cart is empty.<br>Add something delicious!</p></div>`
  } else {
    entries.forEach(([id, qty]) => {
      const item = menuItems.find(i => i.id === parseInt(id))
      if (!item) return
      const div = document.createElement('div')
      div.className = 'cart-item'
      div.innerHTML = `
        <div class="cart-item-info">
          <p class="cart-item-name">${esc(item.name)}</p>
          <p class="cart-item-price">$${parseFloat(item.price).toFixed(2)} each</p>
        </div>
        <div class="cart-item-right">
          <div class="cart-item-qty">
            <button class="small-btn remove" onclick="changeQty(${item.id},-1);showCart()">−</button>
            <span>${qty}</span>
            <button class="small-btn add" onclick="changeQty(${item.id},1);showCart()">+</button>
          </div>
          <span class="cart-item-total">$${(item.price * qty).toFixed(2)}</span>
        </div>`
      listEl.appendChild(div)
    })
  }

  document.getElementById('cart-total').innerHTML =
    `<span>Total</span><span style="color:var(--amber)">$${cartTotal().toFixed(2)}</span>`
  show('cart-screen')
}

function showMenu() { show('menu-screen'); renderMenu() }

// ─── Place Order ────────────────────────────────────────────────────────────
async function placeOrder() {
  if (!Object.keys(cart).length) return
  const btn = document.getElementById('order-btn')
  btn.disabled = true; btn.textContent = 'Placing order…'
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableId,
        items: Object.entries(cart).map(([id,qty]) => ({ menuItemId: parseInt(id), quantity: qty })),
        customerName: document.getElementById('customer-name').value.trim() || 'Guest'
      })
    })
    if (!res.ok) throw new Error()
    const order = await res.json()
    currentOrderId = order.id
    cart = {}
    showStatus(order)
    pollOrderStatus()
  } catch {
    alert('Could not place order. Please try again.')
    btn.disabled = false; btn.textContent = 'Confirm Order'
  }
}

// ─── Status Screen ──────────────────────────────────────────────────────────
function showStatus(order) {
  updateStatusUI('sent')
  const el = document.getElementById('status-items')
  el.innerHTML = ''
  order.items.forEach(i => {
    const row = document.createElement('div')
    row.className = 'status-item'
    row.innerHTML = `<span>${i.quantity}× ${esc(i.name)}</span><span>$${(i.price*i.quantity).toFixed(2)}</span>`
    el.appendChild(row)
  })
  const tot = order.items.reduce((s,i) => s + i.price*i.quantity, 0)
  const totRow = document.createElement('div')
  totRow.className = 'status-item'
  totRow.innerHTML = `<strong>Total</strong><strong>$${tot.toFixed(2)}</strong>`
  el.appendChild(totRow)
  show('status-screen')
  connectSocket()
}

function updateStatusUI(status) {
  const states = {
    sent:      { icon:'📨', title:'Order Sent Successfully', msg:'Waiting on the bartender to pick up your order.' },
    preparing: { icon:'🧑‍🍳', title:'Kitchen Is Preparing',    msg:'The kitchen has seen your order and is preparing it.' },
    ready:     { icon:'🛎️', title:'Awaiting Delivery',        msg:'Your order is ready and waiting for delivery by the waiter.' },
    completed: { icon:'🍽️', title:'Bon appétit!',             msg:'Hope to see you again.' }
  }
  const s = states[status]
  if (!s) return
  currentClientStatus = status
  document.getElementById('status-icon').textContent  = s.icon
  document.getElementById('status-title').textContent = s.title
  document.getElementById('status-msg').textContent   = s.msg
}

function pollOrderStatus() {
  if (!currentOrderId) return
  clearStatusPoll()
  statusPollInterval = setInterval(async () => {
    try {
      const r = await fetch(`/api/orders/status/${currentOrderId}`)
      const d = await r.json()
      const nextStatus = d.clientStatus || d.status
      if (nextStatus && nextStatus !== currentClientStatus) updateStatusUI(nextStatus)
      if (nextStatus === 'completed') clearStatusPoll()
    } catch {}
  }, 5000)
}

function connectSocket() {
  if (socket) return
  const s = document.createElement('script')
  s.src = '/socket.io/socket.io.js'
  s.onload = () => {
    socket = io()
    socket.emit('client:join_table', { tableId })
    socket.on('order:preparing', ({ orderId }) => {
      if (orderId === currentOrderId) updateStatusUI('preparing')
    })
    socket.on('order:ready', ({ orderId }) => {
      if (orderId === currentOrderId) updateStatusUI('ready')
    })
    socket.on('order:completed', ({ orderId }) => {
      if (orderId === currentOrderId) {
        updateStatusUI('completed')
        clearStatusPoll()
      }
    })
  }
  document.head.appendChild(s)
}

function backToMenu() {
  clearStatusPoll()
  currentOrderId = null
  currentClientStatus = null
  cart = {}
  show('menu-screen')
  renderMenu()
}

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const ctxRes = await fetch(`/api/client/context/${tableId}`)
    if (!ctxRes.ok) throw new Error()
    const data = await ctxRes.json()
    restaurant = data.restaurant || restaurant
    categories = data.menu.categories
    menuItems  = data.menu.items.filter(i => i.available)
    activeCatId = categories[0]?.id || null

    const tableName = data.table?.name || `Table ${tableId}`
    const logoEl = document.getElementById('brand-logo')
    if (logoEl) {
      if (restaurant.logoUrl) {
        logoEl.src = restaurant.logoUrl
        logoEl.alt = `${restaurant.name} logo`
        logoEl.classList.remove('hidden')
      } else {
        logoEl.classList.add('hidden')
      }
    }
    const brandNameEl = document.getElementById('brand-name')
    if (brandNameEl) brandNameEl.textContent = restaurant.name || 'Restaurant'

    document.getElementById('table-title').textContent    = tableName
    document.getElementById('table-subtitle').textContent = 'Tap items to order'
    document.title = tableName + ' — Menu'
    renderMenu()
  } catch {
    document.getElementById('menu-list').innerHTML =
      '<p style="text-align:center;color:#ef4444;padding:60px 16px;font-size:15px">Could not load menu. <a href="" style="color:#f59e0b">Tap to retry</a></p>'
  }
}

init()
