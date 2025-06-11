// Kindle2Anki Web App
// All processing is done 100% client-side.
// Dependencies (loaded via CDN in index.html):
//  - sql.js (SQLite in WebAssembly)
//  - jszip (Zip creation)
//  - anki-apkg-export (for packaging .apkg)
//
// Author: Refactor by AI assistant

(function () {
    // DOM elements
    const vocabInput = document.getElementById('vocab-db');
    const clippingsInput = document.getElementById('clippings-file');
    const deckNameInput = document.getElementById('deck-name');
    const generateBtn = document.getElementById('generate-btn');
    const statusEl = document.getElementById('status');
    const downloadLink = document.getElementById('download-link');
    // Filter inputs
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');
    const bookFilterInput = document.getElementById('book-filter');

    // Load sql.js (returns a promise that resolves with the SQL object)
    const SQL_Promise = window.initSqlJs ? window.initSqlJs({
        locateFile: file => `sql/${file}`
    }) : Promise.reject(new Error('sql.js not loaded'));

    // Expose a global `SQL` variable once ready (required by genanki.js)
    let SQL; // eslint-disable-line no-var
    SQL_Promise.then(obj => { SQL = obj; window.SQL = obj; });

    // genanki.js is now shipped locally (see web/anki/). No async loader needed.

    // Utility to update status message
    function setStatus(msg, variant = 'info') {
        statusEl.textContent = msg;
        statusEl.className = `alert alert-${variant} py-2`;
    }

    // Utility to deduplicate by "word" key – keep first occurrence
    function deduplicate(entries) {
        const seen = new Set();
        return entries.filter(({ word }) => {
            if (seen.has(word)) return false;
            seen.add(word);
            return true;
        });
    }

    // NEW: Simple cache for dictionary look-ups
    const definitionCache = new Map();

    // NEW: Map from ISO-639-3 to dictionaryapi.dev language codes
    const iso3toLang = {
        eng: 'en', spa: 'es', fra: 'fr', deu: 'de', ita: 'it', rus: 'ru', por: 'pt-BR',
        jpn: 'ja', kor: 'ko', tur: 'tr', ara: 'ar', hin: 'hi', ind: 'id',
        swe: 'sv', fin: 'fi', pol: 'pl', nld: 'nl', nor: 'no', dan: 'da', ces: 'cs',
        ron: 'ro', ell: 'el', zho: 'zh', heb: 'he', hun: 'hu'
    };

    // NEW: Detect probable language of the given word/context using franc (loaded lazily)
    async function detectLanguage(word, context = '') {
        const sample = [word, context].filter(Boolean).join(' ').trim();
        // Too short — default to English
        if (sample.length < 4) return 'en';

        // Lazy-load franc once and cache on window
        if (!window._franc) {
            try {
                const mod = await import('https://esm.sh/franc@6?bundle');
                window._franc = mod.franc;
            } catch (_) {
                window._franc = null; // mark as failed so we don't retry every time
            }
        }
        const francFn = window._franc;
        if (!francFn) return 'en';

        let iso3;
        try {
            iso3 = francFn(sample, { minLength: 3 });
        } catch (_) {
            iso3 = 'und';
        }

        if (!iso3 || iso3 === 'und') return 'en';
        return iso3toLang[iso3] || 'en';
    }

    // NEW: Fetch a concise English definition for a word using the free dictionary API
    async function fetchDefinition(word, context = '') {
        if (!word) return '';

        // Choose language based on detected language of word/context
        const lang = await detectLanguage(word, context);
        const cacheKey = `${lang}|${word}`;
        if (definitionCache.has(cacheKey)) return definitionCache.get(cacheKey);

        let definition = '';
        try {
            // First attempt with detected language
            let res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/${lang}/${encodeURIComponent(word)}`);

            // Fallback to English if lookup fails
            if (!res.ok && lang !== 'en') {
                res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
            }

            if (res.ok) {
                const json = await res.json();
                if (Array.isArray(json) && json.length) {
                    const first = json[0];
                    if (first.meanings && first.meanings.length) {
                        const defs = first.meanings[0].definitions;
                        if (defs && defs.length && defs[0].definition) {
                            definition = defs[0].definition;
                        }
                    }
                }
            }
        } catch (_) {
            // Network/API errors are ignored; fallback to empty definition
        }

        definitionCache.set(cacheKey, definition);
        return definition;
    }

    // Parse vocab.db into array of { word, context }
    async function parseVocabDb(file) {
        if (!file) return [];
        setStatus('Reading vocab.db…');

        const buffer = await file.arrayBuffer();
        const SQL = await SQL_Promise;
        const db = new SQL.Database(new Uint8Array(buffer));

        const query = `SELECT w.stem AS word,
                              l.usage  AS context,
                              w.timestamp AS ts,
                              IFNULL(b.title, '') AS book
                       FROM WORDS   AS w
                       LEFT JOIN LOOKUPS   AS l ON w.id  = l.word_key
                       LEFT JOIN BOOK_INFO AS b ON l.book_key = b.id;`;

        const res = db.exec(query);
        if (res.length === 0) return [];
        const rows = res[0].values;
        return rows.map(([word, context, ts, book]) => ({
            word,
            context: context || '',
            timestamp: Number(ts) || null, // ms epoch or null
            book: book || ''
        }));
    }

    // Parse My Clippings.txt into array of { word, context }
    async function parseClippings(file) {
        if (!file) return [];
        setStatus('Reading clippings…');

        const text = await file.text();
        const lines = text.split(/\r?\n/);
        const MOD = 5; // Kindle clippings pattern (title, info, blank, body, blank sep)
        const TITLE_LINE = 0;
        const CLIPPING_TEXT = 3;

        const entries = [];
        for (let i = 0; i + CLIPPING_TEXT < lines.length; i += MOD) {
            const wordLine = lines[i + CLIPPING_TEXT].trim();
            if (!wordLine) continue;
            // Remove commas to keep CSV/TSV clean, match original script
            const word = wordLine.replace(/,/g, '');
            // Use the title line as context (book title)
            const book = lines[i + TITLE_LINE] || '';
            const context = book; // keep consistent with previous behaviour
            // Skip very long lines (>30 chars) to mimic Python script default
            if (word.length >= 30) continue;
            // Parse timestamp from the info line (i + 1)
            let ts = null;
            const infoLine = lines[i + 1] || '';
            const match = infoLine.match(/Added on (.*)/);
            if (match && match[1]) {
                const parsed = Date.parse(match[1].trim());
                if (!Number.isNaN(parsed)) ts = parsed;
            }
            entries.push({ word, context, timestamp: ts, book });
        }
        return entries;
    }

    // Build .apkg using genanki-js (bundled locally)
    function createAnkiDeck(deckName, cards) {
        setStatus('Building Anki deck…');

        // Create a very simple Basic model
        const basicModel = new Model({
            name: 'Basic',
            id: Date.now(),
            flds: [{ name: 'Front' }, { name: 'Back' }],
            req: [[0, 'all', [0]]],
            tmpls: [
                {
                    name: 'Card 1',
                    qfmt: '{{Front}}',
                    afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}'
                }
            ]
        });

        const deck = new Deck(Date.now(), deckName);

        for (const { word, context, definition } of cards) {
            const front = `${word}<br><br>${context || ''}`;
            const back = definition || '&nbsp;';
            deck.addNote(basicModel.note([front, back]));
        }

        const pkg = new Package();
        pkg.addDeck(deck);

        // The genanki Package writes directly via FileSaver. We wrap it in a Promise
        // so the caller can await completion.
        return new Promise((resolve) => {
            const originalSaveAs = window.saveAs;
            // intercept FileSaver to detect completion and restore behaviour
            window.saveAs = function (blob, filename) {
                originalSaveAs(blob, filename);
                resolve({ blob, filename });
                // restore
                window.saveAs = originalSaveAs;
            };
            pkg.writeToFile(`${deckName.replace(/\s+/g, '_')}.apkg`);
        });
    }

    // Main click handler
    generateBtn.addEventListener('click', async () => {
        downloadLink.style.display = 'none';
        setStatus('Starting…', 'info');

        const deckName = deckNameInput.value.trim() || 'Kindle Vocabulary';
        const vocabFile = vocabInput.files[0] || null;
        const clippingsFile = clippingsInput.files[0] || null;

        if (!vocabFile && !clippingsFile) {
            setStatus('Please select at least one Kindle data file.', 'warning');
            return;
        }

        try {
            // Extract entries from selected sources
            const [vocabEntries, clippingEntries] = await Promise.all([
                parseVocabDb(vocabFile),
                parseClippings(clippingsFile)
            ]);

            let allEntries = [...vocabEntries, ...clippingEntries];
            if (allEntries.length === 0) {
                setStatus('No entries found in your files.');
                return;
            }

            // Deduplicate
            allEntries = deduplicate(allEntries);

            // Apply filters
            allEntries = applyFilters(allEntries);

            if (allEntries.length === 0) {
                setStatus('No entries remain after applying filters.');
                return;
            }

            setStatus(`Preparing ${allEntries.length} cards…`);

            // NEW: fetch definitions for all words in parallel (with caching)
            setStatus('Fetching definitions…');
            const cardsWithDefs = await Promise.all(
                allEntries.map(async (entry) => ({
                    ...entry,
                    definition: await fetchDefinition(entry.word, entry.context)
                }))
            );

            // Build deck (prompts download automatically)
            await createAnkiDeck(deckName, cardsWithDefs);

            // Inform user – no extra click required.
            downloadLink.style.display = 'none';
            setStatus('Done! Your deck download should start automatically.', 'success');
        } catch (err) {
            console.error(err);
            setStatus('An error occurred: ' + err.message, 'danger');
        }
    });

    // Apply user filters; returns filtered array
    function applyFilters(entries) {
        const start = startDateInput.value ? Date.parse(startDateInput.value) : null; // midnight local
        const end = endDateInput.value ? Date.parse(endDateInput.value) + 24*60*60*1000 - 1 : null; // end of day
        const bookSubstr = bookFilterInput.value.trim().toLowerCase();

        return entries.filter(({ timestamp, book }) => {
            // Date filter
            if (start !== null) {
                if (timestamp === null || timestamp < start) return false;
            }
            if (end !== null) {
                if (timestamp === null || timestamp > end) return false;
            }
            // Book filter (substring, case-insensitive)
            if (bookSubstr) {
                if (!book.toLowerCase().includes(bookSubstr)) return false;
            }
            return true;
        });
    }
})(); 