const { Collection } = require('discord.js');
const {
    GAME_STATUS, 
    activeGames,
    handleLobbyInteraction,
    handleGameMessage,
    sendLobbyMessage,
    stopGame
} = require('./sambung_kata.js'); 

async function handleSambungKataCommand(message, args) {
    const channelId = message.channelId;
    let game = activeGames.get(channelId);
     
    const command = args[0] ? args[0].toLowerCase() : null;
    const mode = args[1] ? args[1].toLowerCase() : null;
     
    if (command === 'stop') {
        if (!game) return message.reply('Tidak ada game yang aktif/di lobby.');

        await stopGame(message, game, 'Game Sambung Kata dihentikan.');
        
        return message.reply('Game Sambung Kata dihentikan.');
    }
     
    if (command === 'kata') {
        if (game && game.status !== GAME_STATUS.STOPPED) return message.reply(`Game sudah berjalan! Status: ${game.status}`);
        
        if (mode === 'solo' || mode === 'vs') {
            const isSoloMode = mode === 'solo';
            
            game = { 
                status: GAME_STATUS.LOBBY, 
                mode: isSoloMode ? 'SOLO' : 'VS', 
                kataTerakhir: '', 
                kataDigunakan: new Collection(),
                pemainTerakhir: null,
                skorPemain: new Map(),
                timeoutRef: null,
                waktuGiliranTerakhir: null,
                currentTurnId: 0,
                players: new Collection(),
                lobbyMessageId: null,
                hostId: message.author.id
            };
            activeGames.set(channelId, game);
            
            if (isSoloMode) {
                game.players.set(message.author.id, message.author);
            }
             
            await sendLobbyMessage(message, game);
            return;
        } else {
            return message.reply('Mode game tidak valid. Gunakan `!sambung kata solo` atau `!sambung kata vs`.');
        }
    } 
}


module.exports = {
    name: 'sambung', 
    description: 'Menjalankan permainan Sambung Kata (Modular).',
    activeGames: activeGames, 
    
    async execute(message, args) {
        const fullCommand = message.content.trim().toLowerCase().split(/\s+/);
        const command = fullCommand[0].startsWith('!') ? fullCommand[0].substring(1) : null;
         
        if (command === 'sambung') {
            await handleSambungKataCommand(message, fullCommand.slice(1));
            return;
        } else {
            const game = activeGames.get(message.channelId);
            if (game && game.status === GAME_STATUS.ACTIVE) {
                await handleGameMessage(message, game);
            }
        }
    },
    
    async handleInteraction(interaction) {
        if (!interaction.isButton()) return;
        
        const game = activeGames.get(interaction.channelId);
        
        if (game && game.lobbyMessageId === interaction.message.id) {
            await handleLobbyInteraction(interaction, game);
        }
    }
};
