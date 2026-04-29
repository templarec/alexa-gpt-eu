function getKitchenPageHtml() {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Cucina</title>
  <style>
    :root {
      --bg: #111;
      --panel: #1a1a1a;
      --panel-2: #151515;
      --text: #fff;
      --muted: #bdbdbd;
      --border: #2f2f2f;
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
      --radius: 18px;
      --gap: 20px;
      --pad: 20px;
    }

    * {
      box-sizing: border-box;
    }

    html {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      background: var(--bg);
      overflow: hidden;
    }

    body {
      width: 100%;
      height: 100%;
      min-height: 100vh;
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Arial, sans-serif;
      overflow: hidden;
      -webkit-text-size-adjust: 100%;
    }

    #app {
      width: 100vw;
      height: 100vh;
      min-height: 100vh;
      overflow: hidden;
    }

    .screen {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      padding:
        max(16px, env(safe-area-inset-top))
        max(16px, env(safe-area-inset-right))
        max(16px, env(safe-area-inset-bottom))
        max(16px, env(safe-area-inset-left));
      gap: 16px;
      overflow: hidden;
    }

    .header {
      flex: 0 0 auto;
      background: linear-gradient(180deg, #1d1d1d 0%, #151515 100%);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
      box-shadow: var(--shadow);
    }

    h1 {
      margin: 0 0 8px 0;
      font-size: clamp(22px, 3vw, 32px);
      line-height: 1.1;
    }

    .meta {
      font-size: clamp(16px, 2.2vw, 22px);
      color: #d4d4d4;
    }

    .content {
      flex: 1 1 auto;
      min-height: 0;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--gap);
      overflow: hidden;
    }

    .panel {
      min-height: 0;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: var(--pad);
      box-shadow: var(--shadow);
      overflow: auto;
    }


    h2 {
      margin: 0 0 14px 0;
      font-size: clamp(20px, 2.6vw, 30px);
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
    }

    ul, ol {
      margin: 0;
      font-size: clamp(18px, 2.5vw, 26px);
      line-height: 1.45;
      padding-left: 28px;
    }

    li {
      margin-bottom: 12px;
    }


    .footer {
      flex: 0 0 auto;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      min-height: 28px;
      color: #8f8f8f;
      font-size: clamp(13px, 1.6vw, 16px);
      padding: 0 4px;
    }

    .empty-wrap {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .empty {
      width: 100%;
      max-width: 720px;
      text-align: center;
      background: #1a1a1a;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 28px 24px;
      font-size: clamp(24px, 3.2vw, 34px);
      color: #c7c7c7;
      box-shadow: var(--shadow);
    }

    @media (max-width: 900px) {
      .content {
        grid-template-columns: 1fr;
      }

      .screen {
        gap: 14px;
      }
    }
  </style>
</head>
<body>
  <div id="app">
    <div class="empty-wrap">
      <div class="empty">Nessuna ricetta inviata alla cucina.</div>
    </div>
  </div>

  <script>
    const API_URL = "/kitchen/current";
    let lastRenderedSignature = null;

    async function loadKitchen() {
      try {
        const response = await fetch(API_URL);
        const data = await response.json();
        const state = data?.state;
        const recipe = state?.recipe;
        const app = document.getElementById("app");

        if (!recipe) {
          const emptySignature = "empty";

          if (lastRenderedSignature !== emptySignature) {
            app.innerHTML = \`
              <div class="empty-wrap">
                <div class="empty">Nessuna ricetta inviata alla cucina.</div>
              </div>
            \`;
            lastRenderedSignature = emptySignature;
          }

          return;
        }

        const currentSignature = JSON.stringify({
          updatedAt: state?.updatedAt || null,
          recipe,
        });

        if (lastRenderedSignature === currentSignature) {
          return;
        }

        lastRenderedSignature = currentSignature;

        app.innerHTML = \`
          <div class="screen">
            <div class="header">
              <h1>\${escapeHtml(recipe.title || "")}</h1>
              <div class="meta">Porzioni: \${recipe.servings ?? "-"}</div>
            </div>

            <div class="content">
              <section class="panel">
                <h2>Ingredienti</h2>
                <ul>
                  \${(recipe.ingredients || []).map(item => \`<li>\${escapeHtml(item)}</li>\`).join("")}
                </ul>
              </section>

              <section class="panel">
                <h2>Procedimento</h2>
                <ol>
                  \${(recipe.steps || []).map(step => \`<li>\${escapeHtml(step)}</li>\`).join("")}
                </ol>
              </section>
            </div>

            <div class="footer">
              Ultimo aggiornamento: \${state.updatedAt ? new Date(state.updatedAt).toLocaleString("it-IT") : "-"}
            </div>
          </div>
        \`;
      } catch (error) {
        document.getElementById("app").innerHTML = \`
          <div class="empty-wrap">
            <div class="empty">Errore nel caricamento della ricetta.</div>
          </div>
        \`;
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    loadKitchen();
    setInterval(loadKitchen, 5000);
  </script>
</body>
</html>`;
}

module.exports = {
  getKitchenPageHtml,
};
