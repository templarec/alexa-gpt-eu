function parseSheetNumber(value) {
  if (value == null || value === "") {
    return 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const normalized = String(value).trim().replace(/\./g, "").replace(",", ".");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundNumber(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function parseIsoDate(dateString) {
  const value = String(dateString || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function getLastNDatesInclusive(endDateString, daysCount, options = {}) {
  const endDate = parseIsoDate(endDateString);

  if (!endDate || !daysCount || daysCount < 1) {
    return [];
  }

  const includeEndDate = options.includeEndDate !== false;
  const effectiveEndDate = new Date(endDate);

  if (!includeEndDate) {
    effectiveEndDate.setUTCDate(effectiveEndDate.getUTCDate() - 1);
  }

  const dates = [];

  for (let i = daysCount - 1; i >= 0; i--) {
    const current = new Date(effectiveEndDate);
    current.setUTCDate(current.getUTCDate() - i);
    dates.push(formatIsoDate(current));
  }

  return dates;
}

function getDiffDays(startDateString, endDateString) {
  const start = parseIsoDate(startDateString);
  const end = parseIsoDate(endDateString);

  if (!start || !end) {
    return 0;
  }

  const diffMs = end.getTime() - start.getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

module.exports = {
  parseSheetNumber,
  roundNumber,
  parseIsoDate,
  formatIsoDate,
  getLastNDatesInclusive,
  getDiffDays,
};
