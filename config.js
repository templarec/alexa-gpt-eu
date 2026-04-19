const TIMEZONE = process.env.TIMEZONE || "Europe/Rome";
const LORENZO_TDEE = Number(process.env.LORENZO_TDEE || 2350);
const DAILY_TARGET = Number(process.env.DAILY_TARGET || 1750);

module.exports = {
  TIMEZONE,
  LORENZO_TDEE,
  DAILY_TARGET
};