import type { Register } from 'claude-code'

/**
 * word-mask v0.7: モデル境界での双方向ワード変換 mod
 *
 * v0.7 の変更（2026-11-20）:
 *   - guard-config.json の wordMasking.restoreBy が "guard" のプロジェクトでは、
 *     Write・NotebookEdit・Bash・PowerShell・Monitor の入力を
 *     この mod では実名に戻さず、ガードのフック（.claude/hooks/word_mask_restore.py）に任せる。
 *     自動モードでは、mod が入力を書き換えると「審査した入力と違う」として呼び出しが止められ、
 *     拒否文に実名が載るため（設定のフックの書き換えは止められない。2026-11-20 実測）。
 *   - 失敗した結果（isError）・止められたときの知らせに実名があれば、仮名にした文を拒否として返す。
 *   - 別のチャットから届くメッセージ（session.receive）の本文を仮名にする。
 * v0.7.1（2026-11-24）: 対応表（word-mask.config.json）が mod のフォルダーに無ければ、
 *   各PCの決まった場所（~/.claude/mods/word-mask/word-mask.config.json）を読む。
 *   組織の mod（appendPlugins）として配った写しでも、各PCの対応表を使えるようにするため。
 * v0.7.2（2026-11-25）: 別の AI に宛てた文を実名に戻さない。
 *   - サブエージェントの報告（SubagentHandback）・別のチャットへのメッセージ（SendMessage 等）の入力は
 *     実名に戻さない（戻すと、親の会話・送り先の会話のモデルへ実名が届いていた。11/25 試験で確認）。
 *   - サブエージェントの報告が親へ渡る直前（agent.report）にも、報告文を仮名にする（旧版の mod が
 *     報告を実名に戻していても、親には仮名で届くように）。
 *
 * モデル（Anthropic サーバー）へ入る側はすべて 実名(from)→仮名(to) へ変換し、
 * モデルから出る側はすべて 仮名(to)→実名(from) へ復元する。
 *
 *   [入る側＝サーバーへ送られる内容]
 *   - prompt.submit        : プロンプト本文・添付コンテキスト
 *   - prompt.compose       : システムプロンプトの全セクション
 *   - prompt.context       : 最初のメッセージに付く文脈（CLAUDE.md と @ で取り込んだ
 *                            ファイル・git status・作業フォルダ等。v0.6〜）
 *   - prompt.attachment    : 途中で差し込まれる通知（起動時フックの出力・リマインダー等。v0.6〜）
 *   - skill.prompt         : スキルの本文（v0.6〜）
 *   - tool.call の結果     : Read/Bash/Grep/MCP 等、全ツールの実行結果
 *   - tool.call の deny 文 : ガード等の拒否メッセージ（実パスを含むことがある）
 *   ※ 実名・仮名の別表記（git の 8 進表記・JSON の \u 表記・URL の %XX 表記）も置き換える（v0.6〜）
 *   [出る側＝モデルの出力が実世界・画面に触れる点]
 *   - tool.call の入力     : 書き込むファイル内容・コマンド・パス等
 *                            → ディスク上のファイルには常に実名が書かれる
 *   - classic.MessageDisplay: アシスタント出力の画面表示
 *
 * 対称変換のため、モデルは一貫して仮名の世界だけを見る：
 *   実名のファイルを読む → 結果は仮名化されてモデルへ → モデルが仮名でパスや
 *   old_string を指定 → 入力側で実名に戻って実ファイルに一致する。
 *
 * 設定（v0.4 で2ファイルに分離、v0.5 で対応表をプロジェクトごとに分離）:
 *   - ON/OFF・マスタースイッチ : プロジェクトの .claude/hooks/guard-config.json
 *   - 対応表（pairs）          : この mod と同じフォルダの word-mask.config.json の
 *                                projects[<プロジェクトのフォルダ>].wordMasking.pairs
 *                                （プロジェクト外。AIのツール呼び出しからはガードが
 *                                  読み書きとも拒否し、対応表そのものをAIへ送らない）
 *   - プロジェクトはセッションの作業フォルダで決まる（サブフォルダで起動しても同じ表）
 *   - 編集はどちらも「設定を開く.bat」の設定画面から。毎回読み直すため保存で即反映。
 *   - そのプロジェクトの表が word-mask.config.json に無い場合は guard-config.json 内の
 *     pairs を使う（未移行プロジェクトの互換。設定画面を一度開けば自動で移行される）
 *   - v0.4 までの形式（全プロジェクト共通の表）は、移行されるまで従来どおり使う
 *   - 移行後も旧形式の位置に旧版 mod 向けの写し（全プロジェクトの表を合わせたもの・
 *     legacyMirror）を設定画面が置く。再起動前の会話で動き続ける旧版のマスキングを
 *     止めないため。本版は projects があれば写しを読まない
 *   - 読み込み失敗時は直前の設定を維持する（変換の突然停止を防ぐ）。
 *
 * 既知の限界:
 * - 仮名(to)は一意な文字列にすること（自然文に出る語だと誤変換する）
 * - エラー結果（isError）は、実名を含むときだけ仮名にした文を拒否として返す（v0.7〜）。
 *   実名を含まないエラーは形を崩さないようそのまま返す
 * - サブエージェント起動(Agent/Task)の指示文は仮名のまま渡す（そのサブ
 *   エージェント内のツール往復も本フックが同様に変換する）
 * - word-mask.config.json 自体・mod 本体（word-mask / dev-mods 配下）を触る
 *   ツール呼び出しは変換対象外（設定・mod 本体の破壊防止）。guard-config.json は
 *   v0.4 から通常どおり変換対象（対応表が外部化されたため除外する理由が消えた）
 */

type Pair = { from: string; to: string }

const CONFIG_RELPATH = '.claude/hooks/guard-config.json'
// 対応表の分離先（mod 自身のフォルダ直下 = ~/.claude/mods/word-mask/word-mask.config.json）
const EXTERNAL_CONFIG_BASENAME = 'word-mask.config.json'

// 入力側の逆変換をしないツール（指示文がモデル側＝仮名世界に留まるもの）
// v0.7.2: 別の AI に宛てた文（サブエージェントの報告・別のチャットへのメッセージ）も仮名のまま渡す
const INPUT_UNMASK_EXCLUDED_TOOLS = new Set([
  'Agent',
  'Task',
  'SubagentHandback',
  'SendMessage',
  'mcp__ccd_session_mgmt__send_message',
])

// tool.call 入力の予約キー（書き換えが拒否される／意味を持つため触らない）
const RESERVED_INPUT_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

// restoreBy=guard のとき、入力の実名への復元をガードのフックに任せるツール
// （.claude/hooks/word_mask_restore.py の GUARD_RESTORED_TOOLS と同じ範囲にすること）
const GUARD_RESTORED_TOOLS = new Set(['Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor'])

/** restoreBy=guard のとき、このツールの入力の復元をガードが受け持つか。
 *  公式資料が「設定のフックが拒否されずに入力を変えられる」とするツールに限る。
 *  MCP のツール（ターミナル操作など）は対象外で、これまでどおりこの mod が戻す（2026-11-24 見直し） */
export function guardRestores(tool: string): boolean {
  return GUARD_RESTORED_TOOLS.has(tool)
}

let enabled = false
let restoreBy: 'mod' | 'guard' = 'mod' // 入力の実名への復元をどちらが受け持つか（guard-config.json）
let pairs: Pair[] = []           // 実際に使う対応表（external 優先）
let outPairs: Pair[] = []        // 送信方向で使う組（pairs＋別表記。from の長い順）
let inPairs: Pair[] = []         // 復元方向で使う組（pairs＋別表記。to の長い順）
let fallbackPairs: Pair[] = []   // guard-config.json 内の旧 pairs（未移行互換）
let externalPairs: Pair[] | null = null // word-mask.config.json の pairs（null = 読めていない）

function sanitizePairs(raw: unknown): Pair[] {
  if (!Array.isArray(raw)) return []
  const out: Pair[] = []
  for (const p of raw) {
    const rec = p as { from?: unknown; to?: unknown }
    if (
      rec &&
      typeof rec.from === 'string' && rec.from.length > 0 &&
      typeof rec.to === 'string' && rec.to.length > 0 &&
      rec.from !== rec.to
    ) {
      out.push({ from: rec.from, to: rec.to })
    }
  }
  return out
}

/** UTF-8 のバイト列（非 ASCII の 1 文字分）。encodeURIComponent の %XX から得る */
function utf8Bytes(ch: string): number[] {
  return encodeURIComponent(ch).split('%').filter(Boolean).map((h) => parseInt(h, 16))
}

/** 同じ語が別の表記で現れる形。文字列一致では見つからないため、組ごとに足して置き換える。
 *  - git: core.quotepath の既定で、日本語のパスを UTF-8 の各バイトの 8 進表記（\346\274\217）で出す
 *  - JSON: ensure_ascii（Python の既定）で 漏 の形（小文字・大文字）
 *  - URL: %E6%BC%8F の形（大文字・小文字）
 *  実名と仮名で同じ位置どうしを組にするため、作れない表記は null で位置を保つ。 */
export function escapedForms(s: string): (string | null)[] {
  const forms: (string | null)[] = [null, null, null, null, null]
  try {
    if (!/["\\\x00-\x1f]/.test(s)) {
      let oct = ''
      for (const ch of s) {
        oct += ch.charCodeAt(0) < 0x80
          ? ch
          : utf8Bytes(ch).map((b) => '\\' + b.toString(8).padStart(3, '0')).join('')
      }
      forms[0] = oct
    }
  } catch {
    // 不正なサロゲート等はこの表記を作らない
  }
  let u = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    u += c < 0x80 ? s.charAt(i) : '\\u' + c.toString(16).padStart(4, '0')
  }
  forms[1] = u
  forms[2] = u.replace(/\\u([0-9a-f]{4})/g, (_m, h: string) => '\\u' + h.toUpperCase())
  try {
    const pct = encodeURIComponent(s)
    forms[3] = pct
    forms[4] = pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())
  } catch {
    // 同上
  }
  return forms
}

function recomputePairs(): void {
  // 外部ファイルが読めていればそれが正（空配列も正）。無ければ guard-config 内の pairs。
  pairs = externalPairs !== null ? externalPairs : fallbackPairs
  const out: Pair[] = [...pairs]
  const back: Pair[] = [...pairs]
  const seenFrom = new Set(pairs.map((p) => p.from))
  for (const p of pairs) {
    const fs = escapedForms(p.from)
    const ts = escapedForms(p.to)
    fs.forEach((f, i) => {
      const t = ts[i]
      if (f === null || t === null || t === undefined || f === p.from || seenFrom.has(f) || f === t) return
      seenFrom.add(f)
      out.push({ from: f, to: t })
      // 仮名が ASCII だけだと別表記が仮名そのものと同じになる。その組は復元に使わない
      // （使うと、普通に書かれた仮名まで 8 進表記の実名に戻してしまう）
      if (t !== p.to) back.push({ from: f, to: t })
    })
  }
  outPairs = out.sort((a, b) => b.from.length - a.from.length)
  inPairs = back.sort((a, b) => b.to.length - a.to.length)
}

/** guard-config.json の文字列から ON/OFF と互換用 pairs を取り込む（テストからも使う） */
export function applyConfigText(text: string): void {
  const cfg = JSON.parse(text) as {
    master?: { enabled?: unknown }
    wordMasking?: { enabled?: unknown; pairs?: unknown; restoreBy?: unknown }
  }
  // マスタースイッチOFFはワードマスキングも停止（ガード・メール取込と同じ扱い）
  const masterOn = cfg?.master?.enabled !== false
  const wm = cfg?.wordMasking
  enabled = masterOn && !!wm && wm.enabled === true
  restoreBy = wm?.restoreBy === 'guard' ? 'guard' : 'mod'
  fallbackPairs = sanitizePairs(wm?.pairs)
  recomputePairs()
}

/** 今の設定で、このツールの入力を mod が実名に戻すか（テストからも使う） */
export function modRestoresInput(tool: string): boolean {
  if (INPUT_UNMASK_EXCLUDED_TOOLS.has(tool)) return false
  return !(restoreBy === 'guard' && guardRestores(tool))
}

/** パス比較用の正規化（区切りを \ に統一・末尾の区切りを除去・小文字化）。
 *  設定サーバー・メール取込（Python の os.path.normcase）と同じキーになるようにする。 */
export function normalizeRoot(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

type ProjectEntry = { wordMasking?: { pairs?: unknown } }

/** projectRoot と同じか、その親にあたるキーのうち最も長いもの */
function findProjectEntry(projects: Record<string, ProjectEntry>, projectRoot: string): ProjectEntry | undefined {
  const root = normalizeRoot(projectRoot)
  let bestKey: string | null = null
  let bestLen = -1
  for (const key of Object.keys(projects)) {
    const k = normalizeRoot(key)
    if ((root === k || root.startsWith(k + '\\')) && k.length > bestLen) {
      bestKey = key
      bestLen = k.length
    }
  }
  return bestKey === null ? undefined : projects[bestKey]
}

/** word-mask.config.json の文字列から projectRoot の対応表を取り込む。null = ファイルが読めない */
export function applyExternalText(text: string | null, projectRoot = ''): void {
  if (text === null) {
    externalPairs = null
    recomputePairs()
    return
  }
  const cfg = JSON.parse(text) as {
    projects?: unknown
    wordMasking?: { pairs?: unknown }
  }
  if (cfg && typeof cfg.projects === 'object' && cfg.projects !== null) {
    const entry = findProjectEntry(cfg.projects as Record<string, ProjectEntry>, projectRoot)
    // このプロジェクトの表が無ければ null（＝guard-config 内 pairs の互換へ）
    externalPairs = entry ? sanitizePairs(entry.wordMasking?.pairs) : null
  } else {
    // v0.4 までの形式（全プロジェクト共通の表）
    externalPairs = sanitizePairs(cfg?.wordMasking?.pairs)
  }
  recomputePairs()
}

/** 各PCで対応表を置く決まった場所（ホームフォルダー基準）。組織の mod として配った写しから読むため（v0.7.1〜） */
export function sharedConfigPath(home: string): string {
  return `${home.replace(/[\\/]+$/, '')}/.claude/mods/word-mask/${EXTERNAL_CONFIG_BASENAME}`
}

/** 対応表のファイルの場所。mod のフォルダーにあればそれ、無ければ各PCの決まった場所。どちらも無ければ null。
 *  組織の mod として入れた写しは、mod のフォルダーが配布物の写し（対応表を置かない）なので、決まった場所を読む */
async function externalConfigPath($: {
  fs: { exists: (path: string) => Promise<boolean> }
  plugin: { root: string }
  env: { get: (name: string) => Promise<string | undefined> }
}): Promise<string | null> {
  const own = `${$.plugin.root}/${EXTERNAL_CONFIG_BASENAME}`
  if (await $.fs.exists(own)) return own
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return null
  const shared = sharedConfigPath(home)
  return (await $.fs.exists(shared)) ? shared : null
}

async function loadConfig($: {
  fs: { read: (path: string) => Promise<string>; exists: (path: string) => Promise<boolean> }
  plugin: { root: string }
  session: { cwd: () => Promise<string> }
  env: { get: (name: string) => Promise<string | undefined> }
}): Promise<void> {
  try {
    applyConfigText(await $.fs.read(CONFIG_RELPATH))
  } catch {
    // 読めないときは直前の設定を維持（起動直後に読めなければ無効のまま）
  }
  try {
    const externalPath = await externalConfigPath($)
    if (externalPath !== null) {
      const projectRoot = await $.session.cwd()
      // JSON が壊れていれば throw → 直前の対応表を維持（変換の突然停止を防ぐ）
      applyExternalText(await $.fs.read(externalPath), projectRoot)
    } else {
      // ファイルが無い＝未移行プロジェクト → guard-config 内の pairs にフォールバック
      applyExternalText(null)
    }
  } catch {
    // 読めない／壊れているときは直前の対応表を維持
  }
}

function replaceAllPlain(text: string, from: string, to: string): string {
  return text.split(from).join(to)
}

/** 送信方向: from → to（長い from から先に置換して部分一致の崩れを防ぐ。別表記も含む） */
export function maskOut(text: string): string {
  let out = text
  for (const p of outPairs) {
    out = replaceAllPlain(out, p.from, p.to)
  }
  return out
}

/** 復元方向: to → from（長い to から先に置換。別表記も含む） */
export function unmaskIn(text: string): string {
  let out = text
  for (const p of inPairs) {
    out = replaceAllPlain(out, p.to, p.from)
  }
  return out
}

/** 値の中のすべての文字列に f を適用（変更が無ければ同じ参照を返す） */
export function transformDeep(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === 'string') {
    const t = f(value)
    return t === value ? value : t
  }
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((v) => {
      const t = transformDeep(v, f)
      if (t !== v) changed = true
      return t
    })
    return changed ? out : value
  }
  if (value && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const t = transformDeep(v, f)
      if (t !== v) changed = true
      out[k] = t
    }
    return changed ? out : value
  }
  return value
}

/** tool.call 入力の予約キーを除いた全フィールドに f を適用 */
function transformToolInput(e: Record<string, unknown>, f: (s: string) => string): Record<string, unknown> {
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) {
    if (RESERVED_INPUT_KEYS.has(k)) {
      out[k] = v
      continue
    }
    const t = transformDeep(v, f)
    if (t !== v) changed = true
    out[k] = t
  }
  return changed ? out : e
}

/** mod 本体・対応表ファイルを触る呼び出しは変換しない（自己破壊防止）。
 *  対象は対応表ファイルと、mod を置くフォルダ（mods/word-mask・dev-mods）だけ。
 *  v0.5 までは「word-mask」という語を含むだけで変換を止めていたため、word-mask について
 *  書く・調べるだけで、書込先のパスが仮名のまま・結果が実名のまま送られていた（v0.6 で修正）。
 *  guard-config.json は v0.4 から除外しない：対応表が外部化され、残る内容
 *  （ON/OFF・例外パス等）は通常の対称変換で一貫するため。 */
export function touchesOwnFiles(e: unknown): boolean {
  try {
    const s = JSON.stringify(e)
    return s.includes('word-mask.config.json') || /mods[\\/]+word-mask/i.test(s) || s.includes('dev-mods')
  } catch {
    return true
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await loadConfig($)
    return next(e)
  })

  // ── 入る側①: プロンプト本文・添付コンテキスト（スラッシュコマンド行は対象外）
  on('prompt.submit', async ($, e, next) => {
    await loadConfig($) // 毎回読み直す＝設定画面で保存すれば次の送信から反映
    if (e.command || !enabled || pairs.length === 0) return next(e)
    const maskedText = maskOut(e.text)
    const maskedContext = e.context ? transformDeep(e.context, maskOut) : e.context
    if (maskedText === e.text && maskedContext === e.context) return next(e)
    const out = { ...e, text: maskedText }
    if (e.context) (out as Record<string, unknown>).context = maskedContext
    return next(out)
  }).catch(($, e, next) => next(e)) // フック失敗時は素通し（送信を止めない）

  // ── 入る側②: システムプロンプトの全セクション（CLAUDE.md 等を含む）
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!enabled || pairs.length === 0) return r
    let changed = false
    const sections = r.sections.map((s) => {
      const t = maskOut(s.text)
      if (t === s.text) return s
      changed = true
      return { ...s, text: t }
    })
    return changed ? { sections } : r
  }).catch(($, e, next) => next(e))

  // ── 入る側③: 会話の最初のメッセージに付く文脈（CLAUDE.md と @ で取り込んだファイル・
  //    git status・作業フォルダ等）。デスクトップアプリではシステムプロンプトではなくこちらに載る
  on('prompt.context', async ($, e, next) => {
    await loadConfig($)
    const r = await next(e)
    if (!enabled || pairs.length === 0) return r
    let changed = false
    const blocks = r.blocks.map((b) => {
      const t = maskOut(b.text)
      if (t === b.text) return b
      changed = true
      return { ...b, text: t }
    })
    return changed ? { blocks } : r
  }).catch(($, e, next) => next(e))

  // ── 入る側④: 会話の途中で差し込まれる通知（起動時フックの出力・作業フォルダの変更・
  //    リマインダー・@ で指定したファイル等）
  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    if (!enabled || pairs.length === 0 || typeof r.text !== 'string') return r
    const t = maskOut(r.text)
    return t === r.text ? r : { text: t }
  }).catch(($, e, next) => next(e))

  // ── 入る側⑤: スキルの本文（スキルのフォルダのパスを含む）
  on('skill.prompt', async ($, e, next) => {
    await loadConfig($)
    const r = await next(e)
    if (!enabled || pairs.length === 0) return r
    const t = maskOut(r.text)
    return t === r.text ? r : { text: t }
  }).catch(($, e, next) => next(e))

  // ── 境界: ツール入力を実名へ戻し（出る側）、結果を仮名へ変換（入る側）
  on('tool.call', async ($, e, next) => {
    await loadConfig($)
    if (!enabled || pairs.length === 0) return next(e)
    if (touchesOwnFiles(e)) return next(e)

    const toolName = String((e as { tool?: unknown }).tool ?? '')
    // restoreBy=guard のプロジェクトでは、書込み・コマンドの入力はガードのフックが実名に戻す
    const input = modRestoresInput(toolName)
      ? (transformToolInput(e as unknown as Record<string, unknown>, unmaskIn) as unknown as typeof e)
      : e

    const r = await next(input)

    const rr = r as { deny?: unknown; isError?: true; result?: unknown; context?: readonly string[]; text?: unknown }
    if (!r) return r
    // 拒否メッセージも仮名化する（ガードの deny 文は実パスを含むことがある）
    if (rr.deny !== undefined) {
      if (typeof rr.deny !== 'string') return r
      const maskedDeny = maskOut(rr.deny)
      return maskedDeny === rr.deny ? r : ({ deny: maskedDeny } as typeof r)
    }
    // エラー結果（自動モードで止められたときの知らせ・ガードの拒否・失敗したコマンド）：
    // 実名が無ければそのまま返す（形を崩さない）。実名があれば、仮名にした文を拒否として返す（v0.7〜）
    if (rr.isError) {
      if (typeof rr.text !== 'string') return r
      const maskedText = maskOut(rr.text)
      return maskedText === rr.text ? r : ({ deny: maskedText } as typeof r)
    }

    const maskedResult = transformDeep(rr.result, maskOut)
    const maskedContext = rr.context ? (transformDeep(rr.context, maskOut) as readonly string[]) : undefined
    if (maskedResult === rr.result && maskedContext === rr.context) return r

    // ref/text を持たない「フック自身の結果」を返す
    // → core がツール自身のマッパーで整形し直し、モデルは仮名化済みの結果を読む
    const out: { result: unknown; context?: readonly string[] } = { result: maskedResult }
    if (maskedContext !== undefined) out.context = maskedContext
    return out as typeof r
  }).catch(($, e, next) => next(e))

  // ── 入る側⑥: 別のチャットから届くメッセージ（司令塔からの指示など。v0.7〜）
  //    prompt.submit を通らずに届くため、ここで仮名にする
  on('session.receive', async ($, e, next) => {
    await loadConfig($)
    if (!enabled || pairs.length === 0 || typeof e.text !== 'string') return next(e)
    const t = maskOut(e.text)
    return t === e.text ? next(e) : next({ ...e, text: t })
  }).catch(($, e, next) => next(e))

  // ── 入る側⑦: サブエージェントの報告（v0.7.2〜）
  //    報告は SubagentHandback の入力や最後の文として親へ渡る。親の会話に入る直前にここで仮名にする。
  //    next(e) は自動モードの審査を返すだけで、届くのは一番外側のフックが返す text
  on('agent.report', async ($, e, next) => {
    await loadConfig($)
    if (!enabled || pairs.length === 0 || typeof e.text !== 'string') return next(e)
    const masked = maskOut(e.text)
    const r = await next(masked === e.text ? e : { ...e, text: masked })
    if (!r || typeof (r as { text?: unknown }).text !== 'string') return r
    const rt = (r as { text: string }).text
    const out = maskOut(rt)
    return out === rt ? r : ({ ...r, text: out } as typeof r)
  }).catch(($, e, next) => next(e))

  // ── 出る側: 画面表示のみ to → from に復元（保存内容・モデル側はそのまま）
  on('classic.MessageDisplay', async ($, e, next) => {
    const r = await next(e)
    if (!enabled || pairs.length === 0) return r
    const prior = r as { displayContent?: unknown } | undefined
    const base = prior && typeof prior.displayContent === 'string' ? prior.displayContent : e.delta
    const restored = unmaskIn(base)
    if (restored === base) return r
    return { ...(r ?? {}), displayContent: restored }
  })
}
