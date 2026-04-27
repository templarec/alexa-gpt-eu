const { sanitizeForAlexa, extractJsonObject } = require("./utils");

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

async function callOpenAI(
  messages,
  { temperature = 0.2, max_tokens = 180, response_format } = {},
) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY non configurata");
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      temperature,
      max_tokens,
      response_format,
    }),
  });

  const data = await response.json();

  console.log("OPENAI STATUS:", response.status);
  console.log("OPENAI DATA:", JSON.stringify(data));

  if (!response.ok) {
    const message = data?.error?.message || "Errore OpenAI";
    throw new Error(message);
  }

  const text = data?.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error("Risposta OpenAI vuota");
  }

  return text;
}

async function askChat(question, history = []) {
  const messages = [
    {
      role: "system",
      content:
        "Sei Alambicco, un assistente vocale per Alexa. Rispondi in italiano, in massimo due o tre frasi, con stile naturale parlato. Se l'utente fa un follow-up, usa il contesto precedente.",
    },
    ...history,
    {
      role: "user",
      content: question,
    },
  ];

  const text = await callOpenAI(messages, {
    temperature: 0.6,
    max_tokens: 150,
  });

  return sanitizeForAlexa(text);
}

async function analyzeMeal(mealType, mealText) {
  const prompt = `
Analizza questo evento nutrizionale in italiano.

Tipo evento: ${mealType}
Testo utente: ${mealText}

Regole:
- Interpreta quantità e unità se presenti (grammi, g, ml, cucchiai, banana media, uovo, passi, km, minuti, ecc.).
- Per alimenti e calorie usa come fonte prioritaria dati ufficiali europei/italiani CREA, quando disponibili; se il dato CREA non è disponibile, usa stime nutrizionali comuni e realistiche.
- Se una quantità manca, stimala solo se è molto implicita e comune; altrimenti segnala che manca.
- Se il tipo è "attivita", le calorie devono essere negative e protein/carbs/fat devono essere 0.
- Rispondi SOLO con JSON valido.
- Non mettere markdown.
- Usa numeri interi quando possibile.

Formato JSON obbligatorio:
{
  "meal_type": "colazione|pranzo|cena|spuntino|attivita",
  "description_normalized": "stringa sintetica",
  "missing_quantities": false,
  "items": [
    {
      "food": "string",
      "quantity": "string",
      "calories": 0,
      "protein": 0,
      "carbs": 0,
      "fat": 0
    }
  ],
  "total": {
    "calories": 0,
    "protein": 0,
    "carbs": 0,
    "fat": 0
  }
}
`;

  const raw = await callOpenAI(
    [
      {
        role: "system",
        content:
          "Sei un assistente nutrizionale preciso. Devi rispondere solo con JSON valido. Nessun testo extra. Nessun markdown.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    {
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" },
    },
  );

  console.log("ANALYZE RAW:", raw);

  let parsed;

  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch (error) {
    console.error("ANALYZE JSON PARSE ERROR:", error);
    console.error("ANALYZE RAW CONTENT:", raw);
    throw new Error("Risposta JSON nutrizionale non valida");
  }

  if (!parsed?.total || typeof parsed.total.calories !== "number") {
    console.error("ANALYZE INVALID STRUCTURE:", JSON.stringify(parsed));
    throw new Error("Analisi nutrizionale non valida");
  }

  parsed.meal_type = parsed.meal_type || mealType;
  parsed.description_normalized = parsed.description_normalized || mealText;
  parsed.missing_quantities = Boolean(parsed.missing_quantities);
  parsed.items = Array.isArray(parsed.items) ? parsed.items : [];

  parsed.total = {
    calories: Number(parsed.total.calories || 0),
    protein: Number(parsed.total.protein || 0),
    carbs: Number(parsed.total.carbs || 0),
    fat: Number(parsed.total.fat || 0),
  };

  return parsed;
}

module.exports = {
  askChat,
  analyzeMeal,
};
