// features/game/sambung_kata/sambung_kata.js

const { Collection, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const mysql = require('mysql2/promise'); 

// --- MAPPING STATUS GAME ---
const GAME_STATUS = {
    LOBBY: 'LOBBY',
    ACTIVE: 'ACTIVE',
    STOPPED: 'STOPPED' 
};

const activeGames = new Map();

// --- KONFIGURASI DATABASE MYSQL ---
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

// --- KONFIGURASI GAME ---
const MAX_TURN_TIME_MS = 7000; // 7 DETIK
const BOT_RESPONSE_DELAY = 2500; // Jeda Bot (2.5 detik)


// *******************************************************************
// *** FUNGSI UTILITAS DAN LOGIKA INTI GAME ***
// *******************************************************************

async function isKBBIWordValid(word) {
    const lowerWord = word.toLowerCase();
    try {
        const [rows] = await pool.execute(
            'SELECT word FROM dictionary WHERE word = ? LIMIT 1',
            [lowerWord]
        );
        return rows.length > 0;
    } catch (error) {
        console.error(`[MySQL Error: isKBBIWordValid] Gagal mencari kata ${lowerWord}:`, error.message);
        return false; 
    }
}

async function getBotResponse(game) { 
    const isFirstWord = game.kataTerakhir === 'a' || game.kataTerakhir === '';
    
    let requiredPrefix;
    if (isFirstWord) {
        requiredPrefix = 'a'; 
    } else {
        const requiredLength = game.kataTerakhir.length >= 2 ? 2 : 1;
        requiredPrefix = game.kataTerakhir.slice(-requiredLength);
    }

    try {
        const [rows] = await pool.execute(
            'SELECT word FROM dictionary WHERE word LIKE ? AND LENGTH(word) >= 2 LIMIT 10', 
            [`${requiredPrefix}%`]
        );
        
        if (rows.length === 0) return null; 

        const availableWords = rows
            .map(row => row.word)
            .filter(word => !game.kataDigunakan.has(word));
        
        if (availableWords.length > 0) {
            return availableWords[0];
        }
        return null; 
    } catch (error) {
        console.error("[BOT ERROR] Gagal mencari kata bot:", error.message);
        return null; 
    }
}

function setGameTimeout(message, game) { 
    const capturedTurnId = game.currentTurnId;
    if (game.timeoutRef) clearTimeout(game.timeoutRef);
    game.timeoutRef = setTimeout(() => {
        const fakeMessage = message.channel.messages.cache.get(game.lobbyMessageId) || message;
        endGameTimeout(fakeMessage, game, capturedTurnId);
    }, MAX_TURN_TIME_MS);
}


function endGameTimeout(message, game, capturedTurnId) { 
    if (!activeGames.has(message.channelId) || game.currentTurnId !== capturedTurnId) return;
    if (game.timeoutRef) clearTimeout(game.timeoutRef);
    
    game.status = GAME_STATUS.STOPPED;
    activeGames.delete(message.channelId); 

    const skorAkhir = Array.from(game.skorPemain.entries())
        .map(([userId, score]) => {
            const user = message.client.users.cache.get(userId) || { username: userId === message.client.user.id ? 'Bot' : 'Unknown' };
            return `* ${user.username}: **${score}**`;
        })
        .join('\n');
    
    const lastPlayerName = game.pemainTerakhir ? (message.client.users.cache.get(game.pemainTerakhir) || { username: 'Bot' }).username : 'Pemain yang memulai';

    message.channel.send(`⏰ **WAKTU HABIS!** ❌\n\nPemain terakhir (**${lastPlayerName}**) gagal membalas dalam 7 detik.\n\nGame berakhir! Kata terakhir: **${game.kataTerakhir}**\n\n**Skor Akhir:**\n${skorAkhir || "Belum ada skor yang tercatat."}`);
}

// --- FUNGSI PENGHENTIAN GAME BERSIH ---
async function stopGame(message, game, reason = 'Game/Lobby Sambung Kata dihentikan.') {
    if (!activeGames.has(message.channelId)) return;
    
    if (game.timeoutRef) clearTimeout(game.timeoutRef); 
    game.status = GAME_STATUS.STOPPED;
    activeGames.delete(message.channelId);
    
    if (game.lobbyMessageId) {
        // Coba edit pesan lobby untuk menghapus tombol dan embed
        message.channel.messages.fetch(game.lobbyMessageId)
            .then(m => m.edit({ components: [], embeds: [], content: reason }))
            .catch(() => {
                // Jika gagal fetch/edit, kirim pesan baru saja
                message.channel.send(reason).catch(() => {});
            });
    } else {
        message.channel.send(reason).catch(() => {});
    }
}

async function updateLobbyMessage(game, hostId) { // Menerima hostId
    const playersList = Array.from(game.players.values())
        .map(user => `➡️ ${user.username}`)
        .join('\n');
    
    const embedMessage = {
        color: 0x5865F2, 
        title: `🎲 Sambung Kata - Ruang Tunggu (${game.mode})`,
        description: `Mode: **${game.mode}**\n\n**Pemain (${game.players.size}):**\n${playersList || "Belum ada pemain yang bergabung."}\n\nTekan tombol **Bergabung** untuk masuk!`,
        fields: [
            {
                name: 'Cara Memulai',
                value: game.mode === 'SOLO'
                    ? 'Di mode SOLO, Bot harus memulai. Tekan tombol **🤖 Bot Main Dulu**.'
                    : 'Di mode VS, game akan dimulai saat salah satu pemain menekan tombol **Mulai Game** (minimal 2 pemain).'
            }
        ]
    };
    
    const isVSMode = game.mode === 'VS';
    
    // Tombol Keluar diizinkan di SOLO dan VS
    const joinButton = new ButtonBuilder().setCustomId('sambung_join').setLabel('Bergabung').setStyle(ButtonStyle.Success).setDisabled(!isVSMode);
    const leaveButton = new ButtonBuilder().setCustomId('sambung_leave').setLabel('Keluar').setStyle(ButtonStyle.Danger).setDisabled(false); // Diaktifkan di Solo/VS
    const botStartButton = new ButtonBuilder().setCustomId('sambung_bot_start').setLabel('🤖 Bot Main Dulu').setStyle(ButtonStyle.Primary).setDisabled(isVSMode);
    
    const row = new ActionRowBuilder().addComponents(joinButton, leaveButton, botStartButton);

    if (isVSMode) {
        const startGameButton = new ButtonBuilder().setCustomId('sambung_start_vs').setLabel('Mulai Game').setStyle(ButtonStyle.Primary).setDisabled(game.players.size < 2);
        row.addComponents(startGameButton);
        
        // --- TOMBOL BATALKAN LOBBY (Hanya untuk host) ---
        const cancelButton = new ButtonBuilder()
            .setCustomId('sambung_cancel_lobby')
            .setLabel('Batalkan Lobby')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(false); 
        
        const secondRow = new ActionRowBuilder().addComponents(cancelButton);
        return { embeds: [embedMessage], components: [row, secondRow] };
        // --------------------------------------------------------
    }
    
    return { embeds: [embedMessage], components: [row] };
}

async function sendLobbyMessage(message, game) { 
    // Meneruskan hostId ke updateLobbyMessage
    const messageOptions = await updateLobbyMessage(game, game.hostId); 
    
    if (!game.lobbyMessageId) {
        const sentMessage = await message.channel.send(messageOptions);
        game.lobbyMessageId = sentMessage.id;
        return sentMessage;
    } else {
        const sentMessage = await message.channel.messages.fetch(game.lobbyMessageId).catch(() => null);
        if (sentMessage) {
            await sentMessage.edit(messageOptions);
            return sentMessage;
        }
    }
}

async function startGame(interactionOrMessage, game, botStartFirst) { 
    game.status = GAME_STATUS.ACTIVE;
    game.kataTerakhir = botStartFirst ? 'a' : ''; 
    game.pemainTerakhir = botStartFirst ? interactionOrMessage.client.user.id : null;
    game.currentTurnId = 1;

    game.players.forEach((user) => {
        game.skorPemain.set(user.id, 0);
    });
    
    if (botStartFirst) {
        const message = interactionOrMessage.channel.messages.cache.get(game.lobbyMessageId) || interactionOrMessage;
        
        if (message) {
             const botResponse = await getBotResponse(game);
             
             if (botResponse) {
                const cleanBotWord = botResponse.replace(/[^a-z]/g, '');
                const botRequiredLength = cleanBotWord.length >= 2 ? 2 : 1;
                const botRequiredString = cleanBotWord.slice(-botRequiredLength).toUpperCase();
                
                game.kataTerakhir = cleanBotWord;
                game.kataDigunakan.set(cleanBotWord, interactionOrMessage.client.user.id);
                game.skorPemain.set(interactionOrMessage.client.user.id, (game.skorPemain.get(interactionOrMessage.client.user.id) || 0) + 1);

                await message.channel.send(`**${botResponse}** (${botRequiredString}).`); 
                await message.channel.send(`Giliran Kamu! Kata harus dimulai dengan **${botRequiredString}**. Waktu 7 detik dimulai.`);
                
                setGameTimeout(message, game); 
             } else {
                 game.status = GAME_STATUS.STOPPED;
                 activeGames.delete(message.channelId);
                 await message.channel.send('❌ **Gagal memulai game!** Bot tidak dapat menemukan kata awal di database. Pastikan database KBBI terisi.');
             }
        }
    } else {
        const message = interactionOrMessage.channel.messages.cache.get(game.lobbyMessageId) || interactionOrMessage;
        if (message) {
            message.channel.send(`Permainan dimulai! ${game.mode} - Giliran pemain. Ketik kata pertama Kamu. (Kata berikutnya harus berakhir dengan 2 huruf terakhir kata Kamu, atau 1 jika kata Kamu pendek).`);
            setGameTimeout(message, game); 
        }
    }
}

async function handleLobbyInteraction(interaction, game) {
    if (interaction.customId === 'sambung_join') {
        if (game.mode !== 'VS') return interaction.followUp({ content: 'Tombol ini hanya untuk mode VS.', ephemeral: true });
        if (game.players.has(interaction.user.id)) {
            return interaction.followUp({ content: 'Kamu sudah bergabung!', ephemeral: true });
        }
        game.players.set(interaction.user.id, interaction.user);
        await interaction.editReply(await updateLobbyMessage(game, game.hostId));
        return;
    } 
    
    // --- PENANGANAN TOMBOL KELUAR (JOIN/LOBBY) ---
    if (interaction.customId === 'sambung_leave') {
        // Izinkan tombol Keluar di mode VS (lobby) dan SOLO (lobby)
        if (game.mode !== 'VS' && game.mode !== 'SOLO') {
            return interaction.followUp({ content: 'Tombol ini hanya untuk mode VS atau SOLO.', ephemeral: true });
        }
        
        if (!game.players.has(interaction.user.id)) {
            return interaction.followUp({ content: 'Kamu belum bergabung!', ephemeral: true });
        }
        
        game.players.delete(interaction.user.id);
        
        // Di mode SOLO, jika pemain keluar, otomatis batalkan lobby karena hanya ada 1 pemain
        if (game.mode === 'SOLO') {
            await stopGame(interaction, game, `👋 Pemain (**${interaction.user.username}**) keluar. Lobby Solo dibatalkan.`);
            return;
        }
        
        // Di mode VS, update lobby message
        await interaction.editReply(await updateLobbyMessage(game, game.hostId));
        return;
    } 
    // --- AKHIR PENANGANAN TOMBOL KELUAR ---
    
    if (interaction.customId === 'sambung_bot_start' && game.mode === 'SOLO') {
        if (!game.players.has(interaction.user.id)) {
             game.players.set(interaction.user.id, interaction.user);
        }
        await interaction.editReply({ content: 'Game Solo dimulai! Bot memulai kata pertama...', embeds: [], components: [] });
        await startGame(interaction, game, true); 
    } else if (interaction.customId === 'sambung_start_vs' && game.mode === 'VS') {
        if (game.players.size < 2) {
            return interaction.followUp({ content: 'Minimal 2 pemain diperlukan untuk memulai game VS.', ephemeral: true });
        }
        await interaction.editReply({ content: 'Game VS dimulai! Giliran Kamu, ketik kata pertama!', embeds: [], components: [] });
        await startGame(interaction, game, false);
    } else if (interaction.customId === 'sambung_cancel_lobby' && game.mode === 'VS') {
        if (interaction.user.id !== game.hostId) {
            return interaction.followUp({ content: 'Hanya host yang dapat membatalkan lobby ini.', ephemeral: true });
        }
        await stopGame(interaction, game, `❌ Lobby dibatalkan oleh host (**${interaction.user.username}**).`);
    } else {
        // Jika game sudah ACTIVE dan tombol lobby diklik, abaikan.
        if (game.status === GAME_STATUS.ACTIVE) {
            return interaction.followUp({ content: 'Game sudah dimulai, tombol tidak lagi berfungsi.', ephemeral: true });
        }
        return interaction.followUp({ content: 'Aksi tidak valid atau tombol dinonaktifkan.', ephemeral: true });
    }
}


async function handleGameMessage(message, game) { 
    if (message.author.bot) return;

    const newWord = message.content.split(/\s+/)[0].toLowerCase().trim();
    if (!newWord || newWord.startsWith('!')) return; 
    
    // Validasi Pemain
    if (game.mode === 'VS' && !game.players.has(message.author.id)) return;
    if (game.mode === 'SOLO' && !game.players.has(message.author.id)) return;

    // Validasi Panjang Kata
    if (newWord.length < 2) return message.reply('Kata minimal harus 2 karakter.');

    // 🎯 VALIDASI SAMBUNGAN (FIX: Tambahkan setGameTimeout dan return)
    const requiredLength = game.kataTerakhir.length >= 2 ? 2 : 1;
    const requiredString = game.kataTerakhir.slice(-requiredLength);

    if (game.kataTerakhir && !newWord.startsWith(requiredString)) {
        setGameTimeout(message, game); 
        return message.reply(`Kata **${newWord}** harus dimulai dengan **${requiredString.toUpperCase()}**! Giliran tetap milik Kamu. Waktu 7 detik dimulai kembali.`);
    }

    // 🎯 VALIDASI KATA SUDAH DIGUNAKAN (FIX: Tambahkan setGameTimeout dan return)
    if (game.kataDigunakan.has(newWord)) {
        setGameTimeout(message, game); 
        return message.reply(`Kata **${newWord}** sudah digunakan! Giliran tetap milik Kamu. Waktu 7 detik dimulai kembali.`);
    }

    // 🎯 VALIDASI KBBI (FIX: Tambahkan setGameTimeout dan return)
    const isValid = await isKBBIWordValid(newWord);
    if (!isValid) {
        setGameTimeout(message, game); 
        return message.reply(`Kata **${newWord}** tidak ditemukan di KBBI! Giliran tetap milik Kamuu. Waktu 7 detik dimulai kembali.`);
    }

    // --- Kata Valid, Update State ---
    
    if (game.timeoutRef) clearTimeout(game.timeoutRef);
    game.currentTurnId++;

    game.kataTerakhir = newWord;
    game.kataDigunakan.set(newWord, message.author.id);
    game.pemainTerakhir = message.author.id;

    const currentScore = game.skorPemain.get(message.author.id) || 0;
    game.skorPemain.set(message.author.id, currentScore + 1);

    const nextRequiredLength = newWord.length >= 2 ? 2 : 1;
    const nextRequiredString = newWord.slice(-nextRequiredLength).toUpperCase();

    if (game.mode === 'VS') {
        setGameTimeout(message, game); 
        return message.channel.send(`✅ Kata diterima! **${newWord}** (${nextRequiredString}). Giliran berikutnya harus dimulai dengan **${nextRequiredString}**. Waktu 7 detik dimulai.`);
    }

    // --- LOGIKA GILIRAN BOT (Hanya di mode SOLO) ---
    if (game.mode === 'SOLO') {
        const botResponse = await getBotResponse(game);
        await new Promise(resolve => setTimeout(resolve, BOT_RESPONSE_DELAY)); 

        if (botResponse) {
            const cleanBotWord = botResponse.replace(/[^a-z]/g, '');
            const botRequiredLength = cleanBotWord.length >= 2 ? 2 : 1;
            const botRequiredString = cleanBotWord.slice(-botRequiredLength).toUpperCase();
            
            game.kataTerakhir = cleanBotWord;
            game.kataDigunakan.set(cleanBotWord, message.client.user.id);
            game.pemainTerakhir = message.client.user.id;
            game.skorPemain.set(message.client.user.id, (game.skorPemain.get(message.client.user.id) || 0) + 1);
            
            await message.channel.send(`**${botResponse}** (${botRequiredString}).`); 
            await message.channel.send(`Giliran Kamu! Kata harus dimulai dengan **${botRequiredString}**. Waktu 7 detik dimulai.`);
            
            setGameTimeout(message, game); 
            
            return;
        } else {
            // Bot Kalah
            activeGames.delete(message.channelId);
            const skorAkhir = Array.from(game.skorPemain.entries())
                .map(([userId, score]) => {
                    const user = message.client.users.cache.get(userId) || { username: 'Bot' };
                    return `* ${user.username}: **${score}**`;
                }).join('\n');
            return message.channel.send(`🎉 Yeaay! Bot kehabisan kata dan kalah! **${message.author.username}** menang!\n\n**Skor Akhir:**\n${skorAkhir}`);
        }
    }
}


// *******************************************************************
// *** EKSPOR ********************************************************
// *******************************************************************

module.exports = {
    GAME_STATUS, 
    activeGames,
    endGameTimeout, 
    handleLobbyInteraction,
    handleGameMessage,
    sendLobbyMessage,
    stopGame 
};