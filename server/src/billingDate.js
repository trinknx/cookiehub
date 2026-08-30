// Localized Netflix billing-date → ISO. Netflix renders nextBillingDate in
// the account's UI language ("26 tháng 9, 2026", "23 de septiembre de 2026",
// "٢٤ أيلول ٢٠٢٦" with Arabic-Indic digits…) and Date.parse only speaks a few
// English shapes. Strategy: fold exotic digits to ASCII, strip diacritics,
// find the month by name across the languages Netflix serves (VI uses numeric
// months), then take the remaining 1–2-digit number as the day.

const foldDigits = s => s
  .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)) // Arabic-Indic
  .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0)) // Eastern Arabic-Indic

const stripDiacritics = s => s.normalize('NFD').replace(/\p{Diacritic}/gu, '')

// folded, lowercase month tokens per month. Same-month cross-language overlaps
// (juni/junio, mai/maio) are harmless; no cross-month substring pairs here.
const MONTHS = {
  1: ['january', 'janvier', 'enero', 'janeiro', 'januar', 'jänner', 'ocak', 'januari', 'styczeń', 'ianuarie', 'يناير', 'كانون الثاني'],
  2: ['february', 'février', 'febrero', 'fevereiro', 'februar', 'şubat', 'februari', 'luty', 'februarie', 'فبراير', 'شباط'],
  3: ['march', 'mars', 'marzo', 'março', 'märz', 'mart', 'maart', 'marzec', 'martie', 'مارس', 'آذار'],
  4: ['april', 'abril', 'avril', 'nisan', 'kwiecień', 'aprilie', 'أبريل', 'نيسان'],
  5: ['may', 'mai', 'mayo', 'maio', 'maj', 'mayıs', 'mei', 'مايو', 'أيار'],
  6: ['june', 'juin', 'junio', 'junho', 'juni', 'haziran', 'czerwiec', 'iunie', 'يونيو', 'حزيران'],
  7: ['july', 'juillet', 'julio', 'julho', 'juli', 'temmuz', 'lipiec', 'iulie', 'يوليو', 'تموز'],
  8: ['august', 'août', 'agosto', 'augustus', 'ağustos', 'sierpień', 'august', 'agustus', 'أغسطس', 'آب'],
  9: ['september', 'septembre', 'septiembre', 'setiembre', 'setembro', 'eylül', 'wrzesień', 'septembrie', 'سبتمبر', 'أيلول'],
  10: ['october', 'octubre', 'outubro', 'oktober', 'ekim', 'październik', 'octombrie', 'oktober', 'أكتوبر', 'تشرين الأول'],
  11: ['november', 'noviembre', 'novembro', 'november', 'kasım', 'listopad', 'noiembrie', 'نوفمبر', 'تشرين الثاني'],
  12: ['december', 'décembre', 'diciembre', 'dezembro', 'aralık', 'grudzień', 'decembrie', 'ديسمبر', 'كانون الأول']
}

export function parseBillingIso(text) {
  if (typeof text !== 'string') return null
  const s = foldDigits(text.trim())
  const year = Number(s.match(/\d{4}/)?.[0])
  if (!year || year < 2000 || year > 2100) return null
  const vi = s.match(/th[aá]ng\s*(\d{1,2})/i) // Vietnamese numeric months
  let month = vi ? Number(vi[1]) : 0
  if (!month) {
    const flat = stripDiacritics(s).toLowerCase()
    for (const [m, names] of Object.entries(MONTHS)) {
      if (names.some(n => flat.includes(stripDiacritics(n).toLowerCase()))) { month = Number(m); break }
    }
  }
  if (month < 1 || month > 12) return null
  // remaining short numbers (excluding the numeric month token and the year)
  // — the first plausible one is the day
  const nums = [...s.matchAll(/\d{1,2}(?!\d)/g)].map(x => Number(x[0]))
  const day = nums.find(n => n >= 1 && n <= 31 && !(vi && n === Number(vi[1]) && nums.filter(x => x === n).length === 1))
  if (!day) return null
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  // roundtrip validation — V8 happily rolls 31 Feb into 3 Mar instead of NaN
  const t = new Date(`${iso}T00:00:00Z`)
  return t.getUTCFullYear() === year && t.getUTCMonth() + 1 === month && t.getUTCDate() === day ? iso : null
}
