export function dayOf(isoTimestamp) {
  return String(isoTimestamp).slice(0, 10);
}

export function todayUtc(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function daysAgoUtc(date, n) {
  const d = new Date(date.getTime() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
