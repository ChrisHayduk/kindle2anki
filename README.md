# Kindle2Anki

> Turn your Kindle vocabulary and highlights into an **Anki** deck – directly in your browser, 100 % offline.

---

## ✨ Why another Kindle-to-Anki tool?

The original **kindle2anki.py** script (still included!) did a great job but required Python, the command line and Anki-Connect.  This refactor ships a **zero-install, browser-only** alternative: drop two Kindle files on a webpage and download a ready-to-import `.apkg` deck.  No accounts, no servers, no data leaving your machine.

---

## Quick Start (Web Interface)

1. **Clone / Download** this repository.
2. **Export your Kindle data** (USB cable):
   * `system/Vocabulary/vocab.db` – your looked-up words.
   * `documents/My Clippings.txt` – optional highlights.
3. **Launch the webpage** – two equally simple options:
   | Option | Command | Notes |
   | ------ | ------- | ----- |
   | Double-click | _none_ | Just open `web/index.html` in Chrome/Firefox/Edge/Safari. |
   | Tiny web-server | `cd web && python3 -m http.server 8000` | Needed if your browser blocks `file://` WebAssembly. Visit <http://localhost:8000>. |
4. **Choose your Kindle files, pick a deck name, hit *Generate* and download the `.apkg`.**
5. **Import into Anki** (`File → Import…` or double-click the file) and start studying 🚀.

---

## 🔄 Live-Reload Development (Web UI)

You can now hack on the files inside the `web/` folder and have your browser refresh automatically.

1. Ensure you have **Node.js ≥14** installed.
2. Run once to install dev deps:

```bash
npm install
```

3. Start the dev server:

```bash
npm run dev
```

This launches [live-server](https://github.com/tapio/live-server) on <http://localhost:3000>.  Any change inside `web/` is picked up instantly – no manual refreshes needed – while all computations remain **100 % client-side**.

Production users can still just open `web/index.html` directly or use the tiny Python server described above.

---

## Under the Hood

| Technology | What it does |
|------------|--------------|
| **SQL.js** | Runs SQLite in WebAssembly to query `vocab.db` entirely in-browser. |
| **anki-apkg-export** | Creates a valid Anki deck database and packages it as `.apkg`. |
| **JSZip** | Zips everything together for download. |

All assets are loaded from public CDNs on first page load; afterwards the page works offline.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| *"sql.js not loaded"* | Make sure you were online the **first** time you opened the page, or serve the site via `python3 -m http.server`. |
| *No entries found* | Check that you selected the correct `vocab.db` (≈ 700 KB) and/or that your clippings file actually contains highlights. |
| Browser security warning | Run the tiny web-server method above – it avoids `file://` restrictions. |

---

## Legacy Python CLI (Optional)

The historical CLI remains for power users.  Example:

```bash
pip install -r requirements.txt
./kindle2anki.py --vocab-db /path/to/vocab.db --deck "Kindle Words" --no-ask
```

See `./kindle2anki.py --help` for full options.

---

## Contributing

Pull requests are welcome!  Feel free to open an issue if you find a bug or have an idea.

---

## License

This project is licensed under the terms of the **MIT License**.  See `LICENSE` for details. 