const fs = require('fs'); 
const path = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.commands = new Collection();
const featuresPath = path.join(__dirname, 'features');


function loadCommands(dir) {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
            loadCommands(filePath);
        } else if (file.endsWith('.js') && file.startsWith('index-')) { 
            try {
                const command = require(filePath);
                if (command.name) {
                    client.commands.set(command.name, command);
                    console.log(`[LOAD] Memuat Command Modular: ${command.name}`);
                }
            } catch (error) {
                console.error(`Gagal memuat file ${filePath}: ${error.message}`);
            }
        }
    }
}

loadCommands(featuresPath);

client.once('ready', () => { 
    console.log(`Bot log in sebagai ${client.user.tag}! ${client.commands.size} perintah dimuat.`);
    client.user.setActivity('Games: !tebak | !sambung', { type: 'PLAYING' });
});

// --- EVENT: messageCreate
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const prefix = '!';
    const content = message.content.trim();
    
    if (content.startsWith(prefix)) {
        const args = content.slice(prefix.length).split(/\s+/);
        const commandName = args.shift().toLowerCase();
        const command = client.commands.get(commandName);
        
        if (command) {
            try {
                await command.execute(message, args);
            } catch (error) {
                console.error(error);
                message.channel.send('Terjadi kesalahan saat menjalankan perintah itu.');
            }
        }
        return; 
    } 
    
    const sambungCommand = client.commands.get('sambung');
    if (sambungCommand && sambungCommand.execute) {
        await sambungCommand.execute(message, []);
    }

    const tebakCommand = client.commands.get('tebak');
    if (tebakCommand && tebakCommand.handleTebakKataGuess) {
        await tebakCommand.handleTebakKataGuess(message);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    
    if (interaction.customId.startsWith('sambung_')) {
        await interaction.deferUpdate().catch(() => {});
        const sambungCommand = client.commands.get('sambung');
        if (sambungCommand && sambungCommand.handleInteraction) {
            await sambungCommand.handleInteraction(interaction);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
