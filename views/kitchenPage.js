function getKitchenPageHtml() {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Cucina</title>
</head>
<body>
  <div id="app">
    <div>Nessuna ricetta inviata alla cucina.</div>
  </div>

  <script>
    const API_URL = "/kitchen/current";

    async function loadKitchen() {
      try {
        const response = await fetch(API_URL);
        const data = await response.json();
        const state = data?.state;
        const recipe = state?.recipe;
        const app = document.getElementById("app");

        if (!recipe) {
          app.innerHTML = "<div>Nessuna ricetta inviata alla cucina.</div>";
          return;
        }

        app.innerHTML = \`
          <h1>\${escapeHtml(recipe.title || "")}</h1>
          <p>Porzioni: \${recipe.servings ?? "-"}</p>
        \`;
      } catch (error) {
        document.getElementById("app").innerHTML =
          "<div>Errore nel caricamento della ricetta.</div>";
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
