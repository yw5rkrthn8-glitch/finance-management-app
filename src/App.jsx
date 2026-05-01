import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import './App.css'

const STORAGE_KEY = 'finance-management-records'
const EXCEL_URL = '/FA.xlsx'

function loadRecordsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return undefined
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function persistRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

function parseDateCell(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'number' && value > 20000) {
    const d = XLSX.SSF.parse_date_code(value)
    if (d?.y) {
      const m = String(d.m).padStart(2, '0')
      const day = String(d.d).padStart(2, '0')
      return `${d.y}-${m}-${day}`
    }
  }
  const s = String(value ?? '').trim()
  if (s) {
    const t = Date.parse(s)
    if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10)
  }
  return ''
}

function parseAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const n = parseFloat(String(value ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function rowToRecord(row, index) {
  const date = parseDateCell(row.Date)
  const direction = String(row['支出/收入'] ?? '').trim()
  const category = String(row['类型'] ?? '').trim()
  const amount = parseAmount(row['金额'])
  const no = row['No.']
  const id =
    typeof no === 'number' && no > 0
      ? `excel-${no}-${index}`
      : crypto.randomUUID()
  return { id, date, direction, category, amount }
}

function isRowEmptyForImport(row) {
  const date = parseDateCell(row.Date)
  const category = String(row['类型'] ?? '').trim()
  const amount = parseAmount(row['金额'])
  return !date && !category && amount === 0
}

async function loadRecordsFromExcel() {
  const res = await fetch(EXCEL_URL)
  if (!res.ok) throw new Error(`Failed to load ${EXCEL_URL}`)
  const buf = await res.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) return []
  const sheet = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  const out = []
  rows.forEach((row, index) => {
    if (isRowEmptyForImport(row)) return
    const rec = rowToRecord(row, index)
    if (!rec.date && !rec.category && rec.amount === 0) return
    out.push(rec)
  })
  return out
}

function formatMoney(n) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n)
}

function monthKey(isoDate) {
  if (!isoDate || isoDate.length < 7) return ''
  return isoDate.slice(0, 7)
}

export default function App() {
  const [records, setRecords] = useState([])
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)

  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    direction: '支出',
    category: '',
    amount: '',
  })

  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadError(null)
      setLoading(true)
      const stored = loadRecordsFromStorage()
      if (stored !== undefined) {
        if (!cancelled) {
          setRecords(stored)
          setLoading(false)
        }
        return
      }
      try {
        const fromExcel = await loadRecordsFromExcel()
        if (!cancelled) setRecords(fromExcel)
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const totals = useMemo(() => {
    let income = 0
    let expense = 0
    for (const r of records) {
      const a = Math.abs(Number(r.amount) || 0)
      if (r.direction === '收入') income += a
      else expense += a
    }
    return {
      income,
      expense,
      net: income - expense,
      count: records.length,
    }
  }, [records])

  const chartBars = useMemo(() => {
    const byMonth = new Map()
    for (const r of records) {
      const mk = monthKey(r.date)
      if (!mk) continue
      if (!byMonth.has(mk)) {
        byMonth.set(mk, { month: mk, income: 0, expense: 0 })
      }
      const b = byMonth.get(mk)
      const a = Math.abs(Number(r.amount) || 0)
      if (r.direction === '收入') b.income += a
      else b.expense += a
    }
    const list = [...byMonth.values()].sort((a, b) =>
      a.month.localeCompare(b.month),
    )
    const last = list.slice(-6)
    const maxVal = Math.max(
      1,
      ...last.flatMap((x) => [x.income, x.expense]),
    )
    return { bars: last, maxVal }
  }, [records])

  const addRecord = useCallback((e) => {
    e.preventDefault()
    const amount = parseAmount(form.amount)
    if (!form.date || !form.category.trim() || amount <= 0) return
    const rec = {
      id: crypto.randomUUID(),
      date: form.date,
      direction: form.direction,
      category: form.category.trim(),
      amount,
    }
    setRecords((prev) => {
      const next = [rec, ...prev]
      persistRecords(next)
      return next
    })
    setForm((f) => ({ ...f, category: '', amount: '' }))
  }, [form])

  const startEdit = useCallback((r) => {
    setEditingId(r.id)
    setEditDraft({
      date: r.date,
      direction: r.direction,
      category: r.category,
      amount: String(r.amount),
    })
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditDraft(null)
  }, [])

  const saveEdit = useCallback(() => {
    if (!editingId || !editDraft) return
    const amount = parseAmount(editDraft.amount)
    if (!editDraft.date || !editDraft.category.trim() || amount <= 0) return
    setRecords((prev) => {
      const next = prev.map((r) =>
        r.id === editingId
          ? {
              ...r,
              date: editDraft.date,
              direction: editDraft.direction,
              category: editDraft.category.trim(),
              amount,
            }
          : r,
      )
      persistRecords(next)
      return next
    })
    cancelEdit()
  }, [editingId, editDraft, cancelEdit])

  const deleteRecord = useCallback((id) => {
    setRecords((prev) => {
      const next = prev.filter((r) => r.id !== id)
      persistRecords(next)
      return next
    })
    setEditingId((cur) => (cur === id ? null : cur))
  }, [])

  return (
    <>
      <style>{`
        .finance-app {
          text-align: left;
          padding: 28px 24px 48px;
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 28px;
          box-sizing: border-box;
        }
        .finance-app h1 {
          font-size: 32px;
          margin: 0 0 8px;
          letter-spacing: -0.5px;
        }
        .finance-app .sub {
          margin: 0;
          color: var(--text);
          font-size: 16px;
        }
        .finance-kpis {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 14px;
        }
        @media (max-width: 900px) {
          .finance-kpis {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        .finance-kpi {
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 16px 18px;
          background: var(--bg);
          box-shadow: var(--shadow);
        }
        .finance-kpi .label {
          font-size: 13px;
          color: var(--text);
          margin-bottom: 6px;
        }
        .finance-kpi .value {
          font-size: 22px;
          font-weight: 600;
          color: var(--text-h);
          font-variant-numeric: tabular-nums;
        }
        .finance-kpi.income .value { color: #16a34a; }
        .finance-kpi.expense .value { color: #dc2626; }
        .finance-kpi.net .value { color: var(--accent); }
        .finance-panel {
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 20px;
          background: var(--code-bg);
        }
        .finance-panel h2 {
          margin: 0 0 16px;
          font-size: 18px;
        }
        .chart-wrap {
          display: flex;
          align-items: flex-end;
          gap: 12px;
          min-height: 180px;
          padding-top: 8px;
        }
        .chart-col {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
        }
        .chart-bars {
          display: flex;
          gap: 4px;
          align-items: flex-end;
          height: 140px;
          width: 100%;
          justify-content: center;
        }
        .chart-bar {
          width: 42%;
          max-width: 28px;
          border-radius: 4px 4px 0 0;
          min-height: 2px;
        }
        .chart-bar.inc { background: #22c55e; }
        .chart-bar.exp { background: #ef4444; }
        .chart-legend {
          display: flex;
          gap: 16px;
          justify-content: center;
          margin-top: 12px;
          font-size: 13px;
          color: var(--text);
        }
        .chart-legend span {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .dot {
          width: 10px;
          height: 10px;
          border-radius: 2px;
          display: inline-block;
        }
        .finance-form {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr)) auto;
          gap: 10px;
          align-items: end;
        }
        @media (max-width: 900px) {
          .finance-form {
            grid-template-columns: 1fr;
          }
        }
        .field label {
          display: block;
          font-size: 12px;
          color: var(--text);
          margin-bottom: 4px;
        }
        .field input,
        .field select {
          width: 100%;
          box-sizing: border-box;
          padding: 8px 10px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--bg);
          color: var(--text-h);
          font: inherit;
        }
        .btn {
          font: inherit;
          padding: 8px 14px;
          border-radius: 6px;
          border: 2px solid transparent;
          cursor: pointer;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .btn-primary {
          color: var(--accent);
          background: var(--accent-bg);
        }
        .btn-primary:hover {
          border-color: var(--accent-border);
        }
        .btn-ghost {
          background: var(--social-bg);
          color: var(--text-h);
        }
        .btn-danger {
          color: #b91c1c;
          background: rgba(239, 68, 68, 0.12);
        }
        .finance-table-wrap {
          overflow-x: auto;
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--bg);
        }
        table.finance-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 15px;
        }
        .finance-table th,
        .finance-table td {
          padding: 10px 12px;
          border-bottom: 1px solid var(--border);
          text-align: left;
        }
        .finance-table th {
          background: var(--code-bg);
          color: var(--text-h);
          font-weight: 500;
        }
        .finance-table tr:last-child td {
          border-bottom: none;
        }
        .finance-table td.num {
          font-variant-numeric: tabular-nums;
          text-align: right;
        }
        .finance-table .actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .status-banner {
          padding: 10px 12px;
          border-radius: 8px;
          background: var(--accent-bg);
          color: var(--text-h);
          font-size: 14px;
        }
        .status-banner.error {
          background: rgba(239, 68, 68, 0.15);
          color: #b91c1c;
        }
      `}</style>

      <div className="finance-app">
        <header>
          <h1>财务概览</h1>
          <p className="sub">
            数据来自 Excel（首次无本地缓存时加载），收支明细支持本地持久化。
          </p>
        </header>

        {loading && (
          <div className="status-banner" role="status">
            正在加载数据…
          </div>
        )}
        {loadError && (
          <div className="status-banner error" role="alert">
            {loadError}
          </div>
        )}

        <section className="finance-kpis" aria-label="关键指标">
          <div className="finance-kpi income">
            <div className="label">总收入</div>
            <div className="value">¥{formatMoney(totals.income)}</div>
          </div>
          <div className="finance-kpi expense">
            <div className="label">总支出</div>
            <div className="value">¥{formatMoney(totals.expense)}</div>
          </div>
          <div className="finance-kpi net">
            <div className="label">净额</div>
            <div className="value">¥{formatMoney(totals.net)}</div>
          </div>
          <div className="finance-kpi">
            <div className="label">笔数</div>
            <div className="value">{totals.count}</div>
          </div>
        </section>

        <section className="finance-panel" aria-label="月度收支对比">
          <h2>近 6 个月收支</h2>
          {chartBars.bars.length === 0 ? (
            <p className="sub">暂无可用月份数据</p>
          ) : (
            <>
              <div className="chart-wrap">
                {chartBars.bars.map((b) => (
                  <div key={b.month} className="chart-col">
                    <div className="chart-bars">
                      <div
                        className="chart-bar inc"
                        style={{
                          height: `${(b.income / chartBars.maxVal) * 100}%`,
                        }}
                        title={`收入 ${formatMoney(b.income)}`}
                      />
                      <div
                        className="chart-bar exp"
                        style={{
                          height: `${(b.expense / chartBars.maxVal) * 100}%`,
                        }}
                        title={`支出 ${formatMoney(b.expense)}`}
                      />
                    </div>
                    <div className="sub" style={{ fontSize: 12 }}>
                      {b.month}
                    </div>
                  </div>
                ))}
              </div>
              <div className="chart-legend">
                <span>
                  <i className="dot" style={{ background: '#22c55e' }} />
                  收入
                </span>
                <span>
                  <i className="dot" style={{ background: '#ef4444' }} />
                  支出
                </span>
              </div>
            </>
          )}
        </section>

        <section className="finance-panel" aria-label="新增记录">
          <h2>新增记录</h2>
          <form className="finance-form" onSubmit={addRecord}>
            <div className="field">
              <label htmlFor="f-date">日期</label>
              <input
                id="f-date"
                type="date"
                value={form.date}
                onChange={(e) =>
                  setForm((f) => ({ ...f, date: e.target.value }))
                }
                required
              />
            </div>
            <div className="field">
              <label htmlFor="f-dir">支出/收入</label>
              <select
                id="f-dir"
                value={form.direction}
                onChange={(e) =>
                  setForm((f) => ({ ...f, direction: e.target.value }))
                }
              >
                <option value="支出">支出</option>
                <option value="收入">收入</option>
              </select>
            </div>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label htmlFor="f-cat">类型</label>
              <input
                id="f-cat"
                value={form.category}
                onChange={(e) =>
                  setForm((f) => ({ ...f, category: e.target.value }))
                }
                placeholder="例如：餐饮"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="f-amt">金额</label>
              <input
                id="f-amt"
                type="number"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={(e) =>
                  setForm((f) => ({ ...f, amount: e.target.value }))
                }
                required
              />
            </div>
            <button type="submit" className="btn btn-primary">
              添加
            </button>
          </form>
        </section>

        <section aria-label="明细表">
          <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>明细</h2>
          <div className="finance-table-wrap">
            <table className="finance-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>支出/收入</th>
                  <th>类型</th>
                  <th className="num">金额</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 && !loading && (
                  <tr>
                    <td colSpan={5} style={{ color: 'var(--text)' }}>
                      暂无记录
                    </td>
                  </tr>
                )}
                {records.map((r) =>
                  editingId === r.id && editDraft ? (
                    <tr key={r.id}>
                      <td>
                        <input
                          type="date"
                          value={editDraft.date}
                          onChange={(e) =>
                            setEditDraft((d) => ({
                              ...d,
                              date: e.target.value,
                            }))
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={editDraft.direction}
                          onChange={(e) =>
                            setEditDraft((d) => ({
                              ...d,
                              direction: e.target.value,
                            }))
                          }
                        >
                          <option value="支出">支出</option>
                          <option value="收入">收入</option>
                        </select>
                      </td>
                      <td>
                        <input
                          value={editDraft.category}
                          onChange={(e) =>
                            setEditDraft((d) => ({
                              ...d,
                              category: e.target.value,
                            }))
                          }
                        />
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={editDraft.amount}
                          onChange={(e) =>
                            setEditDraft((d) => ({
                              ...d,
                              amount: e.target.value,
                            }))
                          }
                          style={{ width: '100%', maxWidth: 120 }}
                        />
                      </td>
                      <td className="actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={saveEdit}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={cancelEdit}
                        >
                          取消
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.id}>
                      <td>{r.date}</td>
                      <td>{r.direction}</td>
                      <td>{r.category}</td>
                      <td className="num">¥{formatMoney(r.amount)}</td>
                      <td className="actions">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => startEdit(r)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => deleteRecord(r.id)}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="ticks"></div>
      <section id="spacer"></section>
    </>
  )
}
