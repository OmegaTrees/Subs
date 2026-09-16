// ==UserScript==

// @name         Chess Masters - Smart Bot with Log Import/Export

// @namespace    http://tampermonkey.net/

// @version      18.0

// @description  Auto-answers, learns from server, imports/exports known hits

// @match        https://chessmasters.co.za/*

// @run-at       document-start

// @grant        GM_addStyle

// @grant        GM_getValue

// @grant        GM_setValue

// @grant        GM_deleteValue

// ==/UserScript==

(function() {

    'use strict';

    // ===== CONFIG =====

    const MIN_DELAY = 100;

    const MAX_DELAY = 3000;

    const DEFAULT_DELAY = 800;

    // ==================

    let ANSWER_DELAY_MS = parseInt(GM_getValue('answerDelay', DEFAULT_DELAY), 10);

    let knownHits = JSON.parse(GM_getValue('knownHits', '{}'));

    let logEntries = JSON.parse(GM_getValue('logEntries', '[]'));

    // State

    let authToken = null;

    let attemptToken = null;

    let captchaHeaders = { token: null, action: null, widget: null };

    let answerIndex = 0;

    let lastQuestionId = null;

    let gameId = null;

    let isReady = false;

    let gameEnded = false;

    let fetching = false;

    let pendingTimeout = null;

    let currentQuestionText = '';

    let currentChosenAnswer = '';

    let currentSource = '—';

    let currentCorrectAnswer = '—';

    let currentScore = 0;

    // ---- UI elements we'll update ----

    let ui = {};

    // ---- Utility functions ----

    function extractAuth(headers) {

        if (!headers) return null;

        if (typeof headers.get === 'function') {

            let val = headers.get('Authorization') || headers.get('authorization');

            if (val) return val;

        }

        return headers.Authorization || headers.authorization || null;

    }

    function pickRandom(answers) {

        return answers[Math.floor(Math.random() * answers.length)];

    }

    function checkReady() {

        if (authToken && attemptToken && captchaHeaders.token) {

            if (!isReady) {

                isReady = true;

                updateUIStatus('● Ready');

                updateUIStatusClass('ready');

            }

        }

    }

    function updateUIStatus(text) {

        if (ui.status) ui.status.textContent = text;

    }

    function updateUIStatusClass(cls) {

        if (ui.status) {

            ui.status.className = 'status ' + cls;

        }

    }

    function updateUIProgress() {

        if (ui.progress) {

            ui.progress.textContent = `Q${answerIndex+1}/10  |  Score: ${currentScore}`;

        }

        if (ui.questionDisplay) {

            let qText = currentQuestionText;

            if (qText.length > 60) qText = qText.substring(0, 60) + '...';

            ui.questionDisplay.textContent = qText || 'Waiting for question...';

        }

        if (ui.answerDisplay) {

            ui.answerDisplay.textContent = currentChosenAnswer || '—';

        }

        if (ui.sourceDisplay) {

            ui.sourceDisplay.textContent = currentSource;

        }

        if (ui.correctDisplay) {

            ui.correctDisplay.textContent = currentCorrectAnswer;

        }

    }

    function addToKnownHits(question, answer, categoryId) {

        if (!question || !answer) return;

        if (!knownHits[question]) {

            knownHits[question] = answer;

            GM_setValue('knownHits', JSON.stringify(knownHits));

            // Also add to log entries for export

            const now = new Date();

            const ts = now.toISOString().replace('T', ' ').slice(0, 19);

            const entry = `[${ts}] [${categoryId || '000000'}] Hit #${Object.keys(knownHits).length} | Q: ${question} | A: ${answer}`;

            logEntries.push(entry);

            GM_setValue('logEntries', JSON.stringify(logEntries));

            console.log(`📚 Learned new Q: "${question}" -> "${answer}"`);

        }

    }

    function loadLogFromFile(file) {

        const reader = new FileReader();

        reader.onload = function(e) {

            const lines = e.target.result.split('\n');

            let count = 0;

            for (let line of lines) {

                // Parse: [timestamp] [id] Hit #X | Q: <question> | A: <answer>

                const match = line.match(/Q:\s*(.*?)\s*\|\s*A:\s*(.*)/);

                if (match) {

                    const q = match[1].trim();

                    const a = match[2].trim();

                    if (q && a) {

                        knownHits[q] = a;

                        count++;

                    }

                }

            }

            GM_setValue('knownHits', JSON.stringify(knownHits));

            // Also merge log entries to avoid duplicates (optional)

            // We'll just replace logEntries with the parsed ones to keep it clean, but we can append.

            // Actually, let's just set the logEntries to lines if we want export to match exactly.

            // But we might add new ones later. We'll keep the ones we loaded plus future ones.

            // For simplicity, we'll replace logEntries with the loaded ones + any future ones.

            // But to avoid duplication, we can just keep the existing logEntries and add the new ones.

            // However, let's just override logEntries with the parsed lines to keep it tidy.

            const newLogs = [];

            for (let line of lines) {

                if (line.trim()) newLogs.push(line.trim());

            }

            logEntries = newLogs;

            GM_setValue('logEntries', JSON.stringify(logEntries));

            console.log(`✅ Loaded ${count} known hits from file.`);

            ui.loadStatus.textContent = `Loaded ${count} hits.`;

            updateUIStatus(`Loaded ${count} known hits.`);

        };

        reader.readAsText(file);

    }

    function exportLog() {

        const data = logEntries.join('\n');

        const blob = new Blob([data], { type: 'text/plain' });

        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');

        a.href = url;

        a.download = `known_hits_${new Date().toISOString().slice(0,10)}.log`;

        document.body.appendChild(a);

        a.click();

        document.body.removeChild(a);

        URL.revokeObjectURL(url);

    }

    // ---- Fetch next question ----

    function fetchNextQuestion() {

        if (gameEnded || fetching || !gameId || !attemptToken) return;

        fetching = true;

        const url = `https://trivia.v2.penroseza.com/api/game/get-questions?productId=36&service=vc-fanclash-quizinc-cm-f-monthly-02&amountOfQuestions=1&questionCategoryId=51`;

        fetch(url, {

            method: 'GET',

            headers: { 'Authorization': authToken, 'X-Attempt-Token': attemptToken, 'Accept': 'application/json, text/plain, */*' },

            credentials: 'include'

        })

        .then(r => r.json())

        .then(() => { fetching = false; })

        .catch(err => { fetching = false; console.error("❌ Fetch failed:", err); });

    }

    // ---- Send Answer ----

    function sendAnswer(qId, answer, catId) {

        if (!isReady) {

            setTimeout(() => sendAnswer(qId, answer, catId), 100);

            return;

        }

        const payload = {

            answer: [{ questionId: qId, answer, questionCategoryId: catId }],

            gameId: gameId,

            service: "vc-fanclash-quizinc-cm-f-monthly-02",

            productId: 36,

            bonusGame: 0

        };

        updateUIStatus(`⏳ Answering Q${answerIndex+1}...`);

        fetch("https://trivia.v2.penroseza.com/api/game/save-answer", {

            method: "POST",

            headers: {

                "Authorization": authToken,

                "Content-Type": "application/json",

                "X-Attempt-Token": attemptToken,

                "X-Captcha-Token": captchaHeaders.token,

                "X-Captcha-Action": captchaHeaders.action || "game_start",

                "X-Captcha-Widget": captchaHeaders.widget || "chessMasters",

                "X-Client-Telemetry": "eyJ2IjoxLCJ0dGFNcyI6MTU3MjIsInR0ZmlNcyI6bnVsbCwicG0iOjAsImRpc3QiOjAsImNsayI6MCwidGNoIjowLCJoaWQiOjAsImZvYyI6MCwidnciOjM2MCwidmgiOjY1MSwiZHByIjozLCJ0eiI6LTEyMCwibGFuZyI6ImVuLVpBIiwicGxhdCI6IkFuZHJvaWQiLCJ0b3VjaCI6dHJ1ZSwiaGMiOjgsImFwcCI6ImNoZXNzQDMuMi4wIn0=",

                "Accept": "application/json, text/plain, */*"

            },

            body: JSON.stringify(payload),

            credentials: "include"

        })

        .then(r => r.json())

        .then(data => {

            const isCorrect = data.correct || false;

            if (isCorrect) currentScore++;

            const serverCorrect = data.correctAnswer || '';

            // If we didn't know this question, learn it now

            if (currentQuestionText && !knownHits[currentQuestionText] && serverCorrect) {

                addToKnownHits(currentQuestionText, serverCorrect, catId);

                currentSource = 'Learned';

                currentCorrectAnswer = serverCorrect;

            } else if (currentQuestionText && knownHits[currentQuestionText]) {

                currentSource = 'Hit';

                currentCorrectAnswer = knownHits[currentQuestionText];

            } else {

                currentSource = 'Random';

                currentCorrectAnswer = serverCorrect || '—';

            }

            // Update UI

            updateUIProgress();

            updateUIStatus(isCorrect ? '✅ Correct!' : '❌ Wrong');

            if (data.gameEnded) {

                gameEnded = true;

                updateUIStatus(`🏆 GAME OVER! Score: ${data.correctAnswers}/10 | Time: ${data.completionTime}s`);

                updateUIStatusClass('ended');

                console.log(`🏆 GAME OVER! Score: ${data.correctAnswers}/10 | Time: ${data.completionTime}s`);

            } else {

                console.log(`✅ Q${answerIndex+1} answered.`);

                updateUIStatus('⏩ Fetching next...');

                fetchNextQuestion();

            }

        })

        .catch(err => {

            console.error("❌ Save failed:", err);

            updateUIStatus('❌ Error saving answer');

        });

    }

    // ---- Handle Intercepted Question ----

    function handleQuestion(data) {

        if (!Array.isArray(data) || !data[0] || !data[0].questionId) return;

        const q = data[0];

        if (q.questionId === lastQuestionId) return;

        if (gameEnded || answerIndex >= 10) return;

        if (!gameId) gameId = q.gameId;

        if (!attemptToken && q.attemptToken) {

            attemptToken = q.attemptToken;

            console.log("🎫 Attempt Token captured:", attemptToken);

            checkReady();

        }

        lastQuestionId = q.questionId;

        currentQuestionText = q.question;

        let chosen = null;

        let source = '';

        // Check if we know this question

        if (knownHits[q.question]) {

            chosen = knownHits[q.question];

            source = 'Hit';

            currentSource = 'Hit';

            currentCorrectAnswer = chosen;

        } else {

            chosen = pickRandom(q.answers);

            source = 'Random';

            currentSource = 'Random';

            currentCorrectAnswer = '—';

        }

        currentChosenAnswer = chosen;

        updateUIProgress();

        updateUIStatus(`⚡ Answering Q${answerIndex+1}...`);

        // Cancel any pending timeout

        if (pendingTimeout) {

            clearTimeout(pendingTimeout);

            pendingTimeout = null;

        }

        // Wait for the configured delay

        pendingTimeout = setTimeout(() => {

            pendingTimeout = null;

            sendAnswer(q.questionId, chosen, q.questionCategoryId);

        }, ANSWER_DELAY_MS);

        answerIndex++;

    }

    // ---- Capture Headers ----

    function captureHeaders(headers) {

        if (!headers) return;

        const auth = extractAuth(headers);

        if (auth && !authToken) { authToken = auth; console.log("🔑 Auth Token captured."); checkReady(); }

        const getHeader = (h) => (typeof headers.get === 'function') ? headers.get(h) : headers[h] || headers[h.toLowerCase()];

        const capToken = getHeader('X-Captcha-Token');

        if (capToken && !captchaHeaders.token) { captchaHeaders.token = capToken; console.log("✅ Captcha Token captured."); checkReady(); }

        const capAction = getHeader('X-Captcha-Action');

        if (capAction && !captchaHeaders.action) captchaHeaders.action = capAction;

        const capWidget = getHeader('X-Captcha-Widget');

        if (capWidget && !captchaHeaders.widget) captchaHeaders.widget = capWidget;

    }

    // ---- Create Floating Panel ----

    function createPanel() {

        GM_addStyle(`

            #chess-auto-panel {

                position: fixed;

                bottom: 20px;

                right: 20px;

                background: rgba(0,0,0,0.9);

                color: #fff;

                border-radius: 12px;

                padding: 14px 18px;

                font-family: Arial, sans-serif;

                font-size: 13px;

                z-index: 999999;

                box-shadow: 0 4px 16px rgba(0,0,0,0.6);

                display: flex;

                flex-direction: column;

                gap: 8px;

                min-width: 280px;

                max-width: 340px;

                backdrop-filter: blur(6px);

                user-select: none;

                border: 1px solid #333;

            }

            #chess-auto-panel .panel-row {

                display: flex;

                align-items: center;

                justify-content: space-between;

                gap: 10px;

            }

            #chess-auto-panel label {

                font-weight: bold;

                color: #aaa;

                font-size: 12px;

            }

            #chess-auto-panel .delay-value {

                color: #ffd700;

                font-weight: bold;

                font-size: 15px;

                min-width: 50px;

                text-align: right;

            }

            #chess-auto-panel input[type="range"] {

                width: 100%;

                cursor: pointer;

                background: #444;

                height: 4px;

                border-radius: 2px;

                -webkit-appearance: none;

            }

            #chess-auto-panel input[type="range"]::-webkit-slider-thumb {

                -webkit-appearance: none;

                width: 14px;

                height: 14px;

                border-radius: 50%;

                background: #ffd700;

                cursor: pointer;

            }

            #chess-auto-panel .status {

                font-size: 12px;

                color: #8f8;

                text-align: center;

                padding: 4px 0;

                border-radius: 4px;

                background: rgba(255,255,255,0.05);

            }

            #chess-auto-panel .status.ready { color: #8f8; }

            #chess-auto-panel .status.waiting { color: #ffa; }

            #chess-auto-panel .status.ended { color: #f88; }

            #chess-auto-panel .progress {

                font-weight: bold;

                color: #fff;

                text-align: center;

                font-size: 14px;

            }

            #chess-auto-panel .question-box {

                background: rgba(255,255,255,0.08);

                padding: 6px 8px;

                border-radius: 6px;

                font-size: 12px;

                color: #ddd;

                word-break: break-word;

                max-height: 40px;

                overflow: hidden;

            }

            #chess-auto-panel .answer-row {

                display: flex;

                justify-content: space-between;

                font-size: 12px;

                background: rgba(255,255,255,0.05);

                padding: 4px 8px;

                border-radius: 4px;

            }

            #chess-auto-panel .answer-row .label { color: #aaa; }

            #chess-auto-panel .answer-row .value { color: #ffd700; font-weight: bold; }

            #chess-auto-panel .answer-row .value.hit { color: #6f6; }

            #chess-auto-panel .answer-row .value.learned { color: #6af; }

            #chess-auto-panel .file-row {

                display: flex;

                gap: 6px;

                align-items: center;

                flex-wrap: wrap;

            }

            #chess-auto-panel .file-row input[type="file"] {

                font-size: 11px;

                color: #ccc;

                flex: 1;

                min-width: 80px;

            }

            #chess-auto-panel .file-row button {

                background: #444;

                color: #fff;

                border: none;

                padding: 4px 10px;

                border-radius: 4px;

                cursor: pointer;

                font-size: 11px;

                transition: background 0.2s;

            }

            #chess-auto-panel .file-row button:hover {

                background: #666;

            }

            #chess-auto-panel .load-status {

                font-size: 10px;

                color: #aaa;

                text-align: center;

            }

        `);

        const panel = document.createElement('div');

        panel.id = 'chess-auto-panel';

        panel.innerHTML = `

            <div class="panel-row">

                <label>Delay (ms)</label>

                <span class="delay-value" id="delayDisplay">${ANSWER_DELAY_MS}</span>

            </div>

            <div class="panel-row">

                <input type="range" id="delaySlider" min="${MIN_DELAY}" max="${MAX_DELAY}" step="50" value="${ANSWER_DELAY_MS}">

            </div>

            <div class="progress" id="progressDisplay">Q0/10  |  Score: 0</div>

            <div class="question-box" id="questionDisplay">Waiting for question...</div>

            <div class="answer-row">

                <span class="label">Answer</span>

                <span class="value" id="answerDisplay">—</span>

            </div>

            <div class="answer-row">

                <span class="label">Source</span>

                <span class="value" id="sourceDisplay">—</span>

            </div>

            <div class="answer-row">

                <span class="label">Correct</span>

                <span class="value" id="correctDisplay">—</span>

            </div>

            <div class="status waiting" id="statusDisplay">● Waiting for game...</div>

            <div class="file-row">

                <input type="file" id="logUpload" accept=".log,.txt">

                <button id="logExportBtn">Export</button>

            </div>

            <div class="load-status" id="loadStatus">Load known_hits.log to start</div>

        `;

        document.body.appendChild(panel);

        // --- Bind UI elements ---

        ui.progress = document.getElementById('progressDisplay');

        ui.questionDisplay = document.getElementById('questionDisplay');

        ui.answerDisplay = document.getElementById('answerDisplay');

        ui.sourceDisplay = document.getElementById('sourceDisplay');

        ui.correctDisplay = document.getElementById('correctDisplay');

        ui.status = document.getElementById('statusDisplay');

        ui.loadStatus = document.getElementById('loadStatus');

        // --- Slider ---

        const slider = document.getElementById('delaySlider');

        const display = document.getElementById('delayDisplay');

        slider.addEventListener('input', function() {

            ANSWER_DELAY_MS = parseInt(this.value, 10);

            GM_setValue('answerDelay', ANSWER_DELAY_MS);

            display.textContent = ANSWER_DELAY_MS;

        });

        // --- File upload ---

        const fileInput = document.getElementById('logUpload');

        fileInput.addEventListener('change', function(e) {

            if (this.files && this.files[0]) {

                loadLogFromFile(this.files[0]);

            }

        });

        // --- Export ---

        document.getElementById('logExportBtn').addEventListener('click', exportLog);

        // Initial status

        updateUIStatus('● Waiting for game...');

        updateUIStatusClass('waiting');

        updateUIProgress();

    }

    // =============================================

    // INTERCEPTORS

    // =============================================

    const origFetch = window.fetch;

    window.fetch = function(input, init) {

        if (init && init.headers) captureHeaders(init.headers);

        let url = typeof input === 'string' ? input : (input.url || '');

        if (url.includes('/get-questions')) {

            return origFetch.apply(this, arguments).then(response => {

                response.clone().json().then(handleQuestion).catch(() => {});

                return response;

            });

        }

        return origFetch.apply(this, arguments);

    };

    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {

        if (header.toLowerCase() === 'authorization') {

            if (!authToken) { authToken = value; console.log("🔑 Auth Token captured (XHR)."); checkReady(); }

        }

        if (header.toLowerCase().startsWith('x-captcha-')) {

            const lower = header.toLowerCase();

            if (lower === 'x-captcha-token' && !captchaHeaders.token) { captchaHeaders.token = value; console.log("✅ Captcha Token captured (XHR)."); checkReady(); }

            if (lower === 'x-captcha-action' && !captchaHeaders.action) captchaHeaders.action = value;

            if (lower === 'x-captcha-widget' && !captchaHeaders.widget) captchaHeaders.widget = value;

        }

        return origSetHeader.call(this, header, value);

    };

    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.send = function(body) {

        if (this._url && this._url.includes('/get-questions')) {

            this.addEventListener('load', function() {

                if (this.readyState === 4 && this.status === 200) {

                    try { handleQuestion(JSON.parse(this.responseText)); } catch(e) {}

                }

            });

        }

        return origSend.call(this, body);

    };

    const origOpen = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function(method, url, ...args) {

        this._url = url;

        return origOpen.call(this, method, url, ...args);

    };

    // ---- Create Panel after DOM ready ----

    if (document.readyState === 'loading') {

        document.addEventListener('DOMContentLoaded', createPanel);

    } else {

        createPanel();

    }

    console.log(`🚀 Smart Bot with Log Import/Export injected. Delay: ${ANSWER_DELAY_MS}ms`);

})();
