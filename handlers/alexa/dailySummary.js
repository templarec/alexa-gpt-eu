const Alexa = require("ask-sdk-core");
const { TIMEZONE, LORENZO_TDEE } = require("../../config");
const { getTodayDietReport } = require("../../sheets");

function getDateTimeParts(timeZone) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const date = formatter.format(now);

  return { date };
}

const DailySummaryIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === "DailySummaryIntent"
    );
  },
  async handle(handlerInput) {
    try {
      const { date } = getDateTimeParts(TIMEZONE);
      const report = await getTodayDietReport(date);
      const { summary, meals } = report;
      const remainingTarget = Number(summary.remaining || 0);
      const realDeficit = LORENZO_TDEE - Number(summary.net || 0);

      if (meals.length === 0) {
        return handlerInput.responseBuilder
          .speak("Oggi non ho ancora eventi registrati.")
          .reprompt(
            "Puoi dirmi, per esempio, colazione 170 grammi di yogurt greco e una banana.",
          )
          .getResponse();
      }

      const activityAbs = Math.abs(Math.round(summary.activity));

      let targetMessage;
      if (remainingTarget > 0) {
        targetMessage = `Ti restano circa ${Math.round(remainingTarget)} calorie rispetto al target dieta.`;
      } else {
        targetMessage = `Hai superato il target dieta di circa ${Math.abs(Math.round(remainingTarget))} calorie.`;
      }

      const realDeficitMessage = `Il deficit reale rispetto al T D E E è circa ${Math.round(realDeficit)} calorie.`;

      const speechText =
        `Oggi hai registrato ${meals.length} eventi. ` +
        `Calorie ingerite: ${Math.round(summary.intake)}. ` +
        `Calorie bruciate in attività: ${activityAbs}. ` +
        `Bilancio netto: ${Math.round(summary.net)}. ` +
        `Proteine: ${Math.round(summary.protein)} grammi. ` +
        `Carboidrati: ${Math.round(summary.carbs)} grammi. ` +
        `Grassi: ${Math.round(summary.fat)} grammi. ` +
        targetMessage +
        ` ` +
        realDeficitMessage;

      return handlerInput.responseBuilder
        .speak(speechText)
        .reprompt("Puoi registrare un altro pasto oppure farmi una domanda.")
        .getResponse();
    } catch (error) {
      console.error("Errore DailySummaryIntent:", error);

      return handlerInput.responseBuilder
        .speak("C'è stato un problema nel recuperare il riepilogo.")
        .reprompt("Riprova tra poco.")
        .getResponse();
    }
  },
};

module.exports = {
  DailySummaryIntentHandler,
};
