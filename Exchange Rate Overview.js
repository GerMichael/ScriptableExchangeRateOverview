// ================= CONFIG =================
const baseCur = "USD"
const targetCur = "EUR"

const tradingDays = 20
const minLookback = tradingDays
const maxLookback = tradingDays * 3

const keyName = "ratesexchange.eu_api_key"

// ================= WIDGET =================
const w = new ListWidget()
w.backgroundColor = new Color("#222222")

const today = new Date()
today.setHours(0, 0, 0, 0)
w.refreshAfterDate = new Date(today.getTime() + 24 * 60 * 60 * 1000)

// ================= FILE CACHE =================
const fm = FileManager.local()
const CACHE_FILE = fm.joinPath(
  fm.documentsDirectory(),
  "rates_cache.json"
)

// ================= API KEY =================
if (!Keychain.contains(keyName)) {
  const a = new Alert()
  a.message = "API Key eingeben"
  a.addSecureTextField("Key für ratesexchange.eu", "")
  a.addAction("OK")
  await a.present()
  Keychain.set(keyName, a.textFieldValue(0))
}
const apiKey = Keychain.get(keyName)

// ================= HELPERS =================
function dateStr(d) {
  return d.toISOString().split("T")[0]
}

function historyUrl(date) {
  return `https://api.ratesexchange.eu/client/history` +
         `?apiKey=${apiKey}` +
         `&base_currency=${baseCur}` +
         `&date=${date}` +
         `&currencies=${targetCur}`
}

function daysBetween(a, b) {
  return Math.floor((a - b) / (24 * 60 * 60 * 1000))
}

async function safeFetch(url) {
  try {
    const r = new Request(url)
    return await r.loadJSON()
  } catch {
    console.error("Failed to fetch:", url)
    return null
  }
}

// ================= CACHE HELPERS =================
function loadCache() {
  if (!fm.fileExists(CACHE_FILE)) {
    return { base: baseCur, target: targetCur, data: {} }
  }
  try {
    console.log(`try to load from cache file ${CACHE_FILE}`)
    const cache = JSON.parse(fm.readString(CACHE_FILE))
    return { base: cache.base, target: cache.target, data: cache.data }
  } catch {
    return { base: baseCur, target: targetCur, data: {} }
  }
}

function saveCache(cache) {
  console.log(`update log file ${CACHE_FILE}`)
  fm.writeString(CACHE_FILE, JSON.stringify(cache))
}

// ================= LOAD TRADING DAYS =================
async function loadTradingDays(n) {
  const cache = loadCache()
  console.log(`Cache: ${JSON.stringify(cache)}`)

  // Cache invalidieren bei Währungswechsel
  if (cache.base !== baseCur || cache.target !== targetCur) {
    cache.base = baseCur
    cache.target = targetCur
    cache.data = {}
  }

  // ================= HORIZONT ABLEITEN =================
  let horizon = minLookback

  const cachedDates = Object.keys(cache.data)
  if (cachedDates.length > 0) {
    const oldest = cachedDates.reduce((a, b) => a < b ? a : b)
    horizon = daysBetween(today, new Date(oldest)) + 1
    horizon = Math.max(horizon, minLookback)
    horizon = Math.min(horizon, maxLookback)
  }

  console.log(`Using horizon = ${horizon} days`)

  // ================= KALENDERTAGE =================
  const calendarDates = []
  for (let i = 0; i < horizon; i++) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    calendarDates.push(dateStr(d))
  }

  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  // Fehlende Tage (null zählt als vorhanden!)
  const missingDates = calendarDates.filter(
    d => (
      !(d in cache.data)
      || (cache.data[d] == null && d == dateStr(today))
      || (cache.data[d] == null && d == dateStr(yesterday))
    )
  )

  console.log(`Missing dates: ${missingDates}`)

  // ================= API LOAD =================
  const fetched = await Promise.all(
    missingDates.map(async d => {
      console.log(`loading rate for date ${d}`)
      const res = await safeFetch(historyUrl(d))
      if (res?.rates?.[targetCur] !== undefined) {
        return { date: d, rate: res.rates[targetCur] }
      }
      return { date: d, rate: null }
    })
  )

  fetched.forEach(r => {
    cache.data[r.date] = r.rate
  })

  // ================= CACHE CLEANUP =================
  const cutoffDate = new Date(today)
  cutoffDate.setDate(today.getDate() - horizon + 1)
  const cutoff = dateStr(cutoffDate)

  for (const d of Object.keys(cache.data)) {
    if (d < cutoff) {
      delete cache.data[d]
    }
  }

  saveCache(cache)

  // ================= TRADING DAYS =================
  const tradingDates = Object.keys(cache.data)
    .filter(d => cache.data[d] !== null)
    .sort((a, b) => new Date(a) - new Date(b))

  const recent = tradingDates.slice(-n - 1)

  return recent.map(d => ({
    date: d,
    rate: cache.data[d]
  }))
}

// ================= DATA =================
const data = await loadTradingDays(tradingDays)

if (data.length < 2) {
  const errorText = w.addText("Not enough market data")
  errorText.textColor = Color.white()
  Script.setWidget(w)
  Script.complete()
  w.presentSmall()
  return
}

const rates = data.map(d => d.rate)

// ================= NUMERIC CHANGE =================
const start = rates[0]
const end = rates[rates.length - 1]
const pct = ((end - start) / start * 100).toFixed(2)

// ================= TEXT =================
const title = w.addText(`${baseCur} → ${targetCur}`)
title.font = Font.boldSystemFont(16)
title.textColor = Color.white()

const value = w.addText(`${end.toFixed(4)} ${targetCur} (${pct}%)`)
value.font = Font.systemFont(14)
value.textColor = pct >= 0 ? Color.green() : Color.red()

w.addSpacer(6)

// ================= CHART =================
const width = 200
const height = 80

const min = Math.min(...rates)
const max = Math.max(...rates)
const range = max - min || 1

const dc = new DrawContext()
dc.size = new Size(width, height)
dc.opaque = false
dc.setStrokeColor(Color.white())
dc.setLineWidth(2)

const path = new Path()

rates.forEach((r, i) => {
  const x = (i / (rates.length - 1)) * width
  const y = height - ((r - min) / range) * height
  i === 0 ? path.move(new Point(x, y)) : path.addLine(new Point(x, y))
})

dc.addPath(path)
dc.strokePath()

w.addImage(dc.getImage())

// ================= DONE =================
Script.setWidget(w)
Script.complete()
w.presentSmall()