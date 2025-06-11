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
    const languageFilterInput = document.getElementById('language-filter');

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
        statusEl.style.display = 'block';
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
        
        const entries = rows.map(([word, context, ts, book]) => ({
            word,
            context: context || '',
            timestamp: Number(ts) || null, // ms epoch or null
            book: book || ''
        }));

        // Add language detection to each entry
        setStatus('Detecting languages…');
        for (const entry of entries) {
            entry.language = await detectLanguage(entry.word, entry.context);
        }

        return entries;
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

        // Add language detection to each entry
        setStatus('Detecting languages for clippings…');
        for (const entry of entries) {
            entry.language = await detectLanguage(entry.word, entry.context);
        }

        return entries;
    }

    // Build .apkg using genanki-js (bundled locally)
    function createAnkiDeck(deckName, cards) {
        setStatus('Building Anki deck…');

        // Create a very simple Basic model with unique ID
        const modelId = Date.now();
        const basicModel = new Model({
            name: 'Basic',
            id: modelId,
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

        // Create deck with unique ID and current timestamp
        const deckId = modelId + 1; // Ensure deck ID is different from model ID
        const deck = new Deck(deckId, deckName);

        // Get current timestamp for card creation
        const baseTimestamp = Math.floor(Date.now() / 1000); // Anki uses seconds since epoch

        for (let i = 0; i < cards.length; i++) {
            const { word, context, definition } = cards[i];
            const front = `${word}<br><br>${context || ''}`;
            const back = definition || '&nbsp;';
            
            // Create note with unique timestamp (add index to ensure uniqueness)
            const note = basicModel.note([front, back]);
            
            // Set creation timestamp and other fields for proper Anki import
            const createdTimestamp = baseTimestamp + i; // Each card gets a unique timestamp
            note.mod = createdTimestamp; // Modification time (when card was created)
            note.id = Date.now() + i; // Unique note ID
            note.usn = -1; // Update sequence number (-1 for new cards)
            note.tags = []; // Empty tags array
            
            deck.addNote(note);
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

        if (globalEntries.length === 0) {
            setStatus('Please select at least one Kindle data file and wait for analysis to complete.', 'warning');
            return;
        }

        try {
            // Apply filters to the globally stored entries
            let filteredEntries = applyFilters(globalEntries);

            if (filteredEntries.length === 0) {
                setStatus('No entries remain after applying filters.', 'warning');
                return;
            }

            setStatus(`Preparing ${filteredEntries.length} cards…`);

            // Fetch definitions for all words in parallel (with caching)
            setStatus('Fetching definitions…');
            const cardsWithDefs = await Promise.all(
                filteredEntries.map(async (entry) => ({
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
        const selectedBooks = Array.from(bookFilterInput.selectedOptions).map(opt => opt.value);
        const selectedLanguages = Array.from(languageFilterInput.selectedOptions).map(opt => opt.value);

        return entries.filter(({ timestamp, book, language }) => {
            // Date filter
            if (start !== null) {
                if (timestamp === null || timestamp < start) return false;
            }
            if (end !== null) {
                if (timestamp === null || timestamp > end) return false;
            }
            // Book filter (exact match from selection)
            // Only apply if there are books in the dropdown (not disabled)
            if (selectedBooks.length > 0 && !bookFilterInput.disabled) {
                if (!selectedBooks.includes(book)) return false;
            }
            // Language filter (exact match from selection)
            // Only apply if there are languages in the dropdown (not disabled)
            if (selectedLanguages.length > 0 && !languageFilterInput.disabled) {
                if (!selectedLanguages.includes(language)) return false;
            }
            return true;
        });
    }

    // Extract unique books from entries
    function getUniqueBooks(entries) {
        const books = new Set();
        entries.forEach(entry => {
            if (entry.book && entry.book.trim()) {
                books.add(entry.book.trim());
            }
        });
        return Array.from(books).sort();
    }

    // Extract unique languages from entries
    function getUniqueLanguages(entries) {
        const languages = new Set();
        entries.forEach(entry => {
            if (entry.language) {
                languages.add(entry.language);
            }
        });
        return Array.from(languages).sort();
    }

    // Get language display name from code
    function getLanguageDisplayName(langCode) {
        const langNames = {
            'en': 'English',
            'es': 'Spanish',
            'fr': 'French',
            'de': 'German',
            'it': 'Italian',
            'ru': 'Russian',
            'pt-BR': 'Portuguese (Brazil)',
            'ja': 'Japanese',
            'ko': 'Korean',
            'tr': 'Turkish',
            'ar': 'Arabic',
            'hi': 'Hindi',
            'id': 'Indonesian',
            'sv': 'Swedish',
            'fi': 'Finnish',
            'pl': 'Polish',
            'nl': 'Dutch',
            'no': 'Norwegian',
            'da': 'Danish',
            'cs': 'Czech',
            'ro': 'Romanian',
            'el': 'Greek',
            'zh': 'Chinese',
            'he': 'Hebrew',
            'hu': 'Hungarian'
        };
        return langNames[langCode] || langCode.toUpperCase();
    }

    // Populate the book filter dropdown
    function populateBookFilter(books) {
        // Remember currently selected books
        const previouslySelected = Array.from(bookFilterInput.selectedOptions).map(opt => opt.value);
        
        bookFilterInput.innerHTML = '';
        bookFilterInput.disabled = false;
        
        if (books.length === 0) {
            bookFilterInput.innerHTML = '<option value="" disabled>No books found</option>';
            bookFilterInput.disabled = true;
            return;
        }

        books.forEach(book => {
            const option = document.createElement('option');
            option.value = book;
            option.textContent = book;
            // If this is the first population or the book was previously selected, select it
            option.selected = previouslySelected.length === 0 || previouslySelected.includes(book);
            bookFilterInput.appendChild(option);
        });

        // Multi-select behavior is already set up globally
    }

    // Populate the language filter dropdown
    function populateLanguageFilter(languages) {
        // Remember currently selected languages
        const previouslySelected = Array.from(languageFilterInput.selectedOptions).map(opt => opt.value);
        
        languageFilterInput.innerHTML = '';
        languageFilterInput.disabled = false;
        
        if (languages.length === 0) {
            languageFilterInput.innerHTML = '<option value="" disabled>No languages detected</option>';
            languageFilterInput.disabled = true;
            return;
        }

        languages.forEach(langCode => {
            const option = document.createElement('option');
            option.value = langCode;
            option.textContent = getLanguageDisplayName(langCode);
            // If this is the first population or the language was previously selected, select it
            option.selected = previouslySelected.length === 0 || previouslySelected.includes(langCode);
            languageFilterInput.appendChild(option);
        });

        // Multi-select behavior is already set up globally
    }

    // Store parsed entries globally for filter updates
    let globalEntries = [];

    // Filter entries by date range
    function filterEntriesByDateRange(entries) {
        const start = startDateInput.value ? Date.parse(startDateInput.value) : null;
        const end = endDateInput.value ? Date.parse(endDateInput.value) + 24*60*60*1000 - 1 : null;

        if (!start && !end) {
            return entries; // No date filter applied
        }

        return entries.filter(({ timestamp }) => {
            if (timestamp === null) {
                return false; // Exclude entries without timestamps when date filter is active
            }
            
            if (start !== null && timestamp < start) {
                return false;
            }
            
            if (end !== null && timestamp > end) {
                return false;
            }
            
            return true;
        });
    }

    // Update book and language filter lists based on current date range
    function updateFilterLists() {
        if (globalEntries.length === 0) {
            return; // No data to filter
        }

        // Get entries within the current date range
        const filteredEntries = filterEntriesByDateRange(globalEntries);
        
        // Extract unique books and languages from filtered entries
        const books = getUniqueBooks(filteredEntries);
        const languages = getUniqueLanguages(filteredEntries);
        
        // Update the dropdowns with filtered data
        populateBookFilter(books);
        populateLanguageFilter(languages);

        // Update status to show filtered counts
        const dateRangeText = getDateRangeText();
        if (dateRangeText) {
            setStatus(`Filtered to ${filteredEntries.length} entries from ${books.length} books in ${languages.length} languages (${dateRangeText})`, 'info');
        } else {
            setStatus(`Found ${filteredEntries.length} entries from ${books.length} books in ${languages.length} languages`, 'success');
        }
    }

    // Helper function to get readable date range text
    function getDateRangeText() {
        const start = startDateInput.value;
        const end = endDateInput.value;
        
        if (start && end) {
            return `${start} to ${end}`;
        } else if (start) {
            return `from ${start}`;
        } else if (end) {
            return `until ${end}`;
        }
        
        return '';
    }

    // Update filters when files are uploaded
    async function updateFiltersFromFiles() {
        const vocabFile = vocabInput.files[0] || null;
        const clippingsFile = clippingsInput.files[0] || null;

        if (!vocabFile && !clippingsFile) {
            // Reset filters to disabled state
            populateBookFilter([]);
            populateLanguageFilter([]);
            globalEntries = [];
            return;
        }

        try {
            setStatus('Analyzing uploaded files…', 'info');
            
            // Extract entries from selected sources
            const [vocabEntries, clippingEntries] = await Promise.all([
                parseVocabDb(vocabFile),
                parseClippings(clippingsFile)
            ]);

            globalEntries = [...vocabEntries, ...clippingEntries];
            globalEntries = deduplicate(globalEntries);

            // Update filter lists (this will apply any existing date filters)
            updateFilterLists();
        } catch (err) {
            console.error(err);
            setStatus('Error analyzing files: ' + err.message, 'danger');
            populateBookFilter([]);
            populateLanguageFilter([]);
            globalEntries = [];
        }
    }

    // Add event listeners for file uploads
    vocabInput.addEventListener('change', updateFiltersFromFiles);
    clippingsInput.addEventListener('change', updateFiltersFromFiles);

    // Add event listeners for date changes to update book/language lists
    startDateInput.addEventListener('change', updateFilterLists);
    endDateInput.addEventListener('change', updateFilterLists);

    // Add a clear dates function for better UX
    function clearDateFilters() {
        startDateInput.value = '';
        endDateInput.value = '';
        updateFilterLists();
    }

    // Expose clear function globally for potential use
    window.clearDateFilters = clearDateFilters;

    // Fix multi-select behavior for both dropdowns
    function setupMultiSelectBehavior(selectElement) {
        // Avoid duplicate listeners
        if (selectElement.hasAttribute('data-multiselect-setup')) {
            return;
        }
        selectElement.setAttribute('data-multiselect-setup', 'true');

        selectElement.addEventListener('mousedown', function(e) {
            e.preventDefault();
            
            const option = e.target;
            if (option.tagName === 'OPTION') {
                // Toggle the selected state of the clicked option
                option.selected = !option.selected;
                
                // Trigger change event to update any listeners
                const changeEvent = new Event('change', { bubbles: true });
                selectElement.dispatchEvent(changeEvent);
            }
        });

        // Prevent the default click behavior that would deselect other options
        selectElement.addEventListener('click', function(e) {
            e.preventDefault();
        });

        // Handle keyboard navigation properly
        selectElement.addEventListener('keydown', function(e) {
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                const focusedOption = selectElement.options[selectElement.selectedIndex];
                if (focusedOption) {
                    focusedOption.selected = !focusedOption.selected;
                    const changeEvent = new Event('change', { bubbles: true });
                    selectElement.dispatchEvent(changeEvent);
                }
            }
        });
    }

    // Apply the multi-select behavior to both filter dropdowns
    setupMultiSelectBehavior(bookFilterInput);
    setupMultiSelectBehavior(languageFilterInput);
})(); 