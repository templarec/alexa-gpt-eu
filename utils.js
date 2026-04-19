function getDateTimeParts(timeZone = "Europe/Rome") {
  const now = new Date();

  const dateFormatter = new Intl.DateTimeFormat("it-IT", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const timeFormatter = new Intl.DateTimeFormat("it-IT", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const dateParts = dateFormatter.formatToParts(now);
  const timeParts = timeFormatter.formatToParts(now);

  const day = dateParts.find((p) => p.type === "day")?.value;
  const month = dateParts.find((p) => p.type === "month")?.value;
  const year = dateParts.find((p) => p.type === "year")?.value;
  const hour = timeParts.find((p) => p.type === "hour")?.value;
  const minute = timeParts.find((p) => p.type === "minute")?.value;

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`
  };
}

function sanitizeForAlexa(text) {
  return String(text)
    .replace(/[*_#`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .trim()
    .slice(0, 700);
}

function stripCodeFences(text) {
  return String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObject(text) {
  const cleaned = stripCodeFences(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("JSON non trovato nella risposta");
  }

  return cleaned.slice(start, end + 1);
}

module.exports = {
  getDateTimeParts,
  sanitizeForAlexa,
  extractJsonObject
};