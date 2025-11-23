// features/game/tebak_kata/index-tebak-kata.js

const {
    GAME_STATUS,
    activeGames,
    getRandomWord,
    stopGame,
    buildGameEmbed,
    processGuess,
    MAX_ATTEMPTS
} = require('./tebak_kata.js'); 

// --- HANDLE COMMAND (!tebak kata/stop) ---
async function handleTebakKataCommand(message, args) {
    const channelId = message.channelId;
    let game = activeGames.get(channelId);
    const command = args[0] ? args[0].toLowerCase() : null;
    
    // Command memulai: !tebak kata
    if (command === 'kata') {
        if (game && game.status === GAME_STATUS.ACTIVE) {
            message.delete().catch(() => {});
            return message.reply('Game Tebak Kata sudah berjalan di sini!').then(msg => {
                setTimeout(() => msg.delete().catch(() => {}), 5000);
            });
        }
        
        const secretWord = await getRandomWord();
        if (!secretWord) return message.reply('❌ Database Error. Cek koneksi ke MySQL/KBBI.');

        message.delete().catch(() => {}); // Hapus command user

        // Setup Hint (Buka 1-2 huruf acak)
        const initialGuessed = new Set();
        const uniqueLetters = [...new Set(secretWord.split(''))];
        const numberOfHints = Math.max(1, Math.floor(secretWord.length / 4));
        const hints = uniqueLetters.sort(() => 0.5 - Math.random()).slice(0, numberOfHints);
        hints.forEach(char => initialGuessed.add(char));

        game = { 
            status: GAME_STATUS.ACTIVE, 
            secretWord: secretWord, 
            guessedLetters: initialGuessed, 
            attemptsLeft: MAX_ATTEMPTS,
            host: message.author,
            hostId: message.author.id,
            lastMessageId: null,
            logs: [] 
        };
        activeGames.set(channelId, game);
        
        const initialEmbed = buildGameEmbed(game, `Game dimulai! Kata memiliki ${secretWord.length} huruf.`);
        const sentMessage = await message.channel.send({ embeds: [initialEmbed] });
        game.lastMessageId = sentMessage.id;
        return;
    }
    
    // Command berhenti: !tebak stop
    if (command === 'stop') {
        if (!game) return message.reply('Tidak ada game yang aktif.').then(msg => {
            setTimeout(() => msg.delete().catch(() => {}), 3000);
        }); 
        if (message.author.id !== game.hostId) return message.reply('Hanya host yang bisa menghentikan game.').then(msg => {
            setTimeout(() => msg.delete().catch(() => {}), 3000);
        }); 

        stopGame(channelId);
        message.delete().catch(() => {}); 
        
        if (game.lastMessageId) {
            message.channel.messages.fetch(game.lastMessageId).then(m => m.delete().catch(() => {})).catch(() => {});
        }
        return message.channel.send('Game dihentikan.').then(msg => {
            setTimeout(() => msg.delete().catch(() => {}), 3000);
        });
    }
    
    // Command bantuan: !tebak bantuan
    if (command === 'bantuan') {
        message.delete().catch(() => {});
        return message.reply('Cara main:\n1. Ketik `!tebak kata` untuk memulai.\n2. Untuk menebak, ketik huruf atau kata langsung di chat (tanpa prefix `!`).\n3. **Visual Feedback:** 🟩=Correct, 🟨=Near, ⬛=Wrong.').then(msg => {
            setTimeout(() => msg.delete().catch(() => {}), 15000);
        });
    }
}

// --- HANDLE TEBAKAN (Pesan Biasa) ---
async function handleTebakKataGuess(message) {
    const channelId = message.channelId;
    const game = activeGames.get(channelId);
    
    if (!game || game.status !== GAME_STATUS.ACTIVE) return;
    
    const input = message.content.trim().toLowerCase();
    
    // Validasi input: tidak kosong, tidak dimulai dengan '!', dan hanya berisi huruf
    if (!input || input.startsWith('!') || !/^[a-z]+$/.test(input)) return; 

    // Hapus Pesan Pemain
    try {
        await message.delete();
    } catch (error) {
        console.log(`⚠️ Gagal hapus pesan di ${message.channel.name}. Pastikan bot memiliki izin 'Manage Messages'.`);
    }
    
    // Proses Tebakan
    const result = processGuess(message, game, input);
    
    if (result && result.statusMsg) {
        if (result.logEntry) {
            game.logs.push(result.logEntry);
        } else {
            // Ini biasanya pesan seperti "Huruf sudah dipakai" atau "Panjang kata salah"
            game.logs.push(`⚠️ ${result.statusMsg}`);
        }

        const newEmbed = buildGameEmbed(game, result.statusMsg);

        if (game.lastMessageId) {
            message.channel.messages.fetch(game.lastMessageId).then(async (m) => {
                await m.edit({ embeds: [newEmbed] });
                
                if (game.status === GAME_STATUS.WIN || game.status === GAME_STATUS.LOSE) {
                    activeGames.delete(channelId);
                }
            }).catch(console.error);
        }
    }
}

module.exports = {
    name: 'tebak', 
    description: 'Game Tebak Kata',
    activeGames: activeGames, 
    handleTebakKataCommand, 
    handleTebakKataGuess,   
    async execute(message, args) { await handleTebakKataCommand(message, args); }
};