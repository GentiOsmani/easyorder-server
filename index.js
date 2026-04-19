const path = require('path')
const os   = require('os')
const express = require('express')
const http    = require('http')
const { Server: SocketIOServer } = require('socket.io')
const { WebSocketServer } = require('ws')
const bcrypt   = require('bcryptjs')
const low      = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')
const cors = require('cors')
const fs   = require('fs')

// ─── Paths ────────────────────────────────────────────────────────────────────
const clientDir = path.join(__dirname, 'client')
const dataDir   = path.join(__dirname, 'data')

// ─── Database Setup ───────────────────────────────────────────────────────────
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const adapter = new FileSync(path.join(dataDir, 'db.json'))
const db = low(adapter)

db.defaults({
  users: [
    { id: 1, username: 'admin',     passwordHash: bcrypt.hashSync('123', 10), role: 'admin' },
    { id: 2, username: 'bartender', passwordHash: bcrypt.hashSync('123', 10), role: 'bartender', restaurantId: 1 },
    { id: 3, username: 'manager',   passwordHash: bcrypt.hashSync('123', 10), role: 'manager', restaurantId: 1 }
  ],
  restaurants: [
    { id: 1, name: 'Default Restaurant', logoUrl: '' }
  ],
  tables: [],
  menuCategories: [
    { id: 1, restaurantId: 1, name: 'Starters' },
    { id: 2, restaurantId: 1, name: 'Mains' },
    { id: 3, restaurantId: 1, name: 'Desserts' },
    { id: 4, restaurantId: 1, name: 'Drinks' }
  ],
  menuItems: [
    { id: 1, restaurantId: 1, categoryId: 4, name: 'Beer',         price: 4.50,  description: 'Cold draft beer',            available: true },
    { id: 2, restaurantId: 1, categoryId: 4, name: 'Wine (Glass)',  price: 6.00,  description: 'House red or white wine',     available: true },
    { id: 3, restaurantId: 1, categoryId: 4, name: 'Water',         price: 1.50,  description: 'Still or sparkling',          available: true },
    { id: 4, restaurantId: 1, categoryId: 2, name: 'Burger',        price: 12.00, description: 'Beef burger with fries',      available: true },
    { id: 5, restaurantId: 1, categoryId: 2, name: 'Pasta',         price: 10.50, description: 'Spaghetti bolognese',         available: true },
    { id: 6, restaurantId: 1, categoryId: 1, name: 'Nachos',        price: 7.00,  description: 'Loaded with cheese & salsa',  available: true }
  ],
  orders: []
}).write()

const DEFAULT_RESTAURANT_ID = 1

const existingTablesForMigration = db.get('tables').value()
const tableRestaurantMap = new Map(existingTablesForMigration.map(t => [t.id, t.restaurantId || DEFAULT_RESTAURANT_ID]))
const currentUsers = db.get('users').value()
const currentCategories = db.get('menuCategories').value()
const currentItems = db.get('menuItems').value()
const currentTables = db.get('tables').value()
const currentOrders = db.get('orders').value()

const currentRestaurants = db.get('restaurants').value()
const nextRestaurants = currentRestaurants.length > 0
  ? currentRestaurants
  : [{ id: DEFAULT_RESTAURANT_ID, name: 'Default Restaurant', logoUrl: '' }]

const nextUsers = currentUsers.map(user => {
  if (user.role === 'bartender' || user.role === 'manager') {
    return { ...user, restaurantId: user.restaurantId || DEFAULT_RESTAURANT_ID }
  }
  return user
})

const nextCategories = currentCategories.map(cat => ({ ...cat, restaurantId: cat.restaurantId || DEFAULT_RESTAURANT_ID }))
const nextItems = currentItems.map(item => ({ ...item, restaurantId: item.restaurantId || DEFAULT_RESTAURANT_ID }))
const nextTables = currentTables.map(table => ({
  ...table,
  id: table.moduleId || table.id,
  moduleId: table.moduleId || table.id,
  restaurantId: table.restaurantId || DEFAULT_RESTAURANT_ID
}))
const nextOrders = currentOrders.map(order => ({
  ...order,
  restaurantId: order.restaurantId || tableRestaurantMap.get(order.tableId) || DEFAULT_RESTAURANT_ID
}))

const migrationChanged =
  nextRestaurants.length !== currentRestaurants.length ||
  currentUsers.some(user => (user.role === 'bartender' || user.role === 'manager') && !user.restaurantId) ||
  currentCategories.some(cat => !cat.restaurantId) ||
  currentItems.some(item => !item.restaurantId) ||
  currentTables.some(table => !table.restaurantId || !table.moduleId || table.id !== table.moduleId) ||
  currentOrders.some(order => !order.restaurantId)

if (migrationChanged) {
  db
    .set('users', nextUsers)
    .set('restaurants', nextRestaurants)
    .set('menuCategories', nextCategories)
    .set('menuItems', nextItems)
    .set('tables', nextTables)
    .set('orders', nextOrders)
    .write()
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getLocalIP() {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return '127.0.0.1'
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function parseRestaurantId(value) {
  const id = parseInt(value, 10)
  return Number.isInteger(id) ? id : null
}

function parseModuleId(value) {
  const id = parseInt(value, 10)
  if (!Number.isInteger(id)) return null
  return id >= 1 && id <= 100 ? id : null
}

function getRestaurantIdFromRequest(req) {
  return parseRestaurantId(req.query.restaurantId) || parseRestaurantId(req.body?.restaurantId) || DEFAULT_RESTAURANT_ID
}

function sanitizeUser(user) {
  if (!user) return null
  const { passwordHash, ...safe } = user
  return safe
}

function getStaffUsers(restaurantId = null) {
  let users = db.get('users').filter(u => u.role === 'bartender' || u.role === 'manager').value()
  if (restaurantId) users = users.filter(u => u.restaurantId === restaurantId)
  return users.map(sanitizeUser)
}

function getMenuData(restaurantId = DEFAULT_RESTAURANT_ID) {
  const categories = db.get('menuCategories').filter({ restaurantId }).value()
  const categoryIds = new Set(categories.map(c => c.id))
  return {
    categories,
    items: db.get('menuItems').filter(i => i.restaurantId === restaurantId && categoryIds.has(i.categoryId)).value()
  }
}

function getRestaurantByTableId(tableId) {
  const table = db.get('tables').find({ id: tableId }).value()
  if (!table) return null
  const restaurant = db.get('restaurants').find({ id: table.restaurantId }).value()
  return { table, restaurant }
}

function getTablesData(restaurantId = null) {
  if (!restaurantId) return db.get('tables').value()
  return db.get('tables').filter({ restaurantId }).value()
}

function getActiveOrders(restaurantId = null) {
  const active = db.get('orders').filter(o => o.status !== 'completed')
  if (!restaurantId) return active.value()
  return active.filter({ restaurantId }).value()
}

function emitMenuUpdated(restaurantId) {
  io.to(`restaurant:${restaurantId}`).emit('menu:updated', {
    restaurantId,
    ...getMenuData(restaurantId)
  })
}

function emitTablesUpdated(restaurantId) {
  io.to(`restaurant:${restaurantId}`).emit('tables:updated', getTablesData(restaurantId))
}

function emitOrderNew(order) {
  io.to(`restaurant:${order.restaurantId || DEFAULT_RESTAURANT_ID}`).emit('order:new', order)
}

function emitOrderUpdated(order) {
  io.to(`restaurant:${order.restaurantId || DEFAULT_RESTAURANT_ID}`).emit('order:updated', order)
}

function emitOrderRemoved(orderId, restaurantId) {
  io.to(`restaurant:${restaurantId || DEFAULT_RESTAURANT_ID}`).emit('order:removed', { orderId })
}

function getClientOrderStatus(order) {
  if (!order) return null
  if (order.status === 'completed') return 'completed'
  if (order.status === 'ready') return 'ready'
  if (order.status === 'preparing') return order.seenByBartender ? 'preparing' : 'sent'
  return order.status
}

// ─── Express + Socket.io Setup ────────────────────────────────────────────────
const PORT       = process.env.PORT || 3001
const expressApp = express()
const httpServer = http.createServer(expressApp)
const io         = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
})

expressApp.use(cors())
expressApp.use(express.json())

// Serve client phone menu
console.log('[SERVER] Client dir:', clientDir)
expressApp.use('/client', express.static(clientDir, {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
  }
}))
expressApp.get('/menu/:tableId', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  res.sendFile(path.join(clientDir, 'index.html'))
})

// Root — redirect to menu
expressApp.get('/', (req, res) => {
  res.send('EasyOrder server is running. Use /menu/:tableId to view a menu.')
})

// ─── REST API ─────────────────────────────────────────────────────────────────

expressApp.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body
  const user = db.get('users').find({ username }).value()
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  if ((user.role === 'bartender' || user.role === 'manager') && !user.restaurantId) {
    return res.status(403).json({ error: 'This staff account is not assigned to a restaurant yet' })
  }

  res.json({ id: user.id, username: user.username, role: user.role, restaurantId: user.restaurantId || null })
})

expressApp.get('/api/users', (req, res) => {
  const restaurantId = parseRestaurantId(req.query.restaurantId)
  res.json(getStaffUsers(restaurantId))
})

expressApp.post('/api/users', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const role = String(req.body?.role || '').trim()
  const restaurantId = parseRestaurantId(req.body?.restaurantId)

  if (!username) return res.status(400).json({ error: 'Username is required' })
  if (password.length < 3) return res.status(400).json({ error: 'Password must be at least 3 characters' })
  if (!['bartender', 'manager'].includes(role)) return res.status(400).json({ error: 'Role must be bartender or manager' })
  if (!restaurantId) return res.status(400).json({ error: 'Restaurant is required' })
  if (!db.get('restaurants').find({ id: restaurantId }).value()) return res.status(404).json({ error: 'Restaurant not found' })
  if (db.get('users').find({ username }).value()) return res.status(409).json({ error: 'Username already exists' })

  const user = {
    id: Date.now(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role,
    restaurantId
  }
  db.get('users').push(user).write()
  io.emit('users:updated', getStaffUsers())
  res.json(sanitizeUser(user))
})

expressApp.put('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  const existing = db.get('users').find({ id }).value()
  if (!existing || existing.role === 'admin') return res.status(404).json({ error: 'User not found' })

  const username = String(req.body?.username ?? existing.username).trim()
  const role = String(req.body?.role ?? existing.role).trim()
  const restaurantId = parseRestaurantId(req.body?.restaurantId) || existing.restaurantId
  const password = req.body?.password !== undefined ? String(req.body.password) : ''

  if (!username) return res.status(400).json({ error: 'Username is required' })
  if (!['bartender', 'manager'].includes(role)) return res.status(400).json({ error: 'Role must be bartender or manager' })
  if (!restaurantId) return res.status(400).json({ error: 'Restaurant is required' })
  if (!db.get('restaurants').find({ id: restaurantId }).value()) return res.status(404).json({ error: 'Restaurant not found' })
  if (db.get('users').find(u => u.username === username && u.id !== id).value()) {
    return res.status(409).json({ error: 'Username already exists' })
  }

  const updates = { username, role, restaurantId }
  if (password) {
    if (password.length < 3) return res.status(400).json({ error: 'Password must be at least 3 characters' })
    updates.passwordHash = bcrypt.hashSync(password, 10)
  }

  db.get('users').find({ id }).assign(updates).write()
  const updated = db.get('users').find({ id }).value()
  io.emit('users:updated', getStaffUsers())
  res.json(sanitizeUser(updated))
})

expressApp.delete('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  const existing = db.get('users').find({ id }).value()
  if (!existing || existing.role === 'admin') return res.json({ ok: true })
  db.get('users').remove({ id }).write()
  io.emit('users:updated', getStaffUsers())
  res.json({ ok: true })
})

expressApp.get('/api/restaurants', (req, res) => {
  res.json(db.get('restaurants').value())
})

expressApp.post('/api/restaurants', (req, res) => {
  const name = String(req.body?.name || '').trim()
  const logoUrl = String(req.body?.logoUrl || '').trim()
  if (!name) return res.status(400).json({ error: 'Restaurant name is required' })

  const restaurant = { id: Date.now(), name, logoUrl }
  db.get('restaurants').push(restaurant).write()
  io.emit('restaurants:updated', db.get('restaurants').value())
  res.json(restaurant)
})

expressApp.put('/api/restaurants/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  const name = String(req.body?.name || '').trim()
  const logoUrl = String(req.body?.logoUrl || '').trim()
  if (!name) return res.status(400).json({ error: 'Restaurant name is required' })
  db.get('restaurants').find({ id }).assign({ name, logoUrl }).write()
  const updated = db.get('restaurants').find({ id }).value()
  io.emit('restaurants:updated', db.get('restaurants').value())
  res.json(updated)
})

expressApp.get('/api/menu', (req, res) => {
  const tableId = parseInt(req.query.tableId, 10)
  if (Number.isInteger(tableId)) {
    const table = db.get('tables').find({ id: tableId }).value()
    if (!table) return res.status(404).json({ error: 'Table not found' })
    return res.json(getMenuData(table.restaurantId || DEFAULT_RESTAURANT_ID))
  }
  res.json(getMenuData(getRestaurantIdFromRequest(req)))
})

expressApp.get('/api/client/context/:tableId', (req, res) => {
  const tableId = parseInt(req.params.tableId, 10)
  const data = getRestaurantByTableId(tableId)
  if (!data) return res.status(404).json({ error: 'Table not found' })

  const restaurantId = data.table.restaurantId || DEFAULT_RESTAURANT_ID
  res.json({
    table: data.table,
    restaurant: data.restaurant || { id: restaurantId, name: 'Restaurant', logoUrl: '' },
    menu: getMenuData(restaurantId)
  })
})

expressApp.post('/api/menu/categories', (req, res) => {
  const restaurantId = getRestaurantIdFromRequest(req)
  const newCat = { id: Date.now(), restaurantId, name: req.body.name }
  db.get('menuCategories').push(newCat).write()
  emitMenuUpdated(restaurantId)
  res.json(newCat)
})

expressApp.delete('/api/menu/categories/:id', (req, res) => {
  const id = parseInt(req.params.id)
  const category = db.get('menuCategories').find({ id }).value()
  const restaurantId = category?.restaurantId || DEFAULT_RESTAURANT_ID
  db.get('menuCategories').remove({ id, restaurantId }).write()
  db.get('menuItems').remove({ categoryId: id, restaurantId }).write()
  emitMenuUpdated(restaurantId)
  res.json({ ok: true })
})

expressApp.post('/api/menu/items', (req, res) => {
  const restaurantId = getRestaurantIdFromRequest(req)
  const item = { id: Date.now(), ...req.body, restaurantId, available: req.body.available !== false }
  db.get('menuItems').push(item).write()
  emitMenuUpdated(restaurantId)
  res.json(item)
})

expressApp.put('/api/menu/items/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  const existing = db.get('menuItems').find({ id }).value()
  if (!existing) return res.status(404).json({ error: 'Item not found' })
  const restaurantId = existing.restaurantId || getRestaurantIdFromRequest(req)
  db.get('menuItems').find({ id }).assign({ ...req.body, restaurantId }).write()
  const updated = db.get('menuItems').find({ id }).value()
  emitMenuUpdated(restaurantId)
  res.json(updated)
})

expressApp.delete('/api/menu/items/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  const existing = db.get('menuItems').find({ id }).value()
  if (!existing) return res.json({ ok: true })
  const restaurantId = existing.restaurantId || DEFAULT_RESTAURANT_ID
  db.get('menuItems').remove({ id, restaurantId }).write()
  emitMenuUpdated(restaurantId)
  res.json({ ok: true })
})

expressApp.get('/api/tables', (req, res) => {
  const restaurantId = parseRestaurantId(req.query.restaurantId)
  if (restaurantId) return res.json(db.get('tables').filter({ restaurantId }).value())
  res.json(db.get('tables').value())
})

expressApp.post('/api/tables', (req, res) => {
  const restaurantId = getRestaurantIdFromRequest(req)
  const moduleId = parseModuleId(req.body.moduleId)
  if (!moduleId) {
    return res.status(400).json({ error: 'Module ID must be between 1 and 100' })
  }
  if (db.get('tables').find({ id: moduleId }).value()) {
    return res.status(409).json({ error: 'Module ID already exists' })
  }
  const table = {
    id: moduleId,
    moduleId,
    restaurantId,
    name: req.body.name || `Module ${moduleId}`,
    esp32Ip: req.body.esp32Ip || '',
    esp32Id: req.body.esp32Id || '',
    active: true
  }
  db.get('tables').push(table).write()
  tryBindPendingModule(moduleId)
  emitTablesUpdated(restaurantId)
  res.json(table)
})

expressApp.put('/api/tables/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  const existing = db.get('tables').find({ id }).value()
  if (!existing) return res.status(404).json({ error: 'Table not found' })

  const nextModuleId = req.body.moduleId !== undefined ? parseModuleId(req.body.moduleId) : existing.moduleId
  if (!nextModuleId) {
    return res.status(400).json({ error: 'Module ID must be between 1 and 100' })
  }
  if (nextModuleId !== id && db.get('tables').find({ id: nextModuleId }).value()) {
    return res.status(409).json({ error: 'Module ID already exists' })
  }

  db.get('tables').remove({ id }).write()
  const updated = {
    ...existing,
    ...req.body,
    id: nextModuleId,
    moduleId: nextModuleId,
    restaurantId: existing.restaurantId
  }
  db.get('tables').push(updated).write()
  tryBindPendingModule(updated.moduleId)

  db.set('orders', db.get('orders').value().map(order => {
    if (order.tableId !== id) return order
    return { ...order, tableId: nextModuleId }
  })).write()

  emitTablesUpdated(existing.restaurantId || DEFAULT_RESTAURANT_ID)
  res.json(updated)
})

expressApp.delete('/api/tables/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  const existing = db.get('tables').find({ id }).value()
  if (!existing) return res.json({ ok: true })
  db.get('tables').remove({ id }).write()
  emitTablesUpdated(existing.restaurantId || DEFAULT_RESTAURANT_ID)
  res.json({ ok: true })
})

expressApp.post('/api/orders', (req, res) => {
  const { tableId, items, customerName } = req.body
  if (!tableId || !items || items.length === 0) {
    return res.status(400).json({ error: 'Invalid order data' })
  }
  const table = db.get('tables').find({ id: tableId }).value()
  if (!table) return res.status(404).json({ error: 'Table not found' })

  const restaurantId = table.restaurantId || DEFAULT_RESTAURANT_ID
  const menuItems = db.get('menuItems').filter({ restaurantId }).value()
  const enrichedItems = items.map(i => {
    const mi = menuItems.find(m => m.id === i.menuItemId)
    return {
      id: genId(), menuItemId: i.menuItemId,
      name: mi ? mi.name : 'Unknown', price: mi ? mi.price : 0,
      quantity: i.quantity, notes: i.notes || '', done: false
    }
  })
  const order = {
    id: genId(), tableId, customerName: customerName || 'Guest',
    restaurantId,
    seenByBartender: false,
    status: 'preparing', items: enrichedItems,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }
  db.get('orders').push(order).write()
  emitOrderNew(order)
  sendToESP32(tableId, 'order:received', {})
  res.json(order)
})

expressApp.get('/api/orders', (req, res) => {
  const restaurantId = parseRestaurantId(req.query.restaurantId)
  const base = db.get('orders').filter(o => o.status !== 'completed')
  res.json(restaurantId ? base.filter({ restaurantId }).value() : base.value())
})

expressApp.get('/api/orders/all', (req, res) => {
  const restaurantId = parseRestaurantId(req.query.restaurantId)
  const base = db.get('orders')
  res.json(restaurantId ? base.filter({ restaurantId }).value() : base.value())
})

expressApp.get('/api/orders/status/:orderId', (req, res) => {
  const order = db.get('orders').find({ id: req.params.orderId }).value()
  if (!order) return res.status(404).json({ error: 'Not found' })
  res.json({
    status: order.status,
    clientStatus: getClientOrderStatus(order),
    updatedAt: order.updatedAt
  })
})

expressApp.get('/api/server-info', (req, res) => {
  res.json({ ip: getLocalIP(), port: PORT })
})

// ─── Socket.io Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.data.restaurantId = null

  const emitInitData = (restaurantId = null) => {
    socket.emit('init:data', {
      orders: getActiveOrders(restaurantId),
      tables: getTablesData(restaurantId),
      menu: getMenuData(restaurantId || DEFAULT_RESTAURANT_ID)
    })
  }

  emitInitData()

  socket.on('staff:set_restaurant', ({ restaurantId }) => {
    const id = parseRestaurantId(restaurantId)
    if (!id) return

    if (socket.data.restaurantId) {
      socket.leave(`restaurant:${socket.data.restaurantId}`)
    }
    socket.data.restaurantId = id
    socket.join(`restaurant:${id}`)
    emitInitData(id)
  })

  socket.on('bartender:item_done', ({ orderId, itemId, done }) => {
    const order = db.get('orders').find({ id: orderId }).value()
    if (!order) return
    const item = order.items.find(i => i.id === itemId)
    if (item) item.done = done
    if (!order.seenByBartender) {
      order.seenByBartender = true
      io.to(`table:${order.tableId}`).emit('order:preparing', { orderId: order.id })
    }
    order.updatedAt = new Date().toISOString()
    db.get('orders').find({ id: orderId }).assign(order).write()
    emitOrderUpdated(order)
  })

  socket.on('bartender:view_preparing', ({ restaurantId }) => {
    const id = parseRestaurantId(restaurantId) || socket.data.restaurantId
    if (!id) return

    const preparingOrders = db.get('orders').filter({ restaurantId: id, status: 'preparing' }).value()
    preparingOrders.forEach((order) => {
      if (!order.seenByBartender) {
        order.seenByBartender = true
        order.updatedAt = new Date().toISOString()
        db.get('orders').find({ id: order.id }).assign(order).write()
        emitOrderUpdated(order)
      }
      io.to(`table:${order.tableId}`).emit('order:preparing', { orderId: order.id })
    })
  })

  socket.on('bartender:finish_order', ({ orderId }) => {
    const order = db.get('orders').find({ id: orderId }).value()
    if (!order) return
    order.status = 'ready'
    order.seenByBartender = true
    order.items.forEach(i => { i.done = true })
    order.updatedAt = new Date().toISOString()
    db.get('orders').find({ id: orderId }).assign(order).write()
    emitOrderUpdated(order)
    io.to(`table:${order.tableId}`).emit('order:ready', { orderId })
    sendToESP32(order.tableId, 'order:ready', {})
  })

  socket.on('bartender:complete_order', ({ orderId }) => {
    const order = db.get('orders').find({ id: orderId }).value()
    if (!order) return
    order.status = 'completed'
    order.updatedAt = new Date().toISOString()
    db.get('orders').find({ id: orderId }).assign(order).write()
    emitOrderRemoved(orderId, order.restaurantId)
    io.to(`table:${order.tableId}`).emit('order:completed', { orderId })
    sendToESP32(order.tableId, 'order:delivered', {})
  })

  socket.on('client:join_table', ({ tableId }) => {
    socket.join(`table:${tableId}`)
  })
})

// ─── ESP32 Plain WebSocket ─────────────────────────────────────────────────────
const esp32Clients = new Map()
const esp32PendingByModuleId = new Map()
const esp32StateBySocket = new WeakMap()
const wss = new WebSocketServer({ server: httpServer, path: '/esp32' })

function findTableByModuleId(moduleId) {
  return db.get('tables').find({ moduleId }).value() || db.get('tables').find({ id: moduleId }).value() || null
}

function untrackSocket(ws) {
  const state = esp32StateBySocket.get(ws)
  if (!state) return
  if (state.tableId) esp32Clients.delete(state.tableId)
  if (state.moduleId) {
    const pending = esp32PendingByModuleId.get(state.moduleId)
    if (pending === ws) esp32PendingByModuleId.delete(state.moduleId)
  }
}

function bindEsp32ToTable(ws, table, moduleId, esp32Id = '') {
  untrackSocket(ws)

  const resolvedModuleId = table.moduleId || table.id
  esp32StateBySocket.set(ws, {
    moduleId: resolvedModuleId,
    tableId: table.id,
    esp32Id,
    onlineAt: new Date().toISOString()
  })
  esp32Clients.set(table.id, ws)

  db.get('tables')
    .find({ id: table.id })
    .assign({
      esp32Id: esp32Id || table.esp32Id || '',
      active: true
    })
    .write()

  const serverIp = getLocalIP()
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({
      event: 'esp32:bound',
      data: {
        moduleId: resolvedModuleId,
        tableId: table.id,
        restaurantId: table.restaurantId,
        menuPath: `/menu/${table.id}`,
        serverIp,
        port: PORT
      }
    }))
  }

  sendToESP32(table.id, 'lcd:update', { line1: table.name || `Table ${table.id}`, line2: 'Tap to order' })
  io.emit('esp32:online', { tableId: table.id, moduleId: resolvedModuleId, esp32Id: esp32Id || null })
  emitTablesUpdated(table.restaurantId || DEFAULT_RESTAURANT_ID)
}

function tryBindPendingModule(moduleId) {
  const ws = esp32PendingByModuleId.get(moduleId)
  if (!ws || ws.readyState !== 1) return false
  const table = findTableByModuleId(moduleId)
  if (!table) return false
  const state = esp32StateBySocket.get(ws) || {}
  bindEsp32ToTable(ws, table, moduleId, state.esp32Id || '')
  esp32PendingByModuleId.delete(moduleId)
  return true
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.event === 'esp32:register') {
        const moduleId = parseModuleId(msg.data?.moduleId ?? msg.data?.tableId)
        if (!moduleId) return

        const esp32Id = String(msg.data?.esp32Id || '').trim()
        const table = findTableByModuleId(moduleId)

        esp32StateBySocket.set(ws, {
          moduleId,
          tableId: null,
          esp32Id,
          onlineAt: new Date().toISOString()
        })

        if (table) {
          bindEsp32ToTable(ws, table, moduleId, esp32Id)
        } else {
          untrackSocket(ws)
          esp32StateBySocket.set(ws, {
            moduleId,
            tableId: null,
            esp32Id,
            onlineAt: new Date().toISOString()
          })
          esp32PendingByModuleId.set(moduleId, ws)
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              event: 'esp32:waiting_table',
              data: { moduleId }
            }))
          }
          io.emit('esp32:pending', { moduleId, esp32Id: esp32Id || null })
        }
      } else if (msg.event === 'nfc:tap') {
        const state = esp32StateBySocket.get(ws)
        const tid = msg.data?.tableId || state?.tableId || null
        if (tid) sendToESP32(tid, 'lcd:update', { line1: 'Scan detected!', line2: 'Opening menu...' })
        io.emit('nfc:tap', { tableId: tid })
      }
    } catch (e) { console.error('[ESP32] parse error:', e) }
  })
  ws.on('close', () => {
    const state = esp32StateBySocket.get(ws)
    untrackSocket(ws)
    if (state?.tableId) {
      io.emit('esp32:offline', { tableId: state.tableId, moduleId: state.moduleId || null })
      const table = db.get('tables').find({ id: state.tableId }).value()
      if (table) emitTablesUpdated(table.restaurantId || DEFAULT_RESTAURANT_ID)
    }
  })
})

function sendToESP32(tableId, event, data) {
  const ws = esp32Clients.get(tableId)
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ event, data }))
}

function sendLCDUpdate(tableId, line1, line2) {
  sendToESP32(tableId, 'lcd:update', { line1, line2 })
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] http://0.0.0.0:${PORT}  LAN: http://${getLocalIP()}:${PORT}`)
})
