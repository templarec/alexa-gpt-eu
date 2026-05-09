function getSilviaPageHtml() {
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Porzione Silvia</title>

  <style>
    :root {
      color-scheme: dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #111827;
      color: #f9fafb;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at top, #1f2937 0, #111827 45%, #030712 100%);
      display: flex;
      align-items: stretch;
      justify-content: center;
    }

    main {
      width: min(920px, 100%);
      padding: 24px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .card {
      background: rgba(17, 24, 39, 0.88);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 22px;
      padding: 20px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.35);
    }

    h1 {
      margin: 0 0 8px;
      font-size: clamp(26px, 5vw, 44px);
      line-height: 1.05;
    }

    .subtitle {
      color: #cbd5e1;
      font-size: clamp(15px, 2.5vw, 20px);
    }

    .macro-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
    }

    .macro {
      background: rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 12px;
      text-align: center;
    }

    .macro strong {
      display: block;
      font-size: clamp(22px, 4vw, 34px);
    }

    .macro span {
      color: #cbd5e1;
      font-size: 14px;
    }

    h2 {
      margin: 0 0 12px;
      font-size: clamp(20px, 3vw, 28px);
    }

    ul {
      margin: 0;
      padding-left: 24px;
      font-size: clamp(18px, 3vw, 26px);
      line-height: 1.45;
    }

    textarea {
      width: 100%;
      min-height: 150px;
      box-sizing: border-box;
      border: 0;
      border-radius: 16px;
      padding: 14px;
      font-size: 18px;
      line-height: 1.35;
      resize: vertical;
      background: rgba(255,255,255,0.95);
      color: #111827;
    }

    button {
      margin-top: 10px;
      width: 100%;
      border: 0;
      border-radius: 16px;
      padding: 14px 18px;
      font-size: 18px;
      font-weight: 700;
      background: #f9fafb;
      color: #111827;
    }

    .footer {
      color: #94a3b8;
      font-size: 13px;
      text-align: center;
    }

    .empty {
      color: #cbd5e1;
      font-size: 20px;
    }

    @media (max-width: 640px) {
      main { padding: 14px; }
      .macro-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>

<body>
  <main id="app">
    <section class="card empty">
      Caricamento porzione Silvia...
    </section>
  </main>

  <script>
    let lastSignature = null;

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    async function copyText() {
      const textarea = document.getElementById("mfpText");

      if (!textarea) return;

      await navigator.clipboard.writeText(textarea.value);

      const button = document.getElementById("copyButton");

      if (button) {
        button.textContent = "Copiato";

        setTimeout(() => {
          button.textContent = "Copia per MyFitnessPal";
        }, 1400);
      }
    }

    function render(state) {
      const payload = state?.payload;
      const app = document.getElementById("app");

      if (!payload) {
        app.innerHTML =
          '<section class="card empty">Nessuna porzione Silvia disponibile.</section>';

        return;
      }

      const ingredients = Array.isArray(payload.ingredients)
        ? payload.ingredients
        : [];

      const mfpText =
        payload.myfitnesspal_text ||
        ingredients.join("\\n");

      const notesHtml = payload.notes
        ? '<section class="card"><h2>Note</h2><div class="subtitle">' +
            escapeHtml(payload.notes) +
          "</div></section>"
        : "";

      app.innerHTML =
        '<section class="card">' +
          '<h1>' +
            escapeHtml(payload.title || "Porzione Silvia") +
          '</h1>' +
          '<div class="subtitle">' +
            escapeHtml(payload.servings || "Porzione Silvia") +
          '</div>' +
        '</section>' +

        '<section class="macro-grid">' +
          '<div class="macro"><strong>' +
            Math.round(Number(payload.calories || 0)) +
          '</strong><span>kcal</span></div>' +

          '<div class="macro"><strong>' +
            Math.round(Number(payload.protein || 0)) +
          'g</strong><span>proteine</span></div>' +

          '<div class="macro"><strong>' +
            Math.round(Number(payload.carbs || 0)) +
          'g</strong><span>carboidrati</span></div>' +

          '<div class="macro"><strong>' +
            Math.round(Number(payload.fat || 0)) +
          'g</strong><span>grassi</span></div>' +
        '</section>' +

        '<section class="card">' +
          '<h2>Ingredienti</h2>' +
          '<ul>' +
            ingredients
              .map((item) =>
                '<li>' + escapeHtml(item) + '</li>'
              )
              .join("") +
          '</ul>' +
        '</section>' +

        '<section class="card">' +
          '<h2>Testo MyFitnessPal</h2>' +
          '<textarea id="mfpText" readonly>' +
            escapeHtml(mfpText) +
          '</textarea>' +
          '<button id="copyButton" onclick="copyText()">' +
            'Copia per MyFitnessPal' +
          '</button>' +
        '</section>' +

        notesHtml +

        '<div class="footer">' +
          'Ultimo aggiornamento: ' +
          escapeHtml(state.updatedAt || "-") +
        '</div>';
    }

    async function load() {
      try {
        const response = await fetch(
          "/silvia/current",
          { cache: "no-store" }
        );

        const state = await response.json();

        const signature = JSON.stringify(state);

        if (signature !== lastSignature) {
          lastSignature = signature;
          render(state);
        }
      } catch (error) {
        document.getElementById("app").innerHTML =
          '<section class="card empty">Errore nel caricamento.</section>';
      }
    }

    load();

    setInterval(load, 5000);
  </script>
</body>
</html>`;
}

module.exports = {
  getSilviaPageHtml,
};
