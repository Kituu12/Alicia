// features/game/tebak_kata/tebak_kata.js

const mysql = require('mysql2/promise'); 
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// --- KONFIGURASI DATABASE ---
const DB_CONFIG = {
    host: 'localhost',
    user: 'root',       
    password: '',       
    database: 'kbbi',   
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(DB_CONFIG);

const GAME_STATUS = {
    IDLE: 'IDLE',
    ACTIVE: 'ACTIVE',
    WIN: 'WIN',
    LOSE: 'LOSE'
};

const activeGames = new Map(); 

// --- KONFIGURASI GAME ---
const MAX_ATTEMPTS = 6; 
const MIN_WORD_LENGTH = 4; 
const MAX_WORD_LENGTH = 6; 

// *******************************************************************
// *** FUNGSI UTILITAS DAN LOGIKA INTI GAME ***
// *******************************************************************

/**
 * [RE-ADDED] Menghitung Levenshtein Distance (untuk Proximity Check)
 */
function levenshteinDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else if (j > 0) {
                let newValue = costs[j - 1];
                if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
            // Fix for the first row logic in Levenshtein implementation
            if (i === 0) costs[j] = j;
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}

async function getRandomWord() {
    try {
        const [rows] = await pool.execute(
            'SELECT word FROM dictionary WHERE LENGTH(word) >= ? AND LENGTH(word) <= ? AND word NOT LIKE "% %" ORDER BY RAND() LIMIT 1',
            [MIN_WORD_LENGTH, MAX_WORD_LENGTH]
        );
        if (rows.length > 0) return rows[0].word.toLowerCase();
        return null; 
    } catch (error) {
        console.error("[MySQL Error]", error.message);
        return null; 
    }
}

function stopGame(channelId, reason) {
    if (!activeGames.has(channelId)) return;
    activeGames.delete(channelId);
    return reason;
}

function getWordMask(word, guessedLetters) {
    let mask = '';
    for (const char of word) {
        if (guessedLetters.has(char)) {
            mask += char.toUpperCase() + ' ';
        } else {
            mask += '_ ';
        }
    }
    return mask.trim();
}

function getAttemptVisual(attemptsLeft) {
    const hearts = '❤️'.repeat(attemptsLeft);
    const brokenHearts = '💔'.repeat(MAX_ATTEMPTS - attemptsLeft);
    return `${hearts}${brokenHearts}`;
}

/**
 * [MODIFIED] Fungsi Wordle Visual (Green/Yellow/Black squares)
 * Yellow (🟨) sekarang berarti KEDEKATAN KATA (Proximity) menggunakan Levenshtein Distance.
 */
function generateWordleFeedback(secret, guess) {
    let result = Array(guess.length).fill('⬛'); 

    // 1. Hijau (Posisi Benar) - Logic Standard
    for (let i = 0; i < guess.length; i++) {
        if (guess[i] === secret[i]) {
            result[i] = '🟩';
        }
    }

    // 2. Tentukan Proximity (Kedekatan Kata)
    const distance = levenshteinDistance(secret, guess);
    // Jika jarak 1 atau 2, kata dianggap "dekat" (Proximate)
    const isClose = distance > 0 && distance <= 2; 

    // 3. Kuning / Hitam (Non-Green) - Logic MODIFIED
    for (let i = 0; i < guess.length; i++) {
        if (result[i] !== '🟩') { 
            if (isClose) {
                // Jika kata DEKAT (Jarak 1 atau 2), semua kotak non-hijau menjadi Kuning (Proximity)
                result[i] = '🟨';
            } else {
                // Jika kata TIDAK DEKAT (Jarak > 2), semua kotak non-hijau menjadi Hitam (Salah total)
                result[i] = '⬛'; 
            }
        }
    }
    return result.join(' ');
}

function buildGameEmbed(game, statusMessage = 'Game dimulai!') {
    const mask = getWordMask(game.secretWord, game.guessedLetters);
    const attemptsVisual = getAttemptVisual(game.attemptsLeft);
    
    // Tampilkan 6 log terakhir
    const historyText = game.logs && game.logs.length > 0 
        ? game.logs.slice(-6).join('\n') 
        : '> *Belum ada tebakan...*';

    return {
        color: 0x5865F2, 
        title: `🕵️ Game Tebak Kata`,
        description: `Host: **${game.host.username}**`,
        fields: [
            {
                name: 'Kata Rahasia',
                value: `\`\`\`${mask}\`\`\``, 
            },
            {
                name: 'Riwayat Tebakan', 
                value: historyText,
            },
            {
                name: 'Info',
                value: `Nyawa: ${attemptsVisual} (${game.attemptsLeft})`,
                inline: true
            },
            {
                name: 'Huruf Dipakai',
                value: game.guessedLetters.size > 0 
                    ? Array.from(game.guessedLetters).map(l => l.toUpperCase()).join(', ')
                    : '-',
                inline: true
            }
        ],
        footer: { text: `Status: ${statusMessage}. 🟩=Correct, 🟨=Near, ⬛=Wrong.` }
    };
}

function processGuess(message, game, input) {
    if (game.status !== GAME_STATUS.ACTIVE) return null;

    const guess = input.toLowerCase();
    let logEntry = ''; 
    let statusMsg = ''; 

    // --- TEBAK KATA UTUH (WORDLE + PROXIMITY) ---
    if (guess.length > 1) {
        if (guess.length !== game.secretWord.length) {
            return { statusMsg: `Panjang kata harus ${game.secretWord.length}!`, logEntry: null };
        }

        const wordleVisual = generateWordleFeedback(game.secretWord, guess);
        
        // Buka huruf yang benar otomatis (Wordle standard)
        for (let char of guess) {
            if (game.secretWord.includes(char)) game.guessedLetters.add(char);
        }

        if (guess === game.secretWord) {
            game.status = GAME_STATUS.WIN;
            logEntry = `🟩 **${guess.toUpperCase()}** - ${message.author.username}`;
            statusMsg = 'MENANG!';
        } else {
            game.attemptsLeft--;
            // [LOG ENTRY HANYA BERISI VISUAL WORDLE]
            logEntry = `${wordleVisual} **${guess.toUpperCase()}** - ${message.author.username}`;
            
            if (game.attemptsLeft <= 0) {
                game.status = GAME_STATUS.LOSE;
                statusMsg = `KALAH! Kata: ${game.secretWord.toUpperCase()}`;
            } else {
                statusMsg = 'Tebakan Salah.';
            }
        }
    }
    
    // --- TEBAK HURUF ---
    else if (guess.length === 1) {
        if (game.guessedLetters.has(guess)) {
            return { statusMsg: `Huruf ${guess} sudah dipakai.`, logEntry: null };
        }

        game.guessedLetters.add(guess);
        
        if (game.secretWord.includes(guess)) {
            const mask = getWordMask(game.secretWord, game.guessedLetters);
            if (!mask.includes('_')) {
                game.status = GAME_STATUS.WIN;
                statusMsg = 'MENANG!';
            } else {
                statusMsg = 'Huruf Benar!';
            }
            logEntry = `✅ Huruf **${guess.toUpperCase()}** - ${message.author.username}`;
        } else {
            game.attemptsLeft--;
            if (game.attemptsLeft <= 0) {
                game.status = GAME_STATUS.LOSE;
                statusMsg = `KALAH! Kata: ${game.secretWord.toUpperCase()}`;
            } else {
                statusMsg = 'Huruf Salah.';
            }
            logEntry = `❌ Huruf **${guess.toUpperCase()}** tidak ada. Sisa kesempatan: ${game.attemptsLeft}.`;
        }
    }

    return { statusMsg, logEntry };
}

module.exports = {
    GAME_STATUS, 
    activeGames,
    getRandomWord,
    stopGame,
    buildGameEmbed,
    processGuess,
    MAX_ATTEMPTS,
    levenshteinDistance // Exporting for testing/reference
};